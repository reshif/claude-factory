'use strict';
// Upgrade: a job that was mid-build under factory 0.14.3 (no builder records, no attempt
// history, a policy snapshot without the new keys) continues under this factory without
// dead-ending: the in-flight attempt verifies once (legacy), realize finishes the rest, and the
// job reaches prove and review. The 0.14.3 CLI comes from this repository's git history
// (e735e01), so the test is skipped outside a git checkout that has it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');

const OLD_REV = 'e735e01';
const REPO = path.resolve(F.PLUGIN, '..', '..');
const hasOld = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${OLD_REV}:plugins/factory/bin/factory`]).status === 0;

function oldPlugin() {
  const dir = require('./helpers/tmp').mkdtemp('factory-0143-');
  const r = spawnSync('bash', ['-c', `git -C "${REPO}" archive ${OLD_REV} plugins/factory | tar -x -C "${dir}"`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return path.join(dir, 'plugins', 'factory', 'bin', 'factory');
}

test('upgrade: a 0.14.3 job mid-build continues under this factory without dead-ending', { skip: !hasOld && 'needs the 0.14.3 CLI from git history' }, async () => {
  const OLD = oldPlugin();
  const old = (root, args) => {
    const r = spawnSync('node', [OLD, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } });
    return JSON.parse(r.stdout);
  };
  const root = F.makeRepo();
  // ---- under 0.14.3: bug@low up to realize, T1 built and verified, T2 started and committed
  const J = old(root, ['job', 'new', '--title', 'Two fixes', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText({ ac: '- AC-1: add(2, 3) returns 5 (evidence: test)\n- AC-2: sub(5, 3) returns 2 (evidence: test)' }));
  let b = old(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  const rec = (env) => {
    const f = path.join(root, '.factory', 'scratch', `env-${Date.now()}-${Math.random()}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(env));
    return old(root, ['record', '--file', f]);
  };
  rec(F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  assert.equal(old(root, ['next']).step, 'H1');
  F.reply(root, 'approve'); // a chat reply: the hook runs whatever factory is installed now; the state is the same
  assert.equal(old(root, ['next']).workflow, 'ground');
  b = old(root, ['wfargs', 'ground']);
  rec(F.envelope(b, 'ok', { topics: [{ topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] }], degraded: [] }));
  old(root, ['next']);
  old(root, ['plan', 'from-contract']);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [
    { id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/add.test.js', covers: ['AC-1'] }] },
    { id: 'T2', objective: 'sub', allowed_paths: ['src/sub.js', 'tests/sub.test.js'], criteria_ids: ['AC-2'], verify_commands: [{ cmd: 'node tests/sub.test.js', covers: ['AC-2'] }] },
  ] }));
  assert.equal(old(root, ['plan', 'validate']).valid, true);
  // the plan the test wrote stands for decompose's (0.14.3's own modules record it)
  const oldCore = (m) => require(path.join(path.dirname(OLD), '..', 'cli', 'core', m));
  const cur = oldCore('invalidation').current(root, oldCore('job').load(root, J));
  oldCore('ledger').append(root, J, { kind: 'step', step: 'decompose', ok: true, bound: { plan: cur.plan, contract: cur.contract }, detail: { source: 'test' } });
  const nx = old(root, ['next']);
  assert.equal(nx.workflow, 'realize', JSON.stringify(nx));
  const s1 = old(root, ['task', 'start', 'T1']);
  F.write(s1.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
  F.sh(s1.worktree, 'git commit -qam "T1"');
  assert.equal(old(root, ['task', 'verify', 'T1']).pass, true);
  const s2 = old(root, ['task', 'start', 'T2']);
  F.write(s2.worktree, 'src/sub.js', 'module.exports = (a, b) => a - b;\n');
  F.write(s2.worktree, 'tests/sub.test.js', "if (require('../src/sub')(5, 3) !== 2) process.exit(1);\n");
  F.sh(s2.worktree, 'git add -A && git commit -qm "T2"');
  const before = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'state.json'), 'utf8'));
  assert.equal(before.tasks.T2.attempts, 1);
  assert.equal(before.tasks.T2.builder, undefined, 'no builder record under 0.14.3');
  assert.equal(before.policy.limits.integrate_each_wave, undefined, 'the old policy snapshot');

  // ---- upgraded: the job continues
  let n = F.cli(root, ['next']);
  assert.ok(!n.error, JSON.stringify(n));
  // T1 (verified under 0.14.3) still counts as done; T2's in-flight attempt verifies once (legacy)
  const brief = F.cli(root, ['wfargs', 'realize'], { allowFail: false });
  assert.deepEqual(Object.keys(brief.tasks), ['T2'], 'T1 stays done');
  assert.equal(brief.integrate_each_wave, true, 'the new key comes from the live policy');
  const lv = F.cli(root, ['task', 'verify', 'T2']);
  assert.equal(lv.pass, true, JSON.stringify(lv));
  assert.match(lv.legacy, /verified once without a builder record/);
  // the realize brief was made before that verify; run it as a fresh realize would, from next
  const { result } = await H.run(path.join(F.PLUGIN, 'workflows', 'realize.js'), JSON.stringify(F.cli(root, ['wfargs', 'realize'], { allowFail: false })), (prompt, opts) => {
    if (opts.agentType === 'factory:tester') return F.relayVerify(root, opts.label);
    if (opts.agentType === 'factory:integrator') return F.relayWave(root, prompt);
    throw new Error(`no ${opts.agentType} expected: ${opts.label}`);
  });
  const r = F.record(root, result);
  assert.ok(!r.error && ['ok'].includes(r.status), JSON.stringify(r));
  // or, had the brief still listed T2: its next start is tracked like any other (covered in phase2.test.js)
  for (let guard = 0; guard < 6; guard++) {
    n = F.cli(root, ['next']);
    if (n.action === 'cli') F.cli(root, n.command.replace(/^factory\s+/, '').split(/\s+/));
    else if (n.action === 'workflow' && n.workflow === 'reconcile') {
      const rb = F.cli(root, ['wfargs', 'reconcile'], { allowFail: false });
      const out = await H.run(path.join(F.PLUGIN, 'workflows', 'reconcile.js'), JSON.stringify(rb), () => {
        const m = F.cli(root, ['reconcile', 'run']);
        return { status: m.status === 'merged' ? 'merged' : 'failed', summary: m.status || m.message, files: [] };
      });
      assert.equal(F.record(root, out.result).status, 'ok');
    } else break;
  }
  assert.equal(n.config, 'challenge', `reached review: ${JSON.stringify(n).slice(0, 400)}`);
  const st = F.cli(root, ['job', 'show']);
  assert.deepEqual([st.tasks.T1.evidence.pass, st.tasks.T2.evidence.pass], [true, true], 'both tasks count as built');
  assert.equal(st.tasks.T2.legacy_verify.attempt, 1, 'T2\'s 0.14.3 attempt was verified once, as legacy');
  // a second legacy verify of the same attempt is refused: from now on a builder records its reply
  assert.equal(F.cli(root, ['task', 'verify', 'T2']).code, 'no_builder_result');
});
