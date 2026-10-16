'use strict';
// factory console — a read-only page of what the factory actually did. It reads
// .factory/ as plain files (no state is loaded through the sealed loaders, nothing is
// written except the page) and turns every job into: the recipe's steps on the factory
// line, a timeline of routing decisions, results, human replies and the agents each
// workflow ran, plus tasks, findings and acceptance criteria. The page replays it.
//
// Seals are checked only when this machine already has the factory key; a page made
// elsewhere says "not checked" rather than hiding records.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readJson, readJsonl, writeText, stableStringify, fail } = require('../lib/util');
const { project, jobPaths, pluginPath } = require('../lib/paths');

const STAGE_OF = {
  request: 'request',
  clarify: 'contract', H1: 'contract', EH1: 'contract', amend: 'contract', A: 'contract',
  deps: 'design', ground: 'design', decide: 'design', H2: 'design', EH2: 'design', HF: 'design',
  decompose: 'plan', H3: 'plan', EH3: 'plan',
  realize: 'build', reconcile: 'build', children: 'build',
  prove: 'verify', challenge: 'verify', epic_gate: 'verify',
  HS: 'ship', ship: 'ship', H4: 'ship', post_merge_challenge: 'ship',
  distill: 'learn', close: 'learn',
};
const HUMAN_GATES = new Set(['H1', 'H2', 'H3', 'HF', 'HS', 'EH1', 'EH2', 'EH3', 'A']);
// An agent started (SubagentStart) with no SubagentStop is "running" only while it is plausible:
// a crashed or closed session never sends the stop, so past this age, or once the job is no
// longer active, it is listed as stale instead of running forever.
const STALE_AGENT_MS = 2 * 3600 * 1000;
// the workflow runs kept per job (the latest), with their steps
const MAX_RUNS = 40;

function secretFile() {
  return process.env.FACTORY_SECRET_FILE || path.join(require('os').homedir(), '.config', 'software-factory', 'secret');
}

// Reads the key only if it exists — never creates one (seal.secret() would).
function sealChecker() {
  let key = null;
  try { key = fs.readFileSync(secretFile(), 'utf8').trim(); } catch { /* no key here */ }
  const tally = { checked: 0, valid: 0, invalid: 0 };
  const check = (obj) => {
    if (!key || !obj || typeof obj !== 'object' || !obj.seal) return;
    const { seal, ...rest } = obj;
    tally.checked += 1;
    const want = crypto.createHmac('sha256', key).update(stableStringify(rest)).digest('hex');
    if (want === seal) tally.valid += 1; else tally.invalid += 1;
  };
  return { check, tally, hasKey: Boolean(key) };
}

const short = (s, n = 160) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n - 1)}…` : s);
const roleOf = (t) => String(t || '').replace(/^factory:/, '');
const num = (v) => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0);

// What the SubagentStop hook recorded about an agent from its own transcript: where Claude Code
// keeps it (linked by the page; served by --serve only from Claude Code's transcript folders),
// its tool calls, tokens and models. Unknown stays absent or null, never zero.
function agentExtras(e) {
  const out = {};
  if (typeof e.transcript === 'string' && path.isAbsolute(e.transcript) && /\.jsonl$/.test(e.transcript)) out.transcript = e.transcript;
  if (e.agent_id) out.agent_id = String(e.agent_id);
  if (Number.isInteger(e.tool_calls)) out.tool_calls = e.tool_calls;
  if (e.usage && typeof e.usage === 'object') {
    const u = e.usage;
    const n = (v) => (typeof v === 'number' ? v : null);
    out.usage = u.reported ? { reported: true, input_tokens: n(u.input_tokens), output_tokens: n(u.output_tokens), cache_read_tokens: n(u.cache_read_tokens) } : { reported: false };
  }
  if (Array.isArray(e.models) && e.models.length) out.models_used = e.models.slice(0, 3).map(String);
  return out;
}

function stepsOf(lock, state) {
  const recipe = (lock && lock.recipe) || {};
  const list = [{ id: 'request', stage: 'request', kind: 'start', human: true, run: 'skill:start' }];
  for (const s of recipe.steps || []) {
    const [kind] = String(s.run || '').split(':');
    list.push({
      id: s.step,
      stage: STAGE_OF[s.step] || 'build',
      kind: kind === 'merge' ? 'merge' : kind, // skill | workflow | cli | gate | merge
      run: s.run,
      config: s.config || null,
      mode: s.mode || null,
      when: s.when || null,
      auto: s.auto || null,
      lanes: s.lanes || null,
      human: (kind === 'gate' && HUMAN_GATES.has(s.step) && !s.auto) || kind === 'merge',
    });
  }
  if (!recipe.steps && state) list.push({ id: 'close', stage: 'learn', kind: 'cli', run: 'cli:close', human: false });
  return list;
}

// Clarify v3's stage lines on the timeline: where clarify went next, in plain words.
const CLARIFY_STAGE_TEXT = {
  readback: () => 'Clarify starts again from the read-back',
  readback_wait: () => 'Read your words back; waiting for your ok or your corrections',
  research: () => 'Research next: one time-boxed pass, pinned to the versions you confirmed',
  sheet_wait: (d) => `Decision sheet ready; waiting for your answer${num(d.failures) ? ` (${num(d.failures)} research gap(s) listed)` : ''}`,
  interpret: () => 'Your sheet answer is in; the interviewer maps it to the decisions',
  redirect: (d) => `Your redirect${d.redirect ? ` ${d.redirect}` : ''} is in; the interviewer reads it back`,
  redirect_wait: () => 'Read your redirect back; waiting for your ok',
  assemble: () => 'The contract writer writes the contract from what was settled',
  check: () => 'Readiness check: the CLI\'s checks, then God Eye\'s checklist',
  ready: () => 'Clarify is done: H1 next',
  park: (d) => `Clarify parked${d.reason ? `: ${d.reason}` : ''}`,
};

function resultText(step, ok, d) {
  d = d || {};
  switch (step) {
    case 'clarify': {
      // God Eye objects (0.15.1): the round is over, but God Eye did not approve; H1 shows why
      if (ok && d.approved === false) return `Clarify can do no more; God Eye did not approve: ${num(d.god_eye_objects)} objection(s), shown at H1`;
      if (ok && d.version === 3) return `Contract passed its readiness check${d.research_passes ? ` after ${num(d.research_passes)} research pass(es)` : ''}`;
      if (ok) return d.approved_with_notes ? 'Contract judged clear; God Eye approved with notes' : 'Contract judged clear; God Eye approved the intent';
      const cats = [...new Set(Array.isArray(d.categories) ? d.categories : [])];
      const held = num(d.held);
      const waiting = Array.isArray(d.waiting_ids) ? d.waiting_ids.length : 0;
      if (num(d.questions)) return `${num(d.questions)} question(s) for you${cats.length ? ` (${cats.join(', ')})` : ''}${held ? `; ${held} more held back until the intent is settled` : ''}${waiting ? `; ${waiting} still waiting` : ''}`;
      if (waiting) return `${waiting} question(s) still waiting for your answer`;
      if (d.ledger && d.ledger.degraded) return 'An analyst failed: the round runs again and does not count';
      return d.intent_open ? 'The intent is not settled yet' : (d.contract_problems || []).length ? `Contract has problems: ${d.contract_problems.slice(0, 2).join('; ')}` : d.contract_revision && d.contract_revision.rejected ? `The contract editor's revision was refused: ${short(String(d.contract_revision.rejected), 120)}` : 'Not clear yet: clarify runs again';
    }
    case 'deps': return `${(d.fetched || []).length} pinned package(s) fetched read-only${(d.gaps || []).length ? `, ${d.gaps.length} gap(s)` : ''}`;
    case 'ground': return `${num(d.claims)} sourced claim(s) across ${num(d.topics)} topic(s)${num(d.unverified) ? `, ${num(d.unverified)} unverified` : ''}${d.api_ledger ? `; API ledger: ${num(d.api_ledger.verified)} verified, ${num(d.api_ledger.rejected)} rejected` : ''}${(d.blocking || []).length ? `, ${d.blocking.length} blocking` : ''}`;
    case 'decide': return `${d.kind === 'adr' ? 'ADR' : d.kind || 'Decision'} recorded after ${num(d.rounds) || 1} critique round(s)${d.threat_model ? ', with a threat model' : ''}; critics: ${d.critique || 'n/a'}${d.stop && d.stop !== 'approved' ? ` (${d.stop === 'no_progress' ? 'no progress' : 'ceiling'}, ${num(d.open)} open at the gate)` : ''}${d.targeted ? '; a targeted revise for your deny' : ''}`;
    case 'decompose': return ok ? (d.source === 'contract' ? 'One task, straight from the contract' : `${num(d.tasks)} task(s) in ${num(d.waves)} wave(s)`) : `Plan invalid: ${(d.errors || []).slice(0, 2).join('; ')}`;
    case 'plan_critique': return 'God Eye approved the plan';
    case 'reconcile': return `Task branches merged into the job branch${d.commit ? ` at ${String(d.commit).slice(0, 7)}` : ''}`;
    case 'prove': {
      const acs = Object.entries(d.acs || {});
      const proven = acs.filter(([, v]) => v === 'proven').length;
      return `${proven} of ${acs.length} acceptance criteria proven on this build`;
    }
    case 'challenge':
    case 'post_merge_challenge': {
      const f = d.findings || [];
      const c = f.filter((x) => x.status === 'confirmed').length;
      // Unverified serious findings (no verifier result, or a verifier that answered "unverifiable") keep blocking.
      const u = f.filter((x) => x.status === 'unverified' && ['blocker', 'major'].includes(x.severity)).length;
      const lanes = Object.entries(d.lanes || {}).map(([k, v]) => `${k} ${v === 'pass' ? '✓' : '✗'}`).join(' · ');
      return `Round ${d.round || 1}: ${lanes || 'no lanes'}${c ? ` — ${c} confirmed finding(s)` : ''}${u ? ` — ${u} unverified, blocking` : ''}${(d.missing || []).length ? ` — missing ${d.missing.join(', ')}` : ''}`;
    }
    case 'ship': return d.mode === 'github' ? `Pull request opened${d.url ? ` (${d.url})` : ''}` : 'Branch prepared for a local merge, with the completion report';
    case 'epic_gate': return ok ? 'All slices merged; the epic branch passes its checks' : 'Epic gate not passed yet';
    case 'distill': return 'Lessons proposed from what happened';
    case 'close': return 'Job closed';
    default: return ok ? 'Done' : 'Not passed';
  }
}

// Clarify v3: the stage, the items with who decided them, the open sheet and the failures, as
// factory clarify status shows them (the latest state). A job still in clarify under 0.15 shows
// none until its first v3 touch migrates it; jobs approved before v3 show none.
function clarifyBlock(root, state) {
  try {
    return require('./clarify').consoleBlock(root, state);
  } catch {
    return null;
  }
}

// The inspector's register, if that plugin is installed: findings for this job, each
// anchored to the routing decision (or the moment) it cites.
function inspectorFor(root, id, decisions) {
  const reg = readJson(path.join(project(root).dir, 'inspect', 'register.json'), null);
  if (!reg || !Array.isArray(reg.findings)) return null;
  const ids = new Set(decisions.filter((d) => d.id).map((d) => d.id));
  return reg.findings.filter((f) => f.job === id).map((f) => {
    const ev = Array.isArray(f.evidence) ? f.evidence.map(String) : [];
    return {
      id: String(f.id), rule: String(f.rule || ''), class: String(f.class || ''), severity: String(f.severity || ''), status: String(f.status || 'open'),
      summary: short(String(f.summary || ''), 240), question: short(String(f.question || ''), 240),
      anchor_decision: ev.find((x) => ids.has(x)) || null,
      anchor_t: ev.find((x) => !Number.isNaN(Date.parse(x)) && /T\d\d:/.test(x)) || f.first_seen || null,
      times_seen: f.times_seen || 1,
    };
  });
}

function jobData(root, id, all, checker, nowMs = Date.now()) {
  const jp = jobPaths(root, id);
  const state = readJson(jp.state, null);
  if (!state) return null;
  let lock = readJson(path.join(jp.dir, 'recipe.lock.json'), null);
  if (!lock && state.recipe && /^[\w@.-]+$/.test(state.recipe.id)) {
    const r = readJson(pluginPath('recipes', `${state.recipe.id}.json`), null); // older jobs: the recipe as it is now
    if (r) lock = { recipe: r, from_current_recipe: true };
  }
  checker.check(state);
  checker.check(lock);
  // clarify v3's record is sealed too: a hand-edited one shows as tampered
  const cdata = readJson(path.join(jp.dir, 'clarify.json'), null);
  if (cdata) checker.check(cdata);
  const ledger = readJsonl(jp.ledger).filter((e) => e && e.job === id);
  ledger.forEach(checker.check);
  const decisions = all.decisions.filter((d) => d.job === id);
  decisions.forEach(checker.check);
  const events = all.events.filter((e) => e.job === id);
  events.forEach(checker.check);

  const steps = stepsOf(lock, state);
  const ids = new Set(steps.map((s) => s.id));
  const autoH3 = steps.some((s) => s.id === 'H3' && s.auto);
  const stepOfDecision = {};
  for (const d of decisions) if (d.id) stepOfDecision[d.id] = d.step;

  // Agent wall time per routing decision, from the hooks (start → stop by agent id).
  const started = {};
  const hookAgents = {};
  for (const e of events) {
    if (e.event === 'SubagentStart') started[e.agent_id] = e;
    if (e.event === 'SubagentStop' && started[e.agent_id]) {
      const s = started[e.agent_id];
      const k = s.decision_id || 'none';
      (hookAgents[k] = hookAgents[k] || []).push({ agent_type: e.agent_type, ms: Date.parse(e.ts) - Date.parse(s.ts), ...agentExtras(e) });
      delete started[e.agent_id];
    }
  }
  const runningNow = [];
  const staleNow = [];
  for (const s of Object.values(started)) {
    const a = { agent_type: s.agent_type, since: s.ts, decision_id: s.decision_id || null };
    const age = nowMs - Date.parse(s.ts);
    if (state.status === 'active' && age >= 0 && age < STALE_AGENT_MS) runningNow.push(a);
    else staleNow.push({ ...a, stale: true });
  }

  // Workflow runs, step by step (run-steps.js): framed by workflow_start (factory wfargs) and
  // workflow_end (factory record), with the agents the hooks saw start and stop in between. A run
  // with no end is at work while the job is active and the run was busy recently, as an agent with
  // no stop is. Older logs have no such lines: no runs, and the page shows the agents as before.
  const RS = require('./run-steps');
  const allRuns = RS.fromEvents(events, { stepOfDecision, alive: (r, last) => state.status === 'active' && nowMs - Date.parse(last) < STALE_AGENT_MS });
  const runs = allRuns.slice(-MAX_RUNS).map((r) => {
    const v = RS.view(r);
    return { ...r, stage: STAGE_OF[r.step] || null, steps: v.steps, at: v.at, of: v.of, next: v.next };
  });
  const lastByStage = {};
  for (const r of runs) if (r.stage && r.status !== 'running') lastByStage[r.stage] = r.id;
  const liveRun = runs.filter((r) => r.status === 'running').pop() || null;

  const T = [];
  let seq = 0;
  const push = (o) => { if (o.t) { o.seq = seq++; if (o.step && STAGE_OF[o.step]) o.stage = STAGE_OF[o.step]; T.push(o); } };
  push({ t: state.created_at, type: 'created', step: 'request', text: `Request submitted: “${short(state.title, 120)}”`, work_type: state.work_type, risk: state.risk, risk_proposed: state.risk_proposed, recipe: state.recipe && state.recipe.id });

  for (const d of decisions) {
    if (d.id) {
      push({ t: d.ts, type: 'route', id: d.id, step: ids.has(d.step) ? d.step : null, raw_step: d.step, action: d.action, chosen: d.chosen, rule: d.rule, first_failing: d.first_failing || null, scope: d.scope || null, reason: short(d.reason), alignment: d.alignment || null, budget: d.budget || null });
    } else {
      const act = String(d.action || '').replace(/^human\./, '');
      const during = d.during ? stepOfDecision[d.during] : null;
      const step = d.gate ? (ids.has(d.gate) ? d.gate : null) : act === 'merged' ? 'H4' : ids.has(during) ? during : null;
      push({ t: d.ts, type: 'human', action: act, step, gate: d.gate || null, reason: short(d.reason), commit: d.commit ? String(d.commit).slice(0, 7) : null, via: act === 'approve' && state.approvals && state.approvals[d.gate] ? state.approvals[d.gate].via : null });
    }
  }

  const rebinds = {};
  for (const e of ledger) {
    if (e.kind === 'step' && e.detail && e.detail.rebound_by) {
      // an approved amendment re-binds earlier steps to the new contract: one event, not N results
      const r = (rebinds[e.detail.rebound_by] = rebinds[e.detail.rebound_by] || { t: e.at, steps: [] });
      if (!r.steps.includes(e.step)) r.steps.push(e.step);
      continue;
    }
    if (e.kind === 'step' && e.step === 'post_merge_challenge' && e.detail && e.detail.followup) {
      push({ t: e.at, type: 'spawn', step: ids.has(e.step) ? e.step : null, job: String(e.detail.followup), text: `Opened follow-up job ${e.detail.followup} for the confirmed problem; this job is never reopened` });
      continue;
    }
    if (e.kind === 'step') {
      let step = e.step;
      if (step === 'plan_critique') step = autoH3 ? 'H3' : 'decompose';
      const d = e.detail || {};
      const outcome = e.ok ? 'ok' : step === 'clarify' && (num(d.questions) || (d.waiting_ids || []).length) ? 'ask' : 'fail';
      const item = { t: e.at, type: 'result', step: ids.has(step) ? step : null, raw_step: e.step, ok: Boolean(e.ok), outcome, text: resultText(e.step, e.ok, d) };
      if (/challenge/.test(e.step) && d.findings) {
        // the verifier's own word (review.js): `verifier: 'unverifiable'` when it could not settle a
        // finding, which then stays unverified and blocking; its reason and evidence when it gave them
        item.findings = d.findings.map((f) => ({
          id: String(f.id || ''), lane: String(f.lane || ''), severity: String(f.severity || ''), status: String(f.status || ''), file: f.file ? String(f.file) : null, line: Number.isInteger(f.line) ? f.line : null, summary: short(String(f.summary || ''), 200),
          ...(f.verifier ? { verifier: String(f.verifier) } : {}),
          ...(f.verification ? { verification: short(String(f.verification), 300) } : {}),
          ...(Array.isArray(f.evidence) && f.evidence.length ? { evidence: f.evidence.slice(0, 5).map((x) => short(String(x), 300)) } : {}),
        }));
        // the CLI's lane verdicts, as recorded: the page never parses them back out of the text
        Object.assign(item, { round: d.round || 1, lanes: d.lanes || {}, required: d.required || [], missing: d.missing || [] });
      }
      if (e.step === 'prove') item.acs = d.acs || {};
      if (e.step === 'clarify' && (d.categories || d.held || d.waiting_ids)) Object.assign(item, { categories: d.categories || [], held: num(d.held), question_ids: [...(d.question_ids || []), ...(d.waiting_ids || [])] });
      push(item);
    } else if (e.kind === 'agents') {
      const step = ids.has(stepOfDecision[e.decision_id]) ? stepOfDecision[e.decision_id] : null;
      const timed = (hookAgents[e.decision_id] || []).slice();
      const agents = (e.agents || []).map((a) => {
        const i = timed.findIndex((x) => x.agent_type === a.agent_type);
        const hit = i >= 0 ? timed.splice(i, 1)[0] : null;
        const { agent_type: _t, ms: _m, ...extras } = hit || {};
        // The hooks name an agent by its id, the roster by its label: with one agent of a role in
        // this run the two are the same agent; with several (parallel builders) they can't be paired,
        // so the row lists the role's transcripts instead of claiming one is its own (minor 8).
        const same = (hookAgents[e.decision_id] || []).filter((x) => x.agent_type === a.agent_type);
        const own = same.length <= 1 ? extras : { role_transcripts: same.filter((x) => x.transcript).map((x) => x.transcript) };
        return { label: short(a.label, 100), role: roleOf(a.agent_type), model: a.model || null, retry: Boolean(a.retry), outcome: a.outcome || null, ms: hit ? hit.ms : null, ...own };
      });
      push({ t: e.at, type: 'agents', step, workflow: e.workflow, config: e.config, mode: e.mode, decision_id: e.decision_id, status: e.status, runs: e.agent_runs || agents.length, agents });
    } else if (e.kind === 'clarify') {
      // clarify v3: one line per stage it moved to (cli/core/clarify.js ledgerNote)
      const d = e.detail || {};
      push({ t: e.at, type: 'clarify', step: ids.has('clarify') ? 'clarify' : null, stage: String(e.stage || ''), outcome: String(e.outcome || ''), failures: num(d.failures), text: short(CLARIFY_STAGE_TEXT[e.outcome] ? CLARIFY_STAGE_TEXT[e.outcome](d) : `Clarify: ${e.outcome}`, 240), waiting: /_wait$/.test(String(e.outcome || '')) });
    } else if (e.kind === 'error') {
      push({ t: e.at, type: 'error', step: null, text: short(`${e.workflow} reported an error: ${e.summary}`, 200) });
    }
  }

  // Agents seen only through the hooks (a workflow without a roster, or an older plugin).
  const covered = new Set(ledger.filter((e) => e.kind === 'agents').map((e) => e.decision_id));
  for (const [did, list] of Object.entries(hookAgents)) {
    if (covered.has(did) || did === 'none') continue;
    const step = stepOfDecision[did];
    const last = events.filter((e) => e.decision_id === did && e.event === 'SubagentStop').pop();
    if (!last) continue;
    push({ t: last.ts, type: 'agents', step: ids.has(step) ? step : null, decision_id: did, from: 'hooks', runs: list.length, agents: list.map((a) => { const { agent_type: _t, ms: _m, ...extras } = a; return { label: roleOf(a.agent_type), role: roleOf(a.agent_type), model: null, retry: false, outcome: null, ms: a.ms, ...extras }; }) });
  }

  for (const [aid, r] of Object.entries(rebinds)) push({ t: r.t, type: 'amend', phase: 'rebound', id: aid, steps: r.steps, step: null, text: `${aid} re-bound ${r.steps.map((x) => x.replace(/_/g, ' ')).join(', ')} to the amended contract` });
  // amendments: what changed and why, from their own records
  let amendFiles = [];
  try { amendFiles = fs.readdirSync(path.join(jp.dir, 'amendments')).filter((d) => /^A-\d+$/.test(d)).sort(); } catch { /* none */ }
  const amendments = amendFiles.map((d) => readJson(path.join(jp.dir, 'amendments', d, 'amendment.json'), null)).filter(Boolean);
  const parkTimes = [];
  let amendStarts = 0;
  for (const e of events) {
    if (e.event === 'cli' && e.cmd === 'park' && e.ok) { parkTimes.push(Date.parse(e.ts)); push({ t: e.ts, type: 'park', step: null, text: short((e.args && e.args.reason) || 'parked by you', 200), from: 'manual' }); }
    if (e.event === 'cli' && e.cmd === 'amend' && e.sub === 'start' && e.ok) {
      const a = amendments[amendStarts++];
      push({ t: e.ts, type: 'amend', phase: 'start', id: a ? a.amendment : null, step: null, text: short((a && a.reason) || (e.args && e.args.reason) || 'amendment started', 220) });
    }
    if (e.event === 'cli' && e.cmd === 'amend' && e.sub === 'submit' && e.ok) {
      const a = amendments.find((x) => Math.abs(Date.parse(x.submitted_at) - Date.parse(e.ts)) < 5000);
      push({ t: e.ts, type: 'amend', phase: 'submit', id: a ? a.amendment : null, step: null, text: a ? `Submitted: ${(a.changed_criteria || []).length} criteria changed, ${(a.affected || []).length} step(s) affected` : 'Amendment submitted for your approval', affected: a ? a.affected || [] : [] });
    }
    if (e.event === 'guard_deny') push({ t: e.ts, type: 'guard', step: ids.has(stepOfDecision[e.decision_id]) ? stepOfDecision[e.decision_id] : null, text: short(`Guard blocked ${e.tool || 'a tool call'}: ${e.reason || ''}`, 200), who: e.agent_type ? String(e.agent_type) : 'Claude (main session)', target: e.target ? short(String(e.target), 160) : null });
    if (e.event === 'hook_error') push({ t: e.ts, type: 'hook_error', step: ids.has(stepOfDecision[e.decision_id]) ? stepOfDecision[e.decision_id] : null, text: short(`The ${e.hook || 'factory'} hook failed${e.tool ? ` on ${e.tool}` : ''}: ${e.message || ''}`, 200) });
    if (e.event === 'stop_block') push({ t: e.ts, type: 'stop_block', step: null, text: short(`The Stop hook refused a "done" claim: ${(e.missing || []).join(', ') || 'floors not met'}`, 200) });
    if (e.event === 'reply_unparsed') push({ t: e.ts, type: 'unparsed', step: null, text: short(`A message looked like "${e.verb || 'a reply'}" but was not applied ("${e.word || ''}")`, 200) });
    if (e.event === 'reply_refused') push({ t: e.ts, type: 'refused', step: null, text: short(`Reply refused: ${e.reason || e.code || ''}`, 200) });
  }
  if (state.park && state.park.at && !parkTimes.some((x) => Math.abs(x - Date.parse(state.park.at)) < 5000)) push({ t: state.park.at, type: 'park', step: null, text: short(state.park.reason, 200), from: state.park.from || null });
  if (state.stopped && state.stopped.at) push({ t: state.stopped.at, type: 'stopped', step: null, text: short(state.stopped.reason || state.status, 200) });

  // Same-millisecond ties: what happened at a step comes before the router moving on from it.
  const order = { created: 0, human: 1, agents: 2, result: 3, spawn: 3, amend: 4, error: 4, guard: 4, refused: 4, hook_error: 4, stop_block: 4, unparsed: 4, route: 5, park: 6, stopped: 7 };
  T.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : order[a.type] - order[b.type] || a.seq - b.seq));
  for (const x of T) delete x.seq;

  const plan = readJson(jp.plan, null);
  const tasks = ((plan && plan.tasks) || []).map((t) => {
    const s = (state.tasks || {})[t.id] || {};
    return { id: t.id, objective: short(t.objective, 140), depends_on: t.depends_on || [], attempts: s.attempts || 0, outcome: s.outcome || null, pass: s.evidence ? Boolean(s.evidence.pass) : null };
  });
  const lessons = (readJson(project(root).lessonsFile, { lessons: [] }).lessons || []).filter((l) => l.source_job === id).map((l) => ({ id: l.id, status: l.status, text: short(l.text, 200), scope: Array.isArray(l.scope) ? l.scope.map(String) : [], created_at: l.created_at || null, decided_at: l.decided_at || null, ...(l.reason ? { reason: short(String(l.reason), 200) } : {}) }));
  // the review lanes this job must pass: as the last review recorded them, else as review.js would require them
  const lastReview = ledger.filter((e) => e.kind === 'step' && e.step === 'challenge' && e.detail && Array.isArray(e.detail.required)).pop();
  const policy = state.policy || {};
  const chStep = steps.find((s) => s.id === 'challenge');
  const stepLanes = ((chStep || {}).lanes || []).filter((l) => l !== 'all');
  const reviewLanes = lastReview ? lastReview.detail.required : chStep ? [...new Set([...((policy.required_lanes || {})[state.risk] || []), ...stepLanes])] : [];

  const job = {
    id,
    title: state.title,
    work_type: state.work_type,
    risk: state.risk,
    risk_proposed: state.risk_proposed || null,
    recipe: state.recipe ? `${state.recipe.id}` : null,
    recipe_version: state.recipe ? state.recipe.version : null,
    status: state.status,
    epic: Boolean(state.epic),
    parent: state.parent || null,
    followup_of: state.followup_of || null,
    inspector: inspectorFor(root, id, decisions),
    children: state.children || [],
    created_at: state.created_at,
    updated_at: state.updated_at,
    closed_at: state.closed_at || null,
    pending_gate: state.pending_gate ? { id: state.pending_gate.id, at: state.pending_gate.at } : null,
    park: state.park ? { reason: short(state.park.reason, 200), at: state.park.at, from: state.park.from } : null,
    counters: state.counters || {},
    pr: state.pr ? { mode: state.pr.mode, url: state.pr.url || null, merged: Boolean(state.pr.merged), merged_at: state.pr.merged_at || null } : null,
    review_lanes: reviewLanes.map(String),
    // the caps the job runs under (policy.limits), so the page never assumes them
    limits: Object.fromEntries(['max_review_rounds', 'max_verify_fix_rounds', 'max_design_critique_rounds', 'max_plan_validate_rounds', 'retry_limit'].filter((k) => Number.isInteger((policy.limits || {})[k])).map((k) => [k, policy.limits[k]])),
    lessons_max: Number.isInteger(policy.lessons_max_per_job) ? policy.lessons_max_per_job : null,
    models: ((state.policy || {}).agents || {}).models || {},
    escalation: ((state.policy || {}).agents || {}).builder_escalation || [],
    // what the agents' own transcripts report (tokens, tool calls; Claude Code reports no cost):
    // null fields were not reported
    cost: (() => {
      const stops = events.filter((e) => e.event === 'SubagentStop' && (e.transcript || e.usage));
      if (!stops.length) return null;
      const ms = {};
      for (const e of events) if (e.event === 'SubagentStart' && e.agent_id) ms[e.agent_id] = Date.parse(e.ts);
      const { models: _m, ...t } = require('./transcripts').totals(stops.map((e) => ({ ...e, ms: ms[e.agent_id] ? Date.parse(e.ts) - ms[e.agent_id] : null })));
      return t;
    })(),
    steps,
    timeline: T,
    running_agents: runningNow,
    stale_agents: staleNow,
    runs,
    runs_live: { running: liveRun ? liveRun.id : null, last_by_stage: lastByStage },
    tasks,
    lessons,
    clarify: clarifyBlock(root, state),
    // what H1 shows besides the contract (factory next's `clarify` at the gate): checked against your words, decisions, gaps, drops, God Eye's objections
    h1: state.pending_gate && ['H1', 'EH1'].includes(state.pending_gate.id) ? require('./clarify').h1Summary(root, state) : null,
    // 0.10.0: at the design or combined design + plan gate, what it approves besides its documents:
    // the critics' open objections, the API ledger, the plan probe, the build environment it seals
    gate_review: state.pending_gate && ['H2', 'EH2', 'H3', 'HF'].includes(state.pending_gate.id) ? (() => {
      try {
        return require('./critics').gateView(require('./steps').context(root, state, require('./job').load), state.pending_gate.id);
      } catch {
        return null;
      }
    })() : null,
    // 0.11 design depth: the decision records, the diagrams (mermaid source, drawn by the page),
    // the project layout with each file's owner task, how it runs (cli/core/design.js)
    design: (() => {
      try {
        return require('./design').view(root, state);
      } catch {
        return null;
      }
    })(),
    api_ledger: (() => {
      try {
        return require('./critics').ledgerSummary(root, id);
      } catch {
        return null;
      }
    })(),
  };
  // A cheap revision: the page re-renders only the jobs whose rev changed.
  job.rev = crypto.createHash('sha1').update(JSON.stringify(job)).digest('hex').slice(0, 12);
  return job;
}

function projectChecks(root) {
  let pol = {};
  try { pol = require('./policy').load(root) || {}; } catch { return []; }
  return (pol.checks || []).map((c) => (typeof c === 'string' ? { cmd: c } : c)).filter((c) => c && c.cmd).map((c) => ({ cmd: short(String(c.cmd), 200), from_lesson: c.from_lesson ? String(c.from_lesson) : null }));
}

function build(root, { job: only, now } = {}) {
  const p = project(root);
  if (!fs.existsSync(p.dir)) fail('No .factory/ folder here. Run factory init first.', 'no_root');
  const checker = sealChecker();
  const all = { decisions: readJsonl(p.decisionsFile), events: readJsonl(p.eventsFile) };
  let ids = [];
  try { ids = fs.readdirSync(p.jobsDir).filter((d) => /^J-\d+$/.test(d)).sort(); } catch { /* no jobs yet */ }
  if (only) ids = ids.filter((i) => i === only);
  const nowMs = now ? Date.parse(now) : Date.now();
  const jobs = ids.map((id) => jobData(root, id, all, checker, nowMs)).filter(Boolean);
  let current = null;
  try { current = fs.readFileSync(p.currentFile, 'utf8').trim() || null; } catch { /* none */ }
  let version = null;
  try { version = readJson(pluginPath('.claude-plugin', 'plugin.json'), {}).version || null; } catch { /* unknown */ }
  return {
    generated_at: new Date().toISOString(),
    project: path.basename(root),
    plugin_version: version,
    current,
    inspector: (() => {
      const reg = readJson(path.join(p.dir, 'inspect', 'register.json'), null);
      if (!reg) return null;
      const f = reg.findings || [];
      // factory-wide health findings (hook errors, torn logs, CLI crashes) belong to no job
      const health = f.filter((x) => !x.job).map((x) => ({ id: String(x.id), rule: String(x.rule || ''), severity: String(x.severity || ''), status: String(x.status || 'open'), summary: short(String(x.summary || ''), 240), question: short(String(x.question || ''), 240), at: x.latest || x.last_seen || x.first_seen || null }));
      return { findings: f.length, open: f.filter((x) => x.status === 'open').length, runs: (reg.runs || []).length, last_run: (reg.runs || []).slice(-1)[0] ? reg.runs.slice(-1)[0].at || null : null, health };
    })(),
    // log lines that belong to no job: hooks failing outside a job, unparsed replies
    factory_events: all.events.filter((e) => !e.job && ['hook_error', 'reply_unparsed', 'stop_block'].includes(e.event)).slice(-100).map((e) => ({ t: e.ts, type: e.event === 'reply_unparsed' ? 'unparsed' : e.event, text: short(e.event === 'hook_error' ? `The ${e.hook || 'factory'} hook failed${e.tool ? ` on ${e.tool}` : ''}: ${e.message || ''}` : e.event === 'reply_unparsed' ? `A message looked like "${e.verb || 'a reply'}" but was not applied ("${e.word || ''}")` : `The Stop hook refused a "done" claim`, 200) })),
    // what waits on the human across jobs (factory inbox), and the drive's last stop (P3.1/P3.2)
    inbox: (() => {
      try {
        const ib = require('./inbox').list(root, { plain: true });
        return { count: ib.count, items: ib.items.map((x) => ({ ...x, screen: x.screen ? short(x.screen, 2000) : undefined })), drive: ib.drive };
      } catch {
        return null;
      }
    })(),
    // the project's own checks (policy.json `checks`, e.g. a promoted lesson's): prove runs each on every build
    checks: projectChecks(root),
    integrity: checker.hasKey ? { ...checker.tally, status: checker.tally.invalid ? 'tampered' : 'verified' } : { status: 'not_checked' },
    jobs,
  };
}

// The data goes into the page as JSON in a script tag; "<" is escaped so no string in a
// job title can close the tag.
function render(data, { label, live } = {}) {
  const tpl = fs.readFileSync(pluginPath('console', 'console.html'), 'utf8');
  const json = JSON.stringify({ ...data, label: label || null, live: Boolean(live) }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (!tpl.includes('/*__FACTORY_DATA__*/null')) fail('console.html has no data slot', 'internal');
  return tpl.replace('/*__FACTORY_DATA__*/null', () => json);
}

function run(root, { out, job, label, data: dataFile } = {}) {
  const data = build(root, { job });
  const target = path.resolve(out || path.join(project(root).dir, 'console.html'));
  const html = render(data, { label });
  writeText(target, html);
  if (dataFile) writeText(path.resolve(dataFile), JSON.stringify(data, null, 2) + '\n');
  return {
    written: target,
    jobs: data.jobs.map((j) => ({ id: j.id, status: j.status, recipe: j.recipe, waiting: j.pending_gate ? j.pending_gate.id : null })),
    integrity: data.integrity.status,
    bytes: Buffer.byteLength(html),
    message: `Open ${target} in a browser to watch the factory line.`,
  };
}

// What the page is built from. A cheap fingerprint (size + mtime of each file) so the
// server can poll every few hundred ms without re-reading the logs.
function watchedFiles(root) {
  const p = project(root);
  const files = [p.eventsFile, p.decisionsFile, p.currentFile, p.lessonsFile, p.policyFile, path.join(p.dir, 'inspect', 'register.json'), path.join(p.dir, 'drive.json'), path.join(p.dir, 'project-brief.proposals.json')];
  let ids = [];
  try { ids = fs.readdirSync(p.jobsDir).filter((d) => /^J-\d+$/.test(d)); } catch { /* no jobs yet */ }
  for (const id of ids) {
    const dir = path.join(p.jobsDir, id);
    try { for (const f of fs.readdirSync(dir)) files.push(path.join(dir, f)); } catch { /* removed meanwhile */ }
  }
  return files;
}
function fingerprint(root) {
  return watchedFiles(root).map((f) => { try { const st = fs.statSync(f); return `${f}:${st.size}:${st.mtimeMs}`; } catch { return `${f}:-`; } }).join('|');
}

// factory console --serve: the same page over http://127.0.0.1, kept current. Hooks and the
// CLI append to .factory/ as Claude works; the server notices within `interval` ms and
// pushes the rebuilt data to every open page over server-sent events. Still read-only.
function serve(root, { port = 4477, job, label, interval = 400, onReady } = {}) {
  const http = require('http');
  const p = project(root);
  if (!fs.existsSync(p.dir)) fail('No .factory/ folder here. Run factory init first.', 'no_root');
  const clients = new Set();
  let data = build(root, { job });
  let body = JSON.stringify(data);
  let print = fingerprint(root);
  const same = (a, b) => JSON.stringify({ ...a, generated_at: 0 }) === JSON.stringify({ ...b, generated_at: 0 });
  const send = (res, d) => res.write(`event: data\ndata: ${d}\n\n`);
  let builtAt = Date.now();
  const tick = () => {
    const now = fingerprint(root);
    // Nothing written: still rebuild once a minute, so an agent whose session died turns stale.
    if (now === print && Date.now() - builtAt < 60000) return;
    print = now;
    builtAt = Date.now();
    let next;
    try { next = build(root, { job }); } catch { return; } // a file mid-write: try again next tick
    if (same(next, data)) return;
    data = next;
    body = JSON.stringify(data);
    for (const res of clients) send(res, body);
  };
  const server = http.createServer((req, res) => {
    // Only this machine, by name: a page on another site can't rebind its DNS to read .factory/.
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) { res.writeHead(403); res.end('forbidden'); return; }
    const url = String(req.url || '/').split('?')[0];
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(render(data, { label, live: true }));
    } else if (url === '/transcript') {
      // an agent's transcript, as Claude Code wrote it: only a .jsonl inside Claude Code's own
      // transcript folders (after symlinks), and only one an event of this project names
      let file = null;
      try { file = new URLSearchParams(String(req.url).slice(String(req.url).indexOf('?') + 1)).get('path'); } catch { file = null; }
      const real = file ? require('./transcripts').safePath(file) : null;
      // a factory agent's only: the transcripts of the user's own subagents (Explore …) are not served
      const named = real && readJsonl(p.eventsFile).some((e) => e.event === 'SubagentStop' && /^factory:/.test(String(e.agent_type || '')) && typeof e.transcript === 'string' && (e.transcript === file || require('./transcripts').safePath(e.transcript) === real));
      if (!named) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(fs.readFileSync(real));
    } else if (url === '/data.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
    } else if (url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 2000\n\n');
      send(res, body); // whatever changed between page load and connect
      clients.add(res);
      req.on('close', () => clients.delete(res));
    } else { res.writeHead(404); res.end('not found'); }
  });
  const poll = setInterval(tick, interval);
  const ping = setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 15000);
  server.on('close', () => { clearInterval(poll); clearInterval(ping); });
  const close = () => { for (const res of clients) res.end(); server.close(); };
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/`;
    if (onReady) onReady({ url, server, close });
  });
  return { server, close };
}

function runServe(root, { port, job, label }) {
  const p = port === undefined || port === true ? 4477 : Number(port);
  if (!Number.isInteger(p) || p < 0 || p > 65535) fail('--port must be a number from 0 to 65535', 'bad_input');
  serve(root, {
    port: p, job, label,
    onReady: ({ url }) => process.stdout.write(JSON.stringify({ serving: url, jobs: job ? [job] : 'all', message: `Open ${url} to watch the factory live. It updates as Claude works; Ctrl-C stops it.` }, null, 2) + '\n'),
  }).server.on('error', (e) => {
    process.stdout.write(JSON.stringify({ error: true, code: e.code === 'EADDRINUSE' ? 'port_in_use' : 'internal', message: e.code === 'EADDRINUSE' ? `Port ${p} is in use: is a console already serving? Try --port 0 for any free port.` : e.message }, null, 2) + '\n');
    process.exitCode = 1;
  });
  return null;
}

module.exports = { build, render, run, serve, runServe, fingerprint, agentExtras, STAGE_OF, STALE_AGENT_MS };
