'use strict';
// Fixes after the independent review of the 0.9.0 + 0.10.0 port (PORT-AUTO-REVIEW.md):
//   B1    the guard reads replies with the prompt hook's own reader (human.readReply), a recurring
//         schedule's note matches every firing, and a short scheduled text is refused while a job
//         waits on the user;
//   MAJ-1 the CLI's own steps through xargs, and factory record, are never an agent's;
//   MAJ-2 the plan probe is its own CLI step, detached, bounded by the caller's time, picked up
//         after a killed call, and after two interrupted runs the job asks how to probe;
//   MAJ-3 the probe's setup runs in no login shell, with a home inside its scratch worktree;
//   MAJ-4 a grant is one exact file, never a subtree; a builder records only its own task, once
//         per attempt;
//   m1–m7 an escapee that cleared its environment, code-fetching setups, the inline engine's text,
//         a stored answer's lifetime, a file name is no answer, the budget grant's form, and a
//         reused pid in the sweep.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const T = require('./helpers/tmp');

const core = (m) => require(`../cli/core/${m}`);
const stateOf = (root, J) => JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'state.json'), 'utf8'));
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const guard = (root, input) => {
  const r = spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'guard.js')], { input: JSON.stringify({ cwd: root, session_id: 's', hook_event_name: 'PreToolUse', ...input }), encoding: 'utf8' });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
const denied = (o) => Boolean(o && o.permissionDecision === 'deny');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function newJob(root, { risk = 'low', type = 'bug' } = {}) {
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', type, '--risk', risk]).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  return J;
}

// A job parked with a question and options a/b (a loop's diagnosis would ask like this).
function parked(root) {
  const J = newJob(root);
  const st = core('job').load(root, J);
  core('decision-table').park(root, st, 'The review loop stopped.', 'review', { question: { question: 'Should T1 keep the null check in src/add.js?', options: [{ key: 'a', text: 'Keep the null check' }, { key: 'b', text: 'Drop the null check' }], recommendation: 'a' } });
  assert.equal(stateOf(root, J).status, 'parked');
  return J;
}

// ------------------------------------------------------------------------------ B1

test('B1: the guard refuses what the prompt hook would take as a reply — park options, confirmations, ";" batches — with one reader', (t) => {
  const root = F.makeRepo(t);
  newJob(root);
  const H = core('human');
  // one reader: the forms the reviewer found the guard did not know
  for (const x of ['b', 'B)', 'option a', '(b)', '2', 'use it', 'do it', 'yes', '+50%', 'resume +50%', 'approve ship; confirm AC-2; accept finding code-1 known flaky test', 'cancel job; waive ci_reverify not needed here at all', 'ok, but 2 b']) {
    assert.ok(H.readReply(x).reply, x);
    assert.ok(denied(guard(root, { tool_name: 'CronCreate', tool_input: { cron: '*/30 * * * *', prompt: x, recurring: true } })), `CronCreate ${x}`);
  }
  // a long batch in a message to another session too
  assert.ok(denied(guard(root, { tool_name: 'SendMessage', tool_input: { to: 'me', message: 'approve ship; confirm AC-2; accept finding code-1 known flaky test, tracked in the issue' } })));
  // the hook dispatches on the same reader: what it parses is what readReply parsed
  const r = H.readReply('confirm AC-2; approve ship');
  assert.equal(r.parsed.cmd, 'batch');
  const src = fs.readFileSync(path.join(F.PLUGIN, 'hooks', 'prompt.js'), 'utf8');
  assert.match(src, /human\.readReply\(input\.prompt\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'reply-origin.js'), 'utf8'), /function looksLikeReply/, 'no second, narrower list');
  // not replies: an instruction, a slash command
  for (const x of ['check the nightly build and summarise the failures for me in the morning', '/factory:console']) assert.equal(H.readReply(x).reply, false, x);
});

test('B1: a recurring cron "b" never answers a park, on any firing; the schedule\'s note lives as long as the schedule', (t) => {
  const root = F.makeRepo(t);
  const J = parked(root);
  // the guard refuses it outright now
  assert.ok(denied(guard(root, { tool_name: 'CronCreate', tool_input: { cron: '*/30 * * * *', prompt: 'b', recurring: true } })));
  // and had it slipped through (noted as a recurring schedule), every firing is refused
  core('reply-origin').record(root, 'b', { tool: 'CronCreate', recurring: true });
  for (let firing = 1; firing <= 3; firing++) {
    F.say(root, 'b');
    assert.equal(stateOf(root, J).status, 'parked', `firing ${firing}: still parked`);
  }
  assert.ok(!events(root).some((e) => e.event === 'reply_applied'), 'never applied as the user\'s reply');
  // a one-shot message still counts once: the user typing it later is theirs
  core('reply-origin').record(root, 'a', { tool: 'SendMessage' });
  F.say(root, 'a');
  assert.equal(stateOf(root, J).status, 'parked', 'the sent message is not the user\'s');
  F.say(root, 'a');
  assert.equal(stateOf(root, J).status, 'active', 'the user\'s own "a" answers the park');
});

test('B1: while a job waits on the user, a short scheduled or sent text is refused (fail closed); a long instruction is noted and never applied on any firing', (t) => {
  const root = F.makeRepo(t);
  // nothing waits: a short instruction may be scheduled
  const other = F.makeRepo(t);
  newJob(other);
  assert.equal(guard(other, { tool_name: 'CronCreate', tool_input: { cron: '0 9 * * *', prompt: 'keep going with the build' } }), null);
  const J = parked(root);
  // a park waits: the same short text could be taken as the answer
  const d = guard(root, { tool_name: 'CronCreate', tool_input: { cron: '*/30 * * * *', prompt: 'keep going with the build', recurring: true } });
  assert.ok(denied(d));
  assert.match(d.permissionDecisionReason, /J-0001 is waiting on the user's reply/);
  assert.ok(denied(guard(root, { tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 600, prompt: 'drop the null check' } })));
  // clearly not a reply: a slash command, a question
  assert.equal(guard(root, { tool_name: 'CronCreate', tool_input: { cron: '*/30 * * * *', prompt: '/factory:console' } }), null);
  // a long instruction passes the guard, noted as recurring: every firing is refused as a reply
  const long = 'every half hour, look at the build log of the null check work and tell me what failed and why';
  assert.equal(guard(root, { tool_name: 'CronCreate', tool_input: { cron: '*/30 * * * *', prompt: long, recurring: true } }), null);
  for (let firing = 1; firing <= 2; firing++) {
    F.say(root, long);
    assert.equal(stateOf(root, J).status, 'parked', `firing ${firing}: not an answer`);
    assert.equal(stateOf(root, J).park.pending_answer, undefined, `firing ${firing}: not even stored as one`);
  }
});

// ------------------------------------------------------------------------------ MAJ-1

test('MAJ-1: deps fetch, plan probe and task grant fed through xargs, and factory record, are refused to agents; the CLI refuses record while an agent works', (t) => {
  const root = F.makeRepo(t);
  newJob(root);
  const G = require('../hooks/guard-rules');
  const pol = core('policy').defaults();
  const ctx = { agent: true, agentType: 'factory:builder', job: 'J-0001' };
  for (const c of ['echo "deps fetch" | xargs factory', 'echo probe | xargs factory plan', 'printf "%s\\n" grant | xargs factory task T1', 'echo fetch | xargs factory deps', 'factory record --file env.json', 'node bin/factory record --file -']) assert.ok(G.checkBash(root, c, pol, ctx), c);
  // the main session's own: allowed
  assert.equal(G.checkBash(root, 'factory record --file env.json', pol, { agent: false }), null);
  assert.equal(G.checkBash(root, 'echo validate | xargs factory plan', pol, ctx), null, 'another plan verb is not refused');
  // the CLI below the guard: record is the main session's, between workflows
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), event: 'SubagentStart', agent_id: 'a1', agent_type: 'factory:builder' })}\n`);
  const r = F.cli(root, ['record', '--file', 'nothing.json']);
  assert.equal(r.code, 'agent_at_work', JSON.stringify(r));
});

// ------------------------------------------------------------------------------ MAJ-2 and MAJ-3

// A medium job with a valid plan whose verify command takes `secs` seconds (and fails, as a test
// for unbuilt code does).
function probeJob(t, { secs = 4, setup = null } = {}) {
  const root = F.makeRepo(t);
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ limits: { probe_command_seconds: 15 } }));
  const J = newJob(root, { risk: 'medium', type: 'feature' });
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [{ id: 'T1', objective: 'fix add', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: [{ cmd: `node -e "setTimeout(() => process.exit(1), ${secs * 1000})"`, covers: ['AC-1'] }] }] }));
  if (setup) fs.writeFileSync(core('environment').JOB_PROPOSED(root, J), JSON.stringify({ version: 1, name: 'probe-env', setup }));
  return { root, J };
}
const factoryArgs = (root, args) => [path.join(F.PLUGIN, 'bin', 'factory'), '--root', root, ...args];
// `factory plan probe` as a process we can kill, like the Bash tool's timeout does
function startProbeCall(root, env = {}) {
  return spawn(process.execPath, factoryArgs(root, ['plan', 'probe']), { cwd: root, env: { ...process.env, FACTORY_ROOT: '', ...env }, stdio: 'ignore' });
}
const started = (root, J) => JSON.parse(fs.readFileSync(core('probe').STARTED(root, J), 'utf8'));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const probeWorktrees = (root) => {
  try {
    return fs.readdirSync(path.join(root, '.factory', 'worktrees')).filter((n) => /^_probe-/.test(n));
  } catch {
    return [];
  }
};

test('MAJ-2: the probe runs as its own detached process with a budget cut to the caller\'s time; a killed call leaves it running, and the next call picks up its result instead of starting again', async (t) => {
  const { root, J } = probeJob(t, { secs: 4 });
  // the router names it as its own CLI step after a valid plan (the drive runs it as a long step)
  const D = core('drive');
  assert.ok(D.longStepDecision({ label: `plan probe --job ${J}`, verb: 'plan', elapsedSec: 45, job: J }), 'a long step: it starts only in a fresh drive');
  const call = startProbeCall(root, { FACTORY_DRIVE_DEADLINE: String(Date.now() + 90000) });
  for (let i = 0; i < 40 && !fs.existsSync(core('probe').STARTED(root, J)); i++) await sleep(100);
  const st = started(root, J);
  assert.ok(st.budget <= 90 - 15 - 20, `the budget fits inside the caller's time: ${st.budget}s`);
  await sleep(600);
  call.kill('SIGKILL');
  await sleep(200);
  assert.ok(alive(st.pid), 'the detached probe outlives the killed call');
  // the next call waits for it and returns its result; nothing is started again
  const r = F.cli(root, ['plan', 'probe']);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  assert.equal(r.commands[0].class, 'fails_as_expected');
  assert.equal(events(root).filter((e) => e.event === 'plan_probe_started').length, 1, 'started once');
  assert.deepEqual(probeWorktrees(root), [], 'its scratch worktree is gone');
  // a third call reuses the record (same plan, same environment)
  assert.equal(F.cli(root, ['plan', 'probe']).reused, true);
});

test('MAJ-2: two interrupted runs of the same plan park the job with a specific question; the answer sets how it is probed', async (t) => {
  const { root, J } = probeJob(t, { secs: 20 });
  for (let n = 1; n <= 2; n++) {
    const call = startProbeCall(root);
    let st = null;
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      try {
        st = started(root, J);
      } catch {
        st = null;
      }
      if (st && !st.finished && st.interrupted === n - 1) break;
    }
    await sleep(800);
    // the whole run dies (the machine, the user's kill): the caller and the probe's group
    call.kill('SIGKILL');
    try {
      process.kill(-st.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
    await sleep(200);
  }
  const r = F.cli(root, ['plan', 'probe']);
  assert.equal(r.parked, true, JSON.stringify(r).slice(0, 400));
  const s = stateOf(root, J);
  assert.equal(s.status, 'parked');
  assert.equal(s.park.kind, 'plan_probe');
  assert.match(s.park.question, /could not finish within the drive's time, twice/);
  assert.deepEqual(s.park.options.map((o) => o.key), ['a', 'b', 'c']);
  assert.equal(events(root).filter((e) => e.event === 'plan_probe_interrupted').length, 2);
  // what the dead runs left is cleaned: the scratch worktree and every tagged process
  assert.deepEqual(probeWorktrees(root), []);
  // (only this test's runs: other tests may be probing at the same time)
  const ids = events(root).filter((e) => e.event === 'plan_probe_started').map((e) => e.probe_id);
  assert.equal(ids.length, 2);
  const tagged = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
    try {
      const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8');
      return ids.some((id) => env.includes(`FACTORY_PROBE_ID=${id}\0`));
    } catch {
      return false;
    }
  });
  assert.deepEqual(tagged, [], 'no probe process left');
  // the user's answer: lint only for this job
  core('human').replyToPark(root, { jobId: J, text: 'a', channel: 'chat' });
  assert.equal(stateOf(root, J).probe_override, 'lint');
  const l = F.cli(root, ['plan', 'probe']);
  assert.equal(l.mode, 'lint');
  assert.deepEqual(l.commands.map((c) => c.class), ['not_run']);
});

test('MAJ-3: the probe\'s setup runs in no login shell, with a home inside its scratch worktree: a profile exporting a token never runs', (t) => {
  const mark = path.join(T.mkdtemp('factory-mark-', t), 'setup.txt');
  const { root, J } = probeJob(t, { secs: 0, setup: [`(shopt -q login_shell && echo login || echo nologin) > ${mark}; echo "home=$HOME tok=\${GH_TOKEN:-none}" >> ${mark}`] });
  // a profile in the scratch home the probe would use, committed to the repository
  F.write(root, '.factory-probe/home/.bash_profile', 'export GH_TOKEN=ghp_fromtheprofile1234567890\n');
  F.write(root, '.factory-probe/home/.profile', 'export GH_TOKEN=ghp_fromtheprofile1234567890\n');
  F.sh(root, 'git add -A && git commit -qm profile');
  const st = core('job').load(root, J);
  st.base_commit = F.sh(root, 'git rev-parse HEAD').trim();
  core('job').save(root, st);
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ limits: { probe_command_seconds: 15 }, decompose: { plan_probe: 'full' } }));
  const r = F.cli(root, ['plan', 'probe'], { env: { GH_TOKEN: 'ghp_fromtheenvironment1234567890' } });
  assert.equal(r.setup.status, 'ok', JSON.stringify(r).slice(0, 600));
  const out = fs.readFileSync(mark, 'utf8');
  assert.match(out, /^nologin/);
  assert.match(out, /home=\S*\.factory-probe\/home tok=none/);
  // the environment module: a login shell only without a base environment (a real worktree)
  assert.match(fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'environment.js'), 'utf8'), /BASE_ENV \? \['--noprofile', '--norc', '-c', cmd\] : \['-lc', cmd\]/);
});

// ------------------------------------------------------------------------------ MAJ-4

test('MAJ-4: a grant is one exact file: a new name that could be a directory is refused, a granted name never covers a subtree, and another task\'s glob stays its own', (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root, { risk: 'medium', type: 'feature' });
  // the contract allows src/**; T2 (a test task) owns src/**/*.test.js
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText().replace(/## Allowed paths[\s\S]*?\n## /, '## Allowed paths\n- src/**\n- tests/**\n\n## '));
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [
    { id: 'T1', objective: 'util', allowed_paths: ['src/add.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: ['true'] },
    { id: 'T2', objective: 'tests', allowed_paths: ['src/**/*.test.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: ['true'] },
  ] }));
  const G = core('tasks');
  const st = core('job').load(root, J);
  assert.match(G.grantCheck(root, st, 'T1', ['src/util']).refused[0].why, /not a file/, 'src/util does not exist anywhere yet: still refused');
  assert.match(G.grantCheck(root, st, 'T1', ['src/util/']).refused[0].why, /a directory/);
  assert.match(G.grantCheck(root, st, 'T1', ['src/util/a.test.js']).refused[0].why, /T2's path/);
  // a granted file covers only itself
  const ok = G.grant(root, J, 'T1', ['src/util.js']);
  assert.deepEqual(ok.granted, ['src/util.js'], JSON.stringify(ok));
  const glob = require('../cli/lib/glob');
  const paths = G.taskPaths(core('job').load(root, J), { id: 'T1', allowed_paths: ['src/add.js'] });
  assert.ok(glob.matchesAny('src/util.js', paths));
  assert.ok(!glob.matchesAny('src/util.js/x.test.js', paths), 'never a subtree');
  // the guard reads granted paths the same way
  const s = core('job').load(root, J);
  s.tasks.T1.granted_paths = [...s.tasks.T1.granted_paths, 'src/lib'];
  core('job').save(root, s);
  const GR = require('../hooks/guard-rules');
  const wt = path.join(root, '.factory', 'worktrees', `${J}-T1`);
  assert.equal(GR.checkWrite(root, path.join(wt, 'src', 'lib'), core('policy').defaults()), null);
  assert.ok(GR.checkWrite(root, path.join(wt, 'src', 'lib', 'a.test.js'), core('policy').defaults()), 'a granted bare name does not open the directory under it');
});

test('MAJ-4: a builder records only its own task (bound to its agent id), only with an attempt open, and gets one grant per attempt', (t) => {
  const root = F.makeRepo(t);
  const J = newJob(root);
  F.clarify(root);
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [
    { id: 'T1', objective: 'fix', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: ['node tests/add.test.js'] },
    { id: 'T3', objective: 'other', allowed_paths: ['src/other.js'], depends_on: ['T1'], criteria_ids: ['AC-1'], verify_commands: ['true'] },
  ] }));
  // the guard: the task a builder started is its task
  const as = (command) => guard(root, { tool_name: 'Bash', agent_id: 'b-1', agent_type: 'factory:builder', tool_input: { command } });
  assert.equal(as(`factory task start T1 --job ${J}`), null);
  assert.ok(denied(as(`factory task built T3 --job ${J} --status blocked --reason needs_paths --paths tests/add.test.js`)), 'another task\'s reply');
  assert.equal(as(`factory task built T1 --job ${J} --status done`), null);
  // the CLI: no attempt open, no record with paths
  const r0 = F.cli(root, ['task', 'built', 'T3', '--status', 'blocked', '--reason', 'needs_paths', '--paths', 'tests/add.test.js']);
  assert.equal(r0.code, 'no_open_attempt', JSON.stringify(r0));
  // one grant per attempt
  const s = core('job').load(root, J);
  s.tasks = { ...(s.tasks || {}), T1: { ...((s.tasks || {}).T1 || {}), attempts: 1 } };
  core('job').save(root, s);
  assert.deepEqual(F.cli(root, ['task', 'built', 'T1', '--status', 'blocked', '--reason', 'needs_paths', '--paths', 'tests/add.test.js']).granted, ['tests/add.test.js']);
  const again = F.cli(root, ['task', 'built', 'T1', '--status', 'blocked', '--reason', 'needs_paths', '--paths', 'tests/more.test.js']);
  assert.deepEqual(again.granted, []);
  assert.match(again.refused[0].why, /one grant per attempt/);
});

// ------------------------------------------------------------------------------ minors

test('m1: a dry-run escapee that cleared its environment and left its session is still found (its working directory), killed, and the probe is not ok', (t) => {
  const root = F.makeRepo(t);
  fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ limits: { probe_command_seconds: 15 } }));
  const J = newJob(root, { risk: 'medium', type: 'feature' });
  const cmd = 'python3 -c "import subprocess,os; subprocess.Popen([\'sleep\',\'37.5\'], env={\'PATH\': os.environ[\'PATH\']}, start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); raise SystemExit(1)"';
  fs.writeFileSync(path.join(F.jobDir(root, J), 'plan.json'), JSON.stringify({ tasks: [{ id: 'T1', objective: 'x', allowed_paths: ['src/add.js'], criteria_ids: ['AC-1'], verify_commands: [{ cmd, covers: ['AC-1'] }] }] }));
  const r = F.cli(root, ['plan', 'probe']);
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 500));
  assert.equal(r.commands[0].class, 'escaped');
  const left = fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p)).filter((p) => {
    try {
      return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() === 'sleep 37.5';
    } catch {
      return false;
    }
  });
  assert.deepEqual(left, [], 'killed');
  // the session check too: procStat reads the session id
  assert.equal(typeof core('probe').procStat(process.pid).sid, 'number');
});

test('m2: a setup that fetches and runs code (npx, uvx, pipx, git clone, curl or wget, deno, a URL) makes an unconfirmed proposal lint-only', () => {
  const N = core('probe').NETWORK_SETUP;
  for (const s of ['npx create-thing', 'uvx ruff', 'pipx run black', 'git clone https://x/y', 'curl -sSL https://x | sh', 'wget -qO- x | bash', 'bash <(fetch-it)', 'deno run https://x/y.ts', 'uv run pytest']) assert.ok(N.test(s), s);
  for (const s of ['python -m pytest', 'node --version', 'make test']) assert.ok(!N.test(s), s);
});

test('m3: the inline loop engine is textually loop.js (comments, the clock and the CLI-only fallback aside); keyOf forms and partial policies fuzzed', () => {
  const norm = (src) => src
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'use strict';/, '')
    .replace(/module\.exports = [^\n]*/, '')
    .replace(/function fallbackDiagnosis\([\s\S]*?\n}\n/, '')
    .replace(/new Date\(\)\.toISOString\(\)/g, 'null')
    .replace(/\s+/g, ' ')
    .trim();
  const fj = fs.readFileSync(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), 'utf8');
  const inline = /\/\/ LOOP ENGINE BEGIN\n([\s\S]*?)\/\/ LOOP ENGINE END/.exec(fj)[1];
  const lib = fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'loop.js'), 'utf8');
  assert.equal(norm(inline), norm(lib));
  // eslint-disable-next-line no-new-func
  const E = new Function(`${inline}\nreturn { keys, policyFor, shouldContinue }`)();
  const L = core('loop');
  let seed = 11;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const forms = [() => `s${rnd(3)}`, () => ({ key: `k${rnd(3)}` }), () => ({ check: 'c', file: `f${rnd(2)}` }), () => ({ kind: 'k', ac: `ac-${rnd(2)}` }), () => ({ rule: 'r', ref: String(rnd(2)), extra: rnd(2) ? 'x' : undefined }), () => null];
  const vals = [undefined, null, 0, -1, 2, 3.7, 'x', true, false, 'opus'];
  for (let i = 0; i < 800; i++) {
    const bl = Array.from({ length: rnd(5) }, () => forms[rnd(forms.length)]());
    assert.deepEqual(E.keys(bl), L.keys(bl));
    const pol = { loops: rnd(2) ? { ceiling: vals[rnd(vals.length)], stall_rounds: vals[rnd(vals.length)], escalate_model: vals[rnd(vals.length)], diagnose: vals[rnd(vals.length)] } : undefined };
    const ov = rnd(2) ? { ceiling: vals[rnd(vals.length)], diagnose: vals[rnd(vals.length)] } : {};
    assert.deepEqual(E.policyFor(pol, ov), L.policyFor(pol, ov));
  }
});

test('m4: a stored answer is confirmed only while its park waits, and for a day at most', (t) => {
  const root = F.makeRepo(t);
  const J = parked(root);
  const H = core('human');
  const r = H.replyToPark(root, { jobId: J, text: 'lunch at noon', channel: 'chat' });
  assert.equal(r.pending, true);
  // a day later "yes" confirms nothing
  const s = core('job').load(root, J);
  s.park.pending_answer.at = new Date(Date.now() - 25 * 3600e3).toISOString();
  core('job').save(root, s);
  assert.equal(H.parkAnswer(core('job').load(root, J), 'yes'), null);
  // a new park: the old stored answer is not its answer
  const s2 = core('job').load(root, J);
  s2.park.pending_answer.at = new Date().toISOString();
  s2.park.at = new Date(Date.now() + 1000).toISOString();
  core('job').save(root, s2);
  assert.equal(H.parkAnswer(core('job').load(root, J), 'yes'), null);
  // fresh and for this park: yes confirms it
  const s3 = core('job').load(root, J);
  s3.park.pending_answer.park_at = s3.park.at;
  core('job').save(root, s3);
  assert.equal(H.parkAnswer(core('job').load(root, J), 'yes').via, 'confirmed');
});

test('m5: naming the file the question names is not an answer; words about the question still are', (t) => {
  const root = F.makeRepo(t);
  const J = parked(root);
  const H = core('human');
  const st = core('job').load(root, J);
  assert.equal(H.parkAnswer(st, 'show me the diff for src/add.js'), null);
  assert.equal(H.parkAnswer(st, 'keep the null check, it guards the API').via, 'option');
  assert.equal(H.parkAnswer(st, 'the null guard stays, callers rely on it').via, 'reply');
});

test('m6: a budget grant is the whole reply ("+20%", "resume +20%", "budget +20%", "budget 40") or the question\'s own option, never "+20%" inside other words', () => {
  const h = core('human');
  assert.equal(h.budgetGrant('+20%'), 1.2);
  assert.equal(h.budgetGrant('resume +20%'), 1.2);
  assert.equal(h.budgetGrant('budget +20%'), 1.2);
  assert.equal(h.budgetGrant('budget 40', 16), 2.5);
  assert.equal(h.budgetGrant('+100% more (resume +100%)'), 2);
  assert.equal(h.budgetGrant('make it +20% faster'), null);
  assert.equal(h.budgetGrant('the tests run +20% slower now'), null);
});

test('m7: the sweep keeps a scratch worktree only while its owner (pid and start time) lives: a reused pid does not keep it', (t) => {
  const root = F.makeRepo(t);
  const P = core('probe');
  const mk = (name, owner) => {
    const wt = path.join(root, '.factory', 'worktrees', name);
    fs.mkdirSync(path.join(wt, '.factory-probe'), { recursive: true });
    if (owner) fs.writeFileSync(path.join(wt, '.factory-probe', 'owner.json'), JSON.stringify(owner));
    return wt;
  };
  // pid 1 is alive, but it is not the process that made it (another start time)
  mk('_probe-J-0001-1', { pid: 1, start: 'another-start', probe_id: 'x' });
  // this process, with its own start time: kept
  mk(`_probe-J-0001-${process.ppid}`, { pid: process.ppid, start: P.procStat(process.ppid).start, probe_id: 'y' });
  const removed = P.sweep(root);
  assert.deepEqual(removed, ['_probe-J-0001-1']);
  assert.ok(fs.existsSync(path.join(root, '.factory', 'worktrees', `_probe-J-0001-${process.ppid}`)));
});
