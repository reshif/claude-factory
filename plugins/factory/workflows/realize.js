export const meta = {
  name: 'realize',
  description: 'Software Factory: build tasks by dependency, each in its own git worktree — a task starts as soon as its dependencies are integrated (up to max_parallel_tasks at a time); builder, then `task verify` (relayed by the tester; the CLI\'s exit code and evidence decide), retried up to each task\'s limit with the previous attempt as input; done tasks are integrated into the job branch as they finish and checked by the CLI (relayed by the integrator), and no attempt starts while an integration runs or a broken one is repaired; a blocked or exhausted task skips only its dependents. Pass the JSON brief from `factory wfargs realize` as args.',
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

// Attempts before escalate_from use the builder's model; from it on, attempts step through
// the escalation list (a brief without escalate_from escalates from attempt 2, as before). The
// attempt is the task's global number (attempt_base + this run's), so escalation holds across runs.
function builderModel(spec, attempt) {
  const up = (spec && spec.escalate) || []
  const from = spec && Number.isInteger(spec.escalate_from) && spec.escalate_from >= 2 ? spec.escalate_from : 2
  if (attempt < from || !up.length) return null
  return up[Math.min(attempt - from, up.length - 1)]
}

let runs = 0
const checks = []
const rebuilds = []
const T = brief.tasks
const st = {}
// attempts counts this run's attempts (the retry limit applies per run); attempt_base is what
// earlier runs used, so numbering and the failure history continue across realize runs.
for (const id of Object.keys(T)) st[id] = { outcome: 'pending', attempts: 0, failures: (T[id].previous_failures || []).slice(), swept: [], summary: '' }
const attemptNo = (id) => (T[id].attempt_base || 0) + st[id].attempts + 1
const BAD = ['blocked', 'exhausted', 'skipped_dependency']
const cap = Math.max(1, brief.max_parallel_tasks || 4)
const running = new Map()

function skipDependents() {
  let changed = true
  while (changed) {
    changed = false
    for (const id of Object.keys(T)) {
      if (st[id].outcome !== 'pending' || running.has(id)) continue // a running task settles itself
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
async function relayVerify(id) {
  const ask = (label) => call(T[id].tester_prompt.replace('{{swept}}', () => st[id].swept.join(', ') || '(none listed)'), opts({ ...T[id].tester, schema: brief.tester_schema }, label))
  runs += 1
  let t = await ask(`test ${id}`)
  if (!t) {
    runs += 1
    t = await ask(`test ${id} (retry)`)
  }
  return t
}

// One attempt of one task: its builder, then `task verify` (relayed by the tester; the CLI's
// exit code and evidence decide). Settles the task (done, blocked, exhausted) or leaves it
// pending for its next attempt.
async function attempt(id) {
  const s = st[id]
  runs += 1
  const prompt = T[id].builder_prompt
    .replace('{{attempt}}', () => String(attemptNo(id)))
    .replace('{{failures}}', () => (s.failures.length ? s.failures.map((f) => `  - ${f}`).join('\n') : '  - (none)'))
  const b = await call(prompt, opts({ ...T[id].builder, schema: brief.builder_schema }, `build ${id} #${attemptNo(id)}`, builderModel(T[id].builder, attemptNo(id))))
  if (b && b.status === 'blocked' && b.blocked_reason === 'environment_broken') {
    // task start could not set the environment up: not this builder's failure
    if (!envBroken) envBroken = { task: id, reason: String(b.summary || 'environment broken').split('\n')[0] }
    return
  }
  // dependency_conflict, the first time: task start could not merge into the task's branch. Its
  // next start restarts the branch from the integrated job branch (which holds every integrated
  // dependency), so it is rebuilt there once, without spending an attempt, before it counts as
  // blocked (P3.3).
  if (b && b.status === 'blocked' && b.blocked_reason === 'dependency_conflict' && !s.conflictRebuilt) {
    s.conflictRebuilt = true
    s.failures = [`Attempt ${attemptNo(id)}: task start could not merge into this task's branch (${b.summary || 'dependency_conflict'}). The branch is restarted from the integrated job branch: build the task there.`]
    rebuilds.push({ task: id, kind: 'dependency_conflict' })
    return
  }
  if (b && b.status === 'blocked') {
    s.outcome = 'blocked'
    // dependency_conflict is typed: the task's dependencies don't merge even on a branch rebuilt
    // from the job branch, a plan change fixes it, and retrying would only fail again.
    s.summary = b.blocked_reason === 'dependency_conflict'
      ? `Blocked (dependency_conflict): ${b.summary || 'its dependencies do not merge'}`
      : `Blocked: needs ${(b.needs_paths || []).join(', ') || 'paths outside its scope'}. ${b.summary || ''}`
    return
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
    return
  }
  s.swept = b.swept || []
  s.summary = b.summary || ''
  // `task verify` decides, by its exit code and the evidence it records; the tester relays it.
  const t = await relayVerify(id)
  s.attempts += 1
  checks.push({ task: id, attempt: attemptNo(id) - 1, pass: Boolean(t && t.pass), ...(t && t.evidence_id ? { evidence_id: t.evidence_id } : {}), ...(t && t.refused ? { refused: t.refused } : {}) })
  if (t && t.refused === 'environment_broken') {
    // not the builder's failure: the attempt is given back and the run stops
    s.attempts -= 1
    if (!envBroken) envBroken = { task: id, reason: String((t.failures || [])[0] || 'environment broken').split('\n')[0] }
    return
  }
  if (t && t.pass) {
    s.outcome = 'done'
    return
  }
  const why = !t ? ['the tester returned nothing twice, so task verify\'s result was not relayed (`task show` has it under history if it ran).'] : t.refused ? [`task verify refused (${t.refused}): ${(t.failures || []).join(' ')}`] : (t.failures || []).length ? t.failures : ['task verify did not pass.']
  s.failures = why.map((f) => `Attempt ${attemptNo(id) - 1}: ${f}`)
  if (s.attempts >= (T[id].retry_limit || 3)) {
    s.outcome = 'exhausted'
    s.summary = `Exhausted after ${s.attempts} attempt(s): ${s.failures.slice(0, 2).join('; ')}`
  }
}

// ---------------------------------------------------------------- the attempt barrier
// Every attempt passes it, the first and every retry: no attempt starts (its builder's task start
// merges the job branch) while an integration's checks run, or while a failed integration is
// being repaired (except the repair itself); none starts on top of a broken integrated build; and
// at most max_parallel_tasks attempts are at work at once. Returns false when the task must not
// go on (the build environment or the integrated build is broken).
let active = 0
const waiters = []
function wake() {
  for (const w of waiters.splice(0)) w()
}
let integrating = null
let brokenIntegration = null
// Tasks reopened by a failed integration: their broken merge is in the job branch, so until they
// are rebuilt and the batch is integrated again, nothing new starts and nothing else is
// integrated on top of it.
const repairing = new Set()
async function gate(id) {
  for (;;) {
    if (envBroken) return false
    const repair = repairing.has(id)
    if (brokenIntegration && !repair) return false
    const held = Boolean(integrating) || (repairing.size > 0 && !repair)
    if (!held && active < cap) return true
    await new Promise((r) => waiters.push(r))
  }
}

// One task from start to settled: attempts until done, blocked or exhausted. Each task runs its
// own build → verify → retry loop: nothing waits for a sibling, only at the barrier.
async function runTask(id) {
  while (st[id].outcome === 'pending' && !envBroken) {
    if (!(await gate(id))) break
    active += 1
    try {
      await attempt(id)
    } finally {
      active -= 1
      wake()
    }
  }
}

// ---------------------------------------------------------------- scheduling (P3.4)
// By dependency, not by wave: a task starts as soon as its own dependencies are integrated
// (merged into the job branch with the job's checks passing; without per-wave integration, as
// soon as they are done), at most max_parallel_tasks at a time. Done tasks are integrated as they
// finish (`factory reconcile wave`, relayed by the integrator), one integration at a time, each
// batch being the done tasks not yet integrated. A failure goes back, with its output, to the
// task(s) whose files it names; they are rebuilt on the integrated branch (within their retry
// limit) and integrated again. If the integrated build stays broken, no further task starts: it
// would start from broken code (the 0.15 guarantee, per dependency instead of per wave). Tasks
// start from the job branch as last integrated green (tasks.startBase), never from a merge whose
// checks have not passed.
const integrateOn = Boolean(brief.integrate_each_wave && brief.integrator && brief.integrate_prompt)
const integrated = new Set()
const waveOf = {}
brief.waves.forEach((w, i) => w.forEach((id) => { waveOf[id] = i + 1 }))
const order = brief.waves.flat().concat(Object.keys(T).filter((id) => !brief.waves.flat().includes(id)))
const depsOf = (id) => (T[id].depends_on || [])
// Tasks outside this run (done and integrated by an earlier one) count as integrated.
const depReady = (d) => !st[d] || (integrateOn ? integrated.has(d) : st[d].outcome === 'done')
const integrations = []
let integrationNo = 0

function skipAfterBrokenIntegration(why) {
  for (const id of order) {
    if (!st[id] || st[id].outcome !== 'pending' || running.has(id)) continue
    st[id].outcome = 'skipped_dependency'
    st[id].summary = `Skipped: the integrated build is broken (${why}); it would start from broken code.`
  }
}

// The CLI integrates (`factory reconcile wave`); the integrator only runs it and relays the
// result, and the job state the CLI wrote is what record trusts.
async function relayIntegrate(ids, wave) {
  const prompt = brief.integrate_prompt.replace('{{tasks}}', () => ids.join(',')).replace('{{wave}}', () => String(wave))
  runs += 1
  let r = await call(prompt, opts(brief.integrator, `integrate ${ids.join(',')} (wave ${wave})`))
  if (!r) {
    runs += 1
    r = await call(prompt, opts(brief.integrator, `integrate ${ids.join(',')} (wave ${wave}) (retry)`))
  }
  return r
}

// Integrate the done, not yet integrated tasks. Returns when the batch is integrated, or the
// integrated build is known broken (brokenIntegration), or tasks were reopened to fix it.
async function integrateDone() {
  const batch = order.filter((id) => st[id] && st[id].outcome === 'done' && !integrated.has(id))
  if (!batch.length) return
  // the batch's frontier: the deepest plan wave among its tasks (the label `reconcile wave` records)
  const frontier = Math.max(...batch.map((id) => waveOf[id] || 1))
  integrationNo += 1
  phase(`realize: integrating ${batch.join(', ')}`)
  const ig = await relayIntegrate(batch, frontier)
  integrations.push({ wave: frontier, n: integrationNo, tasks: batch, ok: Boolean(ig && ig.ok), kind: (ig && ig.kind) || null, route: (ig && ig.route) || [], ...(ig && ig.reconciled ? { reconciled: true } : {}) })
  if (ig && ig.ok) {
    batch.forEach((id) => integrated.add(id))
    repairing.clear()
    return
  }
  if (ig && ig.kind === 'environment') {
    envBroken = { reason: ig.message || 'environment broken' }
    return
  }
  const why = !ig ? 'the integration step was not relayed' : ig.kind === 'commands' ? `${(ig.failures || []).join(', ') || 'its checks failed'}` : `${ig.kind || 'error'}${ig.message ? `: ${String(ig.message).slice(0, 200)}` : ''}`
  const again = []
  for (const id of (ig && ig.route) || []) {
    const s = st[id]
    if (!s) continue // built before this run: its next realize rebuilds it (needs_work: integration)
    if (s.outcome !== 'done') continue // only work that was integrated goes back
    s.failures = [`Attempt ${attemptNo(id) - 1}: the integrated build failed after wave ${frontier} (${why}). \`task show\` lists the failing commands and their output under integration_failures; task start brings the integrated branch into yours.`]
    integrated.delete(id)
    if (s.attempts >= (T[id].retry_limit || 3)) {
      s.outcome = 'exhausted'
      s.summary = `Exhausted after ${s.attempts} attempt(s): the integrated build failed: ${why}`
      continue
    }
    s.outcome = 'pending'
    s.reopened = (s.reopened || 0) + 1
    repairing.add(id)
    again.push(id)
  }
  if (!again.length) {
    brokenIntegration = why
    return
  }
  // the main loop launches them (they pass the attempt barrier; other tasks wait at it)
  phase(`realize: rebuilding ${again.join(', ')} on the integrated branch`)
}

function launch(id) {
  if (running.has(id)) return
  phase(`realize: build ${id}${st[id].reopened ? ' (rebuild on the integrated branch)' : ''}`)
  const p = runTask(id).then(() => {
    running.delete(id)
    // A task rebuilt for an integration that still failed leaves its broken merge in the job
    // branch: the integrated build stays broken, whatever the other tasks' checks say.
    if (st[id].reopened && st[id].outcome !== 'done' && integrateOn && !brokenIntegration) brokenIntegration = `${id} could not fix the integrated build`
    wake()
  })
  running.set(id, p)
}

phase(`realize: ${order.filter((id) => st[id] && st[id].outcome === 'pending').length} task(s), by dependency${integrateOn ? ', each integrated when done' : ''} (up to ${cap} at a time)`)
for (;;) {
  skipDependents()
  if (brokenIntegration) {
    skipAfterBrokenIntegration(brokenIntegration)
    wake()
  }
  const repairOpen = [...repairing].some((id) => st[id].outcome === 'pending')
  // integrate first: a task launched in the same turn then waits at the barrier for its checks
  if (!integrating && !repairOpen && integrateOn && !envBroken && !brokenIntegration && order.some((id) => st[id] && st[id].outcome === 'done' && !integrated.has(id))) {
    integrating = integrateDone().then(() => {
      integrating = null
      wake()
    })
  }
  // a failed integration's repair: its reopened tasks (other tasks wait at the barrier)
  for (const id of order) if (repairing.has(id) && st[id].outcome === 'pending' && !running.has(id) && !envBroken && !brokenIntegration) launch(id)
  if (!envBroken && !brokenIntegration && !integrating && !repairing.size) {
    for (const id of order) {
      if (running.size >= cap) break
      if (!st[id] || st[id].outcome !== 'pending' || running.has(id)) continue
      if (depsOf(id).every(depReady)) launch(id)
    }
  }
  const waiting = [...running.values()].concat(integrating ? [integrating] : [])
  if (!waiting.length) break
  await Promise.race(waiting)
}
// Tasks never started (their dependencies never integrated) and not otherwise settled.
for (const id of order) {
  if (!st[id] || st[id].outcome !== 'pending') continue
  const bad = depsOf(id).find((d) => st[d] && st[d].outcome !== 'done')
  st[id].outcome = 'skipped_dependency'
  st[id].summary = envBroken ? 'Not started: the build environment is broken.' : bad ? `Skipped: depends on ${bad} (${st[bad].outcome})` : `Skipped: its dependencies were not integrated${brokenIntegration ? ` (${brokenIntegration})` : ''}.`
}

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
  return { ...base, status: 'park', park_reason: envBroken.reason, summary: `Stopped: ${envBroken.reason}`, data: { tasks, verifications: checks, integrations, rebuilds, environment_broken: envBroken } }
}
const notDone = tasks.filter((t) => t.outcome !== 'done')
return {
  ...base,
  status: notDone.length ? 'park' : 'ok',
  park_reason: notDone.length ? `Tasks not done: ${notDone.map((t) => `${t.id} (${t.outcome})`).join(', ')}` : null,
  summary: `${tasks.length - notDone.length}/${tasks.length} task(s) done.`,
  data: { tasks, verifications: checks, integrations, rebuilds },
}
