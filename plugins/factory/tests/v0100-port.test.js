'use strict';
// The claude-factory side of the 0.9.0 + 0.10.0 port: what differs from copilot-factory because a
// claude-factory workflow cannot run a command (no runner): the loop engine copied inline into
// fanout-judge.js decides exactly as cli/core/loop.js does; the CLI's own steps (deps fetch, plan
// probe, task grant) are never an agent's; a builder's paths are granted through its own
// `task built --paths`, checked the same way and never wider; factory record checks a design
// critic's source quote and re-asks the API ledger once only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');
const A = require('./helpers/archives');
const T = require('./helpers/tmp');
const { LIB } = require('./helpers/evidence-crew');

const core = (m) => require(`../cli/core/${m}`);
const next = (root) => F.cli(root, ['next']);

// The inline engine of fanout-judge.js, loaded on its own (a workflow may not read Date).
function inlineEngine() {
  const src = fs.readFileSync(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), 'utf8');
  const m = /\/\/ LOOP ENGINE BEGIN\n([\s\S]*?)\/\/ LOOP ENGINE END/.exec(src);
  assert.ok(m, 'fanout-judge.js carries the engine between its markers');
  assert.ok(!/\bDate\b|require\(/.test(m[1]), 'no clock, no require');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[1]}\nreturn { shouldContinue, recordDiagnosis, question, keys, policyFor }`)();
}

const noClock = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'at' ? undefined : v)));

test('the loop engine inline in fanout-judge.js decides exactly as cli/core/loop.js (fuzzed)', () => {
  const E = inlineEngine();
  const L = core('loop');
  let seed = 7;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  for (let run = 0; run < 1500; run++) {
    const policy = { ceiling: 1 + rnd(5), stall_rounds: 1 + rnd(2), escalate_model: rnd(3) ? 'opus' : null, diagnose: Boolean(rnd(2)) };
    let a = null;
    let b = null;
    for (let step = 0; step < 12; step++) {
      const blockers = Array.from({ length: rnd(4) }, () => ({ check: 'c', ref: String(rnd(3)) }));
      const x = L.shouldContinue(a, blockers, policy);
      const y = E.shouldContinue(b, blockers, policy);
      assert.deepEqual(noClock(y), noClock(x), `run ${run} step ${step}`);
      a = x.state;
      b = y.state;
      if (x.action === 'diagnose') {
        const d = { cause: 'c', needs_user: Boolean(rnd(2)), approach: rnd(2) ? 'a' : '', question: 'q?', options: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }], recommendation: 'a' };
        a = L.recordDiagnosis(a, d);
        b = E.recordDiagnosis(b, d);
        assert.deepEqual(noClock(b), noClock(a));
      }
      if (x.action === 'stop') {
        assert.deepEqual(noClock(E.question(b, { what: 'w', blockers })), noClock(L.question(a, { what: 'w', blockers })));
        break;
      }
    }
  }
});

test('the CLI\'s own steps (deps fetch, plan probe, task grant) are never an agent\'s: the guard refuses them by command text, the CLI while an agent is at work', (t) => {
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const G = require('../hooks/guard-rules');
  const pol = core('policy').defaults();
  for (const [cmd, who] of [[`factory deps fetch --job ${J}`, 'factory:researcher'], [`factory plan probe --job ${J}`, 'factory:planner'], [`factory task grant T1 --paths a.js --job ${J}`, 'factory:builder'], [`/x/bin/factory --job ${J} deps fetch --add pypi:x==1`, 'factory:planner']]) {
    assert.match(String(G.checkBash(root, cmd, pol, { agent: true, agentType: who })), /factory CLI's own step/, cmd);
    assert.equal(G.checkBash(root, cmd, pol, {}), null, `the main session may: ${cmd}`);
  }
  // still allowed to agents: looking and checking
  assert.equal(G.checkBash(root, `factory deps show --job ${J}`, pol, { agent: true, agentType: 'factory:god-eye' }), null);
  assert.equal(G.checkBash(root, `factory plan validate --job ${J}`, pol, { agent: true, agentType: 'factory:planner' }), null);
  // the CLI's layer below the guard: refused while a factory agent is at work (agents-open)
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), event: 'SubagentStart', agent_id: 'a1', agent_type: 'factory:researcher' })}\n`);
  assert.equal(F.cli(root, ['deps', 'fetch']).code, 'agent_at_work');
  assert.equal(F.cli(root, ['plan', 'probe']).code, 'agent_at_work');
  // the planner may write its environment proposal next to plan.json, nothing else of the job's
  assert.equal(G.checkWrite(root, path.join(F.jobDir(root, J), 'environment.proposed.json'), pol, { agent: true, agentType: 'factory:planner', job: J }), null);
});

test('a builder blocked for paths: `task built --paths` grants files inside the contract\'s allowed paths no other task owns (never wider), and the reply carries what was granted', (t) => {
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.clarify(root);
  next(root);
  F.reply(root, 'approve');
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [
    { id: 'T1', objective: 'fix', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: ['node tests/add.test.js'] },
    { id: 'T2', objective: 'other', allowed_paths: ['src/other.js'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: ['true'] },
  ] }));
  const allowedBefore = core('contract').parse(core('contract').read(root, J)).allowedPaths;
  // only a task with an attempt open (review MAJ-4): T1's builder ran task start
  const s0 = core('job').load(root, J);
  s0.tasks = { ...(s0.tasks || {}), T1: { ...((s0.tasks || {}).T1 || {}), attempts: 1 } };
  core('job').save(root, s0);
  // what the builder runs as its last step (the guard lets only factory:builder run it)
  const r = F.cli(root, ['task', 'built', 'T1', '--status', 'blocked', '--reason', 'needs_paths', '--paths', 'tests/add.test.js']);
  assert.deepEqual(r.granted, ['tests/add.test.js'], JSON.stringify(r));
  assert.deepEqual(core('job').load(root, J).tasks.T1.granted_paths, ['tests/add.test.js']);
  // refused: another task's file, a directory, outside the contract — all or nothing, nothing written
  for (const [p, why] of [['src/other.js', /T2's path/], ['src', /a directory/], ['README.md', /outside the contract/]]) {
    // a new attempt each time (one grant per attempt)
    const s1 = core('job').load(root, J);
    s1.tasks.T1.attempts += 1;
    core('job').save(root, s1);
    const x = F.cli(root, ['task', 'built', 'T1', '--status', 'blocked', '--reason', 'needs_paths', '--paths', p]);
    assert.deepEqual(x.granted, [], p);
    assert.match(x.refused[0].why, why);
  }
  assert.deepEqual(core('job').load(root, J).tasks.T1.granted_paths, ['tests/add.test.js']);
  assert.deepEqual(core('contract').parse(core('contract').read(root, J)).allowedPaths, allowedBefore, 'the contract\'s allowed paths are never widened');
  // the guard's worktree scope and task verify honour the grant
  const G = require('../hooks/guard-rules');
  assert.equal(G.checkWrite(root, path.join(root, '.factory', 'worktrees', `${J}-T1`, 'tests', 'add.test.js'), core('policy').defaults()), null);
  assert.ok(G.checkWrite(root, path.join(root, '.factory', 'worktrees', `${J}-T1`, 'src', 'other.js'), core('policy').defaults()), 'another task\'s file stays out of T1\'s scope');
  // the brief tells the builder how to ask
  const b = F.cli(root, ['wfargs', 'realize']);
  assert.match(fs.readFileSync(b.tasks.T1.builder_prompt.split('\n')[1].trim(), 'utf8'), /--reason needs_paths --paths <files>/);
});

test('factory record checks a design critic\'s source quote: one not at its line is rejected evidence and no open objection at the gate', (t) => {
  const root = F.makeRepo(t);
  F.write(root, 'requirements.txt', 'diffsync==2.0.1\n');
  F.sh(root, 'git add -A && git commit -qm pin');
  const idx = A.fakeIndex(path.join(T.mkdtemp('factory-index-', t), 'idx'));
  idx.add('pypi', 'diffsync', '2.0.1', LIB);
  const J = F.cli(root, ['job', 'new', '--title', 'VLAN sync', '--type', 'feature', '--risk', 'high']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ goal: 'Sync VLANs with diffsync.' }));
  F.clarify(root);
  next(root);
  F.reply(root, 'approve');
  F.cli(root, ['deps', 'fetch'], { env: idx.env });
  const g = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(g, 'ok', { topics: [{ topic: 'codebase', claims: [], unknowns: [] }], degraded: [] }));
  const lib = `.factory/deps/${J}/pypi/diffsync-2.0.1/diffsync/enum.py`;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'threat-model.md'), F.threatModelText({ job: J }));
  F.write(F.jobDir(root, J), 'adr-001-x.md', F.adrText({ job: J, threats: ['TH-1'] }));
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  assert.deepEqual(b.critics.map((c) => c.id), ['god-eye', 'api-conformance'], 'the job has dependency source: the API critic runs too');
  const items = [
    { id: 'api-conformance-1-1', critic: 'api-conformance', severity: 'blocker', symbol: 'NONE', issue: 'quotes a line that is not there', evidence: { kind: 'source', ref: `${lib}:2`, quote: 'NONE = 0' }, verified: 'confirmed' },
    { id: 'api-conformance-1-2', critic: 'api-conformance', severity: 'major', symbol: 'SKIP_UNMATCHED_DST', issue: 'a real one', evidence: { kind: 'source', ref: `${lib}:6`, quote: 'SKIP_UNMATCHED_DST = 0b10' }, verified: 'confirmed' },
  ];
  const r = F.record(root, F.envelope(b, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-x.md')], summary: 's' }, stop: 'no_progress', revised_after_last: true, open: items.map((i) => i.id), critiques: [{ round: 1, verdict: 'revise', items, open: items.map((i) => i.id) }] }));
  assert.equal(r.status, 'ok', JSON.stringify(r));
  const crit = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'critiques', 'design.json'), 'utf8'));
  assert.deepEqual(crit.open.map((i) => i.id), ['api-conformance-1-2']);
  const bad = crit.items.find((i) => i.id === 'api-conformance-1-1');
  assert.match(bad.evidence_rejected, /the quote is not at/);
  assert.equal(bad.severity, 'minor');
  const n = next(root);
  assert.equal(n.step, 'H2');
  assert.deepEqual(n.review.design_critique.open.map((i) => i.id), ['api-conformance-1-2']);
});

test('the API ledger is re-asked once only: a second run with rejected entries keeps them as rejected, never asks again', (t) => {
  const root = F.makeRepo(t);
  F.write(root, 'requirements.txt', 'diffsync==2.0.1\n');
  F.sh(root, 'git add -A && git commit -qm pin');
  const idx = A.fakeIndex(path.join(T.mkdtemp('factory-index-', t), 'idx'));
  idx.add('pypi', 'diffsync', '2.0.1', LIB);
  const J = F.cli(root, ['job', 'new', '--title', 'VLAN sync', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ goal: 'Sync VLANs with diffsync.' }));
  F.clarify(root);
  next(root);
  F.reply(root, 'approve');
  F.cli(root, ['deps', 'fetch'], { env: idx.env });
  const lib = `.factory/deps/${J}/pypi/diffsync-2.0.1/diffsync/enum.py`;
  const wrong = { topic: 'interfaces', claims: [], unknowns: [], ledger: [{ symbol: 'x', file: lib, line: 1, quote: 'class Invented' }] };
  let b = F.cli(root, ['wfargs', 'ground']);
  assert.equal(F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [], unknowns: [] }, wrong], degraded: [] })).status, 'retry');
  b = F.cli(root, ['wfargs', 'ground']);
  assert.equal(b.reask, true);
  const r = F.record(root, F.envelope(b, 'ok', { topics: [wrong], degraded: [], reask: true }));
  assert.equal(r.status, 'ok', 'asked once: what still fails is dropped');
  const L = core('deps').readLedger(root, J);
  assert.deepEqual([L.entries.length, L.rejected.length], [0, 1]);
  assert.match(fs.readFileSync(path.join(F.jobDir(root, J), 'findings.md'), 'utf8'), /### codebase/, 'the first run\'s other topics are kept');
  assert.equal(next(root).config, 'decide');
});
