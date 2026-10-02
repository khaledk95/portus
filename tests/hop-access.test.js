// Reaching an instance that has no SSM agent, through one that has.
//
// The transport is not new — it is the same StartPortForwardingSessionToRemoteHost
// a database tunnel uses, pointed at an instance's private address. What is new is
// that two instances are now involved in one tunnel, so these check the halves
// that can be got the wrong way round: which instance the session runs on, which
// one the row claims to have reached, and that both ends are validated before
// either touches a command line.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Access via a hop');

const { handlers, state, ready } = loadMain({
  files: { config: '[profile demo]\nregion = eu-central-1\n' },
  onSpawn: () => ({ stdout: 'Port forwarding started', keepOpen: true })
});

const HOP = 'i-0aaa111bbb222ccc3';
const TARGET = 'i-0ddd444eee555fff6';
const TARGET_IP = '10.0.2.57';

(async () => {
  await ready();

  const rdp = handlers.get('connect-rdp-ssm');
  const forward = handlers.get('start-port-forward');
  const listTunnels = handlers.get('list-tunnels');
  const closeTunnel = handlers.get('close-tunnel');

  const closeAll = () => (listTunnels() || []).forEach(tunnel => closeTunnel({}, tunnel.id));

  const isProbe = (spawn) => spawn.command === 'where'
    || (spawn.command === 'sh' && /^command -v /.test(String((spawn.args || [])[1] || '')));

  // The first non-probe spawn is the SSM tunnel. On an RDP connection the RDP
  // client is spawned after it, so taking the last one would assert against
  // `mstsc /v:localhost:…` instead of the command under test.
  const tunnelCommand = () => {
    const real = state.spawns.filter(spawn => !isProbe(spawn));
    if (!real.length) return '';
    const spawned = real[0];
    return String(spawned.args[spawned.args.length - 1]).replace(/^exec /, '');
  };

  // ---------------------------------------------------------------------------
  suite.section('RDP through a hop runs the session on the hop, not the target');

  state.spawns.length = 0;
  const viaResult = await rdp({}, 'demo', TARGET, 'legacy-win', 'eu-central-1', {
    via: { instanceId: HOP, instanceName: 'bastion-01', targetHost: TARGET_IP }
  });

  const command = tunnelCommand();

  suite.check('it starts', viaResult.success === true, viaResult.error);
  suite.check('--target is the hop, which is the only SSM-managed end',
    command.includes(`--target ${HOP}`) && !command.includes(`--target ${TARGET}`), command.slice(0, 160));
  suite.check('the document is the remote-host one',
    command.includes('AWS-StartPortForwardingSessionToRemoteHost'), command.slice(0, 160));
  suite.check('the target is reached by its private address on 3389',
    command.includes(`host=${TARGET_IP},portNumber=3389`), command.slice(0, 200));
  suite.check('and the message names both machines',
    /legacy-win/.test(viaResult.message) && /bastion-01/.test(viaResult.message), viaResult.message);

  // ---------------------------------------------------------------------------
  suite.section('the tunnel row describes the machine the user asked for');
  // Naming the hop here would read as the wrong computer entirely.

  const viaTunnel = listTunnels()[0];

  suite.check('the session instance is the hop',
    viaTunnel.instanceId === HOP, viaTunnel.instanceId);
  suite.check('and the target is recorded separately',
    viaTunnel.target && viaTunnel.target.instanceId === TARGET
      && viaTunnel.target.instanceName === 'legacy-win',
    viaTunnel.target);
  suite.check('with the address it was reached on',
    viaTunnel.target.host === TARGET_IP && viaTunnel.remoteHost === TARGET_IP, viaTunnel);

  // ---------------------------------------------------------------------------
  suite.section('a second request for the same target reuses it');
  // Keyed on what the user asked for, not on the hop — otherwise picking a
  // different hop would quietly open a second tunnel to the same machine.

  const again = await rdp({}, 'demo', TARGET, 'legacy-win', 'eu-central-1', {
    via: { instanceId: 'i-0999888777666555', instanceName: 'other-bastion', targetHost: TARGET_IP }
  });

  suite.check('reported as reused', again.success === true && again.reused === true, again);
  suite.check('and no second tunnel was opened', listTunnels().length === 1, listTunnels().length);

  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('a direct RDP connection is unchanged by any of this');

  state.spawns.length = 0;
  const direct = await rdp({}, 'demo', TARGET, 'win-jump', 'eu-central-1');
  const directCommand = tunnelCommand();

  suite.check('it still starts', direct.success === true, direct.error);
  suite.check('on the instance itself',
    directCommand.includes(`--target ${TARGET}`), directCommand.slice(0, 160));
  suite.check('with the plain port-forwarding document',
    directCommand.includes('--document-name AWS-StartPortForwardingSession ')
      && !directCommand.includes('ToRemoteHost'), directCommand.slice(0, 160));
  suite.check('and no target is recorded, because there is no second machine',
    listTunnels()[0].target === null, listTunnels()[0].target);

  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('a port forward to an unmanaged instance says what it reached');

  state.spawns.length = 0;
  const forwarded = await forward({}, 'demo', HOP, 'bastion-01', {
    remoteHost: TARGET_IP, remotePort: '22', localPort: '',
    target: { instanceId: TARGET, instanceName: 'legacy-linux' }
  });

  suite.check('it starts', forwarded.success === true, forwarded.error);
  suite.check('the far end is the instance address',
    tunnelCommand().includes(`host=${TARGET_IP},portNumber=22`), tunnelCommand().slice(0, 200));

  const fwdTunnel = listTunnels()[0];
  suite.check('and the row can name the target rather than the hop',
    fwdTunnel.target && fwdTunnel.target.instanceId === TARGET
      && fwdTunnel.instanceId === HOP,
    { instanceId: fwdTunnel.instanceId, target: fwdTunnel.target });

  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('both ends are validated before either reaches a shell');
  // The hop lands on the command line as --target and the address lands inside
  // --parameters, so neither can be taken on trust.

  const HOSTILE = [
    ['hop id', { instanceId: 'i-0abc; calc.exe', instanceName: 'x', targetHost: TARGET_IP }],
    ['hop id with a backtick', { instanceId: 'i-0abc`calc`', instanceName: 'x', targetHost: TARGET_IP }],
    ['empty hop id', { instanceId: '', instanceName: 'x', targetHost: TARGET_IP }],
    ['target address', { instanceId: HOP, instanceName: 'x', targetHost: '10.0.2.57; calc.exe' }],
    ['target address substitution', { instanceId: HOP, instanceName: 'x', targetHost: '$(whoami)' }],
    ['missing address', { instanceId: HOP, instanceName: 'x', targetHost: '' }]
  ];

  for (const [label, via] of HOSTILE) {
    state.spawns.length = 0;
    const result = await rdp({}, 'demo', TARGET, 'legacy-win', 'eu-central-1', { via });

    suite.check(`rejected: ${label}`,
      result.success === false && state.spawns.filter(s => !isProbe(s)).length === 0,
      { success: result.success, error: result.error });
  }

  // A hop that is the target is a configuration mistake rather than an attack,
  // but it produces a tunnel from a machine to itself and is worth refusing.
  state.spawns.length = 0;
  const selfHop = await rdp({}, 'demo', TARGET, 'legacy-win', 'eu-central-1', {
    via: { instanceId: TARGET, instanceName: 'itself', targetHost: TARGET_IP }
  });
  suite.check('refused: the hop is the target',
    selfHop.success === false && state.spawns.filter(s => !isProbe(s)).length === 0, selfHop.error);

  // The same for the descriptive target on a port forward: it is renderer input
  // that ends up on screen.
  state.spawns.length = 0;
  const badTarget = await forward({}, 'demo', HOP, 'bastion-01', {
    remoteHost: TARGET_IP, remotePort: '22', localPort: '',
    target: { instanceId: 'i-0abc; calc.exe', instanceName: 'x' }
  });
  suite.check('refused: a hostile target id on a port forward',
    badTarget.success === false && state.spawns.filter(s => !isProbe(s)).length === 0, badTarget.error);

  closeAll();

  suite.done();
})();
