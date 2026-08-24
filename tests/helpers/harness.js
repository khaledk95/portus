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
    sent: [],            // every webContents.send, i.e. what reached the renderer
    opened: [],          // every URL handed to the operating system
    menusSet: [],        // every Menu.setApplicationMenu call
    partitions: [],      // every session partition asked for
    storageCleared: [],  // every partition whose storage was cleared
    sts: [],             // every STS call, in order
    tempDirs: [],        // every temp directory created
    written: [],         // every file written outside ~/.aws
    removed: [],         // every path removed
    dirs: [],            // every directory created
    appEvents: {}        // app.on handlers, so shutdown can be triggered
  };

  const handlers = new Map();

  const onSpawn = options.onSpawn || (() => ({ exit: 0 }));

  const stubs = {
    electron: {
      app: {
        whenReady: () => Promise.resolve(),
        // Captured so a test can fire shutdown and check what gets cleaned up
        on: (event, handler) => { (state.appEvents[event] = state.appEvents[event] || []).push(handler); },
        getVersion: () => require(path.join(APP_ROOT, 'package.json')).version,
        // Where the generated kubeconfigs live
        getPath: (name) => `/portus-${name}`,
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
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      shell: { openExternal: url => state.opened.push(url) },
      Menu: { setApplicationMenu: menu => state.menusSet.push(menu) },
      // The Azure sign-in opens a window in its own persisted partition
      session: {
        fromPartition: name => {
          state.partitions.push(name);
          return {
            webRequest: { onBeforeRequest: () => {} },
            clearStorageData: async () => { state.storageCleared.push(name); }
          };
        }
      }
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
      // The macOS SSM shell writes a short-lived credential script
      mkdtemp: async (prefix) => {
        const directory = `${prefix}test`;
        state.tempDirs.push(directory);
        return directory;
      },
      writeFile: async (filePath, contents, options) => {
        state.written.push({ path: filePath, contents, options });
      },
      remove: async (target) => { state.removed.push(target); },
      removeSync: (target) => { state.removed.push(target); },
      ensureDir: async (dir) => { state.dirs.push(dir); },
      readdir: async (dirPath) => {
        const prefix = `${awsRelative(dirPath)}/`;
        return Object.keys(state.files)
          .filter(name => name.startsWith(prefix))
          .map(name => name.slice(prefix.length))
          .filter(name => !name.includes('/'));
      }
    },

    child_process: {
      spawn: (command, args, options) => {
        // options matters: it carries the environment credentials are passed
        // through, and the shell:true that Windows quoting depends on
        state.spawns.push({ command, args, options });

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
          // Node emits this once the child is running. connect-ssm resolves on it,
          // so without it a terminal launch never returns.
          proc.emit('spawn');

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
    '@aws-sdk/client-sts': {
      STSClient: class {
        constructor(config) { this.config = config; }
        async send(command) {
          // Recorded so a test can assert what was assumed, in what order, and
          // with which credentials — which is the whole of an assume-role chain
          state.sts.push({
            command: command.constructor.name,
            input: command.input,
            credentials: this.config && this.config.credentials
          });

          return {
            Credentials: {
              AccessKeyId: 'ASIAFAKEFAKEFAKEFAKE',
              SecretAccessKey: 'fake-secret',
              SessionToken: `token-for-${(command.input.RoleArn || '').split('/').pop()}`,
              Expiration: new Date(Date.now() + 3600000)
            }
          };
        }
      },
      AssumeRoleWithSAMLCommand: class { constructor(input) { this.input = input; } },
      AssumeRoleCommand: class { constructor(input) { this.input = input; } }
    },
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
    '@aws-sdk/client-eks': {
      EKSClient: inertClient(),
      ListClustersCommand: inertCommand(),
      DescribeClusterCommand: inertCommand()
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
