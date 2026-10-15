// ===================================================================== workflow runs, step by step
// One file, read by two sides: the CLI (`factory console`, require()) and the page itself
// (console/build.js puts it into console.html, before the Blueprint), so the step list the page
// shows while replaying is folded by the same code, from the same templates, as the data.
//
// A run is one workflow the skills start in Claude Code's Workflow tool (or by hand with the
// Agent tool), or one distill. A workflow script cannot run a command or write a file, and the
// Workflow tool shows its phase(...) calls to no hook, so the steps are not logged as they start:
// they are worked out here from what does reach .factory/log/events.jsonl live:
//   workflow_start  { wf_run, job, decision_id, workflow, config, mode, round, plan }   `factory wfargs` / `factory distill context`
//   SubagentStart / SubagentStop  { agent_id, agent_type, job, decision_id }            the hooks, one per agent as it starts and stops
//   PostToolUse     { agent_id, target: "… task start T3 --job …" }                    a builder or tester naming its task (realize's waves)
//   workflow_end    { wf_run, job, decision_id, workflow, config, outcome, status, roster }  `factory record` / `factory distill done`
// `plan` is what the brief holds (how many agents each step starts, realize's waves), and the
// order of the steps is fixed per workflow (TEMPLATES): each agent that starts goes to the step
// its role belongs to, from the step in force onwards. The roster in workflow_end (each agent's
// label and how it came back) then marks failures and retries. fromEvents() turns the lines into
// runs, with the steps as phases, the same shape the page folds; view(run, t) is the step list as
// it stood at time t.
//
// TEMPLATES: the steps each workflow config takes, in the order its source runs them
// (plugins/factory/workflows/*.js). `match` is tested against the phase(...) text; `text` writes
// the phase text the script would print for the step (n agents planned, k-th time the step
// starts); a step the run passes without starting is "skipped", one it has not reached yet
// "pending". tests/console.test.js keeps them honest to the workflow code and the configs.
var RUN_STEPS = (function () {
  var TEMPLATES = {
    // fanout-judge.js, clarify: the intent gate alone → the other angles (held back while the intent is open) → judge → God Eye (intent)
    'fanout-judge:clarify': {
      next: 'your answers or H1',
      steps: [
        { key: 'gate', label: 'intent gate', match: /^clarify: intent gate/, roles: ['intent-analyst'], capped: true, text: function (n) { return 'clarify: intent gate (' + n + ')'; } },
        { key: 'fanout', label: 'fan-out', match: /^clarify: fan-out/, roles: ['intent-analyst'], capped: true, text: function (n) { return 'clarify: fan-out (' + n + ')'; } },
        // the judge runs again, on all angles, when it finds the intent clear after the gate held the others back
        { key: 'judge', label: 'judge', match: /^clarify: judge/, roles: ['judge'], text: function (n, k) { return k > 1 ? 'clarify: judge (all angles)' : 'clarify: judge'; } },
        { key: 'god-eye', label: 'God Eye (intent)', match: /^clarify: God Eye/, roles: ['god-eye'], text: function () { return 'clarify: God Eye (intent)'; } },
      ],
    },
    // fanout-judge.js, decide: options (and the threat model) → architect → God Eye rounds, the architect revising between them
    'fanout-judge:decide': {
      next: 'H2',
      steps: [
        { key: 'fanout', label: 'options', match: /^decide: fan-out/, roles: ['option-generator', 'threat-modeler'], text: function (n) { return 'decide: fan-out (' + n + ')'; } },
        { key: 'architect', label: 'architect decides', match: /^decide: architect$/, roles: ['architect'], text: function () { return 'decide: architect'; } },
        { key: 'god-eye', label: 'God Eye (design)', match: /^decide: God Eye/, roles: ['god-eye'], text: function (n, k) { return 'decide: God Eye (design) round ' + k; } },
        { key: 'revise', label: 'architect revises', match: /^decide: architect revises/, roles: ['architect'], optional: true, text: function (n, k) { return 'decide: architect revises (round ' + k + ')'; } },
      ],
    },
    // fanout-judge.js, challenge: one reviewer per lane → a verifier per serious finding
    'fanout-judge:challenge': {
      next: 'the verdict per lane',
      steps: [
        { key: 'fanout', label: 'review lanes', match: /^challenge: fan-out/, roles: ['code-reviewer', 'test-reviewer', 'security-reviewer', 'ux-reviewer', 'epic-reviewer'], text: function (n) { return 'challenge: fan-out (' + n + ')'; } },
        { key: 'verify', label: 'verify findings', match: /^challenge: verify/, roles: ['finding-verifier'], text: function () { return 'challenge: verify findings'; } },
      ],
    },
    // ground.js: the probes in parallel
    ground: { next: 'decide', steps: [{ key: 'probes', label: 'research probes', match: /^ground:/, roles: ['researcher'], text: function (n) { return 'ground: ' + n + ' probe(s)'; } }] },
    // decompose.js: planner rounds until valid → God Eye (plan) rounds, the planner revising inside each; a step starts again
    // (`rounds`) when one of those roles comes back to it: one planner, or one God Eye, per round
    decompose: {
      next: 'plan validate, then H3',
      steps: [
        { key: 'planner', label: 'planner', match: /^decompose: (?!God Eye)/, roles: ['planner', 'slicer'], rounds: ['planner', 'slicer'], text: function (n, k, run) { return 'decompose: ' + (run.mode || 'plan') + ' round ' + k; } },
        { key: 'god-eye', label: 'God Eye (plan)', match: /^decompose: God Eye/, roles: ['god-eye', 'planner', 'slicer'], rounds: ['god-eye'], optional: true, text: function (n, k) { return 'decompose: God Eye (plan) round ' + k; } },
      ],
    },
    // realize.js: wave by wave, builders then testers per task (a wave whose tasks were all skipped has no phase);
    // the wave of an agent is the one holding the task it names (`factory task start|verify|show <id>`)
    realize: { next: 'reconcile', steps: [{ key: 'wave', label: 'wave', match: /^realize: wave/, roles: ['builder', 'tester'], series: /wave (\d+)\/(\d+)/, text: function (n, k, run, w) { var ws = (run.plan && run.plan.waves) || []; return 'realize: wave ' + (w + 1) + '/' + Math.max(ws.length, w + 1) + ' (' + (ws[w] || []).join(', ') + ')'; } }] },
    // reconcile.js: the integrator
    reconcile: { next: 'prove', steps: [{ key: 'integrate', label: 'integrate task branches', match: /^reconcile:/, roles: ['integrator'], text: function () { return 'reconcile: integrate task branches'; } }] },
    // the distill skill: the lesson-writer, between `factory distill context` and `factory distill done`
    distill: { next: 'distill done, then close', steps: [{ key: 'write', label: 'write lessons', match: /^distill:/, roles: ['lesson-writer'], text: function () { return 'distill: write lessons'; } }] },
  };
  var BAD = { fail: 1, no_result: 1, blocked: 1, failed: 1, exhausted: 1, error: 1, timeout: 1, invalid: 1 };
  var ms = function (s) { var v = Date.parse(s); return isNaN(v) ? null : v; };
  var roleOf = function (t) { return String(t || '').replace(/^factory:/, ''); };

  function templateKey(workflow, config) {
    if (TEMPLATES[workflow + ':' + config]) return workflow + ':' + config;
    return TEMPLATES[workflow] ? workflow : null;
  }
  function templateOf(run) { var k = run && (run.template || templateKey(run.workflow, run.config)); return k ? TEMPLATES[k] : null; }
  function matchStep(tpl, text) {
    if (!tpl) return -1;
    for (var i = 0; i < tpl.steps.length; i++) if (tpl.steps[i].match.test(String(text || ''))) return i;
    return -1;
  }
  // the phase text in plain words: "ground: 4 probe(s)" → "4 probes", "realize: wave 2/3 (T3, T4)" → "wave 2 of 3: T3, T4"
  function cleanText(text) {
    return String(text || '').replace(/^[a-z-]+: /, '')
      .replace(/(\d+) ([A-Za-z-]+)\(s\)/g, function (_, n, w) { return n + ' ' + w + (n === '1' ? '' : 's'); })
      .replace(/\(s\)/g, 's')
      .replace(/^wave (\d+)\/(\d+) \((.+)\)$/, 'wave $1 of $2: $3')
      .replace(/^wave (\d+)\/(\d+) \(\)$/, 'wave $1 of $2');
  }

  // ------------------------------------------------------------ what the brief says will run (CLI side, `factory wfargs`)
  // The agents each step starts, by step key (0: the step does not run in this brief), and realize's waves.
  function planOf(brief) {
    var b = brief || {}, fan = Array.isArray(b.fanout) ? b.fanout : [], p = {};
    if (b.workflow === 'fanout-judge' && b.config === 'clarify') {
      var gate = fan.filter(function (f) { return f.gate || f.category === 'intent'; }).length;
      p = { gate: gate, fanout: fan.length - gate, judge: b.judge ? 1 : 0, 'god-eye': b.critique ? 1 : 0 };
    } else if (b.workflow === 'fanout-judge' && b.config === 'decide') {
      p = { fanout: fan.length, architect: b.judge ? 1 : 0, 'god-eye': b.critique ? null : 0, revise: b.critique && b.critique.revise ? null : 0 };
    } else if (b.workflow === 'fanout-judge' && b.config === 'challenge') {
      p = { fanout: fan.length, verify: b.verifier ? null : 0 };
    } else if (b.workflow === 'ground') {
      p = { probes: Array.isArray(b.probes) ? b.probes.length : null };
    } else if (b.workflow === 'decompose') {
      p = { planner: null, 'god-eye': b.critique ? null : 0 };
    } else if (b.workflow === 'realize') {
      var waves = (Array.isArray(b.waves) ? b.waves : []).map(function (w) { return (Array.isArray(w) ? w : []).map(String); });
      return { steps: { wave: null }, waves: waves };
    } else if (b.workflow === 'reconcile') {
      p = { integrate: 1 };
    } else if (b.workflow === 'distill') {
      p = { write: 1 };
    }
    return { steps: p };
  }

  // ------------------------------------------------------------ the log → runs (CLI side)
  // events: the job's lines in log order. Lines from before workflow_* existed make no run: the
  // console then shows the agents as it always did. opts.alive(run): may a run with no end still
  // be at work (the job is active, and it is recent).
  function fromEvents(events, opts) {
    opts = opts || {};
    var runs = [], by = {}, agentById = {};
    var stepOf = opts.stepOfDecision || {};
    var openOf = function (e) {   // the run an agent line belongs to: the latest open one of its job and routing decision
      for (var q = runs.length - 1; q >= 0; q--) {
        var r = runs[q];
        if (r.status === 'running' && r.job === (e.job || null) && r.decision_id === (e.decision_id || null)) return r;
      }
      return null;
    };
    var lastAt = function (r) {
      var last = r.started_at;
      r.phases.forEach(function (p) { if (p.at > last) last = p.at; });
      r.agents.forEach(function (a) { if (a.at > last) last = a.at; if (a.end && a.end > last) last = a.end; });
      return last;
    };
    var cut = function (r, why) { r.ended_at = lastAt(r); r.status = 'failed'; r.error = why; };
    (events || []).forEach(function (e) {
      if (!e || !e.event) return;
      if (e.event === 'workflow_start' && e.wf_run) {
        // a run of the same job that never ended: a brief made again without running it (dropped), or a run cut off
        runs.slice().forEach(function (o) {
          if (o.status !== 'running' || o.job !== (e.job || null)) return;
          if (!o.agents.length) { runs.splice(runs.indexOf(o), 1); delete by[o.id]; } else cut(o, 'interrupted: another run started before this one finished');
        });
        var plan = e.plan && typeof e.plan === 'object' ? e.plan : { steps: {} };
        var r = {
          id: e.wf_run, job: e.job || null, workflow: e.workflow || null, config: e.config || null, mode: e.mode || null, template: templateKey(e.workflow, e.config),
          decision_id: e.decision_id || null, step: stepOf[e.decision_id] || null, round: typeof e.round === 'number' ? e.round : null, visit: 1,
          started_at: e.ts, ended_at: null, status: 'running', result: null, error: null, phases: [], agents: [], plan: { steps: plan.steps || {}, waves: plan.waves || null }, cur: -1,
        };
        r.visit = runs.filter(function (x) { return x.workflow === r.workflow && x.config === r.config && x.mode === r.mode; }).length + 1;
        runs.push(r); by[r.id] = r;
        return;
      }
      if (e.event === 'cli' && e.cmd === 'next') {   // the router moved on: a run of this job still open was cut off
        runs.forEach(function (o) { if (o.status === 'running' && o.job === (e.job || null)) cut(o, 'interrupted: the run stopped without finishing'); });
        return;
      }
      if (e.event === 'SubagentStart' && e.agent_id && /^factory:/.test(String(e.agent_type || ''))) {
        var run = openOf(e);
        if (!run) return;
        var a = { id: String(e.agent_id), role: roleOf(e.agent_type), label: '', step: null, at: e.ts, end: null, outcome: null, retry: false, task: null };
        a.step = place(run, a);
        run.agents.push(a); agentById[a.id] = { a: a, run: run };
        return;
      }
      if (e.event === 'SubagentStop' && e.agent_id && agentById[e.agent_id]) {
        var b = agentById[e.agent_id].a;
        if (!b.end) b.end = e.ts;
        return;
      }
      if (e.event === 'PostToolUse' && e.agent_id && agentById[e.agent_id]) {
        var m = /\btask (?:start|verify|show) ([A-Za-z0-9_.-]+)/.exec(String(e.target || ''));
        var x = agentById[e.agent_id];
        if (m && !x.a.task && x.run.workflow === 'realize' && x.run.status === 'running') { x.a.task = m[1]; toWave(x.run, x.a); }
        return;
      }
      var wr = e.wf_run ? by[e.wf_run] : null;
      if (wr && e.event === 'workflow_end') {
        wr.ended_at = e.ts; wr.status = e.outcome === 'ok' ? 'done' : 'failed'; wr.result = e.status || null; wr.error = e.error ? String(e.error).slice(0, 200) : null;
        if (Array.isArray(e.roster)) applyRoster(wr, e.roster);
      }
    });
    // a run with no end: at work while plausible, else it was cut off
    runs.forEach(function (r) {
      if (r.status !== 'running') return;
      if (opts.alive && opts.alive(r, lastAt(r))) return;
      cut(r, 'interrupted: the run stopped without finishing');
    });
    // an agent of a finished run that never reported stopping stopped with it
    runs.forEach(function (r) { if (r.status !== 'running') r.agents.forEach(function (a) { if (!a.end) a.end = r.ended_at; }); });
    // a run in which no agent ever started (a distill with nothing to learn, a brief never run) is not news
    return runs.filter(function (r) { return r.agents.length || r.status === 'running'; }).map(function (r) {
      var o = {};
      Object.keys(r).forEach(function (k) { if (k !== 'cur' && k !== 'job') o[k] = r[k]; });
      o.agents = r.agents.map(function (a) { return { role: a.role, label: a.label, step: a.step, at: a.at, end: a.end, outcome: a.outcome, retry: a.retry }; });
      return o;
    });
  }

  // the step an agent that just started belongs to: the step in force if its role works there (and the
  // step has room: clarify's gate takes one analyst, the angles the rest), else the next step of the
  // template its role works in, else an earlier one it comes back to (clarify's held-back angles after the
  // judge, decide's God Eye round 2). A new step is a new phase, opened at the agent's start.
  function place(run, a) {
    var tpl = templateOf(run), ps = run.plan.steps || {};
    if (!tpl) return open(run, -1, a.at, null);
    if (run.workflow === 'realize') { var w0 = run.phases.length ? run.phases[run.phases.length - 1].wave : 0; return run.cur >= 0 ? run.phases[run.phases.length - 1].i : openWave(run, w0, a.at); }
    var on = function (k) { return ps[tpl.steps[k].key] !== 0; };
    var has = function (k) { return k >= 0 && on(k) && tpl.steps[k].roles.indexOf(a.role) >= 0; };
    var used = function (k) { return run.agents.filter(function (x) { var p = phaseOf(run, x.step); return p && p.key === tpl.steps[k].key; }).length; };
    var full = function (k) { var n = ps[tpl.steps[k].key]; return tpl.steps[k].capped && typeof n === 'number' && used(k) >= n; };
    var c = run.cur, k;
    var cur = c >= 0 ? run.phases[run.phases.length - 1] : null;
    if (has(c)) {
      var later = false;
      for (k = c + 1; k < tpl.steps.length; k++) if (has(k)) later = true;
      var again = tpl.steps[c].rounds && tpl.steps[c].rounds.indexOf(a.role) >= 0 && run.agents.some(function (x) { return x.step === cur.i && x.role === a.role; });
      if (again) return open(run, c, a.at);
      if (!(full(c) && later)) return cur.i;
    }
    for (k = c + 1; k < tpl.steps.length; k++) if (has(k) && !full(k)) return open(run, k, a.at);
    for (k = 0; k < c; k++) if (has(k) && !full(k)) return open(run, k, a.at);
    if (has(c)) return cur.i;
    for (k = c + 1; k < tpl.steps.length; k++) if (has(k)) return open(run, k, a.at);
    return cur ? cur.i : open(run, -1, a.at, null);   // a role no step names: where the run is
  }
  function phaseOf(run, i) { for (var q = 0; q < run.phases.length; q++) if (run.phases[q].i === i) return run.phases[q]; return null; }
  function open(run, k, at, text) {
    var tpl = templateOf(run), st = tpl && k >= 0 ? tpl.steps[k] : null;
    var nth = st ? run.phases.filter(function (p) { return p.key === st.key; }).length + 1 : 1;
    var n = st ? (run.plan.steps || {})[st.key] : null;
    var p = { i: run.phases.length, text: st ? st.text(typeof n === 'number' ? n : '?', nth, run) : String(text || 'starting'), at: at, key: st ? st.key : null };
    run.phases.push(p); run.cur = k;
    return p.i;
  }
  // realize: one phase per wave, opened by the first agent that names a task of that wave
  function openWave(run, w, at) {
    var tpl = templateOf(run), st = tpl.steps[0];
    var last = run.phases[run.phases.length - 1];
    var p = { i: run.phases.length, text: st.text(null, 1, run, w), at: last && last.at > at ? last.at : at, key: st.key, wave: w };
    run.phases.push(p); run.cur = 0;
    return p.i;
  }
  function toWave(run, a) {
    var waves = run.plan.waves || [], w = -1;
    for (var q = 0; q < waves.length; q++) if (waves[q].indexOf(a.task) >= 0) { w = q; break; }
    if (w < 0) return;
    var mine = phaseOf(run, a.step);
    if (mine && mine.wave === w) return;
    var there = null;
    run.phases.forEach(function (p) { if (p.wave === w) there = p; });
    var last = run.phases[run.phases.length - 1];
    if (!there && last && w > last.wave) {
      // the first agent of a later wave: a new phase from its start; a phase left with no agent goes
      if (mine && mine === last && !run.agents.some(function (x) { return x !== a && x.step === mine.i; }) && run.phases.length > 0) { run.phases.pop(); }
      a.step = openWave(run, w, a.at);
      return;
    }
    if (there) a.step = there.i;
  }
  // workflow_end's roster: each agent's label and outcome, in the order they came back, matched per role to the
  // agents in the order they stopped
  function applyRoster(run, roster) {
    var q = {};
    roster.forEach(function (x) { var role = roleOf(x.agent_type || x.role); (q[role] = q[role] || []).push(x); });
    var order = run.agents.slice().sort(function (a, b) { var ea = ms(a.end), eb = ms(b.end); return (ea === null ? Infinity : ea) - (eb === null ? Infinity : eb) || (ms(a.at) || 0) - (ms(b.at) || 0); });
    order.forEach(function (a) {
      var x = q[a.role] && q[a.role].shift();
      if (!x) return;
      a.label = String(x.label || '');
      a.retry = Boolean(x.retry) || /\(retry\)$/.test(a.label);
      a.outcome = x.outcome ? String(x.outcome) : null;
      if (!a.end) a.end = run.ended_at;
    });
    // a retry belongs to the step of the call it retries (by label): clarify's gate analyst retried while
    // the other angles were starting was counted with them while it ran
    var moved = false;
    run.agents.forEach(function (a) {
      if (!a.retry) return;
      var base = a.label.replace(/ \(retry\)$/, '');
      var first = run.agents.filter(function (x) { return x !== a && !x.retry && x.label === base; })[0];
      if (first && first.step !== a.step) { a.step = first.step; moved = true; }
    });
    // a step opened by an agent that moved back starts with its own first agent, or goes if it has none
    if (moved) run.phases = run.phases.filter(function (p) { return run.agents.some(function (x) { return x.step === p.i; }); });
    if (moved) run.phases.forEach(function (p) {
      var mine = run.agents.filter(function (x) { return x.step === p.i; }).map(function (x) { return x.at; }).sort();
      if (mine.length && mine[0] > p.at) p.at = mine[0];
    });
  }

  // ------------------------------------------------------------ one run at time t (both sides)
  // Steps in order: the phases that had started by t, plus the template steps the run did not
  // take (skipped once a later step started, or the run ended) or has yet to take (pending).
  function view(run, t) {
    if (!run) return null;
    var t0 = ms(run.started_at);
    if (t === undefined || t === null) t = Infinity;
    if (t0 !== null && t < t0) return null;
    var end = ms(run.ended_at), ended = end !== null && end <= t;
    var tpl = templateOf(run), keys = tpl ? tpl.steps.map(function (s) { return s.key; }) : [];
    var phases = (run.phases || []).filter(function (p) { var a = ms(p.at); return a === null || a <= t; });
    var agents = (run.agents || []).filter(function (a) { var x = ms(a.at); return x === null || x <= t; });
    var steps = [];
    // agents that started before any phase (none in today's workflows): their own first step
    if (agents.some(function (a) { return a.step === -1 || a.step === null; })) steps.push({ i: -1, key: null, label: 'starting', text: 'starting', started_at: run.started_at, ended_at: phases.length ? phases[0].at : null });
    phases.forEach(function (p, n) {
      var tk = p.key ? keys.indexOf(p.key) : -1;
      steps.push({ i: p.i, key: p.key, tk: tk, label: cleanText(p.text), text: p.text, started_at: p.at, ended_at: phases[n + 1] ? phases[n + 1].at : ended ? run.ended_at : null });
    });
    // a step is done once the next one started; the last one ends with the run (failed with it), or is at work
    var current = null;
    steps.forEach(function (s, n) {
      s.state = n < steps.length - 1 ? 'done' : ended ? (run.status === 'failed' ? 'failed' : 'done') : 'running';
      if (s.state === 'running') current = s;
    });
    // the template steps the run has not taken: each goes before the first step that comes later in the template
    if (tpl) {
      var hit = {};
      phases.forEach(function (p) { if (p.key) hit[p.key] = 1; });
      tpl.steps.forEach(function (ts, k) {
        if (hit[ts.key]) return;
        if (run.plan && run.plan.steps && run.plan.steps[ts.key] === 0) return;   // not in this brief (no critique, no threat model)
        var at = steps.length;
        for (var q = 0; q < steps.length; q++) if (steps[q].tk > k) { at = q; break; }
        var later = at < steps.length;
        var state = later || ended ? 'skipped' : 'pending';
        if (state === 'skipped' && ts.optional) return;   // an optional step that did not run is not news
        steps.splice(at, 0, { i: null, key: ts.key, tk: k, label: ts.label, text: null, started_at: null, ended_at: null, state: state, roles_planned: ts.roles.slice() });
      });
      // a series (realize's waves): the numbers it jumped are skipped, the ones still ahead pending
      tpl.steps.forEach(function (ts) {
        if (!ts.series) return;
        var mine = steps.filter(function (s) { return s.key === ts.key && s.text; }), last = null;
        mine.forEach(function (s) {
          var m = ts.series.exec(s.text); if (!m) return;
          var n = +m[1], N = +m[2];
          if (last !== null) for (var k = last + 1; k < n; k++) steps.splice(steps.indexOf(s), 0, { i: null, key: ts.key, label: ts.label + ' ' + k + ' of ' + N, text: null, started_at: null, ended_at: null, state: 'skipped', roles_planned: ts.roles.slice() });
          last = n; s.series_of = N;
        });
        var tail = mine[mine.length - 1];
        if (tail && last !== null && tail.series_of > last) {
          var pos = steps.indexOf(tail) + 1;
          for (var k2 = tail.series_of; k2 > last; k2--) steps.splice(pos, 0, { i: null, key: ts.key, label: ts.label + ' ' + k2 + ' of ' + tail.series_of, text: null, started_at: null, ended_at: null, state: ended ? 'skipped' : 'pending', roles_planned: ts.roles.slice() });
        }
      });
    }
    // who ran in each step, per role: total, at work, came back ok, failed, retries
    steps.forEach(function (s) {
      var order = (s.roles_planned || (tpl && s.tk >= 0 && tpl.steps[s.tk] ? tpl.steps[s.tk].roles : [])).slice(), by = {};
      agents.forEach(function (a) {
        var mine = s.i === -1 ? (a.step === -1 || a.step === null) : s.i !== null && a.step === s.i;
        if (!mine) return;
        var r = by[a.role] = by[a.role] || { role: a.role, total: 0, running: 0, ok: 0, failed: 0, retries: 0 };
        var e = ms(a.end), done = a.end && (e === null || e <= t);
        r.total += 1;
        if (a.retry) r.retries += 1;
        if (!done) r.running += 1; else if (BAD[a.outcome]) r.failed += 1; else r.ok += 1;
      });
      Object.keys(by).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
      s.roles = order.filter(function (k) { return by[k]; }).map(function (k) { return by[k]; });
      if (!s.roles.length && s.state !== 'done' && s.state !== 'running' && s.state !== 'failed') s.planned = (s.roles_planned || []).slice(0, 2);
      delete s.roles_planned; delete s.tk;
    });
    var counted = steps.filter(function (s) { return s.state !== 'skipped'; });
    return {
      id: run.id, workflow: run.workflow, config: run.config, mode: run.mode, step: run.step, round: run.round, visit: run.visit,
      started_at: run.started_at, ended_at: ended ? run.ended_at : null,
      status: ended ? run.status : 'running', result: ended ? run.result : null, error: ended ? run.error : null,
      steps: steps, at: current ? counted.indexOf(current) + 1 : null, of: counted.length,
      next: tpl ? tpl.next : null,
    };
  }


  return { TEMPLATES: TEMPLATES, BAD: BAD, templateKey: templateKey, matchStep: matchStep, cleanText: cleanText, planOf: planOf, fromEvents: fromEvents, view: view };
})();
if (typeof module === 'object' && module && module.exports) module.exports = RUN_STEPS;
