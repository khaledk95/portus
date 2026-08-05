// Managed endpoint discovery: what the port-forward dialog offers as remote hosts.
//
// The shapes here are the ones AWS actually returns. Aurora is the reason this
// suite exists — DescribeDBInstances lists cluster members alongside standalone
// databases, and offering those instead of the cluster writer endpoint hands
// people an address that moves on failover.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Endpoint discovery');

const RDS_INSTANCES = [
  { DBInstanceIdentifier: 'legacy-oracle', Engine: 'oracle-se2', EngineVersion: '19.0', DBInstanceStatus: 'available',
    Endpoint: { Address: 'legacy-oracle.abc.eu-central-1.rds.amazonaws.com', Port: 1521 } },
  { DBInstanceIdentifier: 'reporting-mssql', Engine: 'sqlserver-se', DBInstanceStatus: 'available',
    Endpoint: { Address: 'reporting-mssql.abc.eu-central-1.rds.amazonaws.com', Port: 1433 } },
  // a non-standard port has to survive: the service preset would say 5432
  { DBInstanceIdentifier: 'odd-postgres', Engine: 'postgres', DBInstanceStatus: 'available',
    Endpoint: { Address: 'odd-postgres.abc.eu-central-1.rds.amazonaws.com', Port: 5433 } },
  { DBInstanceIdentifier: 'plain-mysql', Engine: 'mysql', DBInstanceStatus: 'available',
    Endpoint: { Address: 'plain-mysql.abc.eu-central-1.rds.amazonaws.com', Port: 3306 } },

  // Aurora members: their endpoints move on failover, so the cluster wins
  { DBInstanceIdentifier: 'prod-aurora-pg-1', Engine: 'aurora-postgresql', DBClusterIdentifier: 'prod-aurora-pg',
    DBInstanceStatus: 'available', Endpoint: { Address: 'prod-aurora-pg-1.abc.eu-central-1.rds.amazonaws.com', Port: 5432 } },
  { DBInstanceIdentifier: 'prod-aurora-pg-2', Engine: 'aurora-postgresql', DBClusterIdentifier: 'prod-aurora-pg',
    DBInstanceStatus: 'available', Endpoint: { Address: 'prod-aurora-pg-2.abc.eu-central-1.rds.amazonaws.com', Port: 5432 } },
  { DBInstanceIdentifier: 'prod-aurora-my-1', Engine: 'aurora-mysql', DBClusterIdentifier: 'prod-aurora-my',
    DBInstanceStatus: 'available', Endpoint: { Address: 'prod-aurora-my-1.abc.eu-central-1.rds.amazonaws.com', Port: 3306 } },

  { DBInstanceIdentifier: 'half-built', Engine: 'postgres', DBInstanceStatus: 'creating' },
  { DBInstanceIdentifier: 'some-mariadb', Engine: 'mariadb', DBInstanceStatus: 'available',
    Endpoint: { Address: 'some-mariadb.abc.eu-central-1.rds.amazonaws.com', Port: 3306 } }
];

const RDS_CLUSTERS = [
  { DBClusterIdentifier: 'prod-aurora-pg', Engine: 'aurora-postgresql', EngineVersion: '15.4', Status: 'available',
    Endpoint: 'prod-aurora-pg.cluster-abc.eu-central-1.rds.amazonaws.com',
    ReaderEndpoint: 'prod-aurora-pg.cluster-ro-abc.eu-central-1.rds.amazonaws.com', Port: 5432 },
  { DBClusterIdentifier: 'prod-aurora-my', Engine: 'aurora-mysql', Status: 'available',
    Endpoint: 'prod-aurora-my.cluster-abc.eu-central-1.rds.amazonaws.com',
    ReaderEndpoint: 'prod-aurora-my.cluster-ro-abc.eu-central-1.rds.amazonaws.com', Port: 3306 },
  { DBClusterIdentifier: 'docs-cluster', Engine: 'docdb', Status: 'available',
    Endpoint: 'docs-cluster.cluster-abc.eu-central-1.docdb.amazonaws.com', Port: 27017 }
];

const REPLICATION_GROUPS = [
  { ReplicationGroupId: 'session-cache', Engine: 'redis', Status: 'available',
    MemberClusters: ['session-cache-001', 'session-cache-002'],
    TransitEncryptionEnabled: true,
    NodeGroups: [{ PrimaryEndpoint: { Address: 'master.session-cache.abc.euc1.cache.amazonaws.com', Port: 6379 } }] },
  { ReplicationGroupId: 'sharded-cache', Engine: 'redis', Status: 'available',
    MemberClusters: ['sharded-cache-0001-001'],
    ConfigurationEndpoint: { Address: 'sharded-cache.abc.clustercfg.euc1.cache.amazonaws.com', Port: 6379 },
    NodeGroups: [{ PrimaryEndpoint: { Address: 'ignored.euc1.cache.amazonaws.com', Port: 6379 } }] }
];

const CACHE_CLUSTERS = [
  { CacheClusterId: 'session-cache-001', Engine: 'redis', ReplicationGroupId: 'session-cache',
    CacheNodes: [{ Endpoint: { Address: 'session-cache-001.euc1.cache.amazonaws.com', Port: 6379 } }] },
  { CacheClusterId: 'sharded-cache-0001-001', Engine: 'redis',
    CacheNodes: [{ Endpoint: { Address: 'sharded-cache-0001-001.euc1.cache.amazonaws.com', Port: 6379 } }] },
  { CacheClusterId: 'solo-redis', Engine: 'redis', EngineVersion: '7.1', CacheClusterStatus: 'available',
    CacheNodes: [{ Endpoint: { Address: 'solo-redis.euc1.cache.amazonaws.com', Port: 6380 } }] },
  { CacheClusterId: 'memcached-thing', Engine: 'memcached', CacheClusterStatus: 'available',
    CacheNodes: [{ Endpoint: { Address: 'memcached-thing.euc1.cache.amazonaws.com', Port: 11211 } }] }
];

// Which of the four describe calls should throw, set per scenario
let failures = {};

const client = class { async send(command) { return command.run(); } };
const command = (key, payload) => class {
  constructor(input) { this.input = input; }
  run() {
    if (failures[key]) throw new Error(failures[key]);
    return payload;
  }
};

const { handlers, ready } = loadMain({
  files: { config: '[profile demo]\nregion = eu-central-1\n' },
  modules: {
    '@aws-sdk/client-rds': {
      RDSClient: client,
      DescribeDBInstancesCommand: command('instances', { DBInstances: RDS_INSTANCES }),
      DescribeDBClustersCommand: command('clusters', { DBClusters: RDS_CLUSTERS })
    },
    '@aws-sdk/client-elasticache': {
      ElastiCacheClient: client,
      DescribeReplicationGroupsCommand: command('groups', { ReplicationGroups: REPLICATION_GROUPS }),
      DescribeCacheClustersCommand: command('caches', { CacheClusters: CACHE_CLUSTERS })
    }
  }
});

const denied = action =>
  `User: arn:aws:sts::123456789012:assumed-role/dev/me is not authorized to perform: ${action}`;

(async () => {
  await ready();
  const getEndpoints = handlers.get('get-endpoints');

  // ---------------------------------------------------------------------------
  suite.section('all four calls succeed');
  failures = {};

  const result = await getEndpoints({}, 'demo');
  const endpoints = result.data || [];
  const names = endpoints.map(endpoint => endpoint.name);
  const hosts = endpoints.map(endpoint => endpoint.host);

  suite.check('the call succeeds', result.success === true, result.error);
  suite.check('the region is reported', result.region === 'eu-central-1');
  suite.check('no warnings', (result.warnings || []).length === 0, result.warnings);

  suite.check('Aurora member instances are dropped',
    !hosts.some(host => /prod-aurora-(pg|my)-\d\./.test(host)), hosts.filter(h => /-\d\./.test(h)));
  suite.check('the Aurora writer endpoint is offered and the reader is not',
    hosts.includes('prod-aurora-pg.cluster-abc.eu-central-1.rds.amazonaws.com')
      && !hosts.some(host => host.includes('cluster-ro-')));
  suite.check('one row per Aurora cluster',
    names.filter(name => name === 'prod-aurora-pg').length === 1);
  suite.check('a non-standard port is preserved',
    endpoints.find(endpoint => endpoint.name === 'odd-postgres').port === 5433);
  suite.check('MariaDB is left out rather than filed under MySQL', !names.includes('some-mariadb'));
  suite.check('DocumentDB is left out', !names.includes('docs-cluster'));
  suite.check('Memcached is left out', !names.includes('memcached-thing'));
  suite.check('a database still being created is left out', !names.includes('half-built'));
  suite.check('cache nodes inside a replication group are not listed twice',
    !names.includes('session-cache-001') && !names.includes('sharded-cache-0001-001'));
  suite.check('a standalone cache node is listed', names.includes('solo-redis'));
  suite.check('cluster mode uses the configuration endpoint',
    endpoints.find(endpoint => endpoint.name === 'sharded-cache').host
      === 'sharded-cache.abc.clustercfg.euc1.cache.amazonaws.com');
  suite.check('encryption in transit is surfaced',
    endpoints.find(endpoint => endpoint.name === 'session-cache').tls === true);
  suite.check('the list is sorted by name',
    JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))));
  suite.check('no duplicate hosts', new Set(hosts).size === hosts.length);

  const forService = service => endpoints
    .filter(endpoint => endpoint.service === service)
    .map(endpoint => endpoint.name)
    .sort();

  suite.check('Oracle', JSON.stringify(forService('oracle')) === '["legacy-oracle"]', forService('oracle'));
  suite.check('SQL Server', JSON.stringify(forService('sqlserver')) === '["reporting-mssql"]', forService('sqlserver'));
  suite.check('PostgreSQL includes the Aurora cluster',
    JSON.stringify(forService('postgresql')) === '["odd-postgres","prod-aurora-pg"]', forService('postgresql'));
  suite.check('MySQL includes the Aurora cluster',
    JSON.stringify(forService('mysql')) === '["plain-mysql","prod-aurora-my"]', forService('mysql'));
  suite.check('Redis covers groups and standalone nodes',
    JSON.stringify(forService('redis')) === '["session-cache","sharded-cache","solo-redis"]', forService('redis'));

  // ---------------------------------------------------------------------------
  suite.section('a permission gap costs suggestions, not the feature');
  failures = {
    groups: denied('elasticache:DescribeReplicationGroups'),
    caches: denied('elasticache:DescribeCacheClusters')
  };

  const partial = await getEndpoints({}, 'demo');
  suite.check('the call still succeeds', partial.success === true, partial.error);
  suite.check('the RDS endpoints are still returned', (partial.data || []).length === 6, (partial.data || []).length);
  suite.check('two warnings are raised', (partial.warnings || []).length === 2, partial.warnings);
  suite.check('the warning names the denied action',
    partial.warnings.every(warning => /not authorized to perform elasticache:Describe/.test(warning)),
    partial.warnings);
  suite.check('the warning leaks no ARN, account id or username',
    !partial.warnings.some(warning => /arn:aws|\d{12}|assumed-role/.test(warning)), partial.warnings);
  suite.check('no Redis rows survive', !(partial.data || []).some(endpoint => endpoint.service === 'redis'));

  failures = {
    instances: denied('rds:DescribeDBInstances'),
    clusters: denied('rds:DescribeDBClusters'),
    groups: denied('elasticache:DescribeReplicationGroups'),
    caches: denied('elasticache:DescribeCacheClusters')
  };
  const none = await getEndpoints({}, 'demo');
  suite.check('every call denied returns an empty list, not a failure',
    none.success === true && none.data.length === 0, none);
  suite.check('four warnings', (none.warnings || []).length === 4, none.warnings);

  // ---------------------------------------------------------------------------
  suite.section('an expired session is not mistaken for a permission gap');
  failures = { instances: 'The security token included in the request is expired' };

  const expired = await getEndpoints({}, 'demo');
  suite.check('it is reported as a session expiry',
    expired.success === false && expired.sessionExpired === true, expired);

  suite.done();
})();
