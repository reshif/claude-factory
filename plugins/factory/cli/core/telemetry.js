'use strict';
// Telemetry for the monthly human review. Computed by the CLI from state, ledger and
// decision records — never by agents. Primary metrics are pre-registered: escaped
// defects and reverts within 30 days of merge, and cost. The rest are diagnostics.

const path = require('path');
const { writeJson, nowIso } = require('../lib/util');
const { project } = require('../lib/paths');
const git = require('../lib/git');
const job = require('./job');
const ledger = require('./ledger');
const decisions = require('./decisions');

const DAY = 864e5;
const rate = (n, d) => (d ? Math.round((n / d) * 100) / 100 : null);

// Quality signals (Tier 4 of the eval pipeline): how reliably each role returns a usable
// result, how often each review lane is refuted by the finding verifier, why jobs park,
// and how often God Eye sends a document back. All from sealed records the CLI wrote.
function roleStats(ledgerEntries) {
  const roles = {};
  for (const e of ledgerEntries.filter((x) => x.kind === 'agents')) {
    for (const a of e.agents || []) {
      const role = String(a.agent_type || 'unknown').replace(/^factory:/, '');
      const r = (roles[role] = roles[role] || { runs: 0, no_result: 0, retries: 0, degraded: 0, outcomes: {} });
      r.runs += 1;
      if (a.outcome === 'no_result') r.no_result += 1;
      if (a.retry) r.retries += 1;
      if (a.retry && a.outcome === 'no_result') r.degraded += 1; // failed twice: the step went on without it
      if (a.outcome) r.outcomes[a.outcome] = (r.outcomes[a.outcome] || 0) + 1;
    }
  }
  return roles;
}

function parkReasons(decs, state) {
  const out = {};
  decs.forEach((d, i) => {
    if (d.action !== 'parked') return;
    let reason = d.rule;
    if (!reason) {
      const resumed = decs.slice(i + 1).find((x) => x.action === 'human.resume' || x.action === 'parked');
      if (resumed && resumed.action === 'human.resume' && resumed.from) reason = `park.${resumed.from}`;
      else if (state.status === 'parked' && state.park && state.park.from && !decs.slice(i + 1).some((x) => x.action === 'parked')) reason = `park.${state.park.from}`;
      else reason = 'park.workflow';
    }
    out[reason] = (out[reason] || 0) + 1;
  });
  return out;
}

function degradedSteps(ledgerEntries) {
  const out = {};
  for (const e of ledgerEntries.filter((x) => x.kind === 'step' && x.detail && Array.isArray(x.detail.degraded) && x.detail.degraded.length)) out[e.step] = (out[e.step] || 0) + 1;
  return out;
}

function addInto(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'number') target[k] = (target[k] || 0) + v;
    else if (v && typeof v === 'object') addInto((target[k] = target[k] || {}), v);
  }
  return target;
}

function quality(metrics) {
  const roles = {};
  const lanes = {};
  const parks = {};
  const degraded = {};
  for (const m of metrics) {
    addInto(roles, m.roles || {});
    addInto(lanes, m.lanes || {});
    addInto(parks, m.park_reasons || {});
    addInto(degraded, m.degraded_steps || {});
  }
  for (const r of Object.values(roles)) {
    r.null_result_rate = rate(r.no_result, r.runs);
    r.degraded_rate = rate(r.degraded, r.runs);
  }
  const laneOut = {};
  for (const [lane, l] of Object.entries(lanes)) {
    const verified = l.confirmed + l.refuted;
    const sent = verified + l.unverified; // findings that went to a verifier
    laneOut[lane] = { raised: l.raised, sent_to_verifier: sent, verified, refuted: l.refuted, unverified: l.unverified, unverifiable: l.unverifiable || 0, refute_rate: rate(l.refuted, verified), unverifiable_rate: rate(l.unverifiable || 0, sent) };
  }
  const ge = roles['god-eye'] ? roles['god-eye'].outcomes : {};
  const verdicts = (ge.approve || 0) + (ge.revise || 0);
  return {
    roles,
    lanes: laneOut,
    park_reasons: parks,
    degraded_steps: degraded,
    god_eye: { verdicts, approve: ge.approve || 0, revise: ge.revise || 0, revise_rate: rate(ge.revise || 0, verdicts) },
  };
}

function reverts(root, state) {
  if (!state.pr || !state.pr.merge_commit) return 0;
  try {
    const since = new Date(Date.parse(state.pr.merged_at || state.updated_at)).toISOString();
    const log = git.out(root, ['log', state.base_branch, `--since=${since}`, '--format=%B%x00']);
    return log.split('\0').filter((m) => m.includes(`This reverts commit ${state.pr.merge_commit}`) || m.includes(`Factory-Revert-Of: ${state.id}`)).length;
  } catch {
    return 0;
  }
}

function jobMetrics(root, state, all) {
  const entries = ledger.all(root, state.id);
  const steps = entries.filter((e) => e.kind === 'step');
  const challenges = steps.filter((e) => e.step === 'challenge' && e.detail && e.detail.findings);
  const byLane = {};
  for (const c of challenges) {
    for (const f of c.detail.findings) {
      const l = (byLane[f.lane] = byLane[f.lane] || { raised: 0, confirmed: 0, refuted: 0, unverified: 0, unverifiable: 0, minor: 0 });
      l.raised += 1;
      if (f.verifier === 'unverifiable') l.unverifiable += 1; // the verifier could not decide (status stays unverified)
      if (f.status === 'confirmed') l.confirmed += 1;
      else if (f.status === 'refuted') l.refuted += 1;
      else if (f.status === 'unverified') l.unverified += 1;
      else l.minor += 1;
    }
  }
  const mergedAt = state.pr && state.pr.merged_at ? Date.parse(state.pr.merged_at) : null;
  const escaped = all.filter((j) => j.followup_of === state.id && mergedAt && Date.parse(j.created_at) - mergedAt <= 30 * DAY).length;
  const decs = decisions.forJob(root, state.id);
  return {
    job: state.id,
    recipe: state.recipe.id,
    work_type: state.work_type,
    risk: state.risk,
    status: state.status,
    merged: Boolean(state.pr && state.pr.merged),
    escaped_defects_30d: escaped,
    reverts_30d: reverts(root, state),
    agent_runs: state.counters.agent_runs || 0,
    wall_hours: Math.round(((Date.parse(state.closed_at || state.updated_at) - Date.parse(state.created_at)) / 36e5) * 10) / 10,
    review_fix_rounds: state.counters.review_rounds,
    verify_fix_rounds: state.counters.verify_fix_rounds,
    clarify_rounds: state.counters.clarify_rounds,
    gate_denials: (state.denials || []).length,
    amendments: state.amendments_count || 0,
    parked: decs.filter((d) => d.action === 'parked').length,
    decisions: decs.length,
    lanes: byLane,
    roles: roleStats(entries),
    park_reasons: parkReasons(decs, state),
    degraded_steps: degradedSteps(entries),
  };
}

function report(root, { sinceDays = 30 } = {}) {
  const cutoff = Date.now() - sinceDays * DAY;
  const all = job
    .listJobIds(root)
    .map((id) => {
      try {
        return job.load(root, id);
      } catch {
        return null; // tampered or unreadable: left out of the report
      }
    })
    .filter(Boolean);
  const jobs = all.filter((s) => Date.parse(s.updated_at || s.created_at) >= cutoff && !s.epic);
  const metrics = jobs.map((s) => jobMetrics(root, s, all));
  const byRecipe = {};
  for (const m of metrics) {
    const r = (byRecipe[m.recipe] = byRecipe[m.recipe] || { jobs: 0, merged: 0, parked_jobs: 0, escaped_defects_30d: 0, reverts_30d: 0, agent_runs: 0, wall_hours: 0, review_fix_rounds: 0, verify_fix_rounds: 0, gate_denials: 0, lanes: {} });
    r.jobs += 1;
    if (m.merged) r.merged += 1;
    if (m.parked) r.parked_jobs += 1;
    for (const k of ['escaped_defects_30d', 'reverts_30d', 'agent_runs', 'wall_hours', 'review_fix_rounds', 'verify_fix_rounds', 'gate_denials']) r[k] += m[k];
    for (const [lane, v] of Object.entries(m.lanes)) {
      const t = (r.lanes[lane] = r.lanes[lane] || { raised: 0, confirmed: 0, refuted: 0, unverified: 0, unverifiable: 0, minor: 0 });
      for (const k of Object.keys(t)) t[k] += v[k] || 0;
    }
  }
  for (const r of Object.values(byRecipe)) {
    r.avg_agent_runs = r.jobs ? Math.round((r.agent_runs / r.jobs) * 10) / 10 : 0;
    r.avg_wall_hours = r.jobs ? Math.round((r.wall_hours / r.jobs) * 10) / 10 : 0;
    for (const l of Object.values(r.lanes)) {
      l.precision = rate(l.confirmed, l.confirmed + l.refuted);
      l.refute_rate = rate(l.refuted, l.confirmed + l.refuted);
      l.unverifiable_rate = rate(l.unverifiable || 0, l.confirmed + l.refuted + l.unverified);
    }
  }
  const out = { generated_at: nowIso(), since_days: sinceDays, jobs: metrics.length, by_recipe: byRecipe, quality: quality(metrics), per_job: metrics };
  const month = new Date().toISOString().slice(0, 7);
  writeJson(path.join(project(root).telemetryDir, `${month}.json`), out);
  return out;
}

function toMarkdown(r) {
  const L = [];
  L.push(`# Factory telemetry — last ${r.since_days} days`, '', `${r.jobs} jobs. Primary metrics: escaped defects and reverts within 30 days of merge, and cost. Everything else is diagnostic — watch it, don't optimise it.`, '');
  L.push('| Recipe | Jobs | Merged | Escaped defects | Reverts | Avg agent runs | Avg hours | Review fix rounds | Verify fix rounds | Gate denials | Parked |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const [id, x] of Object.entries(r.by_recipe)) {
    L.push(`| ${id} | ${x.jobs} | ${x.merged} | ${x.escaped_defects_30d} | ${x.reverts_30d} | ${x.avg_agent_runs} | ${x.avg_wall_hours} | ${x.review_fix_rounds} | ${x.verify_fix_rounds} | ${x.gate_denials} | ${x.parked_jobs} |`);
  }
  L.push('', '## Review lanes', '', '| Recipe | Lane | Raised | Confirmed | Refuted | Unverified | Minor | Precision | Refute rate |', '|---|---|---|---|---|---|---|---|---|');
  for (const [id, x] of Object.entries(r.by_recipe)) {
    for (const [lane, l] of Object.entries(x.lanes)) L.push(`| ${id} | ${lane} | ${l.raised} | ${l.confirmed} | ${l.refuted} | ${l.unverified} | ${l.minor} | ${l.precision ?? '—'} | ${l.refute_rate ?? '—'} |`);
  }
  const q = r.quality;
  if (q) {
    L.push('', '## Quality signals', '', 'How reliably the agents and reviewers work, not how much they cost. Read a few transcripts before acting on a number.', '');
    L.push('### Roles', '', '| Role | Runs | No result | Null-result rate | Retries | Degraded (failed twice) | Degraded rate |', '|---|---|---|---|---|---|---|');
    for (const [role, x] of Object.entries(q.roles).sort()) L.push(`| ${role} | ${x.runs} | ${x.no_result} | ${x.null_result_rate ?? '—'} | ${x.retries} | ${x.degraded} | ${x.degraded_rate ?? '—'} |`);
    L.push('', '### Finding verifier, per lane', '', '| Lane | Raised | Sent to verifier | Refuted | Refute rate | Unverifiable | Unverifiable rate |', '|---|---|---|---|---|---|---|');
    for (const [lane, x] of Object.entries(q.lanes)) L.push(`| ${lane} | ${x.raised} | ${x.sent_to_verifier} | ${x.refuted} | ${x.refute_rate ?? '—'} | ${x.unverifiable} | ${x.unverifiable_rate ?? '—'} |`);
    L.push('', `**God Eye**: ${q.god_eye.verdicts} verdicts, ${q.god_eye.revise} revise (revise rate ${q.god_eye.revise_rate ?? '—'}).`);
    const parks = Object.entries(q.park_reasons);
    L.push('', `**Park reasons**: ${parks.length ? parks.map(([k, v]) => `${k} ×${v}`).join(', ') : 'none'}.`);
    const deg = Object.entries(q.degraded_steps);
    L.push('', `**Degraded steps** (went on without an angle or lane): ${deg.length ? deg.map(([k, v]) => `${k} ×${v}`).join(', ') : 'none'}.`);
  }
  return L.join('\n');
}

module.exports = { report, toMarkdown, jobMetrics, quality, roleStats, parkReasons };
