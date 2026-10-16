'use strict';
// claude-factory specifics of the copilot-factory 0.11.0 port (design depth, machine-aware build
// environments): what differs because the CLI runs the steps, the Workflow tool runs the agents
// and factory drive hands workflows back. The behaviour shared with copilot-factory is tested in
// design-depth.test.js, v011-env.test.js and rel011-review.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');

const core = (m) => require(`../cli/core/${m}`);

test('agents never scan the machine or check the sealed environment for a job: the guard refuses doctor --machine and env check --job, the CLI refuses env check --job while an agent works; env check --proposed stays an agent\'s', (t) => {
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  const G = require('../hooks/guard-rules');
  const pol = core('policy').defaults();
  const agent = { agent: true, agentType: 'factory:planner' };
  assert.match(String(G.checkBash(root, 'factory doctor --machine', pol, agent)), /main session's step/);
  assert.match(String(G.checkBash(root, `factory env check --job ${J}`, pol, agent)), /may only check a proposal/);
  assert.match(String(G.checkBash(root, `factory env check --job=${J}`, pol, agent)), /may only check a proposal/);
  assert.equal(G.checkBash(root, 'factory env check --proposed', pol, agent), null, 'a proposal is checked sandboxed: an agent may');
  assert.equal(G.checkBash(root, 'factory doctor', pol, agent), null);
  for (const cmd of ['factory doctor --machine', `factory env check --job ${J}`]) assert.equal(G.checkBash(root, cmd, pol, {}), null, `the main session may: ${cmd}`);
  // "approve environment" is a human-only reply: an agent's CLI call and a scheduled text are refused
  assert.match(String(G.checkBash(root, `factory approve environment --job ${J}`, pol, agent) || ''), /human-only|human/i);
  assert.ok(core('reply-origin').refuseScheduled(root, 'approve environment 0123abcd'));
  assert.equal(core('human').readReply('approve environment 0123abcd').forms[0], 'exact');
  // the CLI's layer below the guard
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), event: 'SubagentStart', agent_id: 'a1', agent_type: 'factory:planner' })}\n`);
  assert.equal(F.cli(root, ['env', 'check', '--job', J]).code, 'agent_at_work');
});

test('the environment repair runs as the fanout-judge workflow: the planner (its env-repair schema declared in its agent file), a per-call model once a round makes no progress, the run-steps row the console folds it by; env check is a long drive step', () => {
  const W = core('wfargs');
  assert.ok(W.ROLE_OUTPUTS.planner.includes('env-repair'));
  const body = fs.readFileSync(path.join(F.PLUGIN, 'agents', 'planner.md'), 'utf8');
  assert.match(body, /environment repair/i);
  const wf = fs.readFileSync(path.join(F.PLUGIN, 'workflows', 'fanout-judge.js'), 'utf8');
  assert.match(wf, /brief\.config === 'env_repair'[\s\S]*phase\('env_repair: planner'\)/);
  const RS = require('../cli/core/run-steps');
  const row = RS.TEMPLATES['fanout-judge:env_repair'];
  assert.ok(row && row.steps[0].match.test('env_repair: planner'), 'the console folds the repair run');
  const D = core('drive');
  const d = D.longStepDecision({ label: 'env check --job J-0001', verb: 'env', killedIn: null, durations: {}, elapsedSec: 10000, job: 'J-0001' });
  assert.equal(d && d.kind, 'yield', 'the check runs only in a fresh drive call');
});

test('the inbox shows a repaired environment waiting for the seal with its exact reply; the drive\'s gate stop names the design view', (t) => {
  const root = F.makeRepo(t);
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  core('job').mutate(root, J, (s) => {
    s.status = 'parked';
    s.park = { kind: 'environment_repair', from: 'environment', reason: 'a repaired environment waits', question: 'Seal the repaired build environment 0123abcd?', options: [{ key: 'a', text: 'Seal' }, { key: 'b', text: 'again' }, { key: 'c', text: 'fixed' }], at: new Date().toISOString() };
    s.env_repair = { short: '0123abcd', from: 'x', hash: 'y', env: { version: 1, name: 'n', setup: ['true'] }, diff: '+ setup: true' };
  });
  const it = core('inbox').list(root, { plain: true }).items.find((x) => x.job === J);
  assert.equal(it.park_kind, 'environment_repair');
  assert.deepEqual(it.reply[0], 'approve environment 0123abcd');
  assert.equal(it.command, null, 'no terminal command seals it');
  const src = fs.readFileSync(path.join(F.PLUGIN, 'cli', 'core', 'drive.js'), 'utf8');
  assert.match(src, /Design: \$\{n\.review\.design\.summary\}[\s\S]*factory doc design/);
});
