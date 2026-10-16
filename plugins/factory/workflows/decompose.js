export const meta = {
  name: 'decompose',
  description: 'Software Factory: split an approved design into task contracts (plan.json) or an epic into slices (slices.json); the planner validates with the CLI, up to the round budget. With the plan probe on, this run is one phase: the planner (factory record then runs the CLI\'s plan probe), or God Eye\'s plan critique with the probe\'s record as evidence; otherwise the planner and an optional cold plan critique. Pass the JSON brief from `factory wfargs decompose` as args.',
}

const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'decompose') throw new Error('decompose needs the JSON brief from `factory wfargs decompose` as its args')
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
async function plannerRound(extra, label) {
  runs += 1
  // brief.planner.model: the loop engine escalated the plan's loop (no progress) to a stronger model
  return (await call(`${brief.planner.prompt}${extra ? `\n\n${extra}` : ''}`, opts(brief.planner, label))) || null
}

let result = null
let errors = []
let critique = null
const max = Math.max(1, brief.planner.max_rounds || 3)
if (brief.phase !== 'critique') {
  for (let round = 1; round <= max; round++) {
    phase(`decompose: ${brief.mode} round ${round}`)
    result = await plannerRound(errors.length ? `The validator reported these errors last round; fix all of them:\n- ${errors.join('\n- ')}` : '', `${brief.mode === 'slices' ? 'slicer' : 'planner'} #${round}`)
    if (result && result.valid) break
    errors = result ? result.errors : ['The planner returned nothing.']
  }
  // the plan probe off (or slices): the cold plan critique runs here, as before
  if (result && result.valid && brief.critique && brief.phase !== 'plan') {
    for (let round = 1; round <= (brief.critique.max_rounds || 2); round++) {
      phase(`decompose: God Eye (plan) round ${round}`)
      runs += 1
      critique = (await call(brief.critique.prompt, opts(brief.critique, `god-eye · plan #${round}`))) || null
      if (!critique || critique.verdict === 'approve' || round === (brief.critique.max_rounds || 2)) break
      const revised = await plannerRound(`God Eye asked for revisions; address every item, keep the plan valid:\n${JSON.stringify(critique.items, null, 2)}`, `planner · revise #${round}`)
      if (!revised || !revised.valid) { result = revised || result; break }
      result = revised
    }
  }
} else {
  // 0.10.0, plan probe on: the plan is valid and the CLI probed it (factory record ran the probe):
  // God Eye critiques it once with the probe's record as evidence; factory record sends its items
  // back to the planner while they shrink (cli/core/loop.js) and goes to the gate otherwise.
  phase('decompose: God Eye (plan, with the probe)')
  runs += 1
  critique = (await call(brief.critique.prompt, opts(brief.critique, 'god-eye · plan'))) || null
  result = { valid: true, errors: [], path: brief.plan_path, summary: 'the plan as probed' }
}

const valid = Boolean(result && result.valid)
return {
  workflow: 'decompose',
  config: null,
  mode: brief.mode,
  job: brief.job,
  status: valid ? 'ok' : 'needs_user',
  next_gate: null,
  input_hash: brief.input_hash,
  agents: roster,
  budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
  artifacts: result && result.path ? [result.path] : [],
  questions: [],
  park_reason: null,
  summary: valid ? `Valid ${brief.mode}${brief.phase === 'plan' ? '; factory record runs the plan probe next' : ''}${critique ? `; plan critique: ${critique.verdict}` : ''}.` : `Still invalid after ${max} round(s): ${(result && result.errors || errors).slice(0, 3).join('; ')}`,
  data: { planner: result, critique, ...(brief.phase ? { phase: brief.phase } : {}) },
}
