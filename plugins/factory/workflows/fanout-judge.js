export const meta = {
  name: 'fanout-judge',
  description: 'Software Factory engine for decide and challenge: N independent agents in parallel, retry once, a judge merges, an optional cold critique, and per-finding verifiers. Pass the JSON brief from `factory wfargs fanout-judge --config <decide|challenge>` as args. (Clarify runs as its own workflow, factory:clarify.)',
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
  // Findings an earlier round left unverified are re-verified every round until settled (a
  // verifier that returns nothing is retried once, like every fanned-out agent). Claude Code's
  // Workflow tool sets no agent time cap, so there is no cap to scale for them.
  const carried = brief.carried || []
  let verifications = []
  if (serious.length || carried.length) {
    phase(`challenge: verify ${serious.length} finding(s)${carried.length ? ` + ${carried.length} carried` : ''}`)
    const item = (f, label) => ({
      prompt: brief.verifier.prompt_template.replace('{{finding}}', JSON.stringify(f, null, 2)),
      schema: brief.verifier.schema,
      agent_type: brief.verifier.agent_type,
      model: brief.verifier.model,
      label,
    })
    const items = [...serious.map((f) => item(f, `verify ${f.id}`)), ...carried.map((f) => item(f, `verify ${f.id} (carried from round ${f.from_round})`))]
    const res = await fan(items)
    verifications = res.map((r, i) => (r ? (i < serious.length ? { ...r, finding_id: serious[i].id } : { ...r, finding_id: carried[i - serious.length].id, carried: true }) : null)).filter(Boolean)
  }
  const confirmed = verifications.filter((v) => v.status === 'confirmed').length
  const unverifiable = verifications.filter((v) => v.status === 'unverifiable').length
  const summary = `${lanes.length}/${brief.fanout.length} lane(s) reviewed; ${serious.length} serious finding(s)${carried.length ? ` and ${carried.length} carried unverified` : ''}, ${confirmed} confirmed${unverifiable ? `, ${unverifiable} unverifiable (still blocking)` : ''}.${degraded.length ? ` Missing lanes: ${degraded.join(', ')}.` : ''}`
  return envelope(degraded.length ? 'degraded' : 'ok', summary, { lanes, degraded, verifications }, { fingerprint: brief.fingerprint || null, lanes_requested: brief.lanes_requested || null })
}

throw new Error(`Unknown config ${brief.config}`)
