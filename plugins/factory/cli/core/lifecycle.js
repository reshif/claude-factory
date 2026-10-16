'use strict';
// Closing jobs, follow-ups, distill bookkeeping and `factory why`.

const { readJson, nowIso, fail } = require('../lib/util');
const { jobPaths, taskWorktree, pluginPath } = require('../lib/paths');
const git = require('../lib/git');
const job = require('./job');
const steps = require('./steps');
const floors = require('./floors');
const ledger = require('./ledger');
const decisions = require('./decisions');
const contractMod = require('./contract');

function finalize(root, { jobId, mode = 'full' }) {
  const state = job.resolve(root, jobId);
  const ctx = steps.context(root, state, job.load);
  return { job: state.id, ...floors.evaluate(ctx, mode) };
}

function cleanup(root, state) {
  const plan = readJson(jobPaths(root, state.id).plan, { tasks: [] });
  const envMod = require('./environment');
  const torn = (r) => r && require('./events').append(root, { event: 'environment_teardown', job: state.id, cmd: r.cmd, code: r.code });
  for (const t of plan.tasks || []) {
    // what the build environment started for this worktree (a compose project…), then the worktree
    torn(envMod.teardown(root, state, { taskId: t.id, wt: taskWorktree(root, state.id, t.id) }));
    git.run(root, ['worktree', 'remove', '--force', taskWorktree(root, state.id, t.id)], { allowFail: true });
    git.run(root, ['branch', '-D', steps.taskBranch(state, t.id)], { allowFail: true });
  }
  torn(envMod.teardown(root, state, { taskId: null, wt: jobPaths(root, state.id).worktree }));
  git.run(root, ['worktree', 'remove', '--force', jobPaths(root, state.id).worktree], { allowFail: true });
  git.run(root, ['worktree', 'prune'], { allowFail: true });
}

function close(root, { jobId }) {
  const state = job.resolve(root, jobId);
  const ctx = steps.context(root, state, job.load);
  const fl = floors.evaluate(ctx, 'full');
  if (!fl.ok) {
    const hint = fl.missing.includes('ci_reverify')
      ? ' For a local merge, run factory ci verify to re-verify the merge result (or reply "waive ci_reverify <reason>").'
      : '';
    fail(`Cannot close ${state.id}: floors not met: ${fl.missing.join(', ')}.${hint}`, 'floor', fl);
  }
  const notDone = ctx.recipe.steps.filter((s) => s.step !== 'close' && !steps.isDone(ctx, s)).map((s) => s.step);
  if (notDone.length) fail(`Cannot close ${state.id}: steps not done: ${notDone.join(', ')}`, 'not_ready');
  if (state.branch) cleanup(root, state);
  const down = require('./environment').servicesDown(root, state);
  if (down) require('./events').append(root, { event: 'environment_services_down', job: state.id, cmd: down.cmd, code: down.code });
  state.status = 'closed';
  state.closed_at = nowIso();
  state.pending_gate = null;
  job.save(root, state);
  ledger.append(root, state.id, { kind: 'step', step: 'close', ok: true, bound: {} });
  let next = null;
  if (state.parent) {
    job.setCurrent(root, state.parent);
    next = `Back to epic ${state.parent}.`;
  }
  return { job: state.id, status: 'closed', next };
}

// What went wrong while the job was built, for distill (P4.4): parks (every kind, read
// generically: a router park's rule, a workflow's park, a park by hand, clarify's, and the drive's
// stops that are trouble — never its gate, clarify, hand-off or done stops), resumes, agent
// retries, scope violations, a broken environment, integration failures, tasks that ended
// blocked or exhausted or needed several attempts, automatic recoveries (a rebuild), and manual
// repairs (amendments, task states set by hand, findings settled by hand, waivers). Each list is
// capped; `count` is how many items there were in all. One park written by several records (its
// decision row, the workflow result, the drive's stop) counts once.
const CAP = 12;
const TROUBLE_STOPS = new Set(['parked', 'error', 'limit', 'degraded']);
const clip = (v, n = 240) => (v === undefined || v === null ? null : String(v).slice(0, n));
function troubleOf(root, state) {
  const { readJsonl } = require('../lib/util');
  const { project } = require('../lib/paths');
  const evs = readJsonl(project(root).eventsFile).filter((e) => e && e.job === state.id);
  const decs = decisions.forJob(root, state.id);
  const led = ledger.all(root, state.id);
  const typed = (e) => clip(e.kind || e.park_kind || e.type || e.code || e.rule || e.from || null, 80);
  const parks = [
    ...decs.filter((d) => d.action === 'parked' || d.action === 'park').map((d) => ({ at: d.ts, source: 'router', type: clip((d.park && d.park.kind) || d.rule || null, 80), reason: clip(d.reason) })),
    ...evs.filter((e) => e.event === 'cli' && e.ok !== false && ((e.cmd === 'record' && e.status === 'park') || e.cmd === 'park')).map((e) => ({ at: e.ts, source: e.cmd === 'park' ? 'by hand' : `${e.workflow || 'workflow'} result`, type: null, reason: null })),
    ...led.filter((e) => e.kind === 'clarify' && e.outcome === 'park').map((e) => ({ at: e.at, source: 'clarify', type: 'clarify', reason: clip((e.detail || {}).reason) })),
    ...evs.filter((e) => typeof e.event === 'string' && e.event !== 'cli' && ((/park/i.test(e.event) && !/unpark|resume/i.test(e.event)) || (e.event === 'drive_stop' && TROUBLE_STOPS.has(e.kind)))).map((e) => ({ at: e.ts, source: e.event, type: typed(e), reason: clip(e.reason || e.summary || e.message || null) })),
  ]
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .filter((p, i, all) => !all.slice(0, i).some((q) => q.at && p.at && Math.abs(Date.parse(p.at) - Date.parse(q.at)) < 5000))
    // a drive rerun on a job still parked stops "parked" again, minutes later: the same park, not
    // a new one (review minor 7). A drive stop counts only when no park came before it since the
    // last resume.
    .filter((p, i, all) => {
      if (p.source !== 'drive_stop') return true;
      const prev = all.slice(0, i).filter((q) => q.at && p.at && q.at <= p.at).pop();
      if (!prev) return true;
      return decs.some((d) => d.action === 'human.resume' && d.ts > prev.at && d.ts <= p.at);
    });
  if (state.park && !parks.some((p) => p.reason && state.park.reason && p.reason === clip(state.park.reason))) parks.push({ at: state.park.at, source: 'current', type: clip(state.park.kind || state.park.from || null, 80), reason: clip(state.park.reason) });
  const resumes = decs.filter((d) => d.action === 'human.resume').map((d) => ({ at: d.ts, from: d.from || null, via: d.via || null }));
  // agent retries, from the workflows' rosters (a retried call, or a builder's attempt #2 and later)
  const roster = led.filter((e) => e.kind === 'agents').flatMap((e) => (e.agents || []).map((a) => ({ ...a, workflow: e.workflow })));
  const retries = roster.filter((a) => a.retry || /#([2-9]|\d{2,})$/.test(String(a.label || ''))).map((a) => ({ label: clip(a.label, 80), role: String(a.agent_type || '').replace(/^factory:/, '') || null, outcome: a.outcome || null, why: a.retry ? 'no result: asked again' : 'another attempt' }));
  const noResult = roster.filter((a) => a.outcome === 'no_result').map((a) => ({ label: clip(a.label, 80), role: String(a.agent_type || '').replace(/^factory:/, '') || null }));
  const scope = [];
  const envBroken = evs.filter((e) => e.event === 'environment_broken').map((e) => ({ task: e.task || null, cmd: clip(e.cmd, 120), reason: clip(e.reason) }));
  const tasks = [];
  for (const [id, t] of Object.entries(state.tasks || {})) {
    for (const h of t.history || []) {
      const v = h.verify || {};
      if ((v.scope_violations || []).length) scope.push({ task: id, attempt: h.attempt, paths: v.scope_violations.slice(0, 6) });
      if (v.refused === 'environment_broken') envBroken.push({ task: id, cmd: null, reason: clip(v.message) });
    }
    if (['blocked', 'exhausted', 'skipped_dependency'].includes(t.outcome)) tasks.push({ task: id, outcome: t.outcome, attempts: t.attempts || 0, reason: clip(t.outcome_reason || (t.builder && t.builder.blocked_reason) || null) });
    else if ((t.attempts || 0) > 1) tasks.push({ task: id, outcome: t.outcome || null, attempts: t.attempts, reason: 'needed more than one attempt' });
  }
  const integration = led.filter((e) => e.kind === 'step' && ['integrate', 'reconcile'].includes(e.step) && e.ok === false).map((e) => {
    const d = e.detail || {};
    return { step: e.step, kind: d.kind || (d.regression ? 'regression' : null), wave: d.wave || null, task: d.task || null, files: (d.files || (d.regression && d.regression.files) || []).slice(0, 6), commands: (d.commands || []).filter((c) => c.pass === false).map((c) => clip(c.cmd, 120)).slice(0, 4), message: clip(d.message) };
  });
  const manual = [
    ...evs.filter((e) => e.event === 'cli' && e.ok !== false && ((e.cmd === 'amend' && e.sub === 'submit') || (e.cmd === 'task' && e.sub === 'state'))).map((e) => ({ at: e.ts, what: `factory ${e.cmd} ${e.sub}` })),
    ...decs.filter((d) => d.action === 'human.waive' || (/finding/.test(String(d.action || '')) && /^human\./.test(String(d.action || '')))).map((d) => ({ at: d.ts, what: String(d.action).replace(/^human\./, ''), reason: clip(d.reason) })),
  ];
  const recovery = evs.filter((e) => e.event === 'recovery').map((e) => ({ at: e.ts, kind: e.kind || null, action: e.action || null, tasks: (e.tasks || []).slice(0, 6), reason: clip(e.reason) }));
  const lists = { parks, resumes, retries, no_result: noResult, scope_violations: scope, environment_broken: envBroken, integration_failures: integration, tasks, manual_repairs: manual, recovery };
  const count = Object.values(lists).reduce((n, l) => n + l.length, 0);
  const out = { count };
  for (const [k, l] of Object.entries(lists)) out[k] = l.slice(-CAP);
  return out;
}

// The model the lesson writer runs on, as wfargs gives every other role (policy.agents.models)
function roleModelOf(state, role) {
  try {
    return require('./wfargs').roleModel(state.policy, role);
  } catch {
    return null;
  }
}

function distillContext(root, { jobId }) {
  const state = job.resolve(root, jobId);
  const recs = ledger.all(root, state.id).filter((e) => e.kind === 'step' && /challenge/.test(e.step) && e.detail && e.detail.findings);
  const findings = recs.flatMap((r) => r.detail.findings.map((f) => ({ ...f, round: r.detail.round })));
  const lessons = require('./lessons').load(root).lessons.filter((l) => l.source_job === state.id);
  const others = job
    .listJobIds(root)
    .filter((id) => id !== state.id)
    .flatMap((id) => {
      const rec = ledger.all(root, id).filter((e) => e.kind === 'step' && e.step === 'challenge' && e.detail && e.detail.findings);
      return rec.flatMap((r) => r.detail.findings.filter((f) => f.severity === 'minor').map((f) => ({ job: id, file: f.file, summary: f.summary })));
    });
  const trouble = troubleOf(root, state);
  const minor = findings.filter((f) => f.severity === 'minor');
  const recurring = others.slice(-50).filter((o) => minor.some((m) => m.file && m.file === o.file));
  const worth = Boolean(findings.some((f) => f.status === 'confirmed') || state.counters.verify_fix_rounds > 0 || recurring.length || trouble.count);
  return {
    job: state.id,
    confirmed: findings.filter((f) => f.status === 'confirmed'),
    minor: findings.filter((f) => f.severity === 'minor'),
    minor_in_other_jobs: others.slice(-50),
    verify_fix_rounds: state.counters.verify_fix_rounds,
    review_fix_rounds: state.counters.review_rounds,
    already_proposed: lessons,
    cap: state.policy.lessons_max_per_job,
    // build trouble: lessons about the process and the environment, not only the code (P4.4)
    trouble,
    // whether the lesson writer has anything to work from (the distill skill and factory drive
    // both read it: nothing worth learning skips the agent)
    worth_learning: worth,
    // What the distill step hands the lesson writer: its agent, the command that records a
    // lesson, and the JSON its final message must match (checked by `distill done --result`).
    lesson_writer: {
      agent_type: 'factory:lesson-writer',
      record_command: `factory lessons add --job ${state.id} --text "<lesson>" --scope "<glob>,<glob>" --why "<finding id: what went wrong>"`,
      reply_schema: readJson(pluginPath('schemas', 'agent-outputs', 'lesson.json')),
      ...(roleModelOf(state, 'lesson-writer') ? { model: roleModelOf(state, 'lesson-writer') } : {}),
    },
    // the project brief (.factory/project.md) as it is now: the lesson writer may propose edits
    // (project_brief in its reply), which wait for the user like a lesson
    project_brief: (() => {
      try {
        const pb = require('./project-brief');
        pb.ensure(root, state.policy);
        return { file: pb.file(root), text: pb.read(root), editable: pb.EDITABLE, max_added_lines: pb.MAX_ADDS };
      } catch {
        return null;
      }
    })(),
  };
}

// The lesson writer's final message, checked against what it actually recorded: every id it
// names must be a lesson of this job, and "nothing to learn" means it named none.
function checkLessonReply(root, state, reply) {
  const { validate } = require('../lib/schema');
  const errs = validate(readJson(pluginPath('schemas', 'agent-outputs', 'lesson.json')), reply);
  if (errs.length) fail(`The lesson writer's reply does not match its schema:\n- ${errs.join('\n- ')}`, 'bad_input', errs);
  const mine = new Set(require('./lessons').load(root).lessons.filter((l) => l.source_job === state.id).map((l) => l.id));
  const unknown = reply.lessons.map((l) => l.id).filter((id) => !mine.has(id));
  if (unknown.length) fail(`The lesson writer names lessons ${state.id} never recorded: ${unknown.join(', ')}. Record each with factory lessons add first.`, 'bad_input');
  if (reply.nothing_to_learn && reply.lessons.length) fail('The lesson writer says there is nothing to learn but lists lessons.', 'bad_input');
  return reply.lessons.map((l) => l.id);
}

// `result` (optional) is the lesson writer's final message; without it, distill done records
// the step as before.
function distillDone(root, { jobId, result }) {
  const state = job.resolve(root, jobId);
  const reply = result === undefined || result === null ? null : typeof result === 'string' ? parseReply(result) : result;
  const ids = reply ? checkLessonReply(root, state, reply) : null;
  // Project brief edits the lesson writer proposed: stored as a proposal for the user (accept
  // brief Pn), never applied here (P4.3)
  let brief = null;
  if (reply && reply.project_brief && Array.isArray(reply.project_brief.edits) && reply.project_brief.edits.length) {
    const r = require('./project-brief').propose(root, reply.project_brief.edits, { job: state.id, why: reply.project_brief.why });
    brief = { proposal: r.id, edits: r.edits, refused: r.refused };
  }
  try {
    require('./project-brief').refresh(root, state.policy); // this job's ADRs and newly accepted lessons join the index
  } catch {
    /* a convenience */
  }
  ledger.append(root, state.id, { kind: 'step', step: 'distill', ok: true, bound: {}, ...(reply ? { detail: { lessons: ids, nothing_to_learn: reply.nothing_to_learn, ...(brief && brief.proposal ? { project_brief: brief.proposal } : {}) } } : {}) });
  return {
    job: state.id,
    ok: true,
    ...(reply ? { lessons: ids, nothing_to_learn: reply.nothing_to_learn } : {}),
    ...(brief ? { project_brief: brief, ...(brief.proposal ? { message: `Project brief change ${brief.proposal} proposed (${brief.edits.length} section(s)): it waits for the user's "accept brief ${brief.proposal}" or "reject brief ${brief.proposal} <why>", and then reaches every later agent brief.` } : {}) } : {}),
  };
}

function parseReply(text) {
  try {
    return JSON.parse(text);
  } catch {
    return fail('distill done --result needs the lesson writer\'s JSON reply (a file, - for stdin, or the JSON itself).', 'bad_input');
  }
}

function followup(root, { jobId, findings, workType }) {
  const parent = job.resolve(root, jobId);
  const type = workType || (parent.work_type === 'hotfix' ? 'hotfix' : 'bug');
  const list = findings || [];
  const contract = [
    `# Follow-up to ${parent.id}: ${parent.title}`,
    '',
    `<!-- factory contract · follow-up of ${parent.id} · the merged job is never reopened -->`,
    '',
    '## Intent',
    ...contractMod.intentLines({
      problem: list.length ? `Confirmed after ${parent.id} merged: ${list.map((f) => f.summary).join('; ')}` : null,
      outcome: list.length ? `None of these problems occur any more, and nothing else in ${parent.id} changes` : null,
      why_now: `Found after ${parent.id} (${parent.title}) merged`,
      success: list.length ? 'Every AC below passes on the merged follow-up' : null,
    }),
    '',
    '## Goal',
    `Fix the confirmed problems found after ${parent.id} merged.`,
    '',
    '## Non-goals',
    `- Re-doing anything else in ${parent.id}`,
    '',
    '## Acceptance criteria',
    ...(list.length ? list.map((f, i) => `- AC-${i + 1}: ${f.summary}${f.file ? ` (${f.file})` : ''} no longer occurs (evidence: test)`) : ['- AC-1: <observable behaviour> (evidence: test)']),
    '',
    '## Constraints',
    '- <compatibility, performance, security or style constraints>',
    '',
    '## Allowed paths',
    ...([...new Set(list.map((f) => f.file).filter(Boolean))].map((f) => `- ${f}`).concat(list.length ? [] : ['- <path/glob/**>'])),
    '',
    '## Verify commands',
    '- `<command>` (AC-1)',
    '',
    '## Assumptions',
    '- <anything assumed rather than confirmed>',
    '',
  ].join('\n');
  const prevCurrent = job.current(root);
  const child = job.create(root, { title: `Follow-up to ${parent.id}`, workType: type, risk: parent.risk, contractText: contract, followupOf: parent.id });
  if (prevCurrent) job.setCurrent(root, prevCurrent);
  return { job: parent.id, followup: child.id, recipe: child.recipe.id };
}

function why(root, { jobId }) {
  const state = job.resolve(root, jobId);
  const rows = decisions.forJob(root, state.id);
  // every park with its typed reason and the suggested next step (park rows, and parks the
  // router recorded with its own decision)
  const parks = rows.filter((d) => d.action === 'park' || d.action === 'parked').map((d) => ({ ts: d.ts, kind: (d.park && d.park.kind) || String(d.rule || '').replace(/^park\./, ''), rule: d.rule || null, reason: d.reason || null, next: (d.park && d.park.next) || null }));
  return { job: state.id, title: state.title, recipe: `${state.recipe.id} v${state.recipe.version}`, risk: state.risk, status: state.status, ...(state.status === 'parked' && state.park ? { park: state.park } : {}), parks, decisions: rows };
}

function whyMarkdown(w) {
  const L = [`# Why ${w.job} took this path`, '', `${w.title} · ${w.recipe} · risk ${w.risk} · ${w.status}`, '', '| # | Time | Chosen | Rule | First failing check | Reason |', '|---|---|---|---|---|---|'];
  const reasonOf = (d) => {
    if (d.action === 'park' || d.action === 'parked') return `${d.park && d.park.kind ? `[${d.park.kind}] ` : ''}${d.reason || ''}${d.park && d.park.next ? ` → next: ${d.park.next}` : ''}`;
    if (d.reason) return d.reason;
    if (d.action === 'workflow') return `the ${d.workflow || d.step} workflow${d.config ? ` (config ${d.config})` : ''}${d.scope && d.scope !== 'all' ? ` (scope ${d.scope})` : ''}`;
    if (d.action === 'cli') return d.command || '';
    if (d.action === 'skill') return `${d.skill || d.step}${d.clarify && d.clarify.stage ? ` (${d.clarify.stage}${d.clarify.waiting_for_user ? ', waits on you' : ''})` : ''}`;
    if (String(d.action || '').startsWith('human.')) return `${d.channel ? `${d.channel}: ` : ''}${d.gate || d.reason || d.from || ''}`;
    return '';
  };
  w.decisions.forEach((d, i) => {
    L.push(`| ${i + 1} | ${String(d.ts).replace('T', ' ').slice(0, 19)} | ${d.action === 'park' ? `park${d.park && d.park.kind ? ` (${d.park.kind})` : ''}` : d.chosen || d.action} | ${d.rule || ''} | ${d.first_failing || '—'} | ${String(reasonOf(d)).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 240)} |`);
  });
  if (w.park) L.push('', `**Parked now** (${w.park.kind || 'other'}): ${String(w.park.reason || '').replace(/\n/g, ' ')}`, '', `Next: ${w.park.next || 'reply "resume", "cancel job" or "abandon job".'}`);
  return L.join('\n');
}

module.exports = { troubleOf, finalize, close, distillContext, distillDone, followup, why, whyMarkdown, cleanup };
