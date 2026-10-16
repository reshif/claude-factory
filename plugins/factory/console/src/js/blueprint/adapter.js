// ===================================================================== blueprint: the display document
// The Blueprint draws a job as a walk through states (received → intent → … → closed) on nine
// stations: the factory's stages, with "Prove & challenge" drawn as two stations (Prove, a CLI
// step, and Challenge, the review lanes) because they are separate recipe steps. The factory
// records steps rather than states: the router's routes, results, your replies, parks and
// amendments. toDisplay() folds each job's timeline into that walk, read-only, from the same DATA
// every other view reads. Nothing here goes back to the CLI.
const BP_STAGES = [
  { key: 'intake', label: 'Intake', states: ['received'] },
  { key: 'intent', label: 'Contract', states: ['intent', 'awaiting_answers', 'awaiting_intent_approval'] },
  { key: 'design', label: 'Design', states: ['designing', 'awaiting_design_approval', 'awaiting_findings_approval'] },
  { key: 'plan', label: 'Plan', states: ['planning', 'awaiting_plan_approval'] },
  { key: 'build', label: 'Build', states: ['building', 'integrating'] },
  { key: 'verify', label: 'Prove', states: ['verifying'] },
  { key: 'review', label: 'Challenge', states: ['reviewing'] },
  { key: 'ship', label: 'Ship', states: ['ready_to_ship', 'awaiting_ship_approval', 'pr_open', 'merged', 'post_merge_review'] },
  { key: 'done', label: 'Learn', states: ['learning', 'closed', 'findings_delivered'] },
];
const BP_SIDES = [
  { key: 'change', label: 'Changing', states: ['amending', 'awaiting_amendment_approval', 'needs_replan'] },
  { key: 'parked', label: 'Parked', states: ['parked'] },
  { key: 'stopped', label: 'Stopped', states: ['cancelled', 'abandoned'] },
];
// the recipe step the router chose → the state the job is in while it runs
const BP_STEP_STATE = {
  request: 'received', clarify: 'intent', H1: 'awaiting_intent_approval', EH1: 'awaiting_intent_approval',
  deps: 'designing', ground: 'designing', decide: 'designing', H2: 'awaiting_design_approval', EH2: 'awaiting_design_approval', HF: 'awaiting_findings_approval',
  decompose: 'planning', plan_critique: 'planning', H3: 'awaiting_plan_approval', EH3: 'awaiting_plan_approval',
  realize: 'building', children: 'building', reconcile: 'integrating', prove: 'verifying', challenge: 'reviewing', epic_gate: 'verifying',
  ship: 'ready_to_ship', HS: 'awaiting_ship_approval', H4: 'pr_open', post_merge_challenge: 'post_merge_review', distill: 'learning', close: 'learning',
  amend: 'amending', A: 'awaiting_amendment_approval',
};
// awaiting_answers is not a recipe gate: clarify asked questions only you can answer, and the job waits on your
// reply as it does at a gate (the Board's "Your turn · Clarify"). "Q" is its pseudo-gate id; it has no step ring.
const BP_GATE_OF = { awaiting_answers: 'Q', awaiting_intent_approval: 'H1', awaiting_design_approval: 'H2', awaiting_findings_approval: 'HF', awaiting_plan_approval: 'H3', awaiting_ship_approval: 'HS', awaiting_amendment_approval: 'A', pr_open: 'H4', parked: 'P' };
const BP_MEANING = {
  received: 'the request is in; the router picks the first step', intent: 'clarify drafts the contract and asks only what the repo cannot answer',
  awaiting_answers: 'you reply to clarify in Claude Code (ok, or what to change); then clarify runs its next stage',
  awaiting_intent_approval: 'you approve the contract (H1)', designing: 'ground and decide: sourced facts, then a design record',
  awaiting_design_approval: 'you approve the design (H2)', awaiting_findings_approval: 'you accept the findings (HF)',
  planning: 'decompose writes the task waves', awaiting_plan_approval: 'you approve the plan (H3)', building: 'builders work in their own worktrees, testers verify each task',
  integrating: 'reconcile merges the task branches into the job branch', verifying: 'prove runs every check on the exact build',
  reviewing: 'challenge: the review lanes and the finding verifier', ready_to_ship: 'ship writes the report and opens the pull request, or prepares a local merge',
  awaiting_ship_approval: 'you sign off the ship (HS)', pr_open: 'you merge (H4): on GitHub, or locally and reply merged <commit>', merged: 'merged; the merge result is verified again',
  learning: 'distill proposes lessons from what went wrong, then close checks every floor',
  post_merge_review: 'the review after merge', closed: 'closed', findings_delivered: 'findings delivered',
  amending: 'the contract or plan is changing', awaiting_amendment_approval: 'you approve the amendment (A)', needs_replan: 'needs a new plan',
  parked: 'nothing moves until you decide', cancelled: 'cancelled', abandoned: 'abandoned',
};

function bpHistory(job) {
  const hist = [];
  let cur = 'received';
  let parkedFrom = null;
  let decided = null; // your reply at a gate: the move off the gate that follows is yours, not the router's
  let asked = null; // the clarify result whose questions wait on your answers (awaiting_answers)
  const go = (at, to, by, reason) => { if (!at || !to || to === cur) return; hist.push({ at, from: cur, to, by, reason: reason || '' }); cur = to; };
  for (const it of job.timeline || []) {
    if (it.type === 'route') {
      const step = it.step || it.raw_step;
      if (cur === 'parked') parkedFrom = null;
      let to = BP_STEP_STATE[step] || cur;
      if (cur === 'merged' && step === 'H4') to = cur; // the CI re-verify of a merge already recorded belongs to the merge
      if (decided && BP_GATE_OF[cur] && to !== cur) { go(it.t, to, 'you', decided); decided = null; continue; }
      // clarify runs again only after you answered its questions (skill clarify): that move is yours
      if (cur === 'awaiting_answers' && to === 'intent') { go(it.t, to, 'you', 'you answered'); asked = null; continue; }
      asked = null;
      go(it.t, to, 'router', it.reason || (it.rule ? `rule ${it.rule}` : ''));
    } else if (it.type === 'result' && it.raw_step === 'clarify' && it.outcome === 'ask') {
      // the CLI marks a clarify result that asks you questions `outcome: 'ask'` (cli/core/console.js)
      const n = bpQuestionCount(it);
      go(it.t, 'awaiting_answers', 'router', `clarify asked ${n} question(s)`); asked = it;
    } else if (it.type === 'result' && it.raw_step === 'clarify' && cur === 'awaiting_answers') {
      go(it.t, 'intent', 'you', 'you answered'); asked = null;
    } else if (it.type === 'clarify' && !BP_GATE_OF[cur] && cur !== 'closed' && cur !== 'parked') {
      // clarify v3: a stage that waits on your reply (read-back, sheet, redirect), and the stage after it
      if (it.waiting) { go(it.t, 'awaiting_answers', 'router', it.text); asked = it; }
    } else if (it.type === 'clarify' && cur === 'awaiting_answers' && !it.waiting) {
      go(it.t, 'intent', 'you', 'you replied'); asked = null;
    } else if (it.type === 'human' && (it.action === 'approve' || it.action === 'deny') && BP_GATE_OF[cur]) {
      const g = it.gate || BP_GATE_OF[cur];
      decided = it.action === 'approve' ? `you approved ${g}${it.via && it.via !== 'chat' ? ` (${it.via})` : ''}` : `you asked for changes at ${g}${it.reason ? `: ${it.reason}` : ''}`;
    } else if (it.type === 'park') {
      asked = null; parkedFrom = cur === 'awaiting_answers' ? 'intent' : cur; go(it.t, 'parked', it.from === 'manual' ? 'you' : 'router', it.text);
    } else if (it.type === 'human' && it.action === 'resume' && cur === 'parked') {
      go(it.t, parkedFrom || 'received', 'you', 'you resumed the job'); parkedFrom = null;
    } else if (it.type === 'human' && it.action === 'merged') {
      go(it.t, 'merged', 'you', `you merged${it.commit ? ` ${it.commit}` : ''}`);
    } else if (it.type === 'amend' && it.phase === 'start') {
      go(it.t, 'amending', 'you', it.text);
    } else if (it.type === 'amend' && it.phase === 'submit') {
      go(it.t, 'awaiting_amendment_approval', 'router', it.text);
    }
  }
  const end = job.closed_at || job.updated_at || job.created_at;
  if (job.status === 'cancelled' || job.status === 'abandoned') {
    const st = (job.timeline || []).filter((t) => t.type === 'stopped').pop();
    go(st ? st.t : end, job.status, 'you', st ? st.text : job.status);
  } else if (job.status === 'closed') {
    go(end, job.work_type === 'spike' && !job.pr ? 'findings_delivered' : 'closed', 'router', 'job closed');
  } else if (job.status === 'parked' || (job.pending_gate && job.pending_gate.id === 'P')) {
    if (cur !== 'parked') { parkedFrom = cur === 'awaiting_answers' ? 'intent' : cur; go((job.park && job.park.at) || end, 'parked', 'router', job.park && job.park.reason); }
  } else if (job.pending_gate) {
    const want = BP_STEP_STATE[job.pending_gate.id];
    if (want) go(job.pending_gate.at, want, 'router', 'waiting on you');
  }
  return { hist, state: cur, parkedFrom, asked: cur === 'awaiting_answers' ? asked : null };
}

// how many questions a clarify result asked: its question ids, or the count in its text ("2 question(s) for you")
function bpQuestionCount(it) {
  if (Array.isArray(it.question_ids) && it.question_ids.length) return it.question_ids.length;
  const m = /^(\d+) question/.exec(it.text || '');
  return m ? Number(m[1]) : 0;
}

// The answer to clarify's questions is not a reply the prompt hook applies: it is ordinary chat that reaches Claude,
// which records each answer with `factory answer` (skill clarify: "1 yes, skip 2"). There is no terminal command for it.
function bpAnswer(asked) {
  // clarify v3: one reply to the screen it shows (the read-back, the decision sheet or a redirect read-back)
  if (asked && asked.type === 'clarify') {
    const sheet = asked.outcome === 'sheet_wait';
    return {
      answer: 'ok',
      hint: sheet ? 'one reply answers the whole sheet: ok (take every recommendation), ok, but 2 b, fact 1: <correction>, or your own words'
        : 'reply ok, or say in your own words what to change',
    };
  }
  const ids = asked && Array.isArray(asked.question_ids) ? asked.question_ids : [];
  const n = Math.max(1, ids.length || bpQuestionCount(asked || {}));
  const nums = n === 1 ? ['<your answer>'] : n <= 3 ? Array.from({ length: n }, (_, i) => `${i + 1} <your answer>`) : ['1 <your answer>', '2 <your answer>', `… ${n} <your answer>`];
  return {
    answer: nums.join(', '),
    hint: n === 1 ? `answer ${ids[0] || 'the question'} in your own words (or "defaults"); skip it and it takes its default`
      : `answer ${ids.length ? ids.join(', ') : 'the questions'} by number, in your own words (or "defaults"); skip one and it takes its default`,
  };
}

function bpTaskStatus(t) {
  if (t.pass === true) return 'passing';
  if (t.pass === false) return 'failing';
  if (t.outcome === 'done') return 'built';
  if (t.outcome === 'blocked' || t.outcome === 'exhausted') return 'failing';
  return t.attempts ? 'building' : 'todo';
}

// the reviewer of each lane, to find its model in the roster
const BP_LANE_ROLE = { code: 'code-reviewer', tests: 'test-reviewer', security: 'security-reviewer', ux: 'ux-reviewer', conformance: 'epic-reviewer' };
const BP_SERIOUS = ['blocker', 'major'];
// One review per lane per round, with the CLI's own lane verdict (the result's `lanes`, as review.js
// recorded it). A serious finding still unverified (no verifier result, or "unverifiable") blocks
// its lane, whatever the text says; a lane the result lists as missing did not report.
function bpReviews(job) {
  const out = [];
  let roster = null;
  for (const it of job.timeline || []) {
    if (it.type === 'agents' && (it.agents || []).some((a) => Object.values(BP_LANE_ROLE).includes(a.role))) roster = it;
    if (it.type !== 'result' || !/challenge/.test(it.raw_step || '') || !(it.findings || it.lanes)) continue;
    const byLane = {};
    for (const f of it.findings || []) (byLane[f.lane] = byLane[f.lane] || []).push(f);
    const verdicts = it.lanes || {};
    for (const lane of new Set([...Object.keys(verdicts), ...Object.keys(byLane)])) {
      const fs = byLane[lane] || [];
      const unverified = fs.filter((f) => f.status === 'unverified' && BP_SERIOUS.includes(f.severity)).length;
      const confirmed = fs.some((f) => f.status === 'confirmed' && BP_SERIOUS.includes(f.severity));
      const verdict = verdicts[lane] || (confirmed || unverified ? 'changes' : 'pass');
      const rv = roster && (roster.agents || []).filter((a) => a.role === BP_LANE_ROLE[lane] && a.model).pop();
      out.push({
        lane, verdict, at: it.t, model: rv ? rv.model : null, round: it.round || null, post_merge: it.raw_step === 'post_merge_challenge',
        unverified,
        // review.js: a verifier that could not settle a finding sets verifier 'unverifiable' and leaves it unverified
        findings: fs.filter((f) => f.status !== 'refuted').map((f) => ({ severity: f.severity, summary: f.summary, file: f.file || undefined, line: f.line || undefined, status: f.status || undefined, verifier: f.verifier || (f.status === 'confirmed' && f.verification ? 'confirmed' : undefined), verification: f.verification || undefined, evidence: (f.evidence || []).length ? f.evidence.join('; ') : undefined })),
        dismissed: fs.filter((f) => f.status === 'refuted').length,
      });
    }
    for (const lane of it.missing || []) out.push({ lane, verdict: 'missing', at: it.t, model: null, round: it.round || null, unverified: 0, findings: [], dismissed: 0 });
  }
  return out;
}

function bpCriteria(job) {
  const proofs = (job.timeline || []).filter((t) => t.type === 'result' && t.raw_step === 'prove' && t.acs);
  const last = proofs.pop();
  return last ? Object.entries(last.acs).map(([id, v]) => ({ id, text: '', status: v === 'proven' ? 'proven' : v || 'not_proven', tasks: [] })) : [];
}

// agent runs: each roster entry with a duration becomes a start and a stop, tagged with the state
// the job was in, so the drawing can light the bank of the station the agent worked for.
function bpActivity(job, hist) {
  const stateAt = (ms) => { let s = 'received'; for (const h of hist) { if (Date.parse(h.at) <= ms) s = h.to; else break; } return s; };
  const out = [];
  for (const it of job.timeline || []) {
    const end = Date.parse(it.t);
    if (it.type === 'agents') {
      for (const a of it.agents || []) {
        const ms = a.ms || 0;
        const st = new Date(end - ms).toISOString();
        const state = stateAt(end - ms);
        out.push({ at: st, agent: `factory:${a.role}`, job: job.id, phase: 'start', state, kind: it.workflow || null });
        out.push({ at: it.t, agent: `factory:${a.role}`, job: job.id, phase: 'stop', state, kind: it.workflow || null });
      }
    } else if (it.type === 'guard') {
      out.push({ at: it.t, agent: it.who && it.who.startsWith('factory:') ? it.who : null, job: job.id, phase: 'denied', tool: 'tool call', reason: it.text, command: it.target || null, state: stateAt(end) });
    }
  }
  for (const a of job.running_agents || []) out.push({ at: a.since, agent: a.agent_type, job: job.id, phase: 'start', state: stateAt(Date.parse(a.since)) });
  return out;
}

// Workflow runs (cli/core/run-steps.js, in the page as RUN_STEPS): each run as the console recorded it,
// tagged with the station whose bank it belongs to, for the step list in that bank and the section view.
// The steps are folded again at the replay time by RUN_STEPS.view(run, t); older data has no runs.
const BP_RUN_STATION = { clarify: 'intent', 'fanout-judge:clarify': 'intent', 'fanout-judge:decide': 'design', ground: 'design', decompose: 'plan', realize: 'build', reconcile: 'build', 'fanout-judge:challenge': 'review', distill: 'done' };
function bpRunStation(run) {
  const st = BP_STEP_STATE[run.step];
  const stage = st ? BP_STAGES.find((s) => s.states.includes(st)) : null;
  if (stage) return stage.key;
  return BP_RUN_STATION[`${run.workflow}:${run.config}`] || BP_RUN_STATION[run.workflow] || null;
}
function bpRuns(job) {
  return (job.runs || []).filter((r) => r && r.id && r.started_at).map((r) => ({
    id: r.id, workflow: r.workflow, config: r.config || null, mode: r.mode || null, template: r.template || null, step: r.step || null, station: bpRunStation(r),
    round: r.round == null ? null : r.round, visit: r.visit || 1, started_at: r.started_at, ended_at: r.ended_at || null, status: r.status || 'running', result: r.result || null, error: r.error || null,
    phases: Array.isArray(r.phases) ? r.phases : [], agents: Array.isArray(r.agents) ? r.agents : [], plan: r.plan || null,
  }));
}

function bpWaiting(job, state, asked) {
  const g = BP_GATE_OF[state];
  if (job.status !== 'active' && job.status !== 'parked') return { who: 'nobody', what: BP_MEANING[state] || state };
  if (!g) return { who: 'agent', what: BP_MEANING[state] || state };
  // clarify v3: the screen it waits on; an older record: the questions it asked
  if (g === 'Q') return { who: 'you', gate: g, what: BP_MEANING[state], ...bpAnswer(asked), command: null };
  // the replies the prompt hook applies (human.parseReply, the README's "Your replies"), and the same
  // human-only command from your own terminal (factory approve · resume · merged, with --job)
  const reply = g === 'P' ? `resume ${job.id} · cancel job ${job.id} · abandon job ${job.id}` : g === 'H4' ? `merged ${job.id} <commit>` : `approve ${job.id} ${g} · deny ${job.id} <what must change>`;
  const command = g === 'P' ? `factory resume --job ${job.id}` : g === 'H4' ? `factory merged <commit> --job ${job.id}` : `factory approve ${g} --job ${job.id}`;
  return { who: 'you', gate: g, what: BP_MEANING[state] || '', reply, command };
}

function toDisplay(data) {
  data = data || {};
  const all = data.jobs || [];
  const jobs = [];
  let activity = [];
  const lessons = [];
  const epics = [];
  for (const j of all) {
    // an epic is its own drawing series, not a job on the line: the Board shows it, and its slices run here
    // an epic waiting on your reply at a gate counts in Your turn, as the Board counts it
    if (j.epic) {
      // and so does one whose clarify asked you questions (Q), as the Board's "Your turn · Clarify"
      const eh = j.status === 'active' && !j.pending_gate ? bpHistory(j) : null;
      const q = eh && eh.state === 'awaiting_answers' ? eh.asked : null;
      const g = j.status === 'active' && j.pending_gate && j.pending_gate.id !== 'P' ? j.pending_gate.id : q ? 'Q' : null;
      epics.push({ id: j.id, title: j.title || j.id, status: j.status, children: (j.children || []).length, gate: g, gate_at: q ? q.t : g ? j.pending_gate.at : null,
        ...(q ? { reply: null, ...bpAnswer(q) } : { reply: g ? `approve ${j.id} ${g} · deny ${j.id} <what must change>` : null }) });
      continue;
    }
    const { hist, state, parkedFrom, asked } = bpHistory(j);
    const parent = j.parent ? all.find((x) => x.id === j.parent) : null;
    const challenge = (j.steps || []).find((s) => s.id === 'challenge' && s.lanes);
    const reviews = bpReviews(j);
    const lastRound = reviews.filter((r) => !r.post_merge && r.round).pop();
    const amend = (j.timeline || []).filter((t) => t.type === 'amend' && t.phase === 'start').pop();
    jobs.push({
      id: j.id, slug: j.title || j.id, type: j.work_type || 'feature', risk: j.risk || 'low', state,
      epic: parent && parent.epic ? parent.id : null, slice: parent && parent.epic ? j.id : null,
      created_at: j.created_at, updated_at: j.updated_at, parked_from: parkedFrom,
      waiting_on: bpWaiting(j, state, asked), rework_loops: hist.filter((h) => h.to === 'building' && ['verifying', 'reviewing', 'integrating', 'ready_to_ship', 'pr_open'].includes(h.from)).length,
      history: hist,
      tasks: (j.tasks || []).map((t) => ({ id: t.id, objective: t.objective, depends_on: t.depends_on || [], criteria: [], allowed_paths: [], verify_commands: [], status: bpTaskStatus(t), runs: t.attempts || 0 })),
      criteria: bpCriteria(j), reviews, gate: null,
      // the lanes this job must pass, as the CLI requires them (policy + recipe), not a fixed set
      required_lanes: Array.isArray(j.review_lanes) ? j.review_lanes : challenge ? challenge.lanes.filter((l) => l !== 'all') : [], docs: [],
      review_round: lastRound ? lastRound.round : 0, max_review_rounds: (j.limits || {}).max_review_rounds || null,
      post_merge_lanes: ((j.steps || []).find((s) => s.id === 'post_merge_challenge') || {}).lanes || null,
      status: j.status,
      amendment: amend ? { reason: amend.text, from: 'you' } : null,
      evidence_count: (j.tasks || []).filter((t) => t.pass !== null && t.pass !== undefined).length,
      runs: bpRuns(j),
      // clarify v2: the issue ledger (cli/core/console.js clarifyBlock), for the section view's Clarify block
      clarify: j.clarify || null,
      // at H1 / EH1: what clarify adds to the contract (God Eye's objections, drops, angles gone on without)
      h1: j.h1 || null,
      // at the design / combined gate: the critics' open objections, the API ledger, the plan probe
      gate_review: j.gate_review || null,
    });
    activity = activity.concat(bpActivity(j, hist));
    for (const l of j.lessons || []) {
      lessons.push({
        id: l.id, rule: l.text, why: `from ${j.id}`, status: l.status, created_at: l.created_at || j.closed_at || j.updated_at, scope: l.scope || [], lanes: [], evidence: [{ job: j.id, text: j.title || '' }],
        decided: l.decided_at && l.status !== 'proposed' ? { at: l.decided_at, by: 'you', status: l.status, note: l.reason || '' } : null,
      });
    }
  }
  activity.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return {
    generated_at: data.generated_at, repo: data.project || 'repository',
    stages: BP_STAGES, side_lanes: BP_SIDES, meaning: BP_MEANING,
    jobs, activity, lessons,
    // the project's own checks (policy.json), which prove runs on every build: a promoted lesson becomes one
    standards: { adopted: [], rules: [], checks: (data.checks || []).map((c) => ({ name: c.from_lesson ? `from lesson ${c.from_lesson}` : 'project check', why: 'run by prove on every build', cmd: c.cmd })) },
    // epics are drawn on the Board, not here: the Blueprint lists them in a note (epic_jobs) instead
    epics: [], epic_jobs: epics,
  };
}
