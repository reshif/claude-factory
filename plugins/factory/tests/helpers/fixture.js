'use strict';
// Test fixtures: a throwaway git repo with a tiny project, and helpers that drive the
// real CLI binary and play the parts agents and the human would play.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN = path.resolve(__dirname, '..', '..');
const BIN = path.join(PLUGIN, 'bin', 'factory');

function sh(cwd, cmd) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

function write(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
  sh(root, 'git init -q -b main && git config user.email t@example.com && git config user.name Tester && git config commit.gpgsign false');
  write(root, 'src/add.js', "module.exports = (a, b) => a - b; // bug: should add\n");
  write(root, 'tests/add.test.js', "const add = require('../src/add');\nif (add(2, 3) !== 5) { console.error('add(2,3) =', add(2, 3)); process.exit(1); }\nconsole.log('ok');\n");
  write(root, 'README.md', '# tiny\n');
  sh(root, 'git add -A && git commit -qm init');
  const out = cli(root, ['init']);
  if (out.error) throw new Error(JSON.stringify(out));
  return root;
}

function cli(root, args, { allowFail = true } = {}) {
  const r = spawnSync('node', [BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } });
  let json;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = { raw: r.stdout, stderr: r.stderr };
  }
  if (!allowFail && r.status !== 0) throw new Error(`factory ${args.join(' ')} failed: ${r.stdout}${r.stderr}`);
  return Object.assign(json, { __code: r.status });
}

function reply(root, text) {
  const human = require('../../cli/core/human');
  const parsed = human.parseReply(text);
  if (!parsed) throw new Error(`not a reply: ${text}`);
  return human.applyReply(root, parsed, 'chat');
}

const INTENT = [
  '- Problem: add(2, 3) returns -1, so totals built on it are wrong',
  '- Who: callers of src/add.js (the cart totals)',
  '- Outcome: add returns the arithmetic sum',
  '- Why now: a user reported a wrong total',
  '- Success signal: tests/add.test.js passes',
].join('\n');

// intent: null leaves the section out (a contract from before the Intent section).
function contractText({ goal = 'add(a, b) returns the sum of a and b for all numbers.', allowed = ['src/**', 'tests/**'], verify = '`node tests/add.test.js` (AC-1)', ac = '- AC-1: add(2, 3) returns 5 (evidence: test)', intent = INTENT } = {}) {
  return `# Fix add
${intent === null ? '' : `
## Intent
${intent}
`}
## Goal
${goal}

## Non-goals
- Changing the module's export shape

## Acceptance criteria
${ac}

## Constraints
- No new dependencies

## Allowed paths
${allowed.map((a) => `- ${a}`).join('\n')}

## Verify commands
- ${verify}

## Assumptions
- Node is available
`;
}

function envelope(brief, status, data, extra = {}) {
  return {
    workflow: brief.workflow,
    config: brief.config || null,
    mode: brief.mode || null,
    job: brief.job,
    status,
    next_gate: null,
    input_hash: brief.input_hash,
    budgets: { used: { agent_runs: 3 } },
    artifacts: [],
    questions: [],
    park_reason: null,
    summary: 'test',
    data,
    ...extra,
  };
}

function record(root, env) {
  const f = path.join(root, '.factory', 'scratch', `env-${Date.now()}-${Math.floor(performance.now())}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(env));
  return cli(root, ['record', '--file', f]);
}

function jobDir(root, id) {
  return path.join(root, '.factory', 'jobs', id);
}

module.exports = { PLUGIN, BIN, sh, write, makeRepo, cli, reply, contractText, envelope, record, jobDir };
