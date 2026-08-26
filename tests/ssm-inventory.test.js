// The SSM agent column is a join between two paginated APIs, and the two do not
// page at the same rate. DescribeInstances returns up to 1000 per page; its SSM
// counterpart, DescribeInstanceInformation, caps at 50. If the SSM loop stops
// after the same number of pages as the instance loop, a large fleet outruns the
// status lookup: instances past the SSM cap get no record, are shown as
// 'Not managed', and have their connect buttons disabled — a real, reachable
// target that the UI says cannot be reached.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('SSM inventory pagination');

// More managed instances than the old 40-page x 50 = 2,000 SSM ceiling, so the
// last few are only reachable once the loop pages past it.
const TOTAL = 2250;
const ids = Array.from({ length: TOTAL }, (_, n) => `i-${String(n).padStart(12, '0')}`);

// One page of instances is enough on the EC2 side; the asymmetry under test is
// entirely in how far the SSM loop pages, not the instance loop.
const ec2Send = async (command) => {
  if (command.kind === 'instances') {
    return {
      Reservations: [{
        Instances: ids.map(id => ({
          InstanceId: id,
          InstanceType: 't3.micro',
          State: { Name: 'running' },
          Placement: { AvailabilityZone: 'eu-central-1a' },
          Tags: [{ Key: 'Name', Value: id }]
        }))
      }]
    };
  }
  return {};
};

// SSM pages 50 at a time and reports every instance Online. The NextToken chain
// runs the full TOTAL / 50 = 45 pages; with the old cap the loop abandons it at
// page 40 and the tail is never recorded.
let ssmPagesServed = 0;
const ssmSend = async (command) => {
  const start = (command.input.NextToken ? Number(command.input.NextToken) : 0);
  const slice = ids.slice(start, start + 50);
  ssmPagesServed += 1;
  const next = start + 50;
  return {
    InstanceInformationList: slice.map(id => ({
      InstanceId: id,
      PingStatus: 'Online',
      AgentVersion: '3.0.0.0',
      PlatformName: 'Ubuntu'
    })),
    NextToken: next < TOTAL ? String(next) : undefined
  };
};

const { handlers, state, ready } = loadMain({
  files: { config: '[profile demo]\nregion = eu-central-1\n' },
  onSpawn: () => ({ stdout: 'Port forwarding started', keepOpen: true }),
  modules: {
    '@aws-sdk/client-ec2': {
      EC2Client: class { async send(command) { return ec2Send(command); } },
      DescribeInstancesCommand: class { constructor(i) { this.input = i; this.kind = 'instances'; } },
      DescribeRegionsCommand: class { constructor(i) { this.input = i; this.kind = 'regions'; } }
    },
    '@aws-sdk/client-ssm': {
      SSMClient: class { async send(command) { return ssmSend(command); } },
      DescribeInstanceInformationCommand: class { constructor(i) { this.input = i; } }
    }
  }
});

(async () => {
  await ready();

  const getInstances = handlers.get('get-ec2-instances');

  const result = await getInstances({}, 'demo', 'eu-central-1');
  const byId = new Map((result.data || []).map(instance => [instance.instanceId, instance]));

  suite.section('every managed instance gets its SSM status, not only the first 2,000');

  suite.check('the lookup did not report itself failed',
    result.success === true && result.ssmLookupFailed === false,
    { success: result.success, ssmLookupFailed: result.ssmLookupFailed });

  suite.check('all instances are listed',
    (result.data || []).length === TOTAL, (result.data || []).length);

  suite.check('the whole SSM chain was paged, not truncated at the instance-loop cap',
    ssmPagesServed >= Math.ceil(TOTAL / 50), ssmPagesServed);

  const first = byId.get(ids[0]);
  suite.check('an instance inside the old cap is Online',
    first && first.ssmStatus === 'online', first && first.ssmStatus);

  // ids[2000] and ids[2249] live on SSM pages 41 and 45 — beyond the old 40-page
  // ceiling. Before the fix these came back undefined and mapped to 'unmanaged'.
  const justPast = byId.get(ids[2000]);
  suite.check('the instance just past the old cap is Online, not unmanaged',
    justPast && justPast.ssmStatus === 'online', justPast && justPast.ssmStatus);

  const last = byId.get(ids[TOTAL - 1]);
  suite.check('the last instance is Online, not unmanaged',
    last && last.ssmStatus === 'online', last && last.ssmStatus);

  suite.done();
})();
