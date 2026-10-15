'use strict';
// `factory record`: the single entry point that turns a workflow's result envelope into
// state. It validates the envelope, rejects stale results, re-checks anything it can
// check itself, and writes ledger entries. Agents' claims are never taken at face value
// where the CLI can verify them.

const path = require('path');
const { readJson, writeJson, writeText, readText, exists, nowIso, fail } = require('../lib/util');
const { pluginPath, jobPaths } = require('../lib/paths');
const { validate } = require('../lib/schema');
const { seal } = require('../lib/seal');
const job = require('./job');
const steps = require('./steps');
const ledger = require('./ledger');
const budgets = require('./budgets');
const contractMod = require('./contract');
const invalidation = require('./invalidation');
const planMod = require('./plan');
const review = require('./review');
const wfargs = require('./wfargs');
const lifecycle = require('./lifecycle');
const decisionTable = require('./decision-table');
const questions = require('./questions');
const docMod = require('./doc');

// Decide runs in a row whose design record fails the doc templates before the job parks.
const DOC_RETRY_CAP = 3;

// findings.md follows templates/docs/findings.md (findings@1).
function findingsMarkdown(state, topics, answers = []) {
  const { frontBlock, cell, loadTemplate } = docMod;
  const answered = new Set(answers.map((a) => a.question));
  const unknowns = topics.flatMap((t) => t.unknowns.map((u) => ({ ...u, topic: t.topic })));
  const blocked = unknowns.some((u) => u.blocking && !answered.has(u.question));
  const L = [
    frontBlock({ doc: 'findings', template: loadTemplate('findings').version, job: state.id, title: state.title, status: blocked ? 'blocked' : 'grounded', date: nowIso().slice(0, 10), contract: 'contract.md', related: [] }),
    '',
    `# Findings — ${state.id}: ${state.title}`,
    '',
    '## Summary',
    '',
    'Every claim is cited (file:line, command, or URL) or marked UNVERIFIED.',
    '',
    '| Topic | Claims | Unverified | Unknowns | Blocking |',
    '|---|---|---|---|---|',
    ...topics.map((t) => `| ${cell(t.topic)} | ${t.claims.length} | ${t.claims.filter((c) => c.source === 'UNVERIFIED').length} | ${t.unknowns.length} | ${t.unknowns.filter((u) => u.blocking).length} |`),
    ...(topics.length ? [] : ['| — | 0 | 0 | 0 | 0 |']),
    '',
    '## Topics',
    '',
  ];
  for (const t of topics) {
    L.push(`### ${t.topic}`, '');
    if (!t.claims.length) L.push('_No claims._');
    for (const c of t.claims) L.push(`- ${c.claim} — ${c.source === 'UNVERIFIED' ? '**UNVERIFIED**' : `\`${c.source}\``}`);
    L.push('');
  }
  if (!topics.length) L.push('_No topics._', '');
  L.push('## Unknowns', '');
  for (const u of unknowns) L.push(`- ${u.blocking ? '(blocking) ' : ''}[${u.topic}] ${u.question}${u.blocking ? ` — ${answered.has(u.question) ? 'answered' : 'unanswered'}` : ''}`);
  if (!unknowns.length) L.push('None.');
  L.push('', '## Answers from the human', '');
  for (const a of answers) L.push(`- Q: ${a.question} — A: ${a.answer}`);
  if (!answers.length) L.push('None.');
  L.push('');
  return L.join('\n');
}

function insideJobDir(root, state, p) {
  const dir = jobPaths(root, state.id).dir;
  const abs = path.resolve(root, p);
  return abs.startsWith(dir + path.sep) && exists(abs) ? abs : null;
}

// Clarify v2 (docs/DESIGN-CLARIFY-v2.md): the round's raised issues are folded into the
// ledger (settled is final, raised-again issues are deduplicated by subject), the contract
// editor's revision is checked and written, the CLI-owned sections are rewritten from the
// ledger, questions get their Q-ids, and the round is measured: progress (something settled,
// asked or applied) or not. Rounds in a row without progress park the job.
function recClarify(root, state, env) {
  const clarifyMod = require('./clarify');
  const d = env.data || {};
  const cfg = readJson(pluginPath('config', 'workflows', 'clarify.json'));
  const jp = jobPaths(root, state.id);
  const round = state.counters.clarify_rounds + 1;
  // the first v2 round: the rounds before it (a pre-v2 job's) are not counted against the ceiling
  if (state.counters.clarify_v2_from === undefined) state.counters.clarify_v2_from = clarifyMod.limits(state).before_v2;
  const CL = clarifyMod.limits(state);
  const max = questions.budget(cfg, CL.counted + 1, { ...state.policy.limits, max_intent_rounds: CL.ceiling });
  const log = state.question_log || [];
  const answers = readJson(jp.answers, []) || [];
  const raw = clarifyMod.load(root, state.id);
  const data = clarifyMod.ensure(root, state, raw) || clarifyMod.empty(state);
  const migrated = Boolean(data.migration && !data.migration.persisted_at);
  const lastLedger = (data.rounds || []).length ? data.rounds[data.rounds.length - 1].ledger || null : null;
  const priorIds = new Set(data.issues.map((u) => u.id));
  const prevTotals = lastLedger && lastLedger.totals ? lastLedger.totals : clarifyMod.totals(data);
  // Fold this round's issues into the ledger and re-derive every status that is not final.
  // (Defaults due this round are taken first: the brief gave them to the contract editor.)
  clarifyMod.acceptDefaults(data, state, round);
  const unappliedBefore = data.issues.filter((u) => u.status === 'settled' && ['user', 'assumption_accepted'].includes(u.settled_by) && u.answer && !u.applied_round).map((u) => u.id);
  const wl = d.ledger || null;
  if (wl) clarifyMod.mergeIssues(data, wl.issues, round);
  clarifyMod.advance(data, round);
  foldRaised(clarifyMod, data, priorIds, round);
  // The question protocol: every question names its issue (deduplicated by subject), a settled
  // issue is never asked again, then intent first and alone, priority order, budget, never re-ask.
  const crit = d.critique || null;
  const unconfirmed = Boolean(crit && crit.intent_confirmed === false);
  // CLI fallback: God Eye's blockers the workflow did not turn into questions (an older
  // workflow) are asked here, so a round never ends with nothing to answer.
  const geAsks = crit && !d.approved_with_notes && !((d.judge && d.judge.questions) || []).length && !(crit.verdict === 'approve' && !unconfirmed) ? godEyeAsks(crit) : [];
  const judgeQs = [...((d.judge && d.judge.questions) || []), ...geAsks];
  const dismissed = (d.judge && d.judge.dismissed) || [];
  const asks = ledgerAsks(clarifyMod, data, judgeQs, dismissed);
  const g = questions.ground([...judgeQs, ...asks], data, round);
  if (g.created.length) data.issues.push(...g.created);
  const n = questions.shape(g.questions, { budget: max, asked: questions.askedList(state, answers), startId: log.length });
  state.counters.clarify_rounds = round;
  const intentRounds = (state.counters.intent_rounds || 0) + (n.intent_open ? 1 : 0);
  for (const q of n.questions) {
    const u = data.issues.find((x) => x.id === q.unknown);
    if (u && !clarifyMod.FINAL.has(u.status)) {
      Object.assign(u, { status: 'proposed', owner: 'user', question_id: q.id, default: clarifyMod.isNone(q.default) ? u.default : q.default });
      clarifyMod.event(u, round, 'asked', 'cli', q.id);
    }
  }
  for (const x of dismissed) {
    const u = x.unknown || x.same_as ? clarifyMod.findSame(data.issues, { same_as: x.unknown || x.same_as, text: '' }) : null;
    if (!u || clarifyMod.FINAL.has(u.status) || u.question_id) continue;
    if (/\bdesign\b/i.test(String(x.reason || ''))) Object.assign(u, { owner: 'design', status: 'deferred_to_design', settled_by: 'design_deferral', note: `the judge: ${String(x.reason || '').slice(0, 200)}` });
    else Object.assign(u, { status: 'dropped', dismissed: true, note: `dismissed by the judge: ${String(x.reason || '').slice(0, 200)}` });
    clarifyMod.event(u, round, u.status, 'judge', x.reason);
  }
  for (const nt of d.notes || []) (data.notes = data.notes || []).push({ round, actor: 'god-eye', ref: nt.ref || null, severity: nt.severity || null, text: String(nt.text || '').slice(0, 300) });
  // One writer: the contract editor's revision, checked, then the CLI-owned sections.
  const revision = applyRevision(root, state, d.contract, data, unappliedBefore, round);
  clarifyMod.writeContract(root, state, data);
  data.sections = contractMod.sectionHashes(contractMod.read(root, state.id));
  const b = invalidation.current(root, state);
  const probs = contractMod.problems(contractMod.parse(contractMod.read(root, state.id)));
  // The round, measured.
  const degradedRound = env.status === 'degraded';
  const measure = measureRound(clarifyMod, data, { round, priorIds, prevTotals, asked: n.questions.length, degraded: degradedRound, revised: Boolean(revision && revision.effective) });
  data.rounds = [...(data.rounds || []).filter((r) => r.round !== round), { round, at: nowIso(), degraded: (d.degraded || []).slice(0, 20), ...(d.quiet ? { quiet: true } : {}), ledger: measure }].slice(-40);
  if (migrated) data.migration = { ...data.migration, persisted_at: nowIso() };
  clarifyMod.save(root, state.id, data);
  const C = state.counters;
  if (degradedRound) {
    C.clarify_degraded_streak = (C.clarify_degraded_streak || 0) + 1;
    C.clarify_degraded_rounds = (C.clarify_degraded_rounds || 0) + 1;
  } else {
    C.clarify_degraded_streak = 0;
    C.clarify_no_progress = measure.progress ? 0 : (C.clarify_no_progress || 0) + 1;
  }
  const ledgerView = clarifyMod.view(state, data);
  // ceiling and counted: what the CLI held this round to (the inspector checks rounds against it)
  const ledgerDetail = { opened: measure.opened, settled: measure.settled, deferred: measure.deferred, dropped: measure.dropped, asked: measure.asked, progress: measure.progress, revised: measure.revised, degraded: measure.degraded, open_by_owner: measure.totals.by_owner, no_progress_streak: C.clarify_no_progress || 0, ceiling: CL.ceiling, counted: clarifyMod.limits(state).counted, reraised: ((wl && wl.raised && wl.raised.notes) || []).length + measure.reraised };
  const clarifyOut = { open_by_owner: ledgerView.open_by_owner, issues: ledgerView.issues.filter((r) => !['settled', 'dropped'].includes(r.status)).slice(0, 20), deferred_to_design: ledgerView.deferred_to_design, round: measure, status_command: `factory clarify status --job ${state.id}`, ...(revision ? { contract_revision: revision } : {}), ...(migrated ? { migration: data.migration } : {}) };
  // Intent never falls back to an assumption: still unclear after its rounds (or with no budget left) -> park.
  if (n.intent_open && (intentRounds > cfg.limits.intent_rounds || max === 0)) {
    job.save(root, state);
    const open = [...n.questions, ...n.dropped].map((q) => q.question);
    ledger.append(root, state.id, { kind: 'step', step: 'clarify', ok: false, bound: { contract: b.contract }, detail: { round, intent_open: true, intent_rounds: intentRounds - 1, questions: 0, contract_problems: probs, ledger: ledgerDetail } });
    return { status: 'park', park_from: 'clarify', park_reason: `The intent is still unclear after ${intentRounds - 1} round(s) of intent questions; the factory won't guess the why.${open.length ? ` Open: ${open.join(' | ')}` : ''}`, questions: n.questions, clarify: clarifyOut };
  }
  state.counters.intent_rounds = intentRounds;
  state.question_log = [...log, ...n.questions.map((q) => ({ id: q.id, round, category: q.category, question: q.question, default: q.default, ...(q.unknown ? { unknown: q.unknown } : {}) }))];
  state.asked_questions = [...new Set([...(state.asked_questions || []), ...n.questions.map((q) => q.question)])];
  // Waiting: questions asked in earlier rounds that are still the user's (no default to fall back on).
  const waiting = data.issues.filter((u) => u.status === 'proposed' && u.question_id && u.impact !== 'low' && !n.questions.some((q) => q.unknown === u.id));
  // What a numbered chat reply ("1 yes, 2 …") refers to: the questions this round shows, in
  // order (new ones; else the ones still waiting from earlier rounds).
  state.clarify_shown = n.questions.length ? n.questions.map((q) => q.id) : waiting.map((u) => u.question_id);
  job.save(root, state);
  if (crit) {
    writeJson(path.join(jp.critiquesDir, 'intent.json'), seal({ hash: b.contract, verdict: crit.verdict, intent_confirmed: crit.intent_confirmed !== false, restatement: crit.restatement || null, checklist: crit.checklist || null, items: crit.items, approved_with_notes: Boolean(d.approved_with_notes), notes: (d.notes || []).slice(0, 30), at: nowIso() }));
  }
  const blocking = data.issues.filter((u) => !clarifyMod.FINAL.has(u.status) && u.impact !== 'low');
  const intentConfirmed = Boolean(crit && crit.intent_confirmed !== false); // older critiques carry no flag
  const approved = Boolean(crit && ((crit.verdict === 'approve' && intentConfirmed) || d.approved_with_notes));
  // God Eye judged the editor's revision; a revision the CLI refused is not the contract, so that
  // approval does not carry to H1.
  const refused = Boolean(revision && revision.rejected);
  const ok = Boolean(approved && !refused && !probs.length && !n.questions.length && !blocking.length && !degradedRound);
  const askedNow = n.questions.length || waiting.length;
  ledger.append(root, state.id, { kind: 'step', step: 'clarify', ok, bound: { contract: b.contract }, detail: { ...(askedNow && !ok ? { outcome: 'needs_user' } : {}), round, questions: n.questions.length, question_ids: n.questions.map((q) => q.id), ...(waiting.length ? { waiting_ids: waiting.map((u) => u.question_id) } : {}), categories: n.questions.map((q) => q.category), intent_open: n.intent_open, held: n.held.length, dropped: n.dropped.length, degraded: d.degraded || [], contract_problems: probs, ledger: ledgerDetail, ...(d.approved_with_notes ? { approved_with_notes: true } : {}), ...(revision ? { contract_revision: { written: revision.written, applied: revision.applied.length, ...(revision.rejected ? { rejected: revision.rejected } : {}) } } : {}) } });
  const extra = { clarify: clarifyOut };
  const notesText = (d.notes || []).length ? ` God Eye's notes (${d.notes.length}) are recorded.` : '';
  if (ok) return { status: 'ok', next_gate: state.epic ? 'EH1' : 'H1', restatement: (crit && crit.restatement) || null, ...extra, ...(d.approved_with_notes ? { notes: d.notes || [] } : {}), message: `God Eye ${d.approved_with_notes ? 'approved with notes' : 'approved the contract and confirmed the intent'}.${notesText} Next: present it for your approval.` };
  const answerHow = 'The user answers in chat with a numbered reply ("1 yes, 2 …", or "defaults"), which the reply hook records; or record each answer they give in their own words with factory answer Q-n "…" (factory answer Q-n --default accepts the default). An unanswered question with a default takes it next round. Do not edit the contract (the guard refuses it during clarify): run factory next.';
  if (n.questions.length) {
    return {
      status: 'needs_user',
      questions: n.questions,
      intent_first: n.intent_open,
      held: n.held.length,
      ...(waiting.length ? { waiting: waiting.map((u) => ({ id: u.question_id, issue: u.id, question: u.draft })) } : {}),
      ...extra,
      message: `${unconfirmed ? 'God Eye could not confirm the intent from the contract (its restatement is in the question). ' : ''}Ask these ${n.questions.length} question(s) as one numbered list (id, question, options, default).${n.intent_open ? ` Intent comes first: ${n.held.length} other question(s) wait until it is settled.` : ''} ${answerHow}`,
    };
  }
  if (degradedRound && (C.clarify_degraded_streak || 0) <= 1) {
    job.save(root, state);
    return { status: 'retry', missing: d.degraded || [], ...extra, message: `Analyst(s) failed after their retry (${(d.degraded || []).join(', ')}): this round does not count. factory next runs clarify again once, automatically; don't ask the user yet.` };
  }
  if (degradedRound) return { status: 'degraded', missing: d.degraded, ...extra, message: `Analyst(s) failed in two rounds in a row: ${(d.degraded || []).join(', ')}. Ask the user: re-run, or go on without that angle (factory wfargs fanout-judge --config clarify --accept-degraded).` };
  if (waiting.length) {
    return { status: 'needs_user', questions: waiting.map((u) => { const q = log.find((x) => x.id === u.question_id) || {}; return { id: u.question_id, category: q.category || 'scope', question: q.question || u.draft, why: u.reason || 'Still open: only you can settle it.', default: u.default || q.default || 'None: answer needed', unknown: u.id, kind: u.kind, waiting: true }; }), ...extra, message: `Still waiting for the answer to ${waiting.map((u) => u.question_id).join(', ')} (no default to fall back on). Show them again as one numbered list. ${answerHow}` };
  }
  const stalled = (C.clarify_no_progress || 0) >= CL.no_progress;
  if (stalled) {
    const open = ledgerView.issues.filter((r) => !['settled', 'dropped', 'deferred_to_design'].includes(r.status));
    return { status: 'park', park_from: 'clarify', ...extra, park_reason: `Clarify is not converging: ${C.clarify_no_progress} round(s) in a row settled nothing and asked nothing new.${open.length ? ` Open: ${open.slice(0, 6).map((r) => `${r.id} ${r.subject} (${r.owner})`).join('; ')}.` : ''}${probs.length ? ` Contract problems: ${probs.slice(0, 3).join('; ')}.` : ''}${refused ? ` The contract editor's last revision was refused: ${revision.rejected}.` : ''} See factory clarify status.` };
  }
  if (refused) return { status: 'revise', ...extra, message: `The CLI refused the contract editor's revision (${revision.rejected}), so the contract is unchanged and God Eye's verdict on the revision does not count. Clarify runs again: run factory next; don't edit the contract.` };
  if (probs.length) return { status: 'revise', problems: probs, ...extra, message: 'The contract still has problems: clarify runs again and its contract editor fixes them (the user is not asked). Run factory next; don\'t edit the contract.' };
  return { status: 'revise', critique: crit, ...extra, message: 'Clarify is not done yet (God Eye\'s items with nothing to ask the user): run factory next; clarify runs again and its contract editor revises the contract.' };
}

// God Eye's blockers as questions: an unconfirmed intent (its restatement, no default: the
// factory never guesses the intent) and each blocker that points at an AC or a section.
function godEyeAsks(c) {
  const out = [];
  if (c.intent_confirmed === false) {
    const r = c.restatement || {};
    out.push({ question: `God Eye reads the intent as: ${[r.problem, r.outcome].filter(Boolean).join(' → ')}. Is that the intent?`, category: 'intent', why: 'God Eye could not confirm the intent from the contract.', default: 'None: the factory will not guess the intent', kind: 'intent', subject: 'intent.restatement' });
  }
  for (const it of c.items || []) {
    if (!it || it.severity !== 'blocker' || !it.ref || /^U-\d+$/i.test(it.ref)) continue;
    out.push({ question: `${it.issue}: ${it.suggestion || 'how should the contract say it'}?`, category: /^(E-)?AC-\d+/i.test(it.ref) ? 'acceptance' : /intent|goal/i.test(it.ref) ? 'intent' : 'scope', why: `God Eye (${it.ref})`, default: it.suggestion || 'None: answer needed', subject: it.subject, same_as: it.same_as });
  }
  return out;
}

// A raise the workflow created this round that is the same issue as an older one (subject
// dedup, CLI side): folded into the older issue as an alias.
function foldRaised(clarifyMod, data, priorIds, round) {
  const fresh = data.issues.filter((u) => !priorIds.has(u.id));
  for (const u of fresh) {
    const older = data.issues.filter((x) => x !== u && priorIds.has(x.id));
    const hit = older.find((x) => clarifyMod.sameIssue(u, x));
    if (!hit) continue;
    hit.aliases = [...(hit.aliases || []), { id: u.id, text: String(u.text).slice(0, 300) }];
    if (clarifyMod.FINAL.has(hit.status)) {
      hit.notes = [...(hit.notes || []), { round, actor: u.source || 'agent', text: `raised again as ${u.id} (not reopened): ${String(u.text).slice(0, 200)}` }];
      hit.reraised = (hit.reraised || 0) + 1;
    }
    clarifyMod.event(hit, round, 'folded', 'cli', `${u.id}: ${u.text}`);
    data.issues = data.issues.filter((x) => x !== u);
  }
}

// The ledger's own open proposals (CLI fallback for the workflow's): user issues raised
// earlier and not asked yet (over budget, held while the intent was open, God Eye's blockers).
function ledgerAsks(clarifyMod, data, judgeQs, dismissed) {
  const covered = new Set([...(judgeQs || []).map((q) => String(q.unknown || q.same_as || '').toUpperCase()), ...(dismissed || []).map((x) => String(x.unknown || x.same_as || '').toUpperCase())]);
  const cat = (k) => (['intent', 'scope', 'constraint', 'acceptance'].includes(k) ? k : 'scope');
  return data.issues
    .filter((u) => u.status === 'proposed' && u.owner === 'user' && !u.question_id && u.impact !== 'low' && !covered.has(u.id))
    .map((u) => ({ question: u.draft || u.text, category: cat(u.kind), why: u.why || (u.reason ? `Open: ${u.reason}.` : 'Only you can settle it.'), default: u.default || 'None: answer needed', unknown: u.id, kind: u.kind, ...(u.options ? { options: u.options } : {}) }));
}

// What a revision loses: acceptance criteria by id; constraints and non-goals by count (a
// rewording keeps the count). Each loss needs a `removed` entry from the editor whose `because`
// holds up: a settled or dropped issue (U-n), or a God Eye item, user note or gate denial that
// the editor was given for that criterion or section. Returns what is unjustified.
function lostItems(before, after, edits, data) {
  const removed = edits.flatMap((e) => e.removed || []);
  const requested = edits.flatMap((e) => e.requested || []);
  const key = (x) => String(x || '').trim().toLowerCase();
  const asked = (from, ref, section) => requested.some((r) => key(r.from) === from && (from !== 'god-eye' || [key(ref), key(section)].includes(key(r.ref))));
  const holds = (x, ref, section) => {
    if (![key(ref), key(section)].includes(key(x.ref))) return false;
    const b = String(x.because || '').trim();
    if (/^U-\d+$/i.test(b)) {
      const u = data.issues.find((y) => y.id === b.toUpperCase() || (y.aliases || []).some((a) => a.id === b.toUpperCase()));
      return Boolean(u && ['settled', 'dropped'].includes(u.status));
    }
    if (/god.?eye/i.test(b)) return asked('god-eye', ref, section);
    if (/note/i.test(b)) return asked('user note');
    if (/denial|gate/i.test(b)) return asked('gate denial');
    return false;
  };
  const out = [];
  const ids = new Set(after.acs.map((a) => a.id));
  for (const a of before.acs) if (!ids.has(a.id) && !removed.some((x) => holds(x, a.id, 'acceptance criteria'))) out.push(a.id);
  for (const [name, k] of [['Constraints', 'constraints'], ['Non-goals', 'nonGoals']]) {
    const gone = before[k].length - after[k].length;
    if (gone <= 0) continue;
    const okN = removed.filter((x) => holds(x, name, name)).length;
    if (okN < gone) out.push(`${gone - okN} of ${name}`);
  }
  return out;
}

// The contract editor's revision: CLI-owned sections kept, written only if it still parses,
// keeps the Intent section, loses no criterion, constraint or non-goal without a reason and
// adds no contract problem. Settled issues it applied are marked.
function applyRevision(root, state, c, data, unappliedBefore, round) {
  if (!c) return null;
  const approved = state.approvals && (state.approvals.H1 || state.approvals.EH1);
  const edits = Array.isArray(c.edits) ? c.edits : [];
  const appliedRefs = new Set(edits.flatMap((e) => (e.applied || []).map((a) => String(a.ref || '').toUpperCase())));
  const removed = edits.flatMap((e) => (e.removed || []).map((x) => ({ ref: String(x.ref || ''), because: String(x.because || '') })));
  const out = { written: false, applied: [...appliedRefs], ...(removed.length ? { removed } : {}), skipped: edits.flatMap((e) => (e.skipped || []).map((x) => ({ ref: x.ref, reason: String(x.reason || '').slice(0, 200) }))), editors: edits.map((e) => ({ label: e.label, ok: Boolean(e.ok) })) };
  if (typeof c.text === 'string' && c.text.trim()) {
    const cur = contractMod.read(root, state.id);
    const next = contractMod.keepCliSections(c.text, cur);
    const pb = contractMod.problems(contractMod.parse(cur)).length;
    const pn = contractMod.parse(next);
    const pa = contractMod.problems(pn).length;
    const known = new Set([...Object.keys(contractMod.sections(cur)), 'intent', 'goal', 'non-goals', 'acceptance criteria', 'constraints', 'allowed paths', 'verify commands', 'assumptions', ...contractMod.CLI_OWNED]);
    const foreign = Object.keys(contractMod.sections(next)).filter((k) => !known.has(k));
    const lost = lostItems(contractMod.parse(cur), pn, edits, data);
    if (approved) out.rejected = 'the contract is approved: changes go through an amendment';
    else if (!pn.intent.present) out.rejected = 'the revision has no Intent section';
    else if (lost.length) out.rejected = `the revision drops ${lost.join('; ')} without a recorded reason (a settled issue, or the God Eye item, note or gate denial that asked for it)`;
    else if (foreign.length) out.rejected = `the revision adds sections a contract does not have (${foreign.slice(0, 3).join(', ')})`;
    else if (/^## (Your final message|Your output|Your tools|This run)\b|^# Factory [a-z-]+ — this run/m.test(next)) out.rejected = 'the revision carries the agent\'s own instructions';
    else if (pa > pb) out.rejected = `the revision adds contract problems (${pa} > ${pb})`;
    else {
      writeText(jobPaths(root, state.id).contract, next.endsWith('\n') ? next : `${next}\n`);
      out.written = true;
      out.changed = next.replace(/\s+$/, '') !== String(cur).replace(/\s+$/, '');
      out.problems_fixed = Math.max(0, pb - pa);
    }
  }
  if (edits.some((e) => e.ok)) {
    for (const id of unappliedBefore) {
      const u = data.issues.find((x) => x.id === id);
      if (!u) continue;
      if (out.written && appliedRefs.has(id)) {
        u.applied_round = round;
        require('./clarify').event(u, round, 'applied', 'contract-editor');
      } else u.edit_attempts = (u.edit_attempts || 0) + 1;
    }
    if (out.written) for (const nt of data.notes || []) if (nt.ref === 'contract') nt.applied = true;
  }
  // Progress, for the no-progress rule: a revision that changed the text AND applied something
  // it was given (a settled issue, a note, a denial) or fixed a contract problem. A rewrite that
  // applies nothing is not progress, or an editor rewording every round would keep clarify from
  // ever parking before its ceiling.
  const newlyApplied = unappliedBefore.filter((id) => appliedRefs.has(id)).length;
  const handled = edits.some((e) => e.ok && (e.requested || []).some((r) => ['user note', 'gate denial'].includes(r.from)));
  out.effective = Boolean(out.written && out.changed && (newlyApplied > 0 || out.problems_fixed > 0 || handled));
  return out;
}

// Per-round counts and the progress test: something settled, deferred or dropped since the
// last round, questions asked, or a contract revision that applied something.
function measureRound(clarifyMod, data, { round, priorIds, prevTotals, asked, degraded, revised = false }) {
  const t = clarifyMod.totals(data);
  const p = prevTotals || { closed: 0, settled: 0, deferred_to_design: 0, dropped: 0 };
  const opened = data.issues.filter((u) => !priorIds.has(u.id));
  const settled = Math.max(0, (t.settled || 0) - (p.settled || 0));
  const deferred = Math.max(0, (t.deferred_to_design || 0) - (p.deferred_to_design || 0));
  const dropped = Math.max(0, (t.dropped || 0) - (p.dropped || 0));
  const reraised = data.issues.reduce((k, u) => k + (u.reraised || 0), 0) - (p.reraised || 0);
  const progress = settled + deferred + dropped > 0 || asked > 0 || revised;
  return { round, opened: opened.length, settled, deferred, dropped, asked, revised, progress, degraded: Boolean(degraded), reraised: Math.max(0, reraised), totals: { ...t, reraised: data.issues.reduce((k, u) => k + (u.reraised || 0), 0) } };
}

function recGround(root, state, env) {
  const topics = (env.data && env.data.topics) || [];
  const jp = jobPaths(root, state.id);
  const answers = readJson(jp.answers, []);
  writeText(jp.findings, findingsMarkdown(state, topics, answers));
  const answered = new Set(answers.map((a) => a.question));
  const blocking = topics.flatMap((t) => t.unknowns.filter((u) => u.blocking && !answered.has(u.question)).map((u) => u.question));
  const b = invalidation.current(root, state);
  const ok = blocking.length === 0 && topics.length > 0;
  ledger.append(root, state.id, { kind: 'step', step: 'ground', ok, bound: { contract: b.contract }, detail: { ...(blocking.length ? { outcome: 'needs_user' } : {}), topics: topics.length, claims: topics.reduce((n, t) => n + t.claims.length, 0), unverified: topics.reduce((n, t) => n + t.claims.filter((c) => c.source === 'UNVERIFIED').length, 0), blocking, degraded: (env.data && env.data.degraded) || [] } });
  if (blocking.length) return { status: 'needs_user', questions: blocking.map((q) => ({ question: q, why: 'Blocks the design' })), message: `Ask the user, then record each answer with factory answer --job ${state.id} --question "…" --answer "…", and run ground again.` };
  return { status: 'ok', message: `Findings written to ${jp.findings}.` };
}

function recDecide(root, state, env) {
  const d = env.data || {};
  const a = d.judge || {};
  const jp = jobPaths(root, state.id);
  const paths = (a.paths || []).map((p) => insideJobDir(root, state, p)).filter(Boolean);
  if (!paths.length) fail(`The architect's design record was not found inside ${jp.dir}.`, 'missing_artifact');
  const ctx = steps.context(root, state, job.load);
  const recipeStep = ctx.recipe.steps.find((s) => s.step === 'decide') || {};
  const needThreat = env.threat_model === true || recipeStep.threat_model === true || (recipeStep.threat_model === 'policy' && state.risk === 'high');
  if (needThreat && !exists(jp.threatModel)) fail(`A threat model is required but ${jp.threatModel} does not exist.`, 'missing_artifact');
  const b = invalidation.current(root, state);
  const critiques = d.critiques || [];
  const last = critiques[critiques.length - 1] || null;
  state.counters.decide_rounds += 1;
  job.save(root, state);
  const max = state.policy.limits.max_design_critique_rounds;
  writeJson(path.join(jp.critiquesDir, 'design.json'), seal({ hash: b.design, verdict: last ? last.verdict : 'none', items: last ? last.items : [], rounds: critiques.length, at: nowIso() }));
  // The design record must follow templates/docs (front matter, sections in order, an AC
  // table, a Mermaid architecture diagram in an ADR, a data-flow diagram in a threat model).
  const docProblems = docMod.designProblems(root, state);
  if (docProblems.length) {
    const prior = ledger.steps(root, state.id, 'decide');
    const since = (state.resumed && state.resumed.at) || '';
    let streak = 1;
    for (let i = prior.length - 1; i >= 0 && !prior[i].ok && (prior[i].detail.doc_problems || []).length && prior[i].at > since; i--) streak += 1;
    ledger.append(root, state.id, { kind: 'step', step: 'decide', ok: false, bound: { contract: b.contract, design: b.design }, detail: { kind: a.kind, paths, critique: last ? last.verdict : null, rounds: critiques.length, threat_model: needThreat, doc_problems: docProblems.slice(0, 40) } });
    const list = docProblems.slice(0, 12).map((p) => `- ${p}`).join('\n');
    if (streak >= DOC_RETRY_CAP) return { status: 'park', park_reason: `The design record still breaks the doc templates after ${streak} decide runs:\n${list}`, doc_problems: docProblems, message: 'Parked.' };
    return { status: 'retry', doc_problems: docProblems, message: `The design record does not follow the doc templates (${docProblems.length} problem(s)):\n${list}\nfactory next runs decide again; the architect gets these problems. Check a file with: factory doc check <file>` };
  }
  const h2Step = ctx.recipe.steps.find((s) => ['H2', 'EH2', 'HF'].includes(s.step));
  const humanWillSee = Boolean(h2Step && !(h2Step.when === 'adr' && !invalidation.hasAdr(root, state.id)));
  const approved = last && last.verdict === 'approve';
  const ok = Boolean(approved || (critiques.length >= max && humanWillSee));
  ledger.append(root, state.id, { kind: 'step', step: 'decide', ok, bound: { contract: b.contract, design: b.design }, detail: { kind: a.kind, paths, critique: last ? last.verdict : null, rounds: critiques.length, threat_model: needThreat } });
  if (ok) return { status: 'ok', message: approved ? 'Design critique approved.' : `Design critique still says revise after ${critiques.length} rounds; you will see it at ${h2Step.step}.` };
  return { status: 'park', park_reason: `Design critique did not approve after ${critiques.length} round(s) and no human gate will review it.`, message: 'Parked.' };
}

function recDecompose(root, state, env) {
  const d = env.data || {};
  const v = planMod.validate(root, state);
  const b = invalidation.current(root, state);
  if (!v.valid) {
    state.counters.decompose_rounds += 1;
    job.save(root, state);
    ledger.append(root, state.id, { kind: 'step', step: 'decompose', ok: false, bound: { plan: b.plan, contract: b.contract }, detail: { errors: v.errors } });
    return { status: 'retry', errors: v.errors, message: 'The plan is still invalid; factory next runs decompose again (the planner gets the errors).' };
  }
  ledger.append(root, state.id, { kind: 'step', step: 'decompose', ok: true, bound: { plan: b.plan, contract: b.contract }, detail: { tasks: v.tasks || v.slices, waves: v.waves || v.layers } });
  if (d.critique) {
    const c = d.critique;
    writeJson(path.join(jobPaths(root, state.id).critiquesDir, 'plan.json'), seal({ hash: b.plan, verdict: c.verdict, items: c.items, at: nowIso() }));
    if (c.verdict === 'approve') ledger.append(root, state.id, { kind: 'step', step: 'plan_critique', ok: true, bound: { plan: b.plan }, detail: {} });
  }
  return { status: 'ok', message: `Plan valid: ${v.tasks || v.slices} ${state.epic ? 'slices' : 'tasks'}.` };
}

function recRealize(root, state, env) {
  const reported = (env.data && env.data.tasks) || [];
  const ctx = steps.context(root, state, job.load);
  const table = [];
  // A broken build environment parks the job once with its reason; tasks it stopped keep
  // their state (no attempt was spent on it).
  const eb = env.data && env.data.environment_broken;
  if (eb) {
    for (const r of reported.filter((x) => x.outcome !== 'pending')) {
      const done = steps.taskDone(ctx, r.id);
      state.tasks[r.id] = { ...(state.tasks[r.id] || {}), outcome: done ? 'done' : r.outcome, outcome_reason: r.summary || '', outcome_at: nowIso() };
    }
    job.save(root, state);
    const reason = String(eb.reason || 'environment broken').slice(0, 1500);
    require('./events').append(root, { event: 'environment_broken', job: state.id, task: eb.task || null, cmd: eb.cmd || null, code: eb.code === undefined ? null : eb.code, reason: reason.slice(0, 500) });
    return { status: 'park', park_from: 'environment', park_reason: `${reason} — no builder attempt was spent. Fix the environment (factory env check shows it; factory env set changes it), then reply "resume".`, tasks: reported.map((r) => ({ id: r.id, outcome: r.outcome, attempts: r.attempts, summary: r.summary })), environment_broken: eb, message: 'Parked: the build environment is broken.' };
  }
  // The tester relays task verify (a workflow cannot run it): what it relayed is compared with
  // the evidence task verify recorded, which alone decides.
  const relayMismatches = [];
  for (const v of (env.data && env.data.verifications) || []) {
    const t = state.tasks[v.task] || {};
    if (!v.pass || !t.evidence) continue;
    if (!t.evidence.pass || (v.evidence_id && v.evidence_id !== t.evidence.id)) relayMismatches.push({ task: v.task, relayed: true, evidence: Boolean(t.evidence.pass), evidence_id: t.evidence.id });
  }
  if (relayMismatches.length) require('./events').append(root, { event: 'relay_mismatch', job: state.id, tasks: relayMismatches.map((m) => m.task) });
  for (const r of reported) {
    const done = steps.taskDone(ctx, r.id);
    const outcome = done ? 'done' : r.outcome === 'done' ? 'not_verified' : r.outcome;
    state.tasks[r.id] = { ...(state.tasks[r.id] || {}), outcome, outcome_reason: r.summary || '', outcome_at: nowIso() };
    table.push({ id: r.id, outcome, attempts: r.attempts, summary: r.summary });
  }
  job.save(root, state);
  const bad = table.filter((t) => t.outcome !== 'done');
  if (bad.length) {
    return { status: 'park', park_reason: `Tasks not done: ${bad.map((t) => `${t.id} (${t.outcome})`).join(', ')}. Nothing partial ships.`, tasks: table, ...(relayMismatches.length ? { relay_mismatches: relayMismatches } : {}), message: 'Parked with a per-task table.' };
  }
  return { status: 'ok', tasks: table, ...(relayMismatches.length ? { relay_mismatches: relayMismatches } : {}), message: 'Every task in scope is built and verified.' };
}

function recReconcile(root, state, env) {
  const d = env.data || {};
  const ctx = steps.context(root, state, job.load);
  if (d.integrator && d.integrator.status === 'behavioural_conflict') {
    return { status: 'park', park_reason: `Behavioural conflict while integrating: ${d.integrator.summary}`, message: 'Parked.' };
  }
  if (!steps.isDone(ctx, { step: 'reconcile' })) {
    const last = ledger.lastStep(root, state.id, 'reconcile');
    if (last && !last.ok && last.detail && last.detail.regression) {
      return { status: 'park', park_reason: `Reconcile regression: ${last.detail.message || 'merged or fixed lines were dropped'}`, message: 'Parked: integrating would drop work already merged or fixed.' };
    }
    return { status: 'park', park_reason: `Integration did not complete: ${(d.integrator && d.integrator.summary) || 'no result'}`, message: 'Parked.' };
  }
  return { status: 'ok', message: `Integrated at fingerprint ${ctx.b.fingerprint.slice(0, 12)}.` };
}

function recChallenge(root, state, env) {
  const d = env.data || {};
  const lanes = (d.lanes || []).map((l) => ({ lane: l.lane, findings: l.findings || [] }));
  const missingLanes = (d.degraded || []).filter(Boolean);
  const step = env.mode === 'post_merge' ? 'post_merge_challenge' : 'challenge';
  const res = review.record(root, { jobId: state.id, step, payload: { fingerprint: env.fingerprint, lanes, verifications: d.verifications || [], lanes_requested: env.lanes_requested } });
  if (step === 'post_merge_challenge') {
    if (res.confirmed.length) {
      const fresh = job.load(root, state.id);
      const ch = ledger.lastStep(root, state.id, step);
      const serious = ch.detail.findings.filter((f) => f.status === 'confirmed' && ['blocker', 'major'].includes(f.severity));
      const fu = lifecycle.followup(root, { jobId: fresh.id, findings: serious });
      // Post-merge review is recorded as done either way; the follow-up job carries the fix.
      ledger.append(root, state.id, { kind: 'step', step, ok: true, bound: {}, detail: { followup: fu.followup } });
      return { status: 'ok', followup: fu.followup, message: `Confirmed problems after merge: opened follow-up ${fu.followup}. ${state.id} will close; the merged job is never reopened.` };
    }
    if (!res.ok) return { status: 'retry', ...res, message: 'Post-merge review incomplete (lanes missing or findings unverified); factory next runs it again.' };
    return { status: 'ok', ...res, message: 'Post-merge review passed.' };
  }
  // A serious finding no verifier could settle is re-verified each round,
  // never dropped; after max_reverify_rounds tries the job parks for the human.
  if (!res.ok && !res.confirmed.length && (res.carried || []).length) {
    const L = state.policy.limits || {};
    const allowed = (L.max_reverify_rounds || 3) + ((state.counters || {}).reverify_bonus || 0);
    const stuck = res.carried.filter((c) => c.times > allowed);
    if (stuck.length) {
      return { status: 'park', park_from: 'reverify', degraded: missingLanes, ...res, park_reason: `Serious review finding(s) still unverified after ${allowed} re-verification round(s): ${stuck.map((c) => c.id).join(', ')}. They block ship until a verifier settles them; "resume" re-verifies once more.`, message: 'Parked: a serious finding could not be verified.' };
    }
  }
  return { status: res.ok ? 'ok' : res.confirmed.length ? 'fix' : 'retry', degraded: missingLanes, ...res, message: res.ok ? 'All required lanes pass.' : res.confirmed.length ? 'Confirmed serious findings: factory next schedules a fix round.' : `Lanes missing or findings unverified (${[...res.missing, ...res.unverified].join(', ')}); factory next runs the review again${(res.carried || []).length ? ', re-verifying the unverified ones' : ''}.` };
}

// Which agents ran, as the workflow saw them: sealed, so the console and the inspector
// can show the crew per step without trusting a file an agent could edit. Written for
// results that count (and for errors), never for a stale envelope that was thrown away.
function recordRoster(root, state, env) {
  ledger.append(root, state.id, {
    kind: 'agents', workflow: env.workflow, config: env.config || null, mode: env.mode || null,
    decision_id: state.last_decision_id || null, status: env.status,
    agent_runs: (env.budgets && env.budgets.used && env.budgets.used.agent_runs) || 0,
    agents: (env.agents || []).slice(0, 200).map((a) => ({ label: String(a.label).slice(0, 120), agent_type: String(a.agent_type).slice(0, 60), model: a.model ? String(a.model).slice(0, 60) : null, retry: Boolean(a.retry), outcome: a.outcome ? String(a.outcome).slice(0, 40) : null })),
  });
}

function apply(root, { jobId, file, envelope }) {
  const env = envelope || readJson(file, null);
  if (!env) fail(`No envelope found${file ? ` in ${file}` : ''}`, 'bad_input');
  const errs = validate(readJson(pluginPath('schemas', 'envelope.json')), env);
  if (errs.length) fail(`Envelope invalid:\n- ${errs.join('\n- ')}`, 'bad_envelope', errs);
  const state = job.resolve(root, jobId || env.job);
  if (state.id !== env.job) fail(`Envelope is for ${env.job}, not ${state.id}`, 'bad_input');
  // the workflow came back: its run ends here, with the roster (console step list, run-steps.js)
  require('./wfrun').end(root, { job: state.id, workflow: env.workflow, config: env.config || null, outcome: env.status === 'error' ? 'failed' : 'ok', status: env.status, error: env.status === 'error' ? env.summary : null, roster: env.agents });
  if (state.status !== 'active') fail(`${state.id} is ${state.status}; nothing recorded.`, 'not_active');

  budgets.addAgentRuns(state, env.budgets && env.budgets.used && env.budgets.used.agent_runs);
  job.save(root, state);
  if (env.status === 'error') {
    recordRoster(root, state, env);
    ledger.append(root, state.id, { kind: 'error', workflow: env.workflow, config: env.config || null, summary: env.summary });
    return { job: state.id, status: 'error', message: `Workflow reported an error: ${env.summary}. factory next will retry once, then park.` };
  }
  const expected = wfargs.currentInputHash(root, state, env);
  if (expected && expected !== env.input_hash) {
    return { job: state.id, status: 'stale', message: 'The inputs changed while the workflow ran (contract, findings, design or build). Nothing recorded; run factory next.' };
  }
  recordRoster(root, state, env);

  let res;
  const fresh = job.load(root, state.id);
  switch (env.workflow) {
    case 'fanout-judge':
      if (env.config === 'clarify') res = recClarify(root, fresh, env);
      else if (env.config === 'decide') res = recDecide(root, fresh, env);
      else if (env.config === 'challenge') res = recChallenge(root, fresh, env);
      else fail(`Unknown config ${env.config}`, 'bad_envelope');
      break;
    case 'ground':
      res = recGround(root, fresh, env);
      break;
    case 'decompose':
      res = recDecompose(root, fresh, env);
      break;
    case 'realize':
      res = recRealize(root, fresh, env);
      break;
    case 'reconcile':
      res = recReconcile(root, fresh, env);
      break;
    default:
      fail(`Unknown workflow ${env.workflow}`, 'bad_envelope');
  }
  if (res.status === 'park') decisionTable.park(root, job.load(root, state.id), res.park_reason, res.park_from || env.workflow);
  return { job: state.id, workflow: env.workflow, config: env.config || null, ...res };
}

// `factory answer`: one channel. U-n / Q-n (positional or --id) or free text (--question).
// During clarify it settles the issue in the ledger (cli/core/clarify.js answer); free text
// that matches no issue is refused with the open ids, never dropped. After H1 (ground's
// blocking questions) a free-text answer is recorded by its question text, as before.
function answer(root, { jobId, id, ref, question, answer: a, acceptDefault = false, via = 'cli' }) {
  const state = job.resolve(root, jobId);
  const R = String(ref || id || '').trim().toUpperCase();
  const clarifyMod = require('./clarify');
  const approved = Boolean(state.approvals && (state.approvals.H1 || state.approvals.EH1));
  if (clarifyMod.inClarify(state) || /^U-\d+$/.test(R) || (R && !approved)) return clarifyMod.answer(root, { jobId: state.id, ref: R, text: a, question, acceptDefault, via });
  const logged = R ? (state.question_log || []).find((q) => q.id === R) : null;
  if (R && !logged) fail(`No question ${R} was asked in ${state.id}.`, 'bad_input');
  if (logged && approved) return clarifyMod.answer(root, { jobId: state.id, ref: R, text: a, acceptDefault, via });
  const q = logged ? logged.question : question;
  if (!q || !a) fail('Need the answer: factory answer <U-n|Q-n> "<answer>", or --question "..." --answer "...".', 'bad_input');
  const f = jobPaths(root, state.id).answers;
  const list = readJson(f, []);
  list.push({ ...(logged ? { id: logged.id, category: logged.category } : {}), question: q, answer: a, via, at: nowIso() });
  writeJson(f, list);
  return { job: state.id, ...(logged ? { id: logged.id } : {}), answers: list.length };
}

module.exports = { apply, answer, findingsMarkdown };
