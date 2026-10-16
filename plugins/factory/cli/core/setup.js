'use strict';
// factory init and factory doctor.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeJson, readJson, readText, writeText, exists, mkdirp, nowIso, fail } = require('../lib/util');
const { project, findRoot, pluginPath } = require('../lib/paths');
const git = require('../lib/git');
const recipes = require('./recipes');
const job = require('./job');

const HOOK_MARK = '# installed by software-factory';

// Keep .factory/ and common build caches out of git without touching the user's .gitignore:
// the common-dir info/exclude applies to every worktree, so a verify command that writes
// __pycache__ (or a test cache) never leaves a task or job worktree "dirty". Run at init and
// whenever a worktree is prepared, so repositories initialised earlier get it too.
const EXCLUDES = ['.factory/', '__pycache__/', '*.py[cod]', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.tox/', 'node_modules/.cache/', '.DS_Store'];
function ensureExcludes(root) {
  const commonDir = path.resolve(root, git.out(root, ['rev-parse', '--git-common-dir']));
  const exclude = path.join(commonDir, 'info', 'exclude');
  const ex = readText(exclude, '');
  const have = new Set(ex.split(/\r?\n/).map((l) => l.trim()));
  const add = EXCLUDES.filter((p) => !have.has(p));
  if (!add.length) return null;
  writeText(exclude, `${ex}${ex.endsWith('\n') || !ex ? '' : '\n'}${add.join('\n')}\n`);
  return exclude;
}

// Before a worktree is prepared: the excludes above, and the factory's own commit-msg hook
// brought up to date (never a hook the user wrote).
function ensureGitSetup(root) {
  ensureExcludes(root);
  const hookFile = path.join(path.resolve(root, git.out(root, ['rev-parse', '--git-common-dir'])), 'hooks', 'commit-msg');
  const existing = readText(hookFile, null);
  const want = readText(pluginPath('templates', 'git', 'commit-msg'));
  if (existing !== null && existing.includes(HOOK_MARK) && existing !== want) {
    writeText(hookFile, want);
    fs.chmodSync(hookFile, 0o755);
  }
}

function init(cwd, { baseBranch } = {}) {
  if (!git.isRepo(cwd)) fail('Not a git repository. Run git init and make a first commit, then factory init.', 'no_git');
  const root = git.toplevel(cwd);
  if (!git.hasCommits(root)) fail('The repository has no commits yet. Make a first commit, then run factory init.', 'no_commits');
  const p = project(root);
  const created = [];
  if (!exists(p.projectFile)) {
    writeJson(p.projectFile, { version: 1, created_at: nowIso(), base_branch: baseBranch || git.currentBranch(root) });
    created.push(p.projectFile);
  }
  if (!exists(p.policyFile)) {
    writeJson(p.policyFile, {});
    created.push(p.policyFile);
  }
  for (const d of [p.jobsDir, p.logDir, path.dirname(p.lessonsFile), p.telemetryDir, p.worktreesDir, p.scratchDir]) mkdirp(d);

  const commonDir = path.resolve(root, git.out(root, ['rev-parse', '--git-common-dir']));
  const exclude = ensureExcludes(root);
  if (exclude) created.push(exclude);

  // commit-msg hook: adds Factory-Job / Factory-Task (and, in fix rounds, Factory-Fix) trailers on factory branches.
  const hooksDir = path.join(commonDir, 'hooks');
  const hookFile = path.join(hooksDir, 'commit-msg');
  const existing = readText(hookFile, null);
  if (existing === null || existing.includes(HOOK_MARK)) {
    mkdirp(hooksDir);
    writeText(hookFile, readText(pluginPath('templates', 'git', 'commit-msg')));
    fs.chmodSync(hookFile, 0o755);
    created.push(hookFile);
  }
  return { root, created, base_branch: readJson(p.projectFile).base_branch, doctor: doctor(root) };
}

function doctor(cwd) {
  const checks = [];
  const add = (name, ok, detail, level = 'error') => checks.push({ name, ok, level: ok ? 'ok' : level, detail });
  const major = parseInt(process.versions.node.split('.')[0], 10);
  add('node', major >= 18, `Node ${process.versions.node} (needs 18+)`);
  const g = spawnSync('git', ['--version'], { encoding: 'utf8' });
  add('git', g.status === 0, (g.stdout || '').trim() || 'git not found');
  const root = findRoot(cwd);
  add('initialized', Boolean(root), root ? `.factory/ at ${root}` : 'run factory init');
  if (root) {
    add('remote', git.hasRemote(root), git.remoteUrl(root) || 'no "origin" remote: jobs ship in local mode (you merge and reply "merged <sha>")', 'warning');
    const gh = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8' });
    add('github cli', gh.status === 0, gh.status === 0 ? 'gh authenticated' : 'gh missing or not logged in: PRs are not opened automatically', 'warning');
    const id = git.run(root, ['config', 'user.email'], { allowFail: true });
    add('git identity', id.code === 0 && Boolean(id.stdout), id.stdout || 'set git config user.name / user.email (merges and commits need it)');
    const ci = exists(path.join(root, '.github', 'workflows', 'factory-gate.yml'));
    add('ci', ci, ci ? 'factory-gate workflow present' : 'no CI re-verify workflow: run factory ci install (or re-verify locally with factory ci verify)', 'warning');
    const vc = require('./ship').vendoredCheck(root);
    if (vc) add('ci cli', vc.ok, vc.message, 'warning');
    const cur = job.current(root);
    add('current job', true, cur || '(none)');
    // the build environment every worktree is set up with (factory env show / check)
    const envMod = require('./environment');
    const { env: e, error } = envMod.loadSafe(root);
    if (error) add('build environment', false, error);
    else if (e) {
      const pr = envMod.problems((({ seal: _s, confirmed: _c, ...rest }) => rest)(e));
      add('build environment', pr.length === 0, pr.length ? pr.join('; ') : `${e.name || 'set'} (${envMod.short(e)}): ${(e.setup || []).join(' && ') || 'no setup'}; factory env check runs it in a scratch worktree`);
    } else {
      const p = envMod.proposal(root);
      add('build environment', p.name === 'none', p.name === 'none' ? 'none needed (no dependency manifest)' : `none confirmed; proposed ${p.name}: ${(p.setup || []).join(' && ')}. Reply "confirm environment ${envMod.short(p)}" or run factory env set; until then worktrees are bare`, 'warning');
    }
  }
  for (const c of hookNodeChecks()) add(c.name, c.ok, c.detail, 'warning');
  // The model each role runs on (policy.agents.models: Claude Code aliases or ids, passed per
  // agent call), or the switch that puts every role on the main conversation's model
  try {
    const pol = root ? require('./policy').load(root) : require('./policy').defaults();
    const a = pol.agents || {};
    if (require('./wfargs').modelsOff(pol)) add('agent models', true, 'policy.agents.models_enabled is false: every role runs on the main conversation\'s model', 'warning');
    else {
      const byModel = {};
      const set = a.models && typeof a.models === 'object' ? a.models : {};
      const roles = require('fs').readdirSync(require('../lib/paths').pluginPath('agents')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));
      for (const r of roles) {
        const m = typeof set[r] === 'string' && set[r].trim() && set[r] !== 'default' ? set[r].trim() : 'main conversation model';
        (byModel[m] = byModel[m] || []).push(r);
      }
      const esc = (a.builder_escalation || []).length ? `; builders step up to ${a.builder_escalation.join(' → ')} from attempt ${a.builder_escalation_from_attempt || 3}` : '';
      // a full model id may not be accepted by the Agent tool's per-call model (the docs list aliases)
      const ids = [...new Set([...Object.values(set), ...(a.builder_escalation || [])].filter((m) => typeof m === 'string' && m !== 'default' && !['haiku', 'sonnet', 'opus', 'fable', 'inherit'].includes(m)))];
      add('agent models', !ids.length, `${Object.entries(byModel).map(([m, rs]) => `${m}: ${rs.join(', ')}`).join(' · ')}${esc}.${ids.length ? ` ${ids.join(', ')} ${ids.length > 1 ? 'are' : 'is'} not a Claude Code alias (haiku, sonnet, opus, fable): the Workflow tool takes a full id, but the Agent-tool path (no Workflow tool, the lesson writer) may not.` : ''} Roles not named in agents.models run on the main conversation's model; agents.models_enabled: false puts every role there`, 'warning');
    }
  } catch {
    /* no policy */
  }
  const rc = recipes.checkAll();
  for (const [id, errs] of Object.entries(rc)) add(`recipe ${id}`, errs.length === 0, errs.length ? errs.join('; ') : 'valid');
  const ready = checks.every((c) => c.ok || c.level !== 'error');
  return { ready, checks };
}

// The Node the hooks would run under. Claude Code runs each hook command through a shell with
// the environment it was started with, so the hooks get the first `node` on that PATH, which is
// not always the doctor's own Node (run from your terminal, or a login shell's nvm while Claude
// Code was started with the system PATH, where Ubuntu's apt nodejs 12.x sits at /usr/bin/node).
// hooks/lib.js (and the CLI modules the hooks load) use ?. and ?? (Node 14+): an older Node
// fails every hook with a SyntaxError, and then the guard allows everything (the launcher in
// hooks/hooks.json names the too-old node on stderr). run(file, args) -> { status, stdout,
// stderr, error } is for tests.
const HOOK_NODE_MIN = 14;
function nodeMajor(v) {
  const m = /^v?(\d+)\./.exec(String(v || '').trim());
  return m ? Number(m[1]) : null;
}
function hookNodeChecks(run = (file, args) => spawnSync(file, args, { encoding: 'utf8', timeout: 15000 })) {
  if (process.platform === 'win32') return [];
  const out = [];
  const probe = (r) => {
    const lines = String((r && r.stdout) || '').trim().split('\n').map((x) => x.trim()).filter(Boolean);
    return { ok: Boolean(r && !r.error && lines.length), lines, where: lines.find((x) => x.startsWith('/')) || null, version: lines.find((x) => /^v\d+\./.test(x)) || null };
  };
  const tooOld = (who, where, version) => `${who}: ${where || 'node'} ${version} is too old for the factory hooks (they need Node ${HOOK_NODE_MIN}+; hooks/lib.js uses ?.): every hook fails and the guard allows everything. Put a newer Node first on the PATH Claude Code is started with`;
  // this shell's PATH: what Claude Code gives its hooks when the doctor runs inside it
  const here = probe(run('sh', ['-c', 'command -v node; node --version']));
  const major = nodeMajor(here.version);
  if (!here.ok) out.push({ name: 'hooks node', ok: false, detail: 'no node on this PATH: the factory hooks are off where Claude Code is started with it (install Node 14+ on that PATH)' });
  else if (major === null) out.push({ name: 'hooks node', ok: false, detail: `could not read the Node version on this PATH (${here.lines.join(' ').slice(0, 120)})` });
  else out.push({ name: 'hooks node', ok: major >= HOOK_NODE_MIN, detail: major >= HOOK_NODE_MIN ? `${here.where || 'node'} ${here.version} on this PATH (the hooks need ${HOOK_NODE_MIN}+)` : tooOld('this PATH', here.where, here.version) });
  // a login shell's PATH (Claude Code started from a desktop launcher or another terminal), when it differs
  const login = probe(run('bash', ['-lc', 'command -v node; node --version']));
  const lm = nodeMajor(login.version);
  if (login.ok && lm !== null && (login.where !== here.where || login.version !== here.version)) {
    out.push({ name: 'hooks node (login shell)', ok: lm >= HOOK_NODE_MIN, detail: lm >= HOOK_NODE_MIN ? `bash -lc: ${login.where || 'node'} ${login.version}` : tooOld('bash -lc', login.where, login.version) });
  }
  // the system Node a bare PATH (no nvm) finds
  const sys = run('/usr/bin/node', ['--version']);
  if (sys && !sys.error && sys.status === 0 && here.where !== '/usr/bin/node') {
    const v = String(sys.stdout || '').trim();
    const mj = nodeMajor(v);
    if (mj !== null && mj < HOOK_NODE_MIN) out.push({ name: 'hooks node (/usr/bin/node)', ok: false, detail: `/usr/bin/node is ${v}, too old for the factory hooks (they need Node ${HOOK_NODE_MIN}+). Claude Code started with the system PATH (no nvm) gives the hooks this one: remove it or install Node ${HOOK_NODE_MIN}+ there` });
    else if (mj !== null) out.push({ name: 'hooks node (/usr/bin/node)', ok: true, detail: `/usr/bin/node ${v}` });
  }
  return out;
}

module.exports = { HOOK_NODE_MIN, hookNodeChecks, init, doctor, ensureExcludes, ensureGitSetup, EXCLUDES };
