// A pass/fail counter, deliberately smaller than a test framework.
//
// Everything here runs against the real main.js with module stubs installed
// process-wide, so each suite needs its own process anyway — which is what the
// runner gives it. A framework would add a dependency and buy nothing.

const GREEN = '[32m';
const RED = '[31m';
const DIM = '[2m';
const RESET = '[0m';

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (colour ? `${code}${text}${RESET}` : text);

function createSuite(title) {
  let passed = 0;
  const failures = [];

  console.log(`\n${title}`);

  return {
    section(name) {
      console.log(paint(DIM, `\n  ${name}`));
    },

    check(label, condition, detail) {
      if (condition) {
        passed += 1;
        console.log(`    ${paint(GREEN, 'PASS')}  ${label}`);
        return;
      }

      const shown = detail === undefined ? '' : `  -> ${
        typeof detail === 'string' ? detail : JSON.stringify(detail)
      }`;
      failures.push(`${label}${shown}`);
      console.log(`    ${paint(RED, 'FAIL')}  ${label}${shown}`);
    },

    // Exits non-zero on any failure so the runner and CI both notice
    done() {
      const total = passed + failures.length;
      console.log(`\n  ${passed}/${total} passed`);

      if (failures.length) {
        console.log(paint(RED, `  ${failures.length} failed:`));
        failures.forEach(failure => console.log(`    - ${failure}`));
      }

      process.exit(failures.length ? 1 : 0);
    }
  };
}

module.exports = { createSuite };
