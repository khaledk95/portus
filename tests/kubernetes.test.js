// Reaching a private EKS cluster through a tunnel.
//
// The tunnel itself is an ordinary port forward — the part worth testing is the
// kubeconfig written afterwards. kubectl is pointed at localhost while the
// cluster's certificate names its real endpoint, and the whole design rests on
// tls-server-name reconciling the two without turning verification off. If that
// line goes missing, the only symptom is a TLS error nobody can place.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('EKS over SSM');

const CONFIG = `
[profile azure-corp]
azure_tenant_id = 11111111-2222-3333-4444-555555555555
azure_app_id_uri = https://signin.aws.amazon.com/saml
azure_default_role_arn = arn:aws:iam::111111111111:role/Corp
region = eu-west-1

[profile keys-only]
region = eu-west-1
`;

const CREDENTIALS = `
[keys-only]
aws_access_key_id = AKIAIOSFODNN7EXAMPLE
aws_secret_access_key = secret
`;

const CA = 'LS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tCk1JSUMrRkFLRQotLS0tLUVORA==';

// Two clusters, one of which cannot be described — a cluster being deleted
// mid-listing must not empty the dialog for the others.
let describeFailsFor = null;

const eksStub = {
  EKSClient: class {
    async send(command) {
      const input = command.input || {};

      if (command.constructor.name === 'ListClustersCommand') {
        return { clusters: ['platform-prod', 'platform-sandbox'] };
      }

      if (input.name === describeFailsFor) {
        throw Object.assign(new Error('User is not authorized to perform: eks:DescribeCluster'),
          { name: 'AccessDeniedException' });
      }

      return {
        cluster: {
          name: input.name,
          arn: `arn:aws:eks:eu-west-1:111111111111:cluster/${input.name}`,
          endpoint: `https://ABCD1234${input.name === 'platform-prod' ? 'P' : 'S'}.gr7.eu-west-1.eks.amazonaws.com`,
          version: '1.31',
          status: 'ACTIVE',
          certificateAuthority: { data: CA }
        }
      };
    }
  },
  ListClustersCommand: class { constructor(input) { this.input = input; } },
  DescribeClusterCommand: class { constructor(input) { this.input = input; } }
};

const { handlers, state, ready } = loadMain({
  files: { config: CONFIG, credentials: CREDENTIALS },
  // `where` is the shell probe behind the Windows terminals. Answering it here
  // keeps the tests on the PowerShell path rather than timing out into the cmd
  // fallback, and keeps them quick.
  onSpawn: ({ command, args }) => (command === 'where'
    ? { exit: args[0] === 'pwsh' ? 0 : 1 }
    : { stdout: 'Port forwarding started', keepOpen: true }),
  modules: {
    '@aws-sdk/client-eks': eksStub,
    './azure-saml': {
      requestAssertion: async () => ({
        samlResponse: 'PHNhbWw+',
        roles: [{
          roleArn: 'arn:aws:iam::111111111111:role/Corp',
          principalArn: 'arn:aws:iam::111111111111:saml-provider/Azure'
        }]
      }),
      forgetSession: async () => {}
    }
  }
});

(async () => {
  await ready();

  const endpoints = handlers.get('get-endpoints');
  const forward = handlers.get('start-port-forward');
  const kubectl = handlers.get('open-kubectl-terminal');
  const listTunnels = handlers.get('list-tunnels');
  const closeTunnel = handlers.get('close-tunnel');
  const signIn = handlers.get('sign-in');

  const closeAll = () => (listTunnels() || []).forEach(t => closeTunnel({}, t.id));
  const lastWritten = () => state.written[state.written.length - 1];

  // -------------------------------------------------------------------------
  suite.section('clusters are discovered alongside the databases');

  let result = await endpoints({}, 'keys-only', 'eu-west-1');
  let clusters = (result.data || []).filter(e => e.service === 'kubernetes');

  suite.check('both clusters are listed', clusters.length === 2, clusters.map(c => c.name));
  suite.check('the API server is the target, on 443',
    clusters[0].port === 443 && clusters[0].host.endsWith('.eks.amazonaws.com'),
    { port: clusters[0].port, host: clusters[0].host });
  suite.check('the host is a hostname, not a URL',
    !clusters[0].host.includes('https://'), clusters[0].host);
  suite.check('it is marked as a cluster, which is what offers the kubectl flow',
    clusters[0].kubernetes && clusters[0].kubernetes.clusterName === 'platform-prod',
    clusters[0].kubernetes);
  suite.check('the version is surfaced', clusters[0].engineVersion === '1.31');
  suite.check('no certificate data crosses to the renderer',
    !JSON.stringify(clusters).includes(CA.slice(0, 24)));

  // -------------------------------------------------------------------------
  suite.section('one unreadable cluster does not lose the rest');
  describeFailsFor = 'platform-sandbox';

  result = await endpoints({}, 'keys-only', 'eu-west-1');
  clusters = (result.data || []).filter(e => e.service === 'kubernetes');

  suite.check('the readable one still comes through',
    clusters.length === 1 && clusters[0].name === 'platform-prod', clusters.map(c => c.name));
  suite.check('and the failure is reported as a warning, not an error',
    result.success === true && result.warnings.some(w => w.includes('platform-sandbox')),
    result.warnings);
  describeFailsFor = null;

  // -------------------------------------------------------------------------
  suite.section('forwarding to a cluster writes a kubeconfig');
  state.written.length = 0;

  const started = await forward({}, 'keys-only', 'i-0abc', 'bastion', {
    remoteHost: 'ABCD1234P.gr7.eu-west-1.eks.amazonaws.com',
    remotePort: '443',
    localPort: '',
    region: 'eu-west-1',
    kubernetes: { clusterName: 'platform-prod' }
  });

  suite.check('the tunnel starts', started.success === true, started.error);
  suite.check('a kubeconfig path comes back', !!started.kubeconfig, started);
  suite.check('the preferred local port is used, so the file rarely changes',
    started.port === 6443, started.port);

  const file = lastWritten();
  suite.check('the file is written', !!file, state.written.length);
  suite.check('it is private to this user', file.options.mode === 0o600, file.options);
  suite.check('it lives beside the app data, not in ~/.kube',
    !file.path.includes('.kube') && file.path.includes('portus-userData'), file.path);

  const yaml = file.contents;
  suite.check('kubectl is pointed at the local end of the tunnel',
    yaml.includes(`server: "https://localhost:${started.port}"`), yaml.match(/server:.*/)[0]);
  // Case is preserved, not normalised: a real EKS endpoint id is mixed case, and
  // this is the one value certificate verification is checked against.
  suite.check('tls-server-name carries the cluster\'s real endpoint, case intact',
    yaml.includes('tls-server-name: "ABCD1234P.gr7.eu-west-1.eks.amazonaws.com"'),
    (yaml.match(/tls-server-name:.*/) || [])[0]);
  suite.check('the cluster CA is embedded, so verification stays on',
    yaml.includes(`certificate-authority-data: "${CA}"`));
  suite.check('nothing disables verification',
    !/insecure-skip-tls-verify/.test(yaml));
  suite.check('the token still comes from the AWS CLI at call time',
    yaml.includes('eks') && yaml.includes('get-token') && yaml.includes('command: aws'));
  suite.check('no credential is written into the file',
    !/aws_secret_access_key|SessionToken|BEGIN .*PRIVATE KEY/i.test(yaml));

  // -------------------------------------------------------------------------
  suite.section('the profile is named only when the CLI can resolve it');

  suite.check('a profile the CLI can find is pinned, so the token call uses it',
    yaml.includes('AWS_PROFILE') && yaml.includes('keys-only'),
    (yaml.match(/value:.*/) || [])[0]);

  closeAll();
  state.written.length = 0;

  // Signing in through Portus means the credentials exist only in memory, so
  // naming a profile would send `aws eks get-token` looking on disk for nothing.
  await signIn({}, 'azure-corp');
  await forward({}, 'azure-corp', 'i-0abc', 'bastion', {
    remoteHost: 'ABCD1234P.gr7.eu-west-1.eks.amazonaws.com',
    remotePort: '443', localPort: '', region: 'eu-west-1',
    kubernetes: { clusterName: 'platform-prod' }
  });

  suite.check('a profile Portus signed in is not pinned',
    !lastWritten().contents.includes('AWS_PROFILE'),
    (lastWritten().contents.match(/env:[\s\S]{0,80}/) || ['no env block'])[0]);

  // -------------------------------------------------------------------------
  suite.section('the tunnel carries the cluster, and kubectl gets a terminal');

  const tunnel = listTunnels().find(t => t.kubernetes);
  suite.check('the tunnel row knows it is a cluster',
    tunnel && tunnel.kubernetes.clusterName === 'platform-prod', tunnel && tunnel.kubernetes);
  suite.check('and carries the kubeconfig path for the terminal',
    tunnel.kubernetes.kubeconfig === lastWritten().path, tunnel.kubernetes.kubeconfig);

  state.spawns.length = 0;
  const opened = await kubectl({}, tunnel.id);
  const spawned = state.spawns[state.spawns.length - 1];

  suite.check('a terminal opens', opened.success === true, opened.error);
  suite.check('KUBECONFIG points at the generated file, not ~/.kube/config',
    spawned.options.env.KUBECONFIG === tunnel.kubernetes.kubeconfig,
    spawned.options.env.KUBECONFIG);
  suite.check('credentials travel with it, since get-token runs out there',
    !!spawned.options.env.AWS_ACCESS_KEY_ID);
  // Windows names it Path, not PATH — see azure-chain.test.js
  suite.check('the rest of the environment survives',
    Object.keys(spawned.options.env).some(name => name.toLowerCase() === 'path'));

  suite.check('a tunnel with no cluster is refused',
    (await kubectl({}, 'no-such-tunnel')).success === false);

  // detached becomes CREATE_NEW_PROCESS_GROUP on Windows, which disables Ctrl+C
  // for the window and everything in it — `kubectl logs -f` then cannot be
  // interrupted and the terminal looks hung. `cmd /c start` already outlives
  // Portus, so there is nothing to trade for it.
  const realPlatform = process.platform;
  const asPlatform = (v) => Object.defineProperty(process, 'platform', { value: v });

  state.spawns.length = 0;
  asPlatform('win32');
  await kubectl({}, tunnel.id);
  const onWindows = state.spawns[state.spawns.length - 1];

  state.spawns.length = 0;
  asPlatform('linux');
  await kubectl({}, tunnel.id);
  const onLinux = state.spawns[state.spawns.length - 1];
  asPlatform(realPlatform);

  suite.check('the Windows terminal is not put in its own process group, so Ctrl+C works',
    onWindows.options.detached === false, onWindows.options.detached);
  suite.check('and it still opens through start, which outlives the app',
    onWindows.args.includes('start'), onWindows.args.join(' '));

  // cmd's tab completion cycles blindly through matches, which is painful with
  // the long names these sessions deal in
  suite.check('the Windows terminal is PowerShell, not cmd',
    onWindows.args.includes('pwsh') && !onWindows.args.includes('/k'),
    onWindows.args.join(' '));
  suite.check('and is left at a prompt afterwards',
    onWindows.args.includes('-NoExit'), onWindows.args.join(' '));
  suite.check('elsewhere the terminal is a real child, so detached stays',
    onLinux.options.detached === true, onLinux.options.detached);

  // -------------------------------------------------------------------------
  suite.section('a plain host forward is untouched by any of this');
  closeAll();
  state.written.length = 0;

  const plain = await forward({}, 'keys-only', 'i-0abc', 'bastion', {
    remoteHost: 'db.example.internal', remotePort: '5432', localPort: '', region: 'eu-west-1'
  });

  suite.check('it starts', plain.success === true, plain.error);
  suite.check('no kubeconfig is written', state.written.length === 0, state.written.map(w => w.path));
  suite.check('and nothing claims a cluster',
    !plain.kubeconfig && !listTunnels().some(t => t.kubernetes));

  // -------------------------------------------------------------------------
  suite.section('quitting takes the kubeconfigs with it');
  // Each one points at a local port that dies with its tunnel, so a file left
  // behind describes a cluster nothing can reach.
  closeAll();
  state.written.length = 0;
  state.removed.length = 0;

  await forward({}, 'keys-only', 'i-0abc', 'bastion', {
    remoteHost: 'ABCD1234P.gr7.eu-west-1.eks.amazonaws.com',
    remotePort: '443', localPort: '', region: 'eu-west-1',
    kubernetes: { clusterName: 'platform-prod' }
  });

  const generated = lastWritten().path;
  suite.check('a kubeconfig exists before quitting', !!generated, generated);

  (state.appEvents['before-quit'] || []).forEach(handler => handler());

  suite.check('it is removed on quit',
    state.removed.includes(generated), state.removed);
  suite.check('and only what Portus wrote is touched',
    state.removed.every(p => p === generated || p.includes('portus-')), state.removed);

  // Quitting twice must not throw, and has nothing left to do
  state.removed.length = 0;
  (state.appEvents['will-quit'] || []).forEach(handler => handler());
  suite.check('a second shutdown is a no-op',
    !state.removed.includes(generated), state.removed);

  suite.done();
})();
