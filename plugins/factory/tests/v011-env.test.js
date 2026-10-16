'use strict';
// 0.11 machine-aware build environments (ported from copilot-factory 0.11.0, its fix 0.10.1 part 2):
// the machine's tool inventory (doctor, proposals, the planner's brief), lint against the machine
// in the plan probe (lint-only mode too), the sealed environment checked before any task, and the
// environment repair loop the human seals with one reply. An unconfirmed environment's check runs
// sandboxed like the probe. Every test uses a fixed machine or PATH shims, a temp cache and no
// network (tests/helpers/fixture.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');

const core = (m) => require(`../cli/core/${m}`);
const next = (root) => F.cli(root, ['next']);

function newJob(root, { type = 'feature', risk = 'medium' } = {}) {
  return F.cli(root, ['job', 'new', '--title', 'x', '--type', type, '--risk', risk]).job;
}
function writePlan(root, J, tasks) {
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks }));
}
const task = (id, cmds, extra = {}) => ({ id, objective: id, allowed_paths: [`src/${id.toLowerCase()}.js`], criteria_ids: ['AC-1'], verify_commands: cmds, ...extra });

test('MAJ-3: env check on an unconfirmed (proposed) environment runs like the probe: no login shell, no token, a scratch home', (t) => {
  const root = F.makeRepo(t);
  const out = path.join(root, '..', `maj3c-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(out, { force: true }));
  const env = { version: 1, name: 'shells', setup: [`echo "shell=$(shopt -q login_shell && echo login || echo nologin) home=$HOME tok=\${GH_TOKEN:-none}" > ${out}`] };
  fs.writeFileSync(path.join(root, '.factory', 'environment.proposed.json'), JSON.stringify(env));
  const r = F.cli(root, ['env', 'check', '--proposed'], { env: { GH_TOKEN: 'ghs_callertoken1234567890' } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.which, 'proposed');
  const line = fs.readFileSync(out, 'utf8');
  assert.match(line, /shell=nologin home=\S*_envcheck-\d+\/\.factory-probe\/home tok=none/, line);
  assert.ok(!fs.readdirSync(path.join(root, '.factory', 'worktrees')).some((n) => n.startsWith('_envcheck-')), 'its worktree is gone');
});

// ------------------------------------------------------------------ MAJ-2


const MH = require('./helpers/machine');
const T = require('./helpers/tmp');

// PATH shims: a python3 whose venv lacks ensurepip (WSL Ubuntu 22.04 without python3.10-venv),
// virtualenv, a docker that needs sudo, a curl that reaches the index, a sudo that wants a password.
function shims(t) {
  const dir = T.mkdtemp('factory-shims-', t);
  const sh = (name, body) => {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`);
    fs.chmodSync(path.join(dir, name), 0o755);
  };
  sh('python3', '[ "$1" = -I ] && shift; case "$1" in --version) echo "Python 3.10.12";; -m) if [ "$2" = venv ]; then echo "The virtual environment was not created successfully because ensurepip is not" >&2; echo "available.  On Debian/Ubuntu systems, you need to install the python3-venv" >&2; echo "package using the following command." >&2; echo "    apt install python3.10-venv" >&2; exit 1; fi;; esac');
  sh('virtualenv', 'echo "virtualenv 20.25.0 from /usr/lib/python3/dist-packages/virtualenv/__init__.py"');
  sh('docker', 'case "$1" in --version) echo "Docker version 24.0.7";; compose) echo "Docker Compose version v2.21.0";; info) echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1;; esac');
  sh('curl', 'echo "200 0.052"');
  sh('sudo', 'exit 1');
  return dir;
}

test('machine inventory (PATH shims): python versions, a venv that fails for want of ensurepip, virtualenv but no uv, docker needing sudo, sudo with a password, the index reachable; cached per machine; doctor shows it with remedies', (t) => {
  const dir = shims(t);
  const cache = T.mkdtemp('factory-cache-', t);
  const env = { FACTORY_MACHINE_PATH: dir, XDG_CACHE_HOME: cache, FACTORY_MACHINE_FILE: '', FACTORY_MACHINE_OFFLINE: '' };
  const run = (code) => JSON.parse(spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(${code}))`], { cwd: F.PLUGIN, encoding: 'utf8', env: { ...process.env, ...env } }).stdout);
  const inv = run("require('./cli/core/machine').inventory()");
  assert.deepEqual(inv.python.map((p) => [p.cmd, p.version]), [['python3', '3.10.12']]);
  assert.equal(inv.venv.works, false);
  assert.match(inv.venv.why, /ensurepip is not|python3-venv|apt install/);
  assert.ok(inv.tools.virtualenv && !inv.tools.uv && !inv.tools.poetry);
  assert.deepEqual(inv.docker, { present: true, compose: 'docker compose', daemon: 'needs_sudo' });
  assert.equal(inv.sudo, 'unknown', 'sudo is present but never probed (no auth-failure log line)');
  assert.deepEqual([inv.network.pypi.ok, inv.network.pypi.code, inv.network.pypi.ms], [true, 200, 52]);
  assert.equal(run("require('./cli/core/machine').pythonInstaller(require('./cli/core/machine').inventory())"), 'virtualenv');
  // cached: the second call is the first's scan
  assert.equal(run("require('./cli/core/machine').inventory().at"), inv.at);
  assert.ok(fs.readdirSync(path.join(cache, 'factory')).some((f) => /^machine-[0-9a-f]+\.json$/.test(f)));
  // doctor
  const root = F.makeRepo(t);
  const d = F.cli(root, ['doctor', '--machine'], { env });
  const c = (n) => d.checks.find((x) => x.name === `machine: ${n}`);
  assert.equal(c('python3 -m venv').ok, false);
  assert.match(c('python3 -m venv').detail, /Remedy: environments use virtualenv instead/);
  assert.match(c('docker').detail, /daemon needs_sudo[\s\S]*docker group/);
  assert.match(c('python tools').detail, /virtualenv/);
  assert.equal(c('python3 -m venv').level, 'warning', 'a machine fact never blocks the doctor by itself');
});

test('environment proposals use the machine: uv first, poetry for a poetry repo, virtualenv, python3 -m venv only when it works; pip retries', (t) => {
  const E = core('environment');
  const root = F.makeRepo(t);
  F.write(root, 'pyproject.toml', '[project]\nname = "x"\n');
  F.write(root, 'requirements-dev.txt', 'pytest==8.2.0\n');
  F.sh(root, 'git add -A && git commit -qm py');
  const d = (inv) => E.detect(root, { machine: inv });
  const uv = d(MH.inventory({ venv: false, tools: { uv: true, virtualenv: true } }));
  assert.equal(uv.name, 'python-uv');
  assert.deepEqual(uv.setup, ['uv venv -q --allow-existing .venv', 'uv pip install -q --python .venv/bin/python -e .', 'uv pip install -q --python .venv/bin/python -r requirements-dev.txt']);
  assert.equal(uv.env.UV_HTTP_TIMEOUT, '60');
  const ve = d(MH.inventory({ venv: false, tools: { virtualenv: true } }));
  assert.equal(ve.setup[0], 'virtualenv -q .venv');
  assert.ok(ve.setup.slice(1).every((s) => /--retries 5 --timeout 60/.test(s)), JSON.stringify(ve.setup));
  assert.deepEqual(E.lint(ve, { root, machine: MH.inventory({ venv: false, tools: { virtualenv: true } }) }), [], 'what the factory proposes passes its own lint');
  assert.equal(d(MH.inventory({ venv: true })).setup[0], 'python3 -m venv .venv');
  const none = d(MH.inventory({ venv: false }));
  assert.match(none.notes, /install uv \(no sudo\)/);
  assert.equal(E.lint(none, { root, machine: MH.inventory({ venv: false }) })[0].rule, 'venv_no_ensurepip');
  F.write(root, 'pyproject.toml', '[tool.poetry]\nname = "x"\n');
  F.write(root, 'poetry.lock', '\n');
  const po = d(MH.inventory({ venv: true, tools: { poetry: true, virtualenv: true } }));
  assert.equal(po.name, 'python-poetry');
  assert.deepEqual(po.setup, ['poetry install --no-interaction']);
  assert.equal(po.env.POETRY_VIRTUALENVS_IN_PROJECT, 'true');
  // the planner is told the machine and the rules
  assert.match(fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'wfargs.js'), 'utf8'), /This machine \(its tool inventory/);
});

// The J-0001 environment: python3 -m venv without ensurepip, requirements.txt written by T1, a
// Postgres health check that runs once, pip without retries.
const J0001_ENV = {
  version: 1,
  name: 'django-postgres',
  setup: ['python3 -m venv .venv', '.venv/bin/pip install -r requirements.txt'],
  env: { PATH: '{worktree}/.venv/bin:$PATH' },
  services: { up: 'docker compose -f dev/compose.yml up -d db', health: 'pg_isready -h localhost -p 5432', down: 'docker compose -f dev/compose.yml down' },
};
const J0001_PLAN = [
  { id: 'T1', objective: 'scaffold', allowed_paths: ['requirements.txt', 'app/**'], criteria_ids: ['AC-1'], verify_commands: ['python -m pytest -q app'] },
  { id: 'T2', objective: 'feature', allowed_paths: ['app/views.py'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: ['python -m pytest -q app'] },
];

test('lint (J-0001 reproduced): venv without ensurepip, a missing tool, sudo, setup reading a file T1 creates, a single-shot health check, pip without retries; caught by the plan probe in lint-only mode, before the gate', (t) => {
  const root = F.makeRepo(t);
  F.write(root, 'dev/compose.yml', 'services: {}\n');
  F.sh(root, 'git add -A && git commit -qm compose');
  const J = newJob(root);
  const inv = MH.inventory({ venv: false, tools: { virtualenv: true, docker: true } });
  const mf = MH.use(inv);
  const prevMachine = process.env.FACTORY_MACHINE_FILE;
  t.after(() => { process.env.FACTORY_MACHINE_FILE = prevMachine; });
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { plan_probe: 'lint' } }));
  fs.writeFileSync(core('environment').JOB_PROPOSED(root, J), JSON.stringify({ ...J0001_ENV, setup: [...J0001_ENV.setup, 'uv pip install -q --python .venv/bin/python ruff', 'sudo apt-get install -y libpq-dev'] }));
  writePlan(root, J, J0001_PLAN);
  const r = F.cli(root, ['plan', 'probe'], { env: { FACTORY_MACHINE_FILE: mf } });
  assert.equal(r.mode, 'lint');
  assert.equal(r.ok, false);
  const rules = r.lint.filter((l) => l.task === 'environment').map((l) => l.rule).sort();
  assert.deepEqual([...new Set(rules)], ['missing_tool', 'needs_sudo', 'pip_no_retries', 'setup_reads_plan_file', 'single_health_check', 'venv_no_ensurepip']);
  const p = r.problems.join('\n');
  assert.match(p, /reads requirements\.txt, which T1 creates \(not a bootstrap task\)[\s\S]*Install from pins directly/);
  assert.match(p, /`python3 -m venv` does not work on this machine[\s\S]*use `virtualenv \.venv`/);
  assert.match(p, /health check runs once/);
  assert.match(p, /`uv` is not installed on this machine/);
  assert.equal(r.machine.python3_venv_works, false, 'the record carries the machine it was linted for');
  // the repaired proposal passes the lint: virtualenv, pins installed directly with retries, a health loop
  const FIXED = { ...J0001_ENV, setup: ['virtualenv -q .venv', ".venv/bin/pip install -q --retries 5 --timeout 60 'django==5.0.6' 'psycopg[binary]==3.1.19' pytest==8.2.0"], services: { ...J0001_ENV.services, health: 'for i in $(seq 60); do pg_isready -h localhost -p 5432 && exit 0; sleep 1; done; exit 1' } };
  fs.writeFileSync(core('environment').JOB_PROPOSED(root, J), JSON.stringify(FIXED));
  const r2 = F.cli(root, ['plan', 'probe'], { env: { FACTORY_MACHINE_FILE: mf } });
  assert.deepEqual(r2.lint.filter((l) => l.task === 'environment'), [], JSON.stringify(r2.lint));
  // with a bootstrap T1 the requirements file is fine
  writePlan(root, J, [{ ...J0001_PLAN[0], bootstrap: true }, J0001_PLAN[1]]);
  assert.ok(!core('environment').lint(J0001_ENV, { root, plan: { tasks: [{ ...J0001_PLAN[0], bootstrap: true }] }, machine: inv }).some((l) => l.rule === 'setup_reads_plan_file'));
});

// A job at H3 of a medium feature with this environment proposed (the probe off, as in J-0001).
function toCombinedGate(t, env) {
  const root = F.makeRepo(t);
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { plan_probe: false } }));
  const J = newJob(root);
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  F.clarify(root);
  next(root);
  F.reply(root, 'approve');
  F.cli(root, ['deps', 'fetch']);
  const g = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(g, 'ok', { topics: [{ topic: 'codebase', claims: [], unknowns: [] }], degraded: [] }));
  // design depth (adr@2): the plan's files come from the design's Project layout; T1 writes
  // requirements.txt (the J-0001 setup reads it), so the layout names it
  F.write(F.jobDir(root, J), 'adr-001-x.md', F.adrText({ job: J, layout: F.layoutLines([['src/add.js', 'changed', ['AC-1'], 'add(a, b) returns the sum'], ['tests/add.test.js', 'existing', ['AC-1'], 'proves add(2, 3) is 5'], ['requirements.txt', 'new', ['AC-1'], 'the pinned Python dependencies']]) }));
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'decide']);
  F.record(root, F.envelope(b, 'ok', { options: [], degraded: [], judge: { kind: 'adr', paths: [path.join(F.jobDir(root, J), 'adr-001-x.md')], summary: 's' }, critiques: [{ verdict: 'approve', items: [] }] }));
  b = F.cli(root, ['wfargs', 'decompose']);
  writePlan(root, J, [{ id: 'T1', objective: 'fix', allowed_paths: ['src/add.js', 'requirements.txt'], criteria_ids: ['AC-1'], verify_commands: ['node tests/add.test.js'] }]);
  fs.writeFileSync(core('environment').JOB_PROPOSED(root, J), JSON.stringify(env));
  const rec = F.record(root, F.envelope(b, 'ok', { planner: { valid: true, errors: [], path: 'plan.json' }, critique: { verdict: 'approve', items: [] } }));
  assert.equal(rec.status, 'ok', JSON.stringify(rec.errors || rec));
  assert.equal(next(root).step, 'H3');
  return { root, J };
}

test('J-0001 after H3: the sealed environment is checked before any task; it fails (no ensurepip, requirements.txt from T1, a slow DB checked once); the repair loop escalates, a repair passes in a scratch worktree, one question seals it, the gate is not asked again; no attempt spent', (t) => {
  const dir = shims(t);
  const box = T.mkdtemp('factory-db-', t);
  const ready = path.join(box, 'ready');
  // the slow database: it is ready a moment after it starts
  const BROKEN = { version: 1, name: 'django-postgres', setup: [`${dir}/python3 -m venv .venv`, '.venv/bin/pip install -r requirements.txt'], services: { up: `rm -f ${ready}; (sleep 1; touch ${ready}) >/dev/null 2>&1 & echo $! > ${ready}.pid`, health: `test -f ${ready}`, down: `kill $(cat ${ready}.pid) 2>/dev/null; rm -f ${ready} ${ready}.pid` } };
  const { root, J } = toCombinedGate(t, BROKEN);
  const mf = MH.use(MH.inventory({ venv: false, tools: { virtualenv: true, git: true } }));
  const prevMachine = process.env.FACTORY_MACHINE_FILE;
  t.after(() => { process.env.FACTORY_MACHINE_FILE = prevMachine; });
  const env = { FACTORY_MACHINE_FILE: mf };
  F.reply(root, 'approve');
  // the gate was reached with the probe off (as J-0001 was); repair candidates obey the same
  // switch (release review M3), so the repair loop here runs with the probe on
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({}));
  const sealed = core('environment').load(root);
  assert.equal(sealed.name, 'django-postgres');
  const approvedH3 = core('job').load(root, J).approvals.H3.hash;
  // 1. the check, before any task
  let n = F.cli(root, ['next'], { env });
  assert.equal(n.step, 'env_check');
  assert.equal(n.command, `factory env check --job ${J}`);
  const ck = F.cli(root, ['env', 'check', '--job', J], { env });
  assert.equal(ck.ok, false);
  assert.match(ck.broken.reason, /test -f \S*ready exit 1/, 'the database was checked once, before it was ready');
  // 2. the repair loop: the planner in repair mode, with the failure and the machine
  n = F.cli(root, ['next'], { env });
  assert.equal(n.step, 'env_repair');
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'env_repair'], { env });
  const text = fs.readFileSync(b.judge.prompt.split('\n')[1].trim(), 'utf8');
  assert.match(text, /"python3_venv_works": false/);
  for (const rule of ['single_health_check', 'pip_no_retries', 'venv_no_ensurepip', 'setup_reads_plan_file']) assert.match(text, new RegExp(`"rule": "${rule}"`), rule);
  assert.equal(b.judge.model || null, null, 'first round on the planner\'s own model');
  const R = core('env-repair').REPAIR(root, J);
  // round 1: the agent changes nothing useful: no progress, the next round escalates
  fs.writeFileSync(R, JSON.stringify(BROKEN));
  let rec = F.recordRepair(root, J, b, { repair: { path: R, summary: 'same' } }, { env });
  assert.equal(rec.status, 'retry', JSON.stringify(rec));
  assert.equal(core('job').load(root, J).status, 'active');
  assert.equal(F.cli(root, ['next'], { env }).step, 'env_repair');
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'env_repair'], { env });
  assert.ok(b.judge.model, 'escalated to the stronger model');
  // round 2: virtualenv, pins installed directly with retries (no requirements.txt), a health loop
  const FIXED = { ...BROKEN, setup: ['mkdir -p .venv/bin'], services: { ...BROKEN.services, health: `for i in $(seq 100); do test -f ${ready} && exit 0; sleep 0.1; done; exit 1` } };
  fs.writeFileSync(R, JSON.stringify(FIXED));
  rec = F.recordRepair(root, J, b, { repair: { path: R, summary: 'wait for the database' } }, { env });
  assert.equal(rec.status, 'park', JSON.stringify(rec));
  assert.equal(rec.park.kind, 'environment_repair');
  let st = core('job').load(root, J);
  assert.match(st.park.question, /- setup: .*python3 -m venv[\s\S]*\+ setup: mkdir -p \.venv\/bin[\s\S]*\+ services\.health: for i in/);
  assert.deepEqual(core('environment').load(root).setup, BROKEN.setup, 'not sealed until the human says so');
  // 3. one question, one explicit reply: a bare "yes" never seals; "approve environment <hash>" does
  assert.throws(() => core('human').replyToPark(root, { jobId: J, text: 'yes', channel: 'chat' }), /does not seal/);
  const short = st.env_repair.short;
  assert.match(st.park.question, new RegExp(`Seal the repaired build environment ${short}`));
  const ans = core('human').replyToPark(root, { jobId: J, text: `approve environment ${short}`, channel: 'chat' });
  assert.equal(ans.resumed, true);
  assert.deepEqual(core('environment').load(root).setup, FIXED.setup);
  st = core('job').load(root, J);
  assert.notEqual(st.approvals.H3.hash, approvedH3, 'the gate\'s approval moved with the sealed repair');
  assert.ok(st.approvals.H3.environment_repaired);
  n = F.cli(root, ['next'], { env });
  assert.equal(n.step, 'env_check', 'the gate is not asked again; the sealed fix is checked');
  assert.equal(F.cli(root, ['env', 'check', '--job', J], { env }).ok, true);
  n = F.cli(root, ['next'], { env });
  assert.equal(n.workflow, 'realize');
  assert.equal(Object.values(core('job').load(root, J).tasks || {}).reduce((a, x) => a + (x.attempts || 0), 0), 0, 'no task attempt was spent on the environment');
});

test('environment repair: without progress the loop stops with a specific question (never a bare resume); "approve environment" with nothing to seal is refused', (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  const BAD = { version: 1, name: 'bad', setup: ['echo "No matching distribution found for nautobot==9.9" >&2; exit 3'] };
  core('environment').confirm(root, { env: BAD, channel: 'tty' });
  const ER = core('env-repair');
  ER.checkForJob(root, core('job').load(root, J));
  assert.equal(ER.routerAction({ root, state: core('job').load(root, J) }).step, 'env_repair');
  // a repair the router did not route is refused (release review B2)
  fs.writeFileSync(ER.REPAIR(root, J), JSON.stringify(BAD));
  assert.throws(() => ER.record(root, core('job').load(root, J), {}), /No environment repair is open/);
  let last = null;
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(ER.REPAIR(root, J), JSON.stringify(BAD));
    core('job').mutate(root, J, (x) => { x.last_decision = 'workflow:env_repair::'; });
    last = ER.record(root, core('job').load(root, J), {});
    // (0.11 port review M-1: the candidate's check is its own long step after the record)
    if (last.pending_check) last = ER.checkRepair(root, core('job').load(root, J));
    if (last.status === 'park') break;
  }
  assert.equal(last.status, 'park');
  assert.equal(last.park.kind, 'environment_broken');
  const parked = core('job').load(root, J).park;
  assert.match(parked.question, /still does not set up on this machine \(echo "No matching distribution/);
  assert.equal(parked.options.length, 3);
  assert.throws(() => F.reply(root, 'approve environment'), /no repaired build environment waiting/);
  assert.equal(core('human').parseReply('approve environment').cmd, 'approve_environment');
  assert.ok(core('human').readReply('approve environment').reply);
});

test('proxies and index URLs reach the probe and a proposal\'s check by default; a login in their URL is stripped (unless policy decompose.probe_proxy_credentials) and redacted in output; probe_proxy false keeps them out', (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  const show = `node -e "console.log('p='+process.env.HTTPS_PROXY+' l='+process.env.https_proxy+' n='+process.env.NO_PROXY+' i='+process.env.PIP_INDEX_URL+' u='+process.env.UV_INDEX_URL+' r='+process.env.npm_config_registry); console.log('echo http://bob:s3cr'+'3tpw@proxy.corp:8080'); process.exit(1)"`;
  writePlan(root, J, [task('T1', [show])]);
  const env = { HTTPS_PROXY: 'http://bob:s3cr3tpw@proxy.corp:8080', https_proxy: 'http://bob:s3cr3tpw@proxy.corp:8080', NO_PROXY: 'localhost,.corp', PIP_INDEX_URL: 'https://ci:idxtoken99@pypi.corp/simple', UV_INDEX_URL: 'https://pypi.corp/simple', npm_config_registry: 'https://npm.corp/' };
  let r = F.cli(root, ['plan', 'probe'], { env });
  const tail = r.commands[0].tail;
  assert.match(tail, /p=http:\/\/proxy\.corp:8080 l=http:\/\/proxy\.corp:8080 n=localhost,\.corp i=https:\/\/pypi\.corp\/simple u=https:\/\/pypi\.corp\/simple r=https:\/\/npm\.corp\//, tail);
  assert.match(tail, /echo (\[redacted (HTTPS_PROXY|https_proxy)\]|http:\/\/\[redacted\]@proxy\.corp:8080)/, `a login printed in output is redacted: ${tail}`);
  assert.doesNotMatch(fs.readFileSync(core('probe').FILE(root, J), 'utf8'), /s3cr3tpw|idxtoken99/);
  // the credentials themselves only when the repo says so
  // (claude-factory: plan probe reuses a current record for the same plan and environment, so the
  // record is dropped to probe again under the changed policy)
  const again = () => fs.rmSync(core('probe').FILE(root, J), { force: true });
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { probe_proxy_credentials: true } }));
  again();
  r = F.cli(root, ['plan', 'probe'], { env });
  assert.match(r.commands[0].tail, /p=\[redacted (HTTPS_PROXY|https_proxy)\]/, 'passed with its login, still redacted in what is recorded');
  assert.doesNotMatch(fs.readFileSync(core('probe').FILE(root, J), 'utf8'), /s3cr3tpw/);
  // off
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ decompose: { probe_proxy: false } }));
  again();
  r = F.cli(root, ['plan', 'probe'], { env });
  assert.match(r.commands[0].tail, /p=undefined l=undefined n=undefined i=undefined/);
  // a proposal's env check gets the same environment
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({}));
  const out = path.join(T.mkdtemp('factory-proxy-', t), 'seen');
  fs.writeFileSync(path.join(root, '.factory', 'environment.proposed.json'), JSON.stringify({ version: 1, name: 'p', setup: [`echo "$HTTPS_PROXY $PIP_INDEX_URL" > ${out}`] }));
  assert.equal(F.cli(root, ['env', 'check', '--proposed'], { env }).ok, true);
  assert.equal(fs.readFileSync(out, 'utf8').trim(), 'http://proxy.corp:8080 https://pypi.corp/simple');
});

