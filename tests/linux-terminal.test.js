// On Linux there is no single terminal emulator to assume. The launcher names
// four (gnome-terminal, konsole, xterm, x-terminal-emulator) and the error string
// tells the user to install one of them — but it used to spawn the first name
// unconditionally, and since spawn does not fail synchronously for a missing
// binary, that "succeeded" on gnome-terminal even where only konsole or xterm was
// installed. These check that each candidate is resolved on PATH first, launched
// with the argument form it expects, and that a machine with none installed gets
// the failure rather than a silent no-op.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Linux terminal selection');

// Which emulators this scenario pretends are installed. isCommandAvailable probes
// with `sh -c "command -v <name>"`; the harness lets onSpawn set that probe's exit
// code, so membership here decides what is "on PATH".
let installed = new Set();

const onSpawn = ({ command, args }) => {
  if (command === 'sh' && args[0] === '-c' && String(args[1]).startsWith('command -v ')) {
    const binary = String(args[1]).slice('command -v '.length).trim();
    return { exit: installed.has(binary) ? 0 : 1 };
  }
  // the emulator launch itself — the harness emits 'spawn', so this resolves
  return { stdout: '', keepOpen: false };
};

const { handlers, state, ready } = loadMain({
  files: { config: '[profile demo]\nregion = eu-central-1\n' },
  onSpawn
});

// The launcher reads process.platform at call time, so pinning it here exercises
// the Linux branch on any host — the same technique azure-chain uses for its
// platform-specific sections.
const realPlatform = process.platform;
const asPlatform = value => Object.defineProperty(process, 'platform', { value });

// The emulator spawn is the last one that is not a `command -v` probe.
const lastLaunch = () => {
  for (let i = state.spawns.length - 1; i >= 0; i -= 1) {
    const spawned = state.spawns[i];
    if (!(spawned.command === 'sh' && String(spawned.args[1]).startsWith('command -v '))) {
      return spawned;
    }
  }
  return null;
};

(async () => {
  await ready();

  const connectSsm = handlers.get('connect-ssm');

  asPlatform('linux');

  // ---------------------------------------------------------------------------
  suite.section('the installed emulator is the one that launches');

  installed = new Set(['gnome-terminal']);
  state.spawns.length = 0;
  const gnome = await connectSsm({}, 'demo', 'i-0abc', 'eu-central-1');
  const gnomeLaunch = lastLaunch();
  suite.check('gnome-terminal is used when present, with its -- form',
    gnome.success === true
      && gnomeLaunch.command === 'gnome-terminal'
      && gnomeLaunch.args[0] === '--',
    gnomeLaunch && { command: gnomeLaunch.command, arg0: gnomeLaunch.args[0] });

  // Only konsole installed: the old code would have tried gnome-terminal anyway.
  installed = new Set(['konsole']);
  state.spawns.length = 0;
  const konsole = await connectSsm({}, 'demo', 'i-0abc', 'eu-central-1');
  const konsoleLaunch = lastLaunch();
  suite.check('konsole is used when it is the only one, with its -e form',
    konsole.success === true
      && konsoleLaunch.command === 'konsole'
      && konsoleLaunch.args[0] === '-e',
    konsoleLaunch && { command: konsoleLaunch.command, arg0: konsoleLaunch.args[0] });
  suite.check('gnome-terminal is never launched when it is not installed',
    !state.spawns.some(s => s.command === 'gnome-terminal'),
    state.spawns.map(s => s.command));

  // xterm only.
  installed = new Set(['xterm']);
  state.spawns.length = 0;
  const xterm = await connectSsm({}, 'demo', 'i-0abc', 'eu-central-1');
  const xtermLaunch = lastLaunch();
  suite.check('xterm is used when it is the only one, with its -e form',
    xterm.success === true
      && xtermLaunch.command === 'xterm'
      && xtermLaunch.args[0] === '-e',
    xtermLaunch && { command: xtermLaunch.command, arg0: xtermLaunch.args[0] });

  // ---------------------------------------------------------------------------
  suite.section('preference order holds when several are installed');

  installed = new Set(['gnome-terminal', 'konsole', 'xterm']);
  state.spawns.length = 0;
  await connectSsm({}, 'demo', 'i-0abc', 'eu-central-1');
  suite.check('gnome-terminal wins the tie',
    lastLaunch().command === 'gnome-terminal', lastLaunch().command);

  // ---------------------------------------------------------------------------
  suite.section('a machine with none installed fails instead of pretending');

  installed = new Set();
  state.spawns.length = 0;
  const none = await connectSsm({}, 'demo', 'i-0abc', 'eu-central-1');
  suite.check('the call reports failure',
    none.success === false, none);
  suite.check('the error names the emulators to install',
    /gnome-terminal|konsole|xterm/.test(none.error || ''), none.error);
  suite.check('nothing was launched — only the PATH probes ran',
    state.spawns.every(s => s.command === 'sh'), state.spawns.map(s => s.command));

  asPlatform(realPlatform);
  suite.done();
})();
