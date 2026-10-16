'use strict';
// factory — the Software Factory CLI. The only writer of factory state.
// Output is JSON on stdout (or markdown with --format md where offered).
// Exit code 0 = ok, 1 = refused or failed (the JSON says why).

const fs = require('fs');
const path = require('path');
const { FactoryError, fail, readText, writeJson } = require('./lib/util');
const { requireRoot, findRoot, PLUGIN_ROOT } = require('./lib/paths');

const { BOOL } = require('./lib/args'); // shared with the guard hook's command reader

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (eq !== -1) opt[key] = a.slice(eq + 1);
      else if (BOOL.has(key)) opt[key] = true;
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) opt[key] = true;
        else {
          opt[key] = v;
          i += 1;
        }
      }
    } else pos.push(a);
  }
  return { pos, opt };
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const HELP = `factory — Software Factory CLI (plugin at ${PLUGIN_ROOT})

Setup      init [--base <branch>] · doctor · ci install
Jobs       job new --title "…" --type <work type> --risk low|medium|high [--epic] [--request "<the user's words>"] · job show · job list · use <job>
Routing    next · why [--format md] · finalize [--mode before_ship|full] [--check]
Drive      drive [--record <envelope.json>] [--lessons <reply.json>] [--max-seconds 480] [--max-steps 200]
           (steps the job itself: CLI steps, briefs, records, ship, distill, evidence it can check; returns a typed stop:
           a workflow or the lesson writer for the main session, or a gate, clarify turn, park or done for you, notified)
           drive status · inbox [--format md]   (everything waiting on you, across jobs)
Contract   contract show · contract check [--plan-fields]
           answer "<the user's words>"   (during clarify: the same as clarify reply; after H1: answer --question "…" --answer "…")
Clarify    clarify reply "<the user's words>"   (read-back ok or edit, sheet answers, a redirect's ok; not a gate verb)
           clarify redirect "<the user's words>"   (change course at any time before H1: read back, then restarted)
           clarify status [--json] [--h1]   (stage, items with strength and source, the sheet, failures, checks; --h1 the H1 view)
           clarify note "<text>"   (the same as clarify reply) · clarify split   (v3 keeps no folded issues: says so)
Workflows  wfargs <clarify|ground|fanout-judge|decompose|realize|reconcile> [--config decide|challenge] [--mode m] [--scope s] [--lanes a,b]
           [--threat-model | --no-threat-model] [--plan-critique] [--accept-degraded] [--out file]
           record --file <envelope.json | ->
Env        env show · env check [--proposed]   (the build environment each worktree runs in; read-only)
           env propose --file f   (the main session's proposal) · env prepare <T|job>   (set it up in one worktree; task start does it)
Plan       plan validate · plan from-contract
Tasks      task start <T> · task show <T> · task verify <T> · task built <T> --status done|blocked [--reason r]   (the builder's last step)
           task state <T> blocked|exhausted [--reason]
Build      reconcile run|continue|abort · verify run · evidence add <AC> --type diff|doc [--path p] [--note n]
Ship       report · ship [--local] · pr sync · ci verify [--manifest-dir d | --commit sha] · close
Change     amend start --reason "…" [--by who] · amend submit · park --reason "…" · followup
Epic       epic spawn · epic gate
Docs       doc list · doc template <type> · doc check [<file>] [--type t] [--job J] · doc index
           (templates/docs: adr, no-adr, recommendation, threat-model, contracts, findings, ship-report, lessons, index)
Learning   distill context · distill done [--result <reply.json | - | json>] · lessons list · lessons add --text "…" --scope "glob,…" [--why "…"]
           telemetry report [--since 30] [--format md] · recipe list|show <id>|check|select --type t --risk r [--epic]
Console    console [--out file.html] [--job J] [--label "…"] [--data data.json]   (read-only page of every job)
           console --serve [--port 4477] [--job J]   (the same page, live: updates as Claude works)
Human only (your terminal, or reply in chat):
           approve [gate] · deny --reason "…" · resume [step] · proceed (after a clarify cap: go on, gaps shown) · cancel · abandon · waive <floor> --reason "…"
           merged <commit> · confirm <AC> · lessons accept|reject <L|P> · lessons promote <L> --check "cmd" · reseal
           (a P<n> is a project brief change distill proposed; chat: accept brief P1 · reject brief P1 <why>)
           env set [--file f | --none] [hash]   (confirm the build environment; chat: confirm environment <hash|none>)
           finding accept|dismiss <id> --reason "…"   (a serious finding no verifier settled; chat: dismiss finding code-1 <reason>)
Global     --root <repo> · --job <J-0001>`;

const LONG_RUNNING = Symbol('long-running'); // the command reports for itself (console --serve)

function out(obj, opt) {
  if (opt.format === 'md' && typeof obj === 'string') process.stdout.write(obj + '\n');
  else process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function run(argv) {
  const { pos, opt } = parseArgs(argv);
  if (opt.root) process.env.FACTORY_ROOT = path.resolve(opt.root);
  const cmd = pos[0];
  const sub = pos[1];
  const R = () => requireRoot(opt.root);
  const J = opt.job;
  const tty = 'tty';
  const C = (m) => require(`./core/${m}`);

  switch (cmd) {
    case undefined:
    case 'help':
      return HELP;
    case 'init':
      return C('setup').init(opt.root || process.cwd(), { baseBranch: opt.base });
    case 'doctor':
      return C('setup').doctor(opt.root || process.cwd());
    case 'console':
      if (opt.serve) { C('console').runServe(R(), { port: opt.port, job: J, label: opt.label }); return LONG_RUNNING; } // prints its own URL once listening
      return C('console').run(R(), { out: opt.out, job: J, label: opt.label, data: opt.data });
    case 'job': {
      const job = C('job');
      if (sub === 'new') {
        if (!opt.title || !opt.type || !opt.risk) fail('job new needs --title, --type and --risk', 'bad_input');
        const s = job.create(R(), { title: opt.title, workType: opt.type, risk: opt.risk, epic: Boolean(opt.epic), request: typeof opt.request === 'string' ? opt.request : null });
        return { job: s.id, recipe: `${s.recipe.id} v${s.recipe.version}`, risk: s.risk, risk_raised_by_policy: s.risk !== s.risk_proposed, branch: s.branch, contract: path.join(R(), '.factory', 'jobs', s.id, 'contract.md'), next: 'factory next' };
      }
      if (sub === 'show') return job.resolve(R(), J);
      if (sub === 'list') {
        const root = R();
        return job.listJobIds(root).map((id) => {
          const s = job.load(root, id);
          return { job: id, title: s.title, status: s.status, recipe: s.recipe.id, risk: s.risk, parent: s.parent, gate: s.pending_gate && s.pending_gate.id };
        });
      }
      return fail('job new | show | list', 'bad_input');
    }
    case 'use': {
      const root = R();
      C('job').load(root, sub);
      C('job').setCurrent(root, sub);
      return { current: sub };
    }
    case 'next': {
      // While factory drive steps the job, anyone else's factory next would race it: say so.
      const root = R();
      const live = C('drive').liveFor(root);
      if (live && !C('drive').isDriveChild(live)) {
        const id = J || C('job').current(root);
        if (!id || !live.job || live.job === id) return C('drive').drivingAnswer(live, id);
      }
      return C('decision-table').decide(root, J);
    }
    case 'drive': {
      const D = C('drive');
      if (sub === 'status') return D.status(R());
      if (sub !== undefined) return fail('drive [--record <envelope.json>] [--lessons <reply.json>] | drive status', 'bad_input');
      const file = (k) => (typeof opt[k] === 'string' ? opt[k] : opt[k] === true ? fail(`--${k} needs a file`, 'bad_input') : null);
      return D.drive(R(), { jobId: J, record: file('record'), lessons: file('lessons'), maxSteps: opt['max-steps'], maxSeconds: opt['max-seconds'] });
    }
    case 'inbox': {
      const r = C('inbox').list(R());
      return opt.format === 'md' ? C('inbox').markdown(r) : r;
    }
    case 'why': {
      const w = C('lifecycle').why(R(), { jobId: J });
      return opt.format === 'md' ? C('lifecycle').whyMarkdown(w) : w;
    }
    case 'finalize': {
      const r = C('lifecycle').finalize(R(), { jobId: J, mode: opt.mode || 'full' });
      if (opt.check && !r.ok) process.exitCode = 1;
      return r;
    }
    case 'contract': {
      const root = R();
      const state = C('job').resolve(root, J);
      const c = C('contract');
      const parsed = c.parse(c.read(root, state.id));
      if (sub === 'show') return parsed;
      if (sub === 'check') {
        const problems = c.problems(parsed, { requirePlanFields: Boolean(opt['plan-fields']) });
        if (problems.length) process.exitCode = 1;
        return { job: state.id, ok: problems.length === 0, problems };
      }
      return fail('contract show | check', 'bad_input');
    }
    case 'answer': {
      // factory answer "<the user's words>" | <n|D-n.n> "<words>" | --default | --question "…" --answer "…"
      const idLike = (x) => x && /^([UQ]-\d+|D-\d+\.\d+|\d{1,2})$/i.test(x);
      const ref = idLike(sub) ? sub : opt.id;
      const text = opt.answer || (idLike(sub) ? pos.slice(2).join(' ') : pos.slice(1).join(' ')) || '';
      return C('record').answer(R(), { jobId: J, ref, question: opt.question, answer: text, acceptDefault: Boolean(opt.default) });
    }
    case 'clarify':
      if (sub === 'status') return C('clarify').status(R(), { jobId: J, json: Boolean(opt.json), h1: Boolean(opt.h1) });
      if (sub === 'reply' || sub === 'note') return C('clarify').reply(R(), { jobId: J, text: opt.text || pos.slice(2).join(' ') });
      if (sub === 'redirect') return C('clarify').redirect(R(), { jobId: J, text: opt.text || pos.slice(2).join(' ') });
      if (sub === 'split') return C('clarify').split(R(), { jobId: J });
      return fail('clarify reply "<words>" | clarify redirect "<words>" | clarify status [--json] [--h1]', 'bad_input');
    case 'wfargs': {
      const brief = C('wfargs').build(R(), {
        jobId: J,
        workflow: sub,
        config: opt.config,
        mode: opt.mode,
        scope: opt.scope,
        lanes: opt.lanes,
        threatModel: opt['threat-model'] ? true : opt['no-threat-model'] ? false : undefined,
        planCritique: opt['plan-critique'] ? true : undefined,
        acceptDegraded: Boolean(opt['accept-degraded']),
      });
      C('wfrun').start(R(), brief); // the run's start, for the console's step list (logged once the brief is made)
      if (opt.out) {
        writeJson(path.resolve(opt.out), brief);
        return { written: path.resolve(opt.out), workflow: brief.workflow, config: brief.config || null, bytes: fs.statSync(path.resolve(opt.out)).size };
      }
      return brief;
    }
    case 'record': {
      const file = opt.file;
      if (!file) fail('record --file <envelope.json | ->', 'bad_input');
      const envelope = file === '-' ? JSON.parse(readStdin()) : JSON.parse(readText(path.resolve(file), 'null'));
      return C('record').apply(R(), { jobId: J, envelope });
    }
    case 'plan': {
      const root = R();
      const state = C('job').resolve(root, J);
      if (sub === 'validate') {
        const r = C('plan').validate(root, state);
        if (!r.valid) process.exitCode = 1;
        return { job: state.id, ...r };
      }
      if (sub === 'from-contract') return C('plan').fromContract(root, state);
      return fail('plan validate | from-contract', 'bad_input');
    }
    case 'task': {
      const t = C('tasks');
      const id = pos[2];
      if (!id) fail('task <start|show|verify|built|state> <T1>', 'bad_input');
      if (sub === 'start') return t.start(R(), J, id);
      if (sub === 'show') return t.show(R(), J, id);
      if (sub === 'verify') {
        const r = t.verifyRecorded(R(), J, id);
        if (!r.pass) process.exitCode = 1;
        return r;
      }
      if (sub === 'state') return t.setState(R(), J, id, pos[3], opt.reason);
      if (sub === 'built') {
        // The builder's last step: what this attempt's builder replies (the guard lets only a
        // factory:builder agent run it). task verify counts only an attempt recorded done.
        const status = String(opt.status || '');
        if (!['done', 'blocked'].includes(status)) fail('task built <T1> --status done|blocked [--reason needs_paths|dependency_conflict|environment_broken] [--summary "…"]', 'bad_input');
        if (opt.reason && !['needs_paths', 'dependency_conflict', 'environment_broken'].includes(opt.reason)) fail('--reason is needs_paths, dependency_conflict or environment_broken', 'bad_input');
        const jid = C('job').resolve(R(), J).id;
        t.afterBuilder(R(), jid, id, { status, summary: opt.summary || '', ...(status === 'blocked' && opt.reason ? { blocked_reason: opt.reason } : {}) }, { label: `build ${id}` });
        return { job: jid, task: id, recorded: (C('job').load(R(), jid).tasks[id] || {}).builder || null };
      }
      return fail('task start | show | verify | built | state', 'bad_input');
    }
    case 'reconcile': {
      const r = C('reconcile');
      if (sub === 'run') return r.run(R(), J);
      if (sub === 'continue') return r.cont(R(), J);
      if (sub === 'abort') return r.abort(R(), J);
      if (sub === 'wave') {
        // after each realize wave (P2.3): run by the integrator, relayed to the workflow
        const ids = String(opt.tasks || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (!ids.length) fail('reconcile wave --tasks T1,T2 [--wave n]', 'bad_input');
        const res = r.integrateWave(R(), J, ids, { wave: opt.wave ? Number(opt.wave) : null });
        if (!res.ok) process.exitCode = 1;
        return res;
      }
      return fail('reconcile run | continue | abort | wave --tasks T1,T2', 'bad_input');
    }
    case 'verify':
      if (sub !== 'run') fail('verify run', 'bad_input');
      return C('verify').run(R(), J);
    case 'evidence':
      if (sub !== 'add' || !pos[2]) fail('evidence add <AC> --type diff|doc [--path p]', 'bad_input');
      return C('verify').addEvidence(R(), { jobId: J, ac: pos[2], type: opt.type, path: opt.path, note: opt.note });
    case 'report': {
      const root = R();
      const state = C('job').resolve(root, J);
      const steps = C('steps');
      const ctx = steps.context(root, state, C('job').load);
      return { job: state.id, report: C('ship').report(root, state, ctx, C('floors').evaluate(ctx, 'before_ship')) };
    }
    case 'ship':
      return C('ship').ship(R(), { jobId: J, local: Boolean(opt.local), title: opt.title });
    case 'pr':
      if (sub !== 'sync') fail('pr sync', 'bad_input');
      return C('ship').prSync(R(), { jobId: J });
    case 'ci': {
      if (sub === 'install') return C('ship').ciInstall(R());
      if (sub === 'verify') {
        const r = opt['manifest-dir'] ? C('ship').ciVerify(null, { manifestDir: opt['manifest-dir'] }) : C('ship').ciVerify(R(), { jobId: J, commit: opt.commit });
        if (!r.ok) process.exitCode = 1;
        return r;
      }
      return fail('ci install | verify', 'bad_input');
    }
    case 'close':
      return C('lifecycle').close(R(), { jobId: J });
    case 'followup':
      return C('lifecycle').followup(R(), { jobId: J, findings: opt['findings-file'] ? JSON.parse(readText(path.resolve(opt['findings-file']))) : [], workType: opt.type });
    case 'doc': {
      const d = C('doc');
      if (sub === 'list') return d.list();
      if (sub === 'template') {
        if (!pos[2]) fail('doc template <type>', 'bad_input');
        return d.template(pos[2]).replace(/\n$/, '');
      }
      if (sub === 'check') {
        let r;
        if (pos[2]) {
          // A file in a job folder is checked against that job (its ACs, threat ids, job id).
          const file = path.resolve(pos[2]);
          const root = findRoot(path.dirname(file)) || (opt.root ? path.resolve(opt.root) : null);
          const jobId = J || (root && (/[\\/]\.factory[\\/]jobs[\\/](J-\d+)[\\/]/.exec(file) || [])[1]);
          const extra = root && jobId ? d.jobOpts(root, C('job').resolve(root, jobId), file) : {};
          r = d.checkFile(file, { type: opt.type, ...extra });
        } else r = d.checkJob(R(), J);
        if (!r.ok) process.exitCode = 1;
        return r;
      }
      if (sub === 'index') return d.index(R(), { jobId: J });
      return fail('doc list | template <type> | check [<file>] | index', 'bad_input');
    }
    case 'distill':
      if (sub === 'context') {
        const ctx = C('lifecycle').distillContext(R(), { jobId: J });
        C('wfrun').start(R(), { job: ctx.job, workflow: 'distill' }); // the lesson-writer's run, if the skill starts it
        return ctx;
      }
      if (sub === 'done') {
        // --result: the lesson writer's final message (a file, - for stdin, or inline JSON).
        const res = opt.result === undefined ? undefined : opt.result === '-' ? readStdin() : fs.existsSync(String(opt.result)) ? fs.readFileSync(String(opt.result), 'utf8') : String(opt.result);
        const done = C('lifecycle').distillDone(R(), { jobId: J, result: res });
        C('wfrun').end(R(), { job: done.job, workflow: 'distill', outcome: 'ok', status: done.nothing_to_learn ? 'nothing_to_learn' : 'ok', roster: res === undefined ? [] : [{ agent_type: 'factory:lesson-writer', label: 'lesson-writer', outcome: 'ok' }] });
        return done;
      }
      return fail('distill context | done', 'bad_input');
    case 'lessons': {
      const l = C('lessons');
      if (sub === 'list') return l.load(R());
      if (sub === 'add') return l.add(R(), { jobId: J || C('job').current(R()), text: opt.text, scope: opt.scope, why: opt.why });
      // a project brief proposal (P<n>, from distill) is accepted like a lesson: human-only
      if ((sub === 'accept' || sub === 'reject') && /^P\d+$/i.test(pos[2] || '')) return C('project-brief').decide(R(), { id: pos[2], accept: sub === 'accept', reason: opt.reason, channel: tty });
      if (sub === 'accept' || sub === 'reject') return l.decide(R(), { id: pos[2], accept: sub === 'accept', reason: opt.reason, channel: tty });
      if (sub === 'promote') return l.promote(R(), { id: pos[2], check: opt.check, channel: tty });
      return fail('lessons list | add | accept | reject | promote', 'bad_input');
    }
    case 'amend': {
      const a = C('amend');
      if (sub === 'start') return a.start(R(), { jobId: J, reason: opt.reason, by: opt.by });
      if (sub === 'submit') return a.submit(R(), { jobId: J });
      return fail('amend start | submit', 'bad_input');
    }
    case 'park': {
      if (!opt.reason) fail('park --reason "…"', 'bad_input');
      const root = R();
      const s = C('job').resolve(root, J);
      C('decision-table').park(root, s, opt.reason, 'manual');
      return { job: s.id, status: 'parked', reason: opt.reason };
    }
    case 'epic': {
      if (sub === 'spawn') return C('epic').spawn(R(), { jobId: J });
      if (sub === 'gate') return C('epic').gate(R(), { jobId: J });
      return fail('epic spawn | gate', 'bad_input');
    }
    case 'telemetry': {
      if (sub !== 'report') fail('telemetry report', 'bad_input');
      const r = C('telemetry').report(R(), { sinceDays: parseInt(opt.since || '30', 10) });
      return opt.format === 'md' ? C('telemetry').toMarkdown(r) : r;
    }
    case 'recipe': {
      const r = C('recipes');
      if (sub === 'list') return r.listIds().map((id) => {
        const x = r.load(id);
        return { id, version: x.version, status: x.status, outcome: x.outcome, description: x.description, steps: x.steps.map((s) => s.step) };
      });
      if (sub === 'show') return r.load(pos[2]);
      if (sub === 'check') {
        const rep = r.checkAll();
        if (Object.values(rep).some((e) => e.length)) process.exitCode = 1;
        return rep;
      }
      if (sub === 'select') return { recipe: r.select({ workType: opt.type, risk: opt.risk, epic: Boolean(opt.epic) }) };
      return fail('recipe list | show <id> | check | select', 'bad_input');
    }
    // ---- human-only, from your terminal
    case 'approve':
      return C('human').approve(R(), { jobId: J, gate: sub, channel: tty });
    case 'deny':
      return C('human').deny(R(), { jobId: J, reason: opt.reason || pos.slice(1).join(' '), channel: tty });
    case 'proceed':
      return C('clarify').proceed(R(), { jobId: J, channel: tty });
    case 'resume':
      return C('human').resume(R(), { jobId: J, step: sub, channel: tty });
    case 'cancel':
      return C('human').stop(R(), { jobId: J, kind: 'cancelled', channel: tty, reason: opt.reason });
    case 'abandon':
      return C('human').stop(R(), { jobId: J, kind: 'abandoned', channel: tty, reason: opt.reason });
    case 'waive':
      return C('human').waive(R(), { jobId: J, floor: sub, reason: opt.reason, channel: tty });
    case 'merged':
      return C('human').merged(R(), { jobId: J, commit: sub, channel: tty });
    case 'confirm':
      return C('human').confirmAc(R(), { jobId: J, ac: sub, channel: tty });
    case 'env': {
      const E = C('environment');
      if (sub === 'show') return E.show(R());
      if (sub === 'check') {
        const r = E.check(R(), { proposed: Boolean(opt.proposed) });
        if (!r.ok) process.exitCode = 1;
        return r;
      }
      if (sub === 'propose') return E.propose(R(), { file: opt.file });
      if (sub === 'set') return C('human').setEnvironment(R(), { file: opt.file, none: Boolean(opt.none), expectHash: pos[2] || null, channel: tty });
      if (sub === 'prepare') {
        // the environment set up in one worktree (task start does this for its builder)
        const root = R();
        const state = C('job').resolve(root, J);
        const id = pos[2];
        if (!id) fail('env prepare <T1|job>', 'bad_input');
        const conf = E.load(root);
        if (!conf || conf.name === 'none' || (!(conf.setup || []).length && !conf.services && !Object.keys(conf.env || {}).length && !conf.prefix)) return { job: state.id, task: id, ok: true, none: true };
        const wt = id === 'job' ? C('tasks').ensureJobWorktree(root, state) : C('tasks').prepareWorktree(root, state, id);
        const r = E.ensure(root, state, { taskId: id === 'job' ? null : id, wt });
        if (!r.ok) process.exitCode = 1;
        return { job: state.id, task: id, ok: r.ok, ...(r.ok ? { cached: r.cached, ran: r.ran, name: r.env ? r.env.name || null : null, env: E.processEnv(r.env, r.vars) } : { broken: r.broken, message: r.broken.reason }) };
      }
      return fail('env show | check [--proposed] | propose --file f | set [--file f | --none] [hash]', 'bad_input');
    }
    case 'finding':
      if (!['accept', 'dismiss'].includes(sub) || !pos[2]) fail('finding accept|dismiss <id> --reason "…"', 'bad_input');
      return C('human').settleFinding(R(), { jobId: J, id: pos[2], decision: sub, reason: opt.reason || pos.slice(3).join(' '), channel: tty });
    case 'reseal':
      C('human').requireHumanChannel(tty);
      if (J || C('job').current(R())) C('human').confirmTyped(tty, J || C('job').current(R()), 'reseal it');
      return C('job').reseal(R(), J || C('job').current(R()));
    default:
      return fail(`Unknown command "${cmd}". Run factory help.`, 'bad_input');
  }
}

const PROSE = new Set(['reason', 'text', 'question', 'answer', 'title', 'note', 'by', 'check', 'label', 'why', 'request']);

// One sealed line per command in .factory/log/events.jsonl, tied to the job and the
// routing decision in force, so an auditor can check Claude did what factory next said.
function logCommand(argv, res, err) {
  try {
    const { pos, opt } = parseArgs(argv);
    // console is read-only: it leaves no trace (doc is logged; the inspector counts it read-only);
    // inbox and drive log their own events (inbox_viewed, drive_start / drive_stop), and every step
    // the drive runs is its own command line, logged with via "drive"
    if (['help', 'console', 'inbox', 'drive', undefined].includes(pos[0])) return;
    const root = findRoot(opt.root ? path.resolve(opt.root) : process.cwd());
    if (!root) return;
    const events = require('./core/events');
    const jobId = opt.job || (res && typeof res === 'object' && (res.job || null)) || null;
    const ctx = events.context(root, jobId);
    const args = {};
    for (const [k, v] of Object.entries(opt)) args[k] = PROSE.has(k) && typeof v === 'string' ? `${v.slice(0, 60)}${v.length > 60 ? '…' : ''}` : v;
    // answers and notes are prose: their positional text is clipped like --answer
    const proseArg = (pos[0] === 'answer' || (pos[0] === 'clarify' && ['note', 'reply', 'redirect'].includes(pos[1]))) && pos.length > 2;
    const r = res && typeof res === 'object' ? res : {};
    const extra = {};
    if (pos[0] === 'wfargs') Object.assign(extra, { workflow: r.workflow || pos[1] || null, config: r.config || opt.config || null, mode: r.mode || null, brief_hash: r.input_hash || null });
    if (pos[0] === 'record') Object.assign(extra, { workflow: r.workflow || null, config: r.config || null, status: r.status || null });
    if (pos[0] === 'next') Object.assign(extra, { action: r.action || null, step: r.step || null });
    events.append(root, {
      event: 'cli',
      cmd: pos[0],
      sub: pos[1] || null,
      arg: proseArg ? `${pos.slice(2).join(' ').slice(0, 60)}` : pos[2] || null,
      args,
      job: ctx.job,
      how: ctx.how,
      decision_id: r.decision_id || ctx.decision_id,
      ok: !err && process.exitCode !== 1 && process.exitCode !== 2,
      code: err ? err.code || 'internal' : null,
      ...(process.env.FACTORY_DRIVE ? { via: 'drive' } : {}),
      ...extra,
    });
  } catch {
    /* never let logging break a command */
  }
}

function main(argv) {
  const { opt } = parseArgs(argv);
  let res = null;
  let err = null;
  try {
    res = run(argv);
    if (typeof res === 'string') process.stdout.write(res + '\n');
    else if (res !== LONG_RUNNING) out(res, opt);
  } catch (e) {
    err = e;
    if (e instanceof FactoryError) {
      out({ error: true, code: e.code, message: e.message, details: e.details }, {});
      process.exitCode = 1;
    } else {
      out({ error: true, code: 'internal', message: e.message, stack: String(e.stack).split('\n').slice(0, 6) }, {});
      process.exitCode = 2;
    }
  }
  logCommand(argv, res, err);
}

module.exports = { main, run, parseArgs, findRoot, BOOL };
