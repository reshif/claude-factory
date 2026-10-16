'use strict';
// Clarify v3, unit by unit (docs/DESIGN-CLARIFY-v3.md): version pins and the verdict on every
// finding, sheet replies in plain words, chat replies through the prompt hook (only clear ones;
// the main session relays the rest, and words the hook saw count as the user's own), migration
// of claude-factory's v1/v2 records, the 0.15.1 guarantees (drops, gaps and God Eye objections are
// visible; objections are never approval; proceed is the user's alone), and the guard letting
// the user edit contract.md (and the CLI checking it again).
// The end-to-end scenarios are in clarify-v3-acceptance.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const F = require('./helpers/fixture');
const C = require('../cli/core/clarify');

const NB = 'https://docs.nautobot.com/projects/core/en';

test('versions: pins from repo or user words, compatible pages, moving pages, ranges', () => {
  assert.equal(C.pinOf('==2.4.3'), '2.4.3');
  assert.equal(C.pinOf('v2.4.*'), '2.4.x');
  assert.equal(C.pinOf('latest'), null);
  assert.equal(C.pinOf('>=2.4'), null, 'a range is not a pin');
  assert.equal(C.compatible('2.4.x', '2.4.3'), true);
  assert.equal(C.compatible('2.4', '2.4.4'), true);
  assert.equal(C.compatible('3.2.25', '3.2'), true);
  assert.equal(C.compatible('2.4', '3.0'), false);
  assert.equal(C.compatible('2.4', '2'), false, 'a major-only page does not prove a minor pin');
  assert.deepEqual(C.urlVersion(`${NB}/stable/user-guide/`), { moving: true });
  assert.deepEqual(C.urlVersion(`${NB}/latest/`), { moving: true });
  assert.deepEqual(C.urlVersion(`${NB}/v2.4.4/user-guide/`), { version: '2.4.4' });
  assert.equal(C.urlVersion('src/add.js:1'), null);
  assert.equal(C.inRange('2.4.3', '>=2.4,<3'), true);
  assert.equal(C.inRange('3.0', '>=2.4,<3'), false);
  assert.equal(C.inRange('2.3.9', '^2.4'), false);
});

test('verdicts: repo quotes at their line, pages for the confirmed version, other versions and moving pages are never used', () => {
  const root = F.makeRepo();
  const data = { items: [], evidence: [] };
  const pins = { nautobot: '2.4' };
  const v = (e) => C.verdictOf(root, { item: null, tier: null, ...e }, pins, data);
  assert.equal(v({ source: 'src/add.js:1', quote: 'module.exports = (a, b) => a - b;', tier: 'repo' }), 'repo');
  assert.equal(v({ source: 'src/add.js:2', quote: 'module.exports = (a, b) => a - b;', tier: 'repo' }), 'bad_quote', 'the quote must be at the cited line');
  assert.equal(v({ source: '../outside.js:1', quote: 'x', tier: 'repo' }), 'bad_quote', 'never outside the repo');
  assert.equal(v({ source: `${NB}/v2.4.4/ipam/`, quote: 'q', system: 'nautobot' }), 'pinned');
  assert.equal(v({ source: `${NB}/v3.0.0/ipam/`, quote: 'q', system: 'nautobot' }), 'other_version');
  assert.equal(v({ source: `${NB}/stable/ipam/`, quote: 'q', system: 'nautobot', version: '2.4' }), 'unpinned', 'stable is a moving page, whatever it claims');
  assert.equal(v({ source: 'https://example.com/guide', quote: 'q', system: 'nautobot', version: '3.1' }), 'other_version');
  assert.equal(v({ source: 'https://example.com/guide', quote: 'q', system: 'nautobot' }), 'unpinned', 'no version on a pinned system: not evidence for it');
  assert.equal(v({ source: 'https://www.rfc-editor.org/rfc/rfc6585', quote: 'q', system: 'http' }), 'docs', 'a system with no pin: usable docs');
  assert.equal(v({ source: 'https://example.com/guide', quote: '' }), 'unsourced');
  for (const [verdict, ok] of [['repo', true], ['pinned', true], ['docs', true], ['other_version', false], ['unpinned', false], ['bad_quote', false], ['unsourced', false]]) assert.equal(C.usable({ verdict }), ok, verdict);
});

test('sheet replies: ok, ok but, numbered choices, other, defer, fact corrections; anything else goes to the interviewer', () => {
  const sheet = {
    decisions: [1, 2, 3].map((no) => ({ no, options: [{ key: 'a', text: 'A' }, { key: 'b', text: 'B' }], recommendation: 'a' })),
    facts: [{ no: 1, text: 'f' }],
  };
  const p = (t) => C.parseSheetReply(t, sheet);
  assert.deepEqual(p('ok'), { accept: true, answers: [], facts: [] });
  assert.deepEqual(p('ok, but 2 b'), { accept: true, answers: [{ no: 2, choice: 'b' }], facts: [] });
  assert.deepEqual(p('1 b, 3: other: use the tenant field').answers, [{ no: 1, choice: 'b' }, { no: 3, text: 'use the tenant field' }]);
  assert.deepEqual(p('2 defer').answers, [{ no: 2, defer: true }]);
  assert.deepEqual(p('fact 1: it is 2.4.3').facts, [{ no: 1, text: 'it is 2.4.3' }]);
  assert.equal(p('7 a'), null, 'no decision 7 on the sheet');
  assert.equal(p("whatever's standard, but keep the old names"), null, 'prose: the interviewer reads it');
  assert.equal(p(''), null);
});

// a repo, a job with a request, clarify driven to a stage with the fixture's scripted agents
function job({ risk = 'medium', request = 'fix add so the cart totals add up', policy = null } = {}) {
  const root = F.makeRepo();
  if (policy) {
    const pf = path.join(root, '.factory', 'policy.json');
    const pol = JSON.parse(fs.readFileSync(pf, 'utf8'));
    for (const [k, v] of Object.entries(policy)) pol[k] = { ...(pol[k] || {}), ...v };
    fs.writeFileSync(pf, JSON.stringify(pol, null, 2));
  }
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', risk, '--request', request]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  return { root, J, JD: F.jobDir(root, J) };
}
const record = (root) => JSON.parse(fs.readFileSync(path.join(F.jobDir(root, require('../cli/core/job').resolve(root).id), 'clarify.json'), 'utf8'));

test('replies: the prompt hook records only clear replies; the main session relays the rest verbatim, and words the hook saw are the user\'s own', () => {
  // the read-back waits only when policy says so (or a pin conflicts, or a question is only the user's)
  const { root } = job({ policy: { clarify: { readback: 'wait' } } });
  assert.equal(F.clarify(root, { until: 'readback_wait' }).stage, 'readback_wait');
  assert.equal(C.chatReply(root, 'should research also check the 3.x docs?'), null, 'a question is the user talking, not a reply');
  assert.equal(C.chatReply(root, 'I think the read-back missed that totals are cents'), null, 'prose at the read-back goes through the main session, which reads it back');
  // the user types prose: the hook notes it and leaves it alone; the main session relays it
  assert.equal(F.say(root, 'totals are in cents, not floats').status, 'ignored');
  const r = F.cli(root, ['clarify', 'reply', 'totals are in cents, not floats']);
  assert.ok(!r.error, JSON.stringify(r));
  let d = record(root);
  const w = d.words.find((x) => x.text === 'totals are in cents, not floats');
  assert.equal(w.via, 'reply', 'the words are kept verbatim');
  assert.equal(w.relayed, undefined, 'the hook saw exactly these words: they are the user\'s own');
  assert.equal(w.heard, 'reply hook');
  // words the user never typed (the main session paraphrasing) stay marked as relayed
  assert.equal(F.cli(root, ['next']).clarify.stage, 'readback', 'an edit reads back again');
  assert.equal(F.clarify(root, { until: 'readback_wait' }).stage, 'readback_wait');
  F.cli(root, ['clarify', 'reply', 'they said totals are cents']);
  d = record(root);
  assert.equal(d.words.find((x) => x.text === 'they said totals are cents').relayed, true);
  assert.equal(F.clarify(root, { until: 'readback_wait' }).stage, 'readback_wait');
  // ok in chat is applied by the hook itself
  const ok = F.say(root, 'ok');
  assert.equal(ok.status, 'applied', ok.text);
  assert.match(ok.text, /Recorded your reply for clarify/);
  assert.notEqual(record(root).stage, 'readback_wait');
  // the same words again from the other channel are not a second reply
  const again = F.cli(root, ['clarify', 'reply', 'ok']);
  assert.ok(again.error || /Already recorded|not waiting|nothing/i.test(again.message || ''), JSON.stringify(again));
  // the hook file holds hashes, never the user's text
  const prompts = fs.readFileSync(path.join(root, '.factory', 'log', 'prompts.jsonl'), 'utf8');
  assert.doesNotMatch(prompts, /cents/);
});

test('the user may edit contract.md at any time: the guard allows it, and the CLI checks the edited text again before H1', () => {
  const { root, J, JD } = job({ risk: 'low' });
  const { checkWrite, loadPolicy } = require('../hooks/guard-rules');
  const pol = loadPolicy(root);
  assert.equal(checkWrite(root, path.join(JD, 'contract.md'), pol), null, 'contract.md is the user\'s to edit');
  assert.match(String(checkWrite(root, path.join(JD, 'clarify.json'), pol)), /factory state/, 'the record is not');
  assert.match(String(checkWrite(root, path.join(root, '.factory', 'log', 'prompts.jsonl'), pol)), /factory state/, 'nor what the hook heard');
  F.clarify(root);
  assert.equal(F.cli(root, ['next']).step, 'H1');
  // an edit after the check: clarify runs its readiness check on the user's text before H1 again
  fs.appendFileSync(path.join(JD, 'contract.md'), '\n<!-- the user tightened AC-1 -->\n');
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify', JSON.stringify(n).slice(0, 300));
  assert.equal(n.clarify.stage, 'check');
  F.clarify(root);
  assert.equal(F.cli(root, ['next']).step, 'H1');
  assert.equal(record(root).contract.edited_by_hand, true);
  assert.equal(F.cli(root, ['clarify', 'status', '--json', '--h1']).edited_by_hand, true, 'H1 says the contract was edited by hand');
  void J;
});

test('God Eye objections are never approval: a blocker sends clarify back round after round; when the loop stops making progress H1 shows the objection open (no park, no proceed needed)', () => {
  const { root, J } = job({ risk: 'low' });
  const blocker = [{ check: 'acs_testable', severity: 'blocker', stage: 'assemble', ref: 'AC-1', issue: 'AC-1 names no input range', fix: 'say which numbers' }];
  const last = F.clarify(root, { objections: blocker, checklist: { acs_testable: false } });
  assert.equal(last.status, 'ok', JSON.stringify(last).slice(0, 400));
  assert.equal(last.loop_end.rule, 'no_progress');
  const h = F.cli(root, ['next']);
  assert.equal(h.step, 'H1', JSON.stringify(h).slice(0, 300));
  const view = h.clarify_h1;
  assert.equal(view.approved, false, 'H1 never reads as approved by God Eye');
  assert.equal(view.god_eye_objects.length, 1);
  assert.match(view.god_eye_objects[0], /AC-1 names no input range/);
  assert.match(view.screen, /God Eye objects/);
  assert.doesNotMatch(view.screen, /checks pass/, 'an open objection is never shown next to "all checks pass"');
  // proceed stays a human-only verb (for parks from before 0.9.0)
  assert.ok(require('../hooks/guard-rules').HUMAN_ONLY.has('proceed'), 'proceed is a human-only verb');
  const step = fs.readFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.kind === 'step' && e.step === 'clarify').pop();
  assert.equal(step.detail.approved, false);
  assert.equal(step.detail.god_eye_objects, 1);
  assert.equal(step.detail.loop_end.rule, 'no_progress');
});

test('a degraded run parks: an agent that returns nothing twice is named, and resume tries again', () => {
  const { root, J } = job({ risk: 'low' });
  F.cli(root, ['next']);
  const brief = F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
  // the read-back's interviewer returned nothing (both attempts)
  let r = F.record(root, F.envelope(brief, 'degraded', { stage: brief.stage, rev: brief.rev, outputs: { 'read-back': null }, failed: ['read-back'] }));
  assert.notEqual(r.status, 'ok');
  let n = F.cli(root, ['next']);
  if (n.action !== 'parked') {
    const b2 = F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
    r = F.record(root, F.envelope(b2, 'degraded', { stage: b2.stage, rev: b2.rev, outputs: { 'read-back': null }, failed: ['read-back'] }));
    n = F.cli(root, ['next']);
  }
  assert.equal(n.action, 'parked', JSON.stringify(n).slice(0, 300));
  assert.match(n.reason, /interviewer|read-back/i, 'the park names what failed');
  assert.ok(!/proceed/.test(n.reason), 'nothing to proceed with when an agent failed');
  F.reply(root, `resume ${J}`);
  const again = F.cli(root, ['next']);
  assert.equal(again.skill, 'clarify');
  assert.equal(again.clarify.stage, 'readback', 'resume runs the stage again');
});

// ---------------------------------------------------------------- migration
// claude-factory's clarify v2 ledger (0.14–0.15.1): jobs/<J>/clarify-ledger.json, sealed.
function writeV2(root, J, issues, extra = {}) {
  const { seal } = require('../cli/lib/seal');
  fs.writeFileSync(path.join(F.jobDir(root, J), 'clarify-ledger.json'), JSON.stringify(seal({ version: 2, job: J, updated_at: '2026-10-01T10:00:00.000Z', issues, rounds: [{ round: 1, at: '2026-10-01T10:00:00.000Z' }], notes: [], sections: null, ...extra })));
  const jobs = require('../cli/core/job');
  const st = jobs.load(root, J);
  st.counters.clarify_rounds = 2;
  jobs.save(root, st);
}
const h = (event, actor, text) => ({ round: 1, event, actor, ...(text ? { text } : {}), at: '2026-10-01T10:00:00.000Z' });
function legacyV2() {
  return [
    { id: 'U-1', subject: 'nautobot.version', text: 'Which Nautobot version?', kind: 'scope', impact: 'high', owner: 'user', status: 'settled', settled_by: 'user', question_id: 'Q-1', answer: 'Nautobot 2.4', answered: { via: 'cli' }, history: [h('asked', 'cli', 'Q-1')] },
    { id: 'U-2', subject: 'device.reach', text: 'How are devices reached?', kind: 'decision', impact: 'high', owner: 'user', status: 'settled', settled_by: 'assumption_accepted', question_id: 'Q-2', default: 'netmiko over SSH', answer: 'netmiko over SSH', answered: { via: 'chat', default_accepted: true }, history: [] },
    { id: 'U-3', subject: 'docs.comment', text: 'Is a code comment enough documentation?', kind: 'scope', impact: 'low', owner: 'user', status: 'settled', settled_by: 'assumption_accepted', default: 'A code comment is enough', answer: 'A code comment is enough', note: 'low impact: assumed, not asked', history: [] },
    { id: 'U-5', subject: 'retry.backoff', text: 'Exact retry backoff', kind: 'decision', impact: 'low', owner: 'design', status: 'deferred_to_design', settled_by: 'design_deferral', history: [] },
    { id: 'U-6', subject: 'vlan.lowercase', text: 'Should VLAN names be lowercased?', kind: 'scope', impact: 'low', owner: 'user', status: 'dropped', note: 'dismissed by the judge: not asked for', history: [h('dismissed', 'judge', 'not asked for')] },
    { id: 'U-7', subject: 'vlan.scope', text: 'How does Nautobot scope VLANs?', kind: 'decision', impact: 'high', owner: 'user', status: 'proposed', question_id: 'Q-3', options: ['Global', 'Per Location', 'Per VLAN Group'], default: 'Per VLAN Group', aliases: [{ id: 'U-8', text: 'Can a VLAN belong to several locations?' }], history: [] },
  ];
}

test('migration: a v2 job in clarify keeps every issue, with who settled it; folded aliases become their own items; every denial since the last approval is read back as one redirect', () => {
  const { root, J, JD } = job({ request: 'sync VLANs to Nautobot 2.4' });
  writeV2(root, J, legacyV2());
  const legacyFile = path.join(JD, 'clarify-ledger.json');
  const before = crypto.createHash('sha256').update(fs.readFileSync(legacyFile)).digest('hex');
  const jobs = require('../cli/core/job');
  const st = jobs.load(root, J);
  st.denials = [{ gate: 'H1', at: '2026-10-02T09:00:00.000Z', reason: 'base the tests on Nautobot 2.4, not 3.x' }];
  jobs.save(root, st);
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify');
  assert.equal(n.clarify.stage, 'readback', 'a migrated job starts again at the read-back, pre-filled');
  assert.ok(n.clarify.migrated, 'factory next says it was migrated');
  F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
  const d = record(root);
  assert.equal(d.version, 3);
  assert.equal(d.migration.from, 2);
  const by = (v2) => d.items.find((it) => it.v2_id === v2);
  assert.deepEqual([by('U-1').strength, by('U-1').status], ['user', 'decided'], 'answered by the user → the user\'s words');
  assert.ok(d.words.some((w) => w.text === 'Nautobot 2.4' && w.via === 'migration'));
  assert.deepEqual([by('U-2').strength, by('U-2').value], ['accepted', 'netmiko over SSH'], 'an accepted default → accepted');
  assert.deepEqual([by('U-3').strength, by('U-3').status], ['assumption', 'assumed'], 'assumed without asking → an assumption the sheet shows');
  assert.deepEqual([by('U-5').status, by('U-5').owner], ['deferred', 'design']);
  assert.equal(by('U-6').status, 'dropped');
  assert.match(JSON.stringify(by('U-6').history), /judge \(clarify v2\).*not asked for/, 'who dropped it and why');
  assert.deepEqual([by('U-7').status, by('U-7').kind, by('U-7').needs_research], ['open', 'decision', true], 'an open decision is researched, then put on the sheet');
  assert.deepEqual(by('U-7').options.map((o) => o.text), ['Global', 'Per Location', 'Per VLAN Group']);
  assert.equal(by('U-7').recommendation, 'c', 'a default that names an option is the recommendation');
  assert.equal(by('U-8').folded_into, by('U-7').id, 'the folded alias is its own item, linked to the one it was folded into');
  assert.equal(d.redirects.length, 1);
  assert.equal(d.redirects[0].text, 'base the tests on Nautobot 2.4, not 3.x');
  assert.equal(d.redirects[0].status, 'queued', 'read back after the read-back');
  assert.match(d.migration.summary, /1 answered by you.*1 accepted defaults.*1 assumed without asking.*1 deferred to design.*1 dropped/);
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(legacyFile)).digest('hex'), before, 'the v2 record is left as it was');
});

test('migration: v1 (question_log and answers.json) maps the same way, by id or exact question text only', () => {
  const { root, J, JD } = job();
  const jobs = require('../cli/core/job');
  const st = jobs.load(root, J);
  st.counters.clarify_rounds = 2;
  st.question_log = [
    { id: 'Q-1', round: 1, category: 'scope', question: 'Which version?', default: '2.4' },
    { id: 'Q-2', round: 1, category: 'scope', question: 'Keep floats?', default: 'Your call', options: ['yes', 'no'] },
    { id: 'Q-3', round: 2, category: 'constraint', question: 'Which exact CLI syntax does NX-OS use?', default: 'None' },
    { id: 'Q-4', round: 2, category: 'intent', question: 'Who reads the totals?', default: 'None' },
  ];
  jobs.save(root, st);
  fs.writeFileSync(path.join(JD, 'answers.json'), JSON.stringify([
    { id: 'Q-1', question: 'Which version?', answer: '2.4.3', via: 'chat', at: '2026-10-01T10:00:00.000Z' },
    { question: 'Who reads the totals?', answer: 'finance', via: 'cli', at: '2026-10-01T10:05:00.000Z' },
    { question: 'what about rounding', answer: 'round half up', via: 'cli', at: '2026-10-01T10:06:00.000Z' },
  ]));
  F.cli(root, ['next']);
  F.cli(root, ['wfargs', 'clarify'], { allowFail: false });
  const d = record(root);
  assert.equal(d.migration.from, 1);
  const s = Object.fromEntries(d.items.filter((it) => it.v2_id).map((it) => [it.v2_id, `${it.status}/${it.strength || '-'}`]));
  assert.deepEqual(s, { 'Q-1': 'decided/user', 'Q-2': 'open/-', 'Q-3': 'deferred/-', 'Q-4': 'decided/user' });
  assert.equal(d.items.find((it) => it.v2_id === 'Q-2').recommendation, null, '"Your call" is no recommendation');
  // an answer no id or exact question claims is never matched by overlap: it is kept as the user's words
  assert.ok(d.words.some((w) => w.text === 'round half up' && w.via === 'migration'));
  assert.ok(!d.items.some((it) => it.value === 'round half up'));
});

test('migration: a v2 ledger edited by hand (its seal fails) is rebuilt from the question log, and says so', () => {
  const { root, J, JD } = job();
  writeV2(root, J, legacyV2());
  const f = path.join(JD, 'clarify-ledger.json');
  const led = JSON.parse(fs.readFileSync(f, 'utf8'));
  led.issues[0].answer = 'forged';
  fs.writeFileSync(f, JSON.stringify(led));
  const jobs = require('../cli/core/job');
  const st = jobs.load(root, J);
  st.question_log = [{ id: 'Q-1', round: 1, category: 'scope', question: 'Which Nautobot version?', default: 'None' }];
  jobs.save(root, st);
  F.cli(root, ['next']);
  const d = record(root);
  assert.equal(d.migration.from, 1);
  assert.equal(d.migration.tampered_ledger, true);
  assert.ok(!d.words.some((w) => w.text === 'forged'), 'nothing from the hand-edited file');
  assert.match(d.migration.summary, /failed its seal/);
});

test('0.15.1 guarantees on a migrated job: drops are shown at H1 and in status with who and why; research gaps are shown', () => {
  const { root, J } = job({ risk: 'low' });
  writeV2(root, J, legacyV2().filter((u) => ['U-2', 'U-6'].includes(u.id)));
  F.clarify(root);
  const n = F.cli(root, ['next']);
  assert.equal(n.step, 'H1', JSON.stringify(n).slice(0, 300));
  const hv = n.clarify_h1;
  assert.equal(hv.dropped.length, 1);
  assert.match(hv.dropped[0], /Should VLAN names be lowercased\? \(dropped by judge \(clarify v2\): not asked for\)/);
  assert.match(hv.screen, /\*\*Dropped\*\*/);
  assert.match(hv.screen, /\*\*God Eye:\*\* all 7 checks pass/, 'drops do not hide God Eye\'s verdict');
  const s = F.cli(root, ['clarify', 'status']);
  assert.match(s.raw || JSON.stringify(s), /Dropped:[\s\S]*lowercased/);
  assert.equal(hv.status_command, `factory clarify status --job ${J}`);
  // a research gap is never hidden: it is listed at H1 and in the contract's Research gaps
  const d = record(root);
  assert.ok(Array.isArray(hv.gaps));
  assert.equal(hv.gaps.length, d.failures.length);
});

test('telemetry: what clarify cost the user and what it could not do, per job', () => {
  const { root } = job({ risk: 'low' });
  F.clarify(root);
  const t = F.cli(root, ['telemetry', 'report']);
  const m = (t.per_job || []).find((x) => x.clarify);
  assert.ok(m, JSON.stringify(t).slice(0, 300));
  assert.equal(m.clarify.version, 3);
  assert.equal(m.clarify.user_turns, 0, 'nothing needed the user: the read-back was shown, not waited on');
  assert.equal(m.clarify.readiness_checks, 1);
  assert.equal(m.clarify.proceeded, false);
});
