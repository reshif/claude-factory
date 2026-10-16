'use strict';
// Phase 3 (ported from copilot-factory 0.8.0, claude-native): factory drive as the router loop
// that returns only where the main session must run a Workflow or the human is needed (P3.1),
// factory inbox and notifications (P3.2), typed parks and recovery (P3.3), and scheduling by
// dependency with the attempt barrier (P3.4).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');
const { grab } = require('./helpers/clarify3-crew');

const REALIZE = path.join(F.PLUGIN, 'workflows', 'realize.js');
const core = (m) => require(`../cli/core/${m}`);
const stateOf = (root, J) => JSON.parse(fs.readFileSync(path.join(F.jdir(root, J), 'state.json'), 'utf8'));
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
F.jdir = F.jobDir;

const drive = (root, args = [], env = {}) => F.cli(root, ['drive', ...args], { env: { FACTORY_NOTIFY: 'off', ...env } });

function newJob(root, policy) {
  if (policy) fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify(policy));
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  return J;
}

const instructions = (prompt) => {
  const line = prompt.split('\n').find((l) => l.trim().startsWith('/'));
  return line ? fs.readFileSync(line.trim(), 'utf8') : prompt;
};

// The crew of e2e-workflows.test.js: what real agents would do, told apart by agent type.
function crew(root) {
  return (type, full, raw) => {
    if (type === 'factory:interviewer') return { intent: { problem: 'add(2, 3) returns -1', who: 'callers of src/add.js', outcome: 'add returns the sum', success: 'the add test passes' }, scope: { in: ['add'], out: [] }, took: [], pins: [], plan: [{ item: 'new', what: 'Where is add implemented and what does it do today?', tag: 'repo', pins: [], impact: 'high' }], questions: [], design_may_choose: [] };
    if (type === 'factory:researcher' && /CLARIFY INPUT/.test(full)) {
      const inp = grab(full, 'CLARIFY INPUT (JSON):');
      return { mode: 'repo', versions: [], evidence: inp.plan.map((p) => ({ plan: p.id, claim: 'add lives in src/add.js and subtracts', source: 'src/add.js:1', source_tier: 'repo', quote: 'module.exports = (a, b) => a - b;', confidence: 'high' })), unresolved: [] };
    }
    if (type === 'factory:brief-writer') {
      const inp = grab(full, 'CLARIFY INPUT (JSON):');
      const ev = (grab(raw, 'INPUTS (JSON):') || []).flatMap((x) => (x.output && x.output.evidence) || []);
      return { summary: 'add subtracts', records: [], facts: inp.plan.map((p) => ({ plan: p.id, statement: ev[0].claim, evidence: [ev[0].source] })), gaps: [] };
    }
    if (type === 'factory:contract-writer') {
      const inp = grab(full, 'CLARIFY INPUT (JSON):');
      return { contract: F.contractText(), covers: inp.items.map((x) => ({ item: x.id, where: 'Goal' })), uncovered: [] };
    }
    if (type === 'factory:god-eye') return { verdict: 'ready', restatement: { problem: 'add subtracts', outcome: 'add sums' }, checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, self_consistent: true, facts_honoured: true, instructions_handled: true, decisions_closed: true }, objections: [] };
    if (type === 'factory:researcher') return { topic: 'codebase', claims: [{ claim: 'add subtracts', source: 'src/add.js:1' }], unknowns: [] };
    if (type === 'factory:builder') {
      const s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
      F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
      F.sh(s.worktree, 'git commit -qam fix');
      return { status: 'done', summary: 'fixed', swept: ['src/add.js'] };
    }
    if (type === 'factory:tester') return F.relayVerify(root, `test ${/task verify (\S+)/.exec(full)[1]}`);
    if (type === 'factory:integrator' && /reconcile wave/.test(raw)) return F.relayWave(root, raw);
    if (type === 'factory:integrator') {
      const r = F.cli(root, ['reconcile', 'run']);
      return { status: r.status === 'merged' ? 'merged' : 'failed', summary: r.status };
    }
    if (type === 'factory:code-reviewer') return { lane: 'code', findings: [] };
    throw new Error(`unexpected agent ${type}: ${full.slice(0, 120)}`);
  };
}

// The main session's side of a drive hand-off: run the workflow it names with the brief it gives,
// save the result, and hand it back with factory drive --record.
async function runHandoff(root, stop, agents) {
  const { result } = await H.run(path.join(F.PLUGIN, 'workflows', `${stop.workflow}.js`), JSON.stringify(stop.args), (prompt, opts) => agents(opts.agentType, instructions(prompt), prompt));
  const f = path.join(root, '.factory', 'scratch', 'envelope.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(result));
  return drive(root, ['--record', '.factory/scratch/envelope.json']);
}

// ------------------------------------------------------------------------------ P3.1 drive

test('P3.1: factory drive steps a whole bug@low job; the main session runs only the workflows it hands over; it stops typed and notified where the user is needed; it never answers for them', async () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const agents = crew(root);
  const stops = [];
  let s = drive(root);
  for (let guard = 0; guard < 40; guard++) {
    stops.push(s.kind);
    assert.ok(!s.error, JSON.stringify(s));
    if (s.kind === 'workflow') {
      assert.ok(s.args && s.args.workflow === s.workflow, 'the stop carries the brief');
      s = await runHandoff(root, s, agents);
    } else if (s.kind === 'clarify') {
      assert.ok(s.screen, 'a clarify stop carries the screen');
      assert.equal(F.say(root, 'ok').status, 'applied');
      s = drive(root);
    } else if (s.kind === 'gate') {
      assert.ok(s.next && s.next.gate, 'a gate stop carries factory next whole');
      assert.equal(F.say(root, 'approve').status, 'applied');
      s = drive(root);
    } else if (s.kind === 'wait' && /merged/.test(s.reply || '')) {
      assert.ok(s.ship, 'the wait after ship carries the ship result');
      const st = stateOf(root, J);
      F.sh(root, `git checkout -q ${st.base_branch} && git merge -q --no-ff -m "merge ${J}" ${st.branch}`);
      assert.equal(F.say(root, `merged ${F.sh(root, 'git rev-parse --short HEAD').trim()}`).status, 'applied');
      s = drive(root);
    } else if (s.kind === 'yield') {
      s = drive(root);
    } else if (s.kind === 'agent') {
      assert.equal(s.agent_type, 'factory:lesson-writer');
      fs.writeFileSync(path.join(root, '.factory', 'scratch', 'lessons.json'), JSON.stringify({ lessons: [], nothing_to_learn: true }));
      s = drive(root, ['--lessons', '.factory/scratch/lessons.json']);
    } else break;
  }
  assert.equal(s.kind, 'done', JSON.stringify(s).slice(0, 600));
  assert.equal(stateOf(root, J).status, 'closed');
  const ev = events(root);
  const cli = ev.filter((e) => e.event === 'cli');
  // the main session ran no factory next: the drive did (via "drive")
  assert.equal(cli.filter((e) => e.cmd === 'next' && e.via !== 'drive').length, 0);
  assert.ok(cli.filter((e) => e.cmd === 'next' && e.via === 'drive').length >= 8);
  // the drive ran no human-only verb and no relay of the user's words
  const HUMAN = ['approve', 'deny', 'resume', 'proceed', 'cancel', 'abandon', 'waive', 'merged', 'confirm', 'reseal', 'finding', 'answer'];
  assert.deepEqual(cli.filter((e) => e.via === 'drive' && (HUMAN.includes(e.cmd) || (e.cmd === 'clarify' && ['reply', 'redirect', 'note'].includes(e.sub)) || (e.cmd === 'lessons' && ['accept', 'reject'].includes(e.sub)))), []);
  // every human stop is a drive_stop event with a notify attempt (off here); hand-offs notify nobody
  const ds = ev.filter((e) => e.event === 'drive_stop');
  assert.ok(ds.some((e) => e.kind === 'gate' && e.gate === 'H1'));
  // 0.9.0 (intentional): the read-back is shown at H1, not waited on, and a sheet of facts alone is
  // no turn: the user is needed at H1 and for the merge only
  assert.ok(!ds.some((e) => e.kind === 'clarify'), 'no clarify turn for this job');
  assert.deepEqual(ds.filter((e) => !e.handoff && e.kind !== 'yield').map((e) => (e.kind === 'gate' ? `gate ${e.gate}` : e.kind)), ['gate H1', 'wait', 'done']);
  for (const d of ds) assert.equal(d.notified, d.handoff ? 'none' : 'off', JSON.stringify(d));
  assert.ok(ds.filter((e) => e.kind === 'workflow').length >= 5, 'clarify stages, ground, decompose, realize, prove/challenge handed over');
  // drive.json keeps the last stop, without the brief
  const dj = JSON.parse(fs.readFileSync(path.join(root, '.factory', 'drive.json'), 'utf8'));
  assert.equal(dj.status, 'stopped');
  assert.equal(dj.last.kind, 'done');
  assert.ok(!('args' in dj.last) && !('next' in dj.last));
  // the inspector sees a conforming job
  const ins = spawnSync('node', [path.join(F.PLUGIN, '..', 'factory-inspector', 'bin', 'factory-inspect'), 'run', '--job', J], { cwd: root, encoding: 'utf8' });
  assert.equal(ins.status, 0, ins.stderr);
  const findings = require('../../factory-inspector/inspector/main').report(root, { status: 'all', health: false }).findings.filter((x) => x.job === J);
  assert.deepEqual(findings.filter((x) => x.class === 'deviation' || /^R25\./.test(x.rule)).map((x) => `${x.rule}: ${x.summary}`), [], 'no deviation, and every stop reached the user');
});

test('P3.1: while a drive is live, factory next answers "driving" and a second drive is refused; a drive.json left by a dead pid, or by another host long gone, blocks nothing', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const D = core('drive');
  const file = path.join(root, '.factory', 'drive.json');
  // a live drive: this test's own node process stands in for it
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, pid_start: D.procStart(process.pid), host: os.hostname(), job: J, status: 'running', started_at: new Date().toISOString(), heartbeat_at: new Date(Date.now() - 3600e3).toISOString() }));
  const n = F.cli(root, ['next']);
  assert.equal(n.action, 'driving', 'a live drive on this host (pid and start time match) is live however old its last step');
  // the same pid with another start time: reused by another process, so dead (review M2)
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, pid_start: 'proc:1', host: os.hostname(), job: J, status: 'running', started_at: new Date().toISOString(), heartbeat_at: new Date(Date.now() - 3600e3).toISOString() }));
  assert.notEqual(F.cli(root, ['next']).action, 'driving', 'a reused pid holds nothing');
  // no start time recorded (an older record): only a recent step counts
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), job: J, status: 'running', started_at: new Date().toISOString(), heartbeat_at: new Date(Date.now() - 3600e3).toISOString() }));
  assert.notEqual(F.cli(root, ['next']).action, 'driving');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, pid_start: D.procStart(process.pid), host: os.hostname(), job: J, status: 'running', started_at: new Date().toISOString() }));
  assert.equal(drive(root).code, 'drive_in_progress');
  // a dead pid
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, host: os.hostname(), job: J, status: 'running', started_at: new Date().toISOString() }));
  assert.notEqual(F.cli(root, ['next']).action, 'driving');
  assert.equal(F.cli(root, ['drive', 'status']).status, 'crashed');
  // another host: only its last step speaks for it
  assert.equal(D.alive({ pid: 1, host: 'elsewhere', status: 'running', heartbeat_at: new Date().toISOString() }), true);
  assert.equal(D.alive({ pid: 1, host: 'elsewhere', status: 'running', heartbeat_at: new Date(Date.now() - 3600e3).toISOString() }), false);
  // a rerun takes the dead one over and records it
  const s = drive(root);
  assert.equal(s.kind, 'workflow');
  assert.ok(events(root).some((e) => e.event === 'drive_start' && e.recovered_from && e.recovered_from.pid === 999999));
});

test('P3.1: the drive stops at ground\'s questions (never answering them), refuses a router step that is not its to run, and yields under its time budget', async () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.clarify(root);
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  let s = drive(root);
  assert.equal(s.kind, 'workflow');
  assert.equal(s.workflow, 'ground');
  const env = F.envelope(s.args, 'ok', { topics: [{ topic: 'codebase', claims: [], unknowns: [{ question: 'Which rounding?', blocking: true }] }], degraded: [] });
  fs.writeFileSync(path.join(root, '.factory', 'scratch', 'envelope.json'), JSON.stringify(env));
  s = drive(root, ['--record', '.factory/scratch/envelope.json']);
  assert.equal(s.kind, 'questions');
  assert.deepEqual(s.questions, ['Which rounding?']);
  assert.equal(events(root).filter((e) => e.event === 'cli' && e.cmd === 'answer').length, 0, 'the drive never answers');
  // the router's command words are checked: a human-only verb is never run
  assert.deepEqual(core('drive').words(`factory ci verify --job ${J}`), ['ci', 'verify', '--job', J]);
  // a 1-second budget yields after the first step instead of running on
  F.cli(root, ['answer', '--question', 'Which rounding?', '--answer', 'none']);
  const y = drive(root, ['--max-seconds', '1', '--max-steps', '50']);
  assert.ok(['workflow', 'yield'].includes(y.kind), y.kind);
});

test('P3.1: agents may not drive: factory drive and inbox are refused by the guard for factory agents; the guard reads flags with the CLI\'s own boolean list', () => {
  const G = require('../hooks/guard-rules');
  const root = F.makeRepo();
  const pol = core('policy').defaults();
  for (const c of ['factory drive', 'factory inbox', 'factory drive --record x.json']) assert.match(String(G.checkBash(root, c, pol, { agent: true, agentType: 'factory:builder' }) || ''), /main session/, c);
  assert.equal(G.checkBash(root, 'factory drive', pol, {}), null, 'the main session drives');
  assert.equal(G.CLI_BOOL, require('../cli/lib/args').BOOL, 'one list for both parsers');
  assert.equal(G.CLI_BOOL, require('../cli/main').BOOL);
  for (const flag of require('../cli/lib/args').BOOL) assert.match(String(G.checkBash(root, `factory --${flag} approve H1`, pol, {}) || ''), /human-only/, `--${flag} approve`);
});

test('P3.1: policy.drive.stop_before_ship stops the drive before factory ship (kind ship); the evidence heuristic records a doc only for a file the criterion names', () => {
  const D = core('drive');
  const st = D.stopDetail('ship', { job: 'J-0001' }, {});
  assert.match(st.summary, /stop_before_ship/);
  assert.equal(core('policy').defaults().drive.stop_before_ship, false, 'off by default');
  assert.equal(D.HANDOFF.has('ship'), false, 'ship waits for the user: it is notified');
  assert.ok(['workflow', 'agent', 'evidence', 'skill', 'yield'].every((k) => D.HANDOFF.has(k)));
  // evidencePath: a lone CHANGELOG.md is not the README
  const root = F.makeRepo();
  const J = newJob(root);
  assert.equal(D.evidencePath(root, J, 'AC-1', 'doc'), null, 'no plan, no tasks: nothing to pick');
});

// ------------------------------------------------------------------------------ P3.2 inbox, notifications

test('P3.2: notifications: notify-send on Linux, wsl-notify-send or a PowerShell toast on WSL, osascript on macOS, a bell otherwise; text never becomes script; policy.notify turns them off; they never block', async () => {
  const N = core('notify');
  const has = (names) => (n) => n.find((x) => names.includes(x)) || null;
  assert.equal(N.plan('t', 'b', { platform: 'linux', wsl: false, find: has(['notify-send']) }).method, 'notify-send');
  assert.equal(N.plan('t', 'b', { platform: 'linux', wsl: true, find: has(['wsl-notify-send.exe', 'notify-send']) }).method, 'wsl-notify-send');
  const evil = "x’; Start-Process calc; ’ \u001b[31m\r\nsecond line";
  const toast = N.plan('t’', evil, { platform: 'linux', wsl: true, env: { WSLENV: 'PATH/l' }, find: has(['powershell.exe']) });
  assert.equal(toast.method, 'powershell');
  assert.equal(toast.args[toast.args.length - 1], N.TOAST_SCRIPT, 'the script is a constant');
  assert.ok(!/Start-Process|’/.test(toast.args.join(' ')), 'nothing of the text is in the command line');
  assert.equal(toast.env.FACTORY_NOTE_BODY, "x’; Start-Process calc; ’ [31m second line");
  assert.equal(toast.env.WSLENV, 'PATH/l:FACTORY_NOTE_TITLE:FACTORY_NOTE_BODY');
  const osa = N.plan('a "t"', 'b" & do shell script "touch /tmp/x', { platform: 'darwin', find: has(['osascript']) });
  assert.deepEqual(osa.args.slice(6), ['a "t"', 'b" & do shell script "touch /tmp/x'], 'the text is argv, never code');
  assert.deepEqual(N.plan('-t', '--b', { platform: 'linux', wsl: false, find: has(['notify-send']) }).args, ['--app-name=Software Factory', '--', '-t', '--b'], 'no text is read as an option');
  assert.equal(N.plan('t', 'b', { platform: 'linux', wsl: false, find: () => null }).method, 'bell');
  assert.equal(N.isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, () => ''), true);
  assert.equal(N.isWsl({}, () => 'Linux version 5.15.153.1-microsoft-standard-WSL2'), true);
  assert.equal(N.isWsl({}, () => 'Linux version 6.8.0-generic'), false);
  // a real drive stop through a notify-send on PATH, then policy.notify false
  const root = F.makeRepo();
  newJob(root);
  F.clarify(root);
  const bin = require('./helpers/tmp').mkdtemp('factory-bin-');
  const out = path.join(bin, 'shown.txt');
  fs.writeFileSync(path.join(bin, 'notify-send'), `#!/bin/sh\necho "$@" >> "${out}"\n`, { mode: 0o755 });
  if (N.isWsl()) return;
  const s = F.cli(root, ['drive'], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FACTORY_NOTIFY: '', WSL_DISTRO_NAME: '' } });
  assert.equal(s.kind, 'gate');
  assert.equal(s.notified, 'notify-send');
  for (let i = 0; i < 50 && !fs.existsSync(out); i++) await sleep(50);
  assert.match(fs.readFileSync(out, 'utf8'), /Factory J-0001: gate waits for you .*H1/);
  const ds = events(root).filter((e) => e.event === 'drive_stop').pop();
  assert.deepEqual([ds.kind, ds.sent], ['gate', true]);
  // the same gate again: told once only
  const again = F.cli(root, ['drive'], { env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FACTORY_NOTIFY: '', WSL_DISTRO_NAME: '' } });
  assert.equal(again.notified, 'repeat');
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ notify: false }));
  assert.deepEqual(N.notify(root, { title: 't', body: 'b' }), { sent: false, method: 'off' });
});

test('P3.2: factory inbox lists what waits on the human across jobs (a gate, a clarify turn, a park), each with the reply and the terminal command; it changes nothing; the console shows it', () => {
  const root = F.makeRepo();
  const J1 = newJob(root);
  F.clarify(root);
  F.cli(root, ['next']); // H1
  const J2 = newJob(root);
  F.cli(root, ['next']); // clarify read-back runs: no wait yet
  const J3 = newJob(root);
  F.cli(root, ['park', '--reason', 'waiting for the vendor']);
  const before = fs.readFileSync(path.join(F.jobDir(root, J1), 'state.json'), 'utf8');
  const ib = F.cli(root, ['inbox']);
  const by = Object.fromEntries(ib.items.map((x) => [x.job, x]));
  assert.equal(by[J1].kind, 'gate');
  assert.equal(by[J1].gate, 'H1');
  assert.deepEqual(by[J1].reply, ['approve', 'deny <what must change>']);
  assert.match(by[J1].command, new RegExp(`factory approve H1 --job ${J1}`));
  assert.equal(by[J1].human_only, true);
  assert.equal(by[J3].kind, 'park');
  assert.equal(by[J3].park_kind, 'manual');
  assert.match(by[J3].next, /resume/);
  assert.ok(!by[J2], 'a job at work waits on nobody');
  assert.equal(fs.readFileSync(path.join(F.jobDir(root, J1), 'state.json'), 'utf8'), before, 'read-only');
  assert.ok(events(root).some((e) => e.event === 'inbox_viewed'), 'a look is logged (R25)');
  const md = F.cli(root, ['inbox', '--format', 'md']).raw;
  assert.match(md, /# Factory inbox/);
  assert.match(md, /it asks you to type a code shown on that terminal/);
  assert.ok(!/paste (it|the code) (here|into)/i.test(md.replace(/never paste it into a chat/, '')), 'never asks for the code');
  const c = core('console').build(root);
  assert.equal(c.inbox.count, ib.count);
});

// ------------------------------------------------------------------------------ P3.3 typed recovery

test('P3.3: every park is typed with a suggested next step; factory why shows the park rows with their reasons; a park without a kind (an older job) is typed from its reason', () => {
  const DT = core('decision-table');
  assert.equal(DT.parkKind('Tasks not done: T2 (blocked)', 'realize', { tasks: [{ id: 'T2', outcome: 'blocked', summary: 'Blocked: needs src/index.js' }] }), 'needs_paths');
  assert.equal(DT.parkKind('Tasks not done: T2 (blocked)', 'realize', { tasks: [{ id: 'T2', outcome: 'blocked', summary: 'Blocked (dependency_conflict): x' }] }), 'dependency_conflict');
  assert.equal(DT.parkKind('Tasks not done: T1 (exhausted)', 'realize'), 'task_exhausted');
  assert.equal(DT.parkKind('Reconcile regression: dropped', 'reconcile'), 'regression');
  assert.equal(DT.parkKind('x', 'budget'), 'budget');
  assert.equal(DT.parkKind('x', 'environment'), 'environment_broken');
  assert.match(DT.parkNext('needs_paths', { tasks: [{ id: 'T2', outcome: 'blocked', needs_paths: ['src/index.js'] }] }), /T2 needs src\/index\.js: amend the plan/);
  assert.ok(!('transient' in DT.PARK_NEXT), 'no transient park here: Claude Code retries API errors itself');
  const root = F.makeRepo();
  const J = newJob(root);
  F.cli(root, ['park', '--reason', 'by hand']);
  const n = F.cli(root, ['next']);
  assert.equal(n.action, 'parked');
  assert.deepEqual([n.park.kind, Boolean(n.park.next)], ['manual', true]);
  const w = F.cli(root, ['why']);
  assert.equal(w.parks.length, 1);
  assert.equal(w.parks[0].kind, 'manual');
  assert.equal(w.park.kind, 'manual');
  const md = F.cli(root, ['why', '--format', 'md']).raw;
  assert.match(md, /park \(manual\)/);
  assert.match(md, /→ next: Parked by hand/);
  assert.match(md, /\*\*Parked now\*\* \(manual\)/);
  // an older park (no kind, no row) still gets a kind and a next step from factory next
  const st = stateOf(root, J);
  st.park = { reason: 'Tasks not done: T2 (blocked)', at: st.park.at, from: 'realize' };
  core('job').save(root, st);
  const n2 = F.cli(root, ['next']);
  assert.equal(n2.park.kind, 'needs_paths');
});

test('P3.3: amend submit while parked: gate A pre-empts the park once presented (never before); approving it does what resume does', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.clarify(root);
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  F.cli(root, ['next']);
  // a review-rounds park (0.9.0: a budget park is not lifted by an amendment: the budget is
  // absolute, only "resume +N%" grants more; checked at the end)
  const st = stateOf(root, J);
  core('decision-table').park(root, st, 'Review rounds used up with confirmed serious findings still open.', 'review');
  const limit = stateOf(root, J).policy.limits.max_agent_runs_per_job;
  F.cli(root, ['amend', 'start', '--reason', 'widen the goal', '--by', 'user']);
  const cf = path.join(F.jobDir(root, J), 'contract.md');
  fs.writeFileSync(cf, fs.readFileSync(cf, 'utf8').replace('add(2, 3) returns 5', 'add(2, 3) returns 5 and add(0, 0) returns 0'));
  const sub = F.cli(root, ['amend', 'submit']);
  assert.equal(sub.parked, true);
  assert.match(sub.next, /factory next \(or factory drive\)/);
  // before factory next presents A, approving is refused (no gate presented)
  assert.throws(() => F.reply(root, 'approve'), /no gate waiting|parked/);
  const n = F.cli(root, ['next']);
  assert.equal(n.action, 'gate');
  assert.equal(n.step, 'A');
  assert.equal(n.resumes_park, true);
  const r = F.reply(root, 'approve');
  assert.equal(r.resumed, true);
  const after = stateOf(root, J);
  assert.equal(after.status, 'active');
  assert.equal(after.resumed.via, 'amendment');
  assert.equal(after.policy.limits.max_agent_runs_per_job, limit, 'the budget is absolute: no automatic extra runs');
  assert.ok(core('decisions').forJob(root, J).some((d) => d.action === 'human.resume' && d.via === 'amendment'));
  // a budget park stays parked when an amendment is approved: only "resume +N%" grants more
  core('decision-table').park(root, stateOf(root, J), 'Agent run budget used up', 'budget');
  F.cli(root, ['amend', 'start', '--reason', 'one more change', '--by', 'user']);
  fs.writeFileSync(cf, fs.readFileSync(cf, 'utf8').replace('add(0, 0) returns 0', 'add(0, 0) returns 0 and add(1, 0) returns 1'));
  F.cli(root, ['amend', 'submit']);
  assert.equal(F.cli(root, ['next']).step, 'A');
  const r2 = F.reply(root, 'approve');
  assert.ok(!r2.resumed);
  assert.match(r2.message, /stays parked on its spent budget/);
  assert.throws(() => F.reply(root, 'resume'), /budget is absolute/);
  assert.equal(F.reply(root, 'resume +50%').resumed, true);
  assert.equal(stateOf(root, J).policy.limits.max_agent_runs_per_job, Math.ceil(limit * 1.5));
});

test('P3.3: after a dependency_conflict, the task\'s next start restarts its branch from the integrated job branch, keeping the old head on a ref; a task starts from the last green integration', () => {
  const T = core('tasks');
  const t = { start_error: { code: 'dependency_conflict', message: 'x', at: '2026-01-01T00:00:00Z' } };
  assert.equal(T.startBase.length, 3);
  const root = F.makeRepo();
  const J = newJob(root);
  F.clarify(root);
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  const st = stateOf(root, J);
  const job = core('job');
  // no green record: the job branch
  assert.equal(T.startBase(root, st, 'T1'), st.branch);
  // a green integration that is in the job branch: that commit
  const head = F.sh(root, `git rev-parse ${st.branch}`).trim();
  st.integration_green = head;
  job.save(root, st);
  assert.equal(T.startBase(root, stateOf(root, J), 'T1'), head);
  // a task reopened to repair an integration starts from the job branch itself
  const s2 = stateOf(root, J);
  s2.tasks.T1 = { needs_work: 'integration' };
  job.save(root, s2);
  assert.equal(T.startBase(root, stateOf(root, J), 'T1'), st.branch);
  assert.ok(t.start_error, 'restartReason restarts a branch whose last start hit dependency_conflict (tasks.js)');
});

// ------------------------------------------------------------------------------ P3.4 DAG scheduling

function dagBrief(tasks, { cap = 4, integrate = true, waves } = {}) {
  const t = {};
  for (const [id, o] of Object.entries(tasks)) {
    t[id] = { id, depends_on: o.depends_on || [], retry_limit: o.retry_limit || 3, builder: { agent_type: 'factory:builder', escalate: [] }, tester: { agent_type: 'factory:tester' }, builder_prompt: `build ${id} attempt {{attempt}}\n{{failures}}`, tester_prompt: `test ${id} {{swept}}` };
  }
  return {
    workflow: 'realize', job: 'J-0001', scope: 'all', input_hash: 'h', tasks: t, max_parallel_tasks: cap, builder_schema: {}, tester_schema: {},
    waves: waves || [Object.keys(tasks).filter((id) => !(tasks[id].depends_on || []).length), Object.keys(tasks).filter((id) => (tasks[id].depends_on || []).length)].filter((w) => w.length),
    ...(integrate ? { integrate_each_wave: true, integrator: { agent_type: 'factory:integrator' }, integrate_prompt: 'reconcile wave --tasks {{tasks}} --wave {{wave}}' } : {}),
  };
}

// A scripted timeline: each agent call takes `ms` and the log records start and end, in order.
function timeline(spec) {
  const log = [];
  let active = 0;
  let peak = 0;
  const impl = async (prompt, opts) => {
    const label = opts.label;
    const m = /^(build|test) (T\d+)/.exec(label);
    const ig = /^integrate ([\w,]+)/.exec(label);
    const key = m ? `${m[1]} ${m[2]}` : ig ? 'integrate' : label;
    if (m && m[1] === 'build') peak = Math.max(peak, ++active);
    log.push(`start ${label}`);
    const r = await spec(key, { label, prompt, ids: ig ? ig[1].split(',') : null });
    await sleep(r && r.ms !== undefined ? r.ms : 5);
    log.push(`end ${label}`);
    if (m && m[1] === 'build') active -= 1;
    return r ? r.out : null;
  };
  return { impl, log, peak: () => peak };
}

test('P3.4: tasks are scheduled by dependency: a task starts as soon as its own dependency is integrated, not after the slowest task of its wave; attempts stay within max_parallel_tasks', async () => {
  // T1 fast, T2 slow (same wave), T3 depends on T1 only
  const tl = timeline((key, x) => {
    if (key === 'build T1') return { ms: 5, out: { status: 'done', summary: 'ok', swept: [] } };
    if (key === 'build T2') return { ms: 120, out: { status: 'done', summary: 'ok', swept: [] } };
    if (key === 'build T3') return { ms: 5, out: { status: 'done', summary: 'ok', swept: [] } };
    if (key.startsWith('test')) return { ms: 2, out: { pass: true, failures: [] } };
    if (key === 'integrate') return { ms: 5, out: { ok: true, kind: 'integrated', route: [] } };
    throw new Error(key);
  });
  const { result } = await H.run(REALIZE, dagBrief({ T1: {}, T2: {}, T3: { depends_on: ['T1'] } }, { cap: 2 }), tl.impl);
  assert.deepEqual(result.data.tasks.map((t) => t.outcome), ['done', 'done', 'done']);
  const i = (s) => tl.log.indexOf(s);
  assert.ok(i('start build T3 #1') < i('end build T2 #1'), `T3 started while T2 was still building:\n${tl.log.join('\n')}`);
  assert.ok(i('start build T3 #1') > tl.log.findIndex((l) => /^end integrate T1/.test(l)), 'after T1 was integrated');
  assert.ok(tl.peak() <= 2, 'within max_parallel_tasks');
  assert.ok(result.data.integrations.length >= 2 && result.data.integrations.every((g) => g.ok));
});

test('P3.4 barrier: no attempt starts or retries while an integration runs or a failed one is repaired (except the repair); a broken integration stops what would build on it', async () => {
  // A fast, B slow, C retries; A's first integration fails (its checks) and A is rebuilt
  let integrations = 0;
  const builds = {};
  let integrating = false;
  let repairing = false;
  const during = [];
  const tl = timeline((key, x) => {
    const m = /^build (T\d+)/.exec(key);
    if (m) {
      builds[m[1]] = (builds[m[1]] || 0) + 1;
      if (integrating || (repairing && m[1] !== 'T1')) during.push(`${x.label}${integrating ? ' during an integration' : ' during a repair'}`);
      if (m[1] === 'T1' && builds.T1 === 2) repairing = false;
      return { ms: m[1] === 'T2' ? 80 : 10, out: { status: 'done', summary: 'ok', swept: [] } };
    }
    if (key === 'test T3') return { ms: 2, out: builds.T3 >= 2 ? { pass: true, failures: [] } : { pass: false, failures: ['`node t3` exited 1'] } };
    if (key.startsWith('test')) return { ms: 2, out: { pass: true, failures: [] } };
    if (key === 'integrate') {
      integrations += 1;
      integrating = true;
      const ok = !(integrations === 1 && x.ids.includes('T1'));
      return { ms: 25, out: ok ? { ok: true, kind: 'integrated', route: [] } : { ok: false, kind: 'commands', route: ['T1'], failures: ['`npm test` exited 1'] } };
    }
    throw new Error(key);
  });
  const wrapped = async (prompt, opts) => {
    const r = await tl.impl(prompt, opts);
    if (/^integrate /.test(opts.label)) {
      integrating = false;
      if (r && !r.ok) repairing = true;
    }
    return r;
  };
  const { result } = await H.run(REALIZE, dagBrief({ T1: {}, T2: {}, T3: {} }, { cap: 2, waves: [['T1', 'T2', 'T3']] }), wrapped);
  assert.deepEqual(during, [], `attempts started across the barrier:\n${tl.log.join('\n')}`);
  assert.equal(builds.T1, 2, 'T1 was rebuilt for its integration');
  assert.deepEqual(result.data.tasks.map((t) => t.outcome), ['done', 'done', 'done']);
  assert.ok(tl.peak() <= 2);

  // a broken integration nobody can fix: what depends on it never starts
  const tl2 = timeline((key) => {
    if (key.startsWith('build')) return { ms: 5, out: { status: 'done', summary: 'ok', swept: [] } };
    if (key.startsWith('test')) return { ms: 2, out: { pass: true, failures: [] } };
    if (key === 'integrate') return { ms: 5, out: { ok: false, kind: 'commands', route: ['T1'], failures: ['`npm test` exited 1'] } };
    throw new Error(key);
  });
  const r2 = (await H.run(REALIZE, dagBrief({ T1: { retry_limit: 1 }, T2: { depends_on: ['T1'] } }), tl2.impl)).result;
  assert.equal(r2.status, 'park');
  assert.equal(r2.data.tasks.find((t) => t.id === 'T2').outcome, 'skipped_dependency');
  assert.ok(!tl2.log.some((l) => /build T2/.test(l)), 'T2 never built on the broken integration');
});

test('P3.4/P4.2: builder escalation counts the global attempt (attempt_base): attempt 3 steps up across realize runs', async () => {
  const brief = dagBrief({ T1: {} }, { integrate: false });
  brief.tasks.T1.builder = { agent_type: 'factory:builder', model: 'sonnet', escalate: ['opus'], escalate_from: 3 };
  brief.tasks.T1.attempt_base = 2;
  const { calls } = await H.run(REALIZE, brief, (p, o) => (o.agentType === 'factory:builder' ? { status: 'done', summary: 'ok', swept: [] } : { pass: true, failures: [] }));
  assert.equal(calls[0].opts.label, 'build T1 #3');
  assert.equal(calls[0].opts.model, 'opus');
});

test('upgrade: a 0.16 job parked mid-build (a park with no kind, no park rows, no drive.json) continues under factory drive', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  F.clarify(root);
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  const st = stateOf(root, J);
  st.status = 'parked';
  st.park = { reason: 'Tasks not done: T1 (exhausted)', at: new Date().toISOString(), from: 'realize' };
  st.pending_gate = { id: 'P', hash: null, docs: [], at: new Date().toISOString() };
  core('job').save(root, st);
  assert.ok(!fs.existsSync(path.join(root, '.factory', 'drive.json')));
  const s = drive(root);
  assert.equal(s.kind, 'parked');
  assert.equal(s.park.kind, 'task_exhausted');
  assert.match(s.park.next, /resume/);
  // the human resumes from their terminal (the test seam stands in for it); the drive goes on
  core('human').applyResume(root, st, {});
  core('job').save(root, st);
  const s2 = drive(root);
  assert.equal(s2.kind, 'workflow');
});
