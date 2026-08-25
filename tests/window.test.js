// Electron gives every app a File / Edit / View / Window / Help menu. Portus has
// nothing to put in it, and on Windows and Linux it is drawn inside the window
// above the app's own top bar.
//
// It stays on macOS, where the menu lives in the system bar and Cmd+C, Cmd+V and
// Cmd+Q are routed through it — an app with no menu there loses copy, paste and
// quit. That asymmetry is easy to "tidy up" later without knowing why it exists,
// which is what this guards.

const path = require('path');
const { pathToFileURL } = require('url');
const Module = require('module');
const { createSuite } = require('./helpers/assert');

const APP_ROOT = path.join(__dirname, '..');
const suite = createSuite('Window chrome');

// The window the most recent startOn() created, so checks below can reach the
// webContents handlers main.js registered on it.
const createdWindows = [];

// main.js reads process.platform at startup, so each platform needs its own load
function startOn(platform) {
  createdWindows.length = 0;

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
          this.events = {};               // webContents.on(channel, handler)
          this.windowOpenHandler = null;  // webContents.setWindowOpenHandler(fn)
          this.webContents = {
            setFrameRate() {},
            openDevTools() {},
            send() {},
            on: (channel, handler) => {
              (this.events[channel] = this.events[channel] || []).push(handler);
            },
            setWindowOpenHandler: (handler) => { this.windowOpenHandler = handler; }
          };
          createdWindows.push(this);
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

// The window shows Portus's own UI and nothing in it navigates anywhere — the
// only outbound links go through the validated open-release-page IPC. So the
// window may neither be pointed at another page (script running in the renderer
// is the attacker here) nor be used to open new ones.
suite.section('the window cannot be navigated or popped open to anywhere else');

startOn('linux');

const win = createdWindows[0];
const appUrl = pathToFileURL(path.join(APP_ROOT, 'src', 'index.html')).href;

const navigate = (url) => {
  let prevented = false;
  const handlers = (win && win.events['will-navigate']) || [];
  handlers.forEach(handler => handler({ preventDefault: () => { prevented = true; } }, url));
  return prevented;
};

suite.check('a will-navigate guard is registered on the main window',
  Boolean(win && win.events['will-navigate']),
  win ? Object.keys(win.events).join(', ') || 'no webContents handlers registered' : 'no window created');

suite.check('navigating anywhere but the app itself is stopped',
  navigate('https://evil.example') === true, 'https://evil.example');

suite.check('navigating to the app\'s own page is still allowed',
  navigate(appUrl) === false, appUrl);

const openResult = win && win.windowOpenHandler && win.windowOpenHandler({ url: 'https://evil.example' });
suite.check('script in the page cannot open new windows either',
  Boolean(openResult) && openResult.action === 'deny',
  openResult ? `action: ${openResult.action}` : 'no setWindowOpenHandler registered');

suite.done();
