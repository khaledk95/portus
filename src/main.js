// SET ENVIRONMENT FIRST
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
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

// ============================================================================
// EXTERNAL TOOL PREFLIGHT
// ============================================================================

// Portus shells out to these. Without them the failure only surfaces later, in a
// terminal window that closes immediately, so they are checked up front.
const REQUIRED_TOOLS = [
  {
    id: 'aws-cli',
    name: 'AWS CLI',
    command: 'aws',
    purpose: 'Opens the SSM sessions behind Connect and RDP',
    install: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html'
  },
  {
    id: 'session-manager-plugin',
    name: 'Session Manager plugin',
    command: 'session-manager-plugin',
    purpose: 'Required by the AWS CLI to start a session',
    install: 'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html'
  },
  {
    id: 'aws-azure-login',
    name: 'aws-azure-login',
    command: 'aws-azure-login',
    purpose: 'Performs the Azure AD SSO sign-in',
    install: 'npm install -g aws-azure-login'
  }
];

// Resolve a command on PATH. Presence is checked rather than `--version`, because
// not every tool implements a version flag consistently and a non-zero exit there
// would be reported as a missing tool.
function isCommandAvailable(command) {
  return new Promise(resolve => {
    const isWindows = process.platform === 'win32';

    const probe = isWindows
      ? spawn('where', [command], { windowsHide: true })
      : spawn('sh', ['-c', `command -v ${command}`], {
          env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin' }
        });

    let settled = false;
    const finish = (found) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(found);
    };

    const timer = setTimeout(() => {
      try { probe.kill(); } catch (e) { /* already gone */ }
      finish(false);
    }, 5000);

    probe.on('close', code => finish(code === 0));
    probe.on('error', () => finish(false));
  });
}

async function checkRequiredTools() {
  return Promise.all(REQUIRED_TOOLS.map(async tool => ({
    id: tool.id,
    name: tool.name,
    purpose: tool.purpose,
    install: tool.install,
    found: await isCommandAvailable(tool.command)
  })));
}

// ============================================================================
// RDP TUNNEL REGISTRY
// ============================================================================

// Tunnels are tracked centrally so they can be listed in the UI and, critically,
// terminated when the app exits instead of being left running.
const activeTunnels = new Map();
let tunnelSequence = 0;

function listTunnels() {
  return Array.from(activeTunnels.values()).map(tunnel => ({
    id: tunnel.id,
    kind: tunnel.kind || 'rdp',
    instanceId: tunnel.instanceId,
    instanceName: tunnel.instanceName,
    profileName: tunnel.profileName,
    port: tunnel.port,
    remoteHost: tunnel.remoteHost || null,
    remotePort: tunnel.remotePort || null,
    startedAt: tunnel.startedAt
  }));
}

// Bind port 0 to let the OS hand back a free port
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

// Fail early with a clear message rather than letting the CLI die obscurely
function ensurePortFree(port) {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.unref();
    server.on('error', err => reject(new Error(
      err.code === 'EADDRINUSE'
        ? `Local port ${port} is already in use. Leave it blank to pick one automatically.`
        : `Local port ${port} is unavailable: ${err.message}`
    )));
    server.listen(port, () => server.close(() => resolve(port)));
  });
}

function describeTunnelFailure(stderrText) {
  if (/TargetNotConnected/i.test(stderrText)) {
    return 'The instance is not connected to Systems Manager, so no session could be started.';
  }
  if (/InvalidInstanceId/i.test(stderrText)) {
    return 'Systems Manager does not recognise this instance id.';
  }
  if (/AccessDenied|not authorized/i.test(stderrText)) {
    return 'Access denied starting the session. Your role needs ssm:StartSession for this instance and document.';
  }
  const trimmed = (stderrText || '').trim();
  return trimmed ? `Failed to start the tunnel: ${trimmed.split('\n')[0]}` : 'Failed to start the tunnel.';
}

// Shared tunnel launcher for port forwarding. Resolves once the CLI reports the
// listener is up, or with an error; never rejects, so the message survives IPC.
function startSsmTunnel({ ssmCommand, kind, instanceId, instanceName, profileName, localPort, remoteHost, remotePort }) {
  return new Promise(resolve => {
    const platform = process.platform;
    let established = false;
    let tunnelId = null;
    let stderrText = '';

    // shell:true on Windows is required: it is what makes Node pass the command
    // line through verbatim, so the quotes around --parameters survive.
    const proc = platform === 'win32'
      ? spawn('cmd', ['/c', ssmCommand], { stdio: 'pipe', shell: true, windowsHide: true })
      : spawn('bash', ['-c', `exec ${ssmCommand}`], {
          stdio: 'pipe',
          env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin' }
        });

    proc.stdout.on('data', data => {
      const output = data.toString();
      if (established) return;
      if (!output.includes('Port forwarding started') && !output.includes('Waiting for connections')) return;

      established = true;
      tunnelId = `tunnel-${++tunnelSequence}`;
      activeTunnels.set(tunnelId, {
        id: tunnelId,
        kind,
        instanceId,
        instanceName: instanceName || instanceId,
        profileName,
        port: localPort,
        remoteHost: remoteHost || null,
        remotePort,
        ssmProcess: proc,
        rdpProcess: null,
        startedAt: Date.now()
      });
      broadcastTunnels();

      resolve({ success: true, tunnelId, port: localPort });
    });

    proc.stderr.on('data', data => { stderrText += data.toString(); });

    proc.on('close', () => {
      if (tunnelId && activeTunnels.has(tunnelId)) closeTunnel(tunnelId);
      if (!established) resolve({ success: false, error: describeTunnelFailure(stderrText) });
    });

    proc.on('error', error => {
      if (established) return;
      resolve({
        success: false,
        error: error.code === 'ENOENT'
          ? 'AWS CLI not found. Please ensure the AWS CLI is installed and on your PATH.'
          : `SSM tunnel error: ${error.message}`
      });
    });

    setTimeout(() => {
      if (established) return;
      killProcessTree(proc);
      resolve({
        success: false,
        error: 'Timed out waiting for the tunnel to start. Check that the instance is reachable through Systems Manager.'
      });
    }, 30000);
  });
}

function broadcastTunnels() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('tunnels-changed', listTunnels());
  }
}

// `aws ssm start-session` runs underneath a shell, and on Windows spawns the
// session-manager-plugin below that. child.kill() ends only the shell it was
// handed, leaving the session alive and holding its local port, so the whole
// process tree has to be terminated explicitly.
function killProcessTree(proc) {
  if (!proc || !proc.pid) return;
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  if (process.platform === 'win32') {
    // Synchronous on purpose: this also runs from the process 'exit' handler,
    // where an async spawn would never get the chance to execute.
    try {
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
    } catch (error) {
      try { proc.kill(); } catch (e) { /* nothing else to try */ }
    }
  } else {
    // The shell exec's into aws, so this pid is the session itself
    try { proc.kill('SIGTERM'); } catch (e) { /* already gone */ }
  }
}

function closeTunnel(tunnelId, { silent = false } = {}) {
  const tunnel = activeTunnels.get(tunnelId);
  if (!tunnel) return false;

  activeTunnels.delete(tunnelId);
  killProcessTree(tunnel.ssmProcess);
  if (tunnel.rdpProcess) killProcessTree(tunnel.rdpProcess);

  if (!silent) broadcastTunnels();
  return true;
}

function closeAllTunnels() {
  for (const tunnelId of Array.from(activeTunnels.keys())) {
    closeTunnel(tunnelId, { silent: true });
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

  // Preflight: which external tools are present on this machine
  ipcMain.handle('check-required-tools', async () => {
    try {
      return { success: true, tools: await checkRequiredTools() };
    } catch (error) {
      return { success: false, error: error.message, tools: [] };
    }
  });

  // Generic port forwarding over SSM. With a remote host this tunnels *through*
  // the instance to something else in the VPC (an RDS endpoint, for example),
  // which is otherwise unreachable because RDS cannot run an SSM agent.
  ipcMain.handle('start-port-forward', async (event, profileName, instanceId, instanceName, options) => {
    const { remoteHost, remotePort, localPort } = options || {};

    const targetPort = parseInt(remotePort, 10);
    if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
      return { success: false, error: 'Remote port must be a number between 1 and 65535.' };
    }

    let requestedLocalPort = null;
    if (localPort !== undefined && localPort !== null && String(localPort).trim() !== '') {
      requestedLocalPort = parseInt(localPort, 10);
      if (!Number.isInteger(requestedLocalPort) || requestedLocalPort < 1 || requestedLocalPort > 65535) {
        return { success: false, error: 'Local port must be a number between 1 and 65535, or left blank.' };
      }
    }

    const targetHost = (remoteHost || '').trim();

    // Same instance, same target, same port means the existing tunnel already
    // does the job; different services on one instance still coexist.
    const existing = Array.from(activeTunnels.values()).find(tunnel =>
      tunnel.instanceId === instanceId &&
      tunnel.profileName === profileName &&
      tunnel.remotePort === targetPort &&
      (tunnel.remoteHost || '') === targetHost
    );

    if (existing) {
      return {
        success: true,
        reused: true,
        port: existing.port,
        message: `Already forwarding on localhost:${existing.port}`
      };
    }

    let resolvedLocalPort;
    try {
      resolvedLocalPort = requestedLocalPort
        ? await ensurePortFree(requestedLocalPort)
        : await findFreePort();
    } catch (error) {
      return { success: false, error: error.message };
    }

    const profileConfig = await getProfileConfig(profileName);

    const documentName = targetHost
      ? 'AWS-StartPortForwardingSessionToRemoteHost'
      : 'AWS-StartPortForwardingSession';

    const parameters = targetHost
      ? `host=${targetHost},portNumber=${targetPort},localPortNumber=${resolvedLocalPort}`
      : `portNumber=${targetPort},localPortNumber=${resolvedLocalPort}`;

    const ssmCommand = `aws ssm start-session --target ${instanceId} --document-name ${documentName} --parameters "${parameters}" --profile ${profileName} --region ${profileConfig.region}`;

    const result = await startSsmTunnel({
      ssmCommand,
      kind: 'port',
      instanceId,
      instanceName,
      profileName,
      localPort: resolvedLocalPort,
      remoteHost: targetHost,
      remotePort: targetPort
    });

    if (!result.success) return result;

    return {
      success: true,
      port: resolvedLocalPort,
      remoteHost: targetHost || null,
      remotePort: targetPort,
      message: `Forwarding localhost:${resolvedLocalPort} to ${targetHost || 'this instance'}:${targetPort}`
    };
  });

  // Active tunnels
  ipcMain.handle('list-tunnels', () => listTunnels());
  ipcMain.handle('close-tunnel', (event, tunnelId) => ({ success: closeTunnel(tunnelId) }));

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
    try {
      const result = await runAzureLogin(profileName);
      lastSsoProfile = profileName;
      return result;
    } catch (error) {
      // Rejecting with a plain object crosses IPC as "[object Object]"; an Error
      // carries its message through intact.
      throw new Error(error.error || error.message || 'Authentication failed');
    }
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
            resolve({ success: false, error: 'No suitable terminal emulator found. Please install gnome-terminal, konsole, or xterm.' });
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
              resolve({ success: false, error: 'Could not open Command Prompt. Please ensure cmd.exe is available.' });
            } else if (platform === 'darwin') {
              resolve({ success: false, error: 'Could not open Terminal. Please ensure Terminal.app is available.' });
            } else {
              resolve({ success: false, error: 'Could not open terminal. Please install a terminal emulator.' });
            }
          } else {
            resolve({ success: false, error: `Failed to open terminal: ${error.message}` });
          }
        });
      }).catch(error => {
        resolve({ success: false, error: `Failed to get profile config: ${error.message}` });
      });
    });
  });

  // RDP over SSM - port-forward tunnel + launch RDP client
  // RDP over SSM - port-forward tunnel + launch RDP client.
  // The tunnel is registered so it can be listed in the UI and terminated on exit.
  ipcMain.handle('connect-rdp-ssm', async (event, profileName, instanceId, instanceName) => {
    // Reuse an existing tunnel rather than stacking a second one on another port
    const existing = Array.from(activeTunnels.values())
      .find(t => t.instanceId === instanceId && t.profileName === profileName);

    if (existing) {
      return {
        success: true,
        reused: true,
        port: existing.port,
        message: `Already connected to ${instanceName} on port ${existing.port}`
      };
    }

    const profileConfig = await getProfileConfig(profileName);

    return new Promise((resolve, reject) => {
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

        let rdpProcess;
        let tunnelEstablished = false;
        let tunnelId = null;

        // Windows needs shell:true here. Node only passes the command line through
        // verbatim for cmd.exe under a shell; without it the embedded quotes in
        // --parameters are escaped as \" which cmd.exe does not understand, so the
        // AWS CLI never starts forwarding. Depth of the process tree does not
        // matter for cleanup because taskkill /T terminates all descendants.
        // POSIX: exec replaces the shell with aws, making this pid the session.
        const ssmProcess = platform === 'win32'
          ? spawn('cmd', ['/c', ssmCommand], { stdio: 'pipe', shell: true, windowsHide: true })
          : spawn('bash', ['-c', `exec ${ssmCommand}`], {
              stdio: 'pipe',
              env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin' }
            });

        ssmProcess.stdout.on('data', (data) => {
          const output = data.toString();

          if ((output.includes('Port forwarding started') || output.includes('Waiting for connections')) && !tunnelEstablished) {
            tunnelEstablished = true;

            tunnelId = `tunnel-${++tunnelSequence}`;
            activeTunnels.set(tunnelId, {
              id: tunnelId,
              kind: 'rdp',
              instanceId,
              instanceName: instanceName || instanceId,
              profileName,
              port: availablePort,
              remotePort: 3389,
              ssmProcess,
              rdpProcess: null,
              startedAt: Date.now()
            });
            broadcastTunnels();

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
                  closeTunnel(tunnelId);
                  resolve({ success: false, error: 'No RDP client found. Please install remmina, xfreerdp, or rdesktop.' });
                  return;
                }
              }

              if (rdpProcess) {
                const tunnel = activeTunnels.get(tunnelId);
                if (tunnel) tunnel.rdpProcess = rdpProcess;

                // Closing the RDP window tears the tunnel down with it
                rdpProcess.on('close', () => closeTunnel(tunnelId));

                rdpProcess.on('error', (error) => {
                  closeTunnel(tunnelId);
                  if (platform === 'win32' && error.code === 'ENOENT') {
                    resolve({ success: false, error: 'Remote Desktop client not found. Please ensure mstsc is available.' });
                  } else if (platform === 'darwin') {
                    resolve({ success: false, error: 'RDP client not found. Please install Microsoft Remote Desktop from the Mac App Store, or try: brew install --cask microsoft-remote-desktop' });
                  } else {
                    resolve({ success: false, error: `RDP client error: ${error.message}` });
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
            resolve({ success: false, error: 'Instance not available for SSM connection. Ensure SSM agent is running and the instance is a Windows instance.' });
          }
        });

        // Keeps the registry honest if the session dies on its own
        ssmProcess.on('close', () => {
          if (tunnelId && activeTunnels.has(tunnelId)) {
            closeTunnel(tunnelId);
          }
        });

        ssmProcess.on('error', (error) => {
          if (tunnelId) closeTunnel(tunnelId);
          if (error.code === 'ENOENT') {
            resolve({ success: false, error: 'AWS CLI not found. Please ensure AWS CLI is installed and in your PATH.' });
          } else {
            resolve({ success: false, error: `SSM tunnel error: ${error.message}` });
          }
        });

        setTimeout(() => {
          if (!tunnelEstablished) {
            killProcessTree(ssmProcess);
            resolve({ success: false, error: 'Timeout waiting for SSM tunnel to establish. Please check instance connectivity and ensure it is a Windows instance with SSM agent running.' });
          }
        }, 30000);
      }).catch(portError => {
        resolve({ success: false, error: `Could not find available port: ${portError.message}` });
      });
    });
  });
}

app.whenReady().then(() => {
  createWindow();
  setupIpcHandlers();
});

// Tunnels are child processes that outlive the app unless they are terminated
// explicitly, so every exit path closes them.
app.on('before-quit', closeAllTunnels);
app.on('will-quit', closeAllTunnels);
process.on('exit', closeAllTunnels);

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
