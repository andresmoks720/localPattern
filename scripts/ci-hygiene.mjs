import { execSync } from 'node:child_process';

function run(command) {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const message = error.stderr?.toString().trim() || error.message;
    throw new Error(message);
  }
}

const onlyMatches = run("rg -n --hidden --glob '!node_modules/**' --glob '!*dist/**' '\\b(?:it|test|describe)\\.only\\s*\\(' . || true");
if (onlyMatches) {
  console.error('CI hygiene failure: found focused tests (test.only / it.only / describe.only).');
  console.error(onlyMatches);
  process.exit(1);
}

console.info('CI hygiene check passed: no focused tests found.');
