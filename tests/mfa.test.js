// A profile carrying mfa_serial cannot produce credentials until someone types a
// six-digit code, and a desktop app has to be the thing that asks.
//
// The bug this covers: the AWS CLI asked instead, on a stdin piped to nothing, so
// a port forward sat for thirty seconds and then blamed Systems Manager.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Multi-factor authentication');

const CONFIG = `
[profile mfa-prod]
role_arn = arn:aws:iam::123456789012:role/Admin
source_profile = keys
mfa_serial = arn:aws:iam::123456789012:mfa/alice
region = eu-central-1

[profile plain]
role_arn = arn:aws:iam::123456789012:role/Admin
source_profile = keys
region = eu-central-1

; a second MFA profile, kept unresolved so the cancel case starts from a cold cache
[profile mfa-other]
role_arn = arn:aws:iam::123456789012:role/Reader
source_profile = keys
mfa_serial = arn:aws:iam::123456789012:mfa/alice
region = eu-central-1
`;

const CREDENTIALS = `
[keys]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = secret
`;

const fromIniCalls = [];
const codesSeen = [];
let credentialLifetimeMs = 3600000;
let mfaProviderShouldRun = true;

const { handlers, state, ready } = loadMain({
  files: { config: CONFIG, credentials: CREDENTIALS },
  onSpawn: () => ({ stdout: 'Port forwarding started', keepOpen: true }),
  modules: {
    '@aws-sdk/credential-providers': {
      fromIni: (options) => async () => {
        fromIniCalls.push(options);

        // the real provider calls this only when the profile has mfa_serial
        if (options.mfaCodeProvider && mfaProviderShouldRun) {
          codesSeen.push(await options.mfaCodeProvider('arn:aws:iam::123456789012:mfa/alice'));
        }

        return {
          accessKeyId: 'ASIAFAKEFAKEFAKEFAKE',
          secretAccessKey: 'fake-secret',
          sessionToken: 'fake-token',
          expiration: new Date(Date.now() + credentialLifetimeMs)
        };
      }
    }
  }
});

// The prompt is a round trip: main asks the renderer, the renderer answers. Tests
// drive both halves, so they start the call, wait for the question, then reply.
const answerNextPrompt = async (submit, code) => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const asked = state.sent.filter(message => message.channel === 'mfa-required').pop();
    if (asked) return submit({}, { id: asked.payload.id, code });
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('no mfa-required message was ever sent');
};

(async () => {
  await ready();

  const forward = handlers.get('start-port-forward');
  const submitCode = handlers.get('submit-mfa-code');
  const listTunnels = handlers.get('list-tunnels');
  const closeTunnel = handlers.get('close-tunnel');
  const getProfiles = handlers.get('get-profiles');

  const closeAll = () => (listTunnels() || []).forEach(tunnel => closeTunnel({}, tunnel.id));
  const lastCommand = () => (state.spawns.length
    ? String(state.spawns[0].args[state.spawns[0].args.length - 1]).replace(/^exec /, '')
    : '');

  // ---------------------------------------------------------------------------
  suite.section('the profile is recognised as needing a code');

  const profiles = await getProfiles({});
  const byName = Object.fromEntries((profiles.data || []).map(profile => [profile.name, profile]));

  suite.check('mfa_serial marks the profile', byName['mfa-prod'].requiresMfa === true);
  suite.check('a plain assume-role profile does not', byName.plain.requiresMfa === false);
  suite.check('the device ARN stays in the main process',
    !JSON.stringify(profiles.data).includes('mfa/alice'));

  // ---------------------------------------------------------------------------
  suite.section('the user is asked, and the tunnel starts');
  state.spawns.length = 0;
  state.sent.length = 0;
  codesSeen.length = 0;

  const forwarding = forward({}, 'mfa-prod', 'i-0abc', 'bastion',
    { remoteHost: 'db.rds.amazonaws.com', remotePort: '5432', localPort: '' });

  await answerNextPrompt(submitCode, '123456');
  const started = await forwarding;

  suite.check('the renderer was asked for a code',
    state.sent.some(message => message.channel === 'mfa-required'), state.sent.map(m => m.channel));
  const request = state.sent.find(message => message.channel === 'mfa-required').payload;
  suite.check('the request names the profile', request.profileName === 'mfa-prod');
  suite.check('but carries no device ARN',
    !JSON.stringify(request).includes('arn:'), request);
  suite.check('the code reached the SDK', codesSeen.includes('123456'), codesSeen);
  suite.check('the tunnel started', started.success === true, started.error);

  // ---------------------------------------------------------------------------
  suite.section('the CLI is given credentials rather than left to ask');

  const command = lastCommand();
  const env = (state.spawns[0].options || {}).env || {};

  suite.check('the credentials are handed over in the environment',
    env.AWS_ACCESS_KEY_ID === 'ASIAFAKEFAKEFAKEFAKE'
      && env.AWS_SECRET_ACCESS_KEY === 'fake-secret'
      && env.AWS_SESSION_TOKEN === 'fake-token',
    { id: env.AWS_ACCESS_KEY_ID, token: env.AWS_SESSION_TOKEN ? 'set' : 'missing' });
  // Windows names it Path, not PATH — see azure-chain.test.js
  suite.check('the rest of the environment is preserved',
    Object.keys(env).some(name => name.toLowerCase() === 'path'), Object.keys(env).length);
  suite.check('--profile is dropped, so the CLI does not re-resolve and re-prompt',
    !command.includes('--profile'), command.slice(0, 140));
  suite.check('the region is still passed', /--region eu-central-1/.test(command), command.slice(0, 140));
  suite.check('the command is otherwise unchanged',
    /^aws ssm start-session --target i-0abc --document-name AWS-StartPortForwardingSessionToRemoteHost /.test(command),
    command.slice(0, 140));

  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('the code is asked for once, not per call');
  state.sent.length = 0;
  codesSeen.length = 0;

  const second = await forward({}, 'mfa-prod', 'i-0abc', 'bastion',
    { remoteHost: 'db.rds.amazonaws.com', remotePort: '5433', localPort: '' });

  suite.check('the second tunnel starts without asking again',
    second.success === true && !state.sent.some(message => message.channel === 'mfa-required'),
    { success: second.success, asked: state.sent.map(m => m.channel) });
  suite.check('and no new code was consumed', codesSeen.length === 0, codesSeen);

  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('a profile without mfa_serial is untouched');
  state.spawns.length = 0;
  state.sent.length = 0;
  fromIniCalls.length = 0;

  const plain = await forward({}, 'plain', 'i-0abc', 'bastion',
    { remoteHost: 'db.rds.amazonaws.com', remotePort: '5432', localPort: '' });

  suite.check('it starts with no prompt',
    plain.success === true && !state.sent.some(message => message.channel === 'mfa-required'));
  suite.check('--profile is still passed, exactly as before',
    lastCommand().includes('--profile plain'), lastCommand().slice(0, 140));
  suite.check('no MFA callback is handed to the SDK',
    fromIniCalls.every(call => call.mfaCodeProvider === undefined), fromIniCalls.length);
  suite.check('no credentials are injected into its environment',
    ((state.spawns[0].options || {}).env || {}).AWS_ACCESS_KEY_ID === undefined,
    ((state.spawns[0].options || {}).env || {}).AWS_ACCESS_KEY_ID);
  suite.check('the ini cache is still bypassed, so a fresh login takes effect',
    fromIniCalls.every(call => call.ignoreCache === true));

  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('cancelling is an answer, not a hang');
  // Nothing may be left awaiting a dialog the user dismissed. A profile that has
  // not been resolved yet is used, so the answer is not served from the cache.
  state.sent.length = 0;

  const cancelled = forward({}, 'mfa-other', 'i-0abc', 'bastion',
    { remoteHost: 'db.rds.amazonaws.com', remotePort: '5432', localPort: '' });

  await answerNextPrompt(submitCode, '');
  const refused = await cancelled;

  suite.check('the forward fails rather than waiting',
    refused.success === false, refused);
  suite.check('and says what went wrong',
    /cancelled/i.test(refused.error || ''), refused.error);

  // ---------------------------------------------------------------------------
  suite.section('an answer nobody is waiting for is reported as such');

  const orphan = await submitCode({}, { id: 'mfa-does-not-exist', code: '123456' });
  suite.check('submitting an unknown request id returns false', orphan.success === false, orphan);

  suite.done();
})();
