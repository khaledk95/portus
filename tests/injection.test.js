// Port forwarding builds a shell command from a hostname and a port.
//
// Since endpoint discovery landed, that hostname can arrive from an AWS API
// response rather than the keyboard, so these check what actually reaches the
// shell — not what the UI happens to allow.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Command injection');

const { handlers, state, ready } = loadMain({
  files: { config: '[profile demo]\nregion = eu-central-1\n' },
  // the phrase the tunnel waits for before reporting itself up, then it stays up
  onSpawn: () => ({ stdout: 'Port forwarding started', keepOpen: true })
});

// What a tampered or hostile value could look like
const HOSTILE_HOSTS = [
  'db.rds.amazonaws.com; calc.exe',
  'db.rds.amazonaws.com && whoami',
  'db.rds.amazonaws.com | net user',
  'db.rds.amazonaws.com`whoami`',
  'db.rds.amazonaws.com$(whoami)',
  'db.rds.amazonaws.com"; rm -rf /; "',
  'db.rds.amazonaws.com\ncalc.exe',
  'db.rds.amazonaws.com --profile evil',
  '../../etc/passwd',
  '%USERPROFILE%\\.aws\\credentials',
  'a'.repeat(300)
];

const HOSTILE_PORTS = [
  '5432; calc.exe',
  '$(whoami)',
  '-1',
  '99999',
  'abc',
  '',
  '5432 --profile evil',
  '5432\ncalc'
];

// Shapes AWS genuinely returns, which must keep working
const LEGITIMATE_HOSTS = [
  'prod-aurora-pg.cluster-c9ukmpabc123.eu-central-1.rds.amazonaws.com',
  'master.session-cache.abc123.euc1.cache.amazonaws.com',
  'sharded-cache.abc123.clustercfg.euc1.cache.amazonaws.com',
  'my-db.abc123.us-east-1.rds.amazonaws.com',
  '10.0.14.201',
  'internal-thing.corp.local',
  'fd00:ec2::23'
];

(async () => {
  await ready();

  const forward = handlers.get('start-port-forward');
  const listTunnels = handlers.get('list-tunnels');
  const closeTunnel = handlers.get('close-tunnel');

  const closeAll = () => (listTunnels() || []).forEach(tunnel => closeTunnel({}, tunnel.id));
  const lastCommand = () => (state.spawns.length
    ? String(state.spawns[0].args[state.spawns[0].args.length - 1])
    : '');

  // ---------------------------------------------------------------------------
  suite.section('a hostile hostname never reaches a shell');

  for (const host of HOSTILE_HOSTS) {
    state.spawns.length = 0;
    const result = await forward({}, 'demo', 'i-0abc', 'bastion',
      { remoteHost: host, remotePort: '5432', localPort: '' });

    const label = host.length > 40 ? `${host.slice(0, 37)}…` : host.replace(/\n/g, '\\n');
    suite.check(`rejected: ${label}`,
      result.success === false && state.spawns.length === 0,
      { success: result.success, spawns: state.spawns.length });
  }

  // ---------------------------------------------------------------------------
  suite.section('a hostile port is neutralised rather than refused');
  // The port is parsed to an integer, so "5432; calc.exe" becomes 5432 and the
  // suffix is discarded. What matters is that only digits reach the command.

  for (const port of HOSTILE_PORTS) {
    state.spawns.length = 0;
    await forward({}, 'demo', 'i-0abc', 'bastion',
      { remoteHost: 'db.rds.amazonaws.com', remotePort: port, localPort: '' });

    const command = lastCommand();
    const inCommand = (command.match(/portNumber=([^,"]*)/) || [])[1];

    suite.check(`neutralised: ${JSON.stringify(port)}`,
      state.spawns.length === 0 || (/^\d+$/.test(inCommand || '') && !command.includes(port)),
      { spawns: state.spawns.length, portInCommand: inCommand, command: command.slice(0, 120) });

    closeAll();
  }

  // ---------------------------------------------------------------------------
  suite.section('real AWS endpoints still work');

  for (const host of LEGITIMATE_HOSTS) {
    state.spawns.length = 0;
    const result = await forward({}, 'demo', 'i-0abc', 'bastion',
      { remoteHost: host, remotePort: '5432', localPort: '' });

    const command = lastCommand();

    suite.check(`accepted: ${host}`,
      result.success === true && command.includes(host), { error: result.error, spawns: state.spawns.length });
    suite.check('  one ssm start-session, no shell metacharacters',
      /^aws ssm start-session --target i-0abc --document-name AWS-StartPortForwardingSessionToRemoteHost /.test(command)
        && !/[;&|`\n]|\$\(/.test(command),
      command.slice(0, 160));

    closeAll();
  }

  suite.done();
})();
