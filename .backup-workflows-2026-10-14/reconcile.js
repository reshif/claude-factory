export const meta = {
  name: 'reconcile',
  description: 'Software Factory: merge finished task branches into the job branch in dependency order via the CLI; textual conflicts inside the tasks\' scopes are resolved, behavioural ones aborted. Pass the JSON brief from `factory wfargs reconcile` as args.',
}

const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'reconcile') throw new Error('reconcile needs the JSON brief from `factory wfargs reconcile` as its args')
  return a
})()

let runs = 1
phase('reconcile: integrate task branches')
let r = await agent(brief.integrator.prompt, { schema: brief.integrator.schema, label: 'integrator' })
if (!r) {
  runs += 1
  r = await agent(brief.integrator.prompt, { schema: brief.integrator.schema, label: 'integrator (retry)' })
}
return {
  workflow: 'reconcile',
  config: null,
  mode: null,
  job: brief.job,
  status: !r ? 'error' : r.status === 'merged' ? 'ok' : 'park',
  next_gate: null,
  input_hash: brief.input_hash,
  budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
  artifacts: [],
  questions: [],
  park_reason: r && r.status !== 'merged' ? `${r.status}: ${r.summary}` : null,
  summary: r ? `${r.status}: ${r.summary}` : 'The integrator returned nothing twice.',
  data: { integrator: r },
}
