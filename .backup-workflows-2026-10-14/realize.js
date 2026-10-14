export const meta = {
  name: 'realize',
  description: 'Software Factory: build tasks wave by wave, each in its own git worktree — builder then independent tester, retried up to each task\'s limit; a blocked or exhausted task skips only its dependents. Pass the JSON brief from `factory wfargs realize` as args.',
}

const brief = (() => {
  let a = typeof args === 'string' ? args.trim() : args
  if (typeof a === 'string') a = JSON.parse(a)
  if (a && a.brief) a = typeof a.brief === 'string' ? JSON.parse(a.brief) : a.brief
  if (!a || a.workflow !== 'realize') throw new Error('realize needs the JSON brief from `factory wfargs realize` as its args')
  return a
})()

let runs = 0
const T = brief.tasks
const st = {}
for (const id of Object.keys(T)) st[id] = { outcome: 'pending', attempts: 0, failures: [], swept: [], summary: '' }
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

for (let w = 0; w < brief.waves.length; w++) {
  skipDependents()
  let active = brief.waves[w].filter((id) => st[id] && st[id].outcome === 'pending')
  if (!active.length) continue
  phase(`realize: wave ${w + 1}/${brief.waves.length} (${active.join(', ')})`)
  while (active.length) {
    const built = await runAll(active, (id) => {
      const s = st[id]
      const prompt = T[id].builder_prompt
        .replace('{{attempt}}', String(s.attempts + 1))
        .replace('{{failures}}', s.failures.length ? s.failures.map((f) => `  - ${f}`).join('\n') : '  - (none)')
      return agent(prompt, { schema: brief.builder_schema, label: `build ${id} #${s.attempts + 1}` })
    })
    const toTest = []
    for (const id of active) {
      const b = built[id]
      const s = st[id]
      if (b && b.status === 'blocked') {
        s.outcome = 'blocked'
        s.summary = `Blocked: needs ${(b.needs_paths || []).join(', ') || 'paths outside its scope'}. ${b.summary || ''}`
        continue
      }
      if (b) { s.swept = b.swept || []; s.summary = b.summary || '' }
      toTest.push(id)
    }
    const tested = await runAll(toTest, (id) => agent(T[id].tester_prompt.replace('{{swept}}', st[id].swept.join(', ') || '(none listed)'), { schema: brief.tester_schema, label: `test ${id}` }))
    for (const id of toTest) {
      const s = st[id]
      s.attempts += 1
      const t = tested[id]
      if (t && t.pass) {
        s.outcome = 'done'
        continue
      }
      s.failures = t ? t.failures : ['The tester returned nothing.']
      if (s.attempts >= (T[id].retry_limit || 3)) {
        s.outcome = 'exhausted'
        s.summary = `Exhausted after ${s.attempts} attempt(s): ${s.failures.slice(0, 2).join('; ')}`
      }
    }
    active = active.filter((id) => st[id].outcome === 'pending')
  }
}
skipDependents()

const tasks = Object.keys(T).map((id) => ({ id, outcome: st[id].outcome, attempts: st[id].attempts, summary: st[id].summary }))
const notDone = tasks.filter((t) => t.outcome !== 'done')
return {
  workflow: 'realize',
  config: null,
  mode: brief.scope || null,
  job: brief.job,
  status: notDone.length ? 'park' : 'ok',
  next_gate: null,
  input_hash: brief.input_hash,
  budgets: { used: { agent_runs: runs }, limit: (brief.budgets && brief.budgets.limit) || {} },
  artifacts: [],
  questions: [],
  park_reason: notDone.length ? `Tasks not done: ${notDone.map((t) => `${t.id} (${t.outcome})`).join(', ')}` : null,
  summary: `${tasks.length - notDone.length}/${tasks.length} task(s) done.`,
  data: { tasks },
}
