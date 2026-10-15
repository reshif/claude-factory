'use strict';
// Phase 2 of the agent audit (builds that can actually work), and the two Phase 1 follow-ups:
// jobs that were mid-build when the factory was upgraded, and the human's way to settle a
// carried unverified finding. Each test pins one behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');

const core = (m) => require(`../cli/core/${m}`);
const stateOf = (root, J) => core('job').load(root, J);
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// clarify → H1 → ground; the plan is the test's.
function grounded(root, { risk = 'low' } = {}) {
  const J = F.cli(root, ['job', 'new', '--title', 'Two tasks', '--type', 'bug', '--risk', risk]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'x', source: 'src/add.js:1' }], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  return J;
}
function customPlan(root, J, plan) {
  F.cli(root, ['plan', 'from-contract']);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify(Array.isArray(plan) ? { tasks: plan } : plan));
  const v = F.cli(root, ['plan', 'validate', '--job', J]);
  assert.equal(v.valid, true, JSON.stringify(v));
  const b = core('invalidation').current(root, stateOf(root, J));
  core('ledger').append(root, J, { kind: 'step', step: 'decompose', ok: true, bound: { plan: b.plan, contract: b.contract }, detail: { source: 'test' } });
  return v;
}
const VC = [{ cmd: 'node tests/add.test.js', covers: ['AC-1'] }];
const T1 = { id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC };

// ------------------------------------------------------------------ upgrade: in-flight jobs

// A task started by 0.5.3: the state has attempts but neither a builder record nor the marker
// that this factory's `task start` writes.
function asIfStartedBefore(root, J, id) {
  const s = stateOf(root, J);
  const { builder_tracking: _t, builder: _b, ...rest } = s.tasks[id];
  s.tasks[id] = rest;
  core('job').save(root, s);
}

test('upgrade: a task started before builder replies were recorded verifies once, with an event, then needs a rebuild', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [T1]);
  const s = F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(s.worktree, 'git commit -qam fix');
  asIfStartedBefore(root, J, 'T1');
  const v = F.cli(root, ['task', 'verify', 'T1', '--job', J]);
  assert.equal(v.pass, true, JSON.stringify(v));
  assert.match(v.legacy, /without a builder record/);
  const ev = events(root).filter((e) => e.event === 'legacy_verify');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].task, 'T1');
  const ctx = core('steps').context(root, stateOf(root, J), core('job').load);
  assert.equal(core('steps').taskDone(ctx, 'T1'), true, 'the legacy pass counts');
  // once: a second verify of the same attempt is refused
  const again = F.cli(root, ['task', 'verify', 'T1', '--job', J]);
  assert.equal(again.code, 'no_builder_result');
  assert.match(again.message, /one verification without a builder record/);
  // a task this factory started is never legacy
  F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  assert.equal(stateOf(root, J).tasks.T1.builder_tracking, 1);
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).code, 'no_builder_result');
});

test('upgrade: a task this factory started without a builder reply is not legacy', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [T1]);
  const s = F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(s.worktree, 'git commit -qam fix');
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).code, 'no_builder_result');
  assert.equal(events(root).filter((e) => e.event === 'legacy_verify').length, 0);
});

// ------------------------------------------------------------------ settling a carried finding

// bug@low up to a passing proof, the builder's reply recorded.
function toProve(root) {
  const J = grounded(root);
  F.cli(root, ['plan', 'from-contract']);
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'realize']);
  const s = F.cli(root, ['task', 'start', 'T1']);
  F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(s.worktree, 'git commit -qam fix');
  F.built(root, 'T1');
  F.cli(root, ['task', 'verify', 'T1']);
  F.record(root, F.envelope(b, 'ok', { tasks: [{ id: 'T1', outcome: 'done', attempts: 1 }] }));
  F.cli(root, ['next']);
  const rb = F.cli(root, ['wfargs', 'reconcile']);
  F.cli(root, ['reconcile', 'run']);
  F.record(root, F.envelope(rb, 'ok', { integrator: { status: 'merged', summary: '' } }));
  F.cli(root, ['verify', 'run']);
  return J;
}

test('finding accept|dismiss: the human settles a carried unverified finding, by chat or terminal, with a reason; ship then passes and the report lists it', () => {
  const root = F.makeRepo();
  const J = toProve(root);
  const n = F.cli(root, ['next']);
  assert.equal(n.config, 'challenge', JSON.stringify(n));
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  const lanes = [{ lane: 'code', findings: [{ id: 'code-1', severity: 'major', file: 'src/add.js', line: 1, summary: 'non-numbers are not rejected' }, { id: 'code-2', severity: 'blocker', file: 'src/add.js', line: 1, summary: 'NaN slips through' }] }];
  const rec = F.record(root, F.envelope(b, 'ok', { degraded: [], verifications: [], lanes }, { fingerprint: b.fingerprint }));
  assert.deepEqual(rec.unverified, ['code-1', 'code-2']);
  assert.equal(F.cli(root, ['ship', '--local']).code, 'floor');
  // an agent can't; a chat reply without a reason is refused
  const agent = F.cli(root, ['finding', 'dismiss', 'code-1', '--reason', 'x']);
  assert.equal(agent.code, 'human_only', JSON.stringify(agent));
  const guard = require('../hooks/guard-rules');
  assert.match(String(guard.checkBash(root, 'factory finding dismiss code-1 --reason nah') || ''), /human-only/);
  assert.equal(require('../cli/core/human').parseReply('dismiss finding code-1').reason, '');
  // the reply goes through the real prompt hook, as the user's chat message does
  const say = (text) => F.say(root, text);
  let last = say('dismiss finding code-1');
  assert.equal(last.status, 'refused');
  assert.equal(last.code, 'needs_reason');
  // chat: dismissed with a reason
  last = say('dismiss finding code-1 add() is only called with numbers by the CLI parser');
  assert.equal(last.status, 'applied', JSON.stringify(last));
  assert.equal(F.cli(root, ['ship', '--local']).code, 'floor', 'code-2 is still open');
  // terminal: accepted, typed code required
  const human = require('../cli/core/human');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !human.AGENT_ENV.some(([a]) => a === k)));
  const term = (args, input) => JSON.parse(require('child_process').spawnSync('node', [F.BIN, ...args], { cwd: root, encoding: 'utf8', env: { ...clean, FACTORY_ROOT: '', NODE_ENV: 'test', FACTORY_TEST_HUMAN: human.testToken(), FACTORY_TEST_HUMAN_INPUT: input } }).stdout);
  assert.equal(term(['finding', 'accept', 'code-2', '--reason', 'known; tracked in issue 12'], 'WRONG').code, 'not_confirmed');
  const ok = term(['finding', 'accept', 'code-2', '--reason', 'known; tracked in issue 12'], '{code}');
  assert.equal(ok.status, 'accepted', JSON.stringify(ok));
  assert.deepEqual(ok.still_open, []);
  assert.equal(term(['finding', 'accept', 'code-2', '--reason', 'again'], '{code}').code, 'bad_input', 'only an open finding can be settled');
  // settled: ledger entries, the review record passes, ship goes through, the report says so
  const settled = core('ledger').all(root, J).filter((e) => e.kind === 'finding');
  assert.deepEqual(settled.map((e) => [e.finding, e.decision, e.channel]), [['code-1', 'dismissed', 'chat'], ['code-2', 'accepted', 'tty']]);
  const ch = core('ledger').lastStep(root, J, 'challenge');
  assert.equal(ch.ok, true);
  assert.equal(ch.detail.lanes.code, 'pass');
  assert.equal(F.cli(root, ['next']).skill, 'ship');
  const report = fs.readFileSync(F.cli(root, ['report']).report, 'utf8');
  assert.match(report, /Unverified findings dismissed by you: 1 \(code-1 \[major\].*add\(\) is only called with numbers/);
  assert.match(report, /Unverified findings accepted by you \(known risk, shipped\): 1 \(code-2 \[blocker\].*issue 12/);
  assert.match(report, /Unverified serious review findings \(they block ship\): 0/);
  const shipped = F.cli(root, ['ship', '--local']);
  assert.ok(!shipped.error, JSON.stringify(shipped));
});

test('finding accept|dismiss: a finding the human dismissed stays settled when a later round raises it again', () => {
  const root = F.makeRepo();
  const J = toProve(root);
  F.cli(root, ['next']);
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  const finding = { id: 'code-1', severity: 'major', file: 'src/add.js', line: 1, summary: 'non-numbers are not rejected' };
  F.record(root, F.envelope(b, 'ok', { degraded: [], verifications: [], lanes: [{ lane: 'code', findings: [finding] }] }, { fingerprint: b.fingerprint }));
  F.reply(root, 'dismiss finding code-1 numbers only, by design');
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  const rec = F.record(root, F.envelope(b, 'ok', { degraded: [], verifications: [], lanes: [{ lane: 'code', findings: [finding] }] }, { fingerprint: b.fingerprint }));
  assert.equal(rec.status, 'ok', JSON.stringify(rec));
  const f = core('ledger').lastStep(root, J, 'challenge').detail.findings[0];
  assert.equal(f.status, 'dismissed');
});

// ------------------------------------------------------------------ P2.5 deterministic tester
// Adapted: a Workflow tool script cannot run a command, so the tester agent stays, as a messenger:
// it runs `task verify` and relays it. The CLI decides: record trusts only the evidence task verify
// wrote into the job state, never the relayed `pass`.

const H = require('./helpers/workflow-harness');
const REALIZE = path.join(F.PLUGIN, 'workflows', 'realize.js');
function realizeBrief(tasks = { T1: {} }, extra = {}) {
  const t = {};
  for (const [id, o] of Object.entries(tasks)) {
    t[id] = { id, depends_on: o.depends_on || [], retry_limit: o.retry_limit || 3, builder: { agent_type: 'factory:builder', escalate: [] }, tester: { agent_type: 'factory:tester' }, builder_prompt: `build ${id} attempt {{attempt}}\n{{failures}}`, tester_prompt: `test ${id} {{swept}}` };
  }
  return { workflow: 'realize', job: 'J-0001', scope: 'all', input_hash: 'h', waves: [Object.keys(tasks)], tasks: t, max_parallel_tasks: 4, builder_schema: {}, tester_schema: {}, ...extra };
}

test('P2.5: the tester only relays task verify; a relayed pass the evidence does not back is not done at record', async () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [T1]);
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'realize'], { allowFail: false });
  // the builder commits a change that fails its verify command; the tester claims a pass anyway
  const { result } = await H.run(REALIZE, JSON.stringify(b), (prompt, opts) => {
    if (opts.agentType === 'factory:builder') {
      const s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
      F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a * b; // still wrong\n');
      F.sh(s.worktree, 'git commit -qam "multiply"');
      return { status: 'done', summary: 'built', commits: ['x'], swept: [] };
    }
    const v = F.cli(root, ['task', 'verify', 'T1']);
    assert.equal(v.pass, false, 'task verify itself fails');
    return { pass: true, evidence_id: v.evidence_id, failures: [] };
  });
  assert.equal(result.data.tasks[0].outcome, 'done', 'the workflow believed the messenger');
  const rec = F.record(root, result);
  assert.equal(rec.status, 'park', JSON.stringify(rec));
  assert.equal(rec.tasks[0].outcome, 'not_verified', 'record trusts task verify\'s evidence, not the relay');
  assert.deepEqual(rec.relay_mismatches, [{ task: 'T1', relayed: true, evidence: false, evidence_id: core('job').load(root, J).tasks.T1.evidence.id }]);
});

test('P2.5: a verify refusal is the next attempt\'s input, word for word', async () => {
  const { calls } = await H.run(REALIZE, realizeBrief({ T1: { retry_limit: 2 } }), (prompt, opts) => (opts.agentType === 'factory:builder'
    ? { status: 'done', summary: 'built', swept: [] }
    : { pass: false, refused: 'dirty_worktree', failures: ['T1 has uncommitted changes. Commit them on the task branch first:\n M src/add.js'] }));
  const second = calls.filter((c) => c.opts.agentType === 'factory:builder')[1];
  assert.match(second.prompt, /task verify refused \(dirty_worktree\): T1 has uncommitted changes[\s\S]*M src\/add.js/);
});

test('P2.5: a tester that returns nothing is asked once more; task verify, not the tester, has the last word', async () => {
  let n = 0;
  const { result, calls } = await H.run(REALIZE, realizeBrief(), (prompt, opts) => {
    if (opts.agentType === 'factory:builder') return { status: 'done', summary: 'built', swept: [] };
    n += 1;
    return n === 1 ? null : { pass: true, evidence_id: 'T1-1-1', failures: [] };
  });
  assert.deepEqual(calls.filter((c) => c.opts.agentType === 'factory:tester').map((c) => c.opts.label), ['test T1', 'test T1 (retry)']);
  assert.equal(result.data.tasks[0].outcome, 'done');
  assert.deepEqual(result.data.verifications, [{ task: 'T1', attempt: 1, pass: true, evidence_id: 'T1-1-1' }]);
});

// ------------------------------------------------------------------ P2.4 retries continue
// Adapted: Claude Code's Workflow tool cannot resume a previous subagent, and sets no agent time
// cap. So the retry builder gets the previous attempt from the CLI instead (its reply, task
// verify's raw output, its diff), and what an attempt left uncommitted is kept as a `wip:` commit.

test('P2.4: a stopped attempt\'s uncommitted work becomes a wip: commit; the next builder gets its reply, raw verify output and diff; a later realize run continues the numbering', async () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [T1]);
  F.cli(root, ['next']);
  // attempt 1: commits a half fix that fails verify
  let s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
  F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a * b; // half way\n');
  F.sh(s.worktree, 'git commit -qam "half"');
  F.built(root, 'T1');
  const v = F.cli(root, ['task', 'verify', 'T1']);
  assert.equal(v.pass, false);
  // attempt 2: starts, edits, and stops without committing or replying (crashed, out of time)
  s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
  F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b; // fixed, never committed\n');
  // a later realize run: the brief continues at attempt 3 with what attempt 2 left
  let b = F.cli(root, ['wfargs', 'realize'], { allowFail: false });
  assert.equal(b.tasks.T1.attempt_base, 2);
  assert.match(b.tasks.T1.previous_failures.join('\n'), /Attempt 2: the builder never recorded a reply/);
  // its task start keeps the uncommitted work as wip: on the branch
  s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
  assert.equal(s.attempt, 3);
  assert.match(F.sh(s.worktree, 'git log -1 --format=%s'), /^wip: T1 attempt 2 /);
  assert.match(fs.readFileSync(path.join(s.worktree, 'src/add.js'), 'utf8'), /a \+ b/, 'nothing was lost');
  const show = F.cli(root, ['task', 'show', 'T1']);
  assert.deepEqual(show.history.map((h) => h.attempt), [1, 2, 3]);
  assert.equal(show.history[0].verify.pass, false);
  assert.match(show.history[0].verify.failures[0].tail, /add\(2,3\) =/, 'task verify\'s raw output');
  assert.ok(show.history[1].wip_commit);
  assert.equal(show.previous_attempt.attempt, 2);
  assert.match(show.previous_attempt.diff.patch, /\+module\.exports = \(a, b\) => a \+ b;/, 'the previous attempt\'s change');
  // a refusal is history too, word for word (the main session's CLI path records it)
  const r = F.cli(root, ['task', 'verify', 'T1']);
  assert.equal(r.code, 'no_builder_result');
  const h = core('job').load(root, J).tasks.T1.history.pop();
  assert.equal(h.verify.refused, 'no_builder_result');
  b = F.cli(root, ['wfargs', 'realize'], { allowFail: false });
  assert.match(b.tasks.T1.previous_failures.join('\n'), /Attempt 3: task verify refused \(no_builder_result\)/);
  // the workflow numbers its builds from there
  const { calls } = await H.run(REALIZE, JSON.stringify(b), (prompt, opts) => (opts.agentType === 'factory:builder' ? null : { pass: true, failures: [] }));
  assert.equal(calls[0].opts.label, 'build T1 #4');
  assert.match(calls[0].prompt, /Attempt 4\./);
  assert.match(calls[0].prompt, /Attempt 3: task verify refused \(no_builder_result\)/);
  assert.match(fs.readFileSync(b.tasks.T1.builder_prompt.split('\n').find((l) => l.trim().startsWith('/')).trim(), 'utf8'), /Time: about 30 minutes[\s\S]*wip: /, 'the brief gives the time budget and the wip rule');
});

// ------------------------------------------------------------------ P2.2 task packet

test('P2.2: task show returns the task packet: ADR Decision and diagram, this task\'s criterion rows, findings on its paths, interfaces, siblings', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  const jd = F.jobDir(root, J);
  // a two-criterion contract, an ADR and findings, as decide and ground leave them
  fs.writeFileSync(path.join(jd, 'contract.md'), F.contractText({ ac: '- AC-1: add(2, 3) returns 5 (evidence: test)\n- AC-2: sub(5, 3) returns 2 (evidence: test)' }));
  fs.writeFileSync(path.join(jd, 'adr-001-fix.md'), F.adrText({ job: J, acs: ['AC-1', 'AC-2'], decision: 'We will fix add in src/add.js and add sub in src/sub.js; src/index.js re-exports both.' }));
  fs.writeFileSync(path.join(jd, 'findings.md'), '# Findings\n\n## Topics\n\n### codebase\n- add subtracts — `src/add.js:1`\n- the CLI calls sub from src/sub.js — `src/cli.js:4`\n- nothing tests the README — **UNVERIFIED**\n');
  const plan = {
    interfaces: [{ name: 'add(a, b)', kind: 'function', file: 'src/add.js', owner: 'T1' }, { name: 'sub(a, b)', kind: 'function', file: 'src/sub.js', owner: 'T2' }],
    tasks: [
      { id: 'T1', objective: 'Fix add (ADR 001 Decision)', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: VC },
      { id: 'T2', objective: 'Add sub', allowed_paths: ['src/sub.js'], depends_on: [], criteria_ids: ['AC-2'], verify_commands: [{ cmd: 'true', covers: ['AC-2'] }], consumes: ['add(a, b)'] },
    ],
  };
  customPlan(root, J, plan);
  const show = F.cli(root, ['task', 'show', 'T1', '--job', J]);
  const p = show.packet;
  assert.ok(p, JSON.stringify(show).slice(0, 500));
  assert.equal(p.adr, `.factory/jobs/${J}/adr-001-fix.md`);
  assert.match(p.decision, /src\/index\.js re-exports both/);
  assert.match(p.diagram, /^```mermaid\nflowchart/);
  assert.deepEqual(p.criteria_rows.map((r) => r.ac), ['AC-1'], 'only this task\'s rows of "How each acceptance criterion is met"');
  assert.deepEqual(p.findings.map((f) => f.source), ['src/add.js:1'], 'only the findings on this task\'s paths');
  assert.deepEqual(p.interfaces.owns.map((i) => [i.name, i.consumers]), [['add(a, b)', ['T2']]]);
  assert.deepEqual(p.interfaces.consumes, []);
  assert.deepEqual(p.siblings.map((t) => [t.id, t.objective, t.consumes]), [['T2', 'Add sub', ['add(a, b)']]]);
  const p2 = F.cli(root, ['task', 'show', 'T2', '--job', J]).packet;
  assert.deepEqual(p2.interfaces.consumes.map((i) => [i.name, i.owner, i.file]), [['add(a, b)', 'T1', 'src/add.js']]);
  // the builder brief points at it
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'realize']);
  const brief = fs.readFileSync(b.tasks.T1.builder_prompt.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/')), 'utf8');
  assert.match(brief, /its `packet` is your part of the approved design: the ADR's Decision and diagram/);
});

test('P2.2: every review lane gets the design record and the plan; the code lane checks design conformance', () => {
  const root = F.makeRepo();
  const J = toProve(root);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'adr-001-fix.md'), F.adrText({ job: J }));
  // the ADR is a design input after the fact here; the review brief names whatever is recorded
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  for (const lane of b.fanout) {
    const text = fs.readFileSync(lane.prompt.split('\n').map((l) => l.trim()).find((l) => l.startsWith('/')), 'utf8');
    assert.match(text, /Design record \(approved at H2\): .*adr-001-fix\.md — its Decision and Architecture diagram/, lane.id);
    assert.match(text, /Plan \(approved at H3\): .*plan\.json/, lane.id);
  }
  const body = fs.readFileSync(path.join(F.PLUGIN, 'agents', 'code-reviewer.md'), 'utf8');
  assert.match(body, /Design conformance:[\s\S]*implements the Decision[\s\S]*"design:<what departs>"/);
});

// ------------------------------------------------------------------ P2.3 interfaces, per-wave integration

test('P2.3: plan validate checks interfaces, adds producer→consumer dependencies and shows who consumes what', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  F.cli(root, ['plan', 'from-contract']);
  const tasks = [
    { id: 'T1', objective: 'add', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T2', objective: 'sub', allowed_paths: ['src/sub.js'], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T3', objective: 'index re-exports add and sub', allowed_paths: ['src/index.js'], criteria_ids: ['AC-1'], verify_commands: VC, consumes: ['add(a, b)', 'sub(a, b)'] },
  ];
  const write = (plan) => fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify(plan));
  // the audit's handoff exp: T3 imports T1 and T2 with no depends_on. Undeclared: one wave.
  write({ tasks: tasks.map(({ consumes: _c, ...t }) => t) });
  assert.deepEqual(F.cli(root, ['plan', 'validate', '--job', J]).waves, [['T1', 'T2', 'T3']]);
  // consumed but produced by no task: an error
  write({ interfaces: [{ name: 'add(a, b)', kind: 'function', file: 'src/add.js', owner: 'T1' }], tasks });
  let v = F.cli(root, ['plan', 'validate', '--job', J]);
  assert.equal(v.valid, false);
  assert.match(v.errors.join('\n'), /T3 consumes "sub\(a, b\)", but no task produces it/);
  // an interface outside its owner's paths, or owned by nobody: errors
  write({ interfaces: [{ name: 'add(a, b)', file: 'src/sub.js', owner: 'T1' }, { name: 'sub(a, b)', file: 'src/sub.js', owner: 'T9' }], tasks });
  v = F.cli(root, ['plan', 'validate', '--job', J]);
  assert.match(v.errors.join('\n'), /"add\(a, b\)" lives in src\/sub\.js, outside its owner T1's allowed paths/);
  assert.match(v.errors.join('\n'), /"sub\(a, b\)" is owned by unknown task T9/);
  // declared: T3 waits for both producers, and the H3 view gets the table
  write({ interfaces: [{ name: 'add(a, b)', kind: 'function', file: 'src/add.js', owner: 'T1' }, { name: 'sub(a, b)', kind: 'function', file: 'src/sub.js', owner: 'T2' }], tasks });
  v = F.cli(root, ['plan', 'validate', '--job', J]);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.deepEqual(v.waves, [['T1', 'T2'], ['T3']]);
  assert.deepEqual(v.interfaces.map((i) => [i.name, i.owner, i.consumers]), [['add(a, b)', 'T1', ['T3']], ['sub(a, b)', 'T2', ['T3']]]);
  assert.deepEqual(v.implied_dependencies, [{ task: 'T3', on: 'T1', via: 'add(a, b)' }, { task: 'T3', on: 'T2', via: 'sub(a, b)' }]);
  assert.deepEqual(core('plan').effectiveDeps(tasks, 'T3', JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'plan.json'), 'utf8')).interfaces).sort(), ['T1', 'T2']);
  const b = core('invalidation').current(root, stateOf(root, J));
  core('ledger').append(root, J, { kind: 'step', step: 'decompose', ok: true, bound: { plan: b.plan, contract: b.contract }, detail: { source: 'test' } });
  const r = F.cli(root, ['task', 'start', 'T3', '--job', J]);
  assert.equal(r.code, 'dependency_not_done');
  assert.match(r.message, /T3 depends on T1 \(it produces "add\(a, b\)", which T3 consumes\)/);
  // the schema file mirrors the validator's
  const { $comment: _c, ...file } = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'plan.json'), 'utf8'));
  assert.deepEqual(file, JSON.parse(JSON.stringify(core('plan').TASK_SCHEMA)));
});

test('P2.3: each wave is integrated and checked on the job branch; a same-wave break (exp2) goes back to the task whose file broke, with the raw output; the next wave starts from the integrated branch', async () => {
  const root = F.makeRepo();
  F.write(root, 'src/slug.js', "module.exports = { slugify: (s) => s.split(' ').join('-') };\n");
  F.write(root, 'tests/slug.test.js', "const s = require('../src/slug');\nif (s.slugify('a b') !== 'a-b') process.exit(1);\n");
  F.sh(root, 'git add -A && git commit -qm slug');
  const J = F.cli(root, ['job', 'new', '--title', 'Rename slug', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ goal: 'make_slug replaces slugify; report titles use it.', verify: '`node tests/slug.test.js` (AC-1)', ac: '- AC-1: make_slug("a b") returns "a-b" (evidence: test)' }));
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [], unknowns: [] }], degraded: [] }));
  F.cli(root, ['next']);
  // the planner forgot that T2 calls T1's function: same wave, disjoint paths
  customPlan(root, J, [
    { id: 'T1', objective: 'rename slugify to make_slug', allowed_paths: ['src/slug.js', 'tests/slug.test.js'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/slug.test.js', covers: ['AC-1'] }] },
    { id: 'T2', objective: 'report titles', allowed_paths: ['src/report.js', 'tests/report.test.js'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/report.test.js', covers: ['AC-1'] }] },
    { id: 'T3', objective: 'cli prints a report title', allowed_paths: ['src/cli.js'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: "node -e \"require('./src/cli')\"", covers: ['AC-1'] }] },
  ]);
  assert.equal(F.cli(root, ['next']).workflow, 'realize');
  const brief = F.cli(root, ['wfargs', 'realize']);
  assert.equal(brief.integrate_each_wave, true);
  const H = require('./helpers/workflow-harness');
  const seenByT3 = {};
  let t2Show = null;
  const { result, calls } = await H.run(path.join(F.PLUGIN, 'workflows', 'realize.js'), brief, (prompt, opts) => {
    // the tester and the integrator relay the CLI's task verify and reconcile wave
    if (opts.agentType === 'factory:tester') {
      const v = F.cli(root, ['task', 'verify', /^test (T\d+)/.exec(opts.label)[1], '--job', J]);
      return { pass: v.pass, evidence_id: v.evidence_id, failures: (v.failures || []).map((f) => `\`${f.cmd}\` exited ${f.code}`) };
    }
    if (opts.agentType === 'factory:integrator') return F.relayWave(root, prompt);
    const id = /^build (T\d+)/.exec(opts.label)[1];
    if (id === 'T2' && /#2$/.test(opts.label)) t2Show = F.cli(root, ['task', 'show', 'T2', '--job', J]);
    const s = F.cli(root, ['task', 'start', id, '--job', J], { allowFail: false });
    const wt = s.worktree;
    if (id === 'T1') {
      F.write(wt, 'src/slug.js', "module.exports = { make_slug: (s) => s.split(' ').join('-') };\n");
      F.write(wt, 'tests/slug.test.js', "const s = require('../src/slug');\nif (s.make_slug('a b') !== 'a-b') process.exit(1);\n");
    }
    if (id === 'T2') {
      const has = fs.readFileSync(path.join(wt, 'src/slug.js'), 'utf8').includes('make_slug');
      F.write(wt, 'src/report.js', `const s = require('./slug');\nmodule.exports = { title: (t) => s.${has ? 'make_slug' : 'slugify'}(t) };\n`);
      F.write(wt, 'tests/report.test.js', "const r = require('../src/report');\nif (r.title('a b') !== 'a-b') process.exit(1);\n");
    }
    if (id === 'T3') {
      seenByT3.report = fs.existsSync(path.join(wt, 'src/report.js'));
      F.write(wt, 'src/cli.js', "module.exports = require('./report');\n");
    }
    F.sh(wt, `git add -A && git commit -qm "${opts.label}"`);
    return { status: 'done', summary: opts.label, swept: [] };
  });
  assert.equal(result.status, 'ok', JSON.stringify(result.data));
  assert.deepEqual(result.data.integrations.map((x) => [x.wave, x.ok, x.route]), [[1, false, ['T2']], [1, true, []], [2, true, []]]);
  const t2 = calls.filter((c) => /^build T2/.test(c.opts.label));
  assert.equal(t2.length, 2, 'T2 rebuilt once, on the integrated branch');
  assert.match(t2[1].prompt, /the integrated build failed after wave 1 \(`node tests\/report\.test\.js` exited 1\)[\s\S]*integration_failures/);
  // the raw output reaches the rebuilt task through task show (the CLI wrote it; the relay names the task)
  assert.equal(t2Show.integration_failures[0].cmd, 'node tests/report.test.js');
  assert.match(t2Show.integration_failures[0].output, /slugify is not a function/);
  assert.equal(seenByT3.report, true, 'wave 2 started from the integrated branch (T2\'s work, though T3 does not depend on T2)');
  // the job branch holds every task; reconcile is recorded, so no integrator is needed
  const st = stateOf(root, J);
  assert.ok(F.sh(root, `git show ${st.branch}:src/report.js`).includes('make_slug'));
  assert.equal(core('ledger').lastStep(root, J, 'reconcile').ok, true);
  const ig = core('ledger').steps(root, J, 'integrate');
  assert.deepEqual(ig.map((e) => [e.detail.wave, e.ok, e.detail.kind || null]), [[1, false, 'commands'], [1, true, null], [2, true, null]]);
  F.record(root, result);
  assert.match(F.cli(root, ['next']).command, /verify run/);
});

test('P2.3: a task whose branch only points into the job branch (blocked, restarted) is not integrated, and its commands are not run', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [
    { id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: VC },
    { id: 'T2', objective: 'stock helper', allowed_paths: ['src/stock.js'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node src/stock.js', covers: ['AC-1'] }] },
  ]);
  const s1 = F.cli(root, ['task', 'start', 'T1', '--job', J], { allowFail: false });
  F.write(s1.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(s1.worktree, 'git commit -qam fix');
  F.built(root, 'T1', { job: J });
  assert.equal(F.cli(root, ['task', 'verify', 'T1', '--job', J]).pass, true);
  F.cli(root, ['task', 'start', 'T2', '--job', J], { allowFail: false }); // its branch is the job branch
  F.built(root, 'T2', { job: J, result: { status: 'blocked', summary: 'needs src/index.js', needs_paths: ['src/index.js'] } });
  const r = core('reconcile').integrateWave(root, J, ['T1'], { wave: 1 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const rec = core('ledger').lastStep(root, J, 'integrate');
  assert.deepEqual(rec.detail.commands.map((c) => c.cmd), ['node tests/add.test.js'], 'T2 is not integrated: its command does not run');
});

test('parallel task updates (builders\' task start, the testers\' verify for several tasks) never lose each other: state writes are locked', async () => {
  const root = F.makeRepo();
  const J = grounded(root);
  const ids = Array.from({ length: 24 }, (_, i) => `T${i + 1}`);
  customPlan(root, J, ids.slice(0, 6).map((id) => ({ id, objective: `task ${id}`, allowed_paths: [`src/${id}.js`], criteria_ids: ['AC-1'], verify_commands: VC })));
  const { spawn } = require('child_process');
  const one = (id) => new Promise((res) => spawn('node', [F.BIN, 'task', 'state', id, 'exhausted', '--reason', `r-${id}`, '--job', J], { cwd: root, env: { ...process.env, FACTORY_ROOT: '' } }).on('close', res));
  for (let round = 0; round < 3; round++) await Promise.all(ids.map(one));
  const st = stateOf(root, J);
  assert.deepEqual(ids.filter((id) => (st.tasks[id] || {}).outcome_reason === `r-${id}`), ids, 'every parallel update is kept');
});

test('upgrade: a job whose policy snapshot predates integrate_each_wave takes it from the live policy', () => {
  const root = F.makeRepo();
  const J = grounded(root);
  customPlan(root, J, [T1]);
  F.cli(root, ['next']);
  const s = stateOf(root, J);
  delete s.policy.limits.integrate_each_wave; // as a 0.5.3 job's snapshot
  core('job').save(root, s);
  assert.equal(F.cli(root, ['wfargs', 'realize']).integrate_each_wave, true, 'on by default');
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ limits: { integrate_each_wave: false } }));
  assert.equal(F.cli(root, ['wfargs', 'realize']).integrate_each_wave, false, 'the live policy turns it off for the job in flight');
});
