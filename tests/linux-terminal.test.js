// Linux has no terminal every distribution ships, so opening one is a search.
//
// The search used to be a list that was never walked: four terminals were named,
// `terminals[0]` was spawned, and the failure message told people to install one
// of the three the code would never try. These check that the list is real, that
// each terminal is handed its command the way it actually wants it, and that the
// probing happens once rather than on every launch.

const { loadMain } = require('./helpers/harness');
const { createSuite } = require('./helpers/assert');

const suite = createSuite('Linux terminal');

const CONFIG = { config: '[profile demo]\nregion = eu-central-1\n' };

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const asPlatform = (value) => Object.defineProperty(process, 'platform', { value, configurable: true });

// Opens an SSM shell on Linux with `missing` absent from the machine, and hands
// back the spawn that was not an availability probe.
async function openOn(missing) {
  const { handlers, state, ready } = loadMain({ files: CONFIG, missingCommands: missing });
  await ready();

  asPlatform('linux');
  const result = await handlers.get('connect-ssm')({}, 'demo', 'i-0abc', 'eu-central-1');
  asPlatform(realPlatform.value);

  const probes = state.spawns.filter(spawn => spawn.command === 'sh' || spawn.command === 'where');
  const launched = state.spawns.filter(spawn => spawn.command !== 'sh' && spawn.command !== 'where');

  return { result, probes, launched, state, handlers };
}

(async () => {
  // ---------------------------------------------------------------------------
  suite.section('the first terminal that answers is the one that opens');

  const gnome = await openOn([]);
  suite.check('gnome-terminal is preferred when it is there',
    gnome.launched.length === 1 && gnome.launched[0].command === 'gnome-terminal',
    gnome.launched.map(s => s.command));
  suite.check('and it gets its command after --, which is what it expects',
    gnome.launched[0].args[0] === '--' && gnome.launched[0].args[1] === 'bash',
    gnome.launched[0].args.join(' ').slice(0, 80));

  // ---------------------------------------------------------------------------
  suite.section('and the search really does continue past it');
  // This is the whole bug: every case below used to spawn gnome-terminal and
  // fail with ENOENT.

  const konsole = await openOn(['gnome-terminal']);
  suite.check('konsole is next',
    konsole.launched.length === 1 && konsole.launched[0].command === 'konsole',
    konsole.launched.map(s => s.command));
  suite.check('and takes -e, not --, so the command is not eaten as an option',
    konsole.launched[0].args[0] === '-e' && konsole.launched[0].args[1] === 'bash',
    konsole.launched[0].args.join(' ').slice(0, 80));

  const xterm = await openOn(['gnome-terminal', 'konsole']);
  suite.check('then xterm',
    xterm.launched.length === 1 && xterm.launched[0].command === 'xterm'
      && xterm.launched[0].args[0] === '-e',
    xterm.launched.map(s => s.command));

  const debian = await openOn(['gnome-terminal', 'konsole', 'xterm']);
  suite.check('and x-terminal-emulator last, so a real terminal wins on name first',
    debian.launched.length === 1 && debian.launched[0].command === 'x-terminal-emulator'
      && debian.launched[0].args[0] === '-e',
    debian.launched.map(s => s.command));

  // ---------------------------------------------------------------------------
  suite.section('a machine with none of them fails clearly');

  const none = await openOn(['gnome-terminal', 'konsole', 'xterm', 'x-terminal-emulator']);
  suite.check('nothing is spawned',
    none.launched.length === 0, none.launched.map(s => s.command));
  suite.check('and the error names what to install',
    none.result.success === false
      && /gnome-terminal/.test(none.result.error)
      && /konsole/.test(none.result.error)
      && /xterm/.test(none.result.error),
    none.result.error);

  // ---------------------------------------------------------------------------
  suite.section('the machine is asked once, not once per terminal launch');
  // Four `command -v` spawns on every shell the user opens is four processes
  // nobody is waiting for. windowsShell() memoises for the same reason.

  const repeat = await openOn([]);
  const probesAfterFirst = repeat.probes.length;

  repeat.state.spawns.length = 0;
  asPlatform('linux');
  await repeat.handlers.get('connect-ssm')({}, 'demo', 'i-0def', 'eu-central-1');
  await repeat.handlers.get('connect-ssm')({}, 'demo', 'i-0ghi', 'eu-central-1');
  asPlatform(realPlatform.value);

  const laterProbes = repeat.state.spawns.filter(spawn => spawn.command === 'sh');

  suite.check('the first launch probes',
    probesAfterFirst > 0, probesAfterFirst);
  suite.check('two more launches probe nothing',
    laterProbes.length === 0, laterProbes.map(s => (s.args || []).join(' ')));
  suite.check('and both still open a terminal',
    repeat.state.spawns.filter(s => s.command === 'gnome-terminal').length === 2,
    repeat.state.spawns.map(s => s.command));

  suite.done();
})();
