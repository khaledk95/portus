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
  const ssm = handlers.get('connect-ssm');
  const rdp = handlers.get('connect-rdp-ssm');
  const listTunnels = handlers.get('list-tunnels');
  const closeTunnel = handlers.get('close-tunnel');

  const closeAll = () => (listTunnels() || []).forEach(tunnel => closeTunnel({}, tunnel.id));

  // The tunnel is wrapped differently per platform: Windows hands the command to
  // `cmd /c`, POSIX to `bash -c "exec …"` so the shell is replaced rather than
  // left hanging around as a parent. Both wrappers are stripped here, and the
  // wrapper itself is asserted separately below.
  const onWindows = process.platform === 'win32';
  // Availability probes (`where pwsh`, `sh -c "command -v …"`) are spawns too,
  // and the first terminal launch is preceded by one. They are not what any
  // assertion here is about.
  const isProbe = (spawn) => spawn.command === 'where'
    || (spawn.command === 'sh' && /^command -v /.test(String((spawn.args || [])[1] || '')));

  const lastCommand = () => {
    const real = state.spawns.filter(spawn => !isProbe(spawn));
    if (!real.length) return '';
    const spawned = real[0];
    return String(spawned.args[spawned.args.length - 1]).replace(/^exec /, '');
  };

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
  suite.section('a hostile instance id never reaches a shell either');
  // The id arrives over IPC and lands on a command line. EC2 only ever returns
  // `i-` and hex, so nothing real is rejected — but the Windows terminal is
  // PowerShell now, where ; $() and backticks are syntax that cmd ignored.

  const HOSTILE_IDS = [
    'i-0abc; calc.exe',
    'i-0abc && calc.exe',
    'i-0abc | calc.exe',
    'i-0abc`calc.exe`',
    'i-0abc$(calc.exe)',
    'i-0abc\ncalc.exe',
    '"; calc.exe; "',
    ''
  ];

  for (const id of HOSTILE_IDS) {
    for (const [name, call] of [
      ['port forward', () => forward({}, 'demo', id, 'bastion',
        { remoteHost: 'db.example.internal', remotePort: '5432', localPort: '' })],
      ['SSM shell', () => ssm({}, 'demo', id, 'eu-central-1')],
      ['RDP', () => rdp({}, 'demo', id, 'jump', 'eu-central-1')]
    ]) {
      state.spawns.length = 0;
      const result = await call();

      const label = (id || '(empty)').replace(/\n/g, '\\n').slice(0, 24);
      suite.check(`${name} rejected: ${label}`,
        result.success === false && state.spawns.length === 0,
        { success: result.success, spawns: state.spawns.length });
    }
  }

  // A real one still works, or the guard is just breaking the app
  state.spawns.length = 0;
  suite.check('a genuine instance id is still accepted',
    (await forward({}, 'demo', 'i-0a1b2c3d4e5f60011', 'bastion',
      { remoteHost: 'db.example.internal', remotePort: '5432', localPort: '' })).success === true);

  // ---------------------------------------------------------------------------
  suite.section('a hostile profile name never reaches a shell either');
  // The profile name lands on the same command line as `--profile <name>`, and
  // on Windows that line goes to PowerShell as one string. It arrives over IPC
  // like everything else here.

  const HOSTILE_PROFILES = [
    'demo; calc.exe',
    'demo && whoami',
    'demo | net user',
    'demo`whoami`',
    'demo$(whoami)',
    'demo"; calc.exe; "',
    "demo'; calc.exe; '",
    'demo\ncalc.exe',
    'demo\\"; calc',
    '$env:PATH',
    'demo > C:\\Windows\\Temp\\owned',
    '',
    'a'.repeat(200)
  ];

  for (const name of HOSTILE_PROFILES) {
    for (const [label, call] of [
      ['port forward', () => forward({}, name, 'i-0abc', 'bastion',
        { remoteHost: 'db.example.internal', remotePort: '5432', localPort: '' })],
      ['SSM shell', () => ssm({}, name, 'i-0abc', 'eu-central-1')],
      ['RDP', () => rdp({}, name, 'i-0abc', 'jump', 'eu-central-1')]
    ]) {
      state.spawns.length = 0;
      const result = await call();

      const shown = (name || '(empty)').replace(/\n/g, '\\n').slice(0, 22);
      suite.check(`${label} rejected: ${shown}`,
        result.success === false && state.spawns.length === 0,
        { success: result.success, spawns: state.spawns.length });
    }
  }

  // AWS allows far more than [a-z0-9-] in a profile name, and people use it.
  // Rejecting these would be a regression dressed up as hardening.
  const LEGITIMATE_PROFILES = [
    'demo', 'acme-prod', 'acme_staging', 'team.platform',
    'user@corp', 'team+aws', '_leading', 'café', 'prod 2', 'a/b', 'v1=2'
  ];

  for (const name of LEGITIMATE_PROFILES) {
    state.spawns.length = 0;
    const result = await ssm({}, name, 'i-0abc', 'eu-central-1');

    suite.check(`accepted: ${name}`, result.success === true, result.error);
    suite.check('  and is quoted on the command line',
      lastCommand().includes(`--profile "${name}"`), lastCommand().slice(0, 140));
  }

  closeAll();

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

  // ---------------------------------------------------------------------------
  suite.section('the tunnel is wrapped the way each platform needs');
  // Removing shell:true on Windows once broke RDP: Node escapes the quotes around
  // --parameters as \" and cmd.exe misreads them. The wrapper is load-bearing.

  state.spawns.length = 0;
  await forward({}, 'demo', 'i-0abc', 'bastion',
    { remoteHost: 'db.rds.amazonaws.com', remotePort: '5432', localPort: '' });

  const spawned = state.spawns[0];

  if (onWindows) {
    suite.check('Windows runs it through cmd /c',
      spawned.command === 'cmd' && spawned.args[0] === '/c', spawned);
  } else {
    suite.check('POSIX runs it through bash -c',
      spawned.command === 'bash' && spawned.args[0] === '-c', spawned);
    suite.check('POSIX execs so no shell is left as a parent',
      String(spawned.args[1]).startsWith('exec aws ssm start-session '), String(spawned.args[1]).slice(0, 60));
  }

  closeAll();

  suite.done();
})();
