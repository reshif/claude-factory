'use strict';
// Tier 4: quality signals in `factory telemetry report` — null-result and degraded rates per
// role from the sealed agent rosters, finding-verifier refute rate per lane, park reasons and
// God Eye's revise rate — computed from records the CLI wrote, and rendered for the review.

const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('./helpers/fixture');
const ledger = require('../cli/core/ledger');
const decisions = require('../cli/core/decisions');
const job = require('../cli/core/job');
const telemetry = require('../cli/core/telemetry');

const agent = (type, outcome, retry = false) => ({ label: `${type}${retry ? ' (retry)' : ''}`, agent_type: `factory:${type}`, model: null, retry, outcome });

test('telemetry: quality signals per role, lane, park reason and God Eye', () => {
  const root = F.makeRepo();
  const created = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']);
  const J = created.job || created.id || (created.state && created.state.id);
  assert.ok(J, JSON.stringify(created));

  ledger.append(root, J, { kind: 'agents', workflow: 'fanout-judge', config: 'clarify', agents: [agent('intent-analyst', 'ok'), agent('intent-analyst', 'no_result'), agent('intent-analyst', 'no_result', true), agent('judge', 'ok'), agent('god-eye', 'revise')] });
  ledger.append(root, J, { kind: 'agents', workflow: 'fanout-judge', config: 'clarify', agents: [agent('god-eye', 'approve')] });
  ledger.append(root, J, { kind: 'agents', workflow: 'fanout-judge', config: 'challenge', agents: [agent('code-reviewer', 'ok'), agent('security-reviewer', 'no_result'), agent('finding-verifier', 'confirmed'), agent('finding-verifier', 'refuted')] });
  ledger.append(root, J, { kind: 'step', step: 'clarify', ok: false, bound: {}, detail: { degraded: ['intent-analyst:constraints'] } });
  ledger.append(root, J, {
    kind: 'step', step: 'challenge', ok: false, bound: {},
    detail: { findings: [
      { id: 'code-1', lane: 'code', severity: 'major', status: 'confirmed' },
      { id: 'code-2', lane: 'code', severity: 'major', status: 'refuted' },
      { id: 'code-3', lane: 'code', severity: 'blocker', status: 'refuted' },
      { id: 'code-4', lane: 'code', severity: 'major', status: 'unverified', verifier: 'unverifiable', evidence: 'could not run the service' },
      { id: 'security-1', lane: 'security', severity: 'minor', status: 'minor' },
    ] },
  });
  decisions.write(root, { job: J, action: 'parked', rule: 'cap.review_rounds', reason: 'Review rounds used up' });
  decisions.write(root, { job: J, action: 'human.resume', from: 'review', rule: 'human' });
  decisions.write(root, { job: J, action: 'parked', rule: null, reason: 'Tasks not done' });
  decisions.write(root, { job: J, action: 'human.resume', from: 'realize', rule: 'human' });

  const r = telemetry.report(root, { sinceDays: 30 });
  const q = r.quality;
  assert.ok(q, 'report has a quality section');
  assert.deepEqual({ runs: q.roles['intent-analyst'].runs, no_result: q.roles['intent-analyst'].no_result, degraded: q.roles['intent-analyst'].degraded }, { runs: 3, no_result: 2, degraded: 1 });
  assert.equal(q.roles['intent-analyst'].null_result_rate, 0.67);
  assert.equal(q.roles['security-reviewer'].null_result_rate, 1);
  assert.equal(q.lanes.code.refute_rate, 0.67);
  assert.equal(q.lanes.code.verified, 3);
  assert.equal(q.lanes.code.sent_to_verifier, 4);
  assert.equal(q.lanes.code.unverifiable, 1);
  assert.equal(q.lanes.code.unverifiable_rate, 0.25);
  assert.equal(q.lanes.security.refute_rate, null, 'minor findings are not verified');
  assert.deepEqual(q.god_eye, { verdicts: 2, approve: 1, revise: 1, revise_rate: 0.5 });
  assert.deepEqual(q.park_reasons, { 'cap.review_rounds': 1, 'park.realize': 1 });
  assert.deepEqual(q.degraded_steps, { clarify: 1 });
  const lane = Object.values(r.by_recipe)[0].lanes.code;
  assert.equal(lane.refute_rate, 0.67);
  assert.equal(lane.unverifiable_rate, 0.25);

  const md = telemetry.toMarkdown(r);
  assert.match(md, /## Quality signals/);
  assert.match(md, /\| code \| 4 \| 4 \| 2 \| 0\.67 \| 1 \| 0\.25 \|/);
  assert.match(md, /\| intent-analyst \| 3 \| 2 \| 0\.67 \| 1 \| 1 \| 0\.33 \|/);
  assert.match(md, /\*\*God Eye\*\*: 2 verdicts, 1 revise \(revise rate 0\.5\)/);
  assert.match(md, /cap\.review_rounds ×1, park\.realize ×1/);
  assert.ok(job.load(root, J));
});

test('telemetry: an unsealed roster line is ignored', () => {
  const root = F.makeRepo();
  const created = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']);
  const J = created.job || created.id || (created.state && created.state.id);
  const fs = require('fs');
  const { jobPaths } = require('../cli/lib/paths');
  fs.appendFileSync(jobPaths(root, J).ledger, JSON.stringify({ at: new Date().toISOString(), job: J, kind: 'agents', agents: [agent('god-eye', 'approve')] }) + '\n');
  const q = telemetry.report(root, { sinceDays: 30 }).quality;
  assert.equal(q.god_eye.verdicts, 0);
});
