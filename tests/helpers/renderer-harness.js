// Boots the real src/index.html and src/renderer.js in jsdom with a stubbed
// electronAPI, and hands back the running Portus instance.
//
// The point is the same as the main-process harness: exercise the shipped code
// rather than a copy. Every renderer bug this project has had — a method called
// but never defined, a flag written at the wrong moment, an escape handler that
// bypassed its own cleanup — was in wiring that only exists once the class is
// actually constructed against the actual markup.
//
// jsdom rather than a real browser: no display needed, so it runs in CI the same
// way it runs locally.

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const APP_ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(APP_ROOT, 'src');

// One instance to work from, so a test can say "this profile is an Azure profile"
// without restating every field.
function profile(name, overrides = {}) {
  return {
    name,
    region: 'eu-central-1',
    source: 'config',
    provider: 'static',
    providerLabel: 'Access keys',
    canLogin: false,
    interactiveLogin: false,
    requiresMfa: false,
    ...overrides
  };
}

function instance(overrides = {}) {
  return {
    instanceName: 'bastion-01',
    instanceId: 'i-0abc123',
    instanceType: 't3.micro',
    state: 'running',
    privateIp: '10.0.1.10',
    platform: 'Linux',
    availabilityZone: 'eu-central-1a',
    vpcId: 'vpc-123',
    tags: [],
    ssmStatus: 'online',
    ssmLastPing: null,
    ssmAgentVersion: '3.2',
    ssmPlatformName: 'Amazon Linux',
    ...overrides
  };
}

/**
 * @param {object} options
 * @param {Array}  options.profiles      what get-profiles returns
 * @param {Array}  options.loginTargets  what get-login-targets returns
 * @param {Array}  options.instances     what get-ec2-instances returns
 * @param {Array}  options.endpoints     what get-endpoints returns
 * @param {Array}  options.tunnels       what list-tunnels returns
 * @param {object} options.update        what check-for-update returns
 * @param {object} options.overrides     replace any electronAPI method outright
 */
async function bootRenderer(options = {}) {
  const calls = {
    signIns: [],
    forwards: [],
    opened: [],
    mfaAnswers: [],
    endpointChecks: 0,
    updateChecks: 0,
    ssm: [],
    rdp: [],
    closedTunnels: []
  };

  const state = {
    profiles: options.profiles || [],
    loginTargets: options.loginTargets || [],
    instances: options.instances || [],
    endpoints: options.endpoints || [],
    tunnels: options.tunnels || [],
    update: options.update || { available: false },
    instancesResult: null,        // set to force a failure
    endpointsResult: null,
    signInError: null
  };

  // Callbacks the renderer registers, so a test can push an event at it the way
  // the main process would.
  const listeners = {};

  const api = {
    getAppVersion: async () => '2.3.3',
    checkRequiredTools: async () => ({ success: true, tools: [] }),

    getProfiles: async () => ({ success: true, data: state.profiles }),
    getLoginTargets: async () => ({ success: true, data: state.loginTargets }),

    signIn: async (name) => {
      calls.signIns.push(name);
      const target = state.loginTargets.find(t => t.profileName === name) || {};
      if (target.provider === 'sso' && listeners.sso) {
        listeners.sso({ profileName: name, code: 'QWER-TYUI' });
      }
      if (state.signInError) throw new Error(state.signInError);
      return { success: true, provider: target.provider, providerLabel: target.providerLabel };
    },
    onSsoVerification: (cb) => { listeners.sso = cb; return () => {}; },
    onMfaRequired: (cb) => { listeners.mfa = cb; return () => {}; },
    onMfaCancelled: (cb) => { listeners.mfaCancelled = cb; return () => {}; },
    submitMfaCode: async (id, code) => { calls.mfaAnswers.push({ id, code }); return { success: true }; },

    getSessionStatus: async () => ({ success: true, expiresInMs: 3600000 }),
    refreshSession: async () => ({ success: true }),

    getEc2Instances: async () => state.instancesResult || ({ success: true, data: state.instances }),
    getEndpoints: async () => {
      calls.endpointChecks += 1;
      return state.endpointsResult
        || ({ success: true, data: state.endpoints, region: 'eu-central-1', warnings: [] });
    },

    connectSSM: async (p, id) => { calls.ssm.push(id); return { success: true }; },
    connectRDPSSM: async (p, id) => { calls.rdp.push(id); return { success: true }; },
    startPortForward: async (p, id, name, opts) => {
      calls.forwards.push(opts);
      return { success: true, port: 50001, tunnelId: 't1' };
    },

    listTunnels: async () => state.tunnels,
    closeTunnel: async (id) => { calls.closedTunnels.push(id); return { success: true }; },
    onTunnelsChanged: (cb) => { listeners.tunnels = cb; return () => {}; },

    checkForUpdate: async () => { calls.updateChecks += 1; return state.update; },
    openReleasePage: async (url) => { calls.opened.push(url); return { success: true }; },

    ...(options.overrides || {})
  };

  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

  // runScripts lets the renderer run; external <script src> and <link href> are
  // not fetched, which is wanted — the CDN stylesheets are irrelevant here and
  // renderer.js is evaluated explicitly below, after the stub is in place.
  const dom = new JSDOM(html, {
    // An https origin, not file://. jsdom treats file:// as an opaque origin and
    // throws on localStorage, which the theme, the sidebar state and the release
    // notice all use.
    url: 'https://portus.test/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true
  });

  const { window } = dom;

  // jsdom has no layout, so scrolling an element into view is not implemented.
  // The combobox calls it whenever the highlighted option moves.
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};

  window.electronAPI = api;

  // Surfaces a renderer crash as a test failure instead of a silent no-op
  const errors = [];
  window.addEventListener('error', e => errors.push(e.error || e.message));
  window.addEventListener('unhandledrejection', e => errors.push(e.reason));

  window.eval(fs.readFileSync(path.join(SRC, 'renderer.js'), 'utf8'));

  // init() holds the splash for a fixed floor before finishing
  await waitFor(() => window.portus && !window.document.getElementById('splash'), window, 6000);

  return { dom, window, document: window.document, portus: window.portus, api, calls, state, listeners, errors };
}

// jsdom timers run on their own clock; polling is simpler than faking them and
// keeps the tests honest about the code's real async shape.
function waitFor(predicate, window, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let ready = false;
      try { ready = predicate(); } catch (error) { /* not yet */ }
      if (ready) { resolve(); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('timed out waiting for the renderer')); return; }
      window.setTimeout(tick, 10);
    };
    tick();
  });
}

const settle = (window, ms = 30) => new Promise(resolve => window.setTimeout(resolve, ms));

module.exports = { bootRenderer, waitFor, settle, profile, instance };
