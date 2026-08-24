// Assume-role chains rooted at an Azure sign-in.
//
// This is the case the old tool got for free by writing keys into
// ~/.aws/credentials: a profile with role_arn + source_profile = <azure profile>
// worked because the SDK could read the source profile's credentials off disk.
// Portus writes nothing there, so the SDK cannot chain, and the hops are walked
// in-process instead. If this regresses, every derived profile in an Azure setup
// stops resolving — which is most of them.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Azure assume-role chains');

const CONFIG = `
[profile azure-corp]
azure_tenant_id = 11111111-2222-3333-4444-555555555555
azure_app_id_uri = https://signin.aws.amazon.com/saml
azure_default_role_arn = arn:aws:iam::111111111111:role/Corp
region = eu-central-1

[profile prod]
role_arn = arn:aws:iam::222222222222:role/Prod
source_profile = azure-corp
region = eu-west-1

[profile deep]
role_arn = arn:aws:iam::333333333333:role/Deep
source_profile = prod
region = us-east-1

[profile mfa-hop]
role_arn = arn:aws:iam::444444444444:role/Mfa
source_profile = azure-corp
mfa_serial = arn:aws:iam::444444444444:mfa/alice
region = eu-central-1

[profile from-keys]
role_arn = arn:aws:iam::555555555555:role/Plain
source_profile = keys
region = eu-central-1
`;

const CREDENTIALS = `
[keys]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = secret
`;

const fromIniCalls = [];

const { handlers, state, ready } = loadMain({
  files: { config: CONFIG, credentials: CREDENTIALS },
  // `where` probes which shell the Windows terminals should use; answering it
  // avoids a five second timeout per launch
  onSpawn: ({ command, args }) => (command === 'where'
    ? { exit: args[0] === 'pwsh' ? 0 : 1 }
    : { stdout: 'Port forwarding started', keepOpen: true }),
  modules: {
    './azure-saml': {
      requestAssertion: async () => ({
        samlResponse: 'PHNhbWw+',
        roles: [{
          roleArn: 'arn:aws:iam::111111111111:role/Corp',
          principalArn: 'arn:aws:iam::111111111111:saml-provider/Azure'
        }]
      }),
      forgetSession: async () => {}
    },
    '@aws-sdk/credential-providers': {
      fromIni: (options) => async () => {
        fromIniCalls.push(options);
        return {
          accessKeyId: 'AKIAFROMINI',
          secretAccessKey: 'ini-secret',
          sessionToken: 'ini-token',
          expiration: new Date(Date.now() + 3600000)
        };
      }
    }
  }
});

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

  const signIn = handlers.get('sign-in');
  const forward = handlers.get('start-port-forward');
  const forget = handlers.get('forget-azure-session');
  const submitCode = handlers.get('submit-mfa-code');
  const listTunnels = handlers.get('list-tunnels');
  const closeTunnel = handlers.get('close-tunnel');

  const closeAll = () => (listTunnels() || []).forEach(tunnel => closeTunnel({}, tunnel.id));
  const tunnelFor = (profileName) => forward({}, profileName, 'i-0abc', 'bastion',
    { remoteHost: 'db.example.internal', remotePort: '5432', localPort: '' });

  const lastEnv = () => (state.spawns[state.spawns.length - 1].options || {}).env || {};
  const lastCommand = () => String(
    state.spawns[state.spawns.length - 1].args.slice(-1)[0]).replace(/^exec /, '');
  const assumeRoles = () => state.sts
    .filter(call => call.command === 'AssumeRoleCommand')
    .map(call => call.input.RoleArn);

  // ---------------------------------------------------------------------------
  suite.section('the sign-in itself');

  const result = await signIn({}, 'azure-corp');
  suite.check('the SAML assertion is exchanged for credentials',
    state.sts.some(call => call.command === 'AssumeRoleWithSAMLCommand'), state.sts.map(c => c.command));
  suite.check('for the role the profile names',
    result.roleArn === 'arn:aws:iam::111111111111:role/Corp', result);

  // ---------------------------------------------------------------------------
  suite.section('a two-hop chain is walked from the signed-in profile down');
  // deep -> prod -> azure-corp. Nothing between them is cached yet, so both hops
  // must happen, in that order, each using what the one before produced.
  state.sts.length = 0;
  state.spawns.length = 0;
  fromIniCalls.length = 0;

  const deep = await tunnelFor('deep');

  suite.check('the tunnel starts', deep.success === true, deep.error);
  suite.check('both roles are assumed, nearest the sign-in first',
    assumeRoles().join(' -> ')
      === 'arn:aws:iam::222222222222:role/Prod -> arn:aws:iam::333333333333:role/Deep',
    assumeRoles());
  suite.check('the first hop uses the credentials the Azure sign-in produced',
    state.sts[0].credentials.sessionToken === 'token-for-Corp', state.sts[0].credentials);
  suite.check('the second hop uses what the first returned',
    state.sts[1].credentials.sessionToken === 'token-for-Prod', state.sts[1].credentials);
  suite.check('the SDK was never asked to resolve it, because it cannot',
    !fromIniCalls.some(call => call.profile === 'deep' || call.profile === 'prod'),
    fromIniCalls.map(call => call.profile));

  suite.check('the CLI is handed the end of the chain',
    lastEnv().AWS_SESSION_TOKEN === 'token-for-Deep', lastEnv().AWS_SESSION_TOKEN);
  suite.check('and --profile is dropped, since the CLI could not resolve it either',
    !lastCommand().includes('--profile'), lastCommand().slice(0, 120));
  suite.check('the region is still the profile\'s own',
    /--region us-east-1/.test(lastCommand()), lastCommand().slice(0, 120));

  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('every hop is cached, not only the one that was asked for');
  state.sts.length = 0;

  const prod = await tunnelFor('prod');

  suite.check('an intermediate reached on the way to another profile is reused',
    prod.success === true && assumeRoles().length === 0, assumeRoles());
  suite.check('and the credentials are still the right ones',
    lastEnv().AWS_SESSION_TOKEN === 'token-for-Prod', lastEnv().AWS_SESSION_TOKEN);

  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('an MFA hop still asks for a code');
  // mfa_serial on the hop, not on the Azure profile: the code belongs to the
  // AssumeRole call, and Portus is the only thing that can ask for it.
  state.sts.length = 0;
  state.sent.length = 0;

  const forwarding = tunnelFor('mfa-hop');
  await answerNextPrompt(submitCode, '654321');
  const withMfa = await forwarding;

  suite.check('the tunnel starts', withMfa.success === true, withMfa.error);
  suite.check('the renderer was asked, naming the profile',
    (state.sent.find(m => m.channel === 'mfa-required') || {}).payload.profileName === 'mfa-hop',
    state.sent.map(m => m.channel));
  suite.check('the device and the code reach AssumeRole',
    state.sts[0].input.SerialNumber === 'arn:aws:iam::444444444444:mfa/alice'
      && state.sts[0].input.TokenCode === '654321', state.sts[0] && state.sts[0].input);
  suite.check('the device ARN does not cross to the renderer',
    !JSON.stringify(state.sent.find(m => m.channel === 'mfa-required').payload).includes('arn:'));

  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('the SSM shell gets the credentials too');
  // The regression: this path passed --profile and no environment, so the CLI
  // resolved the chain itself, reached the Azure profile, and found whatever an
  // older tool had left in ~/.aws/credentials. Reported as
  // "ExpiredToken … AssumeRole" in a terminal that had only just opened.
  const connectSsm = handlers.get('connect-ssm');
  const realPlatform = process.platform;
  const asPlatform = (value) => Object.defineProperty(process, 'platform', { value });

  state.spawns.length = 0;

  const shell = await connectSsm({}, 'prod', 'i-0abc', 'eu-west-1');
  const shellSpawn = state.spawns[state.spawns.length - 1];
  const shellCommand = shellSpawn.args.join(' ');

  suite.check('the shell opens', shell.success === true, shell.error);
  suite.check('the credentials are handed over in the environment',
    (shellSpawn.options.env || {}).AWS_SESSION_TOKEN === 'token-for-Prod',
    (shellSpawn.options.env || {}).AWS_SESSION_TOKEN);
  suite.check('--profile is dropped, so the CLI does not re-chain and fail',
    !shellCommand.includes('--profile'), shellCommand);
  suite.check('the rest of the environment survives',
    (shellSpawn.options.env || {}).PATH !== undefined);
  suite.check('the region is still passed',
    shellCommand.includes('--region eu-west-1'), shellCommand);
  suite.check('the target is still passed',
    shellCommand.includes('--target i-0abc'), shellCommand);

  // A profile the CLI can resolve on its own must be left exactly as it was
  state.spawns.length = 0;
  await connectSsm({}, 'from-keys', 'i-0abc', 'eu-central-1');
  const plainShell = state.spawns[state.spawns.length - 1];

  suite.check('a profile the CLI can resolve keeps --profile',
    plainShell.args.join(' ').includes('--profile from-keys'), plainShell.args.join(' '));
  suite.check('and gets no credentials in its environment',
    (plainShell.options.env || {}).AWS_ACCESS_KEY_ID === undefined);

  // ---------------------------------------------------------------------------
  suite.section('macOS cannot use the environment, so it uses a private file');
  // Terminal.app is already running and inherits nothing from this spawn. Putting
  // the keys in the AppleScript would type them into the visible window.
  state.spawns.length = 0;
  state.written.length = 0;
  state.tempDirs.length = 0;

  asPlatform('darwin');
  const mac = await connectSsm({}, 'prod', 'i-0abc', 'eu-west-1');
  asPlatform(realPlatform);

  const macSpawn = state.spawns[state.spawns.length - 1];
  const script = state.written[0];

  suite.check('the shell opens', mac.success === true, mac.error);
  suite.check('a script is written', !!script, state.written);
  suite.check('it is private to this user',
    script.options.mode === 0o700, script.options);
  suite.check('the temp directory is private too',
    state.tempDirs.length === 1, state.tempDirs);
  suite.check('it exports the credentials and becomes the CLI',
    script.contents.includes("export AWS_SESSION_TOKEN='token-for-Prod'")
      && /\nexec aws ssm start-session /.test(script.contents), script.contents);
  suite.check('every exported value is single-quoted',
    script.contents.split('\n').filter(line => line.startsWith('export '))
      .every(line => /^export [A-Z_]+='.*'$/.test(line)),
    script.contents.split('\n').filter(line => line.startsWith('export ')));
  suite.check('no credential reaches the AppleScript, which would be typed on screen',
    !macSpawn.args.join(' ').includes('token-for-Prod'), macSpawn.args.join(' '));
  suite.check('the AppleScript runs the script rather than the command',
    macSpawn.args.join(' ').includes(script.path), macSpawn.args.join(' '));

  // the file is removed on a delay, so the shell has read it first
  await new Promise(resolve => setTimeout(resolve, 5100));
  suite.check('and the script is taken off disk afterwards',
    state.removed.length === 1, state.removed);

  // ---------------------------------------------------------------------------
  suite.section('a chain Portus has no part in is left alone');
  // from-keys roots at static keys, which the CLI resolves perfectly well on its
  // own. Walking it here would be Portus doing work it has no reason to do.
  state.sts.length = 0;
  fromIniCalls.length = 0;

  const plain = await tunnelFor('from-keys');

  suite.check('the tunnel starts', plain.success === true, plain.error);
  suite.check('no role is assumed in-process', assumeRoles().length === 0, assumeRoles());
  suite.check('nothing is resolved in-process at all',
    fromIniCalls.length === 0, fromIniCalls.map(c => c.profile));
  suite.check('--profile is still passed, so the CLI resolves it as it always did',
    lastCommand().includes('--profile from-keys'), lastCommand().slice(0, 120));
  suite.check('and nothing is injected into its environment',
    lastEnv().AWS_ACCESS_KEY_ID === undefined, lastEnv().AWS_ACCESS_KEY_ID);

  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('forgetting the Microsoft session forgets what it produced');
  // Leaving the derived credentials behind would mean "forget" forgets the login
  // and nothing that was done with it.
  const forgotten = await forget({}, 'azure-corp');
  suite.check('it succeeds', forgotten.success === true, forgotten);

  state.sts.length = 0;
  fromIniCalls.length = 0;

  const after = await tunnelFor('prod');
  suite.check('the derived profile is no longer served from the cache',
    !lastEnv().AWS_SESSION_TOKEN && lastCommand().includes('--profile prod'),
    { token: lastEnv().AWS_SESSION_TOKEN, command: lastCommand().slice(0, 120) });
  suite.check('nothing is re-assumed off the forgotten credentials',
    assumeRoles().length === 0, assumeRoles());
  suite.check('and it falls back to the CLI rather than failing',
    after.success === true, after.error);

  closeAll();

  suite.check('forgetting a profile with no tenant is refused',
    (await forget({}, 'prod')).success === false);

  suite.done();
})();
