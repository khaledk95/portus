// Which regions the picker offers, and that the chosen one reaches every request.
//
// Two things are load-bearing here. A region names an account-level opt-in, so
// offering all of them would mostly offer errors. And a region is appended to a
// CLI command line, which makes it the same class of input as a remote host.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Regions');

const CONFIG = `
[profile demo]
region = eu-central-1

[profile elsewhere]
region = us-east-1
`;

// What DescribeRegions replies with, per scenario
let describeRegions = null;

let lastRegionsInput = null;

const ec2Send = async (command) => {
  if (command.kind === 'regions') {
    lastRegionsInput = command.input;
    if (describeRegions instanceof Error) throw describeRegions;
    return describeRegions;
  }
  return { Reservations: [] };
};

const { handlers, state, ready } = loadMain({
  files: { config: CONFIG },
  onSpawn: () => ({ stdout: 'Port forwarding started', keepOpen: true }),
  modules: {
    '@aws-sdk/client-ec2': {
      EC2Client: class {
        constructor(config) { this.config = config; lastEc2Region = config.region; }
        async send(command) { return ec2Send(command); }
      },
      DescribeInstancesCommand: class { constructor(i) { this.input = i; this.kind = 'instances'; } },
      DescribeRegionsCommand: class { constructor(i) { this.input = i; this.kind = 'regions'; } }
    },
    '@aws-sdk/client-ssm': {
      SSMClient: class {
        constructor(config) { lastSsmRegion = config.region; }
        async send() { return { InstanceInformationList: [] }; }
      },
      DescribeInstanceInformationCommand: class { constructor(i) { this.input = i; } }
    }
  }
});

let lastEc2Region = null;
let lastSsmRegion = null;

const enabled = (...names) => ({ Regions: names.map(RegionName => ({ RegionName })) });

(async () => {
  await ready();

  const getRegions = handlers.get('get-regions');
  const getInstances = handlers.get('get-ec2-instances');
  const forward = handlers.get('start-port-forward');
  const listTunnels = handlers.get('list-tunnels');
  const closeTunnel = handlers.get('close-tunnel');

  const closeAll = () => (listTunnels() || []).forEach(t => closeTunnel({}, t.id));
  const commandOf = () => (state.spawns.length
    ? String(state.spawns[0].args[state.spawns[0].args.length - 1]).replace(/^exec /, '')
    : '');

  // ---------------------------------------------------------------------------
  suite.section('only the enabled regions are offered');
  describeRegions = enabled('eu-central-1', 'eu-west-1', 'us-east-1');

  const listed = await getRegions({}, 'demo');
  const names = (listed.data || []).map(r => r.name);

  suite.check('the call succeeds', listed.success === true, listed);
  suite.check('the enabled regions come back', names.join(',') === 'eu-central-1,eu-west-1,us-east-1', names);
  suite.check('they are sorted', JSON.stringify(names) === JSON.stringify([...names].sort()));
  suite.check('the profile\'s own region is reported',
    listed.configured === 'eu-central-1', listed.configured);
  suite.check('nothing is flagged as limited', listed.limited === false);
  suite.check('known regions carry their city',
    (listed.data.find(r => r.name === 'eu-central-1') || {}).label === 'Frankfurt',
    listed.data.find(r => r.name === 'eu-central-1'));

  // The whole point: AllRegions would also return the ones this account never
  // opted into, and every one of those is a region where nothing will work.
  suite.check('AllRegions is not requested',
    !lastRegionsInput || lastRegionsInput.AllRegions !== true, lastRegionsInput);

  describeRegions = enabled('us-east-1');
  const narrow = await getRegions({}, 'elsewhere');
  suite.check('an account with one region gets one',
    (narrow.data || []).length === 1 && narrow.data[0].name === 'us-east-1', narrow.data);

  // ---------------------------------------------------------------------------
  suite.section('the configured region is never missing from the list');
  // Without this the picker would disagree with the status bar, and the region
  // actually in use would be unselectable.
  describeRegions = enabled('us-east-1', 'us-west-2');
  const withoutHome = await getRegions({}, 'demo');
  suite.check('it is added back',
    (withoutHome.data || []).some(r => r.name === 'eu-central-1'),
    (withoutHome.data || []).map(r => r.name));
  suite.check('and the list stays sorted',
    JSON.stringify(withoutHome.data.map(r => r.name))
      === JSON.stringify(withoutHome.data.map(r => r.name).sort()));

  // ---------------------------------------------------------------------------
  suite.section('a missing permission narrows the picker, it does not break it');
  describeRegions = new Error('User: arn:aws:sts::1234:assumed-role/dev/me is not authorized to perform: ec2:DescribeRegions');

  const denied = await getRegions({}, 'demo');
  suite.check('it still succeeds', denied.success === true, denied);
  suite.check('the profile\'s own region is offered',
    (denied.data || []).length === 1 && denied.data[0].name === 'eu-central-1', denied.data);
  suite.check('and it says the list is limited', denied.limited === true);
  suite.check('the reason names the denied action',
    /not authorized to perform ec2:DescribeRegions/.test(denied.reason), denied.reason);
  suite.check('without leaking the caller\'s ARN',
    !/arn:aws|\d{12}|assumed-role/.test(denied.reason), denied.reason);

  describeRegions = { Regions: [] };
  const empty = await getRegions({}, 'demo');
  suite.check('an empty reply falls back too',
    empty.limited === true && empty.data.length === 1, empty);

  // ---------------------------------------------------------------------------
  suite.section('the chosen region reaches every request');
  describeRegions = enabled('eu-central-1', 'us-west-2');

  lastEc2Region = null;
  lastSsmRegion = null;
  await getInstances({}, 'demo', 'us-west-2');
  suite.check('EC2 is queried in the chosen region', lastEc2Region === 'us-west-2', lastEc2Region);
  suite.check('and so is the SSM inventory', lastSsmRegion === 'us-west-2', lastSsmRegion);

  lastEc2Region = null;
  await getInstances({}, 'demo');
  suite.check('with none chosen it falls back to the profile\'s',
    lastEc2Region === 'eu-central-1', lastEc2Region);

  state.spawns.length = 0;
  await forward({}, 'demo', 'i-0abc', 'bastion',
    { remoteHost: 'db.rds.amazonaws.com', remotePort: '5432', localPort: '', region: 'us-west-2' });
  suite.check('a tunnel is opened in the chosen region',
    /--region us-west-2/.test(commandOf()), commandOf().slice(0, 160));
  closeAll();

  state.spawns.length = 0;
  await forward({}, 'demo', 'i-0abc', 'bastion',
    { remoteHost: 'db.rds.amazonaws.com', remotePort: '5432', localPort: '' });
  suite.check('and in the profile\'s region when none was chosen',
    /--region eu-central-1/.test(commandOf()), commandOf().slice(0, 160));
  closeAll();

  // ---------------------------------------------------------------------------
  suite.section('a region cannot smuggle anything onto the command line');
  // It is interpolated into a shell command, so it gets the same treatment the
  // remote host gets: anything unrecognised is discarded, not passed along.
  const hostile = [
    'us-west-2; calc.exe',
    'us-west-2 --profile evil',
    'us-west-2`whoami`',
    'us-west-2$(whoami)',
    'us-west-2\ncalc.exe',
    '../../etc/passwd',
    'US-WEST-2',
    'a'.repeat(40)
  ];

  for (const region of hostile) {
    state.spawns.length = 0;
    await forward({}, 'demo', 'i-0abc', 'bastion',
      { remoteHost: 'db.rds.amazonaws.com', remotePort: '5432', localPort: '', region });

    const command = commandOf();
    const label = region.length > 30 ? `${region.slice(0, 27)}…` : region.replace(/\n/g, '\\n');

    suite.check(`discarded: ${label}`,
      /--region eu-central-1$/.test(command.trim()) && !command.includes(region),
      command.slice(-70));
    closeAll();
  }

  // real regions must still work
  for (const region of ['us-east-1', 'ap-southeast-4', 'us-gov-west-1', 'cn-north-1', 'il-central-1']) {
    state.spawns.length = 0;
    await forward({}, 'demo', 'i-0abc', 'bastion',
      { remoteHost: 'db.rds.amazonaws.com', remotePort: '5432', localPort: '', region });
    suite.check(`accepted: ${region}`, commandOf().includes(`--region ${region}`), commandOf().slice(-60));
    closeAll();
  }

  suite.done();
})();
