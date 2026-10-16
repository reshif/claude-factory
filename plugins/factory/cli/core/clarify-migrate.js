'use strict';
// Clarify v1/v2 → v3 (docs/DESIGN-CLARIFY-v3.md, "Migration"), for claude-factory's own records.
// A job still in clarify (H1 not approved) with an older record and no clarify.json gets a v3
// record on its first v3 touch; the old files are left as they were. Only the data is converted
// here: every rule that then applies to it is cli/core/clarify.js's.
//
// The older records:
//   v2 (0.14–0.15): jobs/<J>/clarify-ledger.json, sealed: issues U-n { subject, text, kind
//       (intent | scope | constraint | acceptance | decision | user), impact, owner (user |
//       design), status (open | proposed | settled | deferred_to_design | dropped), settled_by
//       (user | assumption_accepted | design_deferral), options, default, answer, answered,
//       question_id, aliases [{ id, text, question_id }], notes, history }, and contract notes.
//   v1 (before 0.14): the job state's question_log (Q-n: round, category, question, default,
//       options) and jobs/<J>/answers.json (by Q-n, or free-form by question text).
// Clarify here never researched (no scouts, no evidence), so nothing migrates as evidence.
//
//   v2 issue / v1 question            → v3 item
//   answered by the user              → strength user, the answer kept as a word W-n
//   default accepted (or taken)       → strength accepted
//   low impact, assumed, not asked    → strength assumption ("facts I'll assume")
//   deferred to design                → deferred, owner design
//   dropped / dismissed               → dropped, with who dropped it and why (the user can reopen it)
//   open, proposed (asked)            → open: a decision is researched, anything else is asked
//   an alias a v2 fold merged         → its own item again, linked to the one it was folded into
//   an H1 denial since the last approval → one redirect, read back after the read-back
// Identity is by id only (Q-n, U-n): a free-form answer no id or exact question text claims is
// kept as the user's words for the read-back, never matched to an issue by word overlap.

const fs = require('fs');
const { readJson, nowIso } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const sealMod = require('../lib/seal');

const clip = (s, n = 400) => String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const num = (id) => Number(String(id || '').replace(/^[A-Z]+-/, '')) || 0;
const isNone = (d) => !d || /^none\b/i.test(String(d).trim()) || /^your call\b/i.test(String(d).trim());
// Implementation detail v1 left open: design's, as the v1 → v2 migration decided too.
const IMPL = /\b(exact|precise|specific)\s+(syntax|commands?|fields?|names?|format|lines?|api|endpoints?|regex|signatures?|parameters?|keys?|path)\b|\b(command|cli)\s+(syntax|forms?|format)\b|\bsyntax\b|\bline ranges?\b|\bline numbers?\b|\b(api|json|payload|response|schema|serializer)\s+(fields?|keys?|attributes?)\b|\bfield names?\b|\bparser\b|\bparsing\b|\bregex\b|\bwhich ([\w-]+ )?(cli )?commands?\b|\bcli commands?\b/i;

// The older record of a job, or null: { from: 2, ledger } (a ledger whose seal holds), or
// { from: 1, tampered_ledger? } (v1's question log; also a v2 ledger that fails its seal, rebuilt
// from the question log as 0.14 did).
function legacy(root, state) {
  const f = jobPaths(root, state.id).clarifyLedger;
  let led = null;
  try {
    led = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  } catch {
    led = null;
  }
  if (led && sealMod.valid(led)) {
    const { seal: _s, ...rest } = led;
    return { from: 2, ledger: rest };
  }
  const ranV1 = ((state.counters && state.counters.clarify_rounds) || 0) >= 1 || (state.question_log || []).length > 0;
  if (led || ranV1) return { from: 1, ...(led ? { tampered_ledger: true } : {}) };
  return null;
}

// Options as the sheet shows them; a default is a recommendation only when it names one of the
// options ("Your call: …" never did). A real default with no options is the one option offered
// (claude-factory's clarify took it when the user skipped the question).
function optionsOf(options, def) {
  let opts = (Array.isArray(options) ? options : []).slice(0, 5).map((o, i) => ({ key: String.fromCharCode(97 + i), text: clip(typeof o === 'string' ? o : o && o.text, 200) })).filter((o) => o.text);
  const d = String(def || '').trim();
  if (!opts.length && d && !isNone(d)) opts = [{ key: 'a', text: clip(d.replace(/^your call\s*:\s*/i, ''), 200) }];
  const rec = isNone(d) ? null : opts.find((o) => o.text.toLowerCase() === d.toLowerCase());
  return opts.length ? { options: opts, recommendation: rec ? rec.key : null, ...(d ? { v2_default: clip(d, 200) } : {}) } : {};
}

function migrate(root, state, old) {
  const C = require('./clarify');
  const data = C.empty(state);
  const from = old.from;
  const report = { from, at: nowIso(), items: 0, aliases_split: 0, answered: 0, accepted: 0, assumed: 0, evidence: 0, deferred: 0, dropped: 0, open: 0, words: 0, redirect: false, summary: '', ...(old.tampered_ledger ? { tampered_ledger: true } : {}) };
  if (state.request) C.addWord(data, state.request, 'request');
  const answers = readJson(jobPaths(root, state.id).answers, []) || [];
  const word = (text) => {
    const t = String(text || '').trim();
    if (!t) return null;
    const had = data.words.find((w) => w.text === t);
    return had || C.addWord(data, t, 'migration');
  };
  const add = (u, { parent = null } = {}) => {
    const kind = u.kind === 'decision' ? 'decision' : null;
    const text = clip(u.text, 300);
    const impact = ['high', 'medium', 'low'].includes(u.impact) ? u.impact : 'high';
    let fields = { text, impact, origin: 'migration', needs_research: false };
    const st = u.status;
    if (st === 'settled' && u.settled_by === 'user' && u.answer) {
      const w = word(u.answer);
      fields = { ...fields, kind: kind || 'fact', value: u.answer, status: 'decided', strength: 'user', source: { kind: 'word', ref: w.id, quote: clip(u.answer, 300) } };
      report.answered += 1;
    } else if (st === 'settled' && u.answer && u.answered && (u.answered.default_accepted || u.answered.via === 'default')) {
      fields = { ...fields, kind: kind || 'fact', value: u.answer, status: 'decided', strength: 'accepted', source: { kind: 'migration', ref: u.question_id || u.id } };
      report.accepted += 1;
    } else if (st === 'settled') {
      fields = { ...fields, kind: kind || 'fact', value: u.answer || (isNone(u.default) ? null : u.default) || u.draft || text, status: 'assumed', strength: 'assumption', extra: { unconfirmed: `assumed by the v${from} rules without asking` } };
      report.assumed += 1;
    } else if (st === 'deferred_to_design') {
      fields = { ...fields, kind: kind || 'fact', status: 'deferred', owner: 'design' };
      report.deferred += 1;
    } else if (st === 'dropped') {
      fields = { ...fields, kind: kind || 'question', status: 'dropped' };
      report.dropped += 1;
    } else {
      // open or asked: a decision is researched and put on the sheet; anything else only the user can say
      fields = { ...fields, kind: kind || 'question', status: 'open', ...(kind ? { tag: 'decision', needs_research: true } : {}) };
      report.open += 1;
    }
    if (!parent) {
      const o = optionsOf(u.options, u.default);
      if (o.options) fields.extra = { ...(fields.extra || {}), ...o, ...(u.why ? { why: clip(u.why, 300) } : {}) };
    }
    const it = C.newItem(data, fields, 'migration');
    if (st === 'dropped') {
      // who dropped it and why, as the older clarify recorded it (a judge's dismissal reason)
      const h = [...(u.history || [])].reverse().find((x) => /dropped|dismissed/.test(x.event || '')) || {};
      const why = String(h.text || '').trim() || (/:\s*$/.test(String(u.note || '')) ? '' : String(u.note || '').trim());
      it.history.push({ at: nowIso(), event: 'dropped', actor: h.actor ? `${h.actor} (clarify v${from})` : `clarify v${from}`, text: clip(why || 'no reason recorded', 200) });
    }
    if (parent) {
      it.folded_into = parent;
      it.history.push({ at: nowIso(), event: 'split', actor: 'migration', text: `v${from} folded "${text}" into ${parent}; v3 keeps it as its own item` });
      report.aliases_split += 1;
    }
    it.v2_id = u.id;
    if (u.question_id) it.question_id = u.question_id;
    if (it.tag) data.plan.push({ id: `P-${data.plan.length + 1}`, item: it.id, what: it.text, tag: 'decision', pins: [] });
    report.items += 1;
    return it;
  };
  // an answer given by id (Q-n, or U-n) to a question: the user's, whatever the record did with it
  const answerFor = (ids) => [...answers].reverse().find((a) => a.answer && ((a.id && ids.includes(String(a.id).toUpperCase())) || (a.issue && ids.includes(String(a.issue).toUpperCase()))));

  if (from === 2) {
    const issues = (old.ledger.issues || []).slice().sort((a, b) => num(a.id) - num(b.id));
    for (const u of issues) {
      const it = add(u);
      for (const a of u.aliases || []) {
        // an alias the user answered by its own question id is answered; the others are asked again
        const ans = a.question_id ? answerFor([String(a.question_id).toUpperCase()]) : null;
        const ai = add({ id: a.id, text: a.text, kind: u.kind, impact: u.impact, question_id: a.question_id || null, ...(ans ? { status: 'settled', settled_by: 'user', answer: ans.answer } : { status: 'open' }) }, { parent: it.id });
        void ai;
      }
    }
    // the user's notes on issues and on the contract are their words too
    for (const u of issues) for (const n of u.notes || []) if (/^user/.test(n.actor || '')) word(n.text);
    for (const n of old.ledger.notes || []) if (/^user/.test(n.actor || 'user')) word(n.text);
  } else {
    // v1: each asked question is its own item (v3 folds nothing); answered by Q-n or its exact text
    const log = (state.question_log || []).slice().sort((a, b) => num(a.id) - num(b.id));
    for (const q of log) {
      const exact = [...answers].reverse().find((a) => a.answer && ((a.id && String(a.id).toUpperCase() === q.id) || (!a.id && String(a.question || '').toLowerCase().trim() === String(q.question || '').toLowerCase().trim())));
      const open = !exact;
      const impl = open && IMPL.test(String(q.question || ''));
      add({ id: q.id, text: q.question, kind: q.category === 'decision' ? 'decision' : 'user', impact: ['intent', 'scope'].includes(q.category) ? 'high' : 'medium', options: q.options, default: q.default, question_id: q.id, ...(exact ? { status: 'settled', settled_by: 'user', answer: exact.answer } : impl ? { status: 'deferred_to_design' } : { status: 'proposed' }) });
    }
  }
  // every other answers.json line: still the user's words, for the read-back
  for (const a of answers) if (a.answer) word(a.answer);
  report.words = data.words.filter((w) => w.via === 'migration').length;
  // the denials since the last approval: one redirect, read back after the read-back. Every
  // denial is the user's words: an earlier one is never lost to a later one.
  const approvedAt = (g) => (state.approvals && state.approvals[g] ? state.approvals[g].at : '');
  const denials = (state.denials || []).filter((d) => ['H1', 'EH1'].includes(d.gate) && d.at > approvedAt(d.gate));
  if (denials.length) {
    const texts = [];
    for (const d of denials) {
      const t = String(d.reason || '').trim();
      if (t && !texts.includes(t)) texts.push(t);
    }
    const d = denials[denials.length - 1];
    const R = C.startRedirect(data, texts.length > 1 ? texts.join('\n') : texts[0] || '(no reason given)', 'denial', d.gate);
    R.status = 'queued';
    R.denials = denials.length;
    data.denials_seen = d.at;
    report.redirect = R.id;
    report.denials = denials.length;
  }
  data.stage = 'readback';
  report.summary = `${report.items} item(s) from clarify v${from}${report.aliases_split ? ` (${report.aliases_split} folded alias(es) made their own items again)` : ''}, ${report.answered} answered by you, ${report.accepted} accepted defaults, ${report.assumed} assumed without asking, ${report.deferred} deferred to design, ${report.dropped} dropped, ${report.open} still open${report.tampered_ledger ? '; the v2 ledger failed its seal, so the questions were rebuilt from the question log' : ''}${report.redirect ? `; ${report.denials > 1 ? `your ${report.denials} denials since the last approval are` : 'your last denial is'} ${report.redirect}, read back after this` : ''}`;
  data.migration = report;
  data.history.push({ at: nowIso(), stage: 'readback', event: 'migrated', text: report.summary });
  return data;
}

// For ground and decide on a job approved under clarify v2: what its ledger handed to design.
function legacyDeferredText(root, state) {
  const old = legacy(root, { ...state, counters: {}, question_log: [] });
  const d = old && old.ledger ? (old.ledger.issues || []).filter((u) => u.status === 'deferred_to_design') : [];
  if (!d.length) return '';
  return ['- Deferred to design by clarify (implementation detail: settle these here, cite your sources; they did not block H1):', ...d.map((u) => `  - ${u.id} [${u.kind}] ${clip(u.text, 200)}${u.aliases && u.aliases.length ? ` (also raised as ${u.aliases.map((a) => a.id).join(', ')})` : ''}`)].join('\n');
}

module.exports = { legacy, migrate, legacyDeferredText, optionsOf };
