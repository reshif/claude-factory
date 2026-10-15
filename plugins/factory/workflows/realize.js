export const meta = {
  name: 'realize',
  description: 'Software Factory: build tasks wave by wave, each in its own git worktree — builder, then `task verify` (relayed by the tester; the CLI\'s exit code and evidence decide), retried up to each task\'s limit with the previous attempt as input; a blocked or exhausted task skips only its dependents. Pass the JSON brief from `factory wfargs realize` as args.',
}

const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'realize') throw new Error('realize needs the JSON brief from `factory wfargs realize` as its args')
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

// Attempt 1 uses the builder's model; later attempts step through the escalation list.
function builderModel(spec, attempt) {
  const up = (spec && spec.escalate) || []
  if (attempt <= 1 || !up.length) return null
  return up[Math.min(attempt - 2, up.length - 1)]
}

let runs = 0
const checks = []
const T = brief.tasks
const st = {}
// attempts counts this run's attempts (the retry limit applies per run); attempt_base is what
// earlier runs used, so numbering and the failure history continue across realize runs.
for (const id of Object.keys(T)) st[id] = { outcome: 'pending', attempts: 0, failures: (T[id].previous_failures || []).slice(), swept: [], summary: '' }
const attemptNo = (id) => (T[id].attempt_base || 0) + st[id].attempts + 1
const BAD = ['blocked', 'exhausted', 'skipped_dependency']
const cap = Math.max(1, brief.max_parallel_tasks || 4)

function chunks(list, n) {
  const out = []
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n))
  return out
}
async function runAll(ids, make) {
  const results = {}
  for (const group of chunks(ids, cap)) {
    runs += group.length
    const res = await pipeline(group, (id) => make(id))
    group.forEach((id, i) => { results[id] = res[i] || null })
  }
  return results
}
function skipDependents() {
  let changed = true
  while (changed) {
    changed = false
    for (const id of Object.keys(T)) {
      if (st[id].outcome !== 'pending') continue
      const badDep = (T[id].depends_on || []).find((d) => st[d] && BAD.includes(st[d].outcome))
      if (badDep) {
        st[id].outcome = 'skipped_dependency'
        st[id].summary = `Skipped: depends on ${badDep} (${st[badDep].outcome})`
        changed = true
      }
    }
  }
}

// A broken build environment (a setup step or a service health check failed) is not a build
// failure: the run stops, no attempt is spent on it, and the job parks once with the reason.
let envBroken = null

// The tester only runs `task verify` and relays it (a workflow script cannot run a command);
// one that returns nothing is asked once more, since nothing was relayed.
async function relayVerify(ids) {
  const out = await runAll(ids, (id) => call(T[id].tester_prompt.replace('{{swept}}', () => st[id].swept.join(', ') || '(none listed)'), opts({ ...T[id].tester, schema: brief.tester_schema }, `test ${id}`)))
  const lost = ids.filter((id) => !out[id])
  if (lost.length) {
    const again = await runAll(lost, (id) => call(T[id].tester_prompt.replace('{{swept}}', () => st[id].swept.join(', ') || '(none listed)'), opts({ ...T[id].tester, schema: brief.tester_schema }, `test ${id} (retry)`)))
    for (const id of lost) out[id] = again[id]
  }
  return out
}

// Build, then verify, until every task in `ids` is settled (done, blocked or exhausted).
async function settle(ids) {
  let active = ids.filter((id) => st[id].outcome === 'pending')
  while (active.length && !envBroken) {
    const built = await runAll(active, (id) => {
      const s = st[id]
      const prompt = T[id].builder_prompt
        .replace('{{attempt}}', () => String(attemptNo(id)))
        .replace('{{failures}}', () => (s.failures.length ? s.failures.map((f) => `  - ${f}`).join('\n') : '  - (none)'))
      return call(prompt, opts({ ...T[id].builder, schema: brief.builder_schema }, `build ${id} #${attemptNo(id)}`, builderModel(T[id].builder, s.attempts + 1)))
    })
    const toVerify = []
    for (const id of active) {
      const b = built[id]
      const s = st[id]
      if (b && b.status === 'blocked' && b.blocked_reason === 'environment_broken') {
        // task start could not set the environment up: not this builder's failure
        if (!envBroken) envBroken = { task: id, reason: String(b.summary || 'environment broken').split('\n')[0] }
        continue
      }
      if (b && b.status === 'blocked') {
        s.outcome = 'blocked'
        // dependency_conflict is typed: the task's dependencies don't merge, a plan change
        // fixes it, and retrying the same merge would only fail again.
        s.summary = b.blocked_reason === 'dependency_conflict'
          ? `Blocked (dependency_conflict): ${b.summary || 'its dependencies do not merge'}`
          : `Blocked: needs ${(b.needs_paths || []).join(', ') || 'paths outside its scope'}. ${b.summary || ''}`
        continue
      }
      // A builder that returned nothing (crashed, stopped, no valid reply) built nothing this
      // attempt: verifying the branch would only re-check an older state. The attempt is spent.
      if (!b) {
        s.attempts += 1
        s.failures = [`Attempt ${attemptNo(id) - 1}: the builder returned no result (crashed, stopped or replied without the JSON); nothing was verified. What it left uncommitted becomes a \`wip:\` commit at your task start: continue from it.`]
        if (s.attempts >= (T[id].retry_limit || 3)) {
          s.outcome = 'exhausted'
          s.summary = `Exhausted after ${s.attempts} attempt(s): ${s.failures[0]}`
        }
        continue
      }
      s.swept = b.swept || []
      s.summary = b.summary || ''
      toVerify.push(id)
    }
    // `task verify` decides, by its exit code and the evidence it records; the tester relays it.
    const tested = await relayVerify(toVerify)
    for (const id of toVerify) {
      const s = st[id]
      s.attempts += 1
      const t = tested[id]
      checks.push({ task: id, attempt: attemptNo(id) - 1, pass: Boolean(t && t.pass), ...(t && t.evidence_id ? { evidence_id: t.evidence_id } : {}), ...(t && t.refused ? { refused: t.refused } : {}) })
      if (t && t.refused === 'environment_broken') {
        // not the builder's failure: the attempt is given back and the run stops
        s.attempts -= 1
        if (!envBroken) envBroken = { task: id, reason: String((t.failures || [])[0] || 'environment broken').split('\n')[0] }
        continue
      }
      if (t && t.pass) {
        s.outcome = 'done'
        continue
      }
      const why = !t ? ['the tester returned nothing twice, so task verify\'s result was not relayed (`task show` has it under history if it ran).'] : t.refused ? [`task verify refused (${t.refused}): ${(t.failures || []).join(' ')}`] : (t.failures || []).length ? t.failures : ['task verify did not pass.']
      s.failures = why.map((f) => `Attempt ${attemptNo(id) - 1}: ${f}`)
      if (s.attempts >= (T[id].retry_limit || 3)) {
        s.outcome = 'exhausted'
        s.summary = `Exhausted after ${s.attempts} attempt(s): ${s.failures.slice(0, 2).join('; ')}`
      }
    }
    active = active.filter((id) => st[id].outcome === 'pending')
  }
}

for (let w = 0; w < brief.waves.length && !envBroken; w++) {
  skipDependents()
  const active = brief.waves[w].filter((id) => st[id] && st[id].outcome === 'pending')
  if (!active.length) continue
  phase(`realize: wave ${w + 1}/${brief.waves.length} (${active.join(', ')})`)
  await settle(active)
}
skipDependents()

const tasks = Object.keys(T).map((id) => ({ id, outcome: st[id].outcome, attempts: st[id].attempts, summary: st[id].summary }))
const base = {
  workflow: 'realize',
  config: null,
  mode: brief.scope || null,
  job: brief.job,
  next_gate: null,
  input_hash: brief.input_hash,
  agents: roster,
  budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
  artifacts: [],
  questions: [],
}
if (envBroken) {
  return { ...base, status: 'park', park_reason: envBroken.reason, summary: `Stopped: ${envBroken.reason}`, data: { tasks, verifications: checks, environment_broken: envBroken } }
}
const notDone = tasks.filter((t) => t.outcome !== 'done')
return {
  ...base,
  status: notDone.length ? 'park' : 'ok',
  park_reason: notDone.length ? `Tasks not done: ${notDone.map((t) => `${t.id} (${t.outcome})`).join(', ')}` : null,
  summary: `${tasks.length - notDone.length}/${tasks.length} task(s) done.`,
  data: { tasks, verifications: checks },
}
