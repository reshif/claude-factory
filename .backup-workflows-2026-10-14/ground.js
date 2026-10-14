export const meta = {
  name: 'ground',
  description: 'Software Factory: establish cited facts before decisions — parallel research probes (codebase, interfaces, history, external) merged by the CLI into findings.md. Pass the JSON brief from `factory wfargs ground` as args.',
}

const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'ground') throw new Error('ground needs the JSON brief from `factory wfargs ground` as its args')
  return a
})()

let runs = brief.probes.length
phase(`ground: ${brief.probes.length} probe(s)`)
const first = await pipeline(brief.probes, (p) => agent(p.prompt, { schema: p.schema, label: p.label }))
const out = first.slice()
const failed = brief.probes.map((p, i) => (out[i] ? null : i)).filter((i) => i !== null)
if (failed.length) {
  runs += failed.length
  const again = await pipeline(failed.map((i) => brief.probes[i]), (p) => agent(p.prompt, { schema: p.schema, label: `${p.label} (retry)` }))
  failed.forEach((idx, k) => { out[idx] = again[k] || null })
}
const degraded = brief.probes.filter((_, i) => !out[i]).map((p) => p.id)
const topics = out.filter(Boolean)
const blocking = topics.flatMap((t) => t.unknowns.filter((u) => u.blocking).map((u) => u.question))
const claims = topics.reduce((n, t) => n + t.claims.length, 0)

return {
  workflow: 'ground',
  config: null,
  mode: brief.mode || null,
  job: brief.job,
  status: topics.length === 0 ? 'error' : blocking.length ? 'needs_user' : degraded.length ? 'degraded' : 'ok',
  next_gate: null,
  input_hash: brief.input_hash,
  budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
  artifacts: [],
  questions: blocking.map((q) => ({ question: q, why: 'Blocks the design' })),
  park_reason: null,
  summary: `${topics.length} topic(s), ${claims} claim(s), ${blocking.length} blocking unknown(s)${degraded.length ? `; no result for ${degraded.join(', ')}` : ''}.`,
  data: { topics, degraded },
}
