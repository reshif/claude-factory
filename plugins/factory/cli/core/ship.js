'use strict';
// ship: completion report, pre-ship floors, ship manifest commit, push + PR (or local mode),
// PR sync, and the CI re-verify that runs on the merge result.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, writeJson, writeText, readText, nowIso, exists, fail, mkdirp } = require('../lib/util');
const { jobPaths, pluginPath } = require('../lib/paths');
const git = require('../lib/git');
const { runCommand } = require('../lib/run');
const job = require('./job');
const steps = require('./steps');
const ledger = require('./ledger');
const floors = require('./floors');
const decisions = require('./decisions');
const verifyMod = require('./verify');
const tasks = require('./tasks');

function gh(args, cwd) {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  if (r.error) return { code: -1, stdout: '', stderr: r.error.message };
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function ghReady(root) {
  if (!git.hasRemote(root)) return { ok: false, why: 'no git remote "origin"' };
  const v = gh(['--version'], root);
  if (v.code !== 0) return { ok: false, why: 'GitHub CLI (gh) is not installed' };
  const a = gh(['auth', 'status'], root);
  if (a.code !== 0) return { ok: false, why: 'gh is not authenticated (run gh auth login)' };
  return { ok: true };
}

function report(root, state, ctx, fl) {
  const jp = jobPaths(root, state.id);
  const prove = steps.latestAt(ctx, 'prove');
  const ch = steps.lastAtFingerprint(ctx, 'challenge');
  const parsed = require('./contract').parse(require('./contract').read(root, state.id));
  const path_ = decisions
    .forJob(root, state.id)
    .filter((d) => d.chosen && !String(d.action).startsWith('human.'))
    .map((d) => d.chosen);
  const lines = [];
  lines.push(`# Completion report — ${state.id}: ${state.title}`, '');
  lines.push(`- Work type: ${state.work_type} · Risk: ${state.risk} · Recipe: ${state.recipe.id} v${state.recipe.version}`);
  lines.push(`- Base: ${state.base_branch} @ ${state.base_commit.slice(0, 12)} · Branch: ${state.branch}`);
  lines.push(`- Build fingerprint: ${ctx.b.fingerprint}`, '');
  lines.push('## Acceptance criteria → proof', '', '| AC | Status | Proof |', '|---|---|---|');
  for (const ac of parsed.acs) {
    const s = prove && prove.detail.acs[ac.id];
    const w = prove && prove.detail.why[ac.id];
    lines.push(`| ${ac.id} ${ac.text.replace(/\|/g, '\\|')} | ${s || 'unproven'} | ${(w || []).join('; ').replace(/\|/g, '\\|')} |`);
  }
  lines.push('', '## Floors', '', '| Floor | Met |', '|---|---|');
  for (const r of fl.results) lines.push(`| ${r.floor} | ${r.ok ? 'yes' : 'NO'} |`);
  lines.push('', '## Approvals', '', '| Gate | Hash | When | Via |', '|---|---|---|---|');
  for (const [g, a] of Object.entries(state.approvals || {})) lines.push(`| ${g} | ${String(a.hash).slice(0, 12)} | ${a.at} | ${a.via} |`);
  if (Object.keys(state.waivers || {}).length) {
    lines.push('', '## Waivers', '');
    for (const [f, w] of Object.entries(state.waivers)) lines.push(`- ${f}: ${w.reason} (${w.at})`);
  }
  if (ch) {
    lines.push('', `## Review (round ${ch.detail.round})`, '', '| Lane | Verdict |', '|---|---|');
    for (const [l, v] of Object.entries(ch.detail.lanes)) lines.push(`| ${l} | ${v} |`);
    const minors = ch.detail.findings.filter((f) => f.severity === 'minor');
    const refuted = ch.detail.findings.filter((f) => f.status === 'refuted');
    if (minors.length) {
      lines.push('', '### Non-blocking findings', '');
      for (const f of minors) lines.push(`- [${f.lane}] ${f.file || ''}${f.line ? `:${f.line}` : ''} ${f.summary}${f.notes.length ? ` _(${f.notes.join('; ')})_` : ''}`);
    }
    if (refuted.length) {
      lines.push('', '### Dismissed after verification', '');
      for (const f of refuted) lines.push(`- [${f.lane}] ${f.summary} — ${f.verification || 'refuted'}`);
    }
  }
  lines.push('', '## Path taken', '', path_.join(' → ') || '(none recorded)', '');
  lines.push(`Budget: ${state.counters.agent_runs} agent runs · ${state.counters.review_rounds} fix rounds from review · ${state.counters.verify_fix_rounds} from verification.`, '');
  writeText(jp.report, lines.join('\n'));
  return jp.report;
}

function manifest(root, state) {
  const { commands } = verifyMod.collectCommands(root, state);
  return { job: state.id, title: state.title, risk: state.risk, recipe: state.recipe, base_branch: state.base_branch, created: nowIso(), commands };
}

// Prepare: floors before ship, report, manifest commit. Then push + PR, or local mode.
function ship(root, { jobId, local = false, title }) {
  const state = job.resolve(root, jobId);
  const ctx = steps.context(root, state, job.load);
  const fl = floors.evaluate(ctx, 'before_ship');
  if (!fl.ok) fail(`Floors not met before ship: ${fl.missing.join(', ')}`, 'floor', fl);
  let changed = git.changedFiles(root, state.base_commit, state.branch);
  if (changed.length > state.policy.limits.max_ship_files && !(state.waivers && state.waivers.ship_size)) {
    fail(`The change touches ${changed.length} files (limit ${state.policy.limits.max_ship_files}). Split it, or waive with "waive ship_size <reason>".`, 'size');
  }
  const reportFile = report(root, state, ctx, fl);
  const wt = tasks.ensureJobWorktree(root, state);
  const mdir = path.join(wt, '.factory-ship');
  mkdirp(mdir);
  writeJson(path.join(mdir, `${state.id}.json`), manifest(root, state));
  git.run(wt, ['add', '.factory-ship']);
  if (git.run(wt, ['diff', '--cached', '--quiet'], { allowFail: true }).code !== 0) {
    git.run(wt, ['commit', '-m', `factory: ship manifest for ${state.id}\n\nFactory-Job: ${state.id}`]);
  }
  const head = git.revParse(root, state.branch);
  const fresh = job.load(root, state.id);
  const ready = local ? { ok: false, why: 'local mode requested' } : ghReady(root);
  if (ready.ok) {
    const push = git.run(root, ['push', '-u', 'origin', state.branch], { allowFail: true });
    if (push.code !== 0) fail(`git push failed: ${push.stderr}`, 'push_failed');
    let url = null;
    const existing = gh(['pr', 'view', state.branch, '--json', 'url,number'], root);
    if (existing.code === 0) {
      url = JSON.parse(existing.stdout).url;
    } else {
      const pr = gh(['pr', 'create', '--base', state.base_branch, '--head', state.branch, '--title', title || `${state.id}: ${state.title}`, '--body-file', reportFile], root);
      if (pr.code !== 0) fail(`gh pr create failed: ${pr.stderr}`, 'pr_failed');
      url = pr.stdout.split('\n').pop();
    }
    fresh.pr = { mode: 'github', url, fingerprint: ctx.b.fingerprint, head, checks: {}, merged: false, opened_at: nowIso() };
  } else {
    fresh.pr = { mode: 'local', fingerprint: ctx.b.fingerprint, head, checks: {}, merged: false, prepared_at: nowIso(), why_local: ready.why };
  }
  fresh.pending_gate = null;
  job.save(root, fresh);
  ledger.append(root, state.id, { kind: 'step', step: 'ship', ok: true, bound: { fingerprint: ctx.b.fingerprint }, detail: { mode: fresh.pr.mode, url: fresh.pr.url || null, head } });
  return {
    job: state.id,
    mode: fresh.pr.mode,
    url: fresh.pr.url || null,
    report: reportFile,
    next:
      fresh.pr.mode === 'github'
        ? 'Review and merge the PR on GitHub. CI (factory-gate) re-verifies the merge result. Then say "continue".'
        : `No GitHub PR (${fresh.pr.why_local}). Merge locally: git checkout ${state.base_branch} && git merge --no-ff ${state.branch} — then reply "merged <commit>".`,
  };
}

function prSync(root, { jobId }) {
  const state = job.resolve(root, jobId);
  if (!state.pr || state.pr.mode !== 'github') fail('No GitHub PR recorded for this job.', 'bad_input');
  const r = gh(['pr', 'view', state.pr.url, '--json', 'state,mergeCommit,statusCheckRollup,reviewDecision'], root);
  if (r.code !== 0) fail(`gh pr view failed: ${r.stderr}`, 'gh_failed');
  const data = JSON.parse(r.stdout);
  const checks = {};
  for (const c of data.statusCheckRollup || []) {
    const name = c.name || c.context;
    const result = String(c.conclusion || c.state || '').toLowerCase();
    if (name) checks[name] = result;
  }
  state.pr.checks = checks;
  state.pr.review_decision = data.reviewDecision || null;
  state.pr.synced_at = nowIso();
  if (data.state === 'MERGED' && data.mergeCommit && data.mergeCommit.oid) {
    git.run(root, ['fetch', 'origin', state.base_branch], { allowFail: true });
    state.pr.merged = true;
    state.pr.merge_commit = data.mergeCommit.oid;
    state.pr.merged_via = 'github';
  }
  job.save(root, state);
  return { job: state.id, state: data.state, merged: state.pr.merged, checks, review_decision: state.pr.review_decision };
}

// CI / local re-verify on the merge result. In GitHub Actions this runs on the PR's
// merge commit from the committed manifest; locally it runs on the recorded merge commit.
function ciVerify(root, { manifestDir, jobId, commit }) {
  if (manifestDir) {
    const dir = path.resolve(manifestDir);
    if (!exists(dir)) return { ok: true, message: 'No factory ship manifests in this change; nothing to verify.' };
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    const results = [];
    for (const f of files) {
      const m = readJson(path.join(dir, f));
      for (const c of m.commands) results.push({ job: m.job, ...runCommand(c.cmd, process.cwd(), { timeoutSec: 1800, reruns: 0 }) });
    }
    return { ok: results.every((r) => r.pass), results: results.map(({ output, ...r }) => ({ ...r, output: r.pass ? '' : output })) };
  }
  const state = job.resolve(root, jobId);
  const at = commit || (state.pr && state.pr.merge_commit);
  if (!at) fail('No merge commit recorded; merge first.', 'not_merged');
  const wt = path.join(root, '.factory', 'worktrees', `${state.id}-ci`);
  if (exists(wt)) git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
  git.run(root, ['worktree', 'add', '--detach', wt, at]);
  const m = readJson(path.join(wt, '.factory-ship', `${state.id}.json`), null) || manifest(root, state);
  const results = m.commands.map((c) => runCommand(c.cmd, wt, { timeoutSec: state.policy.limits.command_timeout_seconds, reruns: 0 }));
  git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
  const ok = results.every((r) => r.pass);
  state.pr.checks = { ...(state.pr.checks || {}), [state.policy.ci.required_check]: ok ? 'success' : 'failure' };
  state.pr.ci_local = { at: nowIso(), commit: at, ok };
  job.save(root, state);
  return { job: state.id, ok, commit: at, failed: results.filter((r) => !r.pass).map((r) => ({ cmd: r.cmd, code: r.code, output: r.output })) };
}

// Copies a self-contained CLI and the GitHub workflow into the repo (run by you, once).
function ciInstall(root) {
  const dest = path.join(root, '.github', 'factory-cli');
  const copy = (src, dst) => {
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      mkdirp(dst);
      for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dst, f));
    } else fs.copyFileSync(src, dst);
  };
  for (const d of ['bin', 'cli', 'policy', 'recipes']) copy(pluginPath(d), path.join(dest, d));
  const wf = readText(pluginPath('templates', 'github', 'factory-gate.yml'));
  writeText(path.join(root, '.github', 'workflows', 'factory-gate.yml'), wf);
  return { ok: true, files: ['.github/factory-cli/', '.github/workflows/factory-gate.yml'], next: 'Commit these on your base branch and mark "factory-gate" as a required check.' };
}

module.exports = { ship, prSync, ciVerify, ciInstall, report };
