export const meta = {
  name: 'fanout-judge',
  description: 'Software Factory engine for clarify, decide and challenge: N independent agents in parallel, retry once, a judge merges, an optional cold critique, and per-finding verifiers. Pass the JSON brief from `factory wfargs fanout-judge --config <clarify|decide|challenge>` as args.',
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
  const first = await pipeline(items, (it) => call(`${it.prompt}${ctxBlock()}`, opts(it, it.label)))
  const out = first.slice()
  const failed = items.map((it, i) => (out[i] ? null : i)).filter((i) => i !== null)
  if (failed.length) {
    runs += failed.length
    const again = await pipeline(failed.map((i) => items[i]), (it) => call(`${it.prompt}${ctxBlock()}`, opts(it, `${it.label} (retry)`)))
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

// ---- 0. clarify v2: the issue ledger (docs/DESIGN-CLARIFY-v2.md) ----
// Every question clarify raises is an issue (U-n) with a stable subject, an owner (user |
// design) and a status (open → proposed → settled, or deferred_to_design / dropped). The brief
// carries the CLI's ledger (brief.ledger.prior); everything raised this round (the judge's
// questions, God Eye's blockers, the contract editor's skipped changes) goes through the subject
// dedup below: a raise against a settled subject is a note, never a reopen. `factory record`
// re-applies all of it on the CLI's own copy. A brief without a ledger (an older CLI) runs the
// round as before, with God Eye's blockers asked directly.
const LG = brief.config === 'clarify' && brief.ledger && Array.isArray(brief.ledger.prior) ? brief.ledger : null
const KINDS = ['intent', 'scope', 'constraint', 'acceptance', 'decision', 'user']
const FINALS = new Set(['settled', 'deferred_to_design', 'dropped'])

// -- subjects and identity (same rules as cli/core/clarify.js) --
const STOP = new Set('a an the of to for in on at by with and or is are be been does do did should shall which what when where who whom how this that these those it its as from into per than then there their our we you your can could will would must may might not no yes any all each either via vs about exact exactly precise specific confirm confirmed check verify whether if use used using uses one two new current currently today get gets set sets'.split(' '))
const SYN = { cli: 'command', cmd: 'command', commands: 'command', syntax: 'command', configures: 'configure', configured: 'configure', configuring: 'configure', configuration: 'configure', config: 'configure', ports: 'port', interfaces: 'interface', vlans: 'vlan', fields: 'field', names: 'name', lines: 'line' }
const ALSO_STOP = new Set(['form', 'forms', 'way', 'kind', 'thing', 'value', 'list'])
const normText = (s) => String(s || '').toLowerCase().replace(/\b([a-z0-9]{1,3})-([a-z0-9]{1,3})\b/g, '$1$2')
function stem(w) {
  if (SYN[w]) return SYN[w]
  let x = w
  if (x.length > 4 && x.endsWith('ies')) x = `${x.slice(0, -3)}y`
  else if (x.length > 5 && /(ches|shes|xes|sses)$/.test(x)) x = x.slice(0, -2)
  else if (x.length > 3 && x.endsWith('s') && !/(ss|os|us|is)$/.test(x)) x = x.slice(0, -1)
  return SYN[x] || x
}
function tokens(text) {
  const out = []
  for (const w of normText(text).split(/[^a-z0-9]+/)) {
    if (!w || w.length < 2 || STOP.has(w) || /^\d+$/.test(w)) continue
    const st = stem(w)
    if (STOP.has(st) || ALSO_STOP.has(st) || out.includes(st)) continue
    out.push(st)
  }
  return out
}
const subjectKey = (s) => tokens(normText(s).replace(/[._/:-]+/g, ' ')).join('.')
function subjectOf(raw) {
  if (raw && raw.subject && subjectKey(raw.subject)) return { subject: subjectKey(raw.subject), explicit: true }
  return { subject: tokens((raw && (raw.text || raw.question)) || '').slice(0, 4).join('.'), explicit: false }
}
function wordRoot(w) {
  let x = w
  if (x.length > 5 && x.endsWith('ing')) x = x.slice(0, -3)
  else if (x.length > 4 && x.endsWith('ed')) x = x.slice(0, -2)
  if (x.length > 4 && x.endsWith('e')) x = x.slice(0, -1)
  return x
}
function faces(x) {
  const subj = tokens(normText(x.subject).replace(/[._/:-]+/g, ' '))
  const out = [new Set([...subj, ...tokens(x.text || x.question || '')])]
  for (const a of x.aliases || []) out.push(new Set(tokens(a.text || '')))
  return out.map((f) => new Set([...f].map(wordRoot))).filter((f) => f.size)
}
function faceMatch(ta, tb, strict) {
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared += 1
  if (shared < 3) return false
  // a word swapped for another ("native VLAN" / "allowed VLANs", "leaf" / "spine"): that
  // difference may be the point, so fold only on a wide common core
  const onlyA = ta.size - shared
  const onlyB = tb.size - shared
  if (onlyA && onlyA === onlyB && shared < 5) return false
  const jac = shared / (ta.size + tb.size - shared)
  const ovl = shared / Math.min(ta.size, tb.size)
  return strict ? jac >= 0.6 : jac >= 0.5 || ovl >= 0.75
}
function sameIssue(a, b) {
  if (a.subject && a.subject === b.subject && (a.subject_explicit || b.subject_explicit)) return true
  const strict = Boolean(a.subject_explicit && b.subject_explicit && a.subject !== b.subject)
  const fa = faces(a)
  const fb = faces(b)
  return fa.some((x) => fb.some((y) => faceMatch(x, y, strict)))
}
const IMPL = /\b(exact|precise|specific)\s+(syntax|commands?|fields?|names?|format|lines?|api|endpoints?|regex|signatures?|parameters?|keys?|path)\b|\b(command|cli)\s+(syntax|forms?|format)\b|\bsyntax\b|\bline ranges?\b|\bline numbers?\b|\blines?\s+\d+\s*[-–]\s*\d+|\b(api|json|payload|response|schema|serializer)\s+(fields?|keys?|attributes?)\b|\bfield names?\b|\battribute names?\b|\bparser\b|\bparsing\b|\bparses\b|\bregex\b|\bwhich ([\w-]+ )?(cli )?commands?\b|\bcli commands?\b|\bcommand (form|forms|format)\b/i
function classify(raw, kind) {
  if (kind === 'intent') return 'user'
  if (raw && raw.owner === 'design') return 'design'
  if (raw && ['user', 'research'].includes(raw.owner)) return 'user'
  if (IMPL.test(`${(raw && (raw.text || raw.question)) || ''} ${(raw && raw.draft) || ''}`)) return 'design'
  return 'user'
}
const isNone = (d) => !d || /^none\b/i.test(String(d).trim()) || /^your call\.?:?\s*$/i.test(String(d).trim())
const led = LG ? {
  round: LG.round || brief.round || null,
  issues: LG.prior.map((u) => ({ ...u, history: (u.history || []).slice(), notes: (u.notes || []).slice(), aliases: (u.aliases || []).slice() })),
  ids: { U: LG.next_id || 0 },
  raised: { created: [], folded: [], notes: [] },
} : null
function hist(u, event, actor, text) {
  u.history = u.history || []
  u.history.push({ round: led ? led.round : null, event, actor, ...(text ? { text: String(text).slice(0, 300) } : {}) })
}
// The live issue an item is about: same_as / unknown, an alias, then the subject rule.
function findSame(raw) {
  const ref = String((raw && (raw.same_as || raw.unknown)) || '').trim().toUpperCase()
  if (/^U-\d+$/.test(ref)) {
    const hit = led.issues.find((u) => u.id === ref || (u.aliases || []).some((a) => a.id === ref))
    if (hit) return hit
  }
  const sj = subjectOf(raw)
  const probe = { subject: sj.subject, subject_explicit: sj.explicit, text: raw.text || raw.question || '' }
  return led.issues.find((u) => sameIssue(probe, u)) || null
}
// Raise an issue: folded into a live one (a raise against a settled subject is a note, never a
// reopen), or created with an owner and a status.
function raise(raw, source) {
  if (!raw || !(raw.text || raw.question)) return { issue: null }
  const text = String(raw.text || raw.question)
  const hit = findSame({ ...raw, text })
  if (hit) {
    if (FINALS.has(hit.status)) {
      hit.notes = hit.notes || []
      hit.notes.push({ round: led.round, actor: source, text: `raised again (not reopened): ${text.slice(0, 200)}` })
      led.raised.notes.push({ issue: hit.id, source, text: text.slice(0, 200) })
    } else if (text !== hit.text) led.raised.folded.push({ issue: hit.id, source, text: text.slice(0, 200) })
    return { issue: hit, folded: true, settled: FINALS.has(hit.status) }
  }
  const kind = KINDS.includes(raw.kind) ? raw.kind : KINDS.includes(raw.category) ? raw.category : 'user'
  const owner = classify(raw, kind)
  const sj = subjectOf({ ...raw, text })
  led.ids.U += 1
  const u = {
    id: `U-${led.ids.U}`, subject: sj.subject, subject_explicit: sj.explicit, text, kind,
    impact: ['high', 'medium', 'low'].includes(raw.impact) ? raw.impact : 'high',
    owner,
    status: owner === 'design' ? 'deferred_to_design' : 'proposed',
    settled_by: owner === 'design' ? 'design_deferral' : null,
    draft: String(raw.draft || text),
    ...(Array.isArray(raw.options) && raw.options.length ? { options: raw.options.slice(0, 5) } : {}),
    default: raw.default && !isNone(raw.default) ? String(raw.default) : null,
    reason: raw.reason ? String(raw.reason) : null,
    ...(raw.why ? { why: String(raw.why) } : {}),
    question_id: null, answer: null, note: null,
    aliases: [], notes: [], history: [], applied_round: null,
    source, round: led.round,
  }
  hist(u, owner === 'design' ? 'deferred_to_design' : 'opened', source, owner === 'design' ? 'implementation detail: settled in ground/decide' : null)
  led.issues.push(u)
  led.raised.created.push({ issue: u.id, source })
  return { issue: u, created: true }
}
// The ledger's open proposals nobody has asked yet.
function openQuestions() {
  return led.issues.filter((u) => u.status === 'proposed' && u.owner === 'user' && !u.question_id && u.impact !== 'low').map((u) => ({
    unknown: u.id, subject: u.subject, kind: u.kind, ask: u.draft || u.text, ...(u.options ? { options: u.options } : {}), default: u.default || null, why: u.why || u.reason || null,
  }))
}
// What the analysts, the judge and God Eye are given: the ledger and what changed.
function ledgerView() {
  const brief1 = (u) => ({ id: u.id, subject: u.subject, text: String(u.text).slice(0, 200), kind: u.kind, owner: u.owner, status: u.status, ...(u.question_id ? { question: u.question_id } : {}), ...(u.answer ? { answer: String(u.answer).slice(0, 200) } : {}), ...(u.settled_by ? { settled_by: u.settled_by } : {}), ...((u.aliases || []).length ? { also_raised_as: u.aliases.map((a) => a.id) } : {}) })
  return {
    rules: 'The issue ledger is the single list of what is open. Never re-raise a settled issue (use same_as with its id; a raise against a settled subject is only noted). Ask only about the open issues; raise a new one only when no listed issue covers it, with same_as "new" and a short subject key. Implementation detail (exact API field names, source line ranges, command syntax, parser behaviour) is design\'s: owner "design", never a question for the user.',
    settled_do_not_reraise: led.issues.filter((u) => u.status === 'settled' || u.status === 'dropped').map(brief1),
    open_the_only_things_to_ask_about: led.issues.filter((u) => !FINALS.has(u.status)).map(brief1),
    deferred_to_design_not_yours: led.issues.filter((u) => u.status === 'deferred_to_design').map(brief1),
    new_since_last_round: LG.new_since || {},
    contract_sections_changed: LG.changed_sections === undefined ? null : LG.changed_sections,
    contract_sections_settled: LG.settled_sections || [],
  }
}
// Judge questions go through the ledger: a question about a settled, dropped or deferred issue
// is not asked (noted), one already asked waits for its answer, a new one becomes an issue (an
// implementation detail is deferred to design, not asked).
function groundQuestions(list) {
  const keep = []
  for (const q of list || []) {
    if (!q || !q.question) continue
    const r = raise({ ...q, text: q.question, kind: q.kind || q.category, impact: q.impact || 'high', draft: q.question }, 'judge')
    const u = r.issue
    if (!u || FINALS.has(u.status) || u.question_id) continue
    keep.push({ ...q, unknown: u.id, kind: u.kind, subject: u.subject })
  }
  return keep
}
// The ledger's own proposals are asked even if the judge left them out (over budget or held
// back earlier, God Eye's blockers, the editor's skipped changes), with their default.
function ledgerAsks(questions, dismissed) {
  const covered = new Set([...(questions || []).map((q) => String(q.unknown || '').toUpperCase()), ...(dismissed || []).map((x) => String(x.unknown || x.same_as || '').toUpperCase())])
  const cat = (k) => (['intent', 'scope', 'constraint', 'acceptance'].includes(k) ? k : 'scope')
  return openQuestions().filter((q) => !covered.has(q.unknown)).map((q) => ({
    question: q.ask, category: cat(q.kind), why: q.why || 'Only you can settle it.', default: q.default || 'None: answer needed', unknown: q.unknown, kind: q.kind, subject: q.subject, ...(q.options ? { options: q.options } : {}),
  }))
}

// ---- clarify: the contract editor (one writer: it returns the text, the CLI writes it) ----
let revised = null
const edits = []
async function editContract(todo, label) {
  if (!brief.editor || !todo.length) return null
  const r = await one(`${brief.editor.prompt}\n\nCHANGES TO APPLY:\n${JSON.stringify(todo, null, 2)}${revised ? `\n\nCURRENT CONTRACT (revised earlier this round; edit this text, not the file):\n----- BEGIN CONTRACT -----\n${revised}\n----- END CONTRACT -----` : ''}`, brief.editor, `contract editor · ${label}`)
  if (!r || typeof r.contract !== 'string' || !r.contract.trim()) { edits.push({ label, ok: false }); return null }
  revised = r.contract
  // requested: what the editor was given (the CLI accepts a removal only for a settled issue or a
  // God Eye item, note or denial it was given); removed: what it took out, and why
  edits.push({ label, ok: true, applied: r.applied || [], skipped: r.skipped || [], removed: r.removed || [], requested: todo.map((t) => ({ from: t.from, ref: t.ref || null })) })
  for (const sk of r.skipped || []) if (led && sk && sk.question) raise({ text: sk.question, kind: 'scope', owner: 'user', impact: 'high', default: sk.default || null, reason: sk.reason || null }, 'contract-editor')
  return r
}
const revisedBlock = () => (revised ? `\n\nREVISED CONTRACT (this round's revision of the contract file; the CLI writes it when it records the round, so read this text instead of the file):\n----- BEGIN CONTRACT -----\n${revised}\n----- END CONTRACT -----` : '')
function ctxBlock() {
  if (brief.config !== 'clarify') return ''
  return `${led ? `\n\nCLARIFY LEDGER:\n${JSON.stringify(ledgerView(), null, 2)}` : ''}${revisedBlock()}`
}
if (brief.config === 'clarify' && brief.editor && (brief.editor.todo || []).length) {
  phase('clarify: contract editor (apply what was settled)')
  await editContract(brief.editor.todo, 'apply what was settled')
}

// ---- 1. fan-out (clarify: the intent gate runs first and alone; a later round with nothing
// changed and nothing new skips the analysts and the judge: the ledger's proposals are asked)
const quiet = Boolean(led && LG.nothing_new === true && !revised)
const gate = brief.config === 'clarify' && !quiet ? brief.fanout.filter((f) => f.gate || f.category === 'intent') : []
const rest = quiet ? [] : brief.fanout.filter((f) => !gate.includes(f))
const outs = brief.fanout.map(() => null)
const put = (list, res) => list.forEach((f, i) => { outs[brief.fanout.indexOf(f)] = res[i] || null })
if (quiet) log('Nothing changed since the last round and nothing new came in: the analysts and the judge are skipped; the ledger\'s open questions are asked.')
if (gate.length) {
  phase(`clarify: intent gate (${gate.length})`)
  put(gate, await fan(gate))
}
const intentOpen = gate.some((f) => { const o = outs[brief.fanout.indexOf(f)]; return Boolean(o && (o.questions || []).some((q) => q.blocking)) })
async function fanRest() {
  if (!rest.length) return
  phase(`${brief.config}: fan-out (${rest.length})`)
  put(rest, await fan(rest))
}
if (!intentOpen) await fanRest()
else log(`Intent is not clear yet: holding back ${rest.map((f) => f.id).join(', ')}`)
const inputsNow = () => brief.fanout.map((f, i) => ({ id: f.id, ...(f.category ? { category: f.category } : {}), output: outs[i] })).filter((x) => x.output)
const degradedNow = (held) => brief.fanout.filter((f, i) => !outs[i] && !held.includes(f) && !(quiet && brief.config === 'clarify')).map((f) => f.id)

// ---- clarify question protocol (factory record re-applies it): intent first and alone,
// then scope > constraint > acceptance; never re-ask; one question per issue; at most
// limits.max_questions.
const PRI = (brief.limits && brief.limits.priority) || ['intent', 'scope', 'constraint', 'acceptance']
function shape(list) {
  const key = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  const seen = new Set((brief.asked || []).map(key))
  const seenU = new Set()
  const dropped = []
  const ok = []
  for (const q of list || []) {
    if (!q || !q.question) continue
    if (seen.has(key(q.question))) { dropped.push({ question: q.question, reason: 'already asked' }); continue }
    if (q.unknown && seenU.has(q.unknown)) { dropped.push({ question: q.question, reason: `same issue as another question (${q.unknown})` }); continue }
    seen.add(key(q.question))
    if (q.unknown) seenU.add(q.unknown)
    ok.push({ ...q, category: PRI.includes(q.category) ? q.category : 'scope' })
  }
  const open = ok.some((q) => q.category === 'intent')
  const held = open ? ok.filter((q) => q.category !== 'intent') : []
  const pick = (open ? ok.filter((q) => q.category === 'intent') : ok).map((q, i) => ({ q, i })).sort((a, b) => PRI.indexOf(a.q.category) - PRI.indexOf(b.q.category) || a.i - b.i).map((x) => x.q)
  const max = brief.limits && typeof brief.limits.max_questions === 'number' ? brief.limits.max_questions : pick.length
  pick.slice(max).forEach((q) => dropped.push({ question: q.question, reason: 'over budget' }))
  return { questions: pick.slice(0, max), held, dropped, intent_open: open }
}

// God Eye's verdict through the checklist: every item points at an AC, a section or an issue.
// About a settled issue or a duplicate subject → a note; a pointed blocker or major →
// actionable (the contract editor revises, God Eye looks once more); what stays a blocker
// becomes a user issue whose default is God Eye's suggestion; the rest are notes
// (approve-with-notes). A round never ends needs_user with nothing to answer.
const notes = []
function triage(c) {
  const actionable = []
  if (!c) return { actionable, approved: false }
  const approved = c.verdict === 'approve' && c.intent_confirmed !== false
  if (c.intent_confirmed === false) {
    const r = c.restatement || {}
    actionable.push({ ref: 'Intent', severity: 'blocker', issue: `God Eye could not confirm the intent from the contract; it reads it as: ${[r.problem, r.outcome].filter(Boolean).join(' → ')}`, suggestion: `Align the Intent and Goal with: problem "${r.problem || ''}", who "${r.who || ''}", outcome "${r.outcome || ''}", success "${r.success || ''}"`, subject: 'intent.restatement', kind: 'intent' })
  }
  for (const it of c.items || []) {
    if (!it || !it.issue) continue
    const ref = String(it.ref || '').trim()
    const refU = led && /^U-\d+$/i.test(ref) ? led.issues.find((u) => u.id === ref.toUpperCase() || (u.aliases || []).some((a) => a.id === ref.toUpperCase())) : null
    const same = led && (it.same_as || it.subject) ? findSame({ text: it.issue, same_as: it.same_as, subject: it.subject }) : null
    const known = refU || (same && FINALS.has(same.status) ? same : null)
    if (known && FINALS.has(known.status)) { notes.push({ ref: known.id, severity: it.severity, text: `already settled (${known.status}${known.settled_by ? `: ${known.settled_by}` : ''}): ${it.issue}` }); continue }
    if (refU) { notes.push({ ref: refU.id, severity: it.severity, text: `tracked as ${refU.id}: ${it.issue}` }); continue }
    if (ref && ['blocker', 'major'].includes(it.severity)) actionable.push({ ...it, ref })
    else notes.push({ ref: ref || null, severity: it.severity, text: it.issue })
  }
  return { actionable, approved }
}
const kindOfRef = (ref) => (/^(E-)?AC-\d+/i.test(ref) || /acceptance/i.test(ref) ? 'acceptance' : /intent|goal/i.test(ref) ? 'intent' : /non-goal|scope|allowed/i.test(ref) ? 'scope' : 'constraint')

// ---- 2. config-specific ----
if (brief.config === 'clarify') {
  const judgeOnce = (note) => one(`${brief.judge.prompt}${note}${ctxBlock()}\n\nINPUTS:\n${JSON.stringify(inputsNow(), null, 2)}`, brief.judge, 'judge')
  let judge = { questions: [], dismissed: [], held: [] }
  let held = intentOpen ? rest : []
  if (!quiet) {
    phase('clarify: judge')
    judge = await judgeOnce(intentOpen ? '\n\nINTENT GATE: the intent is not clear yet, so the other angles were held back. Ask only intent questions this round.' : '')
    if (judge && intentOpen && !shape(judge.questions).intent_open) {
      // the judge found the intent clear after all: run the held angles and judge again
      held = []
      await fanRest()
      phase('clarify: judge (all angles)')
      judge = await judgeOnce('')
    }
    if (judge && led) judge = { ...judge, questions: groundQuestions(judge.questions) }
  }
  const degraded = degradedNow(held)
  const inputs = inputsNow()
  if (degraded.length) log(`No result after retry: ${degraded.join(', ')}`)
  if (!judge) return envelope('error', 'The judge returned nothing twice.', { analysts: inputs, degraded })
  const withLedger = (j) => (led ? [...(j.questions || []), ...ledgerAsks(j.questions, j.dismissed)] : j.questions || [])
  let shaped = shape(withLedger(judge))
  let critique = null
  let critiques = 0
  if (shaped.questions.length === 0 && !shaped.intent_open && (degraded.length === 0 || brief.accept_degraded)) {
    const godEye = async (label, extra = '') => {
      if (!label) phase('clarify: God Eye (intent)')
      else phase(`clarify: God Eye (intent, ${label})`)
      const c = await one(`${brief.critique.prompt}${ctxBlock()}${extra}`, brief.critique, `god-eye · intent${label ? ` (${label})` : ''}`)
      if (c) critiques += 1
      return c
    }
    critique = await godEye('')
    let t = triage(critique)
    if (critique && !t.approved && t.actionable.length && brief.editor) {
      phase(`clarify: contract editor (God Eye's items)`)
      const r = await editContract(t.actionable.map((a) => ({ from: 'god-eye', ref: a.ref, severity: a.severity, issue: a.issue, suggestion: a.suggestion || null })), 'God Eye\'s items')
      if (r) {
        const again = await godEye('after the revision', '\n\nREVISION: the contract was revised for your items (REVISED CONTRACT above). Judge the revised text; list only what is still wrong.')
        if (again) { critique = again; t = triage(again) }
      }
    }
    // What is still an actionable blocker becomes ONE user question each, with God Eye's
    // suggestion as the default (one word to accept); majors and the rest are notes.
    if (critique && !t.approved && led) {
      for (const a of t.actionable) {
        if (a.severity !== 'blocker') { notes.push({ ref: a.ref, severity: a.severity, text: a.issue }); continue }
        const r = raise({ text: a.issue, kind: a.kind || kindOfRef(a.ref), owner: 'user', impact: 'high', draft: a.kind === 'intent' ? `${a.issue}. Is that the intent?` : a.issue, default: a.kind === 'intent' ? null : a.suggestion || null, reason: `God Eye (${a.ref})`, subject: a.subject, same_as: a.same_as }, 'god-eye')
        if (r.settled) notes.push({ ref: r.issue.id, severity: a.severity, text: `already settled: ${a.issue}` })
      }
    }
    // Without a ledger (an older brief) the blockers are asked directly.
    const direct = critique && !t.approved && !led ? t.actionable.filter((a) => a.severity === 'blocker').map((a) => ({ question: a.kind === 'intent' ? `${a.issue}. Is that the intent?` : `${a.issue}: ${a.suggestion || 'how should the contract say it'}?`, category: a.kind || kindOfRef(a.ref), why: `God Eye (${a.ref})`, default: a.kind === 'intent' ? 'None: the factory will not guess the intent' : a.suggestion || 'None: answer needed' })) : []
    // God Eye's blockers are questions now
    if (critique) shaped = shape([...withLedger(judge), ...direct])
  }
  const approved = Boolean(critique && critique.verdict === 'approve' && critique.intent_confirmed !== false)
  const withNotes = Boolean(critique && !approved && !shaped.questions.length)
  const status = degraded.length && !brief.accept_degraded ? 'degraded' : shaped.questions.length ? 'needs_user' : critique ? 'ok' : 'needs_user'
  const summary = degraded.length
    ? `Missing angle(s): ${degraded.join(', ')}.`
    : shaped.questions.length
      ? `${shaped.questions.length} ${shaped.intent_open ? 'intent ' : ''}question(s) for you.${held.length ? ` Held until intent is clear: ${held.map((f) => f.id).join(', ')}.` : ''}`
      : critique ? `God Eye: ${approved ? 'approve' : withNotes ? `approve with notes (${notes.length})` : critique.verdict}.` : 'No critique.'
  const ledgerNote = led ? ` Ledger: ${led.issues.length} issue(s), ${led.issues.filter((u) => FINALS.has(u.status)).length} closed, ${led.raised.created.length} new, ${led.raised.folded.length + led.raised.notes.length} raised again and folded.` : ''
  const contract = revised ? { text: revised, edits } : edits.length ? { text: null, edits } : null
  return envelope(status, `${summary}${ledgerNote}`, { analysts: inputs, degraded, quiet, intent_open: shaped.intent_open || (intentOpen && held.length > 0), held_back: held.map((f) => f.id), judge: { ...judge, questions: shaped.questions, held: [...(judge.held || []), ...shaped.held.map((q) => ({ question: q.question, category: q.category }))], over_budget_or_repeat: shaped.dropped }, critique, critiques, approved_with_notes: withNotes, notes, ...(contract ? { contract } : {}), ...(led ? { ledger: { issues: led.issues, raised: led.raised, open: openQuestions() } } : {}) }, { questions: shaped.questions })
}

const degraded = degradedNow([])
const inputs = inputsNow()
if (degraded.length) log(`No result after retry: ${degraded.join(', ')}`)

if (brief.config === 'decide') {
  phase('decide: architect')
  let design = await one(`${brief.judge.prompt}\n\nINPUTS:\n${JSON.stringify(inputs, null, 2)}`, brief.judge, 'architect')
  if (!design) return envelope('error', 'The architect returned nothing twice.', { options: inputs, degraded })
  const critiques = []
  const max = Math.max(1, brief.critique.max_rounds || 2)
  for (let round = 1; round <= max; round++) {
    phase(`decide: God Eye (design) round ${round}`)
    const c = await one(`${brief.critique.prompt}\n\nINPUTS:\n${JSON.stringify({ design }, null, 2)}`, brief.critique, `god-eye · design #${round}`)
    if (!c) break
    critiques.push(c)
    if (c.verdict === 'approve' || round === max) break
    phase(`decide: architect revises (round ${round})`)
    const revised = await one(`${brief.critique.revise.prompt}\n\nINPUTS:\n${JSON.stringify({ critique: c, your_previous_output: design }, null, 2)}`, brief.critique.revise, `architect · revise #${round}`)
    if (revised) design = revised
  }
  const last = critiques[critiques.length - 1]
  return envelope('ok', `Design: ${design.kind} (${design.paths.join(', ')}). Critique: ${last ? last.verdict : 'none'} after ${critiques.length} round(s).`, { options: inputs, degraded, judge: design, critiques }, { threat_model: Boolean(brief.threat_model) })
}

if (brief.config === 'challenge') {
  const lanes = inputs.map((x) => ({ lane: x.id, findings: x.output.findings || [] }))
  const serious = lanes.flatMap((l) => l.findings.filter((f) => (brief.verifier.severities || ['blocker', 'major']).includes(f.severity)).map((f) => ({ ...f, lane: l.lane })))
  let verifications = []
  if (serious.length) {
    phase(`challenge: verify ${serious.length} finding(s)`)
    const items = serious.map((f) => ({
      prompt: brief.verifier.prompt_template.replace('{{finding}}', JSON.stringify(f, null, 2)),
      schema: brief.verifier.schema,
      agent_type: brief.verifier.agent_type,
      model: brief.verifier.model,
      label: `verify ${f.id}`,
    }))
    const res = await fan(items)
    verifications = res.map((r, i) => (r ? { ...r, finding_id: serious[i].id } : null)).filter(Boolean)
  }
  const confirmed = verifications.filter((v) => v.status === 'confirmed').length
  const unsure = verifications.filter((v) => v.status === 'unverifiable').length
  const summary = `${lanes.length}/${brief.fanout.length} lane(s) reviewed; ${serious.length} serious finding(s), ${confirmed} confirmed${unsure ? `, ${unsure} unverifiable (still blocking)` : ''}.${degraded.length ? ` Missing lanes: ${degraded.join(', ')}.` : ''}`
  return envelope(degraded.length ? 'degraded' : 'ok', summary, { lanes, degraded, verifications }, { fingerprint: brief.fingerprint || null, lanes_requested: brief.lanes_requested || null })
}

throw new Error(`Unknown config ${brief.config}`)
