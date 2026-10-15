'use strict';
// 0.15.1: copilot-factory 0.6.1's narrow clarify fixes, ported. No new mechanisms: each fix is
// local.
//   1. the job's own title words are no evidence that two issues are the same (both copies of
//      the dedup rule: the workflow's and the CLI's), with the one-own-word relaxation
//   2. no issue is dropped without an actor and a reason; the record refuses a round in which
//      one vanishes (ledger_invariant); H1 shows "dropped by judge: <reason>"
//   4. degraded rounds park after two in a row, naming the failing analyst(s)
//   5. this clarify does no research: its equivalent of a failed mapper is an analyst angle gone
//      on without (--accept-degraded); it is said in the round result and at H1
//   6. God Eye's blockers and majors are never counted as approval: "God Eye objects" at H1,
//      also from a 0.15.0 workflow or critique (mid-upgrade); the console says so too
// (3, never asking for the confirmation code, is in quality-lint.test.js; 7, the hooks' Node,
// in hooks-node.test.js.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');
const J2 = require('./helpers/j0002');
const clarify = require('../cli/core/clarify');
const job = require('../cli/core/job');

const WF = path.join(F.PLUGIN, 'workflows', 'fanout-judge.js');
const TITLE = 'Nautobot VLAN sync from Cisco devices';
const SCOPE = 'Which Cisco devices does the Nautobot VLAN sync job read from?';
const CREDS = 'How does the Nautobot VLAN sync job get credentials for the Cisco devices?';

function newJob(root, title = TITLE) {
  const J = F.cli(root, ['job', 'new', '--title', title, '--type', 'feature', '--risk', 'medium']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), J2.CONTRACT);
  F.cli(root, ['next']);
  return J;
}
function round(root, data, status = 'needs_user') {
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  return F.record(root, F.envelope(b, status, { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, ...data }));
}
const issue = (id, text, kind, extra = {}) => ({ id, text, kind, impact: 'high', draft: text, owner: 'user', status: 'proposed', question_id: null, answer: null, aliases: [], notes: [], history: [], source: 'judge', round: 1, ...extra });
const led = (issues, raised = {}) => ({ ledger: { issues, raised: { created: [], folded: [], notes: [], ...raised } } });
const ledgerOf = (root, J) => clarify.load(root, J);
const byId = (d, id) => d.issues.find((u) => u.id === id);
const APPROVE = { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, no_open_blockers: true, constraints_consistent: true }, items: [] };

const item = (id, category, gate = false) => ({ id, label: `analyst · ${id}`, category, gate, prompt: `p-${id}`, schema: {}, agent_type: 'factory:intent-analyst' });
function brief(prior = [], ledgerExtra = {}, extra = {}) {
  return {
    workflow: 'fanout-judge', job: 'J-0001', input_hash: 'h', budgets: { limit: {} }, config: 'clarify', round: 2, limits: { max_questions: 5 }, asked: [],
    fanout: [item('intent', 'intent', true), item('scope', 'scope')],
    judge: { prompt: 'JUDGE', schema: {}, agent_type: 'factory:judge' },
    critique: { prompt: 'GOD', schema: {}, agent_type: 'factory:god-eye' },
    editor: { prompt: 'EDIT', schema: {}, agent_type: 'factory:contract-editor', todo: [] },
    ledger: { round: 2, prior, next_id: prior.length, new_since: {}, changed_sections: null, settled_sections: [], nothing_new: false, ...ledgerExtra },
    ...extra,
  };
}
function crew(over = {}) {
  return (prompt, opts) => {
    const t = opts.agentType;
    for (const [k, f] of Object.entries(over)) if (prompt.startsWith(k) || t === k) return f(prompt, opts);
    if (t === 'factory:intent-analyst') return { focus: 'x', questions: [] };
    if (t === 'factory:judge') return { questions: [], dismissed: [] };
    if (t === 'factory:god-eye') return APPROVE;
    if (t === 'factory:contract-editor') return { contract: '# x\n\n## Intent\n- Problem: p\n', applied: [], skipped: [], removed: [] };
    throw new Error(`unexpected ${t}: ${prompt.slice(0, 60)}`);
  };
}

// ---------------------------------------------------------------- 1. the job's own words
test('1: the job title\'s words are no evidence of identity: credentials do not fold into device scope (CLI and workflow); paraphrases still fold', async () => {
  const bg = clarify.vocabulary(TITLE);
  const scope = { subject: 'sync.device-scope', subject_explicit: true, text: SCOPE };
  const creds = { subject: 'device.credentials', subject_explicit: true, text: CREDS };
  assert.equal(clarify.sameIssue({ text: CREDS }, { text: SCOPE }), true, 'without the job\'s vocabulary (0.15.0) credentials fold into device scope');
  assert.equal(clarify.sameIssue({ text: CREDS }, { text: SCOPE }, bg), false, 'with it they are two issues');
  assert.equal(clarify.sameIssue(creds, scope, bg), false);
  assert.equal(clarify.sameIssue({ text: 'How should VLANs be scoped for the six tenants with their own locations?' }, { text: 'How should VLANs be scoped across the six tenants and their own locations?' }, bg), true, 'a real paraphrase still folds');
  assert.equal(clarify.sameIssue({ text: 'Is there a maintenance window for the sync?' }, { text: 'Is there a maintenance window the sync must respect?' }, clarify.vocabulary('Nautobot interface VLAN sync')), true);

  // CLI: device scope settled; the judge raises credentials next round → its own issue, asked
  const root = F.makeRepo();
  const J = newJob(root);
  round(root, { judge: { questions: [{ question: SCOPE, category: 'scope', why: 'w', default: 'None: answer needed' }], dismissed: [] } });
  F.cli(root, ['answer', 'Q-1', 'all access switches']);
  F.cli(root, ['next']);
  const r = round(root, { judge: { questions: [{ question: CREDS, category: 'scope', why: 'w', default: 'None: answer needed' }], dismissed: [] } });
  assert.equal(r.status, 'needs_user', JSON.stringify(r).slice(0, 300));
  const d = ledgerOf(root, J);
  const c = d.issues.find((u) => /credentials/.test(u.text));
  assert.ok(c, 'the credentials issue exists');
  assert.notEqual(c.id, 'U-1');
  assert.ok(r.questions.some((q) => q.unknown === c.id), 'and is asked');
  assert.ok(!(byId(d, 'U-1').notes || []).some((x) => /credentials/.test(x.text)), 'not a note on the settled scope issue');

  // the brief carries the vocabulary to the workflow
  F.cli(root, ['next']);
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.deepEqual(b.ledger.vocabulary, bg);

  // workflow: the same raise against a settled scope issue is a new issue, not a note
  const prior = [issue('U-1', SCOPE, 'scope', { status: 'settled', settled_by: 'user', subject: 'sync.device-scope', answer: 'all access switches', question_id: 'Q-1' })];
  const judge = () => ({ questions: [{ question: CREDS, category: 'scope', why: 'w', default: 'None: answer needed', same_as: 'new' }], dismissed: [] });
  const without = await H.run(WF, brief(prior), crew({ JUDGE: judge }));
  assert.equal(without.result.status, 'ok', '0.15.0 shape (no vocabulary): folded into U-1 as a note');
  const withV = await H.run(WF, brief(prior, { vocabulary: bg }), crew({ JUDGE: judge }));
  assert.equal(withV.result.status, 'needs_user');
  assert.ok(withV.result.data.ledger.issues.some((u) => u.id !== 'U-1' && /credentials/.test(u.text)), 'a new issue in the workflow too');
});

test('1 (review): the job\'s vocabulary never stops the same question from folding: identical texts and one-word paraphrases fold (CLI and workflow); credentials still do not', async () => {
  const bg = clarify.vocabulary(TITLE);
  const SAME = 'Which Cisco devices does the Nautobot VLAN sync read?';
  assert.equal(clarify.sameIssue({ text: SAME }, { text: SAME }, bg), true, 'the same text raised again is the same issue');
  assert.equal(clarify.sameIssue({ text: SAME }, { text: 'Which Cisco devices should the Nautobot VLAN sync job read from?' }, bg), true, 'a paraphrase whose only own word is shared');
  const flask = clarify.vocabulary('Add rate limiting to the Flask API');
  assert.equal(clarify.sameIssue({ text: 'What rate limit should the Flask API apply?' }, { text: 'What rate limit should the Flask API apply?' }, flask), true);
  assert.equal(clarify.sameIssue({ text: CREDS }, { text: SAME }, bg), false, 'credentials are still not device scope');
  assert.equal(clarify.sameIssue({ subject: 'device.credentials', subject_explicit: true, text: CREDS }, { subject: 'sync.device-scope', subject_explicit: true, text: SCOPE }, bg), false);
  // the dedup the J-0002 migration relies on is unchanged with its own title
  const nx = clarify.vocabulary('Nautobot interface VLAN sync');
  assert.equal(clarify.sameIssue({ text: 'Which NX-OS CLI command sets the allowed VLAN list on a trunk interface?' }, { text: 'Which command does NX-OS accept to set allowed VLANs on trunk ports?' }, nx), true);

  // workflow: the settled scope question raised again word for word is folded, not a new issue
  const prior = [issue('U-1', SAME, 'scope', { status: 'settled', settled_by: 'user', subject: 'sync.device-scope', answer: 'all access switches', question_id: 'Q-1' })];
  const judge = () => ({ questions: [{ question: SAME, category: 'scope', why: 'w', default: 'None: answer needed', same_as: 'new' }], dismissed: [] });
  const w = await H.run(WF, brief(prior, { vocabulary: bg }), crew({ JUDGE: judge }));
  assert.equal(w.result.status, 'ok', 'nothing new to ask');
  assert.deepEqual(w.result.data.ledger.issues.map((u) => u.id), ['U-1']);
});

// ---------------------------------------------------------------- 2. no silent drop
test('2: a judge dismissal drops an issue only with a reason; H1 shows "dropped by judge: <reason>"; the record refuses a round in which an issue vanishes or is dropped without actor and reason', async () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const creds = issue('U-1', CREDS, 'decision', { subject: 'device.credentials' });
  const other = issue('U-2', 'Should the sync delete VLANs missing on the device?', 'decision', { subject: 'sync.prune' });
  // no reason: nothing is dropped (0.15.0 dropped it for good)
  let r = round(root, { ...led([creds, other], { created: [{ issue: 'U-1', source: 'judge' }, { issue: 'U-2', source: 'judge' }] }), judge: { questions: [], dismissed: [{ question: CREDS, unknown: 'U-1', reason: '' }, { question: other.text, unknown: 'U-2', reason: 'the README will cover it' }] }, critique: APPROVE }, 'ok');
  let d = ledgerOf(root, J);
  assert.notEqual(byId(d, 'U-1').status, 'dropped', 'a dismissal without a reason drops nothing');
  assert.equal(byId(d, 'U-2').status, 'dropped');
  const h = byId(d, 'U-2').history.slice(-1)[0];
  assert.deepEqual([h.event, h.actor, h.text], ['dropped', 'judge', 'the README will cover it']);
  assert.ok(r.questions.some((q) => q.unknown === 'U-1'), 'U-1 is asked instead');
  // the user answers; the next round reaches H1, which shows the drop and why
  F.cli(root, ['answer', 'U-1', 'from the Nautobot secrets group of each device']);
  F.cli(root, ['next']);
  r = round(root, { critique: APPROVE }, 'ok');
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 400));
  const n = F.cli(root, ['next']);
  assert.equal(n.step, 'H1');
  assert.deepEqual(n.clarify.dropped, ['U-2: Should the sync delete VLANs missing on the device? (dropped by judge: the README will cover it)']);
  assert.match(F.cli(root, ['clarify', 'status', '--job', J]).raw, /Dropped:\n {2}U-2: .*\(dropped by judge: the README will cover it\)/);

  // the workflow: a dismissal without a reason does not keep the ledger's proposal from being asked
  const w = await H.run(WF, brief([issue('U-1', CREDS, 'decision')]), crew({ JUDGE: () => ({ questions: [], dismissed: [{ question: CREDS, unknown: 'U-1', reason: ' ' }] }) }));
  assert.equal(w.result.status, 'needs_user');
  assert.deepEqual(w.result.questions.map((q) => q.unknown), ['U-1']);

  // the guard: a workflow that reports an issue it opened but does not return it
  const root2 = F.makeRepo();
  const J2id = newJob(root2);
  round(root2, { judge: { questions: [{ question: SCOPE, category: 'scope', why: 'w', default: 'None: answer needed' }], dismissed: [] } });
  const before = JSON.stringify(ledgerOf(root2, J2id).issues);
  const stBefore = job.load(root2, J2id).counters.clarify_rounds;
  F.cli(root2, ['next']);
  const bad = round(root2, led(ledgerOf(root2, J2id).issues, { created: [{ issue: 'U-40', source: 'judge' }] }));
  assert.equal(bad.code, 'ledger_invariant', JSON.stringify(bad).slice(0, 300));
  assert.match(bad.message, /U-40, opened this round, vanished/);
  assert.equal(JSON.stringify(ledgerOf(root2, J2id).issues), before, 'nothing was recorded');
  assert.equal(job.load(root2, J2id).counters.clarify_rounds, stBefore, 'not even the round count');
  // a workflow that drops an issue itself, with no actor or reason
  const dropped = ledgerOf(root2, J2id).issues.map((u) => ({ ...u, status: 'dropped' }));
  const bad2 = round(root2, led(dropped));
  assert.equal(bad2.code, 'ledger_invariant');
  assert.match(bad2.message, /U-1 .* dropped without a recorded reason and actor/);

  // the rule itself: a lost alias, a lost new issue, a drop with no actor or reason
  const prior = { issues: [{ id: 'U-1', text: 'a', status: 'proposed', aliases: [{ id: 'U-9' }] }, { id: 'U-2', text: 'b', status: 'proposed', aliases: [] }] };
  const now = { issues: [clarify.cleanIssue({ id: 'U-1', text: 'a', kind: 'user', status: 'proposed' }), clarify.cleanIssue({ id: 'U-2', text: 'b', kind: 'user', status: 'dropped' })] };
  const p = clarify.invariant(prior, now, ['U-7']);
  assert.ok(p.some((x) => /U-9 \(an alias of U-1\) vanished/.test(x)));
  assert.ok(p.some((x) => /U-7, opened this round, vanished/.test(x)));
  assert.ok(p.some((x) => /U-2 .* dropped without a recorded reason and actor/.test(x)));
  clarify.event(now.issues[1], 2, 'dropped', 'judge', 'does not change the outcome');
  assert.deepEqual(clarify.invariant(prior, { issues: [{ ...now.issues[0], aliases: [{ id: 'U-9' }] }, now.issues[1], clarify.cleanIssue({ id: 'U-7', text: 'c', kind: 'user' })] }, ['U-7']), []);
});

test('2 (review): an issue 0.15.0 dropped without a reason is upgraded as is (no ledger_invariant) and shown as "no reason recorded"', () => {
  const u = clarify.cleanIssue({ id: 'U-2', text: 'Should the sync delete VLANs missing on the device?', kind: 'decision', status: 'dropped', dismissed: true, note: 'dismissed by the judge: ' });
  u.history = [{ round: 1, event: 'dropped', actor: 'judge' }];
  const data = { issues: [u] };
  assert.deepEqual(clarify.invariant({ issues: [{ id: 'U-2', text: u.text, status: 'dropped', aliases: [] }] }, data), [], 'a drop from before the round is not re-judged');
  assert.deepEqual(clarify.droppedLines(data).map((x) => x.line), ['U-2: Should the sync delete VLANs missing on the device? (dropped by judge: no reason recorded)']);
});

// ---------------------------------------------------------------- 4. degraded rounds park
test('4: two degraded clarify rounds in a row park the job, naming the failing analyst(s); resume, then --accept-degraded, goes on', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const failed = () => {
    const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
    return F.record(root, F.envelope(b, 'degraded', { analysts: [], degraded: ['intent', 'scope'], judge: { questions: [], dismissed: [] } }));
  };
  let r = failed();
  assert.equal(r.status, 'retry', 'the first degraded round is retried once, automatically');
  F.cli(root, ['next']);
  r = failed();
  assert.equal(r.status, 'park', JSON.stringify(r).slice(0, 300));
  assert.match(r.park_reason, /agent\(s\) failed in 2 clarify rounds in a row: intent, scope/);
  assert.match(r.park_reason, /--accept-degraded/);
  assert.match(r.park_reason, /two more failed rounds in a row park it again/, 'says what resume does');
  let st = job.load(root, J);
  assert.equal(st.status, 'parked');
  assert.match(st.park.reason, /intent, scope/);
  assert.equal(clarify.limits(st).counted, 0, 'degraded rounds still do not count towards the ceiling');
  F.reply(root, 'resume');
  st = job.load(root, J);
  assert.equal(st.counters.clarify_degraded_streak, 0, 'resume resets the streak');
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  // the same analysts keep failing: one automatic retry, then parked again (never an endless loop)
  assert.equal(failed().status, 'retry');
  F.cli(root, ['next']);
  assert.equal(failed().status, 'park');
  // the clarify skill: no `degraded` status any more; park names the way on
  const skill = fs.readFileSync(path.join(F.PLUGIN, 'skills', 'clarify', 'SKILL.md'), 'utf8');
  assert.doesNotMatch(skill, /^\s*- `degraded`/m);
  assert.match(skill, /- `park`: [^\n]*analysts failed in two rounds in a row[^\n]*--accept-degraded/);
});

// ---------------------------------------------------------------- 5. an angle gone on without
test('5: an analyst angle gone on without (--accept-degraded) is said in the round result and at H1; a later round that runs it clears it', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  // the user chose to go on without the testability angle: the round still asks a question
  let r = round(root, { degraded: ['testability'], judge: { questions: [{ question: 'Which devices are in scope?', category: 'scope', why: 'w', default: 'all access switches' }], dismissed: [] } });
  assert.equal(r.status, 'needs_user');
  assert.match(r.analysis_incomplete, /^Analysis incomplete: testability failed and clarify went on without it \(--accept-degraded\) in round 1, so the contract was not checked from that angle\.$/);
  assert.match(r.message, /^Analysis incomplete: testability failed/);
  // nobody answers: the default is taken, God Eye approves; the gap still holds at the ok and at H1
  F.cli(root, ['next']);
  r = round(root, { quiet: true, critique: APPROVE }, 'ok');
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 300));
  assert.match(r.message, /^Analysis incomplete: testability failed/);
  const step = require('../cli/core/ledger').steps(root, J, 'clarify').slice(-1)[0];
  assert.deepEqual(step.detail.analysis_incomplete, ['testability']);
  const n = F.cli(root, ['next']);
  assert.equal(n.step, 'H1');
  assert.match(n.clarify.analysis_incomplete, /testability failed and clarify went on without it/);
  // every angle ran: nothing to say
  assert.equal(clarify.analysisGaps({ rounds: [{ round: 1, degraded: ['testability'], ledger: { degraded: false } }, { round: 2, degraded: [], ledger: { degraded: false } }] }), null);
  assert.equal(clarify.analysisGaps({ rounds: [{ round: 1, degraded: ['scope'], ledger: { degraded: true } }] }), null, 'a degraded round that was retried is not a gap');
});

// ---------------------------------------------------------------- 6. God Eye's objections are never approval
test('6: God Eye revise with blockers and majors (settled issues included) is never approved-with-notes: the round ends with its objections, and H1 shows them under God Eye objects', async () => {
  const settled = issue('U-1', 'How should VLANs be scoped for the six tenants?', 'scope', { status: 'settled', settled_by: 'user', subject: 'vlan.scoping', subject_explicit: true, answer: 'x', question_id: 'Q-1' });
  const revise = { ...APPROVE, verdict: 'revise', items: [
    { issue: 'Scoping was settled without the tenants\' owners; the model for six tenants is unclear', severity: 'blocker', ref: 'U-1' },
    { issue: 'AC-7 promises credentials docs nothing decides', severity: 'major', ref: 'AC-7' },
    { issue: 'Wording', severity: 'minor' },
  ] };
  // the editor revises AC-7, God Eye still objects (the blocker on a settled issue is a note, never a question)
  const w = await H.run(WF, brief([settled]), crew({ GOD: () => revise }));
  assert.equal(w.result.status, 'ok', 'nothing is left to ask');
  assert.equal(w.result.data.approved_with_notes, false, '0.15.0 called this "approve with notes"');
  assert.deepEqual(w.result.data.god_eye_objects.map((o) => [o.ref, o.severity]), [['U-1', 'blocker'], ['AC-7', 'major']]);
  assert.doesNotMatch(w.result.summary, /approve with notes/);
  assert.match(w.result.summary, /it objects to 2 item\(s\), shown at H1/);

  // factory record: not approval; the round ends (clarify can do no more) and H1 shows the objections
  const root = F.makeRepo();
  const J = newJob(root);
  const r = round(root, { critique: revise, approved_with_notes: false, god_eye_objects: w.result.data.god_eye_objects, notes: w.result.data.notes }, 'ok');
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 300));
  assert.equal(r.approved, false);
  assert.match(r.message, /God Eye did NOT approve the contract \(verdict: revise\): it objects to 2 item\(s\)/);
  assert.match(r.message, /H1 shows them under "God Eye objects"/);
  const step = require('../cli/core/ledger').steps(root, J, 'clarify').slice(-1)[0];
  assert.deepEqual([step.detail.outcome, step.detail.approved, step.detail.approved_with_notes], ['god_eye_objects', false, undefined]);
  const n = F.cli(root, ['next']);
  assert.equal(n.step, 'H1');
  assert.deepEqual(n.clarify.god_eye_objects, ['blocker (U-1): Scoping was settled without the tenants\' owners; the model for six tenants is unclear', 'major (AC-7): AC-7 promises credentials docs nothing decides']);
  // an approving God Eye has nothing to object to at H1
  const root2 = F.makeRepo();
  newJob(root2);
  assert.match(round(root2, { critique: APPROVE }, 'ok').message, /^God Eye approved the contract/);
  assert.equal(F.cli(root2, ['next']).clarify, undefined);
});

test('6 (review): an envelope without god_eye_objects (a 0.15.0 workflow, mid-upgrade) that calls blockers "approve with notes" is not approval, and a 0.15.0 critique already waiting at H1 shows its objections', () => {
  const { seal } = require('../cli/lib/seal');
  const revise = { ...APPROVE, verdict: 'revise', items: [{ issue: 'Scoping was settled without its owners', severity: 'blocker', ref: 'U-1' }, { issue: 'Wording', severity: 'minor' }] };
  const root = F.makeRepo();
  const J = newJob(root);
  // what 0.15.0's workflow returned: approved_with_notes true, no god_eye_objects
  const r = round(root, { critique: revise, approved_with_notes: true, notes: [{ text: 'Wording' }] }, 'ok');
  assert.equal(r.status, 'ok');
  assert.equal(r.approved, false);
  assert.match(r.message, /God Eye did NOT approve the contract \(verdict: revise\): it objects to 1 item\(s\)/);
  assert.doesNotMatch(r.message, /approved with notes/);
  const step = require('../cli/core/ledger').steps(root, J, 'clarify').slice(-1)[0];
  assert.equal(step.detail.approved_with_notes, undefined);
  assert.deepEqual(F.cli(root, ['next']).clarify.god_eye_objects, ['blocker (U-1): Scoping was settled without its owners']);

  // a job 0.15.0 already took to H1 "approved with notes": its sealed critique has no god_eye_objects
  const file = path.join(F.jobDir(root, J), 'critiques', 'intent.json');
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete c.god_eye_objects;
  delete c.seal;
  fs.writeFileSync(file, JSON.stringify(seal({ ...c, approved_with_notes: true }), null, 2));
  assert.deepEqual(F.cli(root, ['next']).clarify.god_eye_objects, ['blocker (U-1): Scoping was settled without its owners']);
});

test('6 (review): the console never says God Eye approved a contract it objects to, and shows the objections at H1; the clarify skill never leads an objected round with "approved"', () => {
  const con = require('../cli/core/console');
  const root = F.makeRepo();
  const J = newJob(root);
  const revise = { ...APPROVE, verdict: 'revise', items: [{ issue: 'Scoping was settled without its owners', severity: 'blocker', ref: 'U-1' }] };
  const objects = [{ ref: 'U-1', severity: 'blocker', issue: 'Scoping was settled without its owners' }];
  round(root, { critique: revise, approved_with_notes: false, god_eye_objects: objects }, 'ok');
  assert.equal(F.cli(root, ['next']).step, 'H1');
  const j = con.build(root, { job: J }).jobs.find((x) => x.id === J);
  const res = j.timeline.filter((e) => e.type === 'result' && e.raw_step === 'clarify').slice(-1)[0];
  assert.doesNotMatch(res.text, /approved/i);
  assert.match(res.text, /God Eye did not approve: 1 objection\(s\), shown at H1/);
  assert.deepEqual(j.h1.god_eye_objects, ['blocker (U-1): Scoping was settled without its owners']);
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  assert.match(html, /God Eye objects/, 'the page renders them');
  const skill = fs.readFileSync(path.join(F.PLUGIN, 'skills', 'clarify', 'SKILL.md'), 'utf8');
  const ok = skill.split('\n').find((l) => /^\s*- `ok`:/.test(l));
  assert.doesNotMatch(ok, /^\s*- `ok`: God Eye approved/, 'an ok round may be one God Eye objects to');
  const gate = fs.readFileSync(path.join(F.PLUGIN, 'skills', 'gate', 'SKILL.md'), 'utf8');
  for (const k of ['god_eye_objects', 'dropped', 'analysis_incomplete']) assert.match(gate, new RegExp(`- \`${k}\`:`), `the gate skill shows ${k}`);
});
