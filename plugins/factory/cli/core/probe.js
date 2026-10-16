'use strict';
// The plan probe (0.10.0): before anyone approves a plan, show that its verify commands can run.
//
//   factory plan probe [--job J]
//
// 1. Lint every verify command: a fixed port (parallel worktrees collide), a `sleep` (a race,
//    not a wait), a background `&` (a process nothing stops).
// 2. In a scratch worktree of the base commit, set up the environment the plan's gate binds (the
//    planner's environment.proposed.json, else the confirmed one, else the repo's proposal) and
//    dry-run every verify command there, each with a time cap, the whole probe with a budget.
//    The code is not written yet, so a command is EXPECTED to fail; it must fail for the right
//    reason (no test yet, an assertion), never because the command, a third-party module,
//    settings, a database or a server is missing, and it must end on its own.
// 3. Greenfield (the environment's manifest does not exist yet): the plan needs a bootstrap task
//    (`"bootstrap": true`) that every other task depends on; setup and the dry-run wait for it
//    (realize prepares the bootstrap task's worktree without the environment).
// The scratch worktree is torn down afterwards (teardown, services down, worktree removed). The
// record, .factory/jobs/<job>/probe.json, is sealed and bound to the plan and environment hashes:
// the plan critique reads it, the gate shows it.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { readJson, writeJson, exists, nowIso, hashFile, sha256, stableStringify } = require('../lib/util');
const { jobPaths } = require('../lib/paths');
const { seal, valid } = require('../lib/seal');
const git = require('../lib/git');

const FILE = (root, jobId) => path.join(jobPaths(root, jobId).dir, 'probe.json');
const cmdOf = (c) => (typeof c === 'string' ? c : c && c.cmd);

// ---------------------------------------------------------------- lint

const LINT = [
  { rule: 'fixed_port', re: /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})\b|--port[= ](\d{2,5})\b|\bPORT=(\d{2,5})\b|\s-p\s+(\d{2,5}):/, message: (m) => `uses the fixed port ${m.slice(1).find(Boolean)}: tasks run in parallel worktrees and collide on it; let the test pick a free port (port 0) or take it from the environment` },
  { rule: 'sleep', re: /(^|[;&|(\s])sleep\s+\d/, message: () => 'waits with sleep: a race on a slow machine and wasted time on a fast one; wait on a readiness check (a health URL, a log line, a retry loop with a deadline)' },
  { rule: 'background', re: /(^|[^&>|])&(\s*$|\s+[^&])|\b(setsid|nohup|disown|daemonize|start-stop-daemon)\b|\bdocker\s+(run|compose\s+up)\b[^|;&]*\s-d\b|\b(screen|tmux)\b[^|;&]*\s-d/, message: () => 'starts a background process (&, setsid, nohup, docker -d …) that nothing stops: start and stop it inside the test, or use the environment\'s services' },
];

// ---------------------------------------------------------------- what a dry-run may see

// The environment a dry-run gets: an allowlist, never the user's tokens or credentials, marked as
// an agent's (human.agentContext sees AI_AGENT and CLAUDECODE, so every human-only verb refuses
// it, a pty included), tagged so survivors can be found. In claude-factory the CLI runs the probe
// itself (factory record decompose, or factory plan probe from the main session), never a subagent.
const KEEP = /^(PATH|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TZ|SHELL|USER|LOGNAME|PWD|COLUMNS|LINES)$/;
// The network settings a setup needs behind a corporate proxy (fix 0.11: passed by default; the
// user saw PyPI time out without them): proxies, CA bundles, package index URLs.
const PROXY = /^(https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY|ALL_PROXY|all_proxy|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|PIP_TRUSTED_HOST|UV_INDEX_URL|UV_EXTRA_INDEX_URL|UV_DEFAULT_INDEX|npm_config_registry|NPM_CONFIG_REGISTRY|npm_config_proxy|npm_config_https_proxy|NPM_CONFIG_PROXY|NPM_CONFIG_HTTPS_PROXY|YARN_REGISTRY|YARN_NPM_REGISTRY_SERVER)$/;
// Network values parsed, not pattern-matched (release review M2). A login (userinfo) is whatever
// precedes the LAST "@" that is followed by a host[:port], with or without a scheme
// (user:pass@proxy:8080, http://user:p@ss@proxy, socks5h://bob:pa/ss@sock, https://:PAT@host).
const HOSTPORT = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~%-]+)(:\d{1,5})?$/;
function splitLogin(v) {
  const str = String(v || '');
  const sm = /^\s*([a-z][a-z0-9+.-]*:\/\/)/i.exec(str);
  const lead = sm ? sm[0] : (/^\s*/.exec(str) || [''])[0];
  const body = str.slice(lead.length);
  for (let i = body.lastIndexOf('@'); i > 0; i = body.lastIndexOf('@', i - 1)) {
    const host = body.slice(i + 1).split(/[/?#\s]/)[0];
    if (!HOSTPORT.test(host)) continue;
    const info = body.slice(0, i);
    if (/\s/.test(info)) continue;
    // "host/path@x" is a path, not a login: a login has ":" (or no "/") before any "/"
    const slash = info.indexOf('/');
    if (slash >= 0 && !(info.indexOf(':') >= 0 && info.indexOf(':') < slash)) continue;
    return { lead, login: info, rest: body.slice(i + 1) };
  }
  return null;
}
const stripLogin = (v) => {
  const p = splitLogin(v);
  return p ? `${p.lead}${p.rest}` : String(v);
};
// A token in an index URL's path or query (Cloudsmith, Gemfury, ?token=…): such a URL is dropped.
const TOKEN_QUERY = /[?&](token|access_token|auth|key|api_key|apikey|password|secret)=/i;
const TOKEN_HOSTS = /^(dl\.cloudsmith\.io|[a-z]+\.fury\.io|npm-proxy\.fury\.io)$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function urlCarriesToken(u) {
  const s = String(u || '');
  if (TOKEN_QUERY.test(s)) return true;
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)(\/[^?#]*)?/i.exec(s);
  if (!m) return false;
  const segs = String(m[2] || '').split('/').filter(Boolean);
  if (TOKEN_HOSTS.test(m[1].replace(/^.*@/, '').replace(/:\d+$/, '')) && segs[0] && segs[0].length >= 6) return true;
  return segs.some((x) => x.length >= 16 && /\d/.test(x) && /[A-Za-z]/.test(x) && !UUID.test(x) && /^[A-Za-z0-9_-]+$/.test(x));
}
const INDEX_VAR = /INDEX|REGISTRY/i;
// One network variable's value for an agent's command: logins stripped; an index URL with a token
// in its path or query dropped (null) — unless the repo opted in (decompose.probe_proxy_credentials).
function cleanNetValue(k, v, { keepCreds = false } = {}) {
  if (keepCreds || v === undefined || v === null) return v;
  const parts = String(v).split(/(\s+)/);
  const out = [];
  for (const x of parts) {
    if (!x.trim()) {
      out.push(x);
      continue;
    }
    const clean = stripLogin(x);
    if (INDEX_VAR.test(k) && urlCarriesToken(clean)) return null;
    out.push(clean);
  }
  return out.join('');
}
const stripCreds = (v) => cleanNetValue('X', v);
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|_KEY$|^KEY$|APIKEY|API_KEY|CREDENTIAL|^AWS_|^GH_|^GITHUB_|^SSH_|^GPG_|^COPILOT_|^ANTHROPIC_|^CLAUDE_CODE_|^NPM_TOKEN|^AZURE_|^GOOGLE_|^GCP_|COOKIE|SESSION)/i;
// `own`: the probe's own directories (its scratch home, temp and caches), never filtered: a path
// can contain a secret-looking variable's value (a temp dir named in CLAUDE_CODE_TMPDIR) and must
// still be set.
function probeEnv(root, probeId, extra = {}, own = {}) {
  // proxies and index URLs pass by default (policy decompose.probe_proxy: false keeps them out);
  // a login embedded in one (user:pass@) is stripped unless decompose.probe_proxy_credentials
  let dec = {};
  try {
    dec = (require('./policy').load(root) || {}).decompose || {};
  } catch {
    dec = {};
  }
  const allowProxy = dec.probe_proxy !== false;
  const keepCreds = dec.probe_proxy_credentials === true;
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (KEEP.test(k)) out[k] = v;
    else if (allowProxy && PROXY.test(k)) {
      const c = cleanNetValue(k, v, { keepCreds });
      if (c !== null) out[k] = c;
    }
  }
  // what the environment declares (its env block, the probe's own dirs) is kept, except a value
  // carrying one of the user's secrets (a declared `TOKEN: $GH_TOKEN`)
  const secrets = Object.entries(process.env).filter(([k, v]) => SECRET_NAME.test(k) && v && v.length >= 6).map(([, v]) => v);
  for (const [k, v] of Object.entries(extra)) if (!secrets.some((x) => String(v).includes(x))) out[k] = v;
  return { ...out, ...own, CI: '1', FACTORY_PROBE: '1', FACTORY_PROBE_ID: probeId, FACTORY_RUNNER: '1', AI_AGENT: 'factory-probe', CLAUDECODE: '1', PYTHONDONTWRITEBYTECODE: '1' };
}

// Secrets out of anything the probe records or shows (probe.json, the gate, God Eye's input):
// well-known token shapes, key=value pairs that name a secret, and the values of the user's own
// secret-looking environment variables.
function redact(text) {
  let t = String(text || '');
  // the raw value of every network variable that carries a login or a token, then its pieces
  for (const [k, v] of Object.entries(process.env)) {
    if (!PROXY.test(k) || !v) continue;
    const p = splitLogin(v);
    const tok = urlCarriesToken(v);
    if (!p && !tok) continue;
    t = t.split(v).join(`[redacted ${k}]`);
    if (p && p.login.length >= 3) {
      t = t.split(p.login).join('[redacted]');
      const pw = p.login.includes(':') ? p.login.slice(p.login.indexOf(':') + 1) : '';
      if (pw.length >= 4) t = t.split(pw).join('[redacted]');
    }
  }
  // any other login in a URL, with or without a scheme (the same parser)
  t = t.replace(/[^\s'"`<>()=,;]*@[^\s'"`<>()=,;]+/g, (w) => {
    const p = splitLogin(w);
    // without a scheme only user:password@host (an e-mail address is not a login)
    return p && (/:\/\//.test(p.lead) || p.login.includes(':')) ? `${p.lead}[redacted]@${p.rest}` : w;
  });
  for (const [k, v] of Object.entries(process.env)) if (SECRET_NAME.test(k) && v && v.length >= 6) t = t.split(v).join(`[redacted ${k}]`);
  return t
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{16,})\b/g, '[redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b([A-Za-z_]*(token|secret|password|passwd|api[_-]?key)[A-Za-z_]*)\s*[=:]\s*("[^"]*"|'[^']*'|\S+)/gi, '$1=[redacted]');
}

// A process's session id, process group and start time (Linux /proc/<pid>/stat; fields after the
// command name: state is field 3, pgrp 5, session 6, starttime 22).
function procStat(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop().split(' ');
    return { state: f[0], pgrp: Number(f[2]), sid: Number(f[3]), start: f[19] };
  } catch {
    return null;
  }
}
const procStart = (pid) => (procStat(pid) || {}).start || null;
// Alive, and the same process (a pid reused by another process has another start time: review m7).
function sameProcess(pid, start) {
  if (!pid) return false;
  try {
    process.kill(Number(pid), 0);
  } catch {
    return false;
  }
  return !start || procStart(pid) === String(start);
}

// Processes a dry-run left behind, killed and reported. Found by the probe's tag in their
// environment, and, for one that cleared its environment (review m1), by the dry-run's own session
// (a process that only left its process group stays in it) or a working directory inside the
// scratch worktree (one that also started a new session still runs there).
function survivors(probeId, { sid = null, wt = null } = {}) {
  const out = [];
  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x));
  } catch {
    return out;
  }
  for (const pid of pids) {
    if (Number(pid) === process.pid) continue;
    let env = '';
    try {
      env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    } catch {
      env = '';
    }
    const tagged = env.includes(`FACTORY_PROBE_ID=${probeId}\0`) || env.endsWith(`FACTORY_PROBE_ID=${probeId}`);
    let ours = tagged;
    if (!ours && sid) ours = (procStat(pid) || {}).sid === Number(sid);
    if (!ours && wt) {
      try {
        const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
        ours = cwd === wt || cwd.startsWith(`${wt}${path.sep}`);
      } catch {
        ours = false;
      }
    }
    if (!ours) continue;
    // a zombie has already ended (its parent has not reaped it yet)
    if ((procStat(pid) || {}).state === 'Z') continue;
    let cmd = '';
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch {
      cmd = '';
    }
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* gone */
    }
    out.push({ pid: Number(pid), cmd: redact(cmd).slice(0, 200) });
  }
  return out;
}

// Scratch worktrees an earlier probe left (it was killed before its cleanup ran).
function sweep(root, keep = null) {
  const dir = path.join(root, '.factory', 'worktrees');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^_probe-/.test(n));
  } catch {
    return [];
  }
  const removed = [];
  for (const n of names) {
    const wt = path.join(dir, n);
    if (keep && wt === keep) continue;
    // the owner the probe wrote (pid and its start time): a reused pid is not the owner (review m7)
    const owner = readJson(path.join(wt, '.factory-probe', 'owner.json'), null);
    const pid = Number((owner && owner.pid) || (/-(\d+)$/.exec(n) || [])[1]);
    if (pid === process.pid) continue;
    let alive = owner ? sameProcess(pid, owner.start) : sameProcess(pid, null);
    // no owner record (an older probe): alive only while it is young
    if (alive && !owner) {
      try {
        alive = Date.now() - fs.statSync(wt).mtimeMs < 2 * 3600e3;
      } catch {
        alive = false;
      }
    }
    if (alive) continue;
    if (owner && owner.probe_id) survivors(owner.probe_id, { wt });
    git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
    try {
      fs.rmSync(wt, { recursive: true, force: true });
    } catch {
      /* gone */
    }
    removed.push(n);
  }
  if (removed.length) git.run(root, ['worktree', 'prune'], { allowFail: true });
  return removed;
}

// Does this environment's setup fetch code from the network (and so run code nobody approved)?
// (review m2: also the runners that fetch and run a package, clones, and piped or substituted
// downloads)
const NETWORK_SETUP = /pip3? install|pipx (run|install)|poetry install|uv (sync|pip|run|tool)|uvx\b|npm (ci|install|i|exec)\b|npx\b|pnpm (install|i|dlx|exec)\b|yarn\b|bunx?\b|go (mod download|get|install|run)|cargo (build|fetch|install)|bundle install|gem install|curl\b|wget\b|git (clone|fetch|pull|submodule)|deno (run|install)|docker (pull|build|run|compose (pull|build|up))|podman (pull|build|run)|invoke build|apt(-get)? install|brew install|<\(|https?:\/\//;

function lintCommand(cmd) {
  const out = [];
  for (const r of LINT) {
    const m = r.re.exec(String(cmd));
    if (m) out.push({ rule: r.rule, message: r.message(m) });
  }
  return out;
}

// ---------------------------------------------------------------- classification

// Does a task of the plan own a module or path of this name (so its absence is expected)?
function planOwns(plan, name) {
  const n = String(name || '').replace(/^\.\/+/, '');
  if (!n) return false;
  const globs = (plan.tasks || []).flatMap((t) => t.allowed_paths || []).concat((plan.interfaces || []).map((i) => i.file || ''));
  return globs.some((g) => String(g).split(/[/\\]/).some((seg) => seg.replace(/\.(py|js|ts|mjs|cjs)$/, '').replace(/\*+/g, '') === n));
}

const ENV_SIGNS = /ECONNREFUSED|Connection refused|could not connect to server|Is the server running|ImproperlyConfigured|DJANGO_SETTINGS_MODULE|settings are not configured|EADDRINUSE|address already in use|OperationalError|getaddrinfo|Name or service not known|docker: command not found|Cannot connect to the Docker daemon/i;

// What one dry-run says: { class, ok, why }.
//   passes            exit 0 before any change (ok; the critique judges whether it proves anything)
//   fails_as_expected exit != 0 for a reason the build will fix (no test yet, an assertion)
//   missing_binary    the command itself is not there
//   environment       a third-party module, settings, a database or a server is missing
//   timeout           it did not end on its own
function classify(r, plan) {
  const out = String(r.output || '');
  if (r.timed_out || r.code === 124 || r.code === 137) return { class: 'timeout', ok: false, why: `did not finish within ${r.cap}s: a verify command must end on its own (does it wait on a server, a prompt, a loop?)` };
  if (r.code === 0) return { class: 'passes', ok: true, why: 'exits 0 before any change: make sure it tests the change' };
  if (r.code === 127 || /command not found|: not found\b|is not recognized as an internal or external command/i.test(out)) {
    const bin = (/(?:bash: (?:line \d+: )?)?([\w./-]+): (?:command )?not found/.exec(out) || [])[1];
    return { class: 'missing_binary', ok: false, why: `${bin ? `\`${bin}\`` : 'the command'} is not found in the build environment: install it in the environment's setup, or use a command the project has` };
  }
  const py = /No module named ['"]?([\w.]+)['"]?/.exec(out);
  if (py) {
    const top = py[1].split('.')[0];
    if (planOwns(plan, top) || planOwns(plan, py[1].replace(/\./g, '/'))) return { class: 'fails_as_expected', ok: true, why: `${py[1]} is a module the plan creates` };
    return { class: 'environment', ok: false, why: `the module ${py[1]} is not installed in the build environment (and no task creates it): add it to the environment's setup` };
  }
  const nm = /Cannot find module ['"]([^'"]+)['"]/.exec(out);
  if (nm) {
    if (/^[./]/.test(nm[1]) || planOwns(plan, nm[1])) return { class: 'fails_as_expected', ok: true, why: `${nm[1]} is a file the plan creates` };
    return { class: 'environment', ok: false, why: `the package ${nm[1]} is not installed in the build environment: add it to the environment's setup` };
  }
  if (ENV_SIGNS.test(out)) {
    const sign = (ENV_SIGNS.exec(out) || [])[0];
    return { class: 'environment', ok: false, why: `it needs something the environment does not provide (${sign}): a database, a server, settings or a service; add it to the environment (setup, env, services) or make the test provide it` };
  }
  return { class: 'fails_as_expected', ok: true, why: 'fails before the change is built, for a reason the build should fix' };
}

// ---------------------------------------------------------------- running

const hasTimeout = (() => {
  let v = null;
  return () => {
    if (v === null) v = spawnSync('bash', ['-c', 'command -v timeout'], { encoding: 'utf8' }).status === 0;
    return v;
  };
})();

// One command, bounded: GNU timeout signals the whole process group (servers and sleeps a
// command started included); without it, spawnSync's own cap.
const hasSetsid = (() => {
  let v = null;
  return () => {
    if (v === null) v = spawnSync('bash', ['-c', 'command -v setsid'], { encoding: 'utf8' }).status === 0;
    return v;
  };
})();
// `env` is the whole environment (probeEnv). No stdin, no controlling terminal (its own session).
function runBounded(cmd, cwd, capSec, env) {
  const started = Date.now();
  const opts = { cwd, encoding: 'utf8', timeout: (capSec + 15) * 1000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env };
  const inner = hasTimeout() ? ['timeout', '-k', '5', String(capSec), 'bash', '-c', cmd] : ['bash', '-c', cmd];
  const argv = hasSetsid() ? ['setsid', '--wait', ...inner] : inner;
  const r = spawnSync(argv[0], argv.slice(1), hasTimeout() ? opts : { ...opts, timeout: capSec * 1000 });
  const output = `${r.stdout || ''}${r.stderr ? `\n${r.stderr}` : ''}`;
  // with setsid, the command's session is the child's pid: what stays in it is a survivor
  return { code: r.status === null ? -1 : r.status, sid: hasSetsid() ? r.pid || null : null, timed_out: Boolean(r.error && r.error.code === 'ETIMEDOUT') || r.status === 124 || r.signal === 'SIGTERM' || r.signal === 'SIGKILL', ms: Date.now() - started, cap: capSec, output: output.length > 4000 ? `…${output.slice(-4000)}` : output };
}

// Is this a greenfield plan: the environment sets things up from manifests the base commit does
// not have yet?
function greenfield(root, base, e) {
  if (!e || !(e.setup || []).length) return false;
  let tracked = [];
  try {
    tracked = git.out(root, ['ls-tree', '-r', '--name-only', base]).split('\n').filter(Boolean);
  } catch {
    tracked = [];
  }
  const { matchesAny } = require('../lib/glob');
  // only a setup that installs from a manifest needs one: `pip install -e .`, `npm ci`, …
  if (!/pip3? install|poetry install|uv sync|npm (ci|install)|pnpm install|yarn( install)?\b|go mod|cargo (build|fetch)|bundle install|invoke build/.test((e.setup || []).join('\n'))) return false;
  const keys = e.cache_key || [];
  if (keys.length) return !tracked.some((f) => matchesAny(f, keys));
  return !tracked.some((f) => /^(pyproject\.toml|setup\.py|setup\.cfg|requirements[\w.-]*\.txt|package\.json|go\.mod|Cargo\.toml|Gemfile|pom\.xml|build\.gradle)$/.test(f));
}

function settings(state) {
  const L = (state.policy && state.policy.limits) || {};
  return { perCommand: Math.max(5, Math.min(L.probe_command_seconds || 120, L.command_timeout_seconds || 600)), budget: Math.max(30, L.probe_timeout_seconds || 900) };
}

// Is the probe on for this job? policy decompose.plan_probe (the live .factory/policy.json wins,
// then the job's snapshot; default on), and only when the job's recipe plans with the decompose
// workflow and does not turn the probe off for it (`"plan_probe": false` on the step).
// The probe's mode for this job: false (off), 'lint' (lint only, nothing runs) or 'full' (lint,
// setup in the scratch worktree, and a dry-run of every command lint did not flag).
// policy decompose.plan_probe: false | "lint" | "full" | "auto" (default, also true): "lint" while
// the environment the gate binds is an unconfirmed proposal whose setup installs from the
// network (it would run code nobody approved), "full" otherwise.
function mode(root, state, ctx = null) {
  if (!enabled(root, state, ctx)) return false;
  let live = {};
  try {
    live = (require('./policy').load(root) || {}).decompose || {};
  } catch {
    live = {};
  }
  const snap = ((state && state.policy) || {}).decompose || {};
  const flag = live.plan_probe !== undefined ? live.plan_probe : snap.plan_probe;
  // the human's answer to an interrupted probe (park plan_probe, option a): lint only
  if (state && state.probe_override === 'lint') return 'lint';
  if (flag === 'lint' || flag === 'full') return flag;
  const g = require('./environment').gateProposal(root, state.id);
  return g.status === 'proposed' && NETWORK_SETUP.test(((g.env || {}).setup || []).join('\n')) ? 'lint' : 'full';
}

function enabled(root, state, ctx = null) {
  let live = {};
  try {
    live = (require('./policy').load(root) || {}).decompose || {};
  } catch {
    live = {};
  }
  const snap = ((state && state.policy) || {}).decompose || {};
  const flag = live.plan_probe !== undefined ? live.plan_probe : snap.plan_probe;
  if (flag === false) return false;
  // the human's answer to an interrupted probe (park plan_probe, option c): no probe for this job
  if (state && state.probe_override === false) return false;
  const c = ctx || require('./steps').context(root, state, require('./job').load);
  const step = c.recipe.steps.find((x) => x.step === 'decompose');
  return Boolean(step && String(step.run).startsWith('workflow:') && step.plan_probe !== false && !state.epic);
}

// opts.probeId and opts.budget: set by the managed run (runManaged) for its detached child, the
// budget cut to what the caller's shell call has left.
function run(root, { jobId, probeId: givenId = null, budget = null } = {}) {
  const job = require('./job');
  const envMod = require('./environment');
  const planMod = require('./plan');
  const state = job.resolve(root, jobId);
  if (!enabled(root, state)) return { job: state.id, ok: true, skipped: true, problems: [], commands: [], lint: [], message: 'The plan probe is off for this job (policy decompose.plan_probe, or its recipe).' };
  const runMode = mode(root, state);
  const probeId = givenId || require('crypto').randomBytes(8).toString('hex');
  sweep(root);
  const jp = jobPaths(root, state.id);
  const plan = readJson(jp.plan, null);
  if (!plan || !Array.isArray(plan.tasks)) return { job: state.id, ok: false, problems: ['No plan.json to probe.'], commands: [], lint: [] };
  const planHash = hashFile(jp.plan);
  const gate = envMod.gateProposal(root, state.id);
  const S = settings(state);
  if (Number(budget) > 0) S.budget = Math.max(10, Math.min(S.budget, Math.floor(Number(budget))));
  const started = Date.now();
  const lint = [];
  const problems = [];
  for (const t of plan.tasks) {
    for (const c of t.verify_commands || []) {
      for (const l of lintCommand(cmdOf(c))) {
        lint.push({ task: t.id, cmd: cmdOf(c), ...l });
        problems.push(`${t.id}: \`${cmdOf(c)}\` ${l.message} (${l.rule})`);
      }
    }
  }
  const e = gate.env && !envMod.isNone(gate.env) ? gate.env : null;
  const base = state.base_commit || 'HEAD';
  // the proposed environment against this machine (0.11; copilot-factory fix 0.10.1): lint, so it is caught before the
  // gate even when nothing runs (lint-only mode); a confirmed one is the human's and is not linted
  let machine = null;
  if (e && gate.status === 'proposed') {
    try {
      machine = require('./machine').inventory();
    } catch {
      machine = null;
    }
    for (const l of envMod.lint(e, { root, base, plan, machine })) {
      lint.push({ task: 'environment', cmd: l.cmd, rule: l.rule, message: l.message });
      problems.push(`environment: \`${l.cmd}\` ${l.message} (${l.rule})`);
    }
  }
  const green = greenfield(root, base, e);
  const boot = plan.tasks.filter((t) => t.bootstrap === true);
  if (green) {
    if (!boot.length) problems.push(`Greenfield: the build environment's setup (${(e.setup || []).join(' && ')}) needs files no commit has yet (${(e.cache_key || []).join(', ') || 'a manifest'}). Add a bootstrap task first ("bootstrap": true) that creates them, and make every other task depend on it.`);
    else {
      const b = boot[0];
      const late = plan.tasks.filter((t) => t.id !== b.id && !planMod.effectiveDeps(plan.tasks, t.id, plan.interfaces).includes(b.id) && !dependsOn(plan.tasks, t.id, b.id));
      if (late.length) problems.push(`Greenfield: ${late.map((t) => t.id).join(', ')} ${late.length > 1 ? 'do' : 'does'} not depend on the bootstrap task ${b.id}; every task needs the files it creates.`);
    }
  }
  const commands = [];
  let setup = { status: e ? 'pending' : 'none' };
  const flagged = new Set(lint.map((l) => `${l.task}\0${l.cmd}`));
  if (runMode === 'lint') {
    setup = { status: 'not_run', why: 'lint-only probe: the proposed environment installs from the network and is not confirmed yet (policy decompose.plan_probe "full" runs it)' };
    for (const t of plan.tasks) for (const c of t.verify_commands || []) commands.push({ task: t.id, cmd: cmdOf(c), class: 'not_run', ok: true, why: 'lint only: not executed' });
  } else if (green && boot.length) {
    setup = { status: 'deferred', why: `the environment is set up after ${boot[0].id} (bootstrap) writes its manifests` };
    for (const t of plan.tasks) for (const c of t.verify_commands || []) commands.push({ task: t.id, cmd: cmdOf(c), class: 'deferred', ok: true, why: 'dry-run after the bootstrap task (greenfield)' });
  } else {
    const wt = path.join(root, '.factory', 'worktrees', `_probe-${state.id}-${process.pid}`);
    git.run(root, ['worktree', 'prune'], { allowFail: true });
    const add = git.run(root, ['worktree', 'add', '--detach', wt, base], { allowFail: true });
    if (add.code !== 0) {
      problems.push(`The probe could not create its scratch worktree: ${String(add.stderr || add.stdout || '').trim().slice(0, 300)}`);
    } else {
      let E = null;
      // the dry-run writes only into its scratch worktree: home, temp and the usual caches point
      // inside it (an OS sandbox it is not: a command could still name a path outside, which the
      // check after the run reports). Setup and services get the same home (review MAJ-3).
      const box = path.join(wt, '.factory-probe');
      for (const d of ['home', 'tmp', 'cache']) fs.mkdirSync(path.join(box, d), { recursive: true });
      // who owns this scratch worktree: the sweep keeps it only while this process lives (m7)
      writeJson(path.join(box, 'owner.json'), { pid: process.pid, start: procStart(process.pid), probe_id: probeId, at: nowIso() });
      const homeEnv = ownDirs(box);
      try {
        if (e) {
          const { evidence: _e, notes: _n, source: _s, ...runEnv } = e;
          // the probe's budget bounds setup too
          // setup runs with the same allowlisted environment (no tokens), no terminal, no login
          // shell (environment.sh runs bash --noprofile --norc under a base environment: a
          // ~/.profile that exports a token never runs), and the scratch home
          E = envMod.withBaseEnv(probeEnv(root, probeId, {}, homeEnv), () => envMod.ensure(root, null, { taskId: 'probe', wt, env: { ...runEnv, timeout_seconds: Math.min(runEnv.timeout_seconds || 1200, S.budget) } }));
          if (!E.ok) {
            setup = { status: 'broken', cmd: E.broken.cmd, code: E.broken.code, tail: redact(String(E.broken.tail || '').slice(-800)) };
            problems.push(`The build environment does not set up: ${redact(E.broken.reason.slice(0, 600))}. Fix environment.proposed.json (setup, env, services) so every worktree can build.`);
          } else setup = { status: 'ok', ran: (E.ran || []).map((x) => ({ cmd: x.cmd, code: x.code })), cached: Boolean(E.cached) };
        }
        if (!e || (E && E.ok)) {
          // the dry-run writes only into its scratch worktree: home, temp and the usual caches
          // point inside it (an OS sandbox it is not: a command could still name a path outside,
          // which the check after the run reports)
          const penv = probeEnv(root, probeId, E && E.env ? envMod.processEnv(E.env, E.vars) : {}, homeEnv);
          const before = rootStatus(root);
          for (const t of plan.tasks) {
            for (const c of t.verify_commands || []) {
              const cmd = cmdOf(c);
              if ((Date.now() - started) / 1000 > S.budget) {
                commands.push({ task: t.id, cmd, class: 'skipped', ok: true, why: `the probe's time budget (${S.budget}s) ran out` });
                continue;
              }
              // a command lint flagged (a background process, a sleep, a fixed port) is not run
              if (flagged.has(`${t.id}\0${cmd}`)) {
                commands.push({ task: t.id, cmd, class: 'lint_skipped', ok: false, why: 'not run: lint flagged it (see the problems)' });
                continue;
              }
              const r = runBounded(E && E.env ? envMod.wrap(E.env, E.vars, cmd) : cmd, wt, S.perCommand, penv);
              const k = classify(r, plan);
              const left = survivors(probeId, { sid: r.sid, wt });
              commands.push({ task: t.id, cmd, code: r.code, ms: r.ms, class: left.length ? 'escaped' : k.class, ok: k.ok && !left.length, why: left.length ? `left ${left.length} process(es) running after it ended (killed): ${left.map((x) => x.cmd).join('; ')}` : k.why, tail: redact(String(r.output || '').trim().split('\n').slice(-12).join('\n')).slice(-1200) });
              if (left.length) problems.push(`${t.id}: \`${cmd}\` left ${left.length} process(es) running after it ended (the probe killed them): ${left.map((x) => x.cmd).join('; ')}. A verify command must stop everything it starts.`);
              else if (!k.ok) problems.push(`${t.id}: \`${cmd}\` cannot run in the build environment: ${k.why}. Output (tail): ${redact(String(r.output || '').trim().split('\n').slice(-4).join(' | ')).slice(-400)}`);
              // undo what a command left behind (a cache, a db file) before the next one
              git.run(wt, ['checkout', '--', '.'], { allowFail: true });
            }
          }
          const after = rootStatus(root);
          if (after !== before) problems.push(`The dry-run changed files in your checkout, outside its scratch worktree (git status before: ${before ? before.split('\n').length : 0} line(s), after: ${after ? after.split('\n').length : 0}): a verify command writes outside the repository's worktree; make it write only under its own directory.`);
        }
      } finally {
        try {
          if (e) {
            const { evidence: _e, notes: _n, source: _s, ...runEnv } = e;
            envMod.teardown(root, null, { taskId: 'probe', wt, env: runEnv });
            if (runEnv.services && runEnv.services.down) spawnSync('bash', ['--noprofile', '--norc', '-c', envMod.expand(runEnv.services.down, envMod.vars(root, null, 'probe', wt))], { cwd: root, timeout: Math.min(600, S.budget) * 1000, stdio: ['ignore', 'pipe', 'pipe'], env: probeEnv(root, probeId, {}, homeEnv) });
          }
          for (const x of survivors(probeId, { wt })) problems.push(`A process of the probe's setup or services was still running at the end and was killed: ${x.cmd}`);
        } catch {
          /* best effort */
        }
        git.run(root, ['worktree', 'remove', '--force', wt], { allowFail: true });
        try {
          fs.rmSync(wt, { recursive: true, force: true });
        } catch {
          /* gone */
        }
        git.run(root, ['worktree', 'prune'], { allowFail: true });
      }
    }
  }
  const doc = seal({
    version: 1,
    job: state.id,
    at: nowIso(),
    plan: planHash,
    environment: gate.hash,
    environment_name: (gate.env && gate.env.name) || null,
    greenfield: green,
    mode: runMode,
    ...(machine ? { machine: require('./machine').summary(machine) } : {}),
    ok: problems.length === 0,
    ms: Date.now() - started,
    setup,
    lint,
    commands,
    problems: problems.map(redact),
  });
  writeJson(FILE(root, state.id), doc);
  try {
    require('./events').append(root, { event: 'plan_probe', job: state.id, ok: doc.ok, problems: problems.length, commands: commands.length, ms: doc.ms });
  } catch {
    /* the log is a convenience */
  }
  return { job: state.id, file: FILE(root, state.id), ...doc };
}

function rootStatus(root) {
  try {
    return git.run(root, ['status', '--porcelain', '--untracked-files=all'], { allowFail: true }).stdout;
  } catch {
    return '';
  }
}

function dependsOn(tasks, id, on, seen = new Set()) {
  if (seen.has(id)) return false;
  seen.add(id);
  const t = tasks.find((x) => x.id === id);
  return Boolean(t && (t.depends_on || []).some((d) => d === on || dependsOn(tasks, d, on, seen)));
}

// ---------------------------------------------------------------- the managed run (review MAJ-2)
//
// The probe runs as its own detached process (its own session and process group), never inside
// the caller's shell call: a Bash tool call that times out kills the drive, not the probe, and
// the next `factory plan probe` (the drive's next step) picks up its result instead of starting
// again. Its budget is cut to what the caller's call has left (the drive's deadline, below the
// shell tool's ceiling). Its state is .factory/jobs/<job>/probe.started.json (sealed): the plan
// and environment it probes, the child's pid and start time, its deadline, and how many runs for
// this plan were interrupted (the child died without a result, or overran its deadline and was
// killed as a group). After 2 interrupted runs the job parks with a specific question.

const STARTED = (root, jobId) => path.join(jobPaths(root, jobId).dir, 'probe.started.json');
const MAX_INTERRUPTED = 2;
const ceilingMs = () => (Number(process.env.BASH_MAX_TIMEOUT_MS) > 0 ? Number(process.env.BASH_MAX_TIMEOUT_MS) : 600000);
// When the caller's shell call ends: the drive passes its deadline; a direct call gets the
// ceiling from now, less a margin.
function callerDeadline() {
  const d = Number(process.env.FACTORY_DRIVE_DEADLINE);
  const own = Date.now() + ceilingMs() - 60000;
  return d > 0 ? Math.min(d, own) : own;
}
// the probe's own scratch directories (a home, temp and caches inside its box): also used by a
// sandboxed env check (environment.check of a proposal or a repair candidate)
const ownDirs = (box) => ({ HOME: path.join(box, 'home'), TMPDIR: path.join(box, 'tmp'), TMP: path.join(box, 'tmp'), TEMP: path.join(box, 'tmp'), XDG_CACHE_HOME: path.join(box, 'cache'), XDG_CONFIG_HOME: path.join(box, 'home', '.config'), XDG_DATA_HOME: path.join(box, 'home', '.local', 'share'), npm_config_cache: path.join(box, 'cache', 'npm'), PIP_CACHE_DIR: path.join(box, 'cache', 'pip') });

function readStarted(root, jobId) {
  const s = readJson(STARTED(root, jobId), null);
  return s && valid(s) ? s : null;
}
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
  } catch {
    /* no wait available: poll */
  }
}
// The child's group and every tagged or scratch-worktree process of its run, killed; its scratch
// worktree removed.
function killRun(root, st) {
  if (st && st.pid && sameProcess(st.pid, st.pid_start)) {
    try {
      process.kill(-Number(st.pid), 'SIGKILL');
    } catch {
      try {
        process.kill(Number(st.pid), 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  }
  const left = st && st.probe_id ? survivors(st.probe_id) : [];
  sweep(root);
  return left;
}

// What the plan probe step does (factory plan probe; the drive runs it as a long CLI step):
// returns the probe record, { pending: true } while the detached run goes on past the caller's
// deadline, or { parked: true } after MAX_INTERRUPTED interrupted runs of this plan.
function runManaged(root, { jobId, deadline = callerDeadline() } = {}) {
  const job = require('./job');
  const envMod = require('./environment');
  const state = job.resolve(root, jobId);
  if (!enabled(root, state)) return run(root, { jobId: state.id });
  const done = current(root, state);
  if (done) return { job: state.id, file: FILE(root, state.id), reused: true, ...done };
  const jp = jobPaths(root, state.id);
  if (!exists(jp.plan)) return run(root, { jobId: state.id });
  // validation normalises the plan file (its waves): hash it as every later reader will see it
  try {
    require('./plan').validate(root, state);
  } catch {
    /* an invalid plan is probed as it is */
  }
  const planHash = hashFile(jp.plan);
  const envHash = envMod.gateProposal(root, state.id).hash;
  // lint only: nothing runs, nothing to detach
  if (mode(root, state) === 'lint') return run(root, { jobId: state.id });
  let st = readStarted(root, state.id);
  const same = st && st.plan === planHash && st.environment === envHash;
  let interrupted = same ? st.interrupted || 0 : 0;
  if (same && !st.finished) {
    const alive = sameProcess(st.pid, st.pid_start);
    const overdue = Date.now() > Date.parse(st.deadline_at) + 120000;
    if (alive && !overdue) return waitFor(root, state, st, deadline);
    // died without a result, or ran far past its deadline: interrupted
    const left = killRun(root, st);
    interrupted += 1;
    try {
      require('./events').append(root, { event: 'plan_probe_interrupted', job: state.id, probe_id: st.probe_id, interrupted, overdue, killed: left.length });
    } catch {
      /* the log is a convenience */
    }
    writeJson(STARTED(root, state.id), seal({ ...st, finished: true, outcome: overdue ? 'overdue' : 'died', interrupted, ended_at: nowIso() }));
  }
  if (interrupted >= MAX_INTERRUPTED) return parkInterrupted(root, state, interrupted);
  // the time this call has, less a command's cap and a margin, is the run's budget
  const S = settings(state);
  const left = Math.floor((deadline - Date.now()) / 1000) - S.perCommand - 20;
  if (left < 20) return { job: state.id, pending: true, started: false, ok: false, problems: [], message: 'The plan probe needs a fresh call to start (too little of this call\'s time is left): run it again.' };
  const probeId = require('crypto').randomBytes(8).toString('hex');
  const budget = Math.min(S.budget, left);
  const logFile = path.join(jp.dir, 'probe.log');
  const out = fs.openSync(logFile, 'w');
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'bin', 'factory'), '--root', root, 'plan', 'probe', '--job', state.id, '--child', probeId, '--budget', String(budget)], { cwd: root, detached: true, stdio: ['ignore', out, out], env: { ...process.env, FACTORY_PROBE_CHILD: probeId }, windowsHide: true });
  fs.closeSync(out);
  child.unref();
  st = seal({ version: 1, job: state.id, plan: planHash, environment: envHash, probe_id: probeId, pid: child.pid, pid_start: procStart(child.pid), at: nowIso(), budget, deadline_at: new Date(Date.now() + (budget + S.perCommand + 60) * 1000).toISOString(), interrupted, finished: false });
  writeJson(STARTED(root, state.id), st);
  try {
    require('./events').append(root, { event: 'plan_probe_started', job: state.id, probe_id: probeId, pid: child.pid, budget, interrupted });
  } catch {
    /* the log is a convenience */
  }
  return waitFor(root, state, st, deadline);
}

function waitFor(root, state, st, deadline) {
  while (Date.now() < deadline - 3000) {
    const r = current(root, state);
    if (r) return { job: state.id, file: FILE(root, state.id), ...r };
    if (!sameProcess(st.pid, st.pid_start)) {
      // it just ended: its record may land a moment after
      sleepMs(300);
      const r2 = current(root, state);
      if (r2) return { job: state.id, file: FILE(root, state.id), ...r2 };
      return runManaged(root, { jobId: state.id, deadline });
    }
    sleepMs(250);
  }
  return { job: state.id, pending: true, started: true, probe_id: st.probe_id, ok: false, problems: [], message: `The plan probe is still running (its own process, pid ${st.pid}, until ${st.deadline_at} at most): run factory plan probe again (factory drive does) to pick up its result; it is not started again.` };
}

// Two interrupted runs of this plan: the job asks how to probe it (never a third silent restart).
function parkInterrupted(root, state, n) {
  const fresh = require('./job').load(root, state.id);
  if (fresh.status === 'parked') return { job: state.id, parked: true, ok: false, problems: [], message: `${state.id} is parked: ${fresh.park && fresh.park.reason}` };
  const reason = `The plan probe was interrupted ${n} times before it finished (it died, or ran out of time and was stopped).`;
  require('./decision-table').park(root, fresh, reason, 'decompose', {
    kind: 'plan_probe',
    question: {
      question: 'The plan probe could not finish within the drive\'s time, twice. How should the plan be probed?',
      options: [
        { key: 'a', text: 'Lint only for this job: check the verify commands without running them (the gate shows nothing ran)' },
        { key: 'b', text: `I run it in my own terminal: factory plan probe --job ${state.id} (not human-only), then reply resume` },
        { key: 'c', text: 'No probe for this job: the plan gate says it was not probed' },
      ],
      recommendation: 'b',
    },
  });
  return { job: state.id, parked: true, ok: false, problems: [reason], message: `${reason} ${state.id} is parked with a question.` };
}

// The detached child's entry (factory plan probe --child <id>): runs the probe and marks the
// started record finished; a probe that throws still leaves a (failed) sealed record.
function runChild(root, { jobId, probeId, budget }) {
  const job = require('./job');
  const state = job.resolve(root, jobId);
  let r;
  try {
    r = run(root, { jobId: state.id, probeId, budget });
  } catch (e) {
    const jp = jobPaths(root, state.id);
    const doc = seal({ version: 1, job: state.id, at: nowIso(), plan: exists(jp.plan) ? hashFile(jp.plan) : null, environment: require('./environment').gateProposal(root, state.id).hash, ok: false, ms: 0, setup: { status: 'error' }, lint: [], commands: [], problems: [redact(`The plan probe failed: ${String(e.message || e).slice(0, 400)}`)] });
    writeJson(FILE(root, state.id), doc);
    r = doc;
  }
  const st = readStarted(root, state.id);
  if (st && st.probe_id === probeId) writeJson(STARTED(root, state.id), seal({ ...st, finished: true, outcome: 'done', ended_at: nowIso() }));
  return r;
}

// The probe record for the plan as it is now, or null (none, stale, or edited by hand).
function current(root, state) {
  const p = readJson(FILE(root, state.id), null);
  if (!p || !valid(p)) return null;
  const jp = jobPaths(root, state.id);
  if (!exists(jp.plan) || p.plan !== hashFile(jp.plan)) return null;
  if (p.environment !== require('./environment').gateProposal(root, state.id).hash) return null;
  // a record made in another mode (lint only, full) is not this one's
  const m = mode(root, state);
  if (m && p.mode && p.mode !== m) return null;
  return p;
}

// A fingerprint of the problems, to tell a loop that makes progress from one that does not.
function problemKey(p) {
  return sha256(stableStringify([...((p && p.problems) || [])].map((x) => String(x).replace(/Output \(tail\):.*$/, '')).sort()));
}

module.exports = { ownDirs, splitLogin, cleanNetValue, urlCarriesToken, stripCreds, PROXY, runManaged, runChild, readStarted, procStat, sameProcess, STARTED, MAX_INTERRUPTED, mode, probeEnv, redact, survivors, sweep, NETWORK_SETUP, enabled, run, current, classify, lintCommand, greenfield, planOwns, problemKey, FILE, LINT };
