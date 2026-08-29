// Regression pins for the documentation-audit findings.
//
// Those fixes land in README.md itself, which no harness boots, so the
// demonstrating assertion reads the file as text — the same convention as
// release-check.test.js's "nothing here depends on build config" section.

const fs = require('fs');
const path = require('path');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Documentation accuracy');

// ---------------------------------------------------------------------------
suite.section('the README tests tree lists every suite the runner discovers');
// tests/run.js globs every *.test.js in this directory, so any suite missing
// from the README's project tree is undocumented by the very section that
// inventories the repository — and the omission would recur silently every
// time a suite is added. The pin therefore holds the whole tree honest:
// every suite file the runner would discover must be named in it.
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const tree = (readme.match(/├── tests\/[\s\S]*?\n├── \.github/) || [''])[0];

const discovered = fs.readdirSync(__dirname)
  .filter(name => name.endsWith('.test.js'))
  .sort();
const missing = discovered.filter(name => !tree.includes(name));

suite.check('the tests tree block is found in the README',
  tree.length > 0,
  'no tests/ tree between the tests/ and .github/ headings');

suite.check('every suite the runner discovers is listed',
  missing.length === 0,
  missing.join(', '));

suite.done();
