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
const { fromIni } = require('@aws-sdk/credential-providers');

let mainWindow;

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

function setupIpcHandlers() {
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
          reject({ success: false, error: 'Authentication process timed out after 25 seconds' });
        }
      }, 25000);

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
  });

  // EC2 instances - the SSM/RDP target list
  ipcMain.handle('get-ec2-instances', async (event, profileName) => {
    try {
      const profile = await getProfileConfig(profileName);

      const client = new EC2Client({
        credentials: fromIni({ profile: profileName }),
        region: profile.region
      });

      const response = await client.send(new DescribeInstancesCommand({}));

      const instances = [];
      if (response.Reservations) {
        response.Reservations.forEach(reservation => {
          reservation.Instances.forEach(instance => {
            let instanceName = '';
            if (instance.Tags) {
              const nameTag = instance.Tags.find(tag => tag.Key === 'Name');
              instanceName = nameTag ? nameTag.Value : '';
            }

            instances.push({
              instanceName: instanceName,
              instanceId: instance.InstanceId,
              instanceType: instance.InstanceType,
              state: instance.State.Name,
              publicIp: instance.PublicIpAddress,
              privateIp: instance.PrivateIpAddress,
              launchTime: instance.LaunchTime,
              platform: instance.Platform || 'Linux'
            });
          });
        });
      }

      return { success: true, data: instances };
    } catch (error) {
      return { success: false, error: `Failed to get EC2 instances: ${error.message}` };
    }
  });

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
