// Electron gives every app a File / Edit / View / Window / Help menu. Portus has
// nothing to put in it, and on Windows and Linux it is drawn inside the window
// above the app's own top bar.
//
// It stays on macOS, where the menu lives in the system bar and Cmd+C, Cmd+V and
// Cmd+Q are routed through it — an app with no menu there loses copy, paste and
// quit. That asymmetry is easy to "tidy up" later without knowing why it exists,
// which is what this guards.

const path = require('path');
const Module = require('module');
const { pathToFileURL } = require('url');
const { createSuite } = require('./helpers/assert');

const APP_ROOT = path.join(__dirname, '..');
const suite = createSuite('Window chrome');

// Every BrowserWindow the stubbed electron hands out lands here, so the
// constructor options each load passed are inspectable after the fact.
const createdWindows = [];

// Every URL handed to the real browser instead of being opened in a window
const openedExternally = [];

// main.js reads process.platform at startup, so each platform needs its own load
function startOn(platform) {
  const menusSet = [];
  let readyCallback;

  const stubs = {
    electron: {
      app: {
        whenReady: () => ({ then: (fn) => { readyCallback = fn; } }),
        on: () => {},
        getVersion: () => '0.0.0',
        quit: () => {}
      },
      BrowserWindow: class {
        constructor(options) {
          this.options = options;
          createdWindows.push(this);
          this.navigationHandlers = [];
          this.windowOpenHandler = null;
          this.webContents = {
            setFrameRate() {},
            openDevTools() {},
            send() {},
            on: (event, handler) => {
              if (event === 'will-navigate') this.navigationHandlers.push(handler);
            },
            setWindowOpenHandler: (handler) => { this.windowOpenHandler = handler; }
          };
        }
        loadFile() {} once() {} on() {} show() {}
        isDestroyed() { return false; }
        static getAllWindows() { return []; }
      },
      ipcMain: { handle: () => {} },
      shell: { openExternal: url => openedExternally.push(url) },
      Menu: { setApplicationMenu: menu => menusSet.push(menu) }
    },
    'fs-extra': { pathExists: async () => false, readFile: async () => '' },
    child_process: { spawn: () => { throw new Error('unused'); }, spawnSync: () => ({ status: 0 }) },
    '@aws-sdk/credential-providers': { fromIni: () => async () => ({}) }
  };

  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    if (request.startsWith('@aws-sdk/')) {
      return new Proxy({}, { get: () => class { async send() { return {}; } } });
    }
    return realLoad.call(this, request, ...rest);
  };

  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  delete require.cache[require.resolve(path.join(APP_ROOT, 'src', 'main.js'))];
  require(path.join(APP_ROOT, 'src', 'main.js'));
  readyCallback();

  Object.defineProperty(process, 'platform', realPlatform);
  Module._load = realLoad;

  return menusSet;
}

suite.section('the default menu is removed only where it costs nothing');

const windows = startOn('win32');
suite.check('Windows clears the menu', windows.length === 1 && windows[0] === null, windows);

const linux = startOn('linux');
suite.check('Linux clears the menu', linux.length === 1 && linux[0] === null, linux);

const mac = startOn('darwin');
suite.check('macOS keeps it, so Cmd+C, Cmd+V and Cmd+Q still work',
  mac.length === 0, mac);

suite.section('the main window pins the renderer sandbox');

// Electron has sandboxed renderers by default since v20, but a default is not
// a posture: a future Electron default flip or an edited webPreferences
// literal could silently unsandbox the trusted window. The app states
// sandbox: true itself, next to its other explicit pins (nodeIntegration,
// contextIsolation). Every load above runs the same createWindow(), so all
// created windows testify.
const sandboxPins = createdWindows.map(
  window => window.options.webPreferences && window.options.webPreferences.sandbox
);
suite.check('webPreferences sets sandbox: true',
  createdWindows.length > 0 && sandboxPins.every(pin => pin === true),
  sandboxPins);

// ---------------------------------------------------------------------------
suite.section('the main window cannot be navigated off its own page');

// A main window that followed a link to a remote origin would take its preload
// bridge with it — every IPC channel, and the AWS access behind them.
const guarded = createdWindows[createdWindows.length - 1];
const pageUrl = pathToFileURL(path.join(APP_ROOT, 'src', 'index.html')).href;

suite.check('a will-navigate guard is registered',
  guarded.navigationHandlers.length === 1, guarded.navigationHandlers.length);

// Returns whether navigation to this URL was allowed through
const navigateTo = (url) => {
  let prevented = false;
  guarded.navigationHandlers[0]({ preventDefault: () => { prevented = true; } }, url);
  return !prevented;
};

for (const url of [
  'https://evil.example/',
  'http://169.254.169.254/latest/meta-data/',
  'file:///etc/passwd',
  'file:///C:/Windows/System32/drivers/etc/hosts',
  'data:text/html,<script>fetch("https://evil.example")</script>',
  'javascript:void(0)'
]) {
  suite.check(`refused: ${url.slice(0, 48)}`, navigateTo(url) === false);
}

suite.check('the app\'s own page is allowed', navigateTo(pageUrl) === true, pageUrl);

// The reason the comparison resolves paths instead of matching the href: an
// install path with spaces or non-ASCII characters, or a drive letter in the
// other case, percent-encodes differently depending on who produced the URL.
// An exact string match would refuse the page its own reload on exactly the
// installs that are hardest to debug.
const encodedVariants = [
  pageUrl.replace(/\//g, (match, offset) => (offset > 7 ? '/' : match)), // unchanged, sanity
  pageUrl.replace('index.html', 'index%2Ehtml')
];
if (process.platform === 'win32') {
  encodedVariants.push(pageUrl.replace(/^file:\/\/\/([a-zA-Z]):/, (m, d) => `file:///${d.toLowerCase()}:`));
  encodedVariants.push(pageUrl.replace(/^file:\/\/\/([a-zA-Z]):/, (m, d) => `file:///${d.toUpperCase()}:`));
}

for (const variant of encodedVariants) {
  suite.check(`  and still allowed when spelled: ${variant.slice(-38)}`,
    navigateTo(variant) === true, variant);
}

// ---------------------------------------------------------------------------
suite.section('nothing gets a second privileged window');

suite.check('a window open handler is registered',
  typeof guarded.windowOpenHandler === 'function');

openedExternally.length = 0;
suite.check('an http link is denied a window and handed to the browser',
  guarded.windowOpenHandler({ url: 'https://github.com/khaledk95/portus' }).action === 'deny'
    && openedExternally.length === 1);

openedExternally.length = 0;
suite.check('a file URL is denied a window and not handed anywhere',
  guarded.windowOpenHandler({ url: 'file:///etc/passwd' }).action === 'deny'
    && openedExternally.length === 0, openedExternally);

suite.done();
