// Credential providers: which one a profile uses, what signing in runs, where
// the session expiry is read from, and which external tools are demanded.
//
// This is the area that decides whether Portus is usable at all for a given
// person's AWS setup, so the cases below are drawn from real config shapes
// rather than from the code's own structure.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const files = {};
let spawnReply = { exit: 0 };

// The SAML mechanics live in azure-saml.test.js. Here the module is stubbed so
// these checks are about routing: which provider runs, with what, and silently or
// not.
let lastAssertionRequest = null;

const ASSERTION_ROLES = [
  {
    roleArn: 'arn:aws:iam::123456789012:role/Corp',
    principalArn: 'arn:aws:iam::123456789012:saml-provider/Azure'
  },
  {
    roleArn: 'arn:aws:iam::123456789012:role/Other',
    principalArn: 'arn:aws:iam::123456789012:saml-provider/Azure'
  }
];

const { handlers, state, ready } = loadMain({
  files,
  onSpawn: () => spawnReply,
  modules: {
    './azure-saml': {
      requestAssertion: async (profile, options) => {
        lastAssertionRequest = { profile: profile.name, options };
        return { samlResponse: 'PHNhbWw+', roles: ASSERTION_ROLES };
      },
      forgetSession: async () => {}
    }
  }
});

const suite = createSuite('Credential providers');

// A config with one of everything AWS supports
const FULL_CONFIG = `
[default]
region = us-east-1

[profile idc-prod]
sso_session = mycompany
sso_account_id = 123456789012
sso_role_name = Developer
region = eu-central-1

[profile idc-legacy]
sso_start_url = https://legacy.awsapps.com/start
sso_region = eu-west-1
region = eu-west-1

[sso-session mycompany]
sso_start_url = https://mycompany.awsapps.com/start
sso_region = eu-central-1

[profile azure-corp]
azure_tenant_id = 11111111-2222-3333-4444-555555555555
azure_app_id_uri = https://signin.aws.amazon.com/saml
azure_default_role_arn = arn:aws:iam::123456789012:role/Corp
region = eu-central-1

[profile azure-partial]
azure_default_username = someone@example.com
region = us-west-2

[profile vault]
credential_process = /usr/local/bin/aws-vault export --format=json prod
region = ap-southeast-2

[profile assumed]
role_arn = arn:aws:iam::123456789012:role/Admin
source_profile = keys
region = us-east-2

[profile mfa-assumed]
role_arn = arn:aws:iam::123456789012:role/Admin
source_profile = keys
mfa_serial = arn:aws:iam::123456789012:mfa/alice
region = us-east-2

[profile bare]
region = ca-central-1
`;

const FULL_CREDENTIALS = `
[keys]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY

[azure-corp]
aws_access_key_id = ASIAIOSFODNN7EXAMPLE
aws_secret_access_key = shhh
aws_session_token = tok
aws_expiration = 2099-01-01T00:00:00Z
`;

// Several profiles per portal, plus a second portal
const GROUPED_CONFIG = `${FULL_CONFIG}
[profile idc-dev]
sso_session = mycompany
sso_account_id = 210987654321
region = eu-central-1

[profile idc-sandbox]
sso_session = mycompany
sso_account_id = 111111111111
region = eu-central-1

[sso-session partner]
sso_start_url = https://partner.awsapps.com/start
sso_region = us-east-1

[profile partner-prod]
sso_session = partner
region = us-east-1
`;

const setConfig = (config, credentials) => {
  Object.keys(files).forEach(key => delete files[key]);
  if (config !== null) files.config = config;
  if (credentials !== null && credentials !== undefined) files.credentials = credentials;
};

(async () => {
  await ready();

  const getProfiles = handlers.get('get-profiles');
  const getLoginTargets = handlers.get('get-login-targets');
  const signIn = handlers.get('sign-in');
  const refreshSession = handlers.get('refresh-session');
  const sessionStatus = handlers.get('get-session-status');
  const preflight = handlers.get('check-required-tools');

  // ---------------------------------------------------------------------------
  suite.section('every credential type is recognised');
  setConfig(FULL_CONFIG, FULL_CREDENTIALS);

  const listed = await getProfiles({});
  const byName = Object.fromEntries((listed.data || []).map(profile => [profile.name, profile]));

  suite.check('the list is returned', listed.success === true, listed.error);

  Object.entries({
    'default': 'unknown',
    'idc-prod': 'sso',
    'idc-legacy': 'sso',
    'azure-corp': 'azure',
    'azure-partial': 'azure',
    'vault': 'process',
    'assumed': 'assume-role',
    'mfa-assumed': 'assume-role',
    'bare': 'unknown',
    'keys': 'static'
  }).forEach(([name, provider]) => {
    suite.check(`${name} is ${provider}`,
      byName[name] && byName[name].provider === provider,
      byName[name] ? byName[name].provider : 'missing');
  });

  suite.check('an [sso-session] block is not mistaken for a profile',
    !byName.mycompany, Object.keys(byName));
  suite.check('all ten profiles found', (listed.data || []).length === 10, (listed.data || []).length);
  suite.check('the region is read from the config', byName['idc-prod'].region === 'eu-central-1');
  suite.check('a profile with no region falls back', byName.keys.region === 'us-east-1');
  suite.check('config wins over credentials for the same profile',
    byName['azure-corp'].region === 'eu-central-1', byName['azure-corp'].region);

  // ---------------------------------------------------------------------------
  suite.section('nothing secret reaches the renderer');

  const leaked = (listed.data || []).filter(profile => JSON.stringify(profile).match(
    /wJalrXUt|AKIAIOSFODNN7EXAMPLE|ASIAIOSFODNN7EXAMPLE|shhh|aws_secret|aws_session_token|credential_process|role_arn|azure_tenant_id/));

  suite.check('no secret or raw ini key crosses IPC', leaked.length === 0, leaked);
  suite.check('the SSO portal URL stays in the main process',
    !JSON.stringify(listed.data).includes('awsapps.com'));
  suite.check('only the whitelisted fields are returned',
    (listed.data || []).every(profile => Object.keys(profile).sort().join(',')
      === 'canLogin,interactiveLogin,name,provider,providerLabel,region,requiresMfa,source'),
    Object.keys(listed.data[0] || {}));
  suite.check('the MFA device ARN itself never crosses',
    !JSON.stringify(listed.data).includes('mfa/alice'));
  suite.check('but the fact that a code is needed does',
    byName['mfa-assumed'].requiresMfa === true && byName.assumed.requiresMfa === false,
    { mfa: byName['mfa-assumed'].requiresMfa, plain: byName.assumed.requiresMfa });

  // ---------------------------------------------------------------------------
  suite.section('the sign-in list groups by what one login covers');
  setConfig(GROUPED_CONFIG, FULL_CREDENTIALS);

  const grouped = await getLoginTargets({});
  const targets = Object.fromEntries((grouped.data || []).map(target => [target.id, target]));

  suite.check('profiles sharing a portal collapse to one row',
    targets['sso-session:mycompany'] && targets['sso-session:mycompany'].profileCount === 3,
    targets['sso-session:mycompany']);
  suite.check('the row is labelled with the session, not a profile',
    targets['sso-session:mycompany'].label === 'mycompany');
  suite.check('a second portal is its own row',
    targets['sso-session:partner'] && targets['sso-session:partner'].profileCount === 1);
  suite.check('a legacy inline sso_start_url stays on its own',
    !!targets['profile:idc-legacy'], Object.keys(targets));
  suite.check('Azure stays one row per profile',
    !!targets['profile:azure-corp'] && !!targets['profile:azure-partial']);
  suite.check('providers with no login are absent',
    !Object.keys(targets).some(id => /keys|vault|assumed|bare|default/.test(id)), Object.keys(targets));
  suite.check('five rows for seven loginable profiles', (grouped.data || []).length === 5, (grouped.data || []).length);
  suite.check('no portal URL in the sign-in list',
    !JSON.stringify(grouped.data).includes('awsapps.com'));

  // ---------------------------------------------------------------------------
  suite.section('a chained profile counts towards the login that feeds it');
  setConfig(`
[profile azure-corp]
azure_tenant_id = 1111
region = eu-central-1

[profile azure-other]
azure_tenant_id = 2222
region = us-east-1

[sso-session mycompany]
sso_start_url = https://mycompany.awsapps.com/start
sso_region = eu-central-1

[profile idc-prod]
sso_session = mycompany
region = eu-central-1

[profile prod]
role_arn = arn:aws:iam::111111111111:role/Admin
source_profile = azure-corp
region = eu-central-1

[profile staging]
role_arn = arn:aws:iam::222222222222:role/Admin
source_profile = azure-corp
region = eu-central-1

[profile dev]
role_arn = arn:aws:iam::333333333333:role/Admin
source_profile = prod
region = eu-central-1

[profile idc-child]
role_arn = arn:aws:iam::444444444444:role/Admin
source_profile = idc-prod
region = eu-central-1

[profile orphan]
role_arn = arn:aws:iam::555555555555:role/Admin
source_profile = does-not-exist
region = eu-central-1

[profile loop-a]
role_arn = arn:aws:iam::666666666666:role/Admin
source_profile = loop-b
region = eu-central-1

[profile loop-b]
role_arn = arn:aws:iam::777777777777:role/Admin
source_profile = loop-a
region = eu-central-1
`, `
[standalone-keys]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = x
`);

  const chained = await getLoginTargets({});
  const chainedById = Object.fromEntries((chained.data || []).map(target => [target.id, target]));

  suite.check('one Azure login covers itself and the three that assume from it',
    chainedById['profile:azure-corp'].profileCount === 4,
    chainedById['profile:azure-corp'].profileCount);
  suite.check('a chain two levels deep still counts at the login',
    chainedById['profile:azure-corp'].profileCount === 4);
  suite.check('a separate tenant is unaffected',
    chainedById['profile:azure-other'].profileCount === 1);
  suite.check('an Identity Center session counts its chained profile',
    chainedById['sso-session:mycompany'].profileCount === 2);
  suite.check('a source_profile pointing at nothing counts nowhere',
    Object.values(chainedById).reduce((sum, target) => sum + target.profileCount, 0) === 7,
    Object.values(chainedById).map(target => `${target.id}=${target.profileCount}`));
  suite.check('a source_profile cycle neither hangs nor inflates the count',
    !Object.values(chainedById).some(target => target.profileCount > 4));
  suite.check('standalone keys belong to no login',
    chainedById['profile:standalone-keys'] === undefined, Object.keys(chainedById));

  // ---------------------------------------------------------------------------
  suite.section('signing in runs the right command');
  setConfig(GROUPED_CONFIG, FULL_CREDENTIALS);
  spawnReply = { stdout: 'Then enter the code:\n\nQWER-TYUI\n', exit: 0 };

  state.spawns.length = 0;
  state.sent.length = 0;
  const ssoResult = await signIn({}, 'idc-prod');
  const ssoSpawn = state.spawns.find(spawn => (spawn.args || []).includes('sso'));

  suite.check('a session profile signs in against the session',
    ssoSpawn && ssoSpawn.command === 'aws'
      && ssoSpawn.args.join(' ') === 'sso login --sso-session mycompany', ssoSpawn);
  suite.check('the result reports which provider ran', ssoResult.provider === 'sso');
  suite.check('the pairing code is forwarded to the renderer',
    state.sent.some(message => message.channel === 'sso-verification' && message.payload.code === 'QWER-TYUI'),
    state.sent);

  state.spawns.length = 0;
  await signIn({}, 'idc-dev');
  suite.check('any sibling profile runs the same session login',
    state.spawns.find(spawn => (spawn.args || []).includes('sso')).args.join(' ')
      === 'sso login --sso-session mycompany');

  state.spawns.length = 0;
  await signIn({}, 'idc-legacy');
  suite.check('a legacy profile falls back to --profile',
    state.spawns.find(spawn => (spawn.args || []).includes('sso')).args.join(' ')
      === 'sso login --profile idc-legacy');

  state.spawns.length = 0;
  state.sent.length = 0;
  const azureResult = await signIn({}, 'azure-corp');
  suite.check('Azure signs in without spawning anything',
    state.spawns.length === 0, state.spawns);
  suite.check('and assumes the role the profile names',
    azureResult.roleArn === 'arn:aws:iam::123456789012:role/Corp', azureResult);
  suite.check('no pairing code for Azure',
    !state.sent.some(message => message.channel === 'sso-verification'));
  suite.check('the sign-in was interactive, not silent',
    lastAssertionRequest && lastAssertionRequest.options.silent === false, lastAssertionRequest);

  const refuses = async (profileName, pattern) => {
    try {
      await signIn({}, profileName);
      return false;
    } catch (error) {
      return pattern.test(error.message);
    }
  };

  suite.check('an access-key profile is refused by name',
    await refuses('keys', /Access keys profiles have no sign-in/));
  suite.check('an unknown profile is named in the error',
    await refuses('nope', /was not found in ~\/\.aws/));

  spawnReply = { exit: 1 };
  suite.check('a failed sso login surfaces as an error',
    await refuses('idc-prod', /Sign-in failed/));
  spawnReply = { exit: 0 };

  // ---------------------------------------------------------------------------
  suite.section('background renewal never opens a browser');
  state.spawns.length = 0;

  const idcRenew = await refreshSession({}, 'idc-prod');
  suite.check('an Identity Center renewal is refused rather than started',
    idcRenew.success === false && idcRenew.interactive === true, idcRenew);
  suite.check('nothing was spawned for it',
    !state.spawns.some(spawn => (spawn.args || []).includes('sso')), state.spawns);
  suite.check('the reason names the provider',
    /Identity Center sessions cannot be renewed in the background/.test(idcRenew.error), idcRenew.error);

  state.spawns.length = 0;
  const azureRenew = await refreshSession({}, 'azure-corp');
  suite.check('an Azure renewal still succeeds without showing anything',
    azureRenew.success === true && state.spawns.length === 0,
    { azureRenew, spawns: state.spawns });
  suite.check('and it asked for a silent attempt',
    lastAssertionRequest && lastAssertionRequest.options.silent === true, lastAssertionRequest);

  // ---------------------------------------------------------------------------
  suite.section('the countdown reads the store that provider uses');
  const inTwoHours = new Date(Date.now() + 2 * 3600 * 1000);
  const inOneHour = new Date(Date.now() + 3600 * 1000);

  // a registration file, another org's token, an older token, and the live one
  // written in the non-standard form some CLI versions produce
  files['sso/cache/botocore-client-id-eu-central-1.json'] = JSON.stringify({ clientId: 'x' });
  files['sso/cache/aaa.json'] = JSON.stringify({
    startUrl: 'https://someone-else.awsapps.com/start', expiresAt: '2099-01-01T00:00:00Z' });
  files['sso/cache/bbb.json'] = JSON.stringify({
    startUrl: 'https://mycompany.awsapps.com/start', expiresAt: inOneHour.toISOString() });
  files['sso/cache/ccc.json'] = JSON.stringify({
    startUrl: 'https://mycompany.awsapps.com/start',
    expiresAt: inTwoHours.toISOString().replace(/\.\d+Z$/, 'UTC') });
  files['sso/cache/broken.json'] = '{ not json';

  let status = await sessionStatus({}, 'idc-prod');
  const hoursLeft = status.expiresInMs / 3600000;

  suite.check('Identity Center expiry comes from ~/.aws/sso/cache', status.expiresInMs !== null, status);
  suite.check('the newest matching token wins', hoursLeft > 1.9 && hoursLeft < 2.1, hoursLeft);
  suite.check('a "…UTC" timestamp is parsed, not discarded', hoursLeft > 1.9, hoursLeft);
  suite.check('another organisation\'s token is ignored', hoursLeft < 2.5, hoursLeft);
  suite.check('a malformed cache entry does not break the read', status.success === true);

  status = await sessionStatus({}, 'idc-legacy');
  suite.check('a portal with no cached token reports no expiry', status.expiresInMs === null, status);

  // azure-corp was signed into above, so Portus now holds its credentials and
  // knows exactly when they lapse — better than anything read out of a file.
  status = await sessionStatus({}, 'azure-corp');
  const azureHoursLeft = status.expiresInMs / 3600000;
  suite.check('Azure expiry comes from the credentials Portus holds',
    azureHoursLeft > 0.9 && azureHoursLeft < 1.1, { azureHoursLeft, status });

  status = await sessionStatus({}, 'keys');
  suite.check('access keys report no expiry', status.expiresInMs === null, status);

  Object.keys(files).filter(key => key.startsWith('sso/')).forEach(key => delete files[key]);
  status = await sessionStatus({}, 'idc-prod');
  suite.check('a missing sso cache directory is not an error',
    status.success === true && status.expiresInMs === null, status);

  // ---------------------------------------------------------------------------
  suite.section('an Azure profile asks for nothing extra to be installed');
  setConfig(FULL_CONFIG, FULL_CREDENTIALS);

  let tools = await preflight({});
  suite.check('the preflight is the same with an Azure profile as without',
    tools.tools.length === 2, tools.tools.map(t => t.id));
  suite.check('only the AWS CLI and the Session Manager plugin are checked',
    tools.tools.map(t => t.id).sort().join(',') === 'aws-cli,session-manager-plugin',
    tools.tools.map(t => t.id));

  setConfig(`
[profile idc-prod]
sso_session = mycompany
region = eu-central-1
`, '');
  tools = await preflight({});
  suite.check('and the same two for anyone else',
    tools.tools.map(t => t.id).sort().join(',') === 'aws-cli,session-manager-plugin',
    tools.tools.map(t => t.id));

  // ---------------------------------------------------------------------------
  suite.section('a damaged ~/.aws degrades rather than fails');
  setConfig(null, null);

  const empty = await getProfiles({});
  suite.check('no files means an empty list, not an error',
    empty.success === true && empty.data.length === 0, empty);

  setConfig('not = valid ini [[[\n\x00garbage', '[ok]\naws_access_key_id = AKIA\n');
  const partial = await getProfiles({});
  suite.check('a malformed config does not lose the credentials file',
    partial.success === true && partial.data.some(profile => profile.name === 'ok'),
    partial.data.map(profile => profile.name));

  suite.done();
})();
