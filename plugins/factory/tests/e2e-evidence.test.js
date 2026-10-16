'use strict';
// 0.10.0 "critics with evidence", end to end through `factory drive` and the real workflow
// scripts (claude-factory: the drive runs every CLI step itself, the deps fetch included, and
// hands each workflow to the main session; here the workflow harness plays the Workflow tool
// with tests/helpers/evidence-crew.js). A fake package index serves the pinned library.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');
const A = require('./helpers/archives');
const H = require('./helpers/workflow-harness');
const T = require('./helpers/tmp');
const { LIB, crew } = require('./helpers/evidence-crew');

function pinnedJob(t, risk) {
  const root = F.makeRepo(t);
  F.write(root, 'requirements.txt', 'diffsync==2.0.1\n');
  F.sh(root, 'git add -A && git commit -qm pin');
  const idx = A.fakeIndex(path.join(T.mkdtemp('factory-index-', t), 'idx'));
  idx.add('pypi', 'diffsync', '2.0.1', LIB);
  const J = F.cli(root, ['job', 'new', '--title', 'VLAN sync', '--type', 'feature', '--risk', risk]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ goal: 'Sync VLANs with diffsync: VLANs missing from the source are deleted.' }));
  F.clarify(root);
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');
  return { root, J, idx };
}

// factory drive until it stops for the human (a gate): every workflow it hands over runs through
// the harness with the evidence crew; returns the gate stop and what ran.
async function driveToGate(root, J, idx, o = {}) {
  const env = { FACTORY_NOTIFY: 'off', ...idx.env };
  const drive = (args = []) => F.cli(root, ['drive', ...args], { env });
  const agents = crew(root, J, o);
  const runs = [];
  let s = drive();
  for (let guard = 0; guard < 30; guard++) {
    assert.ok(!s.error, JSON.stringify(s).slice(0, 600));
    if (s.kind !== 'workflow') break;
    const { result, calls } = await H.run(path.join(F.PLUGIN, 'workflows', `${s.workflow}.js`), JSON.stringify(s.args), agents);
    runs.push({ workflow: s.workflow, config: s.args.config || null, phase: s.args.phase || null, result, calls });
    const f = path.join(root, '.factory', 'scratch', 'envelope.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(result));
    s = drive(['--record', '.factory/scratch/envelope.json']);
  }
  return { stop: s, runs };
}

const eventsOf = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('e2e: a design defect only visible in the pinned dependency source is caught, verified and fixed before H2', async (t) => {
  const { root, J, idx } = pinnedJob(t, 'high');
  const { stop, runs } = await driveToGate(root, J, idx, { plan: 'good' });
  assert.equal(stop.kind, 'gate', JSON.stringify(stop).slice(0, 500));
  assert.equal(stop.gate.id, 'H2');
  const gate = stop.next;
  // the drive fetched the source itself (never run) before ground
  const fetched = eventsOf(root).filter((e) => e.event === 'deps_fetch');
  assert.ok(fetched.length >= 1 && fetched[0].fetched === 1, JSON.stringify(fetched));
  assert.ok(fs.existsSync(path.join(root, '.factory', 'deps', J, 'pypi', 'diffsync-2.0.1', 'diffsync', 'enum.py')));
  // ground: the first quote was off by a line; factory record asked that probe once more
  const grounds = runs.filter((r) => r.workflow === 'ground');
  assert.equal(grounds.length, 2, 'one re-ask');
  assert.deepEqual(grounds[1].calls.map((c) => c.opts.label), ['ground · interfaces'], 'only the interfaces probe is asked again');
  const ledger = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'api-ledger.json'), 'utf8'));
  assert.deepEqual(ledger.entries.map((e) => [e.id, e.symbol, e.line]), [['L-1', 'diffsync.DiffSyncFlags.SKIP_UNMATCHED_DST', 6]]);
  // decide: the API critic objected with file:line, a verifier confirmed it, the architect revised,
  // the critics approved the revision — before H2
  const decide = runs.find((r) => r.workflow === 'fanout-judge' && r.config === 'decide').result;
  const labels = decide.agents.map((a) => a.label);
  for (const l of ['api-conformance · design #1', 'verify api-conformance-1-1', 'architect · revise #1', 'api-conformance · design #2']) assert.ok(labels.includes(l), `${l} in ${labels.join(', ')}`);
  const crit = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'critiques', 'design.json'), 'utf8'));
  assert.equal(crit.verdict, 'approve');
  assert.equal(crit.rounds, 2);
  const adr = fs.readFileSync(path.join(F.jobDir(root, J), 'adr-001-sync.md'), 'utf8');
  assert.ok(!/flags=SKIP_UNMATCHED_DST/.test(adr), 'the design H2 shows no longer relies on the flag');
  assert.match(adr, /## External API usage[\s\S]*flags=DiffSyncFlags\.NONE[^\n]*L-1/);
  // what H2 shows: approved critics, the ledger quoted from the pinned source
  assert.equal(gate.review.design_critique.verdict, 'approve');
  assert.deepEqual(gate.review.design_critique.open, []);
  assert.equal(gate.review.api_ledger.entries, 1);
  assert.match(gate.review.api_ledger.symbols[0], /L-1 diffsync\.DiffSyncFlags\.SKIP_UNMATCHED_DST \(pypi:diffsync 2\.0\.1, \.factory\/deps\/J-0001\/pypi\/diffsync-2\.0\.1\/diffsync\/enum\.py:6\)/);
  assert.equal(F.cli(root, ['job', 'show']).status, 'active', 'nothing parked on the way');
});

test('e2e: a medium job reaches ONE combined gate (design + plan + environment); a plan whose verify command cannot run is fixed before it', async (t) => {
  const { root, J, idx } = pinnedJob(t, 'medium');
  const { stop, runs } = await driveToGate(root, J, idx);
  assert.equal(stop.kind, 'gate', JSON.stringify(stop).slice(0, 500));
  assert.equal(stop.gate.id, 'H3', 'medium risk: no H2 on the way');
  const gate = stop.next;
  assert.deepEqual(gate.review.approves, ['design', 'plan', 'environment']);
  assert.match(stop.summary, /one approval for design \+ plan \+ environment/);
  // the design defect was caught before this gate too
  assert.equal(gate.review.design_critique.verdict, 'approve');
  assert.ok(gate.gate.docs.some((d) => d.endsWith('adr-001-sync.md')) && gate.gate.docs.some((d) => d.endsWith('plan.json')) && gate.gate.docs.some((d) => d.endsWith('probe.json')));
  // decompose: the first plan's verify command could not run; the CLI's probe (in factory record)
  // said so, the planner fixed it, then God Eye critiqued the probed plan
  const decs = runs.filter((r) => r.workflow === 'decompose');
  assert.deepEqual(decs.map((r) => r.phase), ['plan', 'plan', 'critique']);
  assert.ok(decs[2].calls.some((c) => c.opts.agentType === 'factory:god-eye'), 'God Eye critiqued the plan at medium risk');
  const plan = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'plan.json'), 'utf8'));
  assert.deepEqual(plan.tasks[0].verify_commands.map((c) => c.cmd), ['node tests/add.test.js']);
  assert.equal(gate.review.probe.ok, true);
  assert.equal(gate.review.probe.current, true);
  assert.ok(gate.review.probe.commands.some((c) => /node tests\/add\.test\.js` → fails_as_expected/.test(c)), gate.review.probe.commands.join('\n'));
  const probeEvents = eventsOf(root).filter((e) => e.event === 'plan_probe');
  assert.deepEqual(probeEvents.map((e) => e.ok), [false, true], 'the broken command was seen before the gate, and fixed');
  // the build environment the planner proposed with the plan is part of this one gate: approving
  // it seals the environment, so the build starts without a separate "confirm environment"
  assert.equal(gate.review.environment.status, 'proposed');
  assert.equal(gate.review.environment.name, 'node-test');
  assert.ok(gate.gate.docs.some((d) => d.endsWith('environment.proposed.json')));
  assert.equal(require('../cli/core/environment').load(root), null);
  F.reply(root, 'approve');
  assert.equal(require('../cli/core/environment').load(root).name, 'node-test');
  // 0.11 (copilot-factory fix 0.10.1): the sealed environment sets up once in a scratch worktree before any task
  assert.equal(F.cli(root, ['next']).step, 'env_check');
  assert.equal(F.cli(root, ['env', 'check', '--job', J]).ok, true);
  const n = F.cli(root, ['next']);
  assert.equal(n.workflow, 'realize', JSON.stringify(n).slice(0, 400));
  assert.equal(F.sh(root, 'git worktree list').split('\n').filter((l) => /_probe-/.test(l)).length, 0, 'the probe left no worktree behind');
});
