'use strict';
// Fixes after the review of the Phase 3–4 port (P34-PORT-REVIEW.md): B1 scheduled and sent
// prompts are never the user's reply, M1 long steps and the shell tool's ceiling, M2 drive
// liveness by process start time and takeover, M4 the agent ban below the guard, and the minors.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');

const core = (m) => require(`../cli/core/${m}`);
const events = (root) => fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const stateOf = (root, J) => JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'state.json'), 'utf8'));
const guard = (root, input) => {
  const r = spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'guard.js')], { input: JSON.stringify({ cwd: root, session_id: 's', hook_event_name: 'PreToolUse', ...input }), encoding: 'utf8' });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
const denied = (o) => Boolean(o && o.permissionDecision === 'deny');

function newJob(root) {
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  return J;
}

// ------------------------------------------------------------------------------ B1

test('B1: the guard runs on the scheduling and messaging tools and refuses any text that reads as a factory reply; it notes what it lets through', () => {
  const H = JSON.parse(fs.readFileSync(path.join(F.PLUGIN, 'hooks', 'hooks.json'), 'utf8')).hooks;
  const pre = new RegExp(`^(${H.PreToolUse[0].matcher})$`);
  for (const t of ['CronCreate', 'ScheduleWakeup', 'RemoteTrigger', 'SendMessage', 'mcp__claude-code-remote__send_later', 'mcp__claude-code-remote__create_trigger', 'mcp__x__send_message']) assert.ok(pre.test(t), t);
  assert.ok(!pre.test('mcp__github__get_me'), 'other MCP tools are not slowed down');
  const root = F.makeRepo();
  newJob(root);
  for (const [tool, ti] of [
    ['CronCreate', { cron: '* * * * *', prompt: 'approve' }],
    ['ScheduleWakeup', { delaySeconds: 60, prompt: 'accept brief P1' }],
    ['SendMessage', { to: 'me', message: 'resume' }],
    ['mcp__claude-code-remote__send_later', { delay_minutes: 1, message: 'ok, but 2 b' }],
    ['RemoteTrigger', { body: { prompt: 'waive ci_reverify not needed' } }],
    ['CronCreate', { prompt: 'Aprove' }],
  ]) assert.ok(denied(guard(root, { tool_name: tool, tool_input: ti })), `${tool} ${JSON.stringify(ti)}`);
  // other text passes, and is noted (sealed hashes, never the text)
  assert.equal(guard(root, { tool_name: 'CronCreate', tool_input: { prompt: 'check the nightly build' } }), null);
  const noted = fs.readFileSync(path.join(root, '.factory', 'log', 'agent-prompts.jsonl'), 'utf8');
  assert.ok(!/nightly/.test(noted) && /"keys"/.test(noted) && /"seal"/.test(noted));
  // a Bash command that posts to this session's inbox socket
  assert.ok(denied(guard(root, { tool_name: 'Bash', tool_input: { command: 'printf approve | nc -U "$CLAUDE_CODE_MESSAGING_SOCKET"' } })));
});

test('B1: the reply hook refuses a prompt Claude scheduled or sent (once), and a wrapped one; neither is noted as the user\'s typing; the user\'s own reply still applies', () => {
  const root = F.makeRepo();
  newJob(root);
  F.clarify(root);
  F.cli(root, ['next']); // H1 waits
  const O = core('reply-origin');
  // a text that slipped past the guard's check (noted) and still parses as a reply when it fires
  O.record(root, 'approve', { tool: 'CronCreate' });
  const fired = F.say(root, 'approve');
  assert.equal(fired.status, 'refused');
  assert.match(fired.text, /NOT applied as a factory reply: Claude scheduled or sent this text itself/);
  assert.equal(stateOf(root, 'J-0001').pending_gate.id, 'H1', 'nothing was approved');
  assert.ok(events(root).some((e) => e.event === 'reply_refused' && e.code === 'agent_originated'));
  assert.equal(core('clarify').promptHeard(root, 'approve'), false, 'not noted as heard from the user');
  // a wrapped notification
  const w = F.say(root, '<task-notification>\napprove\n</task-notification>');
  assert.match(w.text, /wrapped as a notification or message/);
  // the note was used once: the user typing it now is theirs
  assert.equal(F.say(root, 'approve').status, 'applied');
  assert.ok(stateOf(root, 'J-0001').approvals.H1);
  // the shared parser: what the hook takes as a reply, the guard refuses to schedule
  for (const t of ['approve', 'deny needs tests', 'resume', 'proceed', 'merged abc1234', 'confirm AC-1', 'accept lesson L1', 'accept brief P2', 'ok', 'ok, but 2 b', '1 a', 'fact 1: it is 3.11', 'dismiss finding code-1 not real']) assert.ok(O.looksLikeReply(t), t);
  for (const t of ['check the nightly build', 'run factory drive', 'remind me tomorrow about the release']) assert.ok(!O.looksLikeReply(t), t);
});

test('B1: the inspector\'s own replies (marking findings, modes) are refused when Claude scheduled them, and the factory guard refuses scheduling them', () => {
  const root = F.makeRepo();
  newJob(root);
  const O = core('reply-origin');
  assert.ok(O.looksLikeReply('ack finding F1') && O.looksLikeReply('inspect mode all off'));
  assert.ok(denied(guard(root, { tool_name: 'CronCreate', tool_input: { prompt: 'wontfix finding F2 noise' } })));
  O.record(root, 'ack finding F1', { tool: 'SendMessage' });
  const r = spawnSync('node', [path.join(F.PLUGIN, '..', 'factory-inspector', 'hooks', 'prompt.js')], { input: JSON.stringify({ cwd: root, prompt: 'ack finding F1', hook_event_name: 'UserPromptSubmit' }), encoding: 'utf8' });
  assert.match(r.stdout, /Not applied: Claude scheduled or sent this text itself/);
});

// ------------------------------------------------------------------------------ M1

test('M1: a long step starts only in a fresh drive (yield first); a step the drive was cut off in twice, or that took nearly the ceiling, is handed to the user\'s terminal as step_too_long', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const D = core('drive');
  const file = path.join(root, '.factory', 'drive.json');
  const st = (extra) => fs.writeFileSync(file, JSON.stringify({ pid: 999999, host: os.hostname(), job: J, status: 'stopped', ...extra }));
  // drive.stop shapes
  assert.match(D.stopDetail('step_too_long', { job: J }, { step: 'verify run', command: `factory verify run --job ${J}`, why: 'was stopped 2 times while running' }).summary, /Run it in your own terminal \(`factory verify run --job J-0001`; it is not human-only/);
  assert.match(D.stopDetail('yield', { job: J }, { seconds: 40, before: 'verify run' }).summary, /verify run may run long, so it starts in a fresh drive/);
  // a drive killed during a long step twice: the record carries killed_in, counted per step
  st({ status: 'running', step: 'ci verify', step_long: true, killed_in: { step: 'ci verify', count: 1 } });
  F.cli(root, ['drive', 'status']);
  // acquire counts the second kill (dead pid, running record, long step)
  const s = F.cli(root, ['drive'], { env: { FACTORY_NOTIFY: 'off' } });
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(s.kind, JSON.stringify(s));
  assert.equal(events(root).find((e) => e.event === 'drive_start').recovered_from.step, 'ci verify');
  // this job routes to clarify, not ci verify, so the kill count waits for that step
  assert.deepEqual(after.killed_in, { step: 'ci verify', count: 2 });
  assert.equal(typeof after.durations, 'object');
  // the decision before each step
  const L = (o) => D.longStepDecision({ label: 'verify run', verb: 'verify', job: J, elapsedSec: 0, ceiling: 600000, ...o });
  assert.equal(L({}), null, 'a fresh drive runs it');
  assert.equal(L({ elapsedSec: 45 }).kind, 'yield', 'a drive 45 s in starts it in a fresh one');
  assert.equal(L({ killedIn: { step: 'verify run', count: 1 } }), null, 'one cut-off may be a late start');
  assert.equal(L({ killedIn: { step: 'verify run', count: 2 } }).kind, 'step_too_long');
  assert.equal(L({ durations: { 'verify run': 560000 } }).kind, 'step_too_long', 'it took 93% of the ceiling last time');
  assert.equal(L({ verb: 'plan', label: 'plan from-contract', elapsedSec: 300 }), null, 'a short step is not held');
});

// ------------------------------------------------------------------------------ M2

test('M2: liveness by process start time; factory drive takeover is human-only and releases a record without signalling', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  const D = core('drive');
  assert.match(String(D.procStart(process.pid)), /^(proc|ps):/);
  assert.equal(D.alive({ pid: process.pid, pid_start: D.procStart(process.pid), host: os.hostname(), status: 'running' }), true);
  assert.equal(D.alive({ pid: process.pid, pid_start: 'proc:1', host: os.hostname(), status: 'running', heartbeat_at: new Date().toISOString() }), false, 'a reused pid');
  assert.equal(D.alive({ pid: process.pid, host: os.hostname(), status: 'running', heartbeat_at: new Date().toISOString() }), true, 'no start time recorded: a recent step counts');
  assert.equal(D.alive({ pid: process.pid, host: os.hostname(), status: 'running', heartbeat_at: new Date(Date.now() - 3 * 3600e3).toISOString() }), false);
  const file = path.join(root, '.factory', 'drive.json');
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, pid_start: D.procStart(process.pid), host: os.hostname(), job: J, status: 'running', started_at: new Date().toISOString() }));
  assert.match(F.cli(root, ['drive']).message, /factory drive takeover/);
  const G = require('../hooks/guard-rules');
  assert.match(String(G.checkBash(root, 'factory drive takeover', core('policy').defaults(), {}) || ''), /human-only/);
  assert.equal(F.cli(root, ['drive', 'takeover']).code, 'human_only', 'not from a non-terminal');
  // the human, from their terminal (the test seam stands in for it)
  const r = D.takeover(root, { channel: 'chat' });
  assert.equal(r.released, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'stopped');
  assert.ok(events(root).some((e) => e.event === 'drive_takeover'));
});

// ------------------------------------------------------------------------------ M4

test('M4: the agent ban holds for verbs fed on stdin or computed, and below the guard the CLI refuses the main session\'s verbs while a factory agent is at work', () => {
  const G = require('../hooks/guard-rules');
  const root = F.makeRepo();
  newJob(root);
  const pol = core('policy').defaults();
  const agent = { agent: true, agentType: 'factory:builder' };
  for (const c of ['echo drive | xargs factory', 'xargs factory < f.txt', 'parallel factory ::: drive', 'factory "$(echo drive)"', 'factory $(printf drive)', 'factory `echo inbox`', 'echo "clarify reply ok" | xargs factory', 'factory "$(echo clarify)" reply ok']) assert.ok(G.checkBash(root, c, pol, agent), c);
  assert.equal(G.checkBash(root, 'echo T1 | xargs factory task show', pol, agent), null, 'a visible, allowed verb');
  assert.equal(G.checkBash(root, 'factory drive', pol, {}), null, 'the main session');
  // the CLI layer: an open factory agent in the log
  const hook = (s, input) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', s)], { input: JSON.stringify({ cwd: root, session_id: 't', ...input }), encoding: 'utf8' });
  hook('activity.js', { hook_event_name: 'SubagentStart', agent_id: 'b1', agent_type: 'factory:builder' });
  for (const args of [['drive'], ['inbox'], ['answer', '--question', 'q', '--answer', 'a'], ['clarify', 'reply', 'ok']]) assert.equal(F.cli(root, args).code, 'agent_at_work', args.join(' '));
  assert.equal(F.cli(root, ['drive', 'status']).code, undefined, 'a look is fine');
  hook('subagent-stop.js', { hook_event_name: 'SubagentStop', agent_id: 'b1', agent_type: 'factory:builder' });
  assert.notEqual(F.cli(root, ['drive'], { env: { FACTORY_NOTIFY: 'off' } }).code, 'agent_at_work');
  // a user's own subagent (Explore) does not block the factory
  hook('activity.js', { hook_event_name: 'SubagentStart', agent_id: 'e1', agent_type: 'Explore' });
  assert.notEqual(F.cli(root, ['inbox']).code, 'agent_at_work');
});

// ------------------------------------------------------------------------------ minors

test('minors: a --agent main session is no agent; the drive takes the guard\'s human-only list; gate A before presentation is not offered; a rerun parked stop is the same park; quiet superseded stops', () => {
  const root = F.makeRepo();
  const J = newJob(root);
  // 1: agent_type without agent_id is a main session started with --agent
  assert.equal(guard(root, { tool_name: 'Bash', agent_type: 'my-agent', tool_input: { command: 'factory inbox' } }), null);
  assert.ok(denied(guard(root, { tool_name: 'Bash', agent_id: 'a1', agent_type: 'factory:builder', tool_input: { command: 'factory inbox' } })));
  // 2: env set and ci install are human-only for the drive too
  const G = require('../hooks/guard-rules');
  assert.ok(G.isHumanOnly('env', 'set') && G.isHumanOnly('ci', 'install') && G.isHumanOnly('drive', 'takeover'));
  // 5: an amendment submitted on an active job, not yet presented, waits for the drive
  F.clarify(root);
  F.cli(root, ['next']);
  F.reply(root, 'approve');
  F.cli(root, ['next']);
  F.cli(root, ['amend', 'start', '--reason', 'more', '--by', 'user']);
  const cf = path.join(F.jobDir(root, J), 'contract.md');
  fs.writeFileSync(cf, fs.readFileSync(cf, 'utf8').replace('add(2, 3) returns 5', 'add(2, 3) returns 5 and add(0, 0) returns 0'));
  F.cli(root, ['amend', 'submit']);
  let it = F.cli(root, ['inbox']).items.find((x) => x.job === J);
  assert.equal(it.kind, 'amend');
  F.cli(root, ['next']);
  it = F.cli(root, ['inbox']).items.find((x) => x.job === J);
  assert.deepEqual([it.kind, it.gate], ['gate', 'A']);
  // 7: a parked job driven again: one park in distill's trouble
  const root2 = F.makeRepo();
  const J2 = newJob(root2);
  F.cli(root2, ['park', '--reason', 'wait']);
  const ev = core('events');
  // the drive run again ten and twenty minutes later stops "parked" again: the same park
  ev.append(root2, { event: 'drive_stop', job: J2, kind: 'parked', summary: 'parked', ts: new Date(Date.now() + 600e3).toISOString() });
  ev.append(root2, { event: 'drive_stop', job: J2, kind: 'parked', summary: 'parked', ts: new Date(Date.now() + 1200e3).toISOString() });
  assert.equal(core('lifecycle').troubleOf(root2, stateOf(root2, J2)).parks.length, 1);
  // 12: a drive that lost the lock stops quietly
  const D = core('drive');
  assert.ok(D.HANDOFF.has('workflow') && !D.HANDOFF.has('superseded'));
});

test('minors: transcript links are per agent only when the run had one agent of that role; /transcript serves only factory agents\' transcripts; the doctor warns about a full model id', async () => {
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cfg-'));
  const root = F.makeRepo();
  newJob(root);
  const mk = (n) => {
    const f = path.join(cfg, 'projects', 'p', 's', 'subagents', `${n}.jsonl`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${JSON.stringify({ type: 'assistant', message: { id: n, model: 'm', content: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n`);
    return f;
  };
  const hook = (s, input) => spawnSync('node', [path.join(F.PLUGIN, 'hooks', s)], { input: JSON.stringify({ cwd: root, session_id: 't', ...input }), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
  // two builders in one run: the hooks name them by id, the roster by label, so no row claims one
  F.cli(root, ['next']);
  const did = stateOf(root, 'J-0001').last_decision_id;
  for (const id of ['b1', 'b2']) {
    hook('activity.js', { hook_event_name: 'SubagentStart', agent_id: id, agent_type: 'factory:builder' });
    hook('subagent-stop.js', { hook_event_name: 'SubagentStop', agent_id: id, agent_type: 'factory:builder', agent_transcript_path: mk(`agent-${id}`) });
  }
  core('ledger').append(root, 'J-0001', { kind: 'agents', workflow: 'realize', decision_id: did, agents: [{ label: 'build T1 #1', agent_type: 'factory:builder', outcome: 'done' }, { label: 'build T2 #1', agent_type: 'factory:builder', outcome: 'done' }] });
  const rows = core('console').build(root).jobs[0].timeline.filter((x) => x.type === 'agents').flatMap((x) => x.agents);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.equal(r.transcript, undefined, 'no row claims one builder\'s transcript');
    assert.equal(r.role_transcripts.length, 2);
  }
  const explore = mk('agent-x');
  hook('subagent-stop.js', { hook_event_name: 'SubagentStop', agent_id: 'x', agent_type: 'Explore', agent_transcript_path: explore });
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfg;
  try {
    const { server, close } = await new Promise((resolve) => {
      const h = core('console').serve(root, { port: 0, onReady: (x) => resolve({ ...x, server: h.server }) });
    });
    const port = server.address().port;
    const code = await new Promise((resolve) => require('http').get({ host: '127.0.0.1', port, path: `/transcript?path=${encodeURIComponent(explore)}`, headers: { host: `127.0.0.1:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.equal(code, 404, 'a user\'s own Explore agent is not served');
    close();
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
  fs.writeFileSync(path.join(root, '.factory', 'policy.json'), JSON.stringify({ agents: { models: { builder: 'claude-opus-5-5' } } }));
  assert.match(JSON.stringify(F.cli(root, ['doctor'])), /claude-opus-5-5 is not a Claude Code alias/);
});

test('ci install vendors every directory the CLI reads at run time: the vendored CLI runs with no access to the plugin; doctor flags a stale or incomplete copy', () => {
  const root = F.makeRepo();
  newJob(root);
  const S = core('ship');
  const r = S.ciInstall(root);
  assert.equal(r.ok, true);
  const dest = path.join(root, '.github', 'factory-cli');
  for (const d of ['bin', 'cli', 'schemas', 'templates', 'config', 'agents', 'policy', 'recipes']) assert.ok(fs.existsSync(path.join(dest, d)), d);
  // run a copy far from the plugin, so nothing can resolve back into it
  const far = fs.mkdtempSync(path.join(os.tmpdir(), 'vendored-'));
  fs.cpSync(dest, path.join(far, 'factory-cli'), { recursive: true });
  const run = (args) => spawnSync('node', [path.join(far, 'factory-cli', 'bin', 'factory'), '--root', root, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } });
  const g = run(['wfargs', 'ground']); // loads schemas, agents and config
  assert.equal(g.status, 0, g.stdout + g.stderr);
  assert.ok(JSON.parse(g.stdout).probes.length);
  assert.ok(!g.stdout.includes(F.PLUGIN), 'the vendored CLI names only itself');
  const manifests = fs.mkdtempSync(path.join(os.tmpdir(), 'manifests-'));
  const v = run(['ci', 'verify', '--manifest-dir', manifests]);
  assert.ok(!/Cannot find module/.test(v.stdout + v.stderr), v.stdout + v.stderr);
  assert.equal(run(['doc', 'template', 'adr']).status, 0);
  // doctor: current, then incomplete, then another version
  const check = () => F.cli(root, ['doctor']).checks.find((c) => c.name === 'ci cli');
  assert.equal(check().ok, true);
  fs.rmSync(path.join(dest, 'schemas'), { recursive: true });
  assert.match(check().detail, /lacks schemas[\s\S]*Run factory ci install/);
  S.ciInstall(root);
  const stamp = path.join(dest, 'factory-cli.json');
  fs.writeFileSync(stamp, JSON.stringify({ version: '0.0.1' }));
  assert.match(check().detail, /factory 0\.0\.1 \(this plugin is/);
  // and the CLI itself keeps it human-only
  assert.equal(F.cli(root, ['ci', 'install']).code, 'human_only');
});
