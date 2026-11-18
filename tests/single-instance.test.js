// One Portus at a time, because two share a profile directory.
//
// Everything Electron keeps per app lives in one directory keyed by the app
// name: the Chromium caches, localStorage, the persisted Microsoft session. Two
// copies fight over the caches and disagree about anything in localStorage —
// which release you dismissed, when the update check last ran — with the last
// writer silently winning.
//
// A development run is exempt and given its own directory, so running a
// checkout beside the installed app neither disturbs its state nor reads its
// session. That exemption is the part most likely to be "tidied up" later by
// someone who sees two code paths and keeps one.

const path = require('path');
const Module = require('module');
const { createSuite } = require('./helpers/assert');

const APP_ROOT = path.join(__dirname, '..');
const suite = createSuite('Single instance');

// Loads main.js as a given invocation would: installed, or run from a checkout.
function load({ dev = false, lockGranted = true } = {}) {
  const record = {
    lockRequests: 0,
    quits: 0,
    paths: {},
    appHandlers: {},
    windowsCreated: 0
  };

  let readyCallback;

  const stubs = {
    electron: {
      app: {
        whenReady: () => ({ then: (fn) => { readyCallback = fn; } }),
        on: (event, handler) => { (record.appHandlers[event] = record.appHandlers[event] || []).push(handler); },
        getVersion: () => '0.0.0',
        getPath: (name) => record.paths[name] || `/portus-${name}`,
        setPath: (name, value) => { record.paths[name] = value; },
        requestSingleInstanceLock: () => { record.lockRequests += 1; return lockGranted; },
        quit: () => { record.quits += 1; }
      },
      BrowserWindow: class {
        constructor() {
          record.windowsCreated += 1;
          record.window = this;
          this.minimized = false;
          this.shown = 0;
          this.focused = 0;
          this.destroyed = false;
          this.webContents = {
            setFrameRate() {}, openDevTools() {}, send() {},
            on() {}, setWindowOpenHandler() {}
          };
        }
        loadFile() {} once() {} on() {}
        show() { this.shown += 1; }
        focus() { this.focused += 1; }
        isMinimized() { return this.minimized; }
        restore() { this.minimized = false; }
        isDestroyed() { return this.destroyed; }
        static getAllWindows() { return []; }
      },
      ipcMain: { handle: () => {} },
      shell: { openExternal: () => {} },
      Menu: { setApplicationMenu: () => {} },
      session: { fromPartition: () => ({ clearStorageData: async () => {}, webRequest: { onBeforeRequest: () => {} } }) }
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

  const realArgv = process.argv;
  process.argv = dev ? [...realArgv, '--dev'] : realArgv.filter(arg => arg !== '--dev');

  const realEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = dev ? 'development' : 'production';

  delete require.cache[require.resolve(path.join(APP_ROOT, 'src', 'main.js'))];
  require(path.join(APP_ROOT, 'src', 'main.js'));

  // A second instance stands down before the window is ever built
  if (readyCallback && !(record.quits && !dev)) readyCallback();

  process.argv = realArgv;
  process.env.NODE_ENV = realEnv;
  Module._load = realLoad;

  return record;
}

// ---------------------------------------------------------------------------
suite.section('an installed Portus takes the lock');

const first = load({ dev: false, lockGranted: true });

suite.check('the lock is asked for', first.lockRequests === 1, first.lockRequests);
suite.check('and holding it, the app carries on', first.quits === 0 && first.windowsCreated === 1,
  { quits: first.quits, windows: first.windowsCreated });
suite.check('the profile directory is left where it is',
  !first.paths.userData, first.paths);

// ---------------------------------------------------------------------------
suite.section('a second copy stands down and shows the first');

const second = load({ dev: false, lockGranted: false });

suite.check('it quits rather than running alongside', second.quits === 1, second.quits);
suite.check('and never opens a window to quit from',
  second.windowsCreated === 0, second.windowsCreated);
suite.check('no second-instance handler is registered by the one standing down',
  !second.appHandlers['second-instance'], Object.keys(second.appHandlers));

// The instance that holds the lock is the one that answers
const holder = load({ dev: false, lockGranted: true });
const onSecond = (holder.appHandlers['second-instance'] || [])[0];

suite.check('the holder listens for later launches', typeof onSecond === 'function');

holder.window.minimized = true;
onSecond();

suite.check('a later launch restores the window rather than opening another',
  holder.window.minimized === false && holder.windowsCreated === 1,
  { minimized: holder.window.minimized, windows: holder.windowsCreated });
suite.check('and brings it to the front',
  holder.window.shown >= 1 && holder.window.focused === 1,
  { shown: holder.window.shown, focused: holder.window.focused });

// Launching again after the window has gone must not throw
holder.window.destroyed = true;
let threw = false;
try { onSecond(); } catch (error) { threw = true; }
suite.check('a launch with no window left is survivable', !threw);

// ---------------------------------------------------------------------------
suite.section('a development run is exempt, and kept apart');
// Running a checkout beside the installed app is normal while working on it.
// Sharing the directory would mean test runs dismissing real release notices
// and reading the real Microsoft session.

const dev = load({ dev: true, lockGranted: true });

suite.check('it does not ask for the lock', dev.lockRequests === 0, dev.lockRequests);
suite.check('so it runs alongside an installed copy',
  dev.quits === 0 && dev.windowsCreated === 1, { quits: dev.quits, windows: dev.windowsCreated });
suite.check('and takes its own profile directory',
  dev.paths.userData === '/portus-userData-dev', dev.paths.userData);

suite.done();
