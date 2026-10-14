'use strict';
// factory-inspect — audits the Software Factory from the outside.
// It reads the factory's sealed records and each job's declared rulebook, checks what
// happened against what was promised, and keeps a register of findings for you.
// It never blocks, approves or changes a job, a recipe or a policy.

const path = require('path');
const { findRoot, nowIso } = require('./io');
const { observe, isRouting } = require('./observe');
const rules = require('./rules');
const model = require('./model');
const register = require('./register');
const config = require('./config');

function requireRoot(opt) {
  const root = findRoot(opt.root ? path.resolve(opt.root) : process.cwd());
  if (!root) throw Object.assign(new Error('No .factory/ here or above: nothing to inspect.'), { code: 'no_factory' });
  return root;
}

function humanOnly(channel) {
  if (channel === 'chat') return;
  if (channel === 'tty' && process.stdin.isTTY && process.stdout.isTTY) return;
  throw Object.assign(new Error('This is a human-only action. Reply in chat (e.g. "ack finding F3", "inspect mode bug@low sample 10") or run it from your own terminal.'), { code: 'human_only' });
}

// pending: closed jobs not yet inspected since they closed. explicit: the given job (any status).
function run(root, { job: only, all = false } = {}) {
  const obs = observe(root);
  const cfg = config.load(root);
  const reg = register.load(root);
  const result = { at: nowIso(), inspected: [], skipped: [], added: [], reopened: [], rearmed: [] };
  const ids = only ? [only] : Object.keys(obs.jobs);

  for (const id of ids) {
    const job = obs.jobs[id];
    if (!job) {
      result.skipped.push({ job: id, why: 'no such job' });
      continue;
    }
    const status = job.state ? job.state.status : 'unknown';
    const prior = reg.inspected[id];
    const isClosed = ['closed', 'cancelled', 'abandoned'].includes(status);
    if (!only && !all && (!isClosed || (prior && prior.status === status))) continue;
    const recipeId = (job.lock && job.lock.id) || (job.state && job.state.recipe && job.state.recipe.id) || 'unknown';
    const rulebook = model.rulebookKey(job.lock);
    const re = config.rearmIfChanged(cfg, recipeId, rulebook);
    if (re.rearmed) result.rearmed.push({ recipe: recipeId, was: re.was || 'default' });
    const gate = config.shouldInspect(cfg, recipeId, id);
    if (!only && !gate.inspect) {
      result.skipped.push({ job: id, why: gate.why });
      reg.inspected[id] = { at: nowIso(), status, skipped: gate.why, rulebook };
      continue;
    }
    const found = rules.inspectJob(job);
    const m = register.merge(reg, found, rulebook);
    result.added.push(...m.added);
    result.reopened.push(...m.reopened);
    const ids4job = [...m.added, ...m.reopened, ...m.seen];
    result.inspected.push({ job: id, recipe: recipeId, status, findings: ids4job.length });
    if (isClosed && !(prior && prior.status === status && !prior.skipped)) {
      const r = config.recipeCfg(cfg, recipeId);
      r.inspected = (r.inspected || 0) + 1;
      const counted = reg.findings.filter((x) => ids4job.includes(x.id) && x.status !== 'wont_fix');
      r.streak = counted.length ? 0 : (r.streak || 0) + 1;
    }
    reg.inspected[id] = { at: nowIso(), status, findings: ids4job, rulebook };
  }

  const g = register.merge(reg, rules.inspectGlobal(obs, cfg.threshold), null);
  result.added.push(...g.added);
  result.reopened.push(...g.reopened);
  reg.runs.push({ at: result.at, scope: only || (all ? 'all' : 'pending'), inspected: result.inspected.length, added: result.added.length, reopened: result.reopened.length });
  reg.runs = reg.runs.slice(-200);
  register.save(root, reg);
  config.save(root, cfg);
  result.open = counts(reg);
  result.suggestions = config.suggestions(cfg);
  return result;
}

function counts(reg) {
  const open = reg.findings.filter((x) => x.status === 'open');
  return { open: open.length, high: open.filter((x) => x.severity === 'high').length, deviations: open.filter((x) => x.class === 'deviation').length, ambiguities: open.filter((x) => x.class === 'ambiguity').length, gaps: open.filter((x) => x.class === 'gap').length };
}

function report(root, { status = 'open' } = {}) {
  const reg = register.load(root);
  const want = status === 'all' ? null : status === 'open' ? ['open', 'acknowledged'] : [status];
  const sev = { high: 0, medium: 1, low: 2 };
  const list = reg.findings.filter((x) => !want || want.includes(x.status)).sort((a, b) => sev[a.severity] - sev[b.severity] || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { counts: counts(reg), findings: list };
}

function reportMd(r) {
  const L = ['# Factory inspection', '', `Open: ${r.counts.open} (${r.counts.high} high) · deviations ${r.counts.deviations} · ambiguities ${r.counts.ambiguities} · gaps ${r.counts.gaps}`, ''];
  if (!r.findings.length) return [...L, 'No findings. The factory behaved as its rulebooks say.'].join('\n');
  L.push('| ID | Severity | Class | Rule | Job | What happened | Question | Status |', '|---|---|---|---|---|---|---|---|');
  for (const x of r.findings) {
    L.push(`| ${x.id}${x.regressed ? ' ↺' : ''} | ${x.severity} | ${x.class} | ${x.rule} | ${x.job || '—'} | ${String(x.summary).replace(/\|/g, '\\|')} | ${String(x.question).replace(/\|/g, '\\|')} | ${x.status} |`);
  }
  L.push('', 'Reply `ack finding F3`, `fixed finding F3` or `wontfix finding F3 <why>`. ↺ = came back after being marked fixed.');
  return L.join('\n');
}

function status(root) {
  const cfg = config.load(root);
  const reg = register.load(root);
  const recipes = Object.entries(cfg.recipes).map(([id, r]) => {
    const m = config.modeFor(cfg, id);
    return { recipe: id, mode: m.mode, sample_every: m.mode === 'sample' ? m.every : null, clean_streak: r.streak || 0, inspected: r.inspected || 0, rearmed_at: r.rearmed_at };
  });
  return { mode: cfg.mode, sample_every: cfg.sample_every, settle_after: cfg.settle_after, threshold: cfg.threshold, recipes, open: counts(reg), suggestions: config.suggestions(cfg), last_run: reg.runs[reg.runs.length - 1] || null };
}

function mark(root, { id, to, reason, channel }) {
  humanOnly(channel);
  const reg = register.load(root);
  const fd = register.mark(reg, id, to, reason);
  register.save(root, reg);
  return { finding: fd.id, status: fd.status, message: `Finding ${fd.id} marked ${fd.status}.` };
}

function setMode(root, { target, mode, every, channel }) {
  humanOnly(channel);
  const cfg = config.setMode(config.load(root), target, mode, every);
  config.save(root, cfg);
  return { target, mode, every: every || null, message: `Inspection for ${target === 'all' ? 'all recipes' : target}: ${mode}${mode === 'sample' ? ` (1 in ${every || cfg.sample_every})` : ''}.` };
}

// A readable timeline of one job: each routing decision and the commands run under it.
function trace(root, { job: id }) {
  const obs = observe(root);
  const job = obs.jobs[id];
  if (!job) throw Object.assign(new Error(`No job ${id}`), { code: 'bad_input' });
  const L = [`# Trace — ${id}`, '', `Recipe: ${(job.lock && `${job.lock.id} v${job.lock.version}`) || 'unknown'} · status ${job.state && job.state.status}`, ''];
  const routing = job.decisions.filter(isRouting).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const human = job.decisions.filter((d) => !isRouting(d));
  for (const d of routing) {
    L.push(`**${d.id}** ${d.action} ${d.step || d.skill || d.command || ''} — ${d.rule || ''}${d.first_failing ? ` (first failing: ${d.first_failing})` : ''}`);
    for (const e of job.events.filter((x) => x.event === 'cli' && x.decision_id === d.id && x.cmd !== 'next')) L.push(`  - factory ${e.cmd}${e.sub ? ` ${e.sub}` : ''}${e.arg ? ` ${e.arg}` : ''}${e.workflow ? ` [${e.workflow}${e.config ? `/${e.config}` : ''}]` : ''} ${e.ok ? '' : `✗ ${e.code || ''}`}`);
    for (const h of human.filter((x) => x.during === d.id)) L.push(`  - you: ${h.action.replace('human.', '')}${h.gate ? ` ${h.gate}` : ''}${h.reason ? ` — ${h.reason}` : ''}`);
    for (const g of job.events.filter((x) => x.event === 'guard_deny' && x.decision_id === d.id)) L.push(`  - guard denied${g.agent_type ? ` ${g.agent_type}` : ''}: ${g.reason}`);
  }
  return L.join('\n');
}

// Chat replies for the inspector (applied by its prompt hook).
function parseReply(text) {
  const t = String(text || '').trim();
  if (!t || t.includes('\n')) return null;
  let m;
  if ((m = t.match(/^(ack|fixed|wontfix|reopen)\s+finding\s+(F\d+)(?:\s+(.*))?$/i))) return { cmd: 'mark', id: m[2].toUpperCase(), to: m[1].toLowerCase() === 'reopen' ? 'open' : m[1].toLowerCase(), reason: (m[3] || '').trim() };
  if ((m = t.match(/^inspect\s+mode\s+(all|[\w@.-]+)\s+(on|off|sample)(?:\s+(\d+))?$/i))) return { cmd: 'mode', target: m[1], mode: m[2].toLowerCase(), every: m[3] || null };
  return null;
}

function applyReply(root, p) {
  if (p.cmd === 'mark') return mark(root, { id: p.id, to: p.to, reason: p.reason, channel: 'chat' });
  if (p.cmd === 'mode') return setMode(root, { target: p.target, mode: p.mode, every: p.every, channel: 'chat' });
  throw new Error('unknown reply');
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) opt[a.slice(2, eq)] = a.slice(eq + 1);
      else if (['all', 'json'].includes(a.slice(2)) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) opt[a.slice(2)] = true;
      else opt[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

const HELP = `factory-inspect — audits the Software Factory against each job's declared rulebook

  run [--job J-0001 | --all]     inspect closed jobs not yet inspected (or one job, or everything)
  report [--status open|all|fixed|wont_fix] [--format md]
  status                          modes, clean streaks, suggestions
  show <F3>                       one finding in full
  trace --job J-0001              the job's decisions and the commands run under each
Human only (your terminal, or reply in chat):
  mark <F3> ack|fixed|wontfix|open [--reason "…"]
  mode <recipe|all> on|off|sample [N]`;

function cli(argv) {
  const { pos, opt } = parseArgs(argv);
  const [cmd, a, b, c] = pos;
  const tty = 'tty';
  switch (cmd) {
    case undefined:
    case 'help':
      return HELP;
    case 'run':
      return run(requireRoot(opt), { job: opt.job, all: Boolean(opt.all) });
    case 'report': {
      const r = report(requireRoot(opt), { status: opt.status || 'open' });
      return opt.format === 'md' ? reportMd(r) : r;
    }
    case 'status':
      return status(requireRoot(opt));
    case 'show': {
      const fd = register.load(requireRoot(opt)).findings.find((x) => x.id === String(a || '').toUpperCase());
      if (!fd) throw Object.assign(new Error(`No finding ${a}`), { code: 'bad_input' });
      return fd;
    }
    case 'trace':
      return trace(requireRoot(opt), { job: opt.job || a });
    case 'mark':
      return mark(requireRoot(opt), { id: a, to: b, reason: opt.reason, channel: tty });
    case 'mode':
      return setMode(requireRoot(opt), { target: a, mode: b, every: c, channel: tty });
    default:
      throw Object.assign(new Error(`Unknown command "${cmd}"`), { code: 'bad_input' });
  }
}

function main(argv) {
  try {
    const res = cli(argv);
    process.stdout.write((typeof res === 'string' ? res : JSON.stringify(res, null, 2)) + '\n');
  } catch (e) {
    process.stdout.write(JSON.stringify({ error: true, code: e.code || 'internal', message: e.message }, null, 2) + '\n');
    process.exitCode = 1;
  }
}

module.exports = { main, cli, run, report, reportMd, status, mark, setMode, trace, parseReply, applyReply, counts };
