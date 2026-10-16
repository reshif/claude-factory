'use strict';
// factory console: reads .factory/ without changing it, records which agents ran per
// step, and writes a page whose data can't break out of its script tag.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');

const instructions = (prompt) => {
  const line = prompt.split('\n').find((l) => l.trim().startsWith('/'));
  return line ? fs.readFileSync(line.trim(), 'utf8') : prompt;
};

// Clarify v3 through the real workflow script, stage by stage: read-back (nothing to research),
// ok, contract, readiness. Returns the last record.
const READY = { intent_clear: true, scope_bounded: true, acs_testable: true, self_consistent: true, facts_honoured: true, instructions_handled: true, decisions_closed: true };
async function clarify(root) {
  const { grab } = require('./helpers/clarify3-crew');
  let r = null;
  for (let i = 0; i < 8; i++) {
    const n = F.cli(root, ['next']);
    if (!(n.action === 'skill' && n.skill === 'clarify')) break;
    if (n.clarify.waiting_for_user) {
      F.cli(root, ['clarify', 'reply', 'ok'], { allowFail: false });
      continue;
    }
    const brief = F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
    const { result } = await H.run(path.join(F.PLUGIN, 'workflows', 'clarify.js'), JSON.stringify(brief), (prompt, opts) => {
      if (opts.agentType === 'factory:interviewer') return { intent: { problem: 'add subtracts', who: 'callers', outcome: 'add sums', success: 'the test passes' }, scope: { in: ['add'], out: [] }, took: [], pins: [], plan: [], questions: [], design_may_choose: [] };
      if (opts.agentType === 'factory:contract-writer') return { contract: F.contractText(), covers: (grab(`${instructions(prompt)}\n${prompt}`, 'CLARIFY INPUT (JSON):').items || []).map((x) => ({ item: x.id, where: 'Goal' })), uncovered: [] };
      if (opts.agentType === 'factory:god-eye') return { verdict: 'ready', restatement: { problem: 'add subtracts', outcome: 'add sums' }, checklist: READY, objections: [] };
      throw new Error(`unexpected ${opts.agentType}: ${instructions(prompt).slice(0, 80)}`);
    });
    assert.ok(Array.isArray(result.agents) && result.agents.length === 1, 'the envelope carries the roster (one agent per clarify stage here)');
    r = F.record(root, result);
  }
  return r;
}

const snapshot = (root) => {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'worktrees') walk(p); } else out[path.relative(root, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(path.join(root, '.factory'));
  return out;
};

test('console: steps, timeline and the agents per step, read-only', async () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add </script><img src=x onerror=alert(1)>', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.cli(root, ['next']);
  assert.equal((await clarify(root)).status, 'ok');
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');
  F.cli(root, ['next']);
  assert.equal(F.cli(root, ['park', '--reason', 'Waiting on the API owners']).status, 'parked');

  // the roster is sealed into the ledger, tied to the routing decision
  const ledger = fs.readFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const ag = ledger.find((e) => e.kind === 'agents');
  assert.ok(ag && ag.seal, 'agents entry is sealed');
  assert.equal(ag.workflow, 'clarify');
  assert.deepEqual([...new Set(ledger.filter((e) => e.kind === 'agents').flatMap((e) => e.agents.map((a) => a.agent_type)))].sort(), ['factory:contract-writer', 'factory:god-eye', 'factory:interviewer']);
  assert.match(ag.decision_id, /^J-\d+-D\d+$/);

  const before = snapshot(root);
  const out = path.join(os.tmpdir(), `console-${process.pid}-${Date.now()}.html`);
  const dataFile = `${out}.json`;
  const r = F.cli(root, ['console', '--out', out, '--data', dataFile]);
  assert.equal(r.__code, 0, JSON.stringify(r));
  assert.equal(r.written, out);
  assert.deepEqual(snapshot(root), before, 'console changes nothing under .factory/');

  const html = fs.readFileSync(out, 'utf8');
  assert.ok(!html.includes('/*__FACTORY_DATA__*/null'), 'the data slot is filled');
  assert.ok(!html.includes('</script><img'), 'a job title cannot close the script tag');
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const job = data.jobs.find((j) => j.id === J);
  assert.equal(job.recipe, 'bug@low');
  assert.deepEqual(job.steps.map((s) => s.id).slice(0, 4), ['request', 'clarify', 'H1', 'ground']);
  assert.equal(job.steps.find((s) => s.id === 'H1').human, true);
  assert.equal(job.steps.find((s) => s.id === 'realize').stage, 'build');
  const types = job.timeline.map((t) => t.type);
  assert.equal(types[0], 'created');
  for (const t of ['route', 'human', 'agents', 'result']) assert.ok(types.includes(t), `timeline has ${t}`);
  const a = job.timeline.find((t) => t.type === 'agents');
  assert.equal(a.step, 'clarify', 'agents are placed on the step that ran them');
  assert.deepEqual(job.timeline.filter((t) => t.type === 'agents' && t.step === 'clarify').map((t) => t.agents.map((x) => x.role).join()), ['interviewer', 'contract-writer', 'god-eye'], 'one agents event per clarify stage');
  assert.equal(job.timeline.find((t) => t.type === 'human').step, 'H1');
  const park = job.timeline.find((t) => t.type === 'park');
  assert.ok(park && /API owners/.test(park.text), 'a park you asked for is on the timeline, even after a resume clears it from state');
  assert.equal(job.timeline.filter((t) => t.type === 'park').length, 1, 'state.park and the park command are one event');
  assert.equal(data.integrity.status, 'verified');
});

test('console: never creates a factory key on a machine without one', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  const key = path.join(os.tmpdir(), `no-key-${process.pid}-${Date.now()}`, 'secret');
  const out = path.join(os.tmpdir(), `console-nokey-${process.pid}.html`);
  const r = spawnSync('node', [F.BIN, 'console', '--out', out], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '', FACTORY_SECRET_FILE: key } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).integrity, 'not_checked');
  assert.ok(!fs.existsSync(key), 'no key file was created');
});

test('console --serve: streams fresh data when the factory writes, only to this machine', async () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Live one', '--type', 'bug', '--risk', 'low']).job;
  const http = require('http');
  const { url, close } = await new Promise((resolve) => require('../cli/core/console').serve(root, { port: 0, interval: 50, onReady: resolve }));
  try {
    const get = (p, headers = {}) => new Promise((res, rej) => http.get(url + p, { headers }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
    const page = await get('');
    assert.equal(page.status, 200);
    assert.match(page.body, /"live":true/);
    assert.equal((await get('data.json', { host: 'attacker.example' })).status, 403, 'a rebound foreign host is refused');

    const events = [];
    let wake = () => {};
    const req = http.get(`${url}events`, (r) => {
      let buf = '';
      r.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) { events.push(JSON.parse(line.slice(6))); wake(); }
        }
      });
    });
    const nextEvent = (n) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('no event')), 5000); const check = () => { if (events.length >= n) { clearTimeout(t); res(events[n - 1]); } }; wake = check; check(); });
    assert.equal((await nextEvent(1)).jobs.find((j) => j.id === J).status, 'active', 'connecting sends the current data');
    F.cli(root, ['park', '--reason', 'Waiting on the API owners']);
    assert.equal((await nextEvent(2)).jobs.find((j) => j.id === J).status, 'parked', 'a CLI write reaches the open page');
    req.destroy();
  } finally {
    close();
  }
});

test('console: each job carries a rev that changes only when that job does, and items name their stage', () => {
  const root = F.makeRepo();
  const A = F.cli(root, ['job', 'new', '--title', 'First', '--type', 'bug', '--risk', 'low']).job;
  F.cli(root, ['next']);
  const B = F.cli(root, ['job', 'new', '--title', 'Second', '--type', 'bug', '--risk', 'low']).job;
  const { build } = require('../cli/core/console');
  const rev = (d, id) => d.jobs.find((j) => j.id === id).rev;
  const d1 = build(root);
  const d2 = build(root);
  assert.match(rev(d1, A), /^[0-9a-f]{12}$/);
  assert.equal(rev(d1, A), rev(d2, A), 'same files, same rev');
  F.cli(root, ['park', '--reason', 'later', '--job', B]);
  const d3 = build(root);
  assert.notEqual(rev(d3, B), rev(d1, B), 'the parked job has a new rev');
  assert.equal(rev(d3, A), rev(d1, A), 'the other job keeps its rev');
  const route = d3.jobs.find((j) => j.id === A).timeline.find((t) => t.type === 'route' && t.step);
  assert.equal(route.stage, 'contract', 'a routed step carries its stage');
});

test('console: an agent with no stop event is running only while recent and the job is active', () => {
  const root = F.makeRepo();
  const A = F.cli(root, ['job', 'new', '--title', 'Active', '--type', 'bug', '--risk', 'low']).job;
  const B = F.cli(root, ['job', 'new', '--title', 'Parked', '--type', 'bug', '--risk', 'low']).job;
  F.cli(root, ['park', '--reason', 'later', '--job', B]);
  const { build, STALE_AGENT_MS } = require('../cli/core/console');
  const now = Date.parse('2030-01-01T12:00:00.000Z');
  const at = (ms) => new Date(now - ms).toISOString();
  const ev = (job, id, ts, type = 'factory:builder') => JSON.stringify({ ts, event: 'SubagentStart', job, agent_id: id, agent_type: type });
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), [
    ev(A, 'fresh', at(10 * 60000)),
    ev(A, 'crashed', at(STALE_AGENT_MS + 60000), 'factory:tester'),
    ev(B, 'parked-job', at(60000)),
  ].join('\n') + '\n');
  const data = build(root, { now: new Date(now).toISOString() });
  const a = data.jobs.find((j) => j.id === A);
  const b = data.jobs.find((j) => j.id === B);
  assert.deepEqual(a.running_agents.map((x) => x.agent_type), ['factory:builder'], 'only the recent one is running');
  assert.deepEqual(a.stale_agents.map((x) => [x.agent_type, x.stale]), [['factory:tester', true]], 'the old one is marked stale');
  assert.equal(b.running_agents.length, 0, 'a job that is not active has nothing running');
  assert.equal(b.stale_agents.length, 1);
});

// Runs workflow agents the way Claude Code reports them: the agents called together start together
// (one SubagentStart hook each), then stop one by one (SubagentStop); `before(opts, id)` runs as each
// agent works, after the starts are in the log.
function hookedAgents(root, impl) {
  const hook = (s, input) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', s)], { input: JSON.stringify({ cwd: root, session_id: 't', ...input }), encoding: 'utf8' });
  let batch = null;
  let n = 0;
  return (prompt, opts) => new Promise((resolve, reject) => {
    if (!batch) {
      batch = [];
      setImmediate(() => {
        const b = batch;
        batch = null;
        for (const it of b) { it.id = `agent-${++n}`; hook('activity.js', { hook_event_name: 'SubagentStart', agent_id: it.id, agent_type: it.opts.agentType }); }
        for (const it of b) {
          try { it.out = impl(it.prompt, it.opts, it.id, (cmd) => hook('activity.js', { hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: it.id, agent_type: it.opts.agentType, tool_input: { command: cmd } })); } catch (e) { it.err = e; }
          hook('subagent-stop.js', { hook_event_name: 'SubagentStop', agent_id: it.id, agent_type: it.opts.agentType });
        }
        for (const it of b) (it.err ? it.reject(it.err) : it.resolve(it.out));
      });
    }
    batch.push({ prompt, opts, resolve, reject });
  });
}
const logLines = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const stepRows = (r) => r.steps.map((s) => [s.state, s.label, s.roles.map((x) => `${x.role} ${x.total}/${x.running}/${x.ok}/${x.failed}/${x.retries}`).join(', ')]);

test('console: a workflow run step by step, from the brief (wfargs), the agent hooks and the record — live and when done', async () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Clarify me', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  // clarify v3 up to its research pass: a read-back that plans one repo and one docs question, and your ok
  const plan = [
    { item: 'new', what: 'Where add is defined and tested', tag: 'repo', pins: [], impact: 'medium', why: 'The fix goes where add lives.' },
    { item: 'new', what: 'How node:test reports a failed assertion', tag: 'docs', pins: [], impact: 'low', why: 'The verify command must fail on a wrong sum.' },
  ];
  assert.equal(F.clarify(root, { until: 'research', readback: { intent: { problem: 'add subtracts', who: 'callers', outcome: 'add sums', success: 'the test passes' }, scope: { in: ['add'], out: [] }, took: [], pins: [], plan, questions: [], design_may_choose: [] } }).stage, 'research');
  const D = F.cli(root, ['next']).decision_id;
  const { build } = require('../cli/core/console');
  // a brief made twice: the first one never ran, and leaves no run
  F.cli(root, ['wfargs', 'clarify']);
  const brief = F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
  const live = {};
  let briefFailed = false;
  // the docs researcher comes back with nothing (a researcher is tried once: its time box is spent); the
  // brief writer comes back with nothing once and is tried again
  const { result } = await H.run(path.join(F.PLUGIN, 'workflows', 'clarify.js'), JSON.stringify(brief), hookedAgents(root, (prompt, o) => {
    if (o.agentType === 'factory:researcher') return /docs/.test(o.label) ? null : { mode: 'repo', evidence: [], unresolved: [{ plan: 'P-1', reason: 'not found' }], failed_sources: [] };
    if (o.agentType === 'factory:brief-writer') {
      if (!briefFailed) { briefFailed = true; live.brief = build(root, {}).jobs[0]; return null; }
      return { summary: 'nothing found', records: [], facts: [], gaps: [{ plan: 'P-1', why: 'not found' }] };
    }
    throw new Error(o.agentType);
  }));
  assert.ok(['continue', 'needs_user', 'ok'].includes(F.record(root, result).status));

  // the read-back's own run came first (F.clarify recorded it); the research brief's start, made twice, and its end follow
  const wf = logLines(root).filter((e) => /^workflow_/.test(e.event)).slice(-3);
  assert.deepEqual(wf.map((e) => e.event), ['workflow_start', 'workflow_start', 'workflow_end']);
  for (const e of wf) {
    assert.equal(e.job, J);
    assert.equal(e.decision_id, D, 'tied to the routing decision in force, as the agent lines are');
    assert.equal(require('../cli/lib/seal').valid(e), true, 'sealed like every log line');
  }
  // clarify v3: one stage per brief; this one is the research pass (two researchers, then the brief writer)
  assert.deepEqual(wf[1].plan, { steps: { readback: 0, research: 2, brief: 1, interpret: 0, redirect: 0, write: 0, check: 0 }, modes: ['repo', 'docs'] }, 'what the brief will run');
  assert.equal(wf[2].wf_run, wf[1].wf_run, 'the record ends the run its brief started');
  assert.equal(wf[2].roster.length, 4);
  assert.ok(logLines(root).filter((e) => /^Subagent/.test(e.event)).every((e) => e.job === J && e.decision_id === D), 'every agent line names the job and the decision');

  // while the brief writer worked: the research step done, the brief at work
  let r = live.brief.runs.find((x) => x.status === 'running');
  assert.ok(r, 'the research run is live');
  assert.equal(live.brief.runs_live.running, r.id);
  assert.equal(r.stage, 'contract');
  assert.deepEqual(stepRows(r), [
    ['done', 'research (repo, docs)', 'researcher 2/0/2/0/0'],
    ['running', 'research brief', 'brief-writer 1/1/0/0/0'],
  ], 'live, the hooks say only that an agent stopped, not how');

  // done: the record's roster marks the failed researcher and the brief writer's retry
  const j = build(root, {}).jobs[0];
  r = j.runs.find((x) => x.id === wf[2].wf_run);
  assert.equal(r.status, 'done');
  assert.deepEqual(stepRows(r), [
    ['done', 'research (repo, docs)', 'researcher 2/0/1/1/0'],
    ['done', 'research brief', 'brief-writer 2/0/1/1/1'],
  ]);
  assert.equal(r.at, null);
  assert.ok(r.agents.some((a) => /\(retry\)$/.test(a.label) && a.retry), 'the agents carry their labels from the roster');
});

test('console: workflow steps for decide, challenge, decompose rounds and realize waves; cut-off runs; distill', () => {
  const RS = require('../cli/core/run-steps');
  const t0 = Date.parse('2030-01-01T12:00:00.000Z');
  const ts = (s) => new Date(t0 + s * 1000).toISOString();
  const runOf = (lines, opts) => RS.fromEvents(lines.map(([s, e]) => ({ ts: ts(s), job: 'J-1', decision_id: 'D1', ...e })), opts);
  const start = (s, workflow, config, brief, extra) => [s, { event: 'workflow_start', wf_run: `${workflow}-${config}-${s}`, workflow, config, plan: RS.planOf({ workflow, config, ...brief }), ...extra }];
  const A = (s, id, role) => [s, { event: 'SubagentStart', agent_id: id, agent_type: `factory:${role}` }];
  const Z = (s, id) => [s, { event: 'SubagentStop', agent_id: id }];
  const end = (s, run, roster) => [s, { event: 'workflow_end', wf_run: run, outcome: 'ok', status: 'ok', roster }];
  const steps = (run, t) => RS.view(run, t === undefined ? undefined : t0 + t * 1000).steps.map((s) => [s.state, s.label, s.roles.map((x) => `${x.role}×${x.total}${x.failed ? ` ✕${x.failed}` : ''}`).join(',')]);

  // decide: options and the threat model, the architect, God Eye, a revision, God Eye round 2
  let [d] = runOf([start(0, 'fanout-judge', 'decide', { fanout: [1, 2, 3, 4], judge: {}, critique: { revise: {} } }),
    A(1, 'o1', 'option-generator'), A(1, 'o2', 'option-generator'), A(1, 'o3', 'option-generator'), A(1, 't', 'threat-modeler'), Z(50, 'o1'), Z(51, 'o2'), Z(52, 'o3'), Z(60, 't'),
    A(61, 'a', 'architect'), Z(90, 'a'), A(91, 'g1', 'god-eye'), Z(120, 'g1'), A(121, 'a2', 'architect'), Z(150, 'a2'), A(151, 'g2', 'god-eye')], { alive: () => true });
  assert.deepEqual(steps(d), [['done', 'fan-out (4)', 'option-generator×3,threat-modeler×1'], ['done', 'architect', 'architect×1'], ['done', 'God Eye (design) round 1', 'god-eye×1'], ['done', 'architect revises (round 1)', 'architect×1'], ['running', 'God Eye (design) round 2', 'god-eye×1']]);
  assert.deepEqual(steps(d, 100), [['done', 'fan-out (4)', 'option-generator×3,threat-modeler×1'], ['done', 'architect', 'architect×1'], ['running', 'God Eye (design) round 1', 'god-eye×1'], ['pending', 'architect revises', '']], 'replayed at a time: the steps as they stood');
  // with no threat model and no critique in the brief, those steps are not shown at all
  [d] = runOf([start(0, 'fanout-judge', 'decide', { fanout: [1, 2, 3], judge: {} }), A(1, 'o1', 'option-generator')], { alive: () => true });
  assert.deepEqual(steps(d), [['running', 'fan-out (3)', 'option-generator×1'], ['pending', 'architect decides', '']]);

  // challenge: the lanes, then a verifier per serious finding; the roster's outcomes mark who failed
  const [c] = runOf([start(0, 'fanout-judge', 'challenge', { fanout: [1, 2], verifier: {} }), A(1, 'r1', 'code-reviewer'), A(1, 'r2', 'security-reviewer'), Z(30, 'r1'), Z(40, 'r2'), A(41, 'v1', 'finding-verifier'), Z(60, 'v1'),
    end(61, 'fanout-judge-challenge-0', [{ agent_type: 'factory:code-reviewer', label: 'review · code', outcome: 'ok' }, { agent_type: 'factory:security-reviewer', label: 'review · security', outcome: 'ok' }, { agent_type: 'factory:finding-verifier', label: 'verify security-1', outcome: 'no_result' }])]);
  assert.deepEqual(steps(c), [['done', 'fan-out (2)', 'code-reviewer×1,security-reviewer×1'], ['done', 'verify findings', 'finding-verifier×1 ✕1']]);
  assert.equal(c.status, 'done');

  // decompose: a planner round that failed validation starts round 2; God Eye's revision stays in its round
  const [p] = runOf([start(0, 'decompose', null, { mode: 'plan', critique: {} }, { mode: 'plan' }), A(1, 'p1', 'planner'), Z(30, 'p1'), A(31, 'p2', 'planner'), Z(60, 'p2'), A(61, 'g1', 'god-eye'), Z(90, 'g1'), A(91, 'p3', 'planner'), Z(120, 'p3'), A(121, 'g2', 'god-eye')], { alive: () => true });
  assert.deepEqual(steps(p), [['done', 'plan round 1', 'planner×1'], ['done', 'plan round 2', 'planner×1'], ['done', 'God Eye (plan) round 1', 'god-eye×1,planner×1'], ['running', 'God Eye (plan) round 2', 'god-eye×1']]);

  // realize: an agent's wave is the one holding the task it names; waves ahead are pending, a wave with nothing to build skipped
  const B = (s, id, cmd) => [s, { event: 'PostToolUse', tool: 'Bash', agent_id: id, target: `/x/bin/factory ${cmd} --job J-1` }];
  const lines = [start(0, 'realize', null, { waves: [['T1', 'T2'], ['T3'], ['T4'], ['T5']] }), A(1, 'b1', 'builder'), A(1, 'b2', 'builder'), B(5, 'b1', 'task start T1'), B(6, 'b2', 'task start T2'), Z(60, 'b1'), Z(61, 'b2'),
    A(62, 't1', 'tester'), A(62, 't2', 'tester'), B(70, 't1', 'task verify T1'), Z(80, 't1'), Z(81, 't2'), A(90, 'b4', 'builder'), B(95, 'b4', 'task start T4')];
  let [w] = runOf(lines, { alive: () => true });
  assert.deepEqual(steps(w), [['done', 'wave 1 of 4: T1, T2', 'builder×2,tester×2'], ['skipped', 'wave 2 of 4', ''], ['running', 'wave 3 of 4: T4', 'builder×1'], ['pending', 'wave 4 of 4', '']]);
  assert.deepEqual(steps(w, 92).map((x) => x[0]), ['done', 'skipped', 'running', 'pending'], 'the builder is in wave 3 from its start, though it named its task later');
  // the routing moved on with the run still open: it was cut off, its step failed
  [w] = runOf(lines.concat([[200, { event: 'cli', cmd: 'next' }]]), { alive: () => true });
  assert.equal(w.status, 'failed');
  assert.match(w.error, /interrupted/);
  assert.equal(w.ended_at, ts(90), 'ended with its last agent line');
  assert.deepEqual(steps(w).map((x) => x[0]), ['done', 'skipped', 'failed', 'skipped']);
  // and with no `alive` (the job is not active, or nothing happened for hours) a run with no end is cut off too
  assert.equal(runOf(lines)[0].status, 'failed');
  // agents of another routing decision, or of no factory role, are not this run's
  const [o] = runOf([start(0, 'reconcile', null, {}), [1, { event: 'SubagentStart', agent_id: 'x', agent_type: 'factory:integrator', decision_id: 'D0' }], [2, { event: 'SubagentStart', agent_id: 'y', agent_type: 'Explore' }], A(3, 'i', 'integrator')], { alive: () => true });
  assert.deepEqual(steps(o), [['running', 'integrate task branches', 'integrator×1']]);
  // older logs: agent lines with no workflow_start make no run
  assert.deepEqual(RS.fromEvents([A(1, 'a', 'builder'), Z(2, 'a')].map(([s, e]) => ({ ts: ts(s), job: 'J-1', decision_id: 'D1', ...e }))), []);
});

test('console: distill is a run of one step while the lesson-writer works; a distill with nothing to learn leaves none', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Learn', '--type', 'bug', '--risk', 'low']).job;
  const hook = (s, input) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', s)], { input: JSON.stringify({ cwd: root, session_id: 't', ...input }), encoding: 'utf8' });
  const { build } = require('../cli/core/console');
  F.cli(root, ['distill', 'context']);
  F.cli(root, ['distill', 'done']);
  assert.deepEqual(build(root, {}).jobs[0].runs, [], 'no lesson-writer ran: no run');
  F.cli(root, ['distill', 'context']);
  hook('activity.js', { hook_event_name: 'SubagentStart', agent_id: 'lw', agent_type: 'factory:lesson-writer' });
  let r = build(root, {}).jobs[0].runs[0];
  assert.deepEqual([r.workflow, r.stage, r.status, r.steps.map((s) => [s.state, s.label])], ['distill', null, 'running', [['running', 'write lessons']]]);
  hook('subagent-stop.js', { hook_event_name: 'SubagentStop', agent_id: 'lw', agent_type: 'factory:lesson-writer' });
  F.cli(root, ['distill', 'done', '--result', JSON.stringify({ lessons: [], nothing_to_learn: true })]);
  r = build(root, {}).jobs[0].runs[0];
  assert.deepEqual([r.status, r.result, r.steps[0].roles], ['done', 'nothing_to_learn', [{ role: 'lesson-writer', total: 1, running: 0, ok: 1, failed: 0, retries: 0 }]]);
  assert.ok(logLines(root).filter((e) => /^workflow_/.test(e.event)).every((e) => e.job === J));
});

test('console: workflow run templates follow the workflow sources and their configs', () => {
  const RS = require('../cli/core/run-steps');
  const src = (f) => fs.readFileSync(path.join(F.PLUGIN, 'workflows', f), 'utf8');
  // each phase(...) call, as a pattern for the text it prints
  const calls = (f) => [...src(f).matchAll(/phase\((['`])(.*?)\1\)/g)].map((m) => m[2]);
  const pattern = (t) => new RegExp(`^${t.replace(/[.*+?^()|[\]\\]/g, '\\$&').replace(/\\?\$\{[^}]*\}/g, '.+')}$`);
  const sample = (t, cfg) => t.replace(/\$\{brief\.config\}/g, cfg).replace(/\$\{[^}]*\}/g, '1');
  const byTemplate = {};
  for (const t of calls('fanout-judge.js')) {
    const cfgs = t.startsWith('${brief.config}') ? ['decide', 'challenge'] : [t.split(':')[0]];
    for (const c of cfgs) (byTemplate[`fanout-judge:${c}`] = byTemplate[`fanout-judge:${c}`] || []).push(t.replace('${brief.config}', c));
  }
  for (const w of ['ground', 'decompose', 'realize', 'reconcile']) byTemplate[w] = calls(`${w}.js`);
  // clarify v3 runs its own workflow, one stage per run; the phase texts come from the CLI's stage plan
  // (workflows/clarify.js prints them as `clarify: <text>`), checked below
  delete byTemplate.distill;
  assert.deepEqual(Object.keys(RS.TEMPLATES).sort(), [...Object.keys(byTemplate), 'clarify', 'distill'].sort(), 'a template per workflow config, clarify and distill');
  for (const [k, texts] of Object.entries(byTemplate)) {
    const tpl = RS.TEMPLATES[k];
    const cfg = k.split(':')[1];
    // every phase the source prints has a step, and the steps are in the order the source first prints them
    const order = texts.map((t) => RS.matchStep(tpl, sample(t, cfg)));
    assert.ok(order.every((i) => i >= 0), `${k}: ${texts.join(' | ')}`);
    assert.deepEqual([...new Set(order)], [...new Set(order)].slice().sort((a, b) => a - b), `${k}: the steps in source order`);
    assert.deepEqual([...new Set(order)].sort(), tpl.steps.map((_, i) => i), `${k}: every step is one the source prints`);
    // the text a step writes when it is worked out from the agents is one the source would print
    const run = { mode: 'plan', plan: { waves: [['T1', 'T2']] } };
    tpl.steps.forEach((st, i) => {
      for (const n of [1, 3]) for (const nth of [1, 2]) {
        const text = st.text(n, nth, run, 0);
        assert.equal(RS.matchStep(tpl, text), i, `${k}/${st.key}: "${text}" is its own step`);
        assert.ok(texts.some((t) => pattern(t).test(text)) || (k === 'fanout-judge:challenge' && st.key === 'verify' && text === 'challenge: verify findings'), `${k}/${st.key}: "${text}" reads as the source's phase text`);
      }
    });
  }
  // the roles each step names are the agents the configs and briefs start there
  const cfg = (n) => JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'config', 'workflows', `${n}.json`), 'utf8'));
  const roles = (k, key) => RS.TEMPLATES[k].steps.find((s) => s.key === key).roles.slice().sort();
  const cl = cfg('clarify').agents;
  const cs = fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'clarify.js'), 'utf8');
  const ph = [...(/const PH = \{([^\n]*)\};/.exec(cs) || ['', ''])[1].matchAll(/'([^']+)'\]/g)].map((m) => m[1]);
  assert.equal(ph.length, 5, ph.join(' | '));
  assert.match(cs, /'research brief' : `research \(\$\{/);
  for (const t of [...ph, 'research brief', 'research (repo, docs)', 'research (repo)', 'research (docs)']) assert.ok(RS.matchStep(RS.TEMPLATES.clarify, `clarify: ${t}`) >= 0, `clarify: "${t}" has a template step`);
  assert.match(src('clarify.js'), /phase\(`clarify: \$\{\(brief\.phases/, 'the clarify workflow prints the CLI\'s phase texts');
  RS.TEMPLATES.clarify.steps.forEach((st, i) => assert.equal(RS.matchStep(RS.TEMPLATES.clarify, st.text(1, 1, { plan: { modes: ['repo', 'docs'] } })), i, `clarify/${st.key} is its own step`));
  assert.deepEqual(roles('clarify', 'readback'), [cl.interviewer.role]);
  assert.deepEqual(roles('clarify', 'research'), [...new Set([cl.repo.role, cl.docs.role])]);
  assert.deepEqual(roles('clarify', 'brief'), [cl.brief.role]);
  assert.deepEqual(roles('clarify', 'write'), [cl.writer.role]);
  assert.deepEqual(roles('clarify', 'check'), [cl.check.role]);
  const de = cfg('decide');
  assert.deepEqual(roles('fanout-judge:decide', 'fanout'), [...new Set(de.fanout.map((f) => f.role))].sort());
  assert.deepEqual(roles('fanout-judge:decide', 'architect'), [de.judge.role]);
  assert.deepEqual(roles('fanout-judge:decide', 'god-eye'), [de.critique.role]);
  assert.deepEqual(roles('fanout-judge:decide', 'revise'), [de.critique.revise_role]);
  const ch = cfg('challenge');
  assert.deepEqual(roles('fanout-judge:challenge', 'fanout'), [...new Set(Object.values(ch.lanes))].sort());
  assert.deepEqual(roles('fanout-judge:challenge', 'verify'), [ch.verifier.role]);
  // and every role a step names is a factory agent
  for (const t of Object.values(RS.TEMPLATES)) for (const s of t.steps) for (const r of s.roles) assert.ok(fs.existsSync(path.join(F.PLUGIN, 'agents', `${r}.md`)), r);
  // the agents the workflow sources start for ground, decompose, realize and reconcile
  const types = (f) => [...src(f).matchAll(/brief\.(\w+)/g)].map((m) => m[1]);
  assert.ok(types('ground.js').includes('probes') && types('reconcile.js').includes('integrator') && types('realize.js').includes('waves'));
});

test('console page: one data slot, self-contained, and a static file says it is a snapshot', () => {
  const tpl = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  assert.equal(tpl.split('/*__FACTORY_DATA__*/null').length, 2, 'exactly one data slot');
  assert.ok(!/<script[^>]+src=/i.test(tpl), 'no external scripts: one self-contained page');
  assert.ok(tpl.includes("'snapshot'"), 'the page has a snapshot state for a static file');
  const { render } = require('../cli/core/console');
  const html = render({ generated_at: '2030-01-01T00:00:00.000Z', project: 'p', integrity: { status: 'not_checked' }, jobs: [{ id: 'J-0001', title: '</script><script>alert(1)</script>', rev: 'x', timeline: [], steps: [] }] });
  assert.ok(html.includes('"live":false'), 'a written file is not live');
  assert.ok(!html.includes('</script><script>alert'), 'data cannot close the script tag');
  assert.ok(!html.includes('/*__FACTORY_DATA__*/'), 'the slot is filled');
});

test('console page: console.html is built from console/src (node console/build.js) and is current', () => {
  const { build } = require('../console/build');
  const built = build();
  const shipped = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  assert.ok(built === shipped, 'console.html is stale: run node console/build.js');
  const manifest = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'console', 'src', 'manifest.json'), 'utf8'));
  const listed = new Set([...manifest.styles, ...manifest.scripts]);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const src = path.join(F.PLUGIN, 'console', 'src');
  for (const f of walk(src).map((x) => path.relative(src, x).split(path.sep).join('/'))) {
    if (/\.(css|js)$/.test(f)) assert.ok(listed.has(f), `${f} is in src/manifest.json`);
  }
});

test('console: a review round carries the CLI lane verdicts and each finding\'s verifier word; unverified findings read as blocking', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Bulk', '--type', 'feature', '--risk', 'low']).job;
  const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();
  const ledger = path.join(F.jobDir(root, J), 'ledger.jsonl');
  // review.js's own shape: an unverifiable verdict leaves status 'unverified' and sets verifier + evidence
  fs.appendFileSync(ledger, [
    { job: J, at: at(1), kind: 'agents', workflow: 'fanout-judge', config: 'challenge', decision_id: `${J}-D0009`, status: 'ok', agents: [{ label: 'review code', agent_type: 'factory:code-reviewer', model: 'sonnet', outcome: 'ok' }, { label: 'verify code-1', agent_type: 'factory:finding-verifier', model: 'sonnet', outcome: 'unverifiable' }] },
    { job: J, at: at(2), kind: 'step', step: 'challenge', ok: false, detail: { round: 1, required: ['code', 'tests'], lanes: { code: 'changes', tests: 'pass' }, missing: [], findings: [
      { id: 'code-1', lane: 'code', severity: 'major', status: 'unverified', verifier: 'unverifiable', verification: 'Could not build the fixture.', evidence: ['ran the tests: ok', 'read src/a.js:3'], file: 'src/a.js', line: 3, summary: 'Loads every id into memory' },
      { id: 'code-2', lane: 'code', severity: 'blocker', status: 'refuted', verification: 'The loop is bounded.', summary: 'Unbounded loop' },
      { id: 'tests-1', lane: 'tests', severity: 'minor', status: 'minor', summary: 'Small fixture' },
    ] } },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  const { build } = require('../cli/core/console');
  const data = build(root, { now: at(30) });
  const job = data.jobs.find((j) => j.id === J);
  const r = job.timeline.find((t) => t.type === 'result' && t.raw_step === 'challenge');
  assert.match(r.text, /1 unverified, blocking/, 'the round text counts unverified serious findings');
  assert.deepEqual(r.lanes, { code: 'changes', tests: 'pass' }, 'the CLI lane verdicts are carried, not re-parsed from text');
  assert.deepEqual(r.required, ['code', 'tests']);
  assert.deepEqual(r.missing, []);
  assert.equal(r.round, 1);
  const f = r.findings.find((x) => x.id === 'code-1');
  assert.equal(f.status, 'unverified');
  assert.equal(f.verifier, 'unverifiable');
  assert.equal(f.verification, 'Could not build the fixture.');
  assert.deepEqual(f.evidence, ['ran the tests: ok', 'read src/a.js:3']);
  assert.equal(r.findings.find((x) => x.id === 'code-2').verifier, undefined, 'a confirmed or refuted verdict lives in status');
  assert.deepEqual(job.review_lanes, ['code', 'tests'], 'the lanes the last review required');
  const state = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'state.json'), 'utf8'));
  assert.equal(job.limits.max_review_rounds, state.policy.limits.max_review_rounds, 'the job\'s policy limits are in the data');
  assert.equal(job.lessons_max, state.policy.lessons_max_per_job);
  const ag = job.timeline.find((t) => t.type === 'agents').agents.find((a) => a.label === 'verify code-1');
  assert.equal(ag.outcome, 'unverifiable');
  // the page: the Story names the unverified finding as blocking, with the verifier's word
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  assert.match(html, /Unverified \$\{esc\(f\.severity\)\} finding \$\{esc\(f\.id\)\}, still blocking/);
  assert.match(html, /function verifierNote\(f\)[\s\S]{0,200}f\.verifier === 'unverifiable'/);
});

test('console: lessons carry scope and your decision; a job without a review still knows its lanes', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Lanes', '--type', 'feature', '--risk', 'medium']).job;
  F.cli(root, ['lessons', 'add', '--job', J, '--text', 'Validate ids at the boundary', '--scope', 'src/**']);
  const doc = path.join(root, '.factory', 'lessons', 'lessons.json');
  const L = JSON.parse(fs.readFileSync(doc, 'utf8'));
  Object.assign(L.lessons[0], { status: 'accepted', decided_at: '2030-01-01T10:00:00.000Z', reason: 'yes' });
  fs.writeFileSync(doc, JSON.stringify(L));
  const { build } = require('../cli/core/console');
  const job = build(root).jobs.find((j) => j.id === J);
  assert.deepEqual(job.lessons.map((l) => [l.id, l.status, l.scope, l.decided_at, l.reason]), [['L1', 'accepted', ['src/**'], '2030-01-01T10:00:00.000Z', 'yes']]);
  assert.ok(job.lessons[0].created_at);
  const state = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'state.json'), 'utf8'));
  for (const l of state.policy.required_lanes.medium) assert.ok(job.review_lanes.includes(l), `${l} is required before any review ran`);
});

test('console page: the Crew\'s tools are each agent file\'s own tools: line, with Claude Code tool names', () => {
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  const m = /const AGENT_TOOLS = (\{.*?\});/.exec(html);
  assert.ok(m, 'console.html carries AGENT_TOOLS');
  const shown = JSON.parse(m[1]);
  const dir = path.join(F.PLUGIN, 'agents');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.deepEqual(Object.keys(shown).sort(), files.map((f) => f.replace(/\.md$/, '')).sort(), 'one entry per agent file');
  for (const f of files) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(dir, f), 'utf8'))[1];
    const tools = /^tools:\s*(.+)$/m.exec(fm)[1].split(',').map((t) => t.trim()).filter(Boolean);
    assert.deepEqual(shown[f.replace(/\.md$/, '')], tools, `${f}: the console shows the file's tools`);
    for (const t of tools) assert.match(t, /^[A-Z][A-Za-z]+$/, `${f}: ${t} is a Claude Code tool name`);
  }
  const src = fs.readFileSync(path.join(F.PLUGIN, 'console', 'src', 'js', 'definitions.js'), 'utf8');
  const table = src.slice(src.indexOf('const AGENTS'), src.indexOf('\n};', src.indexOf('const AGENTS')));
  assert.ok(!/'(Read|Grep|Glob|Bash|Write|Edit|WebFetch|WebSearch)'/.test(table), 'no hand-written tool list left in definitions.js');
  for (const a of Object.keys(shown)) assert.ok(table.includes(`'${a}':`), `Crew lists ${a}`);
  assert.match(src, /'finding-verifier': \[[^\]]*unverifiable/, 'the finding-verifier says what unverifiable does');
  assert.ok(!/at most (three|3)[^.]*lessons|At most 3 general/i.test(src), 'no stale lesson cap');
});

test('console page: agent outcomes get bad, warn, good or neutral, never good by default', () => {
  const vm = require('vm');
  const ctx = { window: {} };
  vm.runInNewContext(`${fs.readFileSync(path.join(F.PLUGIN, 'console', 'src', 'js', 'job-line', 'data.js'), 'utf8')}\nthis.outcomeClass = outcomeClass;`, ctx);
  for (const o of ['failed', 'error', 'no_result', 'fail', 'blocked', 'exhausted']) assert.equal(ctx.outcomeClass(o), 'bad', o);
  for (const o of ['unverifiable', 'revise', 'skipped_dependency']) assert.equal(ctx.outcomeClass(o), 'warn', o);
  for (const o of ['approve', 'pass', 'done', 'merged']) assert.equal(ctx.outcomeClass(o), 'good', o);
  for (const o of ['ok', 'confirmed', 'refuted', 'something-new', null]) assert.equal(ctx.outcomeClass(o), '', String(o));
});

test('console page: the one script parses, and the Blueprint view is in it', () => {
  const vm = require('vm');
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  assert.doesNotThrow(() => new vm.Script(js), 'console.html has a syntax error');
  assert.match(html, /id="nav-blueprint" data-view="blueprint"/);
  assert.match(html, /<section id="view-blueprint"/);
  assert.match(html, /APP\.displays\.register\(\{\s*id: "blueprint"/);
});

// the Blueprint reads a walk through states; toDisplay folds the factory's timeline into one
const blueprintAdapter = () => {
  const vm = require('vm');
  const src = fs.readFileSync(path.join(F.PLUGIN, 'console', 'src', 'js', 'blueprint', 'adapter.js'), 'utf8');
  const ctx = {};
  vm.runInNewContext(`${src}\nthis.toDisplay = toDisplay;`, ctx);
  return (data) => JSON.parse(JSON.stringify(ctx.toDisplay(data))); // plain objects of this realm, for deepEqual
};
const at = (m) => new Date(Date.UTC(2030, 0, 1, 9, m)).toISOString();
const route = (m, step) => ({ t: at(m), type: 'route', step, raw_step: step, rule: 'r' });
const bpJob = (id, extra) => ({ id, title: `job ${id}`, work_type: 'feature', risk: 'low', status: 'active', created_at: at(0), updated_at: at(50), tasks: [], lessons: [], steps: [], timeline: [], ...extra });

test('console blueprint: each workflow run goes to its station\'s bank, folded by the same run-steps.js the page carries', () => {
  const toDisplay = blueprintAdapter();
  const run = (id, workflow, config, step, extra) => ({ id, workflow, config, step, started_at: at(10), ended_at: null, status: 'running', phases: [], agents: [], plan: { steps: {} }, ...extra });
  const d = toDisplay({ generated_at: at(60), project: 'p', jobs: [bpJob('J-0001', { runs: [
    run('a', 'fanout-judge', 'clarify', 'clarify'), run('b', 'ground', null, 'ground'), run('c', 'fanout-judge', 'decide', 'decide'), run('d', 'decompose', null, 'decompose'),
    run('e', 'realize', null, 'realize'), run('f', 'reconcile', null, 'reconcile'), run('g', 'fanout-judge', 'challenge', 'challenge'), run('h', 'fanout-judge', 'challenge', 'post_merge_challenge', { mode: 'post_merge' }),
    run('i', 'distill', null, 'distill'), run('k', 'fanout-judge', 'challenge', null), run('x', 'fanout-judge', 'clarify', 'clarify', { started_at: null }),
  ] }), bpJob('J-0002', {})] });
  assert.deepEqual(d.jobs[0].runs.map((r) => [r.id, r.station]), [['a', 'intent'], ['b', 'design'], ['c', 'design'], ['d', 'plan'], ['e', 'build'], ['f', 'build'], ['g', 'review'], ['h', 'ship'], ['i', 'done'], ['k', 'review']], 'by the recipe step it ran for, else by workflow; a run with no start is dropped');
  assert.deepEqual(d.jobs[0].runs[0].plan, { steps: {} }, 'the plan goes with the run: the page folds the steps from it too');
  assert.deepEqual(d.jobs[1].runs, [], 'older data: no runs, the bank keeps its lamps');
  // the page carries the CLI's run-steps.js verbatim, before the Blueprint that reads it
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  const rs = fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'run-steps.js'), 'utf8');
  assert.ok(html.includes(rs), 'run-steps.js is in the page');
  assert.ok(html.indexOf(rs) < html.indexOf('APP.displays.register({'), 'before the Blueprint');
  const vm = require('vm');
  const ctx = {};
  vm.runInNewContext(`${rs}\nthis.R = RUN_STEPS;`, ctx);
  assert.deepEqual(Object.keys(ctx.R.TEMPLATES), Object.keys(require('../cli/core/run-steps').TEMPLATES), 'as a classic script it defines RUN_STEPS');
});

test('console blueprint: gates wait on you with the reply the prompt hook applies and the terminal command', () => {
  const toDisplay = blueprintAdapter();
  const human = require('../cli/core/human');
  const d = toDisplay({ generated_at: at(60), project: 'p', jobs: [
    bpJob('J-0001', { pending_gate: { id: 'H1', at: at(5) }, timeline: [route(1, 'clarify'), route(5, 'H1')] }),
    bpJob('J-0002', { pending_gate: { id: 'HS', at: at(9) }, timeline: [route(1, 'clarify'), route(3, 'realize'), route(5, 'prove'), route(7, 'challenge'), route(8, 'ship'), route(9, 'HS')] }),
    bpJob('J-0003', { status: 'parked', park: { reason: 'cap', at: at(4) }, timeline: [route(1, 'clarify'), { t: at(4), type: 'park', text: 'cap', from: 'clarify' }] }),
    bpJob('J-0004', { pending_gate: { id: 'H4', at: at(9) }, timeline: [route(1, 'ship'), route(9, 'H4')] }),
    bpJob('J-0009', { epic: true, pending_gate: { id: 'EH1', at: at(7) } }),
  ] });
  // an epic is not drawn, but one waiting at a gate is your turn, as on the Board
  assert.deepEqual(d.epic_jobs.map((e) => [e.id, e.gate, e.reply.split(' · ')[0]]), [['J-0009', 'EH1', 'approve J-0009 EH1']]);
  const [a, b, p, m] = d.jobs;
  assert.equal(a.state, 'awaiting_intent_approval');
  assert.deepEqual(a.history.map((h) => h.to), ['intent', 'awaiting_intent_approval']);
  assert.equal(a.waiting_on.who, 'you');
  assert.equal(a.waiting_on.reply.split(' · ')[0], 'approve J-0001 H1');
  assert.equal(a.waiting_on.command, 'factory approve H1 --job J-0001');
  assert.equal(b.state, 'awaiting_ship_approval');
  assert.equal(b.waiting_on.gate, 'HS');
  assert.equal(p.waiting_on.gate, 'P');
  assert.equal(p.waiting_on.command, 'factory resume --job J-0003');
  assert.equal(m.waiting_on.gate, 'H4');
  assert.equal(m.waiting_on.command, 'factory merged <commit> --job J-0004');
  // every chat reply the drawing offers is one the prompt hook applies (placeholders filled in)
  for (const j of d.jobs.map((x) => x.waiting_on).concat(d.epic_jobs)) {
    for (const r of j.reply.split(' · ')) {
      const filled = r.replace('<commit>', 'abc1234').replace('<what must change>', 'cover zero');
      assert.ok(human.parseReply(filled), `"${r}" is a reply the hook applies`);
    }
  }
  for (const s of d.stages.concat(d.side_lanes)) for (const x of s.states) assert.ok(d.meaning[x], `${x} has a meaning`);
});

test('console: clarify v3 — items with who decided them, findings with source and verdict (another version never used), gaps and the stage line per step', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'medium', '--request', 'fix add on nautobot 2.4 so the cart totals add up']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  const NB = 'https://docs.nautobot.com/projects/core/en';
  const stage = (outputs) => {
    const brief = F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
    const out = {};
    for (const g of brief.groups) for (const a of g) out[a.label] = outputs(a, brief);
    return F.record(root, F.envelope(brief, 'ok', { stage: brief.stage, rev: brief.rev, outputs: out }));
  };
  assert.equal(F.cli(root, ['next']).clarify.stage, 'readback');
  stage(() => ({ intent: { problem: 'add subtracts', who: 'the cart', outcome: 'add sums', success: 'the test passes' }, scope: { in: ['add'], out: [] }, took: [], pins: [{ system: 'nautobot', version: '2.4', source: 'user', quote: 'nautobot 2.4' }], plan: [{ item: 'new', what: 'Where is add and what does it do?', tag: 'repo', pins: [], impact: 'high' }, { item: 'new', what: 'Does Nautobot scope VLANs by location?', tag: 'docs', pins: ['nautobot'], impact: 'high' }], questions: [], design_may_choose: [] }));
  F.cli(root, ['clarify', 'reply', 'ok'], { allowFail: false });
  assert.equal(F.cli(root, ['next']).clarify.stage, 'research');
  stage((a) => {
    if (a.label === 'research · repo') return { mode: 'repo', versions: [], evidence: [{ plan: 'P-1', claim: 'add is in src/add.js and subtracts', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b;', confidence: 'high' }], unresolved: [] };
    if (a.label === 'research · docs') return { mode: 'docs', web_available: true, versions: [], evidence: [
      { plan: 'P-2', claim: 'Nautobot 2.4 VLAN groups can be assigned to a location', source: `${NB}/v2.4.4/user-guide/core-data-model/ipam/vlangroup/`, source_tier: 'official', system: 'nautobot', version: '2.4.4', quote: 'A VLAN group may be assigned to a location.', retrieved_at: '2026-10-14', confidence: 'high' },
      { plan: 'P-2', claim: 'Nautobot 3 VLANs have many locations', source: `${NB}/stable/user-guide/core-data-model/ipam/vlan/`, source_tier: 'official', system: 'nautobot', version: '3.0', quote: 'A VLAN may be assigned to multiple locations.', retrieved_at: '2026-10-14', confidence: 'high' },
    ], unresolved: [] };
    return { summary: 's', records: [], facts: [{ plan: 'P-1', statement: 'add is in src/add.js and subtracts', evidence: ['src/add.js:1'] }, { plan: 'P-2', statement: 'VLAN groups can be assigned to a location', evidence: [`${NB}/v2.4.4/user-guide/core-data-model/ipam/vlangroup/`, `${NB}/stable/user-guide/core-data-model/ipam/vlan/`] }], gaps: [] };
  });
  assert.equal(F.cli(root, ['next']).clarify.stage, 'sheet_wait');
  const dataFile = path.join(os.tmpdir(), `console-clarify-${process.pid}-${Date.now()}.json`);
  F.cli(root, ['console', '--out', `${dataFile}.html`, '--data', dataFile]);
  let job = JSON.parse(fs.readFileSync(dataFile, 'utf8')).jobs.find((j) => j.id === J);
  const c = job.clarify;
  assert.equal(c.version, 3);
  assert.equal(c.stage, 'sheet_wait');
  assert.equal(c.waiting_for_user, true);
  assert.deepEqual(c.evidence.map((e) => [e.source.replace(NB, ''), e.verdict, e.usable]), [
    ['src/add.js:1', 'repo', true],
    ['/v2.4.4/user-guide/core-data-model/ipam/vlangroup/', 'pinned', true],
    ['/stable/user-guide/core-data-model/ipam/vlan/', 'unpinned', false],
  ], 'a moving page (stable) is shown, and never used for the confirmed 2.4');
  assert.deepEqual(c.pins.map((p) => [p.text, p.by]), [['nautobot 2.4', 'you']]);
  assert.ok(c.items.some((it) => it.kind === 'fact' && it.by === 'evidence'), 'facts research settled say so');
  const lines = job.timeline.filter((t) => t.type === 'clarify');
  assert.deepEqual(lines.map((t) => t.outcome), ['readback_wait', 'research', 'sheet_wait']);
  assert.ok(lines.every((t) => t.step === 'clarify'));
  assert.equal(lines[2].waiting, true);
  assert.match(lines[2].text, /Decision sheet ready; waiting for your answer/);
  // the rest of clarify: ok, contract, readiness → H1, and the result line says so
  F.cli(root, ['clarify', 'reply', 'ok'], { allowFail: false });
  F.clarify(root);
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.cli(root, ['console', '--out', `${dataFile}.html`, '--data', dataFile]);
  job = JSON.parse(fs.readFileSync(dataFile, 'utf8')).jobs.find((j) => j.id === J);
  assert.match(job.timeline.find((t) => t.type === 'result' && t.step === 'clarify').text, /Contract passed its readiness check after 1 research pass/);
  assert.ok(job.h1 && Array.isArray(job.h1.decisions), 'H1 carries the decisions, gaps, drops and objections');
  // the page knows the clarify v3 roles and renders the clarify block and its stage lines
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  for (const role of ['interviewer', 'brief-writer', 'contract-writer']) assert.match(html, new RegExp(`'${role}': \\['Clarify'`));
  for (const role of ['intent-analyst', 'judge', 'contract-editor']) assert.ok(!html.includes(`'${role}': ['Clarify'`), `${role} is retired`);
  assert.match(html, /P\('read-back', 'agent', 'interviewer'\)[\s\S]*P\('research brief', 'agent', 'brief-writer'\)[\s\S]*P\('readiness', 'agent', 'god-eye'\)/);
  assert.match(html, /function clarifyHtml/);
  assert.match(html, /case 'clarify':/);
  assert.ok(!/factory run clarify/.test(html), 'this factory has no factory run: clarify runs through wfargs and the Workflow tool');
});

test('console blueprint: clarify\'s questions wait on you (Q) until the next clarify round, as the Board\'s Your turn', () => {
  const toDisplay = blueprintAdapter();
  const human = require('../cli/core/human');
  // what cli/core/console.js makes of a clarify result that asked questions
  const ask = (m, ids) => ({ t: at(m), type: 'result', step: 'clarify', raw_step: 'clarify', ok: false, outcome: 'ask', text: `${ids.length} question(s) for you (scope)`, categories: ['scope'], held: 0, question_ids: ids });
  const d = toDisplay({ generated_at: at(60), project: 'p', jobs: [
    bpJob('J-0001', { timeline: [route(1, 'clarify'), ask(3, ['Q-1', 'Q-2'])] }),
    bpJob('J-0002', { timeline: [route(1, 'clarify'), ask(3, ['Q-1']), route(9, 'clarify'), { t: at(12), type: 'result', step: 'clarify', raw_step: 'clarify', ok: true, outcome: 'ok', text: 'Contract judged clear' }, route(13, 'H1')], pending_gate: { id: 'H1', at: at(13) } }),
    bpJob('J-0003', { timeline: [route(1, 'clarify'), ask(3, ['Q-1']), { t: at(5), type: 'park', text: 'waiting on infra', from: 'manual' }, { t: at(8), type: 'human', action: 'resume' }] }),
    bpJob('J-0009', { epic: true, timeline: [route(1, 'clarify'), ask(4, ['Q-1', 'Q-2', 'Q-3', 'Q-4'])] }),
  ] });
  const [a, b, c] = d.jobs;
  assert.equal(a.state, 'awaiting_answers');
  assert.deepEqual(a.history.map((h) => [h.to, h.by, h.reason]), [['intent', 'router', 'rule r'], ['awaiting_answers', 'router', 'clarify asked 2 question(s)']]);
  assert.equal(a.waiting_on.who, 'you');
  assert.equal(a.waiting_on.gate, 'Q');
  assert.equal(a.waiting_on.answer, '1 <your answer>, 2 <your answer>');
  assert.match(a.waiting_on.hint, /Q-1, Q-2 by number/);
  assert.equal(a.waiting_on.command, null, 'there is no terminal command for answering');
  // the answer is ordinary chat for Claude (skill clarify: "1 yes, skip 2"), so the prompt hook must not swallow it
  for (const w of [a.waiting_on.answer, '1 yes, skip 2']) assert.equal(human.parseReply(w), null, `"${w}" reaches Claude`);
  assert.ok(d.stages.find((s) => s.key === 'intent').states.includes('awaiting_answers'), 'it waits at the Contract station');
  assert.ok(d.meaning.awaiting_answers);
  // the next route back into clarify is your answer, not the router's move
  assert.deepEqual(b.history.map((h) => h.to), ['intent', 'awaiting_answers', 'intent', 'awaiting_intent_approval']);
  const back = b.history[2];
  assert.equal(back.by, 'you');
  assert.equal(back.reason, 'you answered');
  assert.equal(b.waiting_on.gate, 'H1');
  // parked while it waited: resume goes back to clarify for another round, as the Board shows it running again
  assert.deepEqual(c.history.map((h) => h.to), ['intent', 'awaiting_answers', 'parked', 'intent']);
  assert.equal(c.waiting_on.who, 'agent');
  // an epic whose clarify asked is your turn too, with the answer and no gate reply
  const e = d.epic_jobs[0];
  assert.equal(e.gate, 'Q');
  assert.equal(e.gate_at, at(4));
  assert.equal(e.reply, null);
  assert.equal(e.answer, '1 <your answer>, 2 <your answer>, … 4 <your answer>');
  assert.equal(human.parseReply(e.answer), null);
  // clarify v3: its stage lines (cli/core/console.js, kind clarify) wait on one reply to the screen shown
  const cl = (m, outcome, waiting) => ({ t: at(m), type: 'clarify', step: 'clarify', stage: outcome, outcome, text: outcome, waiting });
  const v3 = toDisplay({ generated_at: at(60), project: 'p', jobs: [
    bpJob('J-0004', { timeline: [route(1, 'clarify'), cl(2, 'readback_wait', true)] }),
    bpJob('J-0005', { timeline: [route(1, 'clarify'), cl(2, 'readback_wait', true), cl(4, 'research', false), cl(6, 'sheet_wait', true)] }),
  ] });
  const [rb, sh] = v3.jobs;
  assert.equal(rb.state, 'awaiting_answers');
  assert.equal(rb.waiting_on.gate, 'Q');
  assert.equal(rb.waiting_on.answer, 'ok');
  assert.match(rb.waiting_on.hint, /what to change/);
  assert.deepEqual(sh.history.map((h) => [h.to, h.by]), [['intent', 'router'], ['awaiting_answers', 'router'], ['intent', 'you'], ['awaiting_answers', 'router']], 'your ok moved clarify on; the sheet waits on you again');
  assert.match(sh.waiting_on.hint, /ok, but 2 b/);
  assert.equal(human.parseReply(sh.waiting_on.answer), null, 'ok reaches the clarify reply path, not the gate replies');
});

test('console blueprint: park and resume, a failed proof sent back to Build, stops and closes', () => {
  const toDisplay = blueprintAdapter();
  const d = toDisplay({ generated_at: at(60), project: 'p', jobs: [
    bpJob('J-0001', { timeline: [route(1, 'decide'), { t: at(2), type: 'park', text: 'waiting on infra', from: 'manual' }, { t: at(9), type: 'human', action: 'resume' }, route(10, 'H2')], pending_gate: { id: 'H2', at: at(10) } }),
    bpJob('J-0002', { timeline: [route(1, 'realize'), route(2, 'prove'), { t: at(3), type: 'result', raw_step: 'prove', ok: false, acs: { 'AC-1': 'failed' } }, route(4, 'realize'), route(5, 'prove')] }),
    bpJob('J-0003', { status: 'cancelled', timeline: [route(1, 'clarify'), { t: at(4), type: 'stopped', text: 'not needed' }] }),
    bpJob('J-0004', { status: 'closed', closed_at: at(30), timeline: [route(1, 'clarify'), route(20, 'distill')], tasks: [{ id: 'T1', objective: 'o', depends_on: [], attempts: 1, outcome: 'done', pass: true }] }),
    bpJob('J-0005', { epic: true, timeline: [route(1, 'clarify')] }),
    bpJob('J-0006', { status: 'abandoned', timeline: [route(1, 'realize'), { t: at(6), type: 'stopped', text: 'superseded' }] }),
  ] });
  const by = Object.fromEntries(d.jobs.map((j) => [j.id, j]));
  assert.deepEqual(by['J-0001'].history.map((h) => h.to), ['designing', 'parked', 'designing', 'awaiting_design_approval'], 'resume goes back where it parked');
  assert.equal(by['J-0002'].rework_loops, 1, 'verifying → building is one trip back');
  assert.deepEqual(by['J-0002'].criteria, [{ id: 'AC-1', text: '', status: 'failed', tasks: [] }]);
  assert.equal(by['J-0003'].state, 'cancelled');
  assert.equal(by['J-0003'].waiting_on.who, 'nobody');
  assert.equal(by['J-0006'].state, 'abandoned');
  assert.ok(d.side_lanes.find((s) => s.key === 'stopped').states.includes('abandoned'), 'cancelled and abandoned sit on the Stopped side track');
  assert.equal(by['J-0004'].state, 'closed');
  assert.equal(by['J-0004'].tasks[0].status, 'passing');
  assert.ok(!by['J-0005'], 'an epic is not a job on the line');
});

test('console blueprint: lane verdicts from the data, unverified findings block, rounds from policy, learn is not merged', () => {
  const toDisplay = blueprintAdapter();
  const ch = (m, round, lanes, findings, text) => ({ t: at(m), type: 'result', step: 'challenge', raw_step: 'challenge', ok: false, round, lanes, required: Object.keys(lanes), missing: [], findings, text });
  const d = toDisplay({ generated_at: at(60), project: 'p', checks: [{ cmd: 'npm run lint:ids', from_lesson: 'L2' }], jobs: [
    bpJob('J-0001', { review_lanes: ['code', 'tests'], limits: { max_review_rounds: 5 }, timeline: [route(1, 'challenge'),
      { t: at(2), type: 'agents', agents: [{ role: 'code-reviewer', model: 'sonnet' }, { role: 'finding-verifier', model: 'sonnet', outcome: 'unverifiable' }] },
      // the text says nothing parseable: the verdicts come from `lanes`; the finding is review.js's unverifiable shape
      ch(3, 2, { code: 'changes', tests: 'pass' }, [{ id: 'code-1', lane: 'code', severity: 'major', status: 'unverified', verifier: 'unverifiable', verification: 'no fixture', evidence: ['ran it', 'read a.js'], summary: 's' }], 'Round two')] }),
    bpJob('J-0002', { status: 'closed', closed_at: at(30), timeline: [route(1, 'clarify'), route(5, 'H1'), { t: at(6), type: 'human', action: 'approve', gate: 'H1', step: 'H1', via: 'chat' }, route(7, 'ground'), route(20, 'distill'), route(25, 'close')],
      lessons: [{ id: 'L2', status: 'promoted', text: 'Check ids', scope: ['src/**'], created_at: at(21), decided_at: at(22), reason: 'yes' }] }),
    bpJob('J-0003', { work_type: 'spike', status: 'active', timeline: [route(1, 'decide'), route(5, 'close')] }),
    bpJob('J-0004', { epic: true, title: 'Big epic', children: ['J-0005'] }),
    bpJob('J-0005', { parent: 'J-0004', steps: [{ id: 'post_merge_challenge', lanes: ['code', 'security'] }], timeline: [route(1, 'clarify')] }),
  ] });
  const [a, b, c, s] = d.jobs;
  const code = a.reviews.find((r) => r.lane === 'code');
  assert.equal(code.verdict, 'changes');
  assert.equal(code.unverified, 1, 'an unverified serious finding blocks its lane');
  assert.equal(code.findings[0].status, 'unverified');
  assert.equal(code.findings[0].verifier, 'unverifiable');
  assert.equal(code.findings[0].verification, 'no fixture');
  assert.equal(code.findings[0].evidence, 'ran it; read a.js');
  assert.equal(code.model, 'sonnet', 'the reviewer\'s model comes from the roster');
  assert.equal(a.reviews.find((r) => r.lane === 'tests').verdict, 'pass');
  assert.deepEqual(a.required_lanes, ['code', 'tests']);
  assert.equal(a.review_round, 2);
  assert.equal(a.max_review_rounds, 5, 'rounds are capped by the job\'s policy, not a fixed number');
  assert.ok(!b.history.some((h) => h.to === 'merged'), 'a job that distils without a merge never passes through Merged');
  assert.ok(b.history.some((h) => h.to === 'learning'), 'distill is the Learn station');
  const appr = b.history.find((h) => h.from === 'awaiting_intent_approval');
  assert.equal(appr.by, 'you', 'your approval moves the job off H1, not the router');
  assert.match(appr.reason, /you approved H1/);
  assert.equal(c.state, 'learning', 'a spike closing sits at Learn, not Merged');
  assert.deepEqual(s.post_merge_lanes, ['code', 'security'], 'the post-merge challenge lanes come from the job\'s recipe steps');
  assert.equal(s.epic, 'J-0004', 'a slice knows its epic');
  assert.ok(!d.jobs.some((j) => j.id === 'J-0004'), 'an epic is not a job on the line');
  assert.deepEqual(d.epic_jobs.map((e) => e.id), ['J-0004'], 'but it is listed, so the drawing can say so');
  assert.deepEqual(d.lessons.map((l) => [l.id, l.status, l.decided.status]), [['L2', 'promoted', 'promoted']]);
  assert.deepEqual(d.standards.checks.map((x) => [x.name, x.cmd]), [['from lesson L2', 'npm run lint:ids']], 'the project\'s checks are the checks in force');
  assert.equal(d.autopilot, undefined, 'no Copilot Autopilot here');
  assert.ok(d.stages.find((st) => st.key === 'done').states.includes('learning'));
  assert.ok(d.meaning.learning);
});

test('console blueprint: agent banks are this factory\'s agents and workflows', () => {
  const src = fs.readFileSync(path.join(F.PLUGIN, 'console', 'src', 'js', 'blueprint', 'blueprint.js'), 'utf8');
  const banks = src.slice(src.indexOf('var BANKS = {'), src.indexOf('var STEPS = {'));
  const agents = new Set(fs.readdirSync(path.join(F.PLUGIN, 'agents')).map((f) => f.replace(/\.md$/, '')));
  const roles = [...banks.matchAll(/\["([a-z-]+)", "/g)].map((m) => m[1]);
  assert.ok(roles.length > 5);
  for (const r of roles) assert.ok(agents.has(r), `bank member ${r} is an agent in agents/`);
  // clarify's bank is its crew (config/workflows/clarify.json): the interviewer, the researchers (repo, docs), the
  // brief writer, the contract writer, God Eye (its readiness check)
  const cl = require('../config/workflows/clarify.json').agents;
  assert.match(banks, new RegExp(`intent: \\{ name: "Clarify agents", members: \\[\\["${cl.interviewer.role}", "interviewer"\\], \\["${cl.repo.role}", "researchers · repo, docs"\\], \\["${cl.brief.role}", "brief writer"\\], \\["${cl.writer.role}", "contract writer"\\], \\["${cl.check.role}", "God Eye"\\]\\] \\}`));
  assert.ok(!/intent-analyst|"judge"|contract-editor|scout/.test(banks), 'the clarify v2 crew is retired');
  // the page: no Copilot Autopilot, no claude-software-factory replies, the 0.4.1 fixes in their form here
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  assert.ok(!/autopilot/i.test(html), 'nothing about an Autopilot this factory does not have');
  assert.ok(!/Reply in chat|paste it in chat/.test(html), 'replies go in Claude Code');
  assert.match(html, /html:not\(\[data-theme\]\) \.dx-blueprint\{/, 'auto theme follows a light system (theme.js removes data-theme)');
  assert.ok(!/data-theme="system"/.test(html));
  assert.match(html, /var STOPPED_STATES = \{ cancelled: 1, abandoned: 1 \}/);
  assert.match(html, /findList\.hidden = true; findIn\.blur\(\);/, 'Esc in the find box lets go of the keyboard');
  assert.match(html, /R\.yourTurn = R\.jobs\.filter\(function \(r\) \{ return !r\.done && r\.g && r\.g !== "P"; \}\)/, 'Your turn counts as the Board does: no parked jobs, no lessons');
  assert.match(html, /H1: \{ title: "Approve the contract", short: "contract", tip: "[^"]*\(H1 · contract\)/);
  assert.match(html, /H4: \['H4 · merge', 'Only you merge: on GitHub, or locally and reply merged <commit>/);
  assert.match(html, /function laneState\(j, ln, t, ag\)/, 'detail B and the section view read a lane the same way');
  assert.match(html, /shown on the Board, not on these sheets/, 'epics are named, not silently left out');
});
