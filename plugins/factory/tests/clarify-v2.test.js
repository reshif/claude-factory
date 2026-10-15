'use strict';
// Clarify v2 (docs/DESIGN-CLARIFY-v2.md): one issue ledger the CLI owns, identity by subject,
// one answer channel, rounds that review only what changed, implementation facts handed to
// design, progress instead of round counting, one writer, and what the console and factory next
// show. Behaviours A–I (D, the research exit, has no counterpart here: this clarify does not
// research), the J-0002 migration from this factory's v1 record, and two end-to-end runs through
// the real workflow (a fresh job, and the migrated J-0002 itself).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');
const J2 = require('./helpers/j0002');
const { crew: scripted } = require('./helpers/clarify-crew');
const clarify = require('../cli/core/clarify');
const guardRules = require('../hooks/guard-rules');
const { validate } = require('../cli/lib/schema');
const seal = require('../cli/lib/seal');

const WF = path.join(F.PLUGIN, 'workflows', 'fanout-judge.js');
const ENV = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'envelope.json'), 'utf8'));

// ---------------------------------------------------------------- helpers
const item = (id, category, gate = false) => ({ id, label: `analyst · ${id}`, category, gate, prompt: `p-${id}`, schema: {}, agent_type: 'factory:intent-analyst' });
function brief(prior = [], extra = {}) {
  return {
    workflow: 'fanout-judge', job: 'J-0001', input_hash: 'h', budgets: { limit: {} }, config: 'clarify', round: 2, limits: { max_questions: 5 }, asked: [],
    fanout: [item('intent', 'intent', true), item('scope', 'scope')],
    judge: { prompt: 'JUDGE', schema: {}, agent_type: 'factory:judge' },
    critique: { prompt: 'GOD', schema: {}, agent_type: 'factory:god-eye' },
    editor: { prompt: 'EDIT', schema: {}, agent_type: 'factory:contract-editor', todo: [] },
    ledger: { round: 2, prior, next_id: prior.length, new_since: {}, changed_sections: null, settled_sections: [], nothing_new: false },
    ...extra,
  };
}
const APPROVE = { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', outcome: 'o' }, checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, no_open_blockers: true, constraints_consistent: true }, items: [] };
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
const NXOS = [
  'Which NX-OS CLI command sets the allowed VLAN list on a trunk interface?',
  'What is the exact NX-OS syntax for switchport trunk allowed vlan?',
  "Does NX-OS use 'switchport trunk allowed vlan add' to add VLANs to a trunk?",
  'Confirm the NX-OS command form for configuring trunk allowed VLANs',
  "NX-OS: is the command 'switchport trunk allowed vlan' or 'switchport allowed vlan'?",
  'Which command does NX-OS accept to set allowed VLANs on trunk ports?',
];
const issue = (id, text, kind, extra = {}) => ({ id, text, kind, impact: 'high', draft: text, owner: 'user', status: 'proposed', question_id: null, answer: null, aliases: [], notes: [], history: [], source: 'judge', round: 1, ...extra });
const q = (question, extra = {}) => ({ question, category: 'scope', why: 'w', default: 'None given: answer needed', ...extra });

function newJob(root, { risk = 'medium', policy } = {}) {
  if (policy) fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify(policy));
  const J = F.cli(root, ['job', 'new', '--title', 'Nautobot interface VLAN sync', '--type', 'feature', '--risk', risk]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), J2.CONTRACT);
  F.cli(root, ['next']);
  return J;
}
// A clarify round recorded from a hand-made envelope (what the workflow would return).
function round(root, data, status = 'needs_user') {
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  return F.record(root, F.envelope(b, status, { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, ...data }));
}
// A clarify round through the real workflow script, with a scripted crew.
async function realRound(root, agent) {
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify'], { allowFail: false });
  const { result, calls } = await H.run(WF, b, agent);
  assert.deepEqual(validate(ENV, result), []);
  return { brief: b, result, calls, record: F.record(root, result) };
}
const ledgerOf = (root, J) => clarify.load(root, J);
const contractOf = (root, J) => fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8');
const say = (root, prompt) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'prompt.js')], { input: JSON.stringify({ prompt, cwd: root, hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8' });
const told = (out) => JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
const statusText = (root, args = []) => spawnSync('node', [F.BIN, 'clarify', 'status', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } }).stdout;
const briefFile = (b, role) => fs.readFileSync((role === 'judge' ? b.judge : role === 'god-eye' ? b.critique : role === 'editor' ? b.editor : b.fanout[0]).prompt.split('\n')[1].trim(), 'utf8');

// ---------------------------------------------------------------- A. one ledger, owned by the CLI
test('A: the ledger is a sealed clarify-ledger.json: subject, owner, status, settled_by, links and history per issue; settled is final', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  assert.equal(F.cli(root, ['clarify', 'status', '--json']).ledger, false, 'no ledger before the first round');
  const r = round(root, { judge: { questions: [q('Should the sync prune VLANs not in Nautobot?', { default: 'Your call: prune them', same_as: 'new', subject: 'sync.prune' })], dismissed: [] } });
  assert.equal(r.status, 'needs_user');
  const file = path.join(F.jobDir(root, J), 'clarify-ledger.json');
  assert.ok(seal.valid(JSON.parse(fs.readFileSync(file, 'utf8'))), 'sealed like the other records');
  const d = ledgerOf(root, J);
  assert.equal(d.version, 2);
  const [u1] = d.issues;
  for (const k of ['id', 'subject', 'text', 'kind', 'impact', 'owner', 'status', 'settled_by', 'question_id', 'answer', 'default', 'history', 'aliases', 'notes']) assert.ok(k in u1, `issue field ${k}`);
  assert.deepEqual([u1.id, u1.subject, u1.owner, u1.status, u1.question_id, u1.default], ['U-1', 'sync.prune', 'user', 'proposed', 'Q-1', 'Your call: prune them']);
  assert.ok(u1.history.some((h) => h.event === 'asked' && h.text === 'Q-1'));
  assert.equal(require('../cli/core/job').load(root, J).question_log[0].unknown, 'U-1', 'the question names its issue');
  // settled is final: the next round's workflow says otherwise, the ledger keeps it
  F.cli(root, ['answer', 'Q-1', 'yes, prune them']);
  round(root, { ledger: { issues: [{ ...u1, status: 'proposed', answer: null, settled_by: null }], raised: { created: [], folded: [], notes: [] } } });
  const d2 = ledgerOf(root, J);
  assert.deepEqual([d2.issues[0].status, d2.issues[0].settled_by, d2.issues[0].answer], ['settled', 'user', 'yes, prune them']);
  // a hand-edited ledger fails its seal and is rebuilt from the (sealed) question log and answers
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.issues[0].answer = 'no, keep them';
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.deepEqual(clarify.load(root, J), { tampered: true });
  const v = F.cli(root, ['clarify', 'status', '--json']);
  assert.equal(v.migration.tampered_ledger, true);
  assert.equal(v.issues[0].answer, 'yes, prune them', 'the answer the user gave, not the edit');
});

// ---------------------------------------------------------------- B. identity by subject
test('B: paraphrases fold into one issue (subject key, then tokens); different issues stay apart; same_as and alias ids name it', () => {
  const list = [];
  for (const t of NXOS) {
    const hit = clarify.findSame(list, { text: t });
    if (hit) hit.aliases.push({ id: `U-${list.length + 10}`, text: t });
    else list.push(clarify.cleanIssue({ id: `U-${list.length + 1}`, text: t, kind: 'constraint' }));
  }
  assert.equal(list.length, 1, 'six phrasings of the NX-OS command are one issue');
  assert.equal(list[0].owner, 'design', 'and an implementation detail');
  for (const other of ['Should the sync remove VLANs that are not in Nautobot from trunk ports?', "Which device roles are in scope for the sync (leaf, spine, border)?", 'Where is add implemented and what does it do today?']) {
    assert.equal(clarify.findSame(list, { text: other }), null, `"${other}" is a different issue`);
  }
  assert.equal(clarify.findSame(list, { text: 'anything', same_as: 'U-1' }), list[0], 'same_as names it');
  assert.equal(clarify.findSame(list, { text: 'anything', same_as: 'U-11' }), list[0], 'an alias id names it too');
  assert.equal(clarify.subjectKey('NX-OS switchport-command'), 'nxos.switchport.command');
  // an agent-given subject is identity; two agent-given subjects that differ need a closer match
  assert.equal(clarify.sameIssue({ subject: 'sync.prune', subject_explicit: true, text: 'Remove extra VLANs?' }, { subject: 'sync.prune', subject_explicit: true, text: 'Prune the trunks?' }), true);
  assert.equal(clarify.sameIssue({ subject: 'nxos.native-vlan', subject_explicit: true, text: 'Which NX-OS command sets the native VLAN on a trunk?' }, { subject: 'nxos.allowed-vlans', subject_explicit: true, text: NXOS[0] }), false);
});

test('B: the workflow and the CLI apply the same dedup; a raise against a settled subject is a note; factory record folds a raise the workflow missed', async () => {
  // the workflow: the judge's "new" paraphrase of a settled issue is noted on it, not asked
  const prior = [issue('U-1', 'Should the sync prune VLANs that are not in Nautobot?', 'scope', { status: 'settled', settled_by: 'user', subject: 'sync.prune', subject_explicit: true, answer: 'yes', question_id: 'Q-1' })];
  const r = await H.run(WF, brief(prior), crew({ JUDGE: () => ({ questions: [q('Should VLANs missing from Nautobot be pruned from the trunks?', { same_as: 'new', subject: 'sync.prune' })], dismissed: [] }) }));
  assert.equal(r.result.status, 'ok');
  assert.equal(r.result.data.ledger.issues.length, 1);
  assert.match(r.result.data.ledger.issues[0].notes[0].text, /raised again \(not reopened\)/);
  assert.equal(r.result.data.ledger.issues[0].status, 'settled');
  assert.deepEqual(r.result.data.ledger.raised.notes.map((x) => x.issue), ['U-1']);
  // the CLI: an envelope with a new issue that paraphrases a live one → folded as an alias
  const root = F.makeRepo();
  const J = newJob(root);
  round(root, { judge: { questions: [q(NXOS[3], { category: 'scope', owner: 'user', subject: 'nxos.command.allowed.vlan' })], dismissed: [] } });
  const d = ledgerOf(root, J);
  assert.equal(d.issues[0].owner, 'user', 'the judge said it is the user\'s');
  round(root, { ledger: { issues: [...d.issues, issue('U-2', NXOS[5], 'scope', { source: 'god-eye', round: 2 })], raised: { created: [], folded: [], notes: [] } } });
  const d2 = ledgerOf(root, J);
  assert.deepEqual(d2.issues.map((u) => u.id), ['U-1']);
  assert.deepEqual(d2.issues[0].aliases.map((a) => a.id), ['U-2']);
  // the token rule is written twice: the workflow's copy is the CLI's
  const wf = fs.readFileSync(WF, 'utf8');
  for (const line of ['if (onlyA && onlyA === onlyB && shared < 5) return false', 'return strict ? jac >= 0.6 : jac >= 0.5 || ovl >= 0.75']) assert.ok(wf.includes(line) && fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'clarify.js'), 'utf8').includes(line), line);
});

test('B: every agent that raises an issue carries same_as and subject in its schema and recipe; every brief carries the ledger', () => {
  const S = (n) => JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'schemas', 'agent-outputs', `${n}.json`), 'utf8'));
  assert.ok(S('judge').properties.questions.items.properties.same_as && S('judge').properties.questions.items.properties.subject && S('judge').properties.questions.items.properties.owner);
  assert.ok(S('judge').properties.dismissed.items.properties.same_as);
  assert.ok(S('analyst').properties.questions.items.properties.same_as && S('analyst').properties.questions.items.properties.subject);
  assert.ok(S('intent-critique').properties.items.items.properties.ref && S('intent-critique').properties.checklist);
  for (const a of ['judge', 'intent-analyst', 'god-eye']) assert.match(fs.readFileSync(path.join(F.PLUGIN, 'agents', `${a}.md`), 'utf8'), /CLARIFY LEDGER/, `${a} reads the ledger`);
  const root = F.makeRepo();
  newJob(root);
  round(root, { judge: { questions: [q('Should the sync prune?', { default: 'yes' })], dismissed: [] } });
  F.cli(root, ['answer', 'Q-1', 'yes']);
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.match(briefFile(b, 'judge'), /same_as/);
  assert.ok(b.ledger && Array.isArray(b.ledger.changed_sections), 'the ledger brief: what changed since the last round');
  assert.deepEqual([b.ledger.prior[0].status, b.ledger.next_id], ['settled', 1], 'the workflow gets the ledger, settled issues included');
});

// ---------------------------------------------------------------- C. one answer channel
test('C: factory answer U-n / Q-n / --default settles the issue; free text is matched or refused loudly; nothing is dropped', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  round(root, { judge: { questions: [
    q('Should the sync prune VLANs not in Nautobot?', { default: 'Your call: prune them' }),
    q('Which device roles are in scope (leaf, spine, border)?'),
    q('Who signs off the first production run?', { category: 'acceptance' }),
  ], dismissed: [] } });
  // U-n with an answer
  let a = F.cli(root, ['answer', 'U-3', 'the DC operations lead']);
  assert.deepEqual([a.issue, a.settled_by, a.id], ['U-3', 'user', 'Q-3']);
  // Q-n --default: the proposed default, without its "Your call:" label
  a = F.cli(root, ['answer', 'Q-1', '--default']);
  assert.deepEqual([a.settled_by, a.answer], ['assumption_accepted', 'prune them']);
  // free text: matched by overlap with the issue
  a = F.cli(root, ['answer', '--question', 'Which device roles are in scope for the sync?', '--answer', 'leaf and border']);
  assert.equal(a.issue, 'U-2');
  // free text that matches nothing: refused, with the open ids; nothing recorded
  const before = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'answers.json'), 'utf8')).length;
  const no = F.cli(root, ['answer', '--question', 'What colour should the dashboard be?', '--answer', 'blue']);
  assert.equal(no.code, 'no_match');
  assert.match(no.message, /nothing was recorded/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'answers.json'), 'utf8')).length, before);
  assert.deepEqual(ledgerOf(root, J).issues.map((u) => [u.id, u.status, u.settled_by]), [['U-1', 'settled', 'assumption_accepted'], ['U-2', 'settled', 'user'], ['U-3', 'settled', 'user']]);
  assert.equal(F.cli(root, ['answer', 'Q-9', 'x']).code, 'bad_input');
  // the old form still works, and a question with no default cannot be "defaulted"
  const r2 = F.makeRepo();
  newJob(r2);
  round(r2, { judge: { questions: [q('Who signs off the first run?')], dismissed: [] } });
  assert.equal(F.cli(r2, ['answer', 'Q-1', '--default']).code, 'no_default');
  assert.equal(F.cli(r2, ['answer', '--id', 'Q-1', '--answer', 'the lead']).settled_by, 'user');
});

test('C: a numbered chat reply ("1 yes, 2 …", "skip 2", "defaults") is recorded by the prompt hook; answers are the main session\'s, never an agent\'s', () => {
  assert.deepEqual(clarify.parseNumbered('1 yes, 2 trunk ports too'), { all_defaults: false, items: [{ n: 1, text: 'yes' }, { n: 2, text: 'trunk ports too' }] });
  assert.deepEqual(clarify.parseNumbered('1. yes\n2) no, keep them'), { all_defaults: false, items: [{ n: 1, text: 'yes' }, { n: 2, text: 'no, keep them' }] });
  assert.deepEqual(clarify.parseNumbered('1 yes, skip 2').items, [{ n: 1, text: 'yes' }, { n: 2, skip: true }]);
  assert.equal(clarify.parseNumbered('approve'), null);
  assert.equal(clarify.parseNumbered('defaults').all_defaults, true);
  const root = F.makeRepo();
  const J = newJob(root);
  // a numbered message before there is a question set is left alone
  assert.equal(say(root, '1 prune them, 2 yes').stdout, '');
  round(root, { judge: { questions: [q('Should the sync prune VLANs not in Nautobot?', { options: ['Yes, prune', 'No'], default: 'Yes, prune' }), q('Is the dry run required first?', { default: 'yes' })], dismissed: [] } });
  assert.match(told(say(root, '1 prune them, 2 yes')), /Recorded 2 answer\(s\): Q-1 → prune them; Q-2 → yes/);
  const d = ledgerOf(root, J);
  assert.deepEqual(d.issues.map((u) => [u.status, u.answered.via]), [['settled', 'chat'], ['settled', 'chat']]);
  // the set is answered: a numbered message now is just a message
  assert.equal(say(root, '7 yes').stdout, '');
  // answers and notes stay the main session's: the guard refuses them from a subagent
  const pol = guardRules.loadPolicy(root);
  assert.match(guardRules.checkBash(root, 'factory answer Q-1 yes', pol, { agent: true }), /never a factory agent's/);
  assert.match(guardRules.checkBash(root, 'factory clarify note U-1 "x"', pol, { agent: true }), /never a factory agent's/);
  assert.equal(guardRules.checkBash(root, 'factory answer Q-1 yes', pol, { agent: false }), null, 'the main session relays the user');
  assert.equal(guardRules.checkBash(root, 'factory clarify status', pol, { agent: true }), null, 'clarify status is open to agents');
  // and the hook process passes the subagent marker through
  const g = spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'guard.js')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'factory answer Q-1 no' }, cwd: root, agent_id: 'a1', agent_type: 'factory:judge' }), encoding: 'utf8' });
  assert.match(JSON.parse(g.stdout).hookSpecificOutput.permissionDecisionReason, /never a factory agent's/);
});

// ---------------------------------------------------------------- E. rounds review only what changed
test('E: briefs carry what changed and what is new; a round with nothing new skips the analysts and the judge', async () => {
  const root = F.makeRepo();
  const J = newJob(root);
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.equal(b.ledger.changed_sections, null, 'the first round reviews everything');
  assert.deepEqual(b.editor.todo, [], 'nothing to apply before the first round');
  round(root, { judge: { questions: [q('Should the sync prune?', { default: 'yes' })], dismissed: [] } });
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.deepEqual(b.ledger.changed_sections, []);
  assert.equal(b.ledger.nothing_new, false, 'the question was asked last round: its default is taken now');
  assert.deepEqual(b.ledger.new_since.defaults_taken, [{ issue: 'U-1', default: 'yes' }]);
  assert.ok(b.editor.todo.some((t) => t.ref === 'U-1' && t.from === 'ledger'), 'the editor applies the accepted default');
  assert.match(briefFile(b, 'judge'), /No contract section changed since the last round/);
  // the editor's revision is written; the section it changed shows as changed next round
  const c = contractOf(root, J);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: APPROVE, contract: { text: c.replace('- Access-port VLANs', '- Access-port VLANs\n- Pruning access ports'), edits: [{ label: 'apply what was settled', ok: true, applied: [{ ref: 'U-1', section: 'Non-goals', change: 'x' }], skipped: [], removed: [], requested: [{ from: 'ledger', ref: 'U-1' }] }] } }));
  assert.match(contractOf(root, J), /- Pruning access ports/);
  assert.equal(ledgerOf(root, J).issues[0].applied_round, 2);
  // the workflow: nothing new → analysts and judge skipped, the ledger's proposals asked
  const prior = [issue('U-1', 'Who signs off?', 'acceptance', { default: 'the lead' })];
  const r = await H.run(WF, brief(prior, { ledger: { round: 3, prior, next_id: 1, new_since: {}, changed_sections: [], settled_sections: ['goal'], nothing_new: true } }), crew({
    'factory:intent-analyst': () => { throw new Error('analyst ran'); },
    'factory:judge': () => { throw new Error('judge ran'); },
  }));
  assert.equal(r.result.data.quiet, true);
  assert.deepEqual(r.result.questions.map((x) => x.unknown), ['U-1']);
  assert.deepEqual(r.result.data.degraded, [], 'skipped angles are not missing angles');
});

test('E: God Eye\'s checklist: unpointed or settled items are notes (approve with notes); a pointed blocker is revised, then asked; never needs_user with zero questions', async () => {
  const deferred = [issue('U-1', NXOS[0], 'constraint', { owner: 'design', status: 'deferred_to_design', settled_by: 'design_deferral', subject: 'nxos.command.allowed.vlan' })];
  // revise, nothing actionable: notes only
  let r = await H.run(WF, brief(deferred), crew({ GOD: () => ({ ...APPROVE, verdict: 'revise', items: [{ issue: 'The goal could be tighter', severity: 'minor' }, { issue: NXOS[1], severity: 'major', ref: 'U-1' }, { issue: 'Log format?', severity: 'major' }] }) }));
  assert.equal(r.result.status, 'ok');
  assert.equal(r.result.data.approved_with_notes, true);
  assert.equal(r.result.data.notes.length, 3);
  assert.match(r.result.data.notes.find((n) => n.ref === 'U-1').text, /already settled \(deferred_to_design/);
  // a pointed blocker: editor → God Eye again → approve
  let god = 0;
  r = await H.run(WF, brief(deferred), crew({
    GOD: () => ((god += 1) === 1 ? { ...APPROVE, verdict: 'revise', items: [{ issue: 'AC-2 is not testable', severity: 'blocker', ref: 'AC-2', suggestion: 'name the output' }] } : APPROVE),
    EDIT: (p) => { assert.match(p, /"ref": "AC-2"/); return { contract: '# x\n\n## Intent\n- Problem: p\n', applied: [{ ref: 'AC-2', section: 'Acceptance criteria', change: 'x' }], skipped: [], removed: [] }; },
  }));
  assert.deepEqual(r.calls.map((c) => c.opts.label).filter((l) => /god|editor/.test(l)), ['god-eye · intent', 'contract editor · God Eye\'s items', 'god-eye · intent (after the revision)']);
  assert.equal(r.result.status, 'ok');
  assert.equal(r.result.data.contract.text, '# x\n\n## Intent\n- Problem: p\n');
  assert.deepEqual(r.result.data.contract.edits[0].requested, [{ from: 'god-eye', ref: 'AC-2' }]);
  assert.match(r.calls.find((c) => /after the revision/.test(c.opts.label)).prompt, /----- BEGIN CONTRACT -----/);
  // still a blocker after the revision → one question with God Eye's suggestion as its default
  r = await H.run(WF, brief(deferred), crew({ GOD: () => ({ ...APPROVE, verdict: 'revise', items: [{ issue: 'AC-2 is not testable', severity: 'blocker', ref: 'AC-2', suggestion: 'AC-2: a dry run lists each change' }] }) }));
  assert.equal(r.result.status, 'needs_user');
  assert.deepEqual(r.result.questions.map((x) => [x.category, x.default]), [['acceptance', 'AC-2: a dry run lists each change']]);
  // intent not confirmed → an intent question with no default, never zero questions
  r = await H.run(WF, brief(deferred), crew({ GOD: () => ({ ...APPROVE, intent_confirmed: false }) }));
  assert.equal(r.result.status, 'needs_user');
  assert.equal(r.result.questions[0].category, 'intent');
  assert.match(r.result.questions[0].default, /^None/);
  assert.deepEqual(validate(ENV, r.result), []);
  // the CLI side: a revise envelope with nothing for the user is "revise" (clarify runs again), not needs_user
  const root = F.makeRepo();
  newJob(root);
  const x = round(root, { critique: { ...APPROVE, verdict: 'revise', items: [{ issue: 'The goal could name the report', severity: 'major', ref: 'Goal' }] } }, 'ok');
  assert.equal(x.status, 'revise');
  assert.ok(!x.questions);
});

// ---------------------------------------------------------------- F. implementation facts go to design
test('F: implementation facts are deferred to design: not asked, not blocking H1, written to the contract, handed to ground and decide', () => {
  for (const t of [NXOS[0], 'What are the exact line ranges in sync/nxos.py that build the commands?', 'Which pynautobot API field holds the untagged VLAN?', 'Does the ntc-templates parser return trunking_vlans as a list?']) assert.equal(clarify.classify({ text: t }, 'constraint'), 'design', t);
  for (const t of ['Should the sync prune VLANs not in Nautobot?', 'Which device roles are in scope?']) assert.equal(clarify.classify({ text: t }, 'scope'), 'user', t);
  assert.equal(clarify.classify({ text: NXOS[0], owner: 'user' }, 'constraint'), 'user', 'the agent\'s owner wins');
  assert.equal(clarify.classify({ text: 'What exact syntax do you mean by "sync"?' }, 'intent'), 'user', 'an intent issue is always the user\'s');
  assert.equal(clarify.classify({ text: 'x', owner: 'research' }, 'scope'), 'user', 'no research lane in this clarify: the user is asked');
  const root = F.makeRepo();
  const J = newJob(root);
  const r = round(root, { judge: { questions: [q(NXOS[0], { category: 'constraint' })], dismissed: [{ question: 'Which serializer fields does the API return?', reason: 'design: the architect looks it up' }] }, critique: APPROVE }, 'ok');
  assert.equal(r.status, 'ok', 'an implementation detail does not block H1');
  const d = ledgerOf(root, J);
  assert.deepEqual([d.issues[0].owner, d.issues[0].status, d.issues[0].settled_by, d.issues[0].question_id], ['design', 'deferred_to_design', 'design_deferral', null]);
  assert.match(contractOf(root, J), /## Deferred to design\n<!--[^\n]*-->\n- U-1: Which NX-OS CLI command/);
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  assert.equal(F.cli(root, ['next']).workflow, 'ground');
  const g = F.cli(root, ['wfargs', 'ground']);
  assert.match(fs.readFileSync(g.probes[0].prompt.split('\n')[1].trim(), 'utf8'), /Deferred to design by clarify[\s\S]*U-1 \[constraint\] Which NX-OS CLI command/);
  F.record(root, F.envelope(g, 'ok', { topics: [{ topic: 'codebase', claims: [], unknowns: [] }], degraded: [] }));
  assert.equal(F.cli(root, ['next']).config, 'decide');
  const dd = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  assert.match(fs.readFileSync(dd.judge.prompt.split('\n')[1].trim(), 'utf8'), /Deferred to design by clarify[\s\S]*U-1/);
});

// ---------------------------------------------------------------- G. progress, not rounds
test('G: rounds without progress park the job (not converging); a waiting question is never a park; a degraded round is retried once and not counted; resume resets', () => {
  const job = require('../cli/core/job');
  const root = F.makeRepo();
  const J = newJob(root);
  let r = round(root, { judge: { questions: [q('Should the sync prune?')], dismissed: [] } });
  assert.equal(r.clarify.round.progress, true, 'asked a question');
  // the user doesn't answer and there is no default: waiting, not progress, and not a park
  r = round(root, {});
  assert.equal(r.status, 'needs_user');
  assert.deepEqual([r.questions[0].id, r.questions[0].waiting], ['Q-1', true], 'the same question again, same id');
  assert.equal(r.clarify.round.progress, false);
  // a degraded round: retried automatically, not counted
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  r = F.record(root, F.envelope(b, 'degraded', { analysts: [], degraded: ['intent-analyst:ambiguity'], judge: { questions: [], dismissed: [] } }));
  assert.equal(r.status, 'retry', 'the round runs again by itself before the waiting question is shown again');
  let st = job.load(root, J);
  assert.deepEqual([st.counters.clarify_no_progress, st.counters.clarify_degraded_rounds], [1, 1]);
  assert.equal(clarify.limits(st).counted, 2);
  // with nothing for the user: a degraded round is a retry, two in a row ask the user
  const r2 = F.makeRepo();
  const J3 = newJob(r2);
  const deg = () => { const bb = F.cli(r2, ['wfargs', 'fanout-judge', '--config', 'clarify']); return F.record(r2, F.envelope(bb, 'degraded', { analysts: [], degraded: ['intent-analyst:ambiguity'], judge: { questions: [], dismissed: [] } })); };
  assert.equal(deg().status, 'retry');
  assert.equal(deg().status, 'degraded');
  st = job.load(r2, J3);
  assert.deepEqual([st.counters.clarify_rounds, clarify.limits(st).counted, st.counters.clarify_no_progress || 0], [2, 0, 0], 'degraded rounds count toward neither rule');
  // two rounds in a row with no progress: not converging → park
  const r3 = F.makeRepo();
  const J4 = newJob(r3);
  const revise = { critique: { ...APPROVE, verdict: 'revise', items: [{ issue: 'wordy', severity: 'major', ref: 'Goal' }] } };
  assert.equal(round(r3, revise, 'ok').status, 'revise');
  const x = round(r3, revise, 'ok');
  assert.equal(x.status, 'park');
  assert.match(x.park_reason, /not converging: 2 round\(s\) in a row settled nothing/);
  st = job.load(r3, J4);
  assert.equal(st.status, 'parked');
  F.reply(r3, 'resume');
  st = job.load(r3, J4);
  assert.equal(st.counters.clarify_no_progress, 0, 'resume resets the no-progress counter');
  assert.equal(st.counters.clarify_rounds, 2, 'the round counter stays monotonic');
  assert.equal(F.cli(r3, ['next']).skill, 'clarify');
});

test('G: the hard ceiling (limits.max_intent_rounds, default 10) parks at factory next; resume allows the rounds the no-progress rule needs; old snapshots keep max+2', () => {
  const pol = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'policy', 'default-policy.json'), 'utf8')).limits;
  assert.deepEqual([pol.max_intent_rounds, pol.clarify_no_progress_rounds], [10, 2]);
  const job = require('../cli/core/job');
  const root = F.makeRepo();
  const J = newJob(root, { policy: { limits: { max_intent_rounds: 2 } } });
  assert.equal(clarify.limits(job.load(root, J)).ceiling, 2);
  round(root, { judge: { questions: [q('q one about pruning', { default: 'a' })], dismissed: [] } });
  round(root, { judge: { questions: [q('another thing entirely here', { default: 'b' })], dismissed: [] } });
  const n = F.cli(root, ['next']);
  assert.equal(n.action, 'parked');
  assert.equal(n.rule, 'cap.clarify_rounds');
  assert.match(n.reason, /ceiling of 2 rounds/);
  F.reply(root, 'resume');
  assert.equal(clarify.limits(job.load(root, J)).ceiling, 4, 'two more rounds after the ceiling');
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  // a pre-v2 snapshot (no clarify_no_progress_rounds): max_intent_rounds + 2, or the new default if higher
  assert.equal(clarify.limits({ policy: { limits: { max_intent_rounds: 4 } }, counters: {} }).ceiling, 10);
  assert.equal(clarify.limits({ policy: { limits: { max_intent_rounds: 12 } }, counters: {} }).ceiling, 14);
  assert.equal(require('../cli/core/budgets').snapshot(root, job.load(root, J)).limit.clarify_rounds, 4, 'the brief\'s budget shows the ceiling');
});

// ---------------------------------------------------------------- H. one writer
test('H: the guard denies hand edits of contract.md while the job is in clarify, naming the commands; the draft and amendments stay writable', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const policy = guardRules.loadPolicy(root);
  const file = path.join(F.jobDir(root, J), 'contract.md');
  assert.equal(guardRules.checkWrite(root, file, policy), null, 'before the first round: intake and the clarify skill write the draft');
  round(root, { judge: { questions: [q('Should the sync prune?')], dismissed: [] } });
  const why = guardRules.checkWrite(root, file, policy);
  assert.match(why, new RegExp(`${J} is in clarify`));
  for (const c of ['factory answer', 'factory clarify note', 'factory clarify status', 'factory next']) assert.ok(why.includes(c), c);
  assert.ok(guardRules.checkBash(root, `echo x > ${file}`, policy), 'a shell redirect is the same write');
  assert.equal(guardRules.checkWrite(root, path.join(F.jobDir(root, J), 'adr-001-x.md'), policy), null, 'other job docs are unaffected');
  // the hook process says so to the chat agent
  const g = spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'guard.js')], { input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' }, cwd: root }), encoding: 'utf8' });
  assert.match(JSON.parse(g.stdout).hookSpecificOutput.permissionDecisionReason, /is in clarify/);
  // the contract still changes through the record path (the CLI-owned sections, the editor's revision)
  F.cli(root, ['answer', 'Q-1', 'yes, prune']);
  round(root, { critique: APPROVE }, 'ok');
  assert.match(contractOf(root, J), /## Clarifications \(settled\)\n<!--[^\n]*-->\n- U-1 \(Q-1\): Should the sync prune\? → yes, prune \(answered by user\)/);
  // after H1: an amendment may edit it again
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  assert.equal(guardRules.checkWrite(root, file, policy), null);
  // the editor's revision is checked: one that carries foreign sections or the agent's own instructions is not written
  const r2 = F.makeRepo();
  const J3 = newJob(r2);
  const r = round(r2, { critique: APPROVE, contract: { text: `${J2.CONTRACT}\n## Your final message\nReply with JSON\n`, edits: [{ label: 'apply', ok: true, applied: [], skipped: [] }] } }, 'ok');
  assert.ok(r.clarify.contract_revision.rejected);
  assert.ok(!/Your final message/.test(contractOf(r2, J3)));
  // and the CLI keeps its own sections, whatever the editor returned for them
  const keep = require('../cli/core/contract').keepCliSections(`${J2.CONTRACT}\n## Deferred to design\n- invented\n`, J2.CONTRACT);
  assert.ok(!/invented/.test(keep));
});

// ---------------------------------------------------------------- I. visibility
test('I: factory next carries the ledger summary and the exact answer commands; clarify status prints the table and the trend; the console has the Clarify block', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  round(root, { judge: { questions: [q(NXOS[0], { category: 'constraint' }), q('Should the sync prune VLANs not in Nautobot?', { default: 'Your call: prune' })], dismissed: [] } });
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify');
  assert.deepEqual(n.clarify.open_by_owner, { user: 1, design: 0 });
  assert.deepEqual(n.clarify.answer_commands, ['factory answer Q-1 "<answer>" (or: factory answer Q-1 --default)']);
  const txt = statusText(root);
  assert.match(txt, new RegExp(`^Clarify ledger — ${J}: 2 issue\\(s\\)`));
  assert.match(txt, /U-2 +sync\.prune\.vlan\.nautobot +proposed +user +answer: factory answer Q-1/);
  assert.match(txt, /U-1 +nxos\.command\.allowed\.vlan +deferred_to_design +design +ground\/decide settle it/);
  assert.match(txt, /Round  opened  settled  deferred  asked  progress\n1 +2 +0 +1 +1 +yes/);
  const js = F.cli(root, ['clarify', 'status', '--json']);
  assert.equal(js.issues.length, 2);
  assert.equal(js.rounds[0].opened, 2);
  assert.ok(!guardRules.checkBash(root, 'factory clarify status --json', guardRules.loadPolicy(root), { agent: true }), 'read-only and open to agents');
  F.cli(root, ['clarify', 'note', 'U-2', 'only on the leaf switches']);
  assert.equal(ledgerOf(root, J).issues.find((u) => u.id === 'U-2').notes.pop().text, 'only on the leaf switches');
  F.cli(root, ['clarify', 'note', 'contract', 'the drift report is emailed']);
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  assert.deepEqual(b.editor.todo.filter((t) => t.from === 'user note').map((t) => t.ref), ['U-2', 'contract'], 'notes reach the editor');
  // the console
  const data = require('../cli/core/console').build(root, { job: J });
  const c = data.jobs.find((j) => j.id === J).clarify;
  assert.deepEqual([c.totals.issues, c.questions.length, c.deferred.length, c.rounds.length], [2, 1, 1, 1]);
  assert.ok(c.issues.every((r) => r.status && r.owner && r.next));
  const html = fs.readFileSync(path.join(F.PLUGIN, 'console', 'console.html'), 'utf8');
  assert.match(html, /function clarifyBlock\(j\)/, 'the section view block');
  assert.match(html, /function clarifyHtml\(job\)/, 'the job view block');
  assert.match(html, /function turnLabel\(m\)/, 'the Board says how many questions');
});

// ---------------------------------------------------------------- migration: the J-0002 fixture
test('migration: J-0002 (v1) → the ledger on first touch: duplicates folded, free-form answers matched, implementation facts deferred; status works with no new round', () => {
  const root = F.makeRepo();
  const J = J2.build(root);
  assert.equal(J, 'J-0002');
  const file = path.join(F.jobDir(root, J), 'clarify-ledger.json');
  assert.equal(fs.existsSync(file), false, 'v1 kept no issue record');
  // clarify status: read-only, shows the migrated ledger and what migrated
  const txt = statusText(root, ['--job', J]);
  assert.match(txt, /Migrated from v1: 4 duplicate\(s\) folded \(U-6→U-3, U-11→U-3, U-15→U-3, U-17→U-3\); 2 free-form answer\(s\) matched \(U-2, U-10\); 4 deferred to design \(U-3, U-9, U-13, U-18\); ceiling 10 rounds\./);
  assert.match(txt, /"Which device roles are in scope for the sync\?" → U-2: leaf and border, not spine/);
  assert.match(txt, /Not matched: "Does NX-OS keep the allowed list on a port-channel flap\?"; "What colour should the dashboard be\?"/);
  assert.match(txt, /U-3 +nxos\.command\.allowed\.vlan +deferred_to_design +design .*\[aliases U-6, U-11, U-15, U-17\]/);
  assert.match(txt, /U-4 +sync\.run\.nightly\.every +proposed +user +answer: factory answer Q-4/);
  assert.match(txt, /9 round\(s\) before clarify v2 not counted/);
  assert.equal(fs.existsSync(file), false, 'status wrote nothing');
  const v = F.cli(root, ['clarify', 'status', '--job', J, '--json']);
  assert.deepEqual([v.totals.issues, v.totals.settled, v.totals.deferred_to_design, v.totals.dropped, v.open_by_owner.user], [14, 9, 4, 0, 1]);
  assert.deepEqual([v.limits.ceiling, v.limits.rounds_counted], [10, 0], 'the pre-v2 snapshot (cap 6) gets the new default ceiling; its 9 rounds are not counted');
  const by = Object.fromEntries(v.issues.map((r) => [r.id, r]));
  assert.deepEqual([by['U-1'].status, by['U-1'].answer], ['settled', 'yes, prune them, but never VLAN 1'], 'a later answer to the same question replaces the earlier one');
  assert.deepEqual([by['U-8'].status, by['U-8'].settled_by], ['settled', 'user'], 'an answer by the exact question text');
  assert.deepEqual([by['U-16'].answer], ['yes'], 'the answer by Q-n, not the earlier free-form match');
  assert.ok(!v.migration.matched_answers.some((m) => m.issue === 'U-16'), 'a match replaced by the user\'s own answer is not reported');
  // the first write persists it: the human resumes, and a note is a write
  F.reply(root, `resume ${J}`);
  F.cli(root, ['clarify', 'note', '--job', J, 'U-4', 'nightly is fine for now']);
  const after = ledgerOf(root, J);
  assert.equal(after.version, 2);
  assert.equal(after.migration.folded.length, 4);
  assert.deepEqual(after.migration.deferred.map((x) => x.id), ['U-3', 'U-9', 'U-13', 'U-18']);
  assert.deepEqual(after.issues.find((u) => u.id === 'U-3').aliases.map((a) => [a.id, a.question_id]), [['U-6', 'Q-6'], ['U-11', 'Q-11'], ['U-15', 'Q-15'], ['U-17', 'Q-17']]);
  // an answer to a folded question's Q-n reaches its issue
  const r = F.cli(root, ['answer', '--job', J, 'Q-15', 'switchport trunk allowed vlan']);
  assert.equal(r.issue, 'U-3');
});

// ---------------------------------------------------------------- end to end, through the workflow
test('e2e: a fresh J-0002-shaped job through the real workflow: the NX-OS detail deferred, a numbered reply, paraphrases re-raised and folded, God Eye revise with nothing actionable → H1 in two rounds', async () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const c = scripted(root, J);
  // round 1
  let r = await realRound(root, c.agent);
  assert.equal(r.record.status, 'needs_user', JSON.stringify(r.record).slice(0, 400));
  assert.deepEqual(r.record.questions.map((x) => [x.id, x.unknown, x.default]), [['Q-1', 'U-1', 'Your call: prune them'], ['Q-2', 'U-2', 'leaf only']]);
  let d = ledgerOf(root, J);
  assert.deepEqual(d.issues.map((u) => [u.id, u.subject, u.status]), [['U-1', 'sync.prune', 'proposed'], ['U-2', 'sync.device.role', 'proposed'], ['U-3', 'nxos.switchport.command', 'deferred_to_design']], 'the NX-OS command is design\'s, never asked');
  // the user: a numbered chat reply; question 2 skipped (its default applies next round)
  assert.match(told(say(root, '1 yes, prune them, skip 2')), /Recorded 1 answer\(s\): Q-1 → yes, prune them\. Skipped: Q-2/);
  assert.ok(guardRules.checkWrite(root, path.join(F.jobDir(root, J), 'contract.md'), guardRules.loadPolicy(root)), 'the chat agent cannot hand-edit the contract now');
  // round 2
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  r = await realRound(root, c.agent);
  assert.equal(r.record.status, 'ok', JSON.stringify(r.record).slice(0, 600));
  assert.equal(r.record.next_gate, 'H1');
  assert.match(r.record.message, /approved with notes/);
  const labels = r.result.agents.map((a) => a.label);
  assert.equal(labels[0], 'contract editor · apply what was settled', 'the editor applies the answers first');
  assert.ok(labels.includes('contract editor · God Eye\'s items') && labels.includes('god-eye · intent (after the revision)'));
  // the judge's paraphrases (the NX-OS command, the prune question) were folded as notes, not asked
  assert.deepEqual(r.result.data.ledger.raised.created, []);
  assert.deepEqual(r.result.data.ledger.raised.notes.map((x) => x.issue).sort(), ['U-1', 'U-3']);
  d = ledgerOf(root, J);
  assert.deepEqual(d.issues.map((u) => [u.id, u.status, u.settled_by]), [['U-1', 'settled', 'user'], ['U-2', 'settled', 'assumption_accepted'], ['U-3', 'deferred_to_design', 'design_deferral']]);
  assert.ok(d.issues.find((u) => u.id === 'U-3').notes.some((x) => /raised again \(not reopened\)/.test(x.text)));
  assert.deepEqual(d.rounds.map((x) => [x.ledger.opened, x.ledger.settled, x.ledger.deferred, x.ledger.progress]), [[3, 0, 1, true], [0, 2, 0, true]]);
  assert.ok(d.notes.some((x) => x.actor === 'god-eye'), 'God Eye\'s approve-with-notes remarks are recorded');
  const text = contractOf(root, J);
  assert.match(text, /- AC-2: a dry run lists each VLAN it would add or remove per interface/, 'God Eye\'s pointed blocker was revised in');
  assert.match(text, /Should the sync remove VLANs that are on the trunk but not in Nautobot: yes, prune them/, 'the answers were applied');
  assert.match(text, /## Clarifications \(settled\)[\s\S]*U-2 \(Q-2\)[^\n]*\(default accepted\)/);
  assert.match(text, /## Deferred to design[\s\S]*U-3: What is the exact NX-OS syntax/);
  assert.deepEqual(F.cli(root, ['contract', 'check']).problems, []);
  const n = F.cli(root, ['next']);
  assert.deepEqual([n.action, n.step], ['gate', 'H1']);
  assert.notEqual(require('../cli/core/job').load(root, J).status, 'parked');
  const step = require('../cli/core/ledger').lastStep(root, J, 'clarify');
  assert.deepEqual([step.ok, step.detail.approved_with_notes, step.detail.ledger.reraised], [true, true, 2]);
});

test('e2e: the migrated J-0002 resumes and reaches H1: the answers v1 never applied are applied, God Eye re-raises the NX-OS command (a note), the open decision is answered', async () => {
  const root = F.makeRepo();
  const J = J2.build(root);
  F.reply(root, `resume ${J}`);
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify');
  assert.deepEqual(n.clarify.answer_commands, ['factory answer Q-4 "<answer>"']);
  const c = scripted(root, J, { migrated: true });
  let r = await realRound(root, c.agent);
  assert.ok(r.brief.editor.todo.filter((t) => t.from === 'ledger').length >= 9, 'every answer v1 left out of the contract goes to the editor');
  assert.equal(r.record.status, 'needs_user', JSON.stringify(r.record).slice(0, 500));
  assert.deepEqual(r.record.questions.map((x) => [x.id, x.waiting]), [['Q-4', true]], 'the open decision, same id, nothing re-asked');
  assert.equal(r.result.agents[0].label, 'contract editor · apply what was settled');
  assert.match(told(say(root, '1 nightly')), /Q-4 → nightly/);
  assert.equal(F.cli(root, ['next']).skill, 'clarify');
  r = await realRound(root, c.agent);
  assert.equal(r.record.status, 'ok', JSON.stringify(r.record).slice(0, 500));
  assert.equal(F.cli(root, ['next']).step, 'H1');
  const d = ledgerOf(root, J);
  assert.equal(d.version, 2);
  assert.ok(d.migration.persisted_at);
  assert.equal(d.issues.filter((u) => !clarify.FINAL.has(u.status)).length, 0);
  assert.equal(d.issues.find((u) => u.id === 'U-3').status, 'deferred_to_design');
  assert.ok(d.issues.find((u) => u.id === 'U-3').notes.some((x) => /raised again/.test(x.text)), 'the judge\'s NX-OS paraphrase is a note');
  assert.deepEqual(d.rounds.map((x) => x.round), [10, 11], 'the round counter went on from v1');
  const st = require('../cli/core/job').load(root, J);
  assert.deepEqual([st.counters.clarify_v2_from, clarify.limits(st).counted], [9, 2]);
});
