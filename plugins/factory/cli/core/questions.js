'use strict';
// The clarify question protocol, enforced by the CLI (the workflow applies the same
// rules first; record re-applies them, so a judge can't talk its way past them):
// intent first and alone, then scope > constraint > acceptance; a per-round budget;
// never re-ask; every question carries an id, a category, why, and a default.

const CATEGORIES = ['intent', 'scope', 'constraint', 'acceptance'];
const FOCUS_CATEGORY = { intent: 'intent', ambiguity: 'scope', scope: 'scope', constraints: 'constraint', constraint: 'constraint', testability: 'acceptance', acceptance: 'acceptance' };

// Round r (1-based): early rounds get early_questions, later ones later_questions,
// the last allowed round none (record assumptions instead).
function budget(cfg, round, L) {
  if (round >= L.max_intent_rounds) return 0;
  return round <= cfg.limits.early_rounds ? cfg.limits.early_questions : cfg.limits.later_questions;
}

// Clarify v2: the ledger fields a question keeps through the protocol (its issue, kind, subject).
const LEDGER_FIELDS = ['unknown', 'kind', 'subject'];

const key = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function category(q) {
  const c = String((q && (q.category || q.focus)) || '').toLowerCase();
  return CATEGORIES.includes(c) ? c : FOCUS_CATEGORY[c] || 'scope';
}

// Everything already asked or answered, as text (answers.json may hold ground's questions too).
function askedList(state, answers = []) {
  return [...new Set([...(state.asked_questions || []), ...answers.map((a) => a.question).filter(Boolean)])];
}

// -> { questions, held, dropped }. held = lower categories kept back while intent is open.
function shape(list, { budget: max = Infinity, asked = [], startId = 0 } = {}) {
  const seen = new Set(asked.map(key));
  const dropped = [];
  const ok = [];
  const seenU = new Set();
  for (const q of list || []) {
    if (!q || !q.question) continue;
    const k = key(q.question);
    if (seen.has(k)) { dropped.push({ question: q.question, reason: 'already asked' }); continue; }
    if (q.unknown && seenU.has(q.unknown)) { dropped.push({ question: q.question, reason: `same issue as another question (${q.unknown})` }); continue; }
    seen.add(k);
    if (q.unknown) seenU.add(q.unknown);
    ok.push({
      question: String(q.question).trim(),
      category: category(q),
      why: String(q.why || '').trim(),
      default: String(q.default || '').trim() || (category(q) === 'intent' ? 'None: the factory will not guess the intent' : 'None given: answer needed'),
      ...(Array.isArray(q.options) && q.options.length ? { options: q.options.slice(0, 5).map(String) } : {}),
      ...LEDGER_FIELDS.reduce((o, f) => (q[f] !== undefined ? { ...o, [f]: q[f] } : o), {}),
    });
  }
  const intentOpen = ok.some((q) => q.category === 'intent');
  const held = intentOpen ? ok.filter((q) => q.category !== 'intent') : [];
  const pick = (intentOpen ? ok.filter((q) => q.category === 'intent') : ok).map((q, i) => ({ q, i }))
    .sort((a, b) => CATEGORIES.indexOf(a.q.category) - CATEGORIES.indexOf(b.q.category) || a.i - b.i).map((x) => x.q);
  for (const q of pick.slice(max)) dropped.push({ question: q.question, reason: 'over budget' });
  const questions = pick.slice(0, max).map((q, i) => ({ id: `Q-${startId + i + 1}`, ...q }));
  return { questions, held, dropped, intent_open: intentOpen };
}

// Clarify v2 (docs/DESIGN-CLARIFY-v2.md): every question goes through the ledger. Its issue is
// found by same_as / U-n, then by subject and wording; a question about a settled, dropped or
// deferred issue is not asked, nor one already asked and waiting for its answer; a new one
// becomes an issue with an owner (an implementation detail is deferred to design, not asked).
// data: the ledger (cli/core/clarify.js); bg: the job's vocabulary (clarify.vocabulary(title)),
// for the dedup rule. -> { questions, created, skipped }
function ground(list, data, round = null, source = 'judge', bg = null) {
  const clarify = require('./clarify');
  let n = data.issues.reduce((m, u) => Math.max(m, Number(String(u.id).replace('U-', '')) || 0, ...(u.aliases || []).map((a) => Number(String(a.id).replace('U-', '')) || 0)), 0);
  const out = [];
  const created = [];
  const skipped = [];
  for (const q of list || []) {
    if (!q || !q.question) continue;
    let u = clarify.findSame([...data.issues, ...created], { ...q, text: q.question }, bg);
    if (!u) {
      const kind = clarify.KINDS.includes(q.kind) ? q.kind : category(q);
      n += 1;
      u = clarify.cleanIssue({ id: `U-${n}`, text: q.question, kind, impact: 'high', draft: q.question, default: q.default, owner: q.owner, subject: q.subject, why: q.why, source, round, ...(Array.isArray(q.options) ? { options: q.options } : {}) }, { round });
      clarify.event(u, round, u.status === 'deferred_to_design' ? 'deferred_to_design' : 'opened', source, q.question);
      created.push(u);
    }
    if (clarify.FINAL.has(u.status)) {
      skipped.push({ question: q.question, unknown: u.id, reason: `${u.id} is ${u.status === 'settled' ? `settled (${u.settled_by})` : u.status}: not asked again` });
      continue;
    }
    if (u.question_id) {
      skipped.push({ question: q.question, unknown: u.id, reason: `${u.id} was asked as ${u.question_id}: waiting for the answer` });
      continue;
    }
    const def = q.default && !clarify.isNone(q.default) ? q.default : u.default || q.default;
    out.push({ ...q, unknown: u.id, kind: u.kind, subject: u.subject, ...(def ? { default: def } : {}) });
  }
  return { questions: out, created, skipped };
}

module.exports = { CATEGORIES, FOCUS_CATEGORY, LEDGER_FIELDS, budget, shape, ground, askedList, key };
