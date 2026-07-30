// SET ENVIRONMENT FIRST
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs-extra');
const ini = require('ini');
const os = require('os');

// AWS SDK imports (EC2 only - needed to list SSM/RDP targets)
const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
const { SSMClient, DescribeInstanceInformationCommand } = require('@aws-sdk/client-ssm');
const { fromIni } = require('@aws-sdk/credential-providers');

let mainWindow;

// Last Azure AD SSO profile used for a successful login — enables silent re-auth
let lastSsoProfile = null;

// IMPORTANT: the AWS SDK caches ~/.aws/config and ~/.aws/credentials in-process
// (@smithy/shared-ini-file-loader slurpFile keeps a module-level promise hash).
// aws-azure-login rewrites those files on every login, so without ignoreCache the
// app keeps using stale/expired credentials until the process restarts.
function awsCredentials(profileName) {
  return fromIni({ profile: profileName, ignoreCache: true });
}

// Errors that mean "the AWS session is no longer valid" (vs. a real API failure)
function isCredentialsError(error) {
  if (!error) return false;
  const name = error.name || '';
  const code = error.Code || error.code || '';
  const message = error.message || '';
  const haystack = `${name} ${code} ${message}`;

  return /ExpiredToken|ExpiredTokenException|TokenRefreshRequired|InvalidClientTokenId|UnrecognizedClientException|RequestExpired|AuthFailure|InvalidAccessKeyId|SignatureDoesNotMatch|CredentialsProviderError|CredentialsError|Could not load credentials|is not authorized|security token included in the request is (expired|invalid)/i.test(haystack);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 650,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
      enableRemoteModule: false,
      offscreen: false,
      backgroundThrottling: false
    },
    titleBarStyle: 'default',
    show: false
  });

  mainWindow.webContents.setFrameRate(60);
  mainWindow.loadFile('src/index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (process.env.NODE_ENV === 'development' || process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// Helper: read region (and other settings) for a profile from ~/.aws
async function getProfileConfig(profileName) {
  try {
    const awsConfigPath = path.join(os.homedir(), '.aws', 'config');
    const awsCredentialsPath = path.join(os.homedir(), '.aws', 'credentials');

    let profileConfig = { region: 'us-east-1' };

    if (await fs.pathExists(awsConfigPath)) {
      const configContent = await fs.readFile(awsConfigPath, 'utf8');
      const config = ini.parse(configContent);
      const configKey = profileName === 'default' ? 'default' : `profile ${profileName}`;
      if (config[configKey]) {
        profileConfig = { ...profileConfig, ...config[configKey] };
      }
    }

    if (await fs.pathExists(awsCredentialsPath)) {
      const credentialsContent = await fs.readFile(awsCredentialsPath, 'utf8');
      const credentials = ini.parse(credentialsContent);
      if (credentials[profileName]) {
        profileConfig = { ...profileConfig, ...credentials[profileName] };
      }
    }

    return profileConfig;
  } catch (error) {
    return { region: 'us-east-1' };
  }
}

// Helper: detect aws-azure-login (Azure AD SSO) compatible profiles
function isProfileAzureLoginCompatible(profileConfig) {
  if (!profileConfig) return false;

  const hasAzureAppId = !!(profileConfig.azure_app_id_uri || profileConfig.azure_app_id);
  const hasAzureTenant = !!profileConfig.azure_tenant_id;
  const hasAzureRole = !!profileConfig.azure_default_role_arn;
  const hasAzureUsername = !!profileConfig.azure_default_username;

  if (hasAzureAppId || hasAzureTenant || hasAzureRole || hasAzureUsername) {
    return true;
  }

  const azureFields = Object.keys(profileConfig).filter(key => key.toLowerCase().includes('azure'));
  return azureFields.length > 0;
}

// Run aws-azure-login for a profile. Resolves on success, rejects with { error }.
function runAzureLogin(profileName, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;
    const command = 'aws-azure-login';
    const args = ['--profile', profileName];

    const spawnOptions = platform === 'win32'
      ? { stdio: 'pipe', shell: true, windowsHide: true }
      : {
          stdio: 'pipe',
          shell: true,
          env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin' }
        };

    const azureAwsLogin = spawn(command, args, spawnOptions);

    let output = '';
    let errorOutput = '';
    let hasResponded = false;

    const timeout = setTimeout(() => {
      if (!hasResponded) {
        hasResponded = true;
        azureAwsLogin.kill();
        reject({ success: false, error: `Authentication process timed out after ${Math.round(timeoutMs / 1000)} seconds` });
      }
    }, timeoutMs);

    azureAwsLogin.stdout.on('data', (data) => { output += data.toString(); });
    azureAwsLogin.stderr.on('data', (data) => { errorOutput += data.toString(); });

    azureAwsLogin.on('close', (code) => {
      if (!hasResponded) {
        hasResponded = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolve({ success: true, output });
        } else {
          const errorMsg = errorOutput || `Process exited with code ${code}`;
          reject({ success: false, error: `Authentication failed: ${errorMsg}` });
        }
      }
    });

    azureAwsLogin.on('error', (error) => {
      if (!hasResponded) {
        hasResponded = true;
        clearTimeout(timeout);
        if (error.code === 'ENOENT') {
          const installMessage = platform === 'win32'
            ? 'aws-azure-login command not found. Please ensure it is installed and accessible:\n\nnpm install -g aws-azure-login\n\nThen restart the application.'
            : 'aws-azure-login command not found. Please ensure it is installed:\n\nnpm install -g aws-azure-login\n\nOr via Homebrew:\nbrew install aws-azure-login';
          reject({ success: false, error: installMessage });
        } else {
          reject({ success: false, error: `Command execution failed: ${error.message}` });
        }
      }
    });
  });
}

// Read the session expiry that aws-azure-login writes into ~/.aws/credentials.
// Only the profiles actually in use are considered, in priority order — scanning
// every section would pick up stale profiles from old logins whose expiry is long
// past, which would look like a permanently expired session.
async function getSessionExpiry(profileNames = []) {
  try {
    const credentialsPath = path.join(os.homedir(), '.aws', 'credentials');
    if (!(await fs.pathExists(credentialsPath))) return null;

    const credentials = ini.parse(await fs.readFile(credentialsPath, 'utf8'));
    const expiryKeys = ['aws_expiration', 'aws_session_expiration', 'x_security_token_expires'];

    for (const name of profileNames) {
      const section = name && credentials[name];
      if (!section || typeof section !== 'object') continue;

      for (const key of expiryKeys) {
        if (!section[key]) continue;
        const parsed = new Date(section[key]);
        if (!isNaN(parsed.getTime())) return parsed;
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

// Fetch the SSM-managed instance inventory for a region, keyed by instance id.
// Only instances that appear here can actually accept a Session Manager
// connection, so this is what decides whether Connect is offered.
async function getSsmManagedInstances(profileName, region) {
  const client = new SSMClient({
    credentials: awsCredentials(profileName),
    region,
    maxAttempts: 3
  });

  const managed = new Map();
  let nextToken;
  let page = 0;
  const MAX_PAGES = 40; // safety valve against an unbounded pagination loop

  do {
    const response = await client.send(new DescribeInstanceInformationCommand({
      MaxResults: 50,
      NextToken: nextToken
    }));

    (response.InstanceInformationList || []).forEach(info => {
      managed.set(info.InstanceId, {
        pingStatus: info.PingStatus,
        lastPingDateTime: info.LastPingDateTime,
        agentVersion: info.AgentVersion,
        isLatestVersion: info.IsLatestVersion,
        platformName: info.PlatformName,
        platformVersion: info.PlatformVersion
      });
    });

    nextToken = response.NextToken;
    page += 1;
  } while (nextToken && page < MAX_PAGES);

  return managed;
}

// Map an SSM PingStatus onto the states the UI cares about
function toSsmStatus(info) {
  if (!info) return 'unmanaged';

  switch ((info.pingStatus || '').toLowerCase()) {
    case 'online': return 'online';
    case 'connectionlost': return 'connection_lost';
    case 'inactive': return 'inactive';
    default: return 'unknown';
  }
}

function setupIpcHandlers() {
  // Single source of truth for the version shown in the UI: package.json, via
  // Electron. Hardcoding it in the markup means it silently goes stale.
  ipcMain.handle('get-app-version', () => app.getVersion());

  // Get Azure AD SSO profiles (for aws-azure-login)
  ipcMain.handle('get-aws-profiles', async () => {
    try {
      const awsConfigPath = path.join(os.homedir(), '.aws', 'config');
      const awsCredentialsPath = path.join(os.homedir(), '.aws', 'credentials');

      let profiles = [];

      try {
        if (await fs.pathExists(awsConfigPath)) {
          const configContent = await fs.readFile(awsConfigPath, 'utf8');
          const config = ini.parse(configContent);

          Object.keys(config).forEach(key => {
            let profileName;
            const profileConfig = config[key];

            if (key === 'default') {
              profileName = 'default';
            } else if (key.startsWith('profile ')) {
              profileName = key.replace('profile ', '');
            } else {
              return;
            }

            if (isProfileAzureLoginCompatible(profileConfig)) {
              profiles.push({
                name: profileName,
                region: profileConfig.region || 'us-east-1',
                source: 'config',
                azureAppId: profileConfig.azure_app_id_uri || profileConfig.azure_app_id,
                azureTenant: profileConfig.azure_tenant_id,
                azureDefaultRole: profileConfig.azure_default_role_arn,
                ...profileConfig
              });
            }
          });
        }
      } catch (configError) {
        console.error('Error reading AWS config file:', configError);
      }

      try {
        if (await fs.pathExists(awsCredentialsPath)) {
          const credentialsContent = await fs.readFile(awsCredentialsPath, 'utf8');
          const credentials = ini.parse(credentialsContent);

          Object.keys(credentials).forEach(profileName => {
            if (!profiles.find(p => p.name === profileName)) {
              const credProfile = credentials[profileName];
              if (credProfile.azure_app_id_uri || credProfile.azure_app_id || credProfile.azure_tenant_id) {
                profiles.push({
                  name: profileName,
                  region: credProfile.region || 'us-east-1',
                  source: 'credentials',
                  azureAppId: credProfile.azure_app_id_uri || credProfile.azure_app_id,
                  azureTenant: credProfile.azure_tenant_id,
                  azureDefaultRole: credProfile.azure_default_role_arn
                });
              }
            }
          });
        }
      } catch (credentialsError) {
        console.error('Error reading AWS credentials file:', credentialsError);
      }

      return profiles;
    } catch (error) {
      console.error('Error loading AWS profiles:', error);
      return [];
    }
  });

  // Get operational (non-SSO) profiles for day-to-day work
  ipcMain.handle('get-operational-profiles', async () => {
    try {
      const awsConfigPath = path.join(os.homedir(), '.aws', 'config');
      const awsCredentialsPath = path.join(os.homedir(), '.aws', 'credentials');

      let profiles = [];

      try {
        if (await fs.pathExists(awsConfigPath)) {
          const configContent = await fs.readFile(awsConfigPath, 'utf8');
          const config = ini.parse(configContent);

          Object.keys(config).forEach(key => {
            let profileName;
            const profileConfig = config[key];

            if (key === 'default') {
              profileName = 'default';
            } else if (key.startsWith('profile ')) {
              profileName = key.replace('profile ', '');
            } else {
              return;
            }

            if (!isProfileAzureLoginCompatible(profileConfig)) {
              profiles.push({
                name: profileName,
                region: profileConfig.region || 'us-east-1',
                source: 'config',
                ...profileConfig
              });
            }
          });
        }
      } catch (configError) {
        console.error('Error reading AWS config file:', configError);
      }

      try {
        if (await fs.pathExists(awsCredentialsPath)) {
          const credentialsContent = await fs.readFile(awsCredentialsPath, 'utf8');
          const credentials = ini.parse(credentialsContent);

          Object.keys(credentials).forEach(profileName => {
            if (!profiles.find(p => p.name === profileName)) {
              const credProfile = credentials[profileName];
              const isAzureProfile = !!(credProfile.azure_app_id_uri || credProfile.azure_app_id || credProfile.azure_tenant_id);
              if (!isAzureProfile) {
                profiles.push({
                  name: profileName,
                  region: credProfile.region || 'us-east-1',
                  source: 'credentials'
                });
              }
            }
          });
        }
      } catch (credentialsError) {
        console.error('Error reading AWS credentials file:', credentialsError);
      }

      return profiles;
    } catch (error) {
      console.error('Error loading operational profiles:', error);
      return [];
    }
  });

  // Azure AD SSO login via aws-azure-login CLI
  ipcMain.handle('azure-aws-login', async (event, profileName) => {
    const result = await runAzureLogin(profileName);
    lastSsoProfile = profileName;
    return result;
  });

  // Report the current session state (used by the renderer to pre-empt expiry).
  // Checks the operational profile in use first, then the SSO profile that was
  // actually logged in — never unrelated leftover profiles.
  ipcMain.handle('get-session-status', async (event, operationalProfile) => {
    const candidates = [operationalProfile, lastSsoProfile].filter(Boolean);
    const expiresAt = candidates.length ? await getSessionExpiry(candidates) : null;

    return {
      success: true,
      ssoProfile: lastSsoProfile,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      expiresInMs: expiresAt ? expiresAt.getTime() - Date.now() : null
    };
  });

  // Re-run SSO login for the last used profile (silent refresh)
  ipcMain.handle('refresh-session', async (event, profileName) => {
    const target = profileName || lastSsoProfile;
    if (!target) {
      return { success: false, error: 'No SSO profile has been used yet' };
    }
    try {
      await runAzureLogin(target);
      lastSsoProfile = target;
      return { success: true, ssoProfile: target };
    } catch (error) {
      return { success: false, error: error.error || error.message || 'Re-authentication failed' };
    }
  });

  // EC2 instances - the SSM/RDP target list
  // On expired credentials, silently re-run SSO login once and retry.
  ipcMain.handle('get-ec2-instances', async (event, profileName) => {
    try {
      return await describeInstances(profileName);
    } catch (error) {
      if (!isCredentialsError(error)) {
        return { success: false, error: `Failed to get EC2 instances: ${error.message}` };
      }

      if (!lastSsoProfile) {
        return {
          success: false,
          sessionExpired: true,
          error: 'Your AWS session has expired. Please sign in again with SSO Connect.'
        };
      }

      try {
        await runAzureLogin(lastSsoProfile);
      } catch (loginError) {
        return {
          success: false,
          sessionExpired: true,
          error: `Session expired and automatic re-authentication failed: ${loginError.error || loginError.message}`
        };
      }

      try {
        const result = await describeInstances(profileName);
        return { ...result, reauthenticated: true };
      } catch (retryError) {
        return {
          success: false,
          sessionExpired: true,
          error: `Failed to load instances after re-authentication: ${retryError.message}`
        };
      }
    }
  });

  // Raw EC2 describe — throws so the caller can decide how to handle failures
  async function describeInstances(profileName) {
    const profile = await getProfileConfig(profileName);

    const client = new EC2Client({
      credentials: awsCredentials(profileName),
      region: profile.region
    });

    // DescribeInstances is paginated. Reading only the first page would silently
    // hide instances in large accounts, which looks like the instance simply does
    // not exist, so every page is walked.
    //
    // The state filter is applied server-side: AWS keeps returning terminated
    // instances for roughly an hour after they are gone, and they can never
    // accept a connection.
    const reservations = [];
    let nextToken;
    let page = 0;
    const MAX_PAGES = 40; // safety valve against an unbounded pagination loop

    do {
      const response = await client.send(new DescribeInstancesCommand({
        Filters: [{
          Name: 'instance-state-name',
          Values: ['pending', 'running', 'shutting-down', 'stopping', 'stopped']
        }],
        MaxResults: 1000,
        NextToken: nextToken
      }));

      if (response.Reservations) {
        reservations.push(...response.Reservations);
      }

      nextToken = response.NextToken;
      page += 1;
    } while (nextToken && page < MAX_PAGES);

    // SSM inventory is supplementary: a missing ssm:DescribeInstanceInformation
    // permission must not break the instance listing. On failure every instance
    // is reported as 'unknown' and the connect buttons stay enabled, so a
    // read-only permission gap never blocks an otherwise valid connection.
    let ssmManaged = new Map();
    let ssmLookupFailed = false;
    try {
      ssmManaged = await getSsmManagedInstances(profileName, profile.region);
    } catch (ssmError) {
      // Credential problems belong to the caller's re-auth path, not here
      if (isCredentialsError(ssmError)) throw ssmError;
      ssmLookupFailed = true;
    }

    const instances = [];
    reservations.forEach(reservation => {
      (reservation.Instances || []).forEach(instance => {
        let instanceName = '';
        if (instance.Tags) {
          const nameTag = instance.Tags.find(tag => tag.Key === 'Name');
          instanceName = nameTag ? nameTag.Value : '';
        }

        const ssmInfo = ssmManaged.get(instance.InstanceId);

        instances.push({
          instanceName: instanceName,
          instanceId: instance.InstanceId,
          instanceType: instance.InstanceType,
          state: instance.State.Name,
          publicIp: instance.PublicIpAddress,
          privateIp: instance.PrivateIpAddress,
          platform: instance.Platform || 'Linux',
          ssmStatus: ssmLookupFailed ? 'unknown' : toSsmStatus(ssmInfo),
          ssmLastPing: ssmInfo ? ssmInfo.lastPingDateTime : null,
          ssmAgentVersion: ssmInfo ? ssmInfo.agentVersion : null,
          ssmPlatformName: ssmInfo ? ssmInfo.platformName : null
        });
      });
    });

    return { success: true, data: instances, ssmLookupFailed };
  }

  // SSM Session - open a shell in a new terminal window
  ipcMain.handle('connect-ssm', async (event, profileName, instanceId) => {
    return new Promise((resolve, reject) => {
      getProfileConfig(profileName).then(profile => {
        const platform = process.platform;
        let command, args;

        const awsCommand = `aws ssm start-session --target ${instanceId} --profile ${profileName} --region ${profile.region}`;

        if (platform === 'win32') {
          command = 'cmd';
          args = ['/c', 'start', 'cmd', '/k', awsCommand];
        } else if (platform === 'darwin') {
          command = 'osascript';
          args = ['-e', `tell application "Terminal" to do script "${awsCommand}"`];
        } else {
          const terminals = ['gnome-terminal', 'konsole', 'xterm', 'x-terminal-emulator'];
          let terminalFound = false;
          for (const terminal of terminals) {
            try {
              if (terminal === 'gnome-terminal') {
                command = terminal;
                args = ['--', 'bash', '-c', `${awsCommand}; exec bash`];
              } else {
                command = terminal;
                args = ['-e', 'bash', '-c', `${awsCommand}; exec bash`];
              }
              terminalFound = true;
              break;
            } catch (e) {
              continue;
            }
          }
          if (!terminalFound) {
            reject({ success: false, error: 'No suitable terminal emulator found. Please install gnome-terminal, konsole, or xterm.' });
            return;
          }
        }

        const terminalProcess = spawn(command, args, { detached: true, stdio: 'ignore' });

        terminalProcess.on('spawn', () => {
          terminalProcess.unref();
          resolve({ success: true, message: 'SSM session started in new terminal window' });
        });

        terminalProcess.on('error', (error) => {
          if (error.code === 'ENOENT') {
            if (platform === 'win32') {
              reject({ success: false, error: 'Could not open Command Prompt. Please ensure cmd.exe is available.' });
            } else if (platform === 'darwin') {
              reject({ success: false, error: 'Could not open Terminal. Please ensure Terminal.app is available.' });
            } else {
              reject({ success: false, error: 'Could not open terminal. Please install a terminal emulator.' });
            }
          } else {
            reject({ success: false, error: `Failed to open terminal: ${error.message}` });
          }
        });
      }).catch(error => {
        reject({ success: false, error: `Failed to get profile config: ${error.message}` });
      });
    });
  });

  // RDP over SSM - port-forward tunnel + launch RDP client
  ipcMain.handle('connect-rdp-ssm', async (event, profileName, instanceId, instanceName) => {
    return new Promise((resolve, reject) => {
      getProfileConfig(profileName).then(profileConfig => {
        const platform = process.platform;
        const net = require('net');

        const findAvailablePort = () => new Promise((portResolve, portReject) => {
          const server = net.createServer();
          server.listen(0, (err) => {
            if (err) { portReject(err); return; }
            const port = server.address().port;
            server.close(() => portResolve(port));
          });
        });

        findAvailablePort().then(availablePort => {
          const ssmCommand = `aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession --parameters "portNumber=3389,localPortNumber=${availablePort}" --profile ${profileName} --region ${profileConfig.region}`;

          let ssmProcess;
          let rdpProcess;
          let tunnelEstablished = false;

          if (platform === 'win32') {
            ssmProcess = spawn('cmd', ['/c', ssmCommand], { stdio: 'pipe', shell: true });
          } else {
            ssmProcess = spawn('bash', ['-c', ssmCommand], {
              stdio: 'pipe',
              env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin' }
            });
          }

          ssmProcess.stdout.on('data', (data) => {
            const output = data.toString();

            if ((output.includes('Port forwarding started') || output.includes('Waiting for connections')) && !tunnelEstablished) {
              tunnelEstablished = true;

              setTimeout(() => {
                if (platform === 'win32') {
                  rdpProcess = spawn('mstsc', [`/v:localhost:${availablePort}`], { detached: false });
                } else if (platform === 'darwin') {
                  rdpProcess = spawn('open', ['-a', 'Microsoft Remote Desktop', `rdp://localhost:${availablePort}`], { detached: false });
                  rdpProcess.on('error', (error) => {
                    if (error.code === 'ENOENT') {
                      rdpProcess = spawn('open', [`rdp://localhost:${availablePort}`], { detached: false });
                    }
                  });
                } else {
                  const rdpClients = ['remmina', 'xfreerdp', 'rdesktop'];
                  let clientFound = false;
                  for (const client of rdpClients) {
                    try {
                      if (client === 'xfreerdp') {
                        rdpProcess = spawn('xfreerdp', [`/v:localhost:${availablePort}`, '/cert-ignore'], { detached: false });
                      } else if (client === 'rdesktop') {
                        rdpProcess = spawn('rdesktop', [`localhost:${availablePort}`], { detached: false });
                      } else {
                        rdpProcess = spawn(client, ['--connect', `rdp://localhost:${availablePort}`], { detached: false });
                      }
                      clientFound = true;
                      break;
                    } catch (e) {
                      continue;
                    }
                  }
                  if (!clientFound) {
                    if (ssmProcess && !ssmProcess.killed) ssmProcess.kill();
                    reject({ success: false, error: 'No RDP client found. Please install remmina, xfreerdp, or rdesktop.' });
                    return;
                  }
                }

                if (rdpProcess) {
                  rdpProcess.on('close', () => {
                    if (ssmProcess && !ssmProcess.killed) ssmProcess.kill();
                  });

                  rdpProcess.on('error', (error) => {
                    if (ssmProcess && !ssmProcess.killed) ssmProcess.kill();
                    if (platform === 'win32' && error.code === 'ENOENT') {
                      reject({ success: false, error: 'Remote Desktop client not found. Please ensure mstsc is available.' });
                    } else if (platform === 'darwin') {
                      reject({ success: false, error: 'RDP client not found. Please install Microsoft Remote Desktop from the Mac App Store, or try: brew install --cask microsoft-remote-desktop' });
                    } else {
                      reject({ success: false, error: `RDP client error: ${error.message}` });
                    }
                  });
                }

                resolve({
                  success: true,
                  message: `RDP tunnel established for ${instanceName} on port ${availablePort}.`,
                  port: availablePort
                });
              }, 2000);
            }
          });

          ssmProcess.stderr.on('data', (data) => {
            const errorOutput = data.toString();
            if (errorOutput.includes('TargetNotConnected') || errorOutput.includes('InvalidInstanceId')) {
              reject({ success: false, error: 'Instance not available for SSM connection. Ensure SSM agent is running and the instance is a Windows instance.' });
            }
          });

          ssmProcess.on('close', () => {
            if (rdpProcess && !rdpProcess.killed) rdpProcess.kill();
          });

          ssmProcess.on('error', (error) => {
            if (error.code === 'ENOENT') {
              reject({ success: false, error: 'AWS CLI not found. Please ensure AWS CLI is installed and in your PATH.' });
            } else {
              reject({ success: false, error: `SSM tunnel error: ${error.message}` });
            }
          });

          setTimeout(() => {
            if (!tunnelEstablished) {
              ssmProcess.kill();
              reject({ success: false, error: 'Timeout waiting for SSM tunnel to establish. Please check instance connectivity and ensure it\'s a Windows instance with SSM agent running.' });
            }
          }, 30000);
        }).catch(portError => {
          reject({ success: false, error: `Could not find available port: ${portError.message}` });
        });
      }).catch(error => {
        reject({ success: false, error: `Failed to get profile config: ${error.message}` });
      });
    });
  });
}

app.whenReady().then(() => {
  createWindow();
  setupIpcHandlers();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
