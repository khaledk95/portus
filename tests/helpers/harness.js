// Loads the real src/main.js with everything it touches outside the process
// replaced, and hands back the IPC handlers it registered.
//
// The point is to exercise the shipped code rather than a copy of it: the tests
// call the same handlers the renderer calls, so a change to main.js that breaks
// a contract fails here rather than in someone's app.
//
// Electron, fs-extra, child_process and the AWS SDK clients are swapped through
// Module._load before main.js is required. That is a blunt instrument, but it is
// process-wide and each suite runs in its own process, so nothing leaks between
// them.

const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

const APP_ROOT = path.join(__dirname, '..', '..');

// Paths are addressed by what follows ~/.aws, so a test writes
// { 'config': '…', 'sso/cache/abc.json': '…' } and never has to know the home
// directory of whoever is running it.
function awsRelative(filePath) {
  const normalised = String(filePath).replace(/\\/g, '/');
  const marker = normalised.indexOf('/.aws/');

  return marker === -1 ? normalised : normalised.slice(marker + '/.aws/'.length);
}

function inertClient() {
  return class { async send() { return {}; } };
}

function inertCommand() {
  return class { constructor(input) { this.input = input; } };
}

/**
 * @param {object} options
 * @param {object} options.files      ~/.aws contents, keyed by path below .aws
 * @param {function} options.onSpawn  ({ command, args }) => { stdout, stderr, exit, keepOpen }
 * @param {object} options.modules    extra module stubs, e.g. a fake RDS client
 */
function loadMain(options = {}) {
  const state = {
    files: options.files || {},
    spawns: [],          // every child process main.js tried to start
    sent: []             // every webContents.send, i.e. what reached the renderer
  };

  const handlers = new Map();

  const onSpawn = options.onSpawn || (() => ({ exit: 0 }));

  const stubs = {
    electron: {
      app: {
        whenReady: () => Promise.resolve(),
        on: () => {},
        getVersion: () => require(path.join(APP_ROOT, 'package.json')).version,
        quit: () => {}
      },
      BrowserWindow: class {
        constructor() {
          this.webContents = {
            setFrameRate() {},
            openDevTools() {},
            send: (channel, payload) => state.sent.push({ channel, payload })
          };
        }
        loadFile() {}
        once() {}
        on() {}
        show() {}
        isDestroyed() { return false; }
        static getAllWindows() { return []; }
      },
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }
    },

    'fs-extra': {
      pathExists: async (filePath) => {
        const key = awsRelative(filePath);
        if (Object.prototype.hasOwnProperty.call(state.files, key)) return true;

        // a directory exists when something lives under it
        return Object.keys(state.files).some(name => name.startsWith(`${key}/`));
      },
      readFile: async (filePath) => {
        const key = awsRelative(filePath);
        if (!Object.prototype.hasOwnProperty.call(state.files, key)) {
          throw Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
        }
        return state.files[key];
      },
      readdir: async (dirPath) => {
        const prefix = `${awsRelative(dirPath)}/`;
        return Object.keys(state.files)
          .filter(name => name.startsWith(prefix))
          .map(name => name.slice(prefix.length))
          .filter(name => !name.includes('/'));
      }
    },

    child_process: {
      spawn: (command, args) => {
        state.spawns.push({ command, args });

        const reply = onSpawn({ command, args }) || {};
        const proc = new EventEmitter();

        proc.pid = 4242;
        proc.exitCode = null;
        proc.signalCode = null;
        proc.stdout = new EventEmitter();
        proc.stderr = new EventEmitter();
        proc.stdin = { write() {}, end() {} };
        proc.kill = () => {};
        proc.unref = () => {};

        setImmediate(() => {
          if (reply.stdout) proc.stdout.emit('data', Buffer.from(reply.stdout));
          if (reply.stderr) proc.stderr.emit('data', Buffer.from(reply.stderr));
          // keepOpen models a tunnel: the listener reports itself up and stays up
          if (!reply.keepOpen) proc.emit('close', reply.exit === undefined ? 0 : reply.exit);
        });

        return proc;
      },
      spawnSync: () => ({ status: 0 })
    },

    '@aws-sdk/credential-providers': { fromIni: () => async () => ({}) },
    '@aws-sdk/client-ec2': { EC2Client: inertClient(), DescribeInstancesCommand: inertCommand() },
    '@aws-sdk/client-ssm': { SSMClient: inertClient(), DescribeInstanceInformationCommand: inertCommand() },
    '@aws-sdk/client-rds': {
      RDSClient: inertClient(),
      DescribeDBInstancesCommand: inertCommand(),
      DescribeDBClustersCommand: inertCommand()
    },
    '@aws-sdk/client-elasticache': {
      ElastiCacheClient: inertClient(),
      DescribeReplicationGroupsCommand: inertCommand(),
      DescribeCacheClustersCommand: inertCommand()
    },

    ...(options.modules || {})
  };

  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    return realLoad.call(this, request, ...rest);
  };

  require(path.join(APP_ROOT, 'src', 'main.js'));

  return {
    handlers,
    state,
    // main.js registers its handlers inside app.whenReady().then(), so nothing
    // exists until the microtask queue has drained once
    ready: () => new Promise(resolve => setImmediate(resolve))
  };
}

module.exports = { loadMain, APP_ROOT };
