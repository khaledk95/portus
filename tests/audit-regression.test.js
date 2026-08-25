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
suite.section('the README tests tree lists the EKS suite');
// tests/run.js globs every *.test.js in this directory, so a suite missing
// from the README's project tree is undocumented by the very section that
// inventories the repository. kubernetes.test.js is the EKS feature's only
// suite, and the README documents EKS tunneling and the kubeconfig Portus
// writes — that feature's test belongs in the tree.
const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const tree = (readme.match(/├── tests\/[\s\S]*?\n├── \.github/) || [''])[0];

suite.check('the tests tree names kubernetes.test.js',
  /kubernetes\.test\.js/.test(tree),
  (tree.match(/.*mfa\.test\.js.*/) || [''])[0]);

suite.done();
