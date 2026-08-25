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
const { createSuite } = require('./helpers/assert');

const APP_ROOT = path.join(__dirname, '..');
const suite = createSuite('Window chrome');

// Every BrowserWindow the stubbed electron hands out lands here, so the
// constructor options each load passed are inspectable after the fact.
const createdWindows = [];

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
          this.webContents = { setFrameRate() {}, openDevTools() {}, send() {} };
        }
        loadFile() {} once() {} on() {} show() {}
        isDestroyed() { return false; }
        static getAllWindows() { return []; }
      },
      ipcMain: { handle: () => {} },
      shell: { openExternal: () => {} },
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

suite.done();
