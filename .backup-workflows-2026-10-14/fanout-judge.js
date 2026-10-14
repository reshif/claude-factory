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

let runs = 0
async function one(prompt, schema, label) {
  runs += 1
  let r = await agent(prompt, { schema, label })
  if (!r) {
    runs += 1
    r = await agent(prompt, { schema, label: `${label} (retry)` })
  }
  return r || null
}
async function fan(items) {
  if (!items.length) return []
  runs += items.length
  const first = await pipeline(items, (it) => agent(it.prompt, { schema: it.schema, label: it.label }))
  const out = first.slice()
  const failed = items.map((it, i) => (out[i] ? null : i)).filter((i) => i !== null)
  if (failed.length) {
    runs += failed.length
    const again = await pipeline(failed.map((i) => items[i]), (it) => agent(it.prompt, { schema: it.schema, label: `${it.label} (retry)` }))
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
phase(`${brief.config}: fan-out (${brief.fanout.length})`)
const outs = await fan(brief.fanout)
const degraded = brief.fanout.filter((_, i) => !outs[i]).map((f) => f.id)
const inputs = brief.fanout.map((f, i) => ({ id: f.id, output: outs[i] })).filter((x) => x.output)
if (degraded.length) log(`No result after retry: ${degraded.join(', ')}`)

// ---- 2. config-specific ----
if (brief.config === 'clarify') {
  phase('clarify: judge')
  const judge = await one(`${brief.judge.prompt}\n\nINPUTS:\n${JSON.stringify(inputs, null, 2)}`, brief.judge.schema, 'judge')
  if (!judge) return envelope('error', 'The judge returned nothing twice.', { analysts: inputs, degraded })
  let critique = null
  if (judge.questions.length === 0 && (degraded.length === 0 || brief.accept_degraded)) {
    phase('clarify: God Eye (intent)')
    critique = await one(brief.critique.prompt, brief.critique.schema, 'god-eye · intent')
  }
  const status = degraded.length && !brief.accept_degraded ? 'degraded' : judge.questions.length ? 'needs_user' : critique && critique.verdict === 'approve' ? 'ok' : 'needs_user'
  const summary = degraded.length
    ? `Missing angle(s): ${degraded.join(', ')}.`
    : judge.questions.length
      ? `${judge.questions.length} question(s) for you.`
      : critique ? `God Eye: ${critique.verdict}.` : 'No critique.'
  return envelope(status, summary, { analysts: inputs, degraded, judge, critique }, { questions: judge.questions })
}

if (brief.config === 'decide') {
  phase('decide: architect')
  let design = await one(`${brief.judge.prompt}\n\nINPUTS:\n${JSON.stringify(inputs, null, 2)}`, brief.judge.schema, 'architect')
  if (!design) return envelope('error', 'The architect returned nothing twice.', { options: inputs, degraded })
  const critiques = []
  const max = Math.max(1, brief.critique.max_rounds || 2)
  for (let round = 1; round <= max; round++) {
    phase(`decide: God Eye (design) round ${round}`)
    const c = await one(`${brief.critique.prompt}\n\nINPUTS:\n${JSON.stringify({ design }, null, 2)}`, brief.critique.schema, `god-eye · design #${round}`)
    if (!c) break
    critiques.push(c)
    if (c.verdict === 'approve' || round === max) break
    phase(`decide: architect revises (round ${round})`)
    const revised = await one(`${brief.critique.revise.prompt}\n\nINPUTS:\n${JSON.stringify({ critique: c, your_previous_output: design }, null, 2)}`, brief.critique.revise.schema, `architect · revise #${round}`)
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
      label: `verify ${f.id}`,
    }))
    const res = await fan(items)
    verifications = res.map((r, i) => (r ? { ...r, finding_id: serious[i].id } : null)).filter(Boolean)
  }
  const confirmed = verifications.filter((v) => v.status === 'confirmed').length
  const summary = `${lanes.length}/${brief.fanout.length} lane(s) reviewed; ${serious.length} serious finding(s), ${confirmed} confirmed.${degraded.length ? ` Missing lanes: ${degraded.join(', ')}.` : ''}`
  return envelope(degraded.length ? 'degraded' : 'ok', summary, { lanes, degraded, verifications }, { fingerprint: brief.fingerprint || null, lanes_requested: brief.lanes_requested || null })
}

throw new Error(`Unknown config ${brief.config}`)
