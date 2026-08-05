// Portus tells you a newer version exists. It never downloads or installs one.
//
// Two things here are easy to get quietly wrong: comparing versions as strings
// (where "2.10.0" sorts below "2.9.0"), and handing an arbitrary URL to the
// operating system because it arrived from the renderer.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Release notification');

// What api.github.com replies with, per scenario
let githubReply = null;

const { handlers, state, ready } = loadMain({
  files: { config: '[profile demo]\nregion = eu-central-1\n' },
  modules: {
    https: {
      get: (options, callback) => {
        const { EventEmitter } = require('events');
        const request = new EventEmitter();
        request.destroy = () => {};

        setImmediate(() => {
          if (githubReply instanceof Error) {
            request.emit('error', githubReply);
            return;
          }

          const response = new EventEmitter();
          response.statusCode = githubReply.statusCode;
          response.setEncoding = () => {};
          response.resume = () => {};

          callback(response);

          if (response.statusCode === 200) {
            response.emit('data', githubReply.body);
          }
          response.emit('end');
        });

        return request;
      }
    }
  }
});

const opened = state.opened;

const release = (tag, body) => ({
  statusCode: 200,
  body: JSON.stringify({
    tag_name: tag,
    body,
    html_url: `https://github.com/khaledk95/portus/releases/tag/${tag}`
  })
});

(async () => {
  await ready();

  const checkForUpdate = handlers.get('check-for-update');
  const openReleasePage = handlers.get('open-release-page');
  const current = require('../package.json').version;

  // ---------------------------------------------------------------------------
  suite.section('a newer release is reported');
  githubReply = release('v99.0.0', '- Something new\n- Something fixed');

  const newer = await checkForUpdate({});
  suite.check('it is flagged as available', newer.available === true, newer);
  suite.check('the version has no leading v', newer.version === '99.0.0', newer.version);
  suite.check('the running version is reported too', newer.current === current, newer.current);
  suite.check('the notes come through', newer.notes === '- Something new\n- Something fixed', newer.notes);
  suite.check('the release URL points at this repository',
    newer.url === 'https://github.com/khaledk95/portus/releases/tag/v99.0.0', newer.url);

  // ---------------------------------------------------------------------------
  suite.section('the same or an older release is not');
  githubReply = release(`v${current}`, 'notes');
  suite.check('the running version is not an update', (await checkForUpdate({})).available === false);

  githubReply = release('v0.0.1', 'notes');
  suite.check('an older version is not an update', (await checkForUpdate({})).available === false);

  // ---------------------------------------------------------------------------
  suite.section('versions compare as numbers, not as strings');
  // "2.10.0" < "2.9.0" alphabetically, which is the classic way to ship a
  // notification that never fires again after the tenth patch release.
  const isNewer = async (tag) => {
    githubReply = release(tag, '');
    return (await checkForUpdate({})).available;
  };

  githubReply = release('v2.10.0', '');
  const tenth = await checkForUpdate({});
  suite.check('a double-digit minor is compared numerically',
    tenth.available === (compare('2.10.0', current) > 0), { latest: '2.10.0', current, got: tenth.available });

  githubReply = release('v2.9.0', '');
  const ninth = await checkForUpdate({});
  suite.check('and so is a single-digit one',
    ninth.available === (compare('2.9.0', current) > 0), { latest: '2.9.0', current, got: ninth.available });
  suite.check('2.10.0 and 2.9.0 do not sort alphabetically',
    compare('2.10.0', '2.9.0') > 0, 'string comparison would put 2.10.0 first');

  suite.check('a longer version string is handled', await isNewer('v99.0.0.1') === true);
  suite.check('a prerelease suffix does not confuse it', await isNewer('v99.0.0-beta.1') === true);
  suite.check('a missing tag is not an update', await isNewer('') === false);
  suite.check('a nonsense tag is not an update', await isNewer('vNext') === false);

  // ---------------------------------------------------------------------------
  suite.section('failure is silent');
  githubReply = { statusCode: 403, body: '' };
  suite.check('a rate limit is not an update', (await checkForUpdate({})).available === false);

  githubReply = { statusCode: 404, body: '' };
  suite.check('no releases yet is not an update', (await checkForUpdate({})).available === false);

  githubReply = { statusCode: 200, body: 'not json at all' };
  suite.check('a malformed body is not an update', (await checkForUpdate({})).available === false);

  githubReply = new Error('getaddrinfo ENOTFOUND api.github.com');
  const offline = await checkForUpdate({});
  suite.check('being offline is not an update', offline.available === false, offline);
  suite.check('and it never throws', typeof offline === 'object');

  // ---------------------------------------------------------------------------
  suite.section('only this project\'s release pages can be opened');
  opened.length = 0;

  const allowed = await openReleasePage({}, 'https://github.com/khaledk95/portus/releases/tag/v2.3.0');
  suite.check('a release URL opens', allowed.success === true && opened.length === 1, { allowed, opened });

  const blocked = [
    'https://evil.example.com/malware',
    'https://github.com/someone-else/portus/releases',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://github.com/khaledk95/portus/releases',
    ''
  ];

  for (const url of blocked) {
    opened.length = 0;
    const result = await openReleasePage({}, url);
    suite.check(`refused: ${url || '(empty)'}`,
      result.success === false && opened.length === 0, { result, opened });
  }

  opened.length = 0;
  suite.check('a non-string is refused too',
    (await openReleasePage({}, { toString: () => 'https://github.com/khaledk95/portus/releases' })).success === false
      && opened.length === 0);

  suite.done();
})();

// Mirrors the comparison being tested, so the expectation is not hand-computed
function compare(left, right) {
  const parts = value => String(value).replace(/^v/, '').split('-')[0].split('.').map(Number);
  const a = parts(left);
  const b = parts(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
