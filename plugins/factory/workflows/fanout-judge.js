export const meta = {
  name: 'fanout-judge',
  description: 'Software Factory engine for decide, challenge and diagnose: N independent agents in parallel, retry once, a judge merges; for decide, critics with evidence (God Eye, and the API-conformance critic when the job has dependency source) whose serious items are verified, the architect revising while they shrink (the shared loop engine); per-finding verifiers; a loop diagnosis. Pass the JSON brief from `factory wfargs fanout-judge --config <decide|challenge|diagnose|env_repair>` as args (env_repair: the planner repairs a sealed build environment that failed its check). (Clarify runs as its own workflow, factory:clarify.)',
}

// ---- brief (from the factory CLI; workflows cannot read files or run commands) ----
const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'fanout-judge') throw new Error('fanout-judge needs the JSON brief from `factory wfargs fanout-judge --config …` as its args')
  return a
})()

// Every agent runs as its real factory agent (agents/<role>.md): its system prompt,
// tool limits and model apply. The brief names it; a missing one is a broken brief.
function opts(spec, label, model) {
  if (!spec || !/^factory:[a-z-]+$/.test(spec.agent_type || '')) throw new Error(`Brief item "${label}" has no factory agent_type`)
  const o = { schema: spec.schema, label, agentType: spec.agent_type }
  const m = model || spec.model
  if (m) o.model = m
  return o
}

// Every agent call is noted in the envelope's roster, so the console can show which
// factory agents ran, on which model, and how each one came back.
const roster = []
async function call(prompt, o) {
  const r = await agent(prompt, o)
  const outcome = !r ? 'no_result' : r.status || (typeof r.pass === 'boolean' ? (r.pass ? 'pass' : 'fail') : r.verdict || 'ok')
  roster.push({ label: o.label, agent_type: o.agentType, model: o.model || null, retry: /\(retry\)$/.test(o.label), outcome })
  return r
}

let runs = 0
async function one(prompt, spec, label) {
  runs += 1
  let r = await call(prompt, opts(spec, label))
  if (!r) {
    runs += 1
    r = await call(prompt, opts(spec, `${label} (retry)`))
  }
  return r || null
}
async function fan(items) {
  if (!items.length) return []
  runs += items.length
  const first = await pipeline(items, (it) => call(it.prompt, opts(it, it.label)))
  const out = first.slice()
  const failed = items.map((it, i) => (out[i] ? null : i)).filter((i) => i !== null)
  if (failed.length) {
    runs += failed.length
    const again = await pipeline(failed.map((i) => items[i]), (it) => call(it.prompt, opts(it, `${it.label} (retry)`)))
    failed.forEach((idx, k) => { out[idx] = again[k] || null })
  }
  return out
}
function envelope(status, summary, data, extra = {}) {
  return {
    workflow: 'fanout-judge',
    config: brief.config,
    mode: brief.mode || null,
    job: brief.job,
    status,
    next_gate: null,
    input_hash: brief.input_hash,
    agents: roster,
    budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
    artifacts: [],
    questions: [],
    park_reason: null,
    summary,
    data,
    ...extra,
  }
}

// ---- 1. fan-out ----
if (brief.fanout.length) phase(`${brief.config}: fan-out (${brief.fanout.length})`)
const outs = await fan(brief.fanout)
const inputsNow = () => brief.fanout.map((f, i) => ({ id: f.id, ...(f.category ? { category: f.category } : {}), output: outs[i] })).filter((x) => x.output)
const degradedNow = () => brief.fanout.filter((f, i) => !outs[i]).map((f) => f.id)

const degraded = degradedNow()
const inputs = inputsNow()
if (degraded.length) log(`No result after retry: ${degraded.join(', ')}`)

// ---- the loop engine, inline (a workflow script cannot require a module) ----
// An exact copy of cli/core/loop.js's DEFAULTS, keyOf, keys, policyFor, fresh, shouldContinue,
// recordDiagnosis and question, without the clock (a workflow may not read Date); the test suite
// checks that it decides exactly as cli/core/loop.js does (tests/v0100-port.test.js).
// LOOP ENGINE BEGIN
const DEFAULTS = { ceiling: 5, stall_rounds: 2, escalate_model: 'opus', diagnose: true };

// A blocker's fingerprint: its check and what it points at (case-insensitive), or the caller's key.
function keyOf(b) {
  if (b === null || b === undefined) return '';
  if (typeof b === 'string') return b.trim();
  if (b.key) return String(b.key).trim();
  const ref = String(b.ref || b.file || b.ac || '').trim().toUpperCase();
  return `${b.check || b.kind || b.rule || 'blocker'}|${ref}${b.extra ? `|${b.extra}` : ''}`;
}

function keys(blockers) {
  return [...new Set((blockers || []).map(keyOf).filter(Boolean))].sort();
}

function policyFor(pol = {}, overrides = {}) {
  const loops = (pol && pol.loops) || {};
  const num = (v, d) => (typeof v === 'number' && v > 0 ? Math.floor(v) : d);
  return {
    ceiling: num(overrides.ceiling, num(loops.ceiling, DEFAULTS.ceiling)),
    stall_rounds: num(overrides.stall_rounds, num(loops.stall_rounds, DEFAULTS.stall_rounds)),
    escalate_model: overrides.escalate_model !== undefined ? overrides.escalate_model : typeof loops.escalate_model === 'string' || loops.escalate_model === null ? loops.escalate_model : DEFAULTS.escalate_model,
    diagnose: overrides.diagnose !== undefined ? overrides.diagnose !== false : loops.diagnose !== false,
  };
}

function fresh() {
  return { rounds: 0, best: null, stalls: 0, level: 0, last: null, history: [], diagnosis: null, pending: null, stopped: null };
}

// level: 0 the agent's own model, 1 the stronger model, 2 diagnosed (approach given), 3 stopped
function shouldContinue(loopState, blockers, policy) {
  const P = policyFor({}, policy || {});
  const s = { ...fresh(), ...(loopState || {}) };
  s.history = [...(s.history || [])];
  const open = keys(blockers);
  const last = s.last || [];
  const closed = last.filter((k) => !open.includes(k));
  const added = open.filter((k) => !last.includes(k));
  const model = s.level >= 1 && P.escalate_model ? P.escalate_model : null;
  const out = (action, rule, extra = {}) => ({ action, rule, round: s.rounds, open, closed, added, escalation: null, model, ...extra, state: s });

  if (!open.length) {
    // resolved: the next time this loop has blockers it starts from the beginning (a loop that
    // once stopped or escalated does not stay stopped)
    return { ...out('done', 'resolved'), state: { ...fresh(), ...(s.segments ? { segments: s.segments } : {}) } };
  }
  // a diagnosis is pending: the same observation again is not a new round
  if (s.pending) {
    if (s.pending.kind === 'diagnosis' && !s.diagnosis) return out('diagnose', s.pending.rule, { escalation: 'diagnosis' });
    const p = s.pending;
    s.pending = null;
    if (p.then_stop || (s.diagnosis && s.diagnosis.needs_user)) {
      // the ceiling stays the reason when it was; otherwise the loop made no progress
      const rule = p.then_stop ? p.rule : 'no_progress';
      s.level = 3;
      s.stopped = { rule, at: null, round: s.rounds };
      return out('stop', rule);
    }
    // the diagnosis gave the agent a different approach: one more round with it
    s.level = 2;
    s.stalls = 0;
    s.rounds += 1;
    s.history.push({ round: s.rounds, open, at: null, note: 'after diagnosis' });
    s.history = s.history.slice(-20);
    return out('continue', 'diagnosed', { approach: (s.diagnosis && s.diagnosis.approach) || null, model: P.escalate_model || null });
  }
  if (s.level >= 3) return out('stop', (s.stopped && s.stopped.rule) || 'no_progress');

  const first = s.best === null;
  // progress is by count: fewer open blockers than the best so far, even if they are new ones
  // (a smaller, different set counts). The ceiling bounds the rounds either way, so every loop ends.
  const progress = first || open.length < s.best;
  const stop = (rule) => {
    if (P.diagnose && !s.diagnosis) {
      s.pending = { kind: 'diagnosis', rule, then_stop: true };
      return out('diagnose', rule, { escalation: 'diagnosis' });
    }
    s.level = 3;
    s.stopped = { rule, at: null, round: s.rounds };
    return out('stop', rule);
  };
  // the hard ceiling: rounds already run
  if (s.rounds >= P.ceiling) {
    s.last = open;
    return stop('ceiling');
  }
  if (progress) {
    s.best = open.length;
    s.stalls = 0;
  } else s.stalls += 1;
  s.last = open;
  let action = 'continue';
  let rule = first ? 'first_round' : progress ? 'progress' : 'stalled';
  let escalation = null;
  if (!progress) {
    if (s.level === 0 && s.stalls >= P.stall_rounds) {
      if (P.escalate_model) {
        s.level = 1;
        s.stalls = 0;
        action = 'escalate';
        rule = 'escalate_model';
        escalation = 'model';
      } else if (P.diagnose && !s.diagnosis) {
        s.pending = { kind: 'diagnosis', rule: 'diagnose', then_stop: false };
        return out('diagnose', 'diagnose', { escalation: 'diagnosis' });
      } else return stop('no_progress');
    } else if (s.level === 1 && s.stalls >= 1) {
      if (P.diagnose && !s.diagnosis) {
        s.pending = { kind: 'diagnosis', rule: 'diagnose', then_stop: false };
        return out('diagnose', 'diagnose', { escalation: 'diagnosis' });
      }
      return stop('no_progress');
    } else if (s.level === 2 && s.stalls >= 1) return stop('no_progress');
  }
  s.rounds += 1;
  s.history.push({ round: s.rounds, open, at: null, rule });
  s.history = s.history.slice(-20);
  const m = s.level >= 1 && P.escalate_model ? P.escalate_model : null;
  return out(action, rule, { escalation, model: m, round: s.rounds });
}

// The diagnosis agent's answer: { cause, needs_user, approach, question, options, recommendation }.
function recordDiagnosis(loopState, d) {
  const s = { ...fresh(), ...(loopState || {}) };
  const clip = (x, n = 400) => String(x === undefined || x === null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n);
  const opts = (Array.isArray(d && d.options) ? d.options : []).slice(0, 5).map((o, i) => ({ key: String((o && o.key) || 'abcde'[i]).toLowerCase().slice(0, 2), text: clip(typeof o === 'string' ? o : o && o.text, 240), consequences: clip(o && o.consequences, 240) })).filter((o) => o.text);
  const rec = clip(d && d.recommendation, 60).toLowerCase();
  s.diagnosis = {
    at: null,
    cause: clip(d && d.cause, 600),
    needs_user: Boolean(d && d.needs_user),
    approach: clip(d && d.approach, 600) || null,
    question: clip(d && d.question, 400) || null,
    options: opts,
    recommendation: opts.find((o) => o.key === rec || o.text.toLowerCase() === rec) ? (opts.find((o) => o.key === rec) || opts.find((o) => o.text.toLowerCase() === rec)).key : null,
    by: (d && d.by) || 'agent',
  };
  if (!s.pending) s.pending = { kind: 'diagnosed', rule: 'diagnose', then_stop: s.diagnosis.needs_user };
  else s.pending = { ...s.pending, kind: 'diagnosed' };
  return s;
}

// The specific question a stopped loop asks the human: the diagnosis's, or one built from the
// blockers when no diagnosis could run. Always names the blockers, the options and a recommendation.
function question(loopState, { what, blockers = [], fallbackOptions = [], fallbackRecommendation = null } = {}) {
  const s = loopState || {};
  const d = s.diagnosis || null;
  const rule = (s.stopped && s.stopped.rule) || (s.pending && s.pending.rule) || 'no_progress';
  const why = rule === 'ceiling' ? `it reached its ceiling of rounds (${s.rounds})` : `${s.rounds} round(s) left the same ${blockers.length || (s.last || []).length} problem(s) open, also on a stronger model${d ? ' and after a diagnosis' : ''}`;
  const options = d && d.options.length ? d.options : fallbackOptions.map((o, i) => ({ key: 'abcde'[i], text: o.text || o, consequences: o.consequences || '' }));
  const recommendation = d && d.recommendation ? d.recommendation : fallbackRecommendation;
  const q = (d && d.question) || `How should ${what || 'this loop'} go on?`;
  const lines = [`${what ? `${what}: ` : ''}stopped because ${why}.${d && d.cause ? ` Diagnosis: ${d.cause}` : ''}`, `Question: ${q}`];
  for (const o of options) lines.push(`  ${o.key}) ${o.text}${o.key === recommendation ? ' (recommended)' : ''}${o.consequences ? ` — ${o.consequences}` : ''}`);
  lines.push('Reply with your answer in your own words (it resumes the job with them), or one of the exact replies listed.');
  return { rule, question: q, options, recommendation, cause: d ? d.cause : null, text: lines.join('\n'), diagnosed: Boolean(d) };
}
// LOOP ENGINE END

// ---- decide: critics with evidence (0.10.0) ----
// The design is critiqued by God Eye and, when the job has dependency source, the API-conformance
// critic, in parallel. Every serious (blocker/major) item goes to a finding verifier, as review
// findings do in challenge; refuted items cost no revise. An API item must carry evidence (a
// dependency file:line with its quote, or a probe's output), or it does not count as serious;
// factory record checks every source quote against the fetched file (a workflow cannot read it)
// and marks one that is not there as rejected evidence at the gate. While serious items stay open
// the architect revises — always once more after the last critique — and the loop stops on the
// shared loop engine's rule (above): on while the open set shrinks, the critics and the architect
// on the stronger model when it stalls, a diagnosis agent before it stops, a specific question
// when it stops. Every stop goes to the human gate with the open objections shown; decide never
// parks on its critique.
async function loopStep(loopState, blockers, policy, diag) {
  let v = shouldContinue(loopState, blockers, policy)
  if (v.action === 'diagnose') {
    const d = diag ? await diag(v) : null
    const ls = recordDiagnosis(v.state, d || { cause: 'the diagnosis agent returned nothing', needs_user: true, approach: '', question: '', options: [], recommendation: '' })
    v = shouldContinue(ls, blockers, policy)
    v.diagnosed = Boolean(d)
  }
  return v
}
const SERIOUS = ['blocker', 'major']
const itemKey = (it) => `${it.critic}:${String(it.symbol || it.issue || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80)}`

// The architect decides (or, after a deny that names a defect, revises the denied design: the
// critics re-check it, no new options).
async function architectDecides() {
  if (brief.targeted && brief.prior_design) {
    phase('decide: architect (revising for your deny)')
    const d = await one(`${brief.critique.revise.prompt}\n\nINPUTS:\n${JSON.stringify({ human_denial: brief.targeted, your_previous_output: brief.prior_design }, null, 2)}`, brief.critique.revise, 'architect · revise (deny)')
    return d || brief.prior_design
  }
  phase('decide: architect')
  return one(`${brief.judge.prompt}\n\nINPUTS:\n${JSON.stringify(inputs, null, 2)}`, brief.judge, 'architect')
}

async function critiqueRound(design, round, model = null) {
  const critics = brief.critics && brief.critics.length ? brief.critics : [brief.critique]
  phase(`decide: critics round ${round} (${critics.map((c) => c.id || 'god-eye').join(' + ')})`)
  const outs = await pipeline(critics, (c) => one(`${c.prompt}\n\nINPUTS:\n${JSON.stringify({ design }, null, 2)}`, model ? { ...c, model } : c, `${c.id || 'god-eye'} · design #${round}`))
  const items = []
  const verdicts = {}
  critics.forEach((c, i) => {
    const o = outs[i]
    const id = c.id || 'god-eye'
    verdicts[id] = o ? o.verdict : null
    ;((o && o.items) || []).forEach((it, k) => items.push({ ...it, critic: id, id: it.id || `${id}-${round}-${k + 1}` }))
  })
  for (const it of items) {
    if (it.critic !== 'god-eye' && SERIOUS.includes(it.severity) && !(it.evidence && it.evidence.ref)) { it.severity = 'minor'; it.evidence_rejected = 'a serious API finding must cite dependency source (file:line and quote) or a probe\'s output' }
  }
  const serious = items.filter((it) => SERIOUS.includes(it.severity))
  let verifications = []
  if (serious.length && brief.verifier) {
    phase(`decide: verify ${serious.length} serious item(s)`)
    const res = await fan(serious.map((it) => ({ prompt: brief.verifier.prompt_template.replace('{{finding}}', () => JSON.stringify({ id: it.id, critic: it.critic, severity: it.severity, symbol: it.symbol, issue: it.issue, evidence: it.evidence, suggestion: it.suggestion }, null, 2)), schema: brief.verifier.schema, agent_type: brief.verifier.agent_type, model: brief.verifier.model, label: `verify ${it.id}` })))
    verifications = res.map((r, i) => (r ? { ...r, finding_id: serious[i].id } : { finding_id: serious[i].id, status: 'unverifiable', evidence: [], reason: 'the verifier returned nothing' }))
  }
  const status = (it) => { const v = verifications.find((x) => x.finding_id === it.id); return v ? v.status : brief.verifier ? 'unverifiable' : 'confirmed' }
  for (const it of serious) it.verified = status(it)
  const open = serious.filter((it) => it.verified !== 'refuted')
  // a critic that returned nothing (twice) approved nothing: the round is not an approval
  const missing = critics.filter((c, i) => !outs[i]).map((c) => c.id || 'god-eye')
  const verdict = open.length || missing.length ? 'revise' : 'approve'
  return { round, verdict, verdicts, items, verifications, open, missing }
}

// The architect revises after a round with open items (the last one included).
async function reviseDesign(round, c, approach, design, spec, model) {
  phase(`decide: architect revises (round ${round})`)
  return one(`${brief.critique.revise.prompt}\n\nINPUTS:\n${JSON.stringify({ critique: { verdict: 'revise', items: c.open.map((it) => ({ id: it.id, critic: it.critic, severity: it.severity, symbol: it.symbol, issue: it.issue, evidence: it.evidence, suggestion: it.suggestion, verified: it.verified })) }, ...(approach ? { approach_from_diagnosis: approach } : {}), your_previous_output: design }, null, 2)}`, spec, `architect · revise #${round}${model ? ' (escalated)' : ''}`)
}

// The loop engine asked for a diagnosis: God Eye says why the objections survive, and what ends it.
async function diagnoseDesign(round, critiques, design) {
  phase(`decide: diagnosis (round ${round})`)
  return one(`${brief.diagnosis.prompt}\n\nDIAGNOSIS INPUT (JSON):\n${JSON.stringify({ focus: 'diagnosis', loop: 'the design critique loop: the critics object, the architect revises, the critics check again', rounds: critiques.map((x) => ({ round: x.round, open: x.open.map((it) => ({ id: it.id, critic: it.critic, severity: it.severity, issue: it.issue, evidence: it.evidence })) })), design }, null, 2)}`, brief.diagnosis, 'god-eye · diagnosis (design)')
}

if (brief.config === 'decide') {
  let design = await architectDecides()
  if (!design) return envelope('error', 'The architect returned nothing twice.', { options: inputs, degraded })
  const critiques = []
  const max = Math.max(1, brief.critique.max_rounds || 3)
  // the engine's ceiling counts the rounds before this one: max critiques, then a diagnosis
  const policy = { stall_rounds: 1, ...(brief.loop || {}), ceiling: Math.max(1, max - 1) }
  let loopState = null
  let model = null
  let approach = null
  let stop = 'ceiling'
  let stopQuestion = null
  let revisedAfterLast = false
  const withModel = (spec) => (model ? { ...spec, model } : spec)
  for (let round = 1; round <= max + 1; round++) {
    const c = await critiqueRound(design, round, model)
    critiques.push(c)
    revisedAfterLast = false
    if (!c.open.length) { stop = c.missing.length ? 'critic_failed' : 'approved'; break }
    const v = await loopStep(loopState, c.open.map(itemKey), policy, brief.diagnosis ? () => diagnoseDesign(round, critiques, design) : null)
    loopState = v.state
    if (v.model) model = v.model
    if (v.approach) approach = v.approach
    // always one revise after the last critique: the gate gets the design with these addressed
    const revised = await reviseDesign(round, c, approach, design, withModel(brief.critique.revise), model)
    if (revised) { design = revised; revisedAfterLast = true }
    if (v.action === 'stop' || round >= max) {
      const shrank = critiques.length > 1 && c.open.length < critiques[critiques.length - 2].open.length
      stop = v.action === 'stop' && v.rule === 'ceiling' && shrank ? 'ceiling' : v.action === 'stop' ? 'no_progress' : 'ceiling'
      stopQuestion = question(loopState, { what: 'The design critique loop', blockers: c.open.map(itemKey), fallbackOptions: ['Approve the design with these objections open', 'Deny naming the defect: a targeted revise', 'Deny rethink: new options'], fallbackRecommendation: 'b' })
      break
    }
  }
  const last = critiques[critiques.length - 1]
  // the shape recDecide has always read (verdict, items per round), plus the evidence
  const out = critiques.map((c) => ({ round: c.round, verdict: c.verdict, verdicts: c.verdicts, items: c.items, verifications: c.verifications, open: c.open.map((it) => it.id), ...(c.missing.length ? { missing: c.missing } : {}) }))
  return envelope('ok', `Design: ${design.kind} (${(design.paths || []).join(', ')}). Critics: ${last ? last.verdict : 'none'} after ${critiques.length} round(s)${stop !== 'approved' ? ` (${stop === 'no_progress' ? 'no progress' : stop === 'critic_failed' ? `no result from ${last.missing.join(', ')}` : 'ceiling'}; ${last.open.length} open${stop === 'critic_failed' ? '' : ', revised after the last critique'}: shown at the gate)` : ''}.`, { options: inputs, degraded, judge: design, critiques: out, stop, revised_after_last: revisedAfterLast, ...(stopQuestion ? { question: stopQuestion } : {}), ...(loopState ? { loop: { rounds: loopState.rounds, escalated: Boolean(model), diagnosed: Boolean(loopState.diagnosis) } } : {}), open: last ? last.open : [], targeted: Boolean(brief.targeted) }, { threat_model: Boolean(brief.threat_model) })
}

if (brief.config === 'challenge') {
  const lanes = inputs.map((x) => ({ lane: x.id, findings: x.output.findings || [] }))
  const serious = lanes.flatMap((l) => l.findings.filter((f) => (brief.verifier.severities || ['blocker', 'major']).includes(f.severity)).map((f) => ({ ...f, lane: l.lane })))
  // Findings an earlier round left unverified are re-verified every round until settled (a
  // verifier that returns nothing is retried once, like every fanned-out agent). Claude Code's
  // Workflow tool sets no agent time cap, so there is no cap to scale for them.
  const carried = brief.carried || []
  let verifications = []
  if (serious.length || carried.length) {
    phase(`challenge: verify ${serious.length} finding(s)${carried.length ? ` + ${carried.length} carried` : ''}`)
    // a carried finding (the first verifier could not settle it) gets a second verifier on the
    // stronger model that reproduces it in the build environment
    const item = (f, label, again = false) => ({
      prompt: `${brief.verifier.prompt_template.replace('{{finding}}', JSON.stringify(f, null, 2))}${again && brief.verifier.carried_note && !brief.verifier.prompt_template.includes(brief.verifier.carried_note) ? `\n\n${brief.verifier.carried_note}` : ''}`,
      schema: brief.verifier.schema,
      agent_type: brief.verifier.agent_type,
      model: (again && brief.verifier.carried_model) || brief.verifier.model,
      label,
    })
    const items = [...serious.map((f) => item(f, `verify ${f.id}`)), ...carried.map((f) => item(f, `verify ${f.id} (carried from round ${f.from_round})`, true))]
    const res = await fan(items)
    verifications = res.map((r, i) => (r ? (i < serious.length ? { ...r, finding_id: serious[i].id } : { ...r, finding_id: carried[i - serious.length].id, carried: true }) : null)).filter(Boolean)
  }
  const confirmed = verifications.filter((v) => v.status === 'confirmed').length
  const unverifiable = verifications.filter((v) => v.status === 'unverifiable').length
  const summary = `${lanes.length}/${brief.fanout.length} lane(s) reviewed; ${serious.length} serious finding(s)${carried.length ? ` and ${carried.length} carried unverified` : ''}, ${confirmed} confirmed${unverifiable ? `, ${unverifiable} unverifiable (still blocking)` : ''}.${degraded.length ? ` Missing lanes: ${degraded.join(', ')}.` : ''}`
  return envelope(degraded.length ? 'degraded' : 'ok', summary, { lanes, degraded, verifications }, { fingerprint: brief.fingerprint || null, lanes_requested: brief.lanes_requested || null })
}

// the loop engine's diagnosis of a router loop that stopped making progress (cli/core/loop.js)
if (brief.config === 'diagnose') {
  phase('diagnose: God Eye')
  const d = await one(brief.judge.prompt, brief.judge, 'diagnosis')
  return envelope('ok', d ? `Diagnosis of the ${brief.mode} loop: ${d.needs_user ? 'a question for the human' : 'a different approach'}.` : 'The diagnosis agent returned nothing.', { loop: brief.mode, diagnosis: d || null })
}

// 0.11 (copilot-factory fix 0.10.1): the sealed build environment failed its check; the planner (repair mode) writes a
// repaired one, the CLI checks it when this is recorded, the human seals it
if (brief.config === 'env_repair') {
  phase('env_repair: planner')
  const d = await one(brief.judge.prompt, brief.judge, 'environment repair')
  return envelope('ok', d ? `Environment repair: ${d.summary || d.path}.` : 'The repair agent returned nothing.', { repair: d || null })
}

throw new Error(`Unknown config ${brief.config}`)
