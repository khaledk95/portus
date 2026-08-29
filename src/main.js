// SET ENVIRONMENT FIRST
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

const { app, BrowserWindow, ipcMain, shell, Menu } = require('electron');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs-extra');
const ini = require('ini');
const os = require('os');
const https = require('https');

// AWS SDK imports (EC2 only - needed to list SSM/RDP targets)
const { EC2Client, DescribeInstancesCommand, DescribeRegionsCommand } = require('@aws-sdk/client-ec2');
const { SSMClient, DescribeInstanceInformationCommand } = require('@aws-sdk/client-ssm');
const { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } = require('@aws-sdk/client-rds');
const {
  ElastiCacheClient,
  DescribeReplicationGroupsCommand,
  DescribeCacheClustersCommand
} = require('@aws-sdk/client-elasticache');
const { EKSClient, ListClustersCommand, DescribeClusterCommand } = require('@aws-sdk/client-eks');
const { STSClient, AssumeRoleWithSAMLCommand, AssumeRoleCommand } = require('@aws-sdk/client-sts');
const { fromIni } = require('@aws-sdk/credential-providers');
const azureSaml = require('./azure-saml');

let mainWindow;

// Last Azure AD SSO profile used for a successful login — enables silent re-auth
let lastSsoProfile = null;

// ============================================================================
// MULTI-FACTOR AUTHENTICATION
// ============================================================================
//
// A profile carrying mfa_serial cannot produce credentials until someone types a
// six-digit code. Nothing in a desktop app can do that on its own, so the request
// is forwarded to the renderer and the answer handed back to the SDK.
//
// Without this the AWS CLI still asks — but it asks on a stdin that is piped to
// nothing, so a port forward sat for thirty seconds and then blamed Systems
// Manager for a problem that was never there.

let mfaRequestSequence = 0;
const pendingMfaRequests = new Map();

// Two minutes: long enough to unlock a phone and read a code, short enough that a
// dialog nobody answered does not hold an AWS call open forever.
const MFA_PROMPT_TIMEOUT_MS = 120000;

// The device serial the SDK passes in is an ARN naming the account and the user.
// It is not forwarded: the dialog asks for a code, and knowing which authenticator
// entry to open is something only the person holding the phone can do anyway.
function askRendererForMfaCode(profileName) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      reject(new Error(`Profile "${profileName}" requires an MFA code and there is no window to ask in.`));
      return;
    }

    const id = `mfa-${++mfaRequestSequence}`;

    const timer = setTimeout(() => {
      pendingMfaRequests.delete(id);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mfa-cancelled', { id });
      reject(new Error('No MFA code was entered in time.'));
    }, MFA_PROMPT_TIMEOUT_MS);

    pendingMfaRequests.set(id, { resolve, reject, timer });
    mainWindow.webContents.send('mfa-required', { id, profileName });
  });
}

function settleMfaRequest(id, code) {
  const pending = pendingMfaRequests.get(id);
  if (!pending) return false;

  clearTimeout(pending.timer);
  pendingMfaRequests.delete(id);

  if (code) pending.resolve(code);
  else pending.reject(new Error('MFA code entry was cancelled.'));

  return true;
}

// Credentials Portus resolved itself, kept until they expire.
//
// Two things land here: what an Azure sign-in produced, and what an MFA prompt
// produced. Neither is written to ~/.aws/credentials, and the SDK provider is
// rebuilt for every client, so without this cache the user would be asked again
// for the instance list, again for the SSM inventory, and again for every refresh.
const sessionCredentialCache = new Map();

// A minute of headroom, so credentials are not handed to a tunnel that outlives them
const CREDENTIAL_SKEW_MS = 60000;

function cachedSessionCredentials(profileName) {
  const entry = sessionCredentialCache.get(profileName);
  if (!entry) return null;

  if (entry.expiration && entry.expiration.getTime() - Date.now() < CREDENTIAL_SKEW_MS) {
    sessionCredentialCache.delete(profileName);
    return null;
  }

  return entry;
}

// The nearest profile up a source_profile chain whose credentials Portus is
// holding, or null. Cheap enough to ask before every call.
async function cachedAncestorOf(profileName) {
  const all = await describeProfiles();
  const byName = new Map(all.map(profile => [profile.name, profile]));

  const chain = sourceProfileChain(profileName, byName);
  const index = chain.findIndex(name => cachedSessionCredentials(name));

  return index === -1 ? null : { chain, index, byName };
}

// Assume-role chains that start at a profile Portus signed in itself.
//
// The SDK cannot do this one: chaining reads the source profile's credentials out
// of ~/.aws/credentials, and an Azure sign-in deliberately never writes them
// there. So the hops are walked here instead, from the signed-in profile down to
// the one that was asked for. The tool this replaced got the same result by
// writing keys to disk, which is exactly what we are not doing.
async function credentialsFromCachedAncestor(profileName) {
  const found = await cachedAncestorOf(profileName);
  if (!found) return null;

  const { chain, index, byName } = found;

  let credentials = cachedSessionCredentials(chain[index]).credentials;

  // Back down the chain: the ancestor's child first, the asked-for profile last
  const hops = [...chain.slice(0, index).reverse(), profileName];

  for (const name of hops) {
    const hop = byName.get(name);

    // Not an assume-role hop, so there is nothing here to walk. Falling through
    // to the SDK is right: it may still resolve this profile some other way.
    if (!hop || !hop.roleArn) return null;

    const sts = new STSClient({ region: hop.region || 'us-east-1', credentials });
    const response = await sts.send(new AssumeRoleCommand({
      RoleArn: hop.roleArn,
      RoleSessionName: hop.roleSessionName || 'portus',
      ...(hop.durationSeconds ? { DurationSeconds: hop.durationSeconds } : {}),
      ...(hop.externalId ? { ExternalId: hop.externalId } : {}),
      ...(hop.mfaSerial ? {
        SerialNumber: hop.mfaSerial,
        TokenCode: await askRendererForMfaCode(name)
      } : {})
    }));

    const issued = response.Credentials;
    if (!issued) throw new Error(`AWS returned no credentials for ${hop.roleArn}.`);

    credentials = {
      accessKeyId: issued.AccessKeyId,
      secretAccessKey: issued.SecretAccessKey,
      sessionToken: issued.SessionToken,
      expiration: issued.Expiration ? new Date(issued.Expiration) : null
    };

    // Every hop is cached, not only the last: a sibling profile assuming from the
    // same intermediate reuses it instead of repeating the chain, and an MFA code
    // is asked for once rather than once per profile.
    sessionCredentialCache.set(name, { credentials, expiration: credentials.expiration });
  }

  return credentials;
}

// IMPORTANT: the AWS SDK caches ~/.aws/config and ~/.aws/credentials in-process
// (@smithy/shared-ini-file-loader slurpFile keeps a module-level promise hash).
// Anything that edits them while Portus runs — `aws sso login`, `aws configure`,
// a hand edit, the Refresh button's whole reason for existing — is invisible
// without ignoreCache, and the app keeps using stale or expired credentials until
// the process restarts.
//
// Resolved credentials are deliberately NOT cached for ordinary profiles, for the
// same reason: a fresh login has to take effect immediately. Only the MFA case
// caches, because there the alternative is prompting on every single call.
function awsCredentials(profileName) {
  return async () => {
    const cached = cachedSessionCredentials(profileName);
    if (cached) return cached.credentials;

    const profile = await findProfile(profileName);

    // Only a profile that chains can be reached this way, and checking costs a
    // read of ~/.aws — so the ones that cannot are not asked about.
    if (profile && profile.sourceProfile) {
      const chained = await credentialsFromCachedAncestor(profileName);
      if (chained) return chained;
    }

    const needsMfa = !!(profile && profile.mfaSerial);

    const credentials = await fromIni({
      profile: profileName,
      ignoreCache: true,
      ...(needsMfa ? { mfaCodeProvider: () => askRendererForMfaCode(profileName) } : {})
    })();

    if (needsMfa) {
      sessionCredentialCache.set(profileName, {
        credentials,
        expiration: credentials.expiration ? new Date(credentials.expiration) : null
      });
    }

    return credentials;
  };
}

// Credentials the CLI cannot find for itself, handed over in the environment.
//
// Three cases need this. An MFA profile, where the CLI would otherwise prompt for
// a code on a stdin nothing is attached to. An Azure profile signed in through
// Portus, where the credentials were never written to ~/.aws/credentials at all.
// And a profile that assumes a role from one of those, which the CLI cannot chain
// for the same reason.
//
// Returns null when there is nothing to hand over, which is what keeps profiles
// signed in by some other tool working exactly as they always did: no environment,
// the --profile flag stays, and the CLI reads the files itself.
async function cliCredentialEnv(profileName) {
  const profile = await findProfile(profileName);
  if (!profile) return null;

  const cached = cachedSessionCredentials(profileName);
  const needsResolving = cached
    || profile.mfaSerial
    || (profile.sourceProfile && await cachedAncestorOf(profileName));
  if (!needsResolving) return null;

  const credentials = await awsCredentials(profileName)();

  return {
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    ...(credentials.sessionToken ? { AWS_SESSION_TOKEN: credentials.sessionToken } : {})
  };
}

// "…requires MFA" is not "your session expired": signing in again fixes the second
// and does nothing for the first.
function isMfaError(error) {
  if (!error) return false;
  return /MFA|multi-?factor|TokenCode|mfa_serial/i.test(`${error.name || ''} ${error.message || ''}`);
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

// "You may not do this" rather than "we do not know who you are". The two look
// alike — isCredentialsError deliberately matches "is not authorized" so a stale
// session is caught early — but only one of them is fixed by signing in again.
// Re-authenticating on a permissions gap loops without ever succeeding, so any
// caller that can carry on with partial results must check this first.
function isAuthorizationError(error) {
  if (!error) return false;
  const haystack = `${error.name || ''} ${error.Code || error.code || ''} ${error.message || ''}`;

  return /AccessDenied|AccessDeniedException|UnauthorizedOperation|not authorized to perform/i.test(haystack);
}

// AWS spells an authorization failure out in full:
//   "User: arn:aws:sts::123456789012:assumed-role/Team/alice is not authorized
//    to perform: rds:DescribeDBInstances on resource: ..."
// The account id, role and username in there are of no use in a toast, but they
// do leak the moment someone screenshots it into a bug report. Only the denied
// action is kept, which is the part that says what to add to the policy.
function describeDeniedAction(error) {
  const message = (error && error.message) || '';
  const action = message.match(/not authorized to perform:?\s*([A-Za-z0-9]+:[A-Za-z0-9]+)/);

  if (action) return `not authorized to perform ${action[1]}`;
  if (isAuthorizationError(error)) return 'access denied';

  return message || 'request failed';
}

// ============================================================================
// RELEASE NOTIFICATION
// ============================================================================
//
// Portus tells you a newer version exists and links to it. It does not download
// or install anything: the builds are unsigned, so Squirrel would refuse the
// macOS update outright, and installing means quitting — which closes every open
// tunnel. Being told is the whole feature.

const UPDATE_CHECK_TIMEOUT_MS = 5000;

// Deliberately constants, and never read out of package.json. electron-builder
// strips the whole build block when it packages the app — it is build
// configuration, not runtime data — so anything under it exists in a checkout and
// is undefined in every installed copy. v2.3.0 read the owner and repo from there
// and shipped an update check that threw before making a request, which nothing
// caught because the tests and the probe written to confirm the feature both ran
// against the source tree, where the key was still present.
const GITHUB_OWNER = 'khaledk95';
const GITHUB_REPO = 'portus';
const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

// Compares two dot-separated versions. Anything after a dash — 2.3.0-beta.1 —
// is ignored rather than half-understood; releases/latest excludes prereleases,
// so it should never arrive in the first place.
function compareVersions(left, right) {
  const parts = value => String(value || '')
    .replace(/^v/, '')
    .split('-')[0]
    .split('.')
    .map(piece => parseInt(piece, 10) || 0);

  const a = parts(left);
  const b = parts(right);

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }

  return 0;
}

function fetchLatestRelease(owner, repo) {
  return new Promise((resolve, reject) => {
    const request = https.get({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/releases/latest`,
      headers: {
        // GitHub rejects requests without one
        'User-Agent': `Portus/${app.getVersion()}`,
        Accept: 'application/vnd.github+json'
      },
      timeout: UPDATE_CHECK_TIMEOUT_MS
    }, response => {
      // Redirects and errors are not worth following for something optional
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`GitHub returned ${response.statusCode}`));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error('Could not read the release feed'));
        }
      });
    });

    request.on('timeout', () => request.destroy(new Error('The release check timed out')));
    request.on('error', reject);
  });
}

// Never throws and never blocks anything. Offline, rate-limited or GitHub down
// all mean the same thing: no notification this time.
async function checkForNewRelease() {
  try {
    const release = await fetchLatestRelease(GITHUB_OWNER, GITHUB_REPO);

    const latest = String(release.tag_name || '').replace(/^v/, '');
    const current = app.getVersion();

    if (!latest || compareVersions(latest, current) <= 0) {
      return { available: false, current };
    }

    return {
      available: true,
      current,
      version: latest,
      // Rendered as text by the renderer, never as markup — this string comes
      // over the network.
      notes: String(release.body || '').trim(),
      url: release.html_url || RELEASES_URL,
      releasesUrl: RELEASES_URL
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

// Electron gives every app a File / Edit / View / Window / Help menu. Portus has
// nothing to put in it, and on Windows and Linux it is drawn inside the window,
// sitting above the app's own top bar.
//
// Not removed on macOS. There the menu lives in the system bar rather than the
// window, so it costs nothing visually, and macOS routes Cmd+C, Cmd+V and Cmd+Q
// through it — an app with no menu loses copy, paste and quit entirely.
function applyApplicationMenu() {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
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
      sandbox: true,
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
  // Azure AD needs nothing here: that sign-in runs in the app, see src/azure-saml.js
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
  // A tool tied to a provider is only checked when a profile actually uses it
  let providersInUse = new Set();
  try {
    providersInUse = new Set((await readAwsProfiles()).map(profile => profile.provider));
  } catch (error) {
    // If ~/.aws cannot be read, check everything rather than silently skipping
    providersInUse = new Set(REQUIRED_TOOLS.map(tool => tool.neededFor).filter(Boolean));
  }

  const applicable = REQUIRED_TOOLS.filter(tool => !tool.neededFor || providersInUse.has(tool.neededFor));

  return Promise.all(applicable.map(async tool => ({
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
    startedAt: tunnel.startedAt,
    // Present only on a tunnel to a cluster; it is what puts a kubectl action on
    // the row rather than just an address to copy.
    kubernetes: tunnel.kubernetes || null
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

// Kubernetes tunnels prefer a settled port so the generated kubeconfig usually
// does not change between sessions, which in turn means an already-open terminal
// keeps working. Any of these being taken is not an error — the kubeconfig is
// rewritten with whatever was actually bound, so correctness never depends on
// getting the preferred one.
const KUBE_PORTS = [6443, 6444, 6445, 6446, 6447];

async function findKubePort() {
  for (const port of KUBE_PORTS) {
    try {
      return await ensurePortFree(port);
    } catch (error) { /* taken; try the next */ }
  }
  return findFreePort();
}

// The tunnel command is handed to a shell, which is unavoidable on Windows: it is
// what makes the quoting around --parameters survive. Characters a shell would act
// on therefore must never reach it, so the host is restricted to what a hostname or
// IP can legitimately contain. This also protects any future caller that supplies a
// host from somewhere other than the dialog, such as a saved bookmark or a deep link.
const VALID_HOST = /^[A-Za-z0-9._:-]+$/;

// An instance id ends up on a command line too. EC2 only ever returns `i-` and
// hex, so this rejects nothing real — but the value arrives over IPC, and the
// shell it lands in is now PowerShell, which treats ; $ and ` as syntax where
// cmd did not. Validated for the same reason the host is: so that a caller other
// than the dialog cannot turn one into a command.
const VALID_INSTANCE_ID = /^[A-Za-z0-9-]{1,64}$/;

function validateInstanceId(instanceId) {
  if (!instanceId || !VALID_INSTANCE_ID.test(instanceId)) {
    return { valid: false, error: 'That does not look like an EC2 instance ID.' };
  }
  return { valid: true };
}

// The profile name lands on a command line too — `--profile ${profileName}` — and
// the ini parser keeps a section name verbatim, so `[profile x$(id)]` in a
// hand-edited or tool-written ~/.aws/config becomes a selectable profile whose
// name carries shell syntax. Every sibling parameter (instance id, region, host,
// port) is already validated for this; the profile name arrives over the same IPC
// channel and must be too. The character set is what AWS profile names use in
// practice: letters, digits, spaces and _ + = , . @ - (the set the CLI documents
// for IAM-friendly names), which rejects nothing real while excluding ; & | ` $ "
// and newlines.
const VALID_PROFILE = /^[A-Za-z0-9_+=,.@ -]{1,128}$/;

function validateProfileName(profileName) {
  if (!profileName || !VALID_PROFILE.test(profileName)) {
    return { valid: false, error: 'That profile name contains characters Portus will not pass to a shell.' };
  }
  return { valid: true };
}

function validateRemoteHost(host) {
  if (!host) return { valid: true };

  if (host.length > 255) {
    return { valid: false, error: 'Remote host is too long to be a valid hostname.' };
  }
  if (!VALID_HOST.test(host)) {
    return {
      valid: false,
      error: 'Remote host may only contain letters, digits, dots, hyphens, underscores and colons.'
    };
  }
  return { valid: true };
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

// Launch the platform's RDP client against an established tunnel.
async function launchRdpClient(tunnelId, localPort) {
  const platform = process.platform;

  // Bind the client to the tunnel so closing the RDP window closes the tunnel
  const attach = (proc) => {
    const tunnel = activeTunnels.get(tunnelId);
    if (tunnel) tunnel.rdpProcess = proc;
    proc.on('close', () => closeTunnel(tunnelId));
    proc.on('error', () => closeTunnel(tunnelId));
    return proc;
  };

  if (platform === 'win32') {
    attach(spawn('mstsc', [`/v:localhost:${localPort}`], { detached: false }));
    return { success: true };
  }

  if (platform === 'darwin') {
    // `open` hands off to the RDP app and exits straight away, so its lifetime
    // says nothing about the session. Tying the tunnel to it would tear the
    // tunnel down the instant the client launched, so the tunnel is left to the
    // Disconnect button or app exit instead.
    const primary = spawn('open', ['-a', 'Microsoft Remote Desktop', `rdp://localhost:${localPort}`], { detached: false });

    primary.on('error', (error) => {
      if (error.code === 'ENOENT') {
        spawn('open', [`rdp://localhost:${localPort}`], { detached: false });
      } else {
        closeTunnel(tunnelId);
      }
    });

    const tunnel = activeTunnels.get(tunnelId);
    if (tunnel) tunnel.rdpProcess = null;
    return { success: true };
  }

  // Linux: spawn does not fail synchronously for a missing binary, so the old
  // loop always "succeeded" on the first entry and never really fell back.
  // Resolving each command on PATH first makes the fallback real.
  const clients = [
    { command: 'remmina', args: ['--connect', `rdp://localhost:${localPort}`] },
    { command: 'xfreerdp', args: [`/v:localhost:${localPort}`, '/cert-ignore'] },
    { command: 'rdesktop', args: [`localhost:${localPort}`] }
  ];

  for (const client of clients) {
    if (await isCommandAvailable(client.command)) {
      attach(spawn(client.command, client.args, { detached: false }));
      return { success: true };
    }
  }

  return {
    success: false,
    error: 'No RDP client found. Please install remmina, xfreerdp, or rdesktop.'
  };
}

// ============================================================================
// KUBERNETES
// ============================================================================
//
// A private EKS cluster answers on an address only reachable inside the VPC, so
// the tunnel is the same one a database gets. The part that needs explaining is
// the kubeconfig.
//
// kubectl is pointed at localhost, but the cluster's certificate is issued for
// its real endpoint name. Rather than turn verification off, the generated file
// sets tls-server-name, which fixes the name used for SNI and validation
// independently of the URL. Verification stays fully on.
//
// The file is written per cluster at a stable path and rewritten whenever the
// tunnel reopens. kubectl re-reads it on every invocation, so a terminal opened
// an hour ago keeps working after a reconnect on a different local port.
//
// Nothing secret goes in it: an address, the cluster's public CA, and an exec
// stanza that calls out for a token. Credentials stay in memory, as everywhere
// else.

// new URL().hostname lowercases, and an EKS endpoint id is genuinely mixed case.
// DNS and certificate name matching are both case-insensitive, so lowercasing
// would almost certainly work — but tls-server-name is the single line this whole
// approach rests on, and there is no reason to hand it anything other than
// exactly what AWS returned.
function hostnameOf(endpoint) {
  return String(endpoint).replace(/^https?:\/\//i, '').replace(/[:/].*$/, '');
}

function kubeconfigDir() {
  return path.join(app.getPath('userData'), 'kube');
}

// Every kubeconfig written this run, so exit can clear them.
//
// Only these are removed — not the directory, and not anything else that might
// be sitting in it. The directory belongs to Portus, but deleting by pattern
// would mean trusting that forever; deleting a list we built ourselves cannot
// take a file we did not create.
const writtenKubeconfigs = new Set();

function clearKubeconfigs() {
  for (const file of writtenKubeconfigs) {
    // Synchronous on purpose: this also runs from the process 'exit' handler,
    // where anything async would never get the chance to run.
    try { fs.removeSync(file); } catch (error) { /* already gone */ }
  }
  writtenKubeconfigs.clear();
}

function kubeconfigPathFor(clusterName) {
  const safe = String(clusterName).replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(kubeconfigDir(), `${safe}.yaml`);
}

// Values are quoted rather than trusted: cluster names are tame, but an endpoint
// and a CA blob both end up in a file another program parses.
const yamlString = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

async function writeKubeconfig({ clusterName, region, localPort, profileName, useEnvCredentials }) {
  const config = { credentials: awsCredentials(profileName), region };
  const { cluster } = await new EKSClient(config).send(new DescribeClusterCommand({ name: clusterName }));

  if (!cluster || !cluster.endpoint) throw new Error(`${clusterName} has no API endpoint.`);

  const endpointHost = hostnameOf(cluster.endpoint);
  const caData = (cluster.certificateAuthority || {}).data || '';
  const context = `portus:${clusterName}`;

  // AWS_PROFILE is pinned only when the CLI can resolve that profile by itself.
  // When Portus is holding the credentials — an Azure sign-in, an MFA session, a
  // chain rooted at either — they arrive in the environment instead, and naming
  // a profile here would send `aws eks get-token` looking on disk for something
  // that was deliberately never written there.
  const env = useEnvCredentials ? '' : `
      env:
        - name: AWS_PROFILE
          value: ${yamlString(profileName)}`;

  const body = `# Written by Portus. Regenerated whenever the tunnel reopens.
# Points at the local end of an SSM tunnel; tls-server-name keeps certificate
# verification honest against the cluster's real endpoint name.
apiVersion: v1
kind: Config
current-context: ${yamlString(context)}
clusters:
  - name: ${yamlString(clusterName)}
    cluster:
      server: ${yamlString(`https://localhost:${localPort}`)}
      tls-server-name: ${yamlString(endpointHost)}
      certificate-authority-data: ${yamlString(caData)}
contexts:
  - name: ${yamlString(context)}
    context:
      cluster: ${yamlString(clusterName)}
      user: ${yamlString(clusterName)}
users:
  - name: ${yamlString(clusterName)}
    user:
      exec:
        apiVersion: client.authentication.k8s.io/v1beta1
        command: aws
        args:
          - --region
          - ${yamlString(region)}
          - eks
          - get-token
          - --cluster-name
          - ${yamlString(clusterName)}
          - --output
          - json${env}
`;

  const file = kubeconfigPathFor(clusterName);
  await fs.ensureDir(kubeconfigDir());
  await fs.writeFile(file, body, { mode: 0o600 });
  writtenKubeconfigs.add(file);

  return { path: file, context, endpointHost };
}

// Which shell the Windows terminals open in.
//
// PowerShell rather than cmd, because cmd's Tab completion cycles blindly
// through matches and is close to unusable for the long resource names these
// sessions deal in. PowerShell 7 first where it exists, then the Windows
// PowerShell every machine already has, and cmd only if neither answers.
//
// Resolved once: it cannot change while the app runs, and `where` on every
// terminal launch is a needless wait.
let windowsShellPromise = null;

function windowsShell() {
  if (!windowsShellPromise) {
    windowsShellPromise = (async () => {
      for (const shell of ['pwsh', 'powershell']) {
        if (await isCommandAvailable(shell)) return shell;
      }
      return 'cmd';
    })();
  }
  return windowsShellPromise;
}

// -NoExit is PowerShell's /k: run this, then leave me a prompt.
function windowsTerminalArgs(shell, command) {
  if (shell === 'cmd') {
    return command ? ['/c', 'start', 'cmd', '/k', command] : ['/c', 'start', 'cmd', '/k'];
  }
  return command
    ? ['/c', 'start', shell, '-NoExit', '-Command', command]
    : ['/c', 'start', shell, '-NoExit'];
}

// Opens a terminal the user can see, carrying an environment they cannot.
//
// Shared by the SSM shell and the kubectl session, which differ only in what
// they run: one execs a single command and ends with it, the other leaves an
// interactive shell behind. Everything awkward is the same for both — Terminal
// on macOS inherits nothing from a spawn, Linux has no single terminal to
// assume, and Windows needs `start` to get a window at all.
async function openTerminal({ command, env, interactive = false, scriptPath = null, message }) {
  const platform = process.platform;

  // Resolved before the promise: picking a shell is the one asynchronous part,
  // and everything after it is synchronous spawn plumbing.
  const shell = platform === 'win32' ? await windowsShell() : null;

  return new Promise((resolve) => {
    let launcher, args;

    if (platform === 'win32') {
      // `start` is what gets a console window at all — an Electron process
      // spawning a console app gets none otherwise.
      launcher = 'cmd';
      args = windowsTerminalArgs(shell, interactive && !command ? null : command);
    } else if (platform === 'darwin') {
      launcher = 'osascript';
      args = ['-e', `tell application "Terminal" to do script "${scriptPath || command}"`];
    } else {
      const shell = interactive && !command ? 'exec bash' : `${command}; exec bash`;
      const terminals = ['gnome-terminal', 'konsole', 'xterm', 'x-terminal-emulator'];

      launcher = terminals[0];
      args = ['--', 'bash', '-c', shell];
    }

    // detached is deliberately off on Windows. libuv turns it into
    // CREATE_NEW_PROCESS_GROUP, and Windows disables Ctrl+C for a new process
    // group and everything it spawns — so `kubectl logs -f` could not be
    // interrupted and the window looked hung. Nothing is lost by dropping it:
    // `cmd /c start` already opens an independent console that outlives Portus,
    // which is the only thing detached was there for.
    //
    // On the other platforms the terminal really is a child of this spawn, so it
    // stays.
    const terminalProcess = spawn(launcher, args, {
      detached: process.platform !== 'win32',
      stdio: 'ignore',
      env: { ...process.env, ...(env || {}) }
    });

    terminalProcess.on('spawn', () => {
      terminalProcess.unref();
      // The shell has read the script by the time it is running, so removing it
      // takes the credentials off disk while the session lives on.
      if (scriptPath) scheduleScriptRemoval(scriptPath);
      resolve({ success: true, message });
    });

    terminalProcess.on('error', (error) => {
      if (error.code === 'ENOENT') {
        resolve({
          success: false,
          error: platform === 'win32'
            ? 'Could not open Command Prompt. Please ensure cmd.exe is available.'
            : platform === 'darwin'
              ? 'Could not open Terminal. Please ensure Terminal.app is available.'
              : 'No suitable terminal emulator found. Please install gnome-terminal, konsole, or xterm.'
        });
      } else {
        resolve({ success: false, error: `Failed to open terminal: ${error.message}` });
      }

      if (scriptPath) scheduleScriptRemoval(scriptPath, 0);
    });
  });
}

// Every credential-script directory written this run, so exit can clear them.
// The delayed removal below handles the normal path; this list catches the
// rest — quitting inside the delay, or a removal that failed. Only directories
// we created are ever removed, never a sweep of the temp directory by pattern.
const writtenScriptDirs = new Set();

function clearScriptDirs() {
  for (const directory of writtenScriptDirs) {
    // Synchronous on purpose: this also runs from the process 'exit' handler,
    // where anything async would never get the chance to run.
    try { fs.removeSync(directory); } catch (error) { /* already gone */ }
  }
  writtenScriptDirs.clear();
}

// A private script that exports credentials and then becomes the AWS CLI.
//
// Only macOS needs this. Terminal.app is already running and does not inherit a
// spawned process's environment, so the credentials have to travel some other
// way, and the obvious one — writing them into the `do script` string — types
// them into the visible window and leaves them in shell history.
//
// Written 0600 inside a 0700 directory, and removed once the shell has read it.
async function writeCredentialScript(awsCommand, credentialEnv) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'portus-'), { mode: 0o700 });
  writtenScriptDirs.add(directory);
  const scriptPath = path.join(directory, 'session.sh');

  // A single-quoted string ends at the first quote inside it, so an unexpected
  // one would leave the rest of the value as shell. STS does not put quotes in
  // credentials, but this file becomes a shell script and is quoted accordingly.
  const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

  // exec, so the CLI replaces the shell and closing the session closes the window
  const body = [
    '#!/bin/sh',
    ...Object.entries(credentialEnv).map(([key, value]) => `export ${key}=${quote(value)}`),
    `exec ${awsCommand}`,
    ''
  ].join('\n');

  await fs.writeFile(scriptPath, body, { mode: 0o700 });

  return scriptPath;
}

// The shell reads the script once, at startup, so it can go immediately after.
// The delay is only to let that happen; the session itself is unaffected.
function scheduleScriptRemoval(scriptPath, delayMs = 5000) {
  const directory = path.dirname(scriptPath);
  setTimeout(() => {
    fs.remove(directory)
      // A successful removal takes the directory off the exit list; a failed
      // one leaves it there, so the shutdown sweep gets another chance at it.
      .then(() => writtenScriptDirs.delete(directory))
      .catch(() => { /* temp dir; nothing to do */ });
  }, delayMs).unref();
}

// Shared tunnel launcher for port forwarding. Resolves once the CLI reports the
// listener is up, or with an error; never rejects, so the message survives IPC.
function startSsmTunnel({ ssmCommand, kind, instanceId, instanceName, profileName, localPort, remoteHost, remotePort, credentialEnv }) {
  return new Promise(resolve => {
    const platform = process.platform;
    let established = false;
    let tunnelId = null;
    let stderrText = '';

    // credentialEnv is set only for a profile needing MFA, where the code has
    // already been entered and the credentials resolved here. Handing them over
    // this way leaves the CLI with nothing to prompt for on a stdin it cannot
    // reach — which is what used to stall the tunnel for thirty seconds.
    const env = { ...process.env, ...(credentialEnv || {}) };

    // shell:true on Windows is required: it is what makes Node pass the command
    // line through verbatim, so the quotes around --parameters survive.
    const proc = platform === 'win32'
      ? spawn('cmd', ['/c', ssmCommand], { stdio: 'pipe', shell: true, windowsHide: true, env })
      : spawn('bash', ['-c', `exec ${ssmCommand}`], {
          stdio: 'pipe',
          env: { ...env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin' }
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

// ============================================================================
// CREDENTIAL PROVIDERS
// ============================================================================
//
// Portus never authenticates. It hands a profile name to the AWS SDK and to the
// CLI, both of which already resolve every credential type AWS supports. The
// only thing a provider decides is whether Portus can *start a login* for that
// profile, and where the session expiry can be read from.
//
// Order matters: the first match wins, so the more specific entries come first.
// A profile with sso_session is an Identity Center profile even though it also
// has a region, and an Azure profile usually has role_arn too.
const CREDENTIAL_PROVIDERS = [
  {
    id: 'sso',
    label: 'Identity Center',
    detect: settings => !!(settings.sso_session || settings.sso_start_url)
  },
  {
    id: 'azure',
    label: 'Azure AD',
    // any azure_* key, so a profile configured with only some of them is still
    // recognised — which is what the previous detection did
    detect: settings => Object.keys(settings).some(key => key.toLowerCase().startsWith('azure_'))
  },
  {
    id: 'process',
    label: 'Credential process',
    detect: settings => !!settings.credential_process
  },
  {
    id: 'assume-role',
    label: 'Assume role',
    detect: settings => !!settings.role_arn
  },
  {
    id: 'static',
    label: 'Access keys',
    detect: settings => !!settings.aws_access_key_id
  },
  {
    id: 'unknown',
    label: 'Profile',
    detect: () => true
  }
];

// Logins Portus knows how to run itself. A provider missing from here is not
// unsupported — its credentials still resolve normally — it just cannot be
// refreshed from inside the app, the way access keys have nothing to refresh.
// Adding `aws sso login` here is what turns Identity Center from "works if you
// already logged in through the CLI" into "works from the button".
// Each runner receives the resolved profile, not just its name, because what a
// login needs differs: the Azure flow reads the tenant and app id off the profile,
// while `aws sso login` should target the session when the profile names one.
// `interactive` means the login cannot complete without the user doing something
// in another window. Those are never started on a timer: silently opening a
// browser at someone mid-task is worse than letting the session lapse and saying so.
const LOGIN_RUNNERS = {
  // Azure is not interactive in the sense that matters here: a renewal is
  // attempted without showing anything, and only asks when Microsoft would.
  azure: { run: (profile, options) => runAzureLogin(profile, options), interactive: false },
  sso: { run: profile => runSsoLogin(profile), interactive: true }
};

function detectProvider(settings) {
  return CREDENTIAL_PROVIDERS.find(provider => provider.detect(settings || {}))
    || CREDENTIAL_PROVIDERS[CREDENTIAL_PROVIDERS.length - 1];
}

// Every profile in ~/.aws, classified. The two files are merged per profile
// before detection, because the pieces that identify a provider are routinely
// split across them — sso_session in config, cached keys in credentials — and
// reading either alone misidentifies the profile.
//
// Only the whitelisted fields below are returned. The ini sections themselves
// are never handed to the renderer: aws_secret_access_key is legal in ~/.aws/config,
// and there is no reason for a secret to cross the IPC boundary to reach a
// dropdown that shows a name and a region.
async function describeProfiles() {
  const home = os.homedir();
  const sections = new Map();
  const ssoSessions = new Map();

  const remember = (name, settings, source) => {
    if (!name) return;
    const existing = sections.get(name);

    if (existing) {
      // config is authoritative where the two files disagree
      existing.settings = source === 'config'
        ? { ...existing.settings, ...settings }
        : { ...settings, ...existing.settings };
      return;
    }

    sections.set(name, { settings: { ...settings }, source });
  };

  const readIni = async (file) => {
    try {
      if (!(await fs.pathExists(file))) return null;
      return ini.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      return null;   // an unreadable or malformed file must not empty the list
    }
  };

  const config = await readIni(path.join(home, '.aws', 'config'));
  if (config) {
    Object.keys(config).forEach(key => {
      // [sso-session name] and [services name] are not profiles
      if (key === 'default') remember('default', config[key], 'config');
      else if (key.startsWith('profile ')) remember(key.slice('profile '.length).trim(), config[key], 'config');
      else if (key.startsWith('sso-session ')) ssoSessions.set(key.slice('sso-session '.length).trim(), config[key]);
    });
  }

  const credentials = await readIni(path.join(home, '.aws', 'credentials'));
  if (credentials) {
    Object.keys(credentials).forEach(key => {
      if (typeof credentials[key] === 'object') remember(key, credentials[key], 'credentials');
    });
  }

  return [...sections.entries()]
    .map(([name, { settings, source }]) => {
      const provider = detectProvider(settings);

      // An Identity Center profile keeps its portal URL either inline (the older
      // layout) or in the [sso-session] section it names. Resolving it here is
      // what lets the cached token for this profile be found later.
      const sessionName = settings.sso_session || null;
      const session = sessionName ? ssoSessions.get(sessionName) : null;
      const ssoStartUrl = settings.sso_start_url || (session && session.sso_start_url) || null;
      const ssoRegion = settings.sso_region || (session && session.sso_region) || null;

      return {
        name,
        region: settings.region || 'us-east-1',
        source,
        provider: provider.id,
        providerLabel: provider.label,
        canLogin: Object.prototype.hasOwnProperty.call(LOGIN_RUNNERS, provider.id),
        interactiveLogin: !!(LOGIN_RUNNERS[provider.id] && LOGIN_RUNNERS[provider.id].interactive),
        // the device AWS wants a code from before it will assume the role
        mfaSerial: settings.mfa_serial || null,
        requiresMfa: !!settings.mfa_serial,
        // what the SAML request needs. The tenant and app id identify the
        // organisation, so they stay here rather than crossing to the renderer.
        azureTenantId: settings.azure_tenant_id || null,
        azureAppIdUri: settings.azure_app_id_uri || settings.azure_app_id || null,
        azureDefaultRoleArn: settings.azure_default_role_arn || null,
        azureDurationHours: parseInt(settings.azure_default_duration_hours, 10) || null,
        // the profile this one assumes a role from; a sign-in to that profile is
        // what makes this one work
        sourceProfile: settings.source_profile || null,
        // the assume-role hop itself, needed when Portus has to walk the chain
        // rather than leave it to the SDK
        roleArn: settings.role_arn || null,
        roleSessionName: settings.role_session_name || null,
        externalId: settings.external_id || null,
        durationSeconds: parseInt(settings.duration_seconds, 10) || null,
        ssoSession: sessionName,
        ssoStartUrl,
        ssoRegion
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// The IPC-facing view. ssoStartUrl names the organisation's sign-in portal, so it
// stays in the main process — the dropdown only ever needs a name and a region.
// requiresMfa crosses as a boolean; mfaSerial itself is an ARN naming the user and
// account, and the dialog only needs to know that a code is wanted.
const PROFILE_FIELDS_FOR_RENDERER = [
  'name', 'region', 'source', 'provider', 'providerLabel', 'canLogin', 'interactiveLogin', 'requiresMfa'
];

async function readAwsProfiles() {
  return (await describeProfiles()).map(profile =>
    Object.fromEntries(PROFILE_FIELDS_FOR_RENDERER.map(key => [key, profile[key]])));
}

async function findProfile(profileName) {
  if (!profileName) return null;
  return (await describeProfiles()).find(profile => profile.name === profileName) || null;
}

// What the sign-in dialog offers — which is not the same as the profile list.
//
// An Identity Center token belongs to the portal session, not to a profile: one
// `aws sso login` for a session covers every profile that names it. Listing them
// per profile would offer the same login several times over, each appearing to do
// something different. They are grouped by session instead.
//
// An Azure sign-in really is per profile — the tenant, the app and the role all
// come off the profile — and an older Identity Center profile with an inline
// sso_start_url has no session name to group under, so both stay individual
// entries.
async function readLoginTargets() {
  const all = await describeProfiles();
  const byName = new Map(all.map(profile => [profile.name, profile]));

  const targets = [];
  const sessions = new Map();
  const ownerOf = new Map();   // profile name -> the target that signs it in

  all.filter(profile => profile.canLogin).forEach(profile => {
    if (profile.provider === 'sso' && profile.ssoSession) {
      const existing = sessions.get(profile.ssoSession);
      if (existing) {
        existing.profileCount += 1;
        ownerOf.set(profile.name, existing);
        return;
      }

      const target = {
        id: `sso-session:${profile.ssoSession}`,
        label: profile.ssoSession,
        provider: profile.provider,
        providerLabel: profile.providerLabel,
        // the login runs against a profile; any member resolves to the same session
        profileName: profile.name,
        profileCount: 1
      };
      sessions.set(profile.ssoSession, target);
      ownerOf.set(profile.name, target);
      targets.push(target);
      return;
    }

    const target = {
      id: `profile:${profile.name}`,
      label: profile.name,
      provider: profile.provider,
      providerLabel: profile.providerLabel,
      profileName: profile.name,
      profileCount: 1,
      region: profile.region
    };
    ownerOf.set(profile.name, target);
    targets.push(target);
  });

  // Profiles that assume a role from one of the above are made usable by that
  // same sign-in — see credentialsFromCachedAncestor, which walks the hops. This
  // is how one Azure sign-in covers a whole set of accounts, so those profiles
  // belong in the count.
  all.forEach(profile => {
    if (ownerOf.has(profile.name)) return;   // signs itself in; already counted

    for (const ancestor of sourceProfileChain(profile.name, byName)) {
      const target = ownerOf.get(ancestor);
      if (target) {
        target.profileCount += 1;
        break;   // the nearest sign-in wins; anything above it is that one's problem
      }
    }
  });

  return targets.sort((a, b) => a.label.localeCompare(b.label));
}

// Walk source_profile upwards. Bounded and cycle-guarded: a self-referential or
// mutually referential pair is a broken config, not a reason to hang.
function sourceProfileChain(name, byName, maxDepth = 10) {
  const chain = [];
  const seen = new Set([name]);
  let current = byName.get(name);

  while (current && current.sourceProfile && chain.length < maxDepth) {
    const next = current.sourceProfile;
    if (seen.has(next)) break;

    seen.add(next);
    chain.push(next);
    current = byName.get(next);
  }

  return chain;
}

// Start whatever login the profile's provider declares, and remember it so the
// session can later be refreshed without asking again. Throws when the provider
// has no login — which is not a failure state, only a thing this cannot do.
async function runLoginFor(profileName, options = {}) {
  const profile = (await describeProfiles()).find(p => p.name === profileName);
  if (!profile) throw new Error(`Profile "${profileName}" was not found in ~/.aws`);

  const runner = LOGIN_RUNNERS[profile.provider];
  if (!runner) {
    throw new Error(`${profile.providerLabel} profiles have no sign-in for Portus to run.`);
  }

  const result = await runner.run(profile, options);
  lastSsoProfile = profileName;

  return { ...result, provider: profile.provider, providerLabel: profile.providerLabel };
}

// ============================================================================
// AZURE AD SIGN-IN
// ============================================================================
//
// The SAML flow itself lives in src/azure-saml.js.
//
// The credentials this produces are never written to ~/.aws/credentials. They
// live in the same in-memory cache the MFA path uses and reach the CLI through
// the environment, so signing in leaves nothing on disk.

let pendingRoleChoice = null;

// Asks which role to assume when the assertion offers more than one and the
// profile does not name a default.
function askRendererToChooseRole(profileName, roles) {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      reject(new Error('There is no window to choose a role in.'));
      return;
    }

    const id = `role-${Date.now()}`;
    pendingRoleChoice = { id, resolve, reject };

    mainWindow.webContents.send('role-choice-required', {
      id,
      profileName,
      // Only the role ARNs. The principal is an implementation detail the
      // renderer has no use for.
      roles: roles.map(role => role.roleArn)
    });
  });
}

function settleRoleChoice(id, roleArn) {
  if (!pendingRoleChoice || pendingRoleChoice.id !== id) return false;

  const { resolve, reject } = pendingRoleChoice;
  pendingRoleChoice = null;

  if (roleArn) resolve(roleArn);
  else reject(new Error('Role selection was cancelled.'));

  return true;
}

async function runAzureLogin(profile, { silent = false } = {}) {
  const { samlResponse, roles } = await azureSaml.requestAssertion(profile, {
    silent,
    parent: mainWindow
  });

  // A profile naming its role is the normal case, and the reason a renewal can
  // complete without asking anything.
  let chosen = profile.azureDefaultRoleArn
    ? roles.find(role => role.roleArn === profile.azureDefaultRoleArn)
    : null;

  if (!chosen) {
    if (roles.length === 1) {
      chosen = roles[0];
    } else if (silent) {
      throw new Error('More than one role is available and the profile names no default.');
    } else {
      const roleArn = await askRendererToChooseRole(profile.name, roles);
      chosen = roles.find(role => role.roleArn === roleArn);
      if (!chosen) throw new Error('That role was not in the assertion.');
    }
  }

  const sts = new STSClient({ region: profile.region || 'us-east-1' });
  const response = await sts.send(new AssumeRoleWithSAMLCommand({
    RoleArn: chosen.roleArn,
    PrincipalArn: chosen.principalArn,
    SAMLAssertion: samlResponse,
    ...(profile.azureDurationHours ? { DurationSeconds: profile.azureDurationHours * 3600 } : {})
  }));

  const credentials = response.Credentials;
  if (!credentials) throw new Error('AWS returned no credentials for that role.');

  sessionCredentialCache.set(profile.name, {
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      expiration: credentials.Expiration ? new Date(credentials.Expiration) : null
    },
    expiration: credentials.Expiration ? new Date(credentials.Expiration) : null
  });

  return { success: true, roleArn: chosen.roleArn };
}


// Run `aws sso login` for an IAM Identity Center profile.
//
// This one leaves the app: the CLI opens the portal in the user's browser and
// blocks until they approve, so the timeout is minutes rather than seconds.
// The CLI prints a verification code that AWS asks the user to confirm in the
// browser; it is forwarded to the renderer as soon as it appears, because a code
// the user cannot see is a code they cannot check.
function runSsoLogin(profile, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    const platform = process.platform;

    // The token is issued per session, so sign in against the session where the
    // profile names one — that is the unit the cache is keyed on, and it covers
    // every other profile pointing at the same portal. Profiles carrying an
    // inline sso_start_url have no session to name and fall back to themselves,
    // which also keeps this working on AWS CLI older than v2.9.
    const args = profile.ssoSession
      ? ['sso', 'login', '--sso-session', profile.ssoSession]
      : ['sso', 'login', '--profile', profile.name];

    // The session and profile names come from ~/.aws/config itself, and a
    // pasted or shared file can carry shell syntax in them. On Windows the
    // shell stays: that is how the CLI's aws.cmd shim is found and quoted. On
    // macOS and Linux the arguments above cross as plain argv — no shell ever
    // sees them — and the PATH below is what resolves `aws` without one.
    const spawnOptions = platform === 'win32'
      ? { stdio: 'pipe', shell: true, windowsHide: true }
      : {
          stdio: 'pipe',
          env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin:/usr/bin' }
        };

    const proc = spawn('aws', args, spawnOptions);

    let output = '';
    let errorOutput = '';
    let codeSent = false;
    let hasResponded = false;

    const timeout = setTimeout(() => {
      if (hasResponded) return;
      hasResponded = true;
      killProcessTree(proc);
      reject({
        success: false,
        error: `Sign-in timed out after ${Math.round(timeoutMs / 60000)} minutes. The browser approval was not completed.`
      });
    }, timeoutMs);

    // AWS prints the pairing code as XXXX-XXXX alongside the verification URL.
    // Both stdout and stderr are scanned because the CLI has moved it between the
    // two across versions.
    const scanForCode = (text) => {
      if (codeSent) return;
      const match = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
      if (!match) return;

      codeSent = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sso-verification', {
          profileName: profile.name,
          session: profile.ssoSession || null,
          code: match[1]
        });
      }
    };

    proc.stdout.on('data', data => {
      const text = data.toString();
      output += text;
      scanForCode(text);
    });
    proc.stderr.on('data', data => {
      const text = data.toString();
      errorOutput += text;
      scanForCode(text);
    });

    proc.on('close', code => {
      if (hasResponded) return;
      hasResponded = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve({ success: true, output });
        return;
      }
      reject({
        success: false,
        error: `Sign-in failed: ${(errorOutput || output || `aws sso login exited with code ${code}`).trim()}`
      });
    });

    proc.on('error', error => {
      if (hasResponded) return;
      hasResponded = true;
      clearTimeout(timeout);

      reject({
        success: false,
        error: error.code === 'ENOENT'
          ? 'The AWS CLI was not found. Install AWS CLI v2 and make sure "aws" is on your PATH.'
          : `Could not start aws sso login: ${error.message}`
      });
    });
  });
}

// Read a session expiry out of ~/.aws/credentials, for profiles signed in by
// something other than Portus — an external SAML tool, a credential helper, a
// script — all of which write one of these keys next to the temporary keys they
// issue. Portus's own sign-ins never reach here; their expiry comes from the
// credentials it is holding.
//
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
        const parsed = parseAwsTimestamp(section[key]);
        if (parsed) return parsed;
      }
    }

    return null;
  } catch (error) {
    return null;
  }
}

// The AWS CLI writes SSO expiry as "2026-08-04T18:00:00UTC" in some versions and
// as a normal ISO string in others. Date cannot parse the first, which would read
// as "no session" and quietly disable the countdown.
function parseAwsTimestamp(value) {
  if (!value) return null;

  const normalised = String(value).trim().replace(/UTC$/, 'Z');
  const parsed = new Date(normalised);

  return isNaN(parsed.getTime()) ? null : parsed;
}

// Identity Center keeps its token in ~/.aws/sso/cache, not ~/.aws/credentials, so
// the expiry the status bar shows has to come from there.
//
// The filename is a hash of the session name or start URL, which differs by CLI
// version. Rather than reproduce that, every cache entry is read and matched on
// the startUrl the profile resolved to — the registration files sitting in the
// same directory have no startUrl and fall out on their own.
async function getSsoExpiry(startUrl) {
  if (!startUrl) return null;

  try {
    const cacheDir = path.join(os.homedir(), '.aws', 'sso', 'cache');
    if (!(await fs.pathExists(cacheDir))) return null;

    const files = (await fs.readdir(cacheDir)).filter(name => name.endsWith('.json'));
    let newest = null;

    for (const file of files) {
      let entry;
      try {
        entry = JSON.parse(await fs.readFile(path.join(cacheDir, file), 'utf8'));
      } catch (error) {
        continue;   // a half-written or unrelated file is not a reason to give up
      }

      if (!entry || entry.startUrl !== startUrl) continue;

      const expiresAt = parseAwsTimestamp(entry.expiresAt);
      // several tokens can exist for one portal; the newest is the live one
      if (expiresAt && (!newest || expiresAt > newest)) newest = expiresAt;
    }

    return newest;
  } catch (error) {
    return null;
  }
}

// When the session for a profile runs out, whichever store its provider uses.
async function getExpiryForProfile(profileName) {
  if (!profileName) return null;

  // Credentials Portus holds itself know exactly when they lapse, which beats
  // anything inferred from a file. This is the Azure and MFA case.
  const cached = cachedSessionCredentials(profileName);
  if (cached && cached.expiration) return cached.expiration;

  const profile = (await describeProfiles()).find(p => p.name === profileName);
  if (!profile) return null;

  if (profile.provider === 'sso') return getSsoExpiry(profile.ssoStartUrl);
  return getSessionExpiry([profileName]);
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
  // Safety valve against an unbounded pagination loop. DescribeInstanceInformation
  // caps MaxResults at 50, where DescribeInstances allows 1000, so this loop needs
  // 20x the pages to cover the same fleet. The instance list (DescribeInstances)
  // walks up to 40 pages of 1000 = 40,000 instances; sized to the same ceiling so
  // the SSM status join does not run out first and leave managed instances past
  // #2,000 mislabelled 'Not managed' with their connect buttons disabled.
  const MAX_PAGES = 800; // 800 x 50 = 40,000, matching the instance-list ceiling

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

// ============================================================================
// REGIONS
// ============================================================================
//
// Which regions an account may use is an account-level setting: everything after
// the original set has to be opted into, and most accounts never opt into most of
// them. DescribeRegions without AllRegions returns exactly the enabled ones, so
// the picker offers what will actually work rather than a list of mostly-errors.

// A region reaches the CLI on a command line, so it is checked the same way a
// remote host is. Every real region — us-east-1, ap-southeast-4, us-gov-west-1,
// cn-north-1 — fits inside this.
const VALID_REGION = /^[a-z0-9-]{1,32}$/;

// Region codes say where, not what. These are the names AWS uses for them, so a
// picker can read "Frankfurt · eu-central-1" instead of asking people to
// remember which number Frankfurt is. Unknown codes fall back to the code alone,
// so a region added after this was written still works, just without the name.
const REGION_NAMES = {
  'us-east-1': 'N. Virginia', 'us-east-2': 'Ohio',
  'us-west-1': 'N. California', 'us-west-2': 'Oregon',
  'af-south-1': 'Cape Town',
  'ap-east-1': 'Hong Kong',
  'ap-south-1': 'Mumbai', 'ap-south-2': 'Hyderabad',
  'ap-northeast-1': 'Tokyo', 'ap-northeast-2': 'Seoul', 'ap-northeast-3': 'Osaka',
  'ap-southeast-1': 'Singapore', 'ap-southeast-2': 'Sydney',
  'ap-southeast-3': 'Jakarta', 'ap-southeast-4': 'Melbourne',
  'ca-central-1': 'Central Canada', 'ca-west-1': 'Calgary',
  'eu-central-1': 'Frankfurt', 'eu-central-2': 'Zurich',
  'eu-west-1': 'Ireland', 'eu-west-2': 'London', 'eu-west-3': 'Paris',
  'eu-north-1': 'Stockholm', 'eu-south-1': 'Milan', 'eu-south-2': 'Spain',
  'il-central-1': 'Tel Aviv',
  'me-south-1': 'Bahrain', 'me-central-1': 'UAE',
  'sa-east-1': 'São Paulo',
  'us-gov-east-1': 'GovCloud East', 'us-gov-west-1': 'GovCloud West',
  'cn-north-1': 'Beijing', 'cn-northwest-1': 'Ningxia'
};

// The region a request should use: what the user picked, or the profile's own.
// An unrecognised value is discarded rather than passed on, so nothing shaped
// like a command-line argument can arrive and be appended to one. This holds for
// the profile's own region too: `region` is read verbatim from ~/.aws/config, so
// a hand-edited or tool-written `region = us-east-1$(id)` would otherwise reach
// `--region ${region}` on the command line without ever passing the renderer's
// picker. Anything that fails the guard falls back to the same default the config
// reader already uses.
async function regionFor(profileName, requested) {
  if (requested && VALID_REGION.test(requested)) return requested;

  const profile = await getProfileConfig(profileName);
  return VALID_REGION.test(profile.region) ? profile.region : 'us-east-1';
}

// ============================================================================
// MANAGED ENDPOINT DISCOVERY
// ============================================================================

// Maps an AWS engine identifier onto one of the services offered in the port
// forwarding dialog. Anything unrecognised (MariaDB, DocumentDB, Neptune,
// Memcached) returns null and is left out rather than filed under the wrong
// service, where its default port would be wrong too.
function engineToService(engine) {
  const name = (engine || '').toLowerCase();

  if (name.startsWith('oracle')) return 'oracle';
  if (name.startsWith('sqlserver')) return 'sqlserver';
  if (name === 'aurora-postgresql' || name === 'postgres') return 'postgresql';
  if (name === 'aurora-mysql' || name === 'mysql') return 'mysql';
  if (name === 'redis' || name === 'valkey') return 'redis';

  return null;
}

// Fallback only. The real port comes from the endpoint the API returned, which
// is what makes a database on a non-standard port work without being edited.
function defaultPortFor(service) {
  switch (service) {
    case 'oracle': return 1521;
    case 'sqlserver': return 1433;
    case 'postgresql': return 5432;
    case 'mysql': return 3306;
    case 'redis': return 6379;
    default: return null;
  }
}

function setupIpcHandlers() {
  // Single source of truth for the version shown in the UI: package.json, via
  // Electron. Hardcoding it in the markup means it silently goes stale.
  ipcMain.handle('get-app-version', () => app.getVersion());

  // Is there a newer release? Resolves to { available: false } on any failure.
  ipcMain.handle('check-for-update', () => checkForNewRelease());

  // Opening a link hands a string to the operating system, so this refuses
  // anything that is not an https URL on the project's own release pages. A
  // renderer bug should not be able to launch arbitrary things.
  ipcMain.handle('open-release-page', (event, url) => {
    if (typeof url !== 'string' || !url.startsWith(RELEASES_URL)) {
      return { success: false, error: 'Refused to open a link outside the project releases page.' };
    }

    shell.openExternal(url);
    return { success: true };
  });

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
    const { remoteHost, remotePort, localPort, region: requestedRegion, kubernetes } = options || {};
    const clusterName = kubernetes && kubernetes.clusterName ? String(kubernetes.clusterName) : null;

    const profileCheck = validateProfileName(profileName);
    if (!profileCheck.valid) return { success: false, error: profileCheck.error };
    const idCheck = validateInstanceId(instanceId);
    if (!idCheck.valid) return { success: false, error: idCheck.error };

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

    const hostCheck = validateRemoteHost(targetHost);
    if (!hostCheck.valid) {
      return { success: false, error: hostCheck.error };
    }

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
        : (clusterName ? await findKubePort() : await findFreePort());
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

    // With credentials in the environment the CLI must not also be pointed at the
    // profile, or it resolves that profile itself and asks for the code again.
    let credentialEnv;
    try {
      credentialEnv = await cliCredentialEnv(profileName);
    } catch (error) {
      return { success: false, error: `Could not get credentials for ${profileName}: ${error.message}` };
    }

    const profileFlag = credentialEnv ? '' : ` --profile ${profileName}`;
    const region = await regionFor(profileName, requestedRegion);
    const ssmCommand = `aws ssm start-session --target ${instanceId} --document-name ${documentName} --parameters "${parameters}"${profileFlag} --region ${region}`;

    const result = await startSsmTunnel({
      ssmCommand,
      credentialEnv,
      kind: 'port',
      instanceId,
      instanceName,
      profileName,
      localPort: resolvedLocalPort,
      remoteHost: targetHost,
      remotePort: targetPort
    });

    if (!result.success) return result;

    // The kubeconfig is written after the listener is up, so the port in it is
    // the one that was actually bound. A failure here loses kubectl, not the
    // tunnel — the forward still works, and the reason is reported.
    let kube = null;
    if (clusterName) {
      try {
        kube = await writeKubeconfig({
          clusterName,
          region,
          localPort: resolvedLocalPort,
          profileName,
          useEnvCredentials: !!credentialEnv
        });

        const tunnel = activeTunnels.get(result.tunnelId);
        if (tunnel) {
          tunnel.kubernetes = { clusterName, kubeconfig: kube.path, context: kube.context };
          broadcastTunnels();
        }
      } catch (error) {
        return {
          success: true,
          port: resolvedLocalPort,
          remoteHost: targetHost || null,
          remotePort: targetPort,
          kubeconfigError: `Tunnel is up, but the kubeconfig could not be written: ${error.message}`,
          message: `Forwarding localhost:${resolvedLocalPort} to ${targetHost}:${targetPort}`
        };
      }
    }

    return {
      success: true,
      port: resolvedLocalPort,
      remoteHost: targetHost || null,
      remotePort: targetPort,
      ...(kube ? { kubeconfig: kube.path, clusterName } : {}),
      message: `Forwarding localhost:${resolvedLocalPort} to ${targetHost || 'this instance'}:${targetPort}`
    };
  });

  // Active tunnels
  ipcMain.handle('list-tunnels', () => listTunnels());
  ipcMain.handle('close-tunnel', (event, tunnelId) => ({ success: closeTunnel(tunnelId) }));

  // Every profile in ~/.aws, each tagged with the credential provider it uses.
  // One list, not two: the old split into "SSO" and "operational" profiles only
  // ever meant "Azure" and "not Azure", which says nothing to anyone whose
  // credentials come from somewhere else.
  ipcMain.handle('get-profiles', async () => {
    try {
      return { success: true, data: await readAwsProfiles() };
    } catch (error) {
      return { success: false, error: `Failed to read ~/.aws: ${error.message}`, data: [] };
    }
  });

  // The answer to an mfa-required message. Returns whether anything was still
  // waiting for it, so a dialog left open after the request timed out says so
  // rather than appearing to succeed.
  ipcMain.handle('submit-mfa-code', (event, { id, code } = {}) => {
    const trimmed = (code || '').trim();
    return { success: settleMfaRequest(id, trimmed || null) };
  });

  // The answer to a role-choice-required message, when an Azure assertion offers
  // more than one role and the profile names no default.
  ipcMain.handle('submit-role-choice', (event, { id, roleArn } = {}) => {
    return { success: settleRoleChoice(id, roleArn || null) };
  });

  // Forgets the Microsoft session for a profile's tenant, so the next sign-in
  // starts from a clean login rather than a remembered one.
  ipcMain.handle('forget-azure-session', async (event, profileName) => {
    try {
      const profile = await findProfile(profileName);
      if (!profile || !profile.azureTenantId) {
        return { success: false, error: 'That profile has no Azure tenant to forget.' };
      }

      await azureSaml.forgetSession(profile.azureTenantId);

      // The AWS credentials that sign-in produced go too, along with any assumed
      // from it — leaving those behind means "forget" forgets nothing usable.
      const all = await describeProfiles();
      const byName = new Map(all.map(entry => [entry.name, entry]));

      sessionCredentialCache.delete(profileName);
      all.forEach(entry => {
        if (sourceProfileChain(entry.name, byName).includes(profileName)) {
          sessionCredentialCache.delete(entry.name);
        }
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // What the sign-in dialog offers: Identity Center grouped by portal session,
  // everything else per profile.
  ipcMain.handle('get-login-targets', async () => {
    try {
      return { success: true, data: await readLoginTargets() };
    } catch (error) {
      return { success: false, error: `Failed to read ~/.aws: ${error.message}`, data: [] };
    }
  });

  // Start a login for a profile, using whichever runner its provider declares.
  // Providers with no runner are not an error to select — they simply have
  // nothing to sign into — so this is only reached from a button that is shown
  // for loginable profiles.
  ipcMain.handle('sign-in', async (event, profileName) => {
    try {
      return await runLoginFor(profileName);
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
    // Asked of the selected profile's own provider: Identity Center keeps its
    // expiry in ~/.aws/sso/cache, everything else in ~/.aws/credentials.
    let expiresAt = operationalProfile ? await getExpiryForProfile(operationalProfile) : null;

    if (!expiresAt && lastSsoProfile && lastSsoProfile !== operationalProfile) {
      // The long-standing Azure shape is a plain profile whose credentials were
      // written by signing in to a *different* one, so its countdown lives under
      // that other name. Providers that carry their own session are never asked
      // about someone else's: showing the Azure clock next to a set of access
      // keys, or next to another org's Identity Center profile, is just wrong.
      const selected = operationalProfile
        ? (await describeProfiles()).find(p => p.name === operationalProfile)
        : null;

      const selfContained = selected && ['sso', 'azure', 'static'].includes(selected.provider);
      if (!selfContained) expiresAt = await getExpiryForProfile(lastSsoProfile);
    }

    return {
      success: true,
      ssoProfile: lastSsoProfile,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      expiresInMs: expiresAt ? expiresAt.getTime() - Date.now() : null
    };
  });

  // Re-run the login for the last used profile (silent refresh)
  ipcMain.handle('refresh-session', async (event, profileName) => {
    const target = profileName || lastSsoProfile;
    if (!target) {
      return { success: false, error: 'No profile has been signed into yet' };
    }

    // This runs on a timer, so an interactive login is refused rather than
    // started: opening a browser unannounced is not a silent renewal, and the
    // user has to be at the keyboard to finish it anyway.
    const profile = (await describeProfiles()).find(p => p.name === target);
    if (profile && profile.interactiveLogin) {
      return {
        success: false,
        interactive: true,
        error: `${profile.providerLabel} sessions cannot be renewed in the background — sign in again when you are ready.`
      };
    }

    try {
      // silent: an Azure renewal reuses the Microsoft session in a window that is
      // never shown. If Microsoft would ask something, it fails here rather than
      // putting a login in front of someone mid-task.
      await runLoginFor(target, { silent: true });
      return { success: true, ssoProfile: target };
    } catch (error) {
      return { success: false, error: error.error || error.message || 'Re-authentication failed' };
    }
  });

  // EC2 instances - the SSM/RDP target list
  // On expired credentials, silently re-run SSO login once and retry.
  ipcMain.handle('get-ec2-instances', async (event, profileName, region) => {
    try {
      return await describeInstances(profileName, region);
    } catch (error) {
      // An MFA failure looks like a credentials failure to isCredentialsError, but
      // re-running a sign-in cannot supply a code — it is reported as itself.
      if (isMfaError(error)) {
        return { success: false, mfaRequired: true, error: error.message };
      }
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
        await runLoginFor(lastSsoProfile);
      } catch (loginError) {
        return {
          success: false,
          sessionExpired: true,
          error: `Session expired and automatic re-authentication failed: ${loginError.error || loginError.message}`
        };
      }

      try {
        const result = await describeInstances(profileName, region);
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
  async function describeInstances(profileName, requestedRegion) {
    const region = await regionFor(profileName, requestedRegion);

    const client = new EC2Client({
      credentials: awsCredentials(profileName),
      region
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
      ssmManaged = await getSsmManagedInstances(profileName, region);
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
          availabilityZone: instance.Placement ? instance.Placement.AvailabilityZone : null,
          vpcId: instance.VpcId || null,
          // Surfaced in the detail panel; Name is shown separately as the row title
          tags: (instance.Tags || [])
            .filter(tag => tag.Key !== 'Name')
            .map(tag => ({ key: tag.Key, value: tag.Value })),
          ssmStatus: ssmLookupFailed ? 'unknown' : toSsmStatus(ssmInfo),
          ssmLastPing: ssmInfo ? ssmInfo.lastPingDateTime : null,
          ssmAgentVersion: ssmInfo ? ssmInfo.agentVersion : null,
          ssmPlatformName: ssmInfo ? ssmInfo.platformName : null
        });
      });
    });

    return { success: true, data: instances, ssmLookupFailed };
  }

  // The regions this account has enabled.
  //
  // Never fails in a way that empties the picker: without ec2:DescribeRegions the
  // profile's own region is returned on its own, so the app behaves exactly as it
  // did before regions could be switched.
  ipcMain.handle('get-regions', async (event, profileName) => {
    const profile = await getProfileConfig(profileName);
    const configured = profile.region;

    const fallback = (reason) => ({
      success: true,
      data: [{ name: configured, label: REGION_NAMES[configured] || null }],
      configured,
      limited: true,
      reason
    });

    try {
      const client = new EC2Client({ credentials: awsCredentials(profileName), region: configured });

      // No AllRegions: this returns the enabled ones, which is the whole point
      const response = await client.send(new DescribeRegionsCommand({}));

      const regions = (response.Regions || [])
        .map(region => region.RegionName)
        .filter(name => name && VALID_REGION.test(name))
        .sort()
        .map(name => ({ name, label: REGION_NAMES[name] || null }));

      if (!regions.length) return fallback('No regions were returned');

      // The configured region belongs in the list even if DescribeRegions did not
      // mention it — it is what the profile is set to, and hiding it would leave
      // the picker disagreeing with the status bar.
      if (!regions.some(region => region.name === configured)) {
        regions.push({ name: configured, label: REGION_NAMES[configured] || null });
        regions.sort((a, b) => a.name.localeCompare(b.name));
      }

      return { success: true, data: regions, configured, limited: false };
    } catch (error) {
      if (isMfaError(error)) return fallback('An MFA code is needed first');
      return fallback(describeDeniedAction(error));
    }
  });

  // Managed database endpoints in the profile's region — the target list for
  // "a host reachable from it" in port forwarding.
  // Same re-auth path as the EC2 listing: expired credentials trigger one silent
  // SSO login and a single retry.
  ipcMain.handle('get-endpoints', async (event, profileName, region) => {
    try {
      return await describeEndpoints(profileName, region);
    } catch (error) {
      if (isMfaError(error)) {
        return { success: false, mfaRequired: true, error: error.message };
      }
      if (!isCredentialsError(error)) {
        return { success: false, error: `Failed to list endpoints: ${error.message}` };
      }

      if (!lastSsoProfile) {
        return {
          success: false,
          sessionExpired: true,
          error: 'Your AWS session has expired. Please sign in again with SSO Connect.'
        };
      }

      try {
        await runLoginFor(lastSsoProfile);
      } catch (loginError) {
        return {
          success: false,
          sessionExpired: true,
          error: `Session expired and automatic re-authentication failed: ${loginError.error || loginError.message}`
        };
      }

      try {
        const result = await describeEndpoints(profileName, region);
        return { ...result, reauthenticated: true };
      } catch (retryError) {
        return {
          success: false,
          sessionExpired: true,
          error: `Failed to list endpoints after re-authentication: ${retryError.message}`
        };
      }
    }
  });

  // Raw endpoint discovery — throws so the caller can handle credential failures.
  //
  // Each of the four API calls is isolated: a missing rds:* or elasticache:*
  // permission must degrade to "fewer suggestions", never to a broken dialog,
  // because typing the host by hand still works.
  async function describeEndpoints(profileName, requestedRegion) {
    const region = await regionFor(profileName, requestedRegion);
    const config = { credentials: awsCredentials(profileName), region };

    const rds = new RDSClient(config);
    const elasticache = new ElastiCacheClient(config);
    const eks = new EKSClient(config);

    const endpoints = [];
    const warnings = [];

    // A read-only Describe that fails on permissions costs the user suggestions,
    // not the feature. Only a genuine credential failure belongs to the caller's
    // re-auth path — checked second, because an AccessDenied message also matches
    // isCredentialsError and would otherwise trigger a sign-in that cannot help.
    const collect = async (label, fn) => {
      try {
        await fn();
      } catch (error) {
        if (!isAuthorizationError(error) && isCredentialsError(error)) throw error;
        warnings.push(`${label}: ${describeDeniedAction(error)}`);
      }
    };

    // RDS and ElastiCache both paginate with an opaque Marker
    const MAX_PAGES = 20;
    const paginate = async (send) => {
      const pages = [];
      let marker;
      let page = 0;
      do {
        const response = await send(marker);
        pages.push(response);
        marker = response.Marker;
        page += 1;
      } while (marker && page < MAX_PAGES);
      return pages;
    };

    // --- RDS instances -------------------------------------------------------
    // Aurora member instances are skipped: they carry a DBClusterIdentifier and
    // their per-instance endpoints move on failover. The cluster writer endpoint
    // below is the one that stays correct.
    await collect('RDS instances', async () => {
      const pages = await paginate(marker => rds.send(new DescribeDBInstancesCommand({
        MaxRecords: 100,
        Marker: marker
      })));

      pages.forEach(page => {
        (page.DBInstances || []).forEach(db => {
          if (db.DBClusterIdentifier) return;
          if (!db.Endpoint || !db.Endpoint.Address) return; // still being created

          const service = engineToService(db.Engine);
          if (!service) return;

          endpoints.push({
            id: `rds-instance:${db.DBInstanceIdentifier}`,
            name: db.DBInstanceIdentifier,
            host: db.Endpoint.Address,
            port: db.Endpoint.Port || defaultPortFor(service),
            service,
            kind: 'RDS instance',
            engine: db.Engine,
            engineVersion: db.EngineVersion || null,
            status: db.DBInstanceStatus || null,
            tls: false
          });
        });
      });
    });

    // --- Aurora clusters -----------------------------------------------------
    // Writer endpoint only, one row per cluster.
    await collect('Aurora clusters', async () => {
      const pages = await paginate(marker => rds.send(new DescribeDBClustersCommand({
        MaxRecords: 100,
        Marker: marker
      })));

      pages.forEach(page => {
        (page.DBClusters || []).forEach(cluster => {
          if (!cluster.Endpoint) return;

          const service = engineToService(cluster.Engine);
          if (!service) return;

          endpoints.push({
            id: `rds-cluster:${cluster.DBClusterIdentifier}`,
            name: cluster.DBClusterIdentifier,
            host: cluster.Endpoint,
            port: cluster.Port || defaultPortFor(service),
            service,
            kind: 'Aurora writer',
            engine: cluster.Engine,
            engineVersion: cluster.EngineVersion || null,
            status: cluster.Status || null,
            tls: false
          });
        });
      });
    });

    // --- ElastiCache replication groups --------------------------------------
    // Cluster mode enabled exposes a ConfigurationEndpoint; cluster mode disabled
    // exposes a primary endpoint per node group. Either way the writer is wanted.
    const groupedCacheClusters = new Set();
    await collect('ElastiCache replication groups', async () => {
      const pages = await paginate(marker => elasticache.send(new DescribeReplicationGroupsCommand({
        MaxRecords: 100,
        Marker: marker
      })));

      pages.forEach(page => {
        (page.ReplicationGroups || []).forEach(group => {
          (group.MemberClusters || []).forEach(id => groupedCacheClusters.add(id));

          const engine = (group.Engine || 'redis').toLowerCase();
          const service = engineToService(engine);
          if (!service) return;

          const primary = group.ConfigurationEndpoint
            || ((group.NodeGroups || []).find(n => n.PrimaryEndpoint) || {}).PrimaryEndpoint;
          if (!primary || !primary.Address) return;

          endpoints.push({
            id: `elasticache-group:${group.ReplicationGroupId}`,
            name: group.ReplicationGroupId,
            host: primary.Address,
            port: primary.Port || defaultPortFor(service),
            service,
            kind: group.ConfigurationEndpoint ? 'ElastiCache (cluster mode)' : 'ElastiCache primary',
            engine,
            engineVersion: null,
            status: group.Status || null,
            tls: !!group.TransitEncryptionEnabled
          });
        });
      });
    });

    // --- Standalone ElastiCache nodes ----------------------------------------
    // Members of a replication group are already covered above.
    await collect('ElastiCache clusters', async () => {
      const pages = await paginate(marker => elasticache.send(new DescribeCacheClustersCommand({
        MaxRecords: 100,
        Marker: marker,
        ShowCacheNodeInfo: true
      })));

      pages.forEach(page => {
        (page.CacheClusters || []).forEach(cluster => {
          if (cluster.ReplicationGroupId) return;
          if (groupedCacheClusters.has(cluster.CacheClusterId)) return;

          const service = engineToService(cluster.Engine);
          if (!service) return;

          const node = (cluster.CacheNodes || []).find(n => n.Endpoint && n.Endpoint.Address);
          const endpoint = node ? node.Endpoint : cluster.ConfigurationEndpoint;
          if (!endpoint || !endpoint.Address) return;

          endpoints.push({
            id: `elasticache-cluster:${cluster.CacheClusterId}`,
            name: cluster.CacheClusterId,
            host: endpoint.Address,
            port: endpoint.Port || defaultPortFor(service),
            service,
            kind: 'ElastiCache node',
            engine: (cluster.Engine || '').toLowerCase(),
            engineVersion: cluster.EngineVersion || null,
            status: cluster.CacheClusterStatus || null,
            tls: !!cluster.TransitEncryptionEnabled
          });
        });
      });
    });

    // --- EKS clusters --------------------------------------------------------
    // A private cluster's API server is only an HTTPS endpoint on a private
    // address, so it is reachable the same way a database is: through an
    // instance that sits in the VPC. What makes it more than a port forward is
    // the kubeconfig, written once the tunnel is up — see writeKubeconfig.
    await collect('EKS clusters', async () => {
      const listed = [];
      let nextToken;
      let page = 0;

      do {
        const response = await eks.send(new ListClustersCommand({ maxResults: 100, nextToken }));
        listed.push(...(response.clusters || []));
        nextToken = response.nextToken;
        page += 1;
      } while (nextToken && page < MAX_PAGES);

      // DescribeCluster per cluster is the only way to get the endpoint, and the
      // list is normally short. One that fails is skipped rather than losing the
      // rest — a cluster being deleted mid-listing should not empty the dialog.
      for (const name of listed) {
        try {
          const { cluster } = await eks.send(new DescribeClusterCommand({ name }));
          if (!cluster || !cluster.endpoint) continue;

          const host = hostnameOf(cluster.endpoint);

          endpoints.push({
            id: `eks:${name}`,
            name,
            host,
            port: 443,
            service: 'kubernetes',
            kind: 'EKS cluster',
            engine: 'kubernetes',
            engineVersion: cluster.version || null,
            status: cluster.status || null,
            tls: true,
            // Marks it as more than a host: the renderer offers the kubectl flow
            // for these, and the tunnel writes a kubeconfig. The CA and the ARN
            // stay here — they are re-read when the file is written, so nothing
            // large crosses to the renderer.
            kubernetes: { clusterName: name }
          });
        } catch (error) {
          if (isCredentialsError(error) && !isAuthorizationError(error)) throw error;
          warnings.push(`EKS ${name}: ${describeDeniedAction(error)}`);
        }
      }
    });

    endpoints.sort((a, b) => a.name.localeCompare(b.name));

    return { success: true, data: endpoints, region, warnings };
  }

  // SSM Session - open a shell in a new terminal window
  //
  // Unlike the tunnels, this hands the command to a terminal the user can see.
  // It still needs the credentials Portus is holding: a profile signed in through
  // Azure has nothing on disk for the CLI to find, and a chain rooted at one
  // resolves to whatever stale keys an older tool left behind — which surfaces as
  // "ExpiredToken … AssumeRole" in a terminal that just opened.
  ipcMain.handle('connect-ssm', async (event, profileName, instanceId, requestedRegion) => {
    const profileCheck = validateProfileName(profileName);
    if (!profileCheck.valid) return { success: false, error: profileCheck.error };
    const idCheck = validateInstanceId(instanceId);
    if (!idCheck.valid) return { success: false, error: idCheck.error };
    let credentialEnv;
    try {
      credentialEnv = await cliCredentialEnv(profileName);
    } catch (error) {
      return { success: false, error: `Could not get credentials for ${profileName}: ${error.message}` };
    }

    let region;
    try {
      region = await regionFor(profileName, requestedRegion);
    } catch (error) {
      return { success: false, error: `Failed to get profile config: ${error.message}` };
    }

    const profileFlag = credentialEnv ? '' : ` --profile ${profileName}`;
    const awsCommand = `aws ssm start-session --target ${instanceId}${profileFlag} --region ${region}`;

    // macOS is the awkward one: Terminal.app is already running, so it does not
    // inherit anything from a process spawned here, and putting the keys in the
    // `do script` string would type them into the window and into shell history.
    // A private script file keeps them out of both.
    let scriptPath = null;
    if (credentialEnv && process.platform === 'darwin') {
      try {
        scriptPath = await writeCredentialScript(awsCommand, credentialEnv);
      } catch (error) {
        return { success: false, error: `Could not prepare the session: ${error.message}` };
      }
    }

    return openTerminal({
      command: awsCommand,
      env: credentialEnv,
      scriptPath,
      message: 'SSM session started in new terminal window'
    });
  });

  // A terminal pointed at the cluster behind a tunnel.
  //
  // KUBECONFIG points at the generated file rather than ~/.kube/config, which is
  // never touched. The credentials go in the environment for the same reason the
  // SSM shell needs them: `aws eks get-token` runs out here, and for a profile
  // signed in through Portus there is nothing on disk for it to find.
  ipcMain.handle('open-kubectl-terminal', async (event, tunnelId) => {
    const tunnel = activeTunnels.get(tunnelId);
    if (!tunnel || !tunnel.kubernetes) {
      return { success: false, error: 'That tunnel has no cluster attached.' };
    }

    let credentialEnv;
    try {
      credentialEnv = await cliCredentialEnv(tunnel.profileName);
    } catch (error) {
      return { success: false, error: `Could not get credentials for ${tunnel.profileName}: ${error.message}` };
    }

    const env = { ...(credentialEnv || {}), KUBECONFIG: tunnel.kubernetes.kubeconfig };

    // Terminal.app inherits nothing from this spawn, so on macOS the environment
    // travels in a private script that then becomes an interactive shell.
    let scriptPath = null;
    if (process.platform === 'darwin') {
      try {
        scriptPath = await writeCredentialScript('${SHELL:-/bin/bash} -l', env);
      } catch (error) {
        return { success: false, error: `Could not prepare the session: ${error.message}` };
      }
    }

    return openTerminal({
      command: null,
      interactive: true,
      env,
      scriptPath,
      message: `kubectl is pointed at ${tunnel.kubernetes.clusterName}`
    });
  });

  // RDP over SSM - port-forward tunnel + launch RDP client
  // RDP over SSM - port-forward tunnel + launch RDP client.
  // The tunnel is registered so it can be listed in the UI and terminated on exit.
  // RDP over SSM: a 3389 port forward plus the platform's RDP client.
  ipcMain.handle('connect-rdp-ssm', async (event, profileName, instanceId, instanceName, requestedRegion) => {
    const profileCheck = validateProfileName(profileName);
    if (!profileCheck.valid) return { success: false, error: profileCheck.error };
    const idCheck = validateInstanceId(instanceId);
    if (!idCheck.valid) return { success: false, error: idCheck.error };
    // Only an existing *RDP* tunnel can be reused. Without the kind check a port
    // forward on the same instance would be mistaken for an open RDP session.
    const existing = Array.from(activeTunnels.values()).find(tunnel =>
      tunnel.kind === 'rdp' &&
      tunnel.instanceId === instanceId &&
      tunnel.profileName === profileName
    );

    if (existing) {
      return {
        success: true,
        reused: true,
        port: existing.port,
        message: `Already connected to ${instanceName} on port ${existing.port}`
      };
    }

    let localPort;
    try {
      localPort = await findFreePort();
    } catch (error) {
      return { success: false, error: `Could not find an available local port: ${error.message}` };
    }

    let credentialEnv;
    try {
      credentialEnv = await cliCredentialEnv(profileName);
    } catch (error) {
      return { success: false, error: `Could not get credentials for ${profileName}: ${error.message}` };
    }

    const profileFlag = credentialEnv ? '' : ` --profile ${profileName}`;
    const region = await regionFor(profileName, requestedRegion);
    const ssmCommand = `aws ssm start-session --target ${instanceId} --document-name AWS-StartPortForwardingSession --parameters "portNumber=3389,localPortNumber=${localPort}"${profileFlag} --region ${region}`;

    const result = await startSsmTunnel({
      ssmCommand,
      credentialEnv,
      kind: 'rdp',
      instanceId,
      instanceName,
      profileName,
      localPort,
      remoteHost: '',
      remotePort: 3389
    });

    if (!result.success) return result;

    // The listener needs a moment before a client can dial into it
    await new Promise(resolve => setTimeout(resolve, 2000));

    const launched = await launchRdpClient(result.tunnelId, localPort);
    if (!launched.success) {
      closeTunnel(result.tunnelId);
      return launched;
    }

    return {
      success: true,
      port: localPort,
      message: `RDP tunnel established for ${instanceName} on port ${localPort}.`
    };
  });
}

app.whenReady().then(() => {
  applyApplicationMenu();
  createWindow();
  setupIpcHandlers();
});

// Tunnels are child processes that outlive the app unless they are terminated
// explicitly, so every exit path closes them. The kubeconfigs go at the same
// time: each one points at a local port that dies with its tunnel, so leaving
// them behind leaves files that describe a cluster nothing can reach. The
// credential scripts join them, so quitting inside their removal window does
// not leave exported keys behind in the temp directory.
const shutDown = () => { closeAllTunnels(); clearKubeconfigs(); clearScriptDirs(); };

app.on('before-quit', shutDown);
app.on('will-quit', shutDown);
process.on('exit', shutDown);

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