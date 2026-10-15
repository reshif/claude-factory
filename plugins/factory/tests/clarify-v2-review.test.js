'use strict';
// Clarify v2, the hardening its review asked for: numbered chat replies that must not settle the
// wrong issue (Q-n names the question, the shown list, all or nothing, "defaults" never
// half-records), the contract editor that must not drop criteria silently (`removed` and its
// reasons), a revision the CLI refuses that God Eye approved, revisions that are not progress,
// dedup that keeps one-word swaps apart (and its undo, split), rounds run before v2 that do not
// count, what clarify status shows about migrated answers, and answers after H1.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const J2 = require('./helpers/j0002');
const clarify = require('../cli/core/clarify');
const guardRules = require('../hooks/guard-rules');

const APPROVE = { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, no_open_blockers: true, constraints_consistent: true }, items: [] };

function newJob(root, { risk = 'medium' } = {}) {
  const J = F.cli(root, ['job', 'new', '--title', 'Nautobot interface VLAN sync', '--type', 'feature', '--risk', risk]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), J2.CONTRACT);
  F.cli(root, ['next']);
  return J;
}
function round(root, data, status = 'needs_user') {
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  return F.record(root, F.envelope(b, status, { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, ...data }));
}
const q = (question, extra = {}) => ({ question, category: 'scope', why: 'w', default: 'None given: answer needed', ...extra });
const asks = (...list) => ({ judge: { questions: list, dismissed: [] } });
const ledgerOf = (root, J) => clarify.load(root, J);
const say = (root, prompt) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'prompt.js')], { input: JSON.stringify({ prompt, cwd: root }), encoding: 'utf8' });
const told = (out) => JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
const contractOf = (root, J) => fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8');
const editorEnv = (text, extra = {}) => ({ contract: { text, edits: [{ label: 'apply what was settled', ok: true, applied: [], skipped: [], removed: [], ...extra }] } });

// ---------------------------------------------------------------- numbered chat replies
test('numbered replies: "Q-n" names the question itself, not its place in the list; the set is what the last round showed', () => {
  assert.deepEqual(clarify.parseNumbered('Q-4 no, Q-3 yes').items.map((x) => [x.q, x.text]), [['Q-4', 'no'], ['Q-3', 'yes']]);
  const root = F.makeRepo();
  const J = newJob(root);
  round(root, asks(q('Should the sync prune VLANs not in Nautobot?', { default: 'yes' }), q('Is a dry run required before the first live run?', { default: 'yes' })));
  F.cli(root, ['answer', 'Q-1', 'yes']);
  F.cli(root, ['answer', 'Q-2', 'yes']);
  round(root, asks(q('Which device roles are in scope for the sync?', { default: 'leaf only' }), q('Who approves the first production run?', { default: 'the operations lead' })));
  const set = clarify.questionSet(require('../cli/core/job').load(root, J)).map((x) => x.id);
  assert.deepEqual(set, ['Q-3', 'Q-4']);
  assert.match(told(say(root, 'Q-4 the change board')), /Q-4 → the change board/);
  const d = ledgerOf(root, J);
  assert.equal(d.issues.find((u) => u.question_id === 'Q-4').answer, 'the change board');
  assert.equal(d.issues.find((u) => u.question_id === 'Q-3').status, 'proposed', 'Q-3 untouched');
  // "2 x" is the second question shown (Q-4 here is settled already: refused, nothing recorded)
  assert.match(told(say(root, '2 the board again')), /NOT recorded.*Q-4 \(2\) is already settled/);
});

test('numbered replies: ordinary messages are left alone; nothing already settled is overwritten by a pasted list; all or nothing', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  round(root, asks(q('Should the sync prune VLANs not in Nautobot?', { default: 'yes' }), q('Is a dry run required before the first live run?', { default: 'yes' }), q('Which device roles are in scope for the sync?', { default: 'leaf only' })));
  // a question to Claude is not an answer
  assert.equal(say(root, '3 tests are failing, can you look?').stdout, '');
  // a number no question has: not an answer set at all
  assert.equal(say(root, '10 minutes later it failed again').stdout, '');
  let d = ledgerOf(root, J);
  assert.ok(d.issues.every((u) => u.status === 'proposed'), 'nothing was settled');
  // a real answer
  assert.match(told(say(root, '1 yes')), /Recorded 1 answer/);
  // a pasted list over a question already answered: refused loudly, nothing changed
  assert.match(told(say(root, '1. Must support trunk ports\n2. Must not touch access ports')), /NOT recorded.*already settled/);
  d = ledgerOf(root, J);
  assert.equal(d.issues.find((u) => u.question_id === 'Q-1').answer, 'yes');
  assert.equal(d.issues.find((u) => u.question_id === 'Q-2').status, 'proposed', 'all or nothing: Q-2 was not settled either');
  // the same number twice, and a number outside the set
  assert.match(told(say(root, '2 yes, 2 no')), /NOT recorded.*answered twice/);
  assert.match(told(say(root, '2 yes, 7 no')), /NOT recorded.*There is no question 7: this round asked 3 \(1 = Q-1, 2 = Q-2, 3 = Q-3\)/);
  assert.equal(ledgerOf(root, J).issues.find((u) => u.question_id === 'Q-2').status, 'proposed');
  // a refusal is logged for the audit
  const log = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8');
  assert.match(log, /"event":"reply_refused","reply":"answers"/);
});

test('numbered replies: "defaults" accepts the defaults there are and names the questions without one; nothing is half-recorded', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  round(root, asks(q('Should the sync prune VLANs not in Nautobot?', { default: 'yes' }), q('Who approves the first production run?')));
  // an item that accepts a default that does not exist refuses the whole reply, before anything is written
  assert.match(told(say(root, '1 yes, 2 default')), /NOT recorded.*Q-2 has no proposed default/);
  assert.ok(ledgerOf(root, J).issues.every((u) => u.status === 'proposed'), 'Q-1 was not recorded either');
  assert.match(told(say(root, 'defaults')), /Recorded 1 answer\(s\): Q-1 → yes\. Still open \(no default, answer in words\): Q-2/);
  assert.deepEqual(ledgerOf(root, J).issues.map((u) => [u.question_id, u.status, u.settled_by]), [['Q-1', 'settled', 'assumption_accepted'], ['Q-2', 'proposed', null]]);
  // only questions without a default left: "defaults" records nothing and says so
  assert.match(told(say(root, 'defaults')), /NOT recorded.*No open question has a proposed default \(Q-2\)/);
});

// ---------------------------------------------------------------- the contract editor
test('contract editor: a revision that drops an acceptance criterion, a constraint or a non-goal without a recorded reason is refused', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const noAc2 = J2.CONTRACT.replace(/- AC-2:[^\n]*\n/, '');
  let r = round(root, { ...asks(q('Should the sync prune VLANs not in Nautobot?')), ...editorEnv(noAc2) });
  assert.match(r.clarify.contract_revision.rejected, /AC-2/);
  assert.ok(contractOf(root, J).includes('- AC-2:'), 'not written');
  // a constraint gone, no reason
  r = round(root, editorEnv(J2.CONTRACT.replace('- Runs from the existing automation container (Python 3.11)\n', '')));
  assert.match(r.clarify.contract_revision.rejected, /Constraints/);
  // a non-goal gone, "justified" by an issue that is not settled
  r = round(root, editorEnv(J2.CONTRACT.replace('- Access-port VLANs\n', ''), { removed: [{ ref: 'Non-goals', because: 'U-1', text: 'Access-port VLANs' }] }));
  assert.match(r.clarify.contract_revision.rejected, /Non-goals/);
  // the user settled it: the removal names that issue and is written
  F.cli(root, ['answer', 'Q-1', 'yes, and drop AC-2: no dry run']);
  r = round(root, editorEnv(noAc2, { applied: [{ ref: 'U-1', section: 'Acceptance criteria', change: 'AC-2 removed' }], removed: [{ ref: 'AC-2', because: 'U-1' }] }));
  assert.equal(r.clarify.contract_revision.written, true, JSON.stringify(r.clarify.contract_revision));
  assert.ok(!/- AC-2:/.test(contractOf(root, J)));
  assert.deepEqual(r.clarify.contract_revision.removed, [{ ref: 'AC-2', because: 'U-1' }]);
});

test('contract editor: a removal God Eye asked for is justified by its item; a truncated revision is refused', () => {
  const root = F.makeRepo();
  newJob(root);
  const noAc2 = J2.CONTRACT.replace(/- AC-2:[^\n]*\n/, '');
  let r = round(root, { critique: APPROVE, contract: { text: noAc2, edits: [{ label: "God Eye's items", ok: true, requested: [{ from: 'god-eye', ref: 'AC-2' }], applied: [{ ref: 'AC-2', section: 'Acceptance criteria', change: 'removed: duplicate of AC-1' }], skipped: [], removed: [{ ref: 'AC-2', because: 'god-eye' }] }] } }, 'ok');
  assert.equal(r.clarify.contract_revision.written, true, JSON.stringify(r.clarify.contract_revision));
  // God Eye asked about another criterion: that does not justify dropping AC-2
  const r2 = F.makeRepo();
  newJob(r2);
  r = round(r2, { critique: APPROVE, contract: { text: noAc2, edits: [{ label: "God Eye's items", ok: true, requested: [{ from: 'god-eye', ref: 'AC-1' }], applied: [], skipped: [], removed: [{ ref: 'AC-2', because: 'god-eye' }] }] } }, 'ok');
  assert.match(r.clarify.contract_revision.rejected, /AC-2/);
  // a reply cut off mid-contract
  const r3 = F.makeRepo();
  const J3 = newJob(r3);
  r = round(r3, { critique: APPROVE, ...editorEnv(J2.CONTRACT.slice(0, J2.CONTRACT.indexOf('- AC-2'))) }, 'ok');
  assert.ok(r.clarify.contract_revision.rejected);
  assert.ok(contractOf(r3, J3).includes('- AC-2:'));
});

test('contract editor: when the CLI refuses the revision God Eye approved, the round is not ok (H1 never shows a text God Eye did not see)', () => {
  const root = F.makeRepo();
  newJob(root);
  const r = round(root, { critique: APPROVE, ...editorEnv(J2.CONTRACT.replace(/- AC-2:[^\n]*\n/, '')) }, 'ok');
  assert.equal(r.status, 'revise');
  assert.match(r.message, /refused the contract editor's revision/);
  assert.notEqual(F.cli(root, ['next']).action, 'gate');
});

test('progress: a revision that changes nothing, or rewords without applying anything, is not progress; a gate denial goes to the editor once', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const ge = { ...APPROVE, verdict: 'revise', items: [{ ref: 'Goal', severity: 'major', issue: 'wordy' }] };
  // the same text back: written or not, it is not progress
  let r = round(root, { critique: ge, ...editorEnv(J2.CONTRACT) }, 'ok');
  assert.equal(r.clarify.round.revised, false);
  // a reworded goal that applies nothing it was asked for
  r = round(root, { critique: ge, ...editorEnv(J2.CONTRACT.replace('A sync job reads', 'A synchronisation job reads')) }, 'ok');
  assert.equal(r.clarify.round.revised, false);
  assert.equal(r.clarify.round.progress, false);
  // two rounds with no progress: not converging (the rewording did not keep it going)
  assert.equal(r.status, 'park');
  F.reply(root, 'resume');
  F.cli(root, ['next']);
  // a denial: the editor gets it in the round right after, not in every round after that
  const job = require('../cli/core/job');
  const st = job.load(root, J);
  st.denials = [...(st.denials || []), { gate: 'H1', reason: 'say which VLANs are reserved', at: new Date().toISOString() }];
  job.save(root, st);
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.ok(b.editor.todo.some((t) => t.from === 'gate denial'));
  r = F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: ge, ...editorEnv(J2.CONTRACT.replace('## Constraints\n', '## Constraints\n- VLANs 3968-4094 are reserved and never synced\n'), { requested: [{ from: 'gate denial' }] }) }));
  assert.equal(r.clarify.round.revised, true, 'applying the denial is progress');
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.ok(!b.editor.todo.some((t) => t.from === 'gate denial'), 'the denial was handled last round');
});

// ---------------------------------------------------------------- dedup and its undo
test('dedup: issues that differ in one telling word are not folded; long paraphrases still are', () => {
  const same = (a, b) => {
    const sa = clarify.subjectOf(a);
    const sb = clarify.subjectOf(b);
    return clarify.sameIssue({ subject: sa.subject, subject_explicit: sa.explicit, text: a.text }, { subject: sb.subject, subject_explicit: sb.explicit, text: b.text });
  };
  assert.equal(same({ text: 'Which VLAN is the native VLAN on trunk ports?' }, { text: 'Which VLANs are allowed on trunk ports?' }), false);
  assert.equal(same({ subject: 'nxos.native-vlan', text: 'Which VLAN is the native VLAN on NX-OS trunk ports?' }, { subject: 'nxos.allowed-vlans', text: 'Which VLANs are allowed on NX-OS trunk ports?' }), false);
  assert.equal(same({ text: 'Should the sync remove VLANs on the trunk that are not in Nautobot?' }, { text: 'Should the sync add VLANs on the trunk that are in Nautobot?' }), false);
  assert.equal(same({ text: 'Does the sync run on leaf switches?' }, { text: 'Does the sync run on spine switches?' }), false);
  assert.equal(same({ text: 'Does the Nautobot interface VLAN API list tagged members?' }, { text: 'Does the Nautobot interface VLAN API need a token?' }), false, 'a derived subject (the same first words) is not identity');
  // the limit of a word rule: longer texts one telling word apart still fold; split undoes such a fold
  assert.equal(same({ text: 'Does Nautobot interface VLAN API expose tagged VLANs?' }, { text: 'Does Nautobot interface VLAN API expose the native VLAN?' }), true);
  // the J-0002 paraphrases still fold
  assert.equal(same({ text: 'Which NX-OS CLI command sets the allowed VLAN list on a trunk interface?' }, { text: 'What is the exact NX-OS syntax for switchport trunk allowed vlan?' }), true);
  assert.equal(same({ text: 'Confirm the NX-OS command form for configuring trunk allowed VLANs' }, { text: 'Which command does NX-OS accept to set allowed VLANs on trunk ports?' }), true);
});

test('split U-n <alias>: a wrong fold is undone (human-only: the chat reply or your terminal), and the issue is asked again', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  round(root, asks(q('Which NX-OS command sets the allowed VLAN list on a trunk interface?', { owner: 'user' })));
  // the judge raises a different question the token rule folds into it
  round(root, { ledger: { issues: [...ledgerOf(root, J).issues, { id: 'U-2', text: 'Which NX-OS command sets the native VLAN on a trunk interface?', kind: 'scope', owner: 'user', status: 'proposed', aliases: [], notes: [], history: [] }], raised: { created: [], folded: [], notes: [] } } });
  let d = ledgerOf(root, J);
  assert.deepEqual(d.issues.map((u) => [u.id, u.aliases.map((a) => a.id)]), [['U-1', ['U-2']]]);
  // status names the way to undo a fold
  const txt = spawnSync('node', [F.BIN, 'clarify', 'status'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } }).stdout;
  assert.match(txt, /\[aliases U-2\][\s\S]*split <U-n> <alias>/);
  // human-only: refused from a pipe (not your terminal), and the guard refuses it to the chat agent and to agents
  assert.equal(F.cli(root, ['clarify', 'split', 'U-1', 'U-2']).code, 'human_only');
  for (const agent of [false, true]) assert.match(guardRules.checkBash(root, 'factory clarify split U-1 U-2', guardRules.loadPolicy(root), { agent }), /human-only/);
  // the user's chat reply
  assert.deepEqual(require('../cli/core/human').parseReply('split U-1 U-2'), { cmd: 'split', jobId: undefined, ref: 'U-1', alias: 'U-2' });
  const r = F.reply(root, 'split U-1 U-2');
  assert.equal(r.issue, 'U-2', JSON.stringify(r));
  d = ledgerOf(root, J);
  const u2 = d.issues.find((u) => u.id === 'U-2');
  assert.ok(u2, 'U-2 is an issue again');
  assert.deepEqual([u2.status, u2.owner], ['proposed', 'user']);
  assert.equal(d.issues.find((u) => u.id === 'U-1').aliases.length, 0);
  assert.ok(u2.history.some((h) => h.event === 'split') && d.issues.find((u) => u.id === 'U-1').history.some((h) => h.event === 'split'));
  assert.ok(require('../cli/core/decisions').forJob(root, J).some((x) => x.action === 'human.split'), 'recorded as your decision');
  // the next round asks it
  const r2 = round(root, {});
  assert.ok(r2.questions.some((x) => x.unknown === 'U-2'), JSON.stringify(r2.questions));
});

// ---------------------------------------------------------------- pre-v2 jobs and migration
test('a pre-v2 job: rounds run before the upgrade do not count against the v2 ceiling', () => {
  const root = F.makeRepo();
  const J = J2.build(root);
  const job = require('../cli/core/job');
  const st = job.load(root, J);
  const L = clarify.limits(st);
  assert.deepEqual([L.counted, L.before_v2, L.ceiling], [0, 9, 10], `rounds before v2 are not counted (${st.counters.clarify_rounds} ran)`);
  F.reply(root, `resume ${J}`);
  F.cli(root, ['next']);
  round(root, {});
  const s2 = job.load(root, J);
  assert.equal(s2.counters.clarify_v2_from, 9, 'the first v2 round records where v2 began');
  assert.equal(clarify.limits(s2).counted, 1);
  assert.ok(clarify.limits(s2).ceiling >= 10);
});

test('migration: clarify status shows each free-form answer matched by overlap, with the question it came from', () => {
  const root = F.makeRepo();
  const J = J2.build(root);
  const v = F.cli(root, ['clarify', 'status', '--job', J, '--json']);
  assert.ok(v.migration.matched_answers.length, 'the fixture has free-form answers');
  const text = spawnSync('node', [F.BIN, 'clarify', 'status', '--job', J], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } }).stdout;
  for (const m of v.migration.matched_answers) assert.ok(text.includes(`→ ${m.issue}`) && text.includes(m.question.slice(0, 40)), `${m.issue}: ${text}`);
  assert.match(text, /check them; factory answer U-n "…" corrects one/);
});

test('after H1, factory answer does not change a clarify issue behind the approved contract', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  round(root, asks(q('Should the sync prune VLANs not in Nautobot?', { default: 'yes' })));
  F.cli(root, ['answer', 'Q-1', 'yes']);
  round(root, { critique: APPROVE }, 'ok');
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  for (const ref of ['U-1', 'Q-1']) assert.equal(F.cli(root, ['answer', ref, 'no, keep them']).code, 'approved', ref);
  assert.equal(ledgerOf(root, J).issues[0].answer, 'yes');
  assert.equal(F.cli(root, ['clarify', 'note', 'U-1', 'x']).code, 'approved');
  // a free-text answer after H1 is ground's: recorded, never matched to a clarify issue
  const g = F.cli(root, ['answer', '--question', 'Should the sync prune VLANs that are not in Nautobot?', '--answer', 'only on leaf switches']);
  assert.equal(g.issue, undefined, JSON.stringify(g));
  assert.equal(g.answers, 2, 'recorded in answers.json');
  assert.equal(ledgerOf(root, J).issues[0].answer, 'yes');
});
