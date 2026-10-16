'use strict';
// factory drive — the deterministic router loop (P3.1, claude-native). The CLI cannot start
// Claude Code subagents or run the Workflow tool, so the drive does every step a program can do
// and hands back to the main session only where it must act: it loops over `factory next`, runs
// the router's CLI steps, `factory ship`, distill's bookkeeping, the epic's slice switches and
// the evidence records the CLI can check, builds each workflow's brief (`factory wfargs`) and
// records each result (`factory drive --record`), and returns one typed stop:
//
//   main-session hand-offs (no notification; the main session acts and runs factory drive again)
//     workflow   run the Workflow tool with `args` (the brief), save its result, then
//                factory drive --record <file>
//     agent      start the lesson writer (distill) with the context given, save its reply, then
//                factory drive --lessons <file>
//     evidence   a doc/diff record the CLI cannot pick a file for: check the build, run the line
//     skill      a step only the main session can do (none today; kept for new recipe steps)
//     yield      the drive used its time budget (--max-seconds, under a shell tool's time limit):
//                run factory drive again, it continues from factory next
//   human stops (a desktop notification, notify.js; the main session shows the stop and ends
//   its turn)
//     gate       a human gate (H1, H2, H3, HF, HS, EH*, A): the human approves or denies
//     clarify    clarify waits on the user (read-back, decision sheet, redirect read-back)
//     questions  ground's blocking questions for the user
//     parked     the job parked (typed: kind and the suggested next step)
//     wait       the merge, a PR, a human check of a criterion
//     amend      an amendment needs the user (what changed, and the edit)
//     ship       policy.drive.stop_before_ship: the push or PR waits for the user's go
//     done       the job is closed (or cancelled/abandoned)
//     error      a step failed twice, or a result could not be recorded
//     limit      too many steps without a stop (a loop)
//
// It never answers a gate or a clarify turn: no human-only verb, no `clarify reply` or `clarify
// redirect`, no `answer` is ever run by the drive (a router step naming one is refused), and its
// children have no terminal and run in Claude Code's agent environment, where the CLI's human
// channel refuses anyway. Every step runs as its own `factory` child process (logged like the
// main session's commands, with via "drive"), so the router, the stop hook and the inspector see
// what a hand-stepped job shows. Every stop is a `drive_stop` event and the last one is kept in
// .factory/drive.json; rerun the drive after a crash or a stop and it continues from
// `factory next`. One drive per repository at a time; while it runs, `factory next` from
// anyone else answers "driving".

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { fail, nowIso, readJson } = require('../lib/util');
const { PLUGIN_ROOT, project, jobPaths } = require('../lib/paths');
const events = require('./events');

const MAX_STEPS = 200;
const MAX_SECONDS = 480; // under the Bash tool's 10-minute ceiling, with room for the last step
const STALE_MS = 15 * 60 * 1000; // another host's drive counts as gone after this long without a step
const HUMAN_ONLY = new Set(['approve', 'deny', 'resume', 'proceed', 'cancel', 'abandon', 'waive', 'merged', 'confirm', 'reseal', 'finding']);
const HANDOFF = new Set(['workflow', 'agent', 'evidence', 'skill', 'yield']);
const FAILURE = new Set(['error', 'limit']);

const driveFile = (root) => path.join(project(root).dir, 'drive.json');

function readState(root) {
  try {
    return JSON.parse(fs.readFileSync(driveFile(root), 'utf8'));
  } catch {
    return null;
  }
}

function writeState(root, st) {
  try {
    fs.mkdirSync(path.dirname(driveFile(root)), { recursive: true });
    const tmp = `${driveFile(root)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n');
    fs.renameSync(tmp, driveFile(root));
  } catch {
    /* the drive goes on; status shows less */
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Is this pid still a node/factory process? true / false, or null where /proc can't tell.
function nodeProcess(pid) {
  try {
    return /factory|node/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'));
  } catch {
    return null;
  }
}

// A running drive, by what can be known about it: on another machine (a container, a renamed
// host) only its last step speaks for it, so an old one is gone (and its pid means nothing here);
// on this machine, its process: a live node/factory process is alive however long its step
// takes, a gone or reused pid is dead.
const sameHost = (st) => !st.host || st.host === os.hostname();
function alive(st) {
  if (!st || st.status !== 'running') return false;
  if (!sameHost(st)) return Date.now() - (Date.parse(st.heartbeat_at || st.started_at || '') || 0) <= STALE_MS;
  if (!pidAlive(st.pid)) return false;
  return nodeProcess(st.pid) !== false;
}

function liveFor(root, jobId = null) {
  const st = readState(root);
  if (!alive(st)) return null;
  if (jobId && st.job && st.job !== jobId) return null;
  return st;
}

// Am I (this process) running under that drive? Its children carry FACTORY_DRIVE=<pid>.
function isDriveChild(st) {
  return Boolean(st && String(process.env.FACTORY_DRIVE || '') === String(st.pid));
}

function drivingAnswer(st, jobId) {
  return {
    job: jobId || st.job,
    action: 'driving',
    reason: `factory drive (pid ${st.pid}, since ${st.started_at}) is stepping ${st.job}; it returns when the main session or you are needed.`,
    drive: { pid: st.pid, job: st.job, started_at: st.started_at, step: st.step || null },
    instructions: 'Wait for that factory drive to return (factory drive status shows where it is). Don\'t run factory next alongside it.',
  };
}

// ---------------------------------------------------------------- one factory command

function runChild(ctx, args, { jobId = ctx.job } = {}) {
  const a = [path.join(PLUGIN_ROOT, 'bin', 'factory'), '--root', ctx.root, ...args];
  if (jobId && !args.includes('--job')) a.push('--job', jobId);
  const env = { ...process.env, FACTORY_ROOT: ctx.root, FACTORY_DRIVE: String(process.pid) };
  const r = spawnSync(process.execPath, a, { cwd: ctx.root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  if (r.error) json = { error: true, code: 'internal', message: r.error.message };
  return { code: r.status === null ? -1 : r.status, json, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// "factory ci verify --job J-0001" → ['ci', 'verify', '--job', 'J-0001'] (quotes kept together)
function words(command) {
  return (String(command || '').replace(/^\s*(?:node\s+"?[^"\s]*bin[\\/]factory"?(?:\s+--root\s+"[^"]*")?|factory)\s+/, '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) => w.replace(/^(["'])([\s\S]*)\1$/, '$2'));
}

// The `factory wfargs` arguments for a workflow action, exactly the fields `factory next` gave.
function wfargsArgs(n) {
  const a = ['wfargs', n.workflow || 'clarify'];
  if (n.config) a.push('--config', n.config);
  if (n.mode) a.push('--mode', n.mode);
  if (n.scope) a.push('--scope', n.scope);
  if (n.lanes && [].concat(n.lanes).length) a.push('--lanes', [].concat(n.lanes).join(','));
  if (n.threat_model === true) a.push('--threat-model');
  if (n.threat_model === false) a.push('--no-threat-model');
  if (n.plan_critique) a.push('--plan-critique');
  return a;
}

// ---------------------------------------------------------------- evidence the CLI can check

// A doc/diff record the drive may make itself: exactly one file of that kind among the files the
// tasks covering the criterion changed, and the criterion's own text names it (its path, or its
// file name as a word: a lone CHANGELOG.md is not evidence for a README criterion). Anything
// else (none, several) is the main session's judgement and a hand-off.
const DOC_FILE = /(^|\/)(docs?|documentation)\/|\.(md|mdx|markdown|rst|adoc|txt)$|(^|\/)README[^/]*$/i;
function evidencePath(root, jobId, ac, type) {
  try {
    const job = require('./job');
    const git = require('../lib/git');
    const steps = require('./steps');
    const { matchesAny } = require('../lib/glob');
    const state = job.load(root, jobId);
    const plan = readJson(jobPaths(root, jobId).plan, { tasks: [] }) || { tasks: [] };
    const tasks = (plan.tasks || []).filter((t) => (t.criteria_ids || []).includes(ac));
    if (!tasks.length) return null;
    const changed = new Set();
    for (const t of tasks) {
      const br = steps.taskBranch(state, t.id);
      if (!git.branchExists(root, br)) continue;
      for (const f of git.changedFiles(root, state.base_commit, br)) if (matchesAny(f, t.allowed_paths || [])) changed.add(f);
    }
    const inBuild = new Set(git.changedFiles(root, state.base_commit, state.branch));
    const cands = [...changed].filter((f) => inBuild.has(f) && (type !== 'doc' || DOC_FILE.test(f)));
    if (cands.length !== 1) return null;
    const C = require('./contract');
    const crit = C.parse(C.read(root, jobId)).acs.find((a) => a.id === String(ac).toUpperCase());
    const text = String((crit && crit.text) || '').toLowerCase();
    const f = cands[0].toLowerCase();
    const stem = path.basename(f).replace(/\.[^.]+$/, '');
    if (!text || !(text.includes(f) || (stem.length >= 3 && new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)))) return null;
    return { path: cands[0], tasks: tasks.map((t) => t.id) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- stops

const STOP_TITLE = {
  gate: 'gate waits for you',
  clarify: 'clarify waits for your reply',
  questions: 'questions for you',
  parked: 'job parked',
  wait: 'waiting on you',
  amend: 'an amendment needs you',
  ship: 'ready to ship: waits for your go',
  done: 'job done',
  error: 'drive stopped on an error',
  limit: 'drive step limit reached',
};

const ENVELOPE = '.factory/scratch/envelope.json';
const LESSONS = '.factory/scratch/lessons.json';

// What the human (or the main session) does next, for each kind of stop.
function stopDetail(kind, n, extra = {}) {
  const J = (n && n.job) || extra.job;
  const g = n && n.gate;
  switch (kind) {
    case 'workflow':
      return {
        workflow: extra.workflow,
        args: extra.args,
        summary: `${J}: run the ${extra.workflow} workflow (Workflow tool, factory:${extra.workflow}) with \`args\` unchanged, write its JSON result unchanged to ${ENVELOPE}, then run factory drive --record ${ENVELOPE}.`,
        envelope: ENVELOPE,
        then: `factory drive --record ${ENVELOPE}`,
      };
    case 'agent':
      return {
        agent_type: 'factory:lesson-writer',
        context: extra.context,
        summary: `${J}: start factory:lesson-writer (Agent tool${extra.context && extra.context.lesson_writer && extra.context.lesson_writer.model ? `, model ${extra.context.lesson_writer.model}` : ''}) with \`context\` (the distill context), save its final message unchanged to ${LESSONS}, then run factory drive --lessons ${LESSONS}.`,
        reply_file: LESSONS,
        then: `factory drive --lessons ${LESSONS}`,
      };
    case 'gate':
      return {
        gate: g ? { id: g.id, hash: g.hash, docs: g.docs || [] } : null,
        summary: `${J} waits at gate ${g ? g.id : n.step}${g && g.hash ? ` (hash ${String(g.hash).slice(0, 12)})` : ''}${n.resumes_park ? '; approving it also resumes the parked job' : ''}.`,
        reply: 'approve | deny <what must change>',
        command: g && g.id === 'A' ? `factory approve --job ${J}` : `factory approve ${g ? g.id : ''} --job ${J}`.replace('  ', ' '),
      };
    case 'clarify': {
      const c = (n && n.clarify) || {};
      const stage = extra.stage || c.stage || null;
      const what = { readback_wait: 'the read-back: ok, or what to change', sheet_wait: 'the decision sheet: your answers', redirect_wait: 'how your redirect was read: ok, or what to change' }[stage] || stage || 'clarify';
      return { stage, screen: extra.screen || c.screen || null, summary: `${J}: clarify waits on your reply (${what}).`, reply: 'ok, or your corrections / sheet answers in your own words' };
    }
    case 'questions':
      return { questions: extra.questions || [], summary: `${J}: ${(extra.questions || []).length} question(s) block the design.`, reply: 'answer each question' };
    case 'parked': {
      const p = n.park || {};
      return { park: { kind: p.kind || null, next: p.next || null }, summary: `${J} parked${p.kind ? ` (${p.kind})` : ''}: ${String(n.reason || '').split('\n')[0].slice(0, 300)}${p.next ? ` Next: ${p.next}` : ''}`, reply: 'resume | cancel job | abandon job | what to change', command: `factory resume --job ${J}` };
    }
    case 'wait': {
      const merged = /merged/.test(n.reason || '');
      return { summary: `${J}: ${n.reason || 'waiting on you'}`, reply: merged ? 'merged <commit>' : (n.acs || []).length ? (n.acs || []).map((a) => `confirm ${a}`).join(' | ') : 'continue', ...(merged ? { command: `factory merged <commit> --job ${J}` } : (n.acs || []).length ? { command: `factory confirm ${n.acs[0]} --job ${J}` } : {}) };
    }
    case 'ship':
      return { summary: `${J} is ready to ship (every pre-ship floor is met). policy.drive.stop_before_ship holds the push, the pull request or the local merge for your go: say so, and Claude follows the ship skill (factory ship), then factory drive.`, reply: 'ship it | what to change first' };
    case 'amend':
      return { summary: `${J}: ${n.reason || 'an amendment is needed'} Claude follows the amend skill (what changed and who asked), then factory drive continues.` };
    case 'evidence':
      return { commands: n.commands || [], acs: n.acs || [], summary: `${J}: ${(n.acs || []).join(', ')} need${(n.acs || []).length === 1 ? 's' : ''} a doc/diff record the drive could not pick a file for: check the build shows it, run its line with the real path, then factory drive.` };
    case 'skill':
      return { skill: n.skill || null, summary: `${J}: the ${n.skill || 'next'} step is the main session's: follow the factory:${n.skill || 'start'} skill, then factory drive.` };
    case 'yield':
      return { summary: `${J}: the drive used its time budget (${extra.seconds}s) between steps; run factory drive again: it continues from where the job is.` };
    case 'done':
      return {
        summary: `${J} is done: ${n.reason || 'closed'}${extra.lessons && extra.lessons.length ? ` Lessons proposed: ${extra.lessons.join(', ')} (reply "accept lesson Ln" or "reject lesson Ln <why>").` : ''}${extra.briefs && extra.briefs.length ? ` Project brief changes proposed: ${extra.briefs.map((b) => b.id).join(', ')} (reply "accept brief Pn" or "reject brief Pn <why>"; they reach every later agent).` : ''}`,
        ...(extra.lessons && extra.lessons.length ? { lessons: extra.lessons } : {}),
        ...(extra.briefs && extra.briefs.length ? { briefs: extra.briefs } : {}),
      };
    default:
      return { summary: `${J || 'drive'}: ${extra.message || n.reason || kind}` };
  }
}

// ---------------------------------------------------------------- recording what the main session ran

// A workflow result the main session saved: recorded with `factory record`. Returns a stop (the
// user is needed now) or null (go on with factory next).
function recordEnvelope(ctx, file) {
  const res = runChild(ctx, ['record', '--file', file]);
  const j = res.json;
  if (!j || j.error) return ctx.stop('error', { job: ctx.job }, { message: `factory record --file ${file}: ${(j && j.message) || res.stdout.slice(0, 300) || `exit ${res.code}`}`, code: j && j.code });
  ctx.job = j.job || ctx.job;
  ctx.recorded = j;
  if (j.status === 'needs_user') {
    if (j.workflow === 'clarify') return ctx.stop('clarify', { job: ctx.job }, { stage: j.stage, screen: j.screen });
    return ctx.stop('questions', { job: ctx.job }, { questions: (j.questions || []).map((q) => q.question || q) });
  }
  return null;
}

// The lesson writer's reply the main session saved: distill done checks it against what it
// recorded and stores its project brief edits as a proposal.
function recordLessons(ctx, file) {
  const res = runChild(ctx, file ? ['distill', 'done', '--result', file] : ['distill', 'done']);
  const j = res.json;
  if (!j || j.error) return ctx.stop('error', { job: ctx.job }, { message: `factory distill done: ${(j && j.message) || `exit ${res.code}`}`, code: j && j.code });
  ctx.recorded = j;
  ctx.lessons.push(...(j.lessons || []));
  if (j.project_brief && j.project_brief.proposal) ctx.briefs.push({ id: j.project_brief.proposal, job: ctx.job, edits: (j.project_brief.edits || []).length });
  return null;
}

// ---------------------------------------------------------------- the loop

function loop(ctx) {
  const job = require('./job');
  const fails = {};
  let unknown = 0;
  for (;;) {
    if (!ctx.owns()) return ctx.stop('error', { job: ctx.job }, { message: 'another factory drive took over this repository' });
    ctx.steps += 1;
    if (ctx.steps > ctx.maxSteps) return ctx.stop('limit', { job: ctx.job }, { message: `stopped after ${ctx.maxSteps} steps on ${ctx.job} without reaching a stop (a loop?): read factory why --format md` });
    if (ctx.steps > 1 && Date.now() - ctx.t0 > ctx.maxSeconds * 1000) return ctx.stop('yield', { job: ctx.job }, { seconds: ctx.maxSeconds });
    ctx.beat('next');
    const r = runChild(ctx, ['next']);
    const n = r.json;
    if (!n || n.error) return ctx.stop('error', { job: ctx.job }, { message: `factory next failed: ${(n && n.message) || r.stdout.slice(0, 300) || `exit ${r.code}`}`, code: n && n.code });
    ctx.lastNext = n;
    ctx.job = n.job || ctx.job;
    switch (n.action) {
      case 'workflow':
      case 'skill': {
        if (n.action === 'skill' && n.skill !== 'clarify') {
          if (n.skill === 'ship') {
            if (ctx.stopBeforeShip) return ctx.stop('ship', n);
            ctx.beat('ship');
            const s = runChild(ctx, ['ship']);
            if (!s.json || s.json.error) return ctx.stop('error', n, { message: `factory ship failed: ${(s.json && s.json.message) || `exit ${s.code}`}`, code: s.json && s.json.code });
            ctx.shipped = s.json;
            continue;
          }
          if (n.skill === 'distill') {
            ctx.beat('distill context');
            const c = runChild(ctx, ['distill', 'context']);
            if (!c.json || c.json.error) return ctx.stop('error', n, { message: `factory distill context failed: ${(c.json && c.json.message) || `exit ${c.code}`}` });
            // something to learn: the lesson writer is a subagent, the main session's to start
            if (c.json.worth_learning) return ctx.stop('agent', n, { context: c.json });
            const stop = recordLessons(ctx, null);
            if (stop) return stop;
            continue;
          }
          return ctx.stop(n.skill === 'amend' ? 'amend' : 'skill', n);
        }
        if (n.action === 'skill') {
          const c = n.clarify || {};
          if (c.error) return ctx.stop('error', n, { message: c.error });
          if (c.waiting_for_user) return ctx.stop('clarify', n);
          if (!c.run) return ctx.stop('error', n, { message: `clarify is at stage ${c.stage || 'unknown'}, which neither runs agents nor waits on the user: factory clarify status shows it` });
        }
        const args = wfargsArgs(n.action === 'skill' ? { workflow: 'clarify' } : n);
        ctx.beat(args.join(' '));
        const b = runChild(ctx, args);
        if (!b.json || b.json.error) return ctx.stop('error', n, { message: `factory ${args.join(' ')}: ${(b.json && b.json.message) || `exit ${b.code}`}`, code: b.json && b.json.code });
        return ctx.stop('workflow', n, { workflow: b.json.workflow || args[1], args: b.json });
      }
      case 'cli': {
        const w = words(n.command);
        // the router never names a human-only verb or a relay of the user's words; if one ever
        // did, the drive would not run it
        if (!w.length || HUMAN_ONLY.has(w[0]) || (w[0] === 'lessons' && ['accept', 'reject', 'promote'].includes(w[1])) || w[0] === 'answer' || (w[0] === 'clarify' && ['reply', 'redirect', 'note'].includes(w[1])) || w[0] === 'drive') {
          return ctx.stop('error', n, { message: `factory next asked for "${n.command}", which is not the drive's to run` });
        }
        ctx.beat(w.join(' '));
        const res = runChild(ctx, w);
        const key = n.command;
        if (res.code !== 0 || !res.json || res.json.error) {
          fails[key] = (fails[key] || 0) + 1;
          // a failing check (ci verify) is routed again by factory next; the same command failing
          // twice in a row with nothing else happening is a stop
          if (fails[key] >= 2 || !res.json) return ctx.stop('error', n, { message: `${n.command} failed: ${(res.json && (res.json.message || JSON.stringify(res.json).slice(0, 300))) || `exit ${res.code}`}` });
        } else fails[key] = 0;
        continue;
      }
      case 'evidence': {
        const types = {};
        for (const c of n.commands || []) {
          const m = /evidence add (AC-\d+) --type (doc|diff)/.exec(c);
          if (m) types[m[1]] = m[2];
        }
        let all = (n.acs || []).length > 0;
        for (const ac of n.acs || []) {
          const pick = types[ac] && evidencePath(ctx.root, ctx.job, ac, types[ac]);
          if (!pick) {
            all = false;
            break;
          }
          const res = runChild(ctx, ['evidence', 'add', ac, '--type', types[ac], '--path', pick.path, '--note', `factory drive: the only ${types[ac] === 'doc' ? 'documentation ' : ''}file changed by ${pick.tasks.join(', ')} (the task(s) covering ${ac}), and the criterion names it`]);
          if (!res.json || res.json.error) {
            all = false;
            break;
          }
        }
        if (!all) return ctx.stop('evidence', n);
        continue;
      }
      case 'gate':
        return ctx.stop('gate', n);
      case 'wait':
        if ((n.ready || []).length) {
          runChild(ctx, ['use', n.ready[0]], { jobId: null });
          ctx.job = n.ready[0];
          continue;
        }
        return ctx.stop('wait', n);
      case 'parked':
        return ctx.stop('parked', n);
      case 'done': {
        // a slice job of an epic is done: back to the epic
        let parent = null;
        try {
          const s = job.load(ctx.root, ctx.job);
          parent = s.parent && job.load(ctx.root, s.parent).status === 'active' ? s.parent : null;
        } catch {
          parent = null;
        }
        if (parent) {
          runChild(ctx, ['use', parent], { jobId: null });
          ctx.job = parent;
          continue;
        }
        return ctx.stop('done', n, { lessons: ctx.lessons, briefs: ctx.briefs });
      }
      case 'driving':
        return ctx.stop('error', n, { message: 'another factory drive runs this job' });
      default:
        unknown += 1;
        if (unknown > 3) return ctx.stop('error', n, { message: `factory next returned "${n.action}", which the drive does not know` });
    }
  }
}

// ---------------------------------------------------------------- the lock and the run

function acquire(root, jobId) {
  return require('./job').withLock(path.join(project(root).dir, 'drive.lock'), () => {
    const prev = readState(root);
    if (alive(prev) && prev.pid !== process.pid) {
      fail(`factory drive is already running (pid ${prev.pid}, ${prev.job}, since ${prev.started_at}): wait for it to return (factory drive status).`, 'drive_in_progress', { pid: prev.pid, job: prev.job });
    }
    const st = {
      pid: process.pid,
      host: os.hostname(),
      job: jobId,
      status: 'running',
      started_at: nowIso(),
      heartbeat_at: nowIso(),
      step: null,
      steps: 0,
      ...(prev && prev.status === 'running' ? { recovered_from: { pid: prev.pid, started_at: prev.started_at, step: prev.step || null } } : {}),
      last: prev ? prev.last || null : null,
      stops: prev ? (prev.stops || []).slice(-20) : [],
    };
    writeState(root, st);
    return st;
  }, { waitMs: 10000, staleMs: 30000, what: 'the drive lock' });
}

function drive(root, { jobId, record = null, lessons = null, maxSteps = MAX_STEPS, maxSeconds = MAX_SECONDS } = {}) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  const st = acquire(root, state.id);
  let current = st;
  const ctx = {
    root,
    job: state.id,
    steps: 0,
    t0: Date.now(),
    maxSteps: Number(maxSteps) > 0 ? Number(maxSteps) : MAX_STEPS,
    maxSeconds: Number(maxSeconds) > 0 ? Number(maxSeconds) : MAX_SECONDS,
    lessons: [],
    briefs: [],
    recorded: null,
    // policy.drive.stop_before_ship (default false): stop before factory ship instead of running it
    stopBeforeShip: (() => {
      try {
        const pol = require('../lib/util').deepMerge(require('./policy').load(root), state.policy || {});
        return Boolean(pol.drive && pol.drive.stop_before_ship === true);
      } catch {
        return false;
      }
    })(),
  };
  events.append(root, { event: 'drive_start', job: state.id, pid: process.pid, ...(record ? { record } : {}), ...(lessons ? { lessons } : {}), ...(st.recovered_from ? { recovered_from: st.recovered_from } : {}) });
  // Never write over another drive's record: one that took over (this one looked dead to it)
  // owns drive.json now.
  ctx.owns = () => {
    const now = readState(root);
    return Boolean(now && now.pid === process.pid && (now.host || '') === (st.host || ''));
  };
  const save = (patch) => {
    if (!ctx.owns()) return;
    current = { ...current, ...patch, heartbeat_at: nowIso() };
    writeState(root, current);
  };
  ctx.beat = (step) => save({ job: ctx.job, steps: ctx.steps, step });
  ctx.stop = (kind, n, extra = {}) => {
    const d = stopDetail(kind, n || {}, { job: ctx.job, ...extra });
    const rec = {
      at: nowIso(),
      job: ctx.job,
      kind,
      handoff: HANDOFF.has(kind),
      summary: d.summary,
      action: (n && n.action) || null,
      step: (n && n.step) || null,
      decision_id: (n && n.decision_id) || null,
      ...d,
      ...(extra.code ? { code: extra.code } : {}),
      ...(n && n.environment ? { environment: n.environment } : {}),
      ...(ctx.shipped && ['wait', 'done'].includes(kind) ? { ship: ctx.shipped } : {}),
      ...(ctx.recorded ? { recorded: ctx.recorded } : {}),
      steps: ctx.steps,
      // the `factory next` output at this stop, whole: the gate, park and clarify skills read
      // their fields from it (no second factory next needed)
      ...(n && n.action ? { next: n } : {}),
    };
    // A rerun that stops at the same gate, park or clarify turn again tells the human once only;
    // a hand-off to the main session tells nobody (the session is at work).
    const key = [ctx.job, kind, rec.gate ? `${rec.gate.id}:${rec.gate.hash}` : '', rec.stage || '', kind === 'parked' ? (n && n.park && n.park.at) || (n && n.reason) || '' : '', kind === 'wait' ? (n && n.reason) || '' : ''].join('|');
    const prevLast = current.last || null;
    const repeat = prevLast && prevLast.notify_key === key && ['gate', 'parked', 'clarify', 'wait', 'questions'].includes(kind);
    const sent = rec.handoff ? { method: 'none', sent: false } : repeat ? { method: 'repeat', sent: false } : require('./notify').notify(root, { title: `Factory ${ctx.job}: ${STOP_TITLE[kind] || kind}`, body: rec.summary, job: ctx.job, kind });
    rec.notified = sent.method;
    rec.notify_key = key;
    events.append(root, { event: 'drive_stop', job: ctx.job, kind, handoff: rec.handoff, summary: String(rec.summary).slice(0, 500), gate: rec.gate ? rec.gate.id : null, park_kind: rec.park ? rec.park.kind : null, stage: rec.stage || null, workflow: kind === 'workflow' ? extra.workflow || null : null, decision_id: rec.decision_id, steps: ctx.steps, notified: sent.method, sent: sent.sent === true, pid: process.pid });
    const { args: _a, context: _c, next: _n, recorded: _r, screen: _s, ...brief } = rec; // drive.json keeps the stop, not the brief
    save({ status: 'stopped', step: null, stopped_at: rec.at, last: brief, stops: [...(current.stops || []), { at: rec.at, job: ctx.job, kind, summary: rec.summary }].slice(-20) });
    if (FAILURE.has(kind)) process.exitCode = 1;
    return rec;
  };
  try {
    if (record) {
      const stop = recordEnvelope(ctx, path.resolve(root, record));
      if (stop) return stop;
    }
    if (lessons) {
      const stop = recordLessons(ctx, path.resolve(root, lessons));
      if (stop) return stop;
    }
    return loop(ctx);
  } catch (e) {
    return ctx.stop('error', ctx.lastNext || { job: ctx.job }, { message: `drive failed: ${e.message}` });
  }
}

function statusView(root) {
  const st = readState(root);
  if (!st) return { status: 'none', message: 'No factory drive has run in this repository.' };
  const live = alive(st);
  const status = st.status === 'running' && !live ? 'crashed' : st.status;
  return {
    status,
    job: st.job,
    pid: st.pid,
    alive: live,
    started_at: st.started_at,
    step: live ? st.step || null : null,
    steps: st.steps || 0,
    last: st.last || null,
    stops: (st.stops || []).slice(-5),
    message: status === 'running'
      ? `Running ${st.job}${st.step ? `: ${st.step}` : ''}.`
      : status === 'crashed'
        ? `The drive for ${st.job} (pid ${st.pid}) is gone without a stop (a tool timeout or a kill). Run factory drive again: it continues from where the job is.`
        : st.last ? `Stopped (${st.last.kind}): ${st.last.summary}` : 'Stopped.',
  };
}

function status(root) {
  const v = statusView(root);
  try {
    events.append(root, { event: 'drive_status_viewed', job: v.job || null, status: v.status });
  } catch {
    /* a look, best effort */
  }
  return v;
}

module.exports = { drive, status, statusView, liveFor, isDriveChild, drivingAnswer, readState, words, wfargsArgs, evidencePath, stopDetail, alive, driveFile, HANDOFF, MAX_SECONDS };
