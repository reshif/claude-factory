'use strict';
// End to end, with the imperfections of copilot-factory's red-team run (audit e2e.md), through the
// real workflow scripts in the workflow harness: a feature@medium job of five tasks in three
// waves where
//   - T5's builder crashes on its first attempt (returns nothing, its work left uncommitted),
//   - T2 and T3 both add an export to src/index.js (the shared wiring file),
//   - T4's first attempt changes a file outside its allowed paths (a scope violation),
//   - the code reviewer raises a major finding whose verifier times out twice (returns nothing),
//     and the next reviewer does not raise it again.
// Pass: no finding lost (carried, re-verified, confirmed, fixed), no task done without its
// builder, no dropped export, no manual git repair (this test never touches git outside what a
// builder does in its worktree), and the job reaches ship.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');

const next = (root) => F.cli(root, ['next']);
const instructions = (prompt) => {
  const line = prompt.split('\n').find((l) => l.trim().startsWith('/'));
  return line ? fs.readFileSync(line.trim(), 'utf8') : prompt;
};

const CONTRACT = F.contractText({
  goal: 'Rows export as CSV, alerts and a report build on it, add() is fixed, and src/index.js exports all of them.',
  ac: [
    '- AC-1: toCsv([["a","b"]]) returns "a,b" and quotes fields that contain a comma (evidence: test)',
    '- AC-2: alerts and the report use toCsv (evidence: test)',
    '- AC-3: add(2, 3) returns 5 (evidence: test)',
    '- AC-4: src/index.js exports add, csv and alerts (evidence: test)',
  ].join('\n'),
  // clarify v3's readiness check: every test criterion has a verify command
  // (the per-wave check runs a contract command once all its criteria are integrated: each names
  // the test of the task that builds it)
  verify: '`node tests/add.test.js` (AC-3)\n- `node tests/csv.test.js` (AC-1)\n- `node tests/report.test.js` (AC-2)\n- `node tests/index-csv.test.js` (AC-4)',
});
const INDEX_TEST = "const m = require('../src/index');\nfor (const k of ['add', 'csv', 'alerts']) if (!m[k]) { console.error('missing export ' + k); process.exit(1); }\n";

const PLAN = {
  interfaces: [{ name: 'toCsv(rows) -> string', kind: 'function', file: 'src/csv.js', owner: 'T1' }],
  tasks: [
    { id: 'T1', objective: 'toCsv in src/csv.js', allowed_paths: ['src/csv.js', 'tests/csv.test.js'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/csv.test.js', covers: ['AC-1'] }] },
    { id: 'T5', objective: 'fix add', allowed_paths: ['src/add.js'], criteria_ids: ['AC-3'], verify_commands: [{ cmd: 'node tests/add.test.js', covers: ['AC-3'] }] },
    { id: 'T2', objective: 'export csv from src/index.js', allowed_paths: ['src/index.js', 'tests/index-csv.test.js'], consumes: ['toCsv(rows) -> string'], criteria_ids: ['AC-4'], verify_commands: [{ cmd: 'node tests/index-csv.test.js', covers: ['AC-4'] }] },
    { id: 'T3', objective: 'alerts, exported from src/index.js', allowed_paths: ['src/alerts.js', 'src/index.js', 'tests/alerts.test.js'], consumes: ['toCsv(rows) -> string'], criteria_ids: ['AC-2', 'AC-4'], verify_commands: [{ cmd: 'node tests/alerts.test.js', covers: ['AC-2'] }] },
    { id: 'T4', objective: 'report', allowed_paths: ['src/report.js', 'tests/report.test.js'], consumes: ['toCsv(rows) -> string'], criteria_ids: ['AC-2'], verify_commands: [{ cmd: 'node tests/report.test.js', covers: ['AC-2'] }] },
  ],
};

test('e2e: a five-task, three-wave feature@medium job with a crashing builder, a shared file, a verifier timeout and a scope violation ships with nothing lost', async () => {
  const root = F.makeRepo();
  F.write(root, 'src/index.js', "module.exports = {\n  add: require('./add'),\n};\n");
  F.sh(root, 'git add -A && git commit -qm "index"');
  const J = F.cli(root, ['job', 'new', '--title', 'CSV export', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), CONTRACT);
  // clarify → H1 → ground → decide → H2 → decompose → H3, as in e2e-medium-high
  F.clarify(root);
  assert.equal(next(root).step, 'H1');
  F.reply(root, 'approve');
  assert.equal(next(root).workflow, 'ground');
  let b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] }], degraded: [] }));
  assert.equal(next(root).config, 'decide');
  F.write(F.jobDir(root, J), 'adr-001-csv.md', F.adrText({ job: J, acs: ['AC-1', 'AC-2', 'AC-3', 'AC-4'], decision: 'We will build toCsv in src/csv.js and have alerts and the report call it.' }));
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  F.record(root, F.envelope(b, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-csv.md')], summary: 's' }, critiques: [{ verdict: 'approve', items: [] }] }));
  assert.equal(next(root).step, 'H2');
  F.reply(root, 'approve');
  assert.equal(next(root).workflow, 'decompose');
  b = F.cli(root, ['wfargs', 'decompose']);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify(PLAN));
  const v = F.cli(root, ['plan', 'validate']);
  assert.equal(v.valid, true, JSON.stringify(v));
  F.record(root, F.envelope(b, 'ok', { planner: { valid: true, errors: [], path: 'plan.json' }, critique: null }));
  assert.equal(next(root).step, 'H3');
  F.reply(root, 'approve');

  // ---- the agents, with their imperfections
  const attempts = {};
  let verifies = 0;
  let challengeRound = 0;
  const log = [];
  const append = (wt, file, line) => {
    const p = path.join(wt, file);
    F.write(wt, file, fs.readFileSync(p, 'utf8').replace('};\n', `  ${line}\n};\n`));
  };
  const builder = (id) => {
    attempts[id] = (attempts[id] || 0) + 1;
    const n = attempts[id];
    const s = F.cli(root, ['task', 'start', id], { allowFail: false });
    const wt = s.worktree;
    const show = F.cli(root, ['task', 'show', id]);
    const fix = show.fix_findings.length > 0;
    if (id === 'T1') {
      F.write(wt, 'src/csv.js', fix
        ? "const q = (f) => (/[\",\\n]/.test(String(f)) ? `\"${String(f).replace(/\"/g, '\"\"')}\"` : String(f));\nmodule.exports = (rows) => rows.map((r) => r.map(q).join(',')).join('\\n');\n"
        : "module.exports = (rows) => rows.map((r) => r.join(',')).join('\\n');\n");
      F.write(wt, 'tests/csv.test.js', `const t = require('../src/csv');\nif (t([['a', 'b']]) !== 'a,b') process.exit(1);\n${fix ? "if (t([['a,b', 'c']]) !== '\"a,b\",c') process.exit(1);\n" : ''}`);
    }
    if (id === 'T5') {
      F.write(wt, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
      if (n === 1) return null; // crashed before committing or replying
    }
    if (id === 'T2') {
      append(wt, 'src/index.js', "csv: require('./csv'),");
      F.write(wt, 'tests/index-csv.test.js', "if (typeof require('../src/index').csv !== 'function') process.exit(1);\n");
    }
    if (id === 'T3') {
      F.write(wt, 'src/alerts.js', "const toCsv = require('./csv');\nmodule.exports = (xs) => toCsv(xs.map((x) => [x.level, x.text]));\n");
      append(wt, 'src/index.js', "alerts: require('./alerts'),");
      F.write(wt, 'tests/alerts.test.js', "if (require('../src/alerts')([{ level: 'hi', text: 't' }]) !== 'hi,t') process.exit(1);\n");
    }
    if (id === 'T4') {
      F.write(wt, 'src/report.js', "const toCsv = require('./csv');\nmodule.exports = (rows) => `report\\n${toCsv(rows)}`;\n");
      F.write(wt, 'tests/report.test.js', "if (require('../src/report')([['x']]) !== 'report\\nx') process.exit(1);\n");
      if (n === 1) F.write(wt, 'README.md', '# tiny\n\nNow with reports.\n'); // outside its paths
    }
    F.sh(wt, `git add -A && (git diff --cached --quiet || git commit -qm "${id} attempt ${n}")`);
    return { status: 'done', summary: `${id} attempt ${n}`, commits: ['x'], swept: [] };
  };
  const agents = (prompt, opts) => {
    const type = opts.agentType;
    log.push(opts.label);
    if (type === 'factory:builder') return builder(/^build (T\d+)/.exec(opts.label)[1]);
    if (type === 'factory:tester') return F.relayVerify(root, opts.label);
    if (type === 'factory:integrator') {
      if (/reconcile wave/.test(prompt)) return F.relayWave(root, prompt);
      const r = F.cli(root, ['reconcile', 'run']);
      return { status: r.status === 'merged' ? 'merged' : 'failed', summary: r.status || r.message, files: [] };
    }
    if (type === 'factory:code-reviewer') {
      // round 1 raises the bug; round 2's reviewer does not raise it again
      return { lane: 'code', findings: challengeRound === 1 ? [{ id: 'code-1', severity: 'major', file: 'src/csv.js', line: 1, summary: 'fields that contain a comma are not quoted, so the CSV splits them', rule: null }] : [] };
    }
    if (/reviewer$/.test(type)) return { lane: /factory:(\w+)-reviewer/.exec(type)[1].replace('test', 'tests'), findings: [] };
    if (type === 'factory:finding-verifier') {
      verifies += 1;
      if (challengeRound === 1) return null; // timed out, twice
      return { finding_id: 'code-1', status: 'confirmed', evidence: ['src/csv.js:1'], reason: 'a field "a,b" comes out as two columns' };
    }
    throw new Error(`unexpected agent ${type}`);
  };

  // ---- drive the job the way the start skill does
  let runs = 0;
  let shipped = null;
  for (let guard = 0; guard < 40 && !shipped; guard++) {
    const n = next(root);
    if (n.action === 'workflow') {
      if (n.config === 'challenge') challengeRound += 1;
      const args = ['wfargs', n.workflow, ...(n.config ? ['--config', n.config] : []), ...(n.mode ? ['--mode', n.mode] : []), ...(n.scope ? ['--scope', n.scope] : [])];
      const brief = F.cli(root, args, { allowFail: false });
      const { result } = await H.run(path.join(F.PLUGIN, 'workflows', `${n.workflow}.js`), JSON.stringify(brief), agents);
      runs += result.agents.length;
      const r = F.record(root, result);
      assert.ok(!r.error, JSON.stringify(r));
    } else if (n.action === 'cli') {
      F.cli(root, n.command.replace(/^factory\s+/, '').split(/\s+/));
    } else if (n.action === 'skill' && n.skill === 'ship') {
      shipped = F.cli(root, ['ship', '--local']);
    } else {
      assert.fail(`unexpected stop: ${JSON.stringify(n).slice(0, 600)}`);
    }
  }
  assert.ok(shipped && !shipped.error, JSON.stringify(shipped));

  // the imperfections happened, and were handled
  assert.ok(log.includes('build T5 #1') && log.includes('build T5 #2'), 'T5 crashed once and was built again');
  const st = F.cli(root, ['job', 'show']);
  const h5 = st.tasks.T5.history;
  assert.ok(h5.some((h) => h.wip_commit), 'what the crashed attempt left uncommitted was kept as a wip: commit');
  assert.equal(st.tasks.T4.restarted.reason, 'scope_violation', 'T4 restarted from the job branch after its scope violation');
  assert.ok(!F.sh(root, `git show ${st.branch}:README.md`).includes('Now with reports'), 'the out-of-scope change never reached the job branch');
  // no lost finding: carried from round 1, re-verified, confirmed, fixed in T1
  const challenges = require('../cli/core/ledger').steps(root, J, 'challenge');
  const r1 = challenges[0].detail.findings.find((f) => f.id === 'code-1');
  assert.equal(r1.status, 'unverified', 'round 1: the verifier timed out twice');
  const r2 = challenges[1].detail.findings.find((f) => /^code-1/.test(f.id));
  assert.ok(r2 && r2.carried && r2.status === 'confirmed', `round 2 carried it and its verifier confirmed it: ${JSON.stringify(r2)}`);
  assert.equal(challenges[challenges.length - 1].ok, true);
  assert.match(F.sh(root, `git show ${st.branch}:src/csv.js`), /replace\(/, 'the fix round fixed it');
  assert.match(fs.readFileSync(F.cli(root, ['report']).report, 'utf8'), /Unverified serious review findings \(they block ship\): 0/);
  // no task done without its builder: every done task's last builder reply was done, and the inspector agrees
  for (const [id, t] of Object.entries(st.tasks)) {
    assert.equal(t.outcome, 'done', id);
    assert.equal(t.builder.outcome, 'done', `${id}'s builder finished`);
    assert.equal(t.evidence.builder_at, t.builder.at, `${id}'s evidence came after its builder's reply`);
  }
  // no dropped export: the shared wiring holds every task's line
  const index = F.sh(root, `git show ${st.branch}:src/index.js`);
  for (const k of ['add', 'csv', 'alerts']) assert.match(index, new RegExp(`${k}: require`), `${k} is exported`);
  F.write(root, 'tests/index.test.js', INDEX_TEST);
  // the inspector finds no outcome-integrity deviation on the job
  const ins = require('child_process').spawnSync('node', [path.join(F.PLUGIN, '..', 'factory-inspector', 'bin', 'factory-inspect'), 'run', '--job', J], { cwd: root, encoding: 'utf8' });
  assert.equal(ins.status, 0, ins.stderr);
  const findings = require('../../factory-inspector/inspector/main').report(root, { status: 'all', health: false }).findings.filter((x) => x.job === J);
  assert.deepEqual(findings.filter((x) => /^R[57]\./.test(x.rule)).map((x) => `${x.rule}: ${x.summary}`), [], 'no outcome-integrity or driver deviation');
  // only the planted failures show: T5's crashed builder and the verifier's two timeouts
  assert.deepEqual(findings.map((x) => x.rule).sort(), ['R14.agent_failures', 'R14.agent_retries']);
  console.log(`e2e: inspector findings: ${findings.map((x) => `${x.rule}: ${x.summary}`).join(' || ') || 'none'}`);
  // fewer agent runs than the copilot baseline's 74
  assert.ok(runs < 74, `${runs} agent runs`);
  console.log(`e2e: ${runs} agent runs, ${challenges.length} review rounds, labels: ${log.join(' | ')}`);
});
