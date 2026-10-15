'use strict';
// Upgrade: a job mid-clarify under factory 0.15.0 keeps going under 0.15.1. Its ledger may hold
// a drop 0.15.0 made without a reason (no ledger_invariant: drops from before the round are not
// re-judged; H1 says "no reason recorded"), a round in flight was briefed by 0.15.0's wfargs and
// run by 0.15.0's workflow (no vocabulary, God Eye's blockers called "approve with notes"), and
// 0.15.1's record takes it: not approval, its objections shown at H1. The 0.15.0 plugin comes
// from this repository's git history (f2eecd6), so the test is skipped outside a git checkout
// that has it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');
const J2 = require('./helpers/j0002');

const OLD_REV = 'f2eecd6';
const REPO = path.resolve(F.PLUGIN, '..', '..');
const hasOld = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${OLD_REV}:plugins/factory/bin/factory`]).status === 0;

function oldPlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-0150-'));
  const r = spawnSync('bash', ['-c', `git -C "${REPO}" archive ${OLD_REV} plugins/factory | tar -x -C "${dir}"`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return path.join(dir, 'plugins', 'factory');
}

const APPROVE = { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, no_open_blockers: true, constraints_consistent: true }, items: [] };
function crew(over = {}) {
  return (prompt, opts) => {
    const t = opts.agentType;
    for (const [k, f] of Object.entries(over)) if (t === k) return f(prompt, opts);
    if (t === 'factory:intent-analyst') return { focus: 'x', questions: [] };
    if (t === 'factory:judge') return { questions: [], dismissed: [] };
    if (t === 'factory:god-eye') return APPROVE;
    if (t === 'factory:contract-editor') return null; // no revision: the contract stays as it is
    throw new Error(`unexpected ${t}`);
  };
}

test('upgrade: a 0.15.0 job mid-clarify keeps going under 0.15.1 (old drops, an old workflow round in flight, H1)', { skip: !hasOld && 'needs the 0.15.0 plugin from git history' }, async () => {
  const OLD = oldPlugin();
  const oldCli = (root, args) => {
    const r = spawnSync('node', [path.join(OLD, 'bin', 'factory'), ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } });
    return JSON.parse(r.stdout);
  };
  const oldRec = (root, env) => {
    const f = path.join(root, '.factory', 'scratch', `env-${Date.now()}-${Math.random()}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(env));
    return oldCli(root, ['record', '--file', f]);
  };
  const OLD_WF = path.join(OLD, 'workflows', 'fanout-judge.js');
  const root = F.makeRepo();

  // ---- under 0.15.0: round 1 asks one question and drops another issue on a dismissal with no reason
  const J = oldCli(root, ['job', 'new', '--title', 'Nautobot VLAN sync from Cisco devices', '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), J2.CONTRACT);
  oldCli(root, ['next']);
  let b = oldCli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.equal(b.ledger.vocabulary, undefined, 'a 0.15.0 brief');
  const prune = { id: 'U-2', text: 'Should the sync delete VLANs missing on the device?', kind: 'decision', impact: 'high', owner: 'user', status: 'proposed', draft: 'x', aliases: [], notes: [], history: [], source: 'judge', round: 1 };
  let w = await H.run(OLD_WF, b, crew({ 'factory:judge': () => ({ questions: [{ question: 'Which Cisco devices does the sync read from?', category: 'scope', why: 'w', default: 'None: answer needed', same_as: 'new' }], dismissed: [] }) }));
  w.result.data.ledger.issues.push(prune);
  w.result.data.judge.dismissed = [{ question: prune.text, unknown: 'U-2', reason: '' }];
  let r = oldRec(root, w.result);
  assert.equal(r.status, 'needs_user', JSON.stringify(r).slice(0, 300));
  const ledger0 = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'clarify-ledger.json'), 'utf8'));
  const u2 = ledger0.issues.find((u) => u.id === 'U-2');
  assert.deepEqual([u2.status, u2.note], ['dropped', 'dismissed by the judge: '], '0.15.0 dropped it without a reason');

  // the user answers (the reply hook runs whatever factory is installed: the state is the same)
  assert.match(F.say(root, '1 all access switches').text, /Recorded 1 answer/);
  oldCli(root, ['next']);
  // round 2 is briefed and run by 0.15.0 (the session started before the upgrade): God Eye objects
  // to the settled scope issue, which 0.15.0's workflow calls "approve with notes"
  b = oldCli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  const revise = { ...APPROVE, verdict: 'revise', items: [{ issue: 'Device scope was settled without naming the device roles', severity: 'blocker', ref: 'U-1' }] };
  w = await H.run(OLD_WF, b, crew({ 'factory:god-eye': () => revise }));
  assert.equal(w.result.data.approved_with_notes, true, '0.15.0 counted it as approval');
  assert.equal(w.result.data.god_eye_objects, undefined);

  // ---- upgraded: 0.15.1 records that round
  r = F.record(root, w.result);
  assert.equal(r.code, undefined, JSON.stringify(r).slice(0, 400));
  assert.equal(r.status, 'ok');
  assert.equal(r.approved, false, 'not approval');
  assert.match(r.message, /God Eye did NOT approve the contract \(verdict: revise\): it objects to 1 item\(s\)/);
  const n = F.cli(root, ['next']);
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  assert.deepEqual(n.clarify.god_eye_objects, ['blocker (U-1): Device scope was settled without naming the device roles']);
  assert.deepEqual(n.clarify.dropped, ['U-2: Should the sync delete VLANs missing on the device? (dropped by judge: no reason recorded)']);
  const status = F.cli(root, ['clarify', 'status', '--job', J]).raw;
  assert.match(status, /Dropped:\n {2}U-2: .*no reason recorded/);

  // the user denies over the objection: clarify runs again under 0.15.1 (its own brief and workflow)
  F.reply(root, 'deny name the device roles in scope');
  const back = F.cli(root, ['next']);
  assert.equal(back.skill, 'clarify', JSON.stringify(back).slice(0, 300));
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.deepEqual(b.ledger.vocabulary.slice(0, 3), ['nautobot', 'vlan', 'sync']);
  w = await H.run(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), b, crew({ 'factory:contract-editor': () => ({ contract: J2.CONTRACT.replace('## Non-goals', '- Device roles in scope: access switches.\n\n## Non-goals'), applied: [], skipped: [], removed: [] }) }));
  r = F.record(root, w.result);
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 400));
  assert.notEqual(r.approved, false, 'God Eye approved the revised contract');
  const n2 = F.cli(root, ['next']);
  assert.equal(n2.step, 'H1');
  assert.equal(n2.clarify.god_eye_objects, undefined, 'the objection was to the old contract');
  assert.ok(n2.clarify.dropped, 'the old drop is still shown');
  F.reply(root, 'approve');
  assert.notEqual(F.cli(root, ['next']).step, 'H1', 'past H1');
});
