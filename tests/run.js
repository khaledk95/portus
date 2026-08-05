// Runs every *.test.js in this directory and reports whether they all passed.
//
// Each suite gets its own process on purpose: they stub electron, fs-extra and
// the AWS SDK through Module._load before requiring the real main.js, which is a
// process-wide change. Sharing one process would leak one suite's stubs into the
// next.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const suites = fs.readdirSync(__dirname)
  .filter(name => name.endsWith('.test.js'))
  .sort();

if (!suites.length) {
  console.error('No test suites found in tests/');
  process.exit(1);
}

const failed = [];

for (const suite of suites) {
  const run = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  if (run.status !== 0) failed.push(suite);
}

console.log(`\n${'='.repeat(60)}`);

if (failed.length) {
  console.log(`FAILED: ${failed.join(', ')}`);
  process.exit(1);
}

console.log(`All ${suites.length} suites passed.`);
