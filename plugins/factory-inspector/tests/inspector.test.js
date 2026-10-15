'use strict';
// The inspector against real factory jobs (built with the factory's own test fixture)
// and against synthetic records for the deviations a working factory can't produce.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('../../factory/tests/helpers/fixture');
const I = require('../inspector/main');
const rules = require('../inspector/rules');
const { check: guardCheck } = require('../hooks/guard-rules');

const PLUGIN = path.resolve(__dirname, '..');
const BIN = path.join(PLUGIN, 'bin', 'factory-inspect');
const next = (root) => F.cli(root, ['next']);
const inspect = (root, args) => JSON.parse(spawnSync('node', [BIN, ...args], { cwd: root, encoding: 'utf8' }).stdout);

// A complete, well-behaved bug@low job: what Claude should do, step by step.
function cleanJob(root) {
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  next(root);
  let b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  next(root);
  F.reply(root, 'approve');
  next(root);
  b = F.cli(root, ['wfargs', 'ground']);
  F.record(root, F.envelope(b, 'ok', { topics: [{ topic: 't', claims: [], unknowns: [] }], degraded: [] }));
  next(root);
  F.cli(root, ['plan', 'from-contract']);
  next(root);
  b = F.cli(root, ['wfargs', 'realize']);
  const s = F.cli(root, ['task', 'start', 'T1']);
  F.write(s.worktree, 'src/add.js', `module.exports = (a, b) => a + b; // ${J}\n`);
  F.sh(s.worktree, 'git commit -qam fix');
  F.built(root, 'T1'); // the builder replied done (its `task built` step)
  F.cli(root, ['task', 'verify', 'T1']);
  F.record(root, F.envelope(b, 'ok', { tasks: [{ id: 'T1', outcome: 'done', attempts: 1 }] }));
  next(root);
  b = F.cli(root, ['wfargs', 'reconcile']);
  F.cli(root, ['reconcile', 'run']);
  F.record(root, F.envelope(b, 'ok', { integrator: { status: 'merged', summary: '' } }));
  next(root);
  F.cli(root, ['verify', 'run']);
  next(root);
  b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'challenge']);
  F.record(root, F.envelope(b, 'ok', { lanes: [{ lane: 'code', findings: [] }], degraded: [], verifications: [] }, { fingerprint: b.fingerprint }));
  next(root);
  F.cli(root, ['ship', '--local']);
  next(root);
  F.sh(root, `git merge -q --no-ff -m m factory/${J}`);
  F.reply(root, `merged ${F.sh(root, 'git rev-parse HEAD')}`);
  next(root); // a local merge: factory next asks for factory ci verify first
  F.cli(root, ['ci', 'verify']);
  next(root);
  F.cli(root, ['distill', 'done']);
  next(root);
  assert.equal(F.cli(root, ['close']).status, 'closed');
  return J;
}

test('a well-behaved job has no findings; streaks count once per job', () => {
  const root = F.makeRepo();
  const J = cleanJob(root);
  const r = inspect(root, ['run']);
  assert.deepEqual(r.inspected.map((x) => x.job), [J]);
  assert.equal(r.added.length, 0, JSON.stringify(I.report(root, { status: 'all' }).findings, null, 1));
  const again = inspect(root, ['run']);
  assert.equal(again.inspected.length, 0, 'an inspected closed job is not re-counted');
  const st = inspect(root, ['status']);
  assert.equal(st.recipes.find((x) => x.recipe === 'bug@low').clean_streak, 1);
  assert.match(spawnSync('node', [BIN, 'trace', '--job', J], { cwd: root, encoding: 'utf8' }).stdout, /D0001.*clarify/);
});

test('forged records are caught (R1)', () => {
  const root = F.makeRepo();
  const J = cleanJob(root);
  fs.appendFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), JSON.stringify({ at: 'x', job: J, kind: 'step', step: 'challenge', ok: true, bound: {} }) + '\n');
  fs.appendFileSync(path.join(root, '.factory', 'log', 'decisions.jsonl'), JSON.stringify({ ts: 'x', job: J, action: 'human.approve', gate: 'HS' }) + '\n');
  const r = inspect(root, ['run', '--job', J]);
  const fds = I.report(root).findings;
  const seal = fds.find((x) => x.rule === 'R1.seals');
  assert.ok(seal, JSON.stringify(fds));
  assert.match(seal.summary, /ledger\.jsonl lines .*decisions\.jsonl lines/);
  assert.ok(r.added.length >= 1);
});

test('driver fidelity (R7): acting at a gate, and skipping what the router asked for', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  next(root);
  const b = F.cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  F.record(root, F.envelope(b, 'ok', { analysts: [], degraded: [], judge: { questions: [], dismissed: [] }, critique: { verdict: 'approve', items: [] } }));
  assert.equal(next(root).step, 'H1');
  F.cli(root, ['plan', 'from-contract']); // acting while the human hasn't approved
  F.reply(root, 'approve');
  assert.equal(next(root).workflow, 'ground');
  next(root); // asked again with nothing tried: the same decision (factory next is a query)
  F.cli(root, ['answer', '--question', 'Which Node versions?', '--answer', '18+']); // did something else instead of ground
  next(root); // …and asked again: a new decision, so the ground decision was skipped
  inspect(root, ['run', '--job', J]);
  const fds = I.report(root).findings;
  const waiting = fds.find((x) => x.rule === 'R7.acted_while_waiting');
  assert.ok(waiting, JSON.stringify(fds.map((x) => x.rule)));
  assert.equal(waiting.severity, 'high');
  assert.match(waiting.summary, /plan from-contract.*gate "H1"/);
  const skipped = fds.find((x) => x.rule === 'R7.not_done');
  assert.ok(skipped);
  assert.match(skipped.summary, /wfargs ground/);
});

test('synthetic deviations: wrong recipe, skipped step, unpresented gate, unproven review, over-cap rounds', () => {
  const recipe = { id: 'bug@low', version: 1, steps: ['clarify', 'H1', 'ground', 'decompose', 'realize', 'reconcile', 'prove', 'challenge', 'ship', 'H4', 'distill', 'close'].map((step) => ({ step })) };
  const selection = { rules: [{ when: { risk: ['low'], work_type: ['bug'] }, recipe: 'bug@low' }, { when: { risk: ['high'] }, recipe: 'full@high' }] };
  const M = require('../inspector/model');
  const lock = { id: 'bug@low', version: 1, inputs: { work_type: 'bug', risk: 'low', risk_proposed: 'low', epic: false }, recipe, recipe_hash: M.recipeHash(recipe), selection, risk_floor: { hotfix: 'high' }, limits: { max_review_rounds: 1, max_verify_fix_rounds: 3, max_intent_rounds: 4 } };
  const d = (n, extra) => ({ id: `J-0001-D${n}`, job: 'J-0001', ts: `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`, recipe: 'bug@low', recipe_version: 1, ...extra });
  const job = {
    id: 'J-0001',
    state: { status: 'active', work_type: 'bug', risk: 'low', epic: false, recipe: { id: 'bug@low' }, approvals: { H1: { via: 'policy' } } },
    lock,
    stateSealed: true,
    lockSealed: true,
    ledgerLines: [],
    decisionLines: [],
    eventLines: [],
    events: [],
    ledger: [
      { kind: 'step', step: 'clarify', ok: true, at: '2026-01-01T00:00:01Z', bound: {} },
      { kind: 'step', step: 'challenge', ok: true, at: '2026-01-01T00:00:09Z', bound: { fingerprint: 'fp1' } },
    ],
    decisions: [
      d(2, { action: 'skill', step: 'clarify', rule: 'order.next_step' }),
      d(3, { action: 'workflow', step: 'ground', rule: 'order.next_step' }),
      { job: 'J-0001', ts: '2026-01-01T00:00:04Z', action: 'human.approve', gate: 'H1', hash: 'h' },
      d(5, { action: 'workflow', step: 'realize', rule: 'row4.confirmed_serious' }),
      d(6, { action: 'workflow', step: 'realize', rule: 'row4.confirmed_serious' }),
      d(7, { action: 'workflow', step: 'teleport', rule: 'order.next_step' }),
    ],
  };
  const found = rules.inspectJob(job).map((x) => x.rule);
  for (const r of ['R3.skipped_step', 'R4.unpresented_gate', 'R4.policy_approval', 'R5.review_unproven_build', 'R6.rounds_over_cap', 'R3.step_not_in_recipe']) assert.ok(found.includes(r), `${r} in ${found}`);
  const wrong = { ...job, lock: { ...lock, id: 'full@high' }, state: { ...job.state, recipe: { id: 'full@high' } } };
  assert.ok(rules.intendedRecipe(wrong).some((x) => x.rule === 'R2.recipe_selection'));
  const lowered = { ...job, lock: { ...lock, inputs: { work_type: 'hotfix', risk: 'low', risk_proposed: 'low' } } };
  assert.ok(rules.intendedRecipe(lowered).some((x) => x.rule === 'R2.risk_floor'));
});

test('cross-job ambiguity: the same failing check routed by different rules', () => {
  const mk = (id, rule) => ({ id, lock: { id: 'bug@low', recipe_hash: 'r', floors_hash: 'f', selection_hash: 's', plugin: { behaviour_hash: 'b' }, inputs: { work_type: 'bug', risk: 'low' } }, decisions: [{ id: `${id}-D1`, action: 'workflow', step: 'realize', first_failing: 'acs_proven', rule }] });
  const obs = { jobs: { a: mk('J-1', 'row5.acs_unproven'), b: mk('J-2', 'row9.something_else') }, events: [], decisions: [], unsealed: { decisions: [], events: [] } };
  assert.ok(rules.consistency(obs).some((x) => x.rule === 'R8.divergent_routing'));
});

test('friction patterns from real hook events (R9)', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  const guard = path.join(F.PLUGIN, 'hooks', 'guard.js');
  for (let i = 0; i < 3; i++) spawnSync('node', [guard], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: root, agent_type: 'factory:builder' }), encoding: 'utf8' });
  inspect(root, ['run', '--all']);
  const fr = I.report(root).findings.find((x) => x.rule === 'R9.guard_friction');
  assert.ok(fr);
  assert.match(fr.summary, /factory:builder hit the same guard denial 3 times/);
});

test('marks, regressions, modes, sampling and re-arming', () => {
  const root = F.makeRepo();
  const J = cleanJob(root);
  fs.appendFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), '{"forged":true}\n');
  inspect(root, ['run', '--job', J]);
  const id = I.report(root).findings[0].id;
  // human-only from an agent's shell
  assert.equal(inspect(root, ['mark', id, 'fixed']).code, 'human_only');
  assert.ok(guardCheck(`factory-inspect --root /x mark ${id} fixed`));
  assert.ok(guardCheck('factory-inspect mode all off'));
  assert.equal(guardCheck('factory-inspect run --all'), null);
  // your chat reply
  assert.match(I.applyReply(root, I.parseReply(`fixed finding ${id}`)).message, /fixed/);
  inspect(root, ['run', '--job', J]);
  const back = I.report(root).findings.find((x) => x.id === id);
  assert.equal(back.status, 'open');
  assert.equal(back.regressed, true);
  assert.throws(() => I.applyReply(root, I.parseReply(`wontfix finding ${id}`)), /needs a reason/);
  I.applyReply(root, I.parseReply(`wontfix finding ${id} old test data`));
  assert.equal(I.report(root, { status: 'wont_fix' }).findings.length, 1);
  // modes
  I.applyReply(root, I.parseReply('inspect mode bug@low off'));
  const J2 = cleanJob(root);
  const r = inspect(root, ['run']);
  assert.ok(r.skipped.some((s) => s.job === J2 && /off/.test(s.why)));
  I.applyReply(root, I.parseReply('inspect mode bug@low sample 2'));
  assert.equal(inspect(root, ['status']).recipes.find((x) => x.recipe === 'bug@low').mode, 'sample');
  // the rules change → re-armed, back to inspecting everything
  const cfgFile = path.join(root, '.factory', 'inspect', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cfg.recipes['bug@low'].rulebook = 'an-older-rulebook';
  cfg.recipes['bug@low'].streak = 25;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  cleanJob(root);
  const rr = inspect(root, ['run']);
  assert.deepEqual(rr.rearmed.map((x) => x.recipe), ['bug@low']);
  const st = inspect(root, ['status']).recipes.find((x) => x.recipe === 'bug@low');
  assert.equal(st.mode, 'on');
  assert.ok(st.clean_streak <= 1);
});

test('settled recipes get a suggestion, never an automatic change', () => {
  const root = F.makeRepo();
  fs.mkdirSync(path.join(root, '.factory', 'inspect'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'inspect', 'config.json'), JSON.stringify({ settle_after: 1, recipes: {} }));
  cleanJob(root);
  const r = inspect(root, ['run']);
  assert.equal(r.suggestions[0].suggest, 'inspect mode bug@low sample 10');
  assert.equal(inspect(root, ['status']).recipes[0].mode, 'on');
});

test('hooks: after-close reports, session start mentions open findings, replies apply', () => {
  const root = F.makeRepo();
  const J = cleanJob(root);
  const run = (hook, input) => spawnSync('node', [path.join(PLUGIN, 'hooks', hook)], { input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8' });
  const after = JSON.parse(run('after-close.js', { tool_name: 'Bash', tool_input: { command: `factory close --job ${J}` } }).stdout);
  assert.match(after.hookSpecificOutput.additionalContext, /inspected J-0001; no new findings/);
  assert.equal(run('after-close.js', { tool_name: 'Bash', tool_input: { command: 'git status' } }).stdout, '');
  assert.equal(run('session-start.js', {}).stdout, '');
  fs.appendFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), '{"forged":true}\n');
  inspect(root, ['run', '--all']);
  assert.match(JSON.parse(run('session-start.js', {}).stdout).hookSpecificOutput.additionalContext, /1 open factory finding/);
  assert.match(JSON.parse(run('prompt.js', { prompt: 'ack finding F1' }).stdout).hookSpecificOutput.additionalContext, /Applied: Finding F1 marked acknowledged/);
  const denied = JSON.parse(run('guard.js', { tool_name: 'Bash', tool_input: { command: 'factory-inspect mark F1 fixed' } }).stdout);
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(spawnSync('node', [path.join(PLUGIN, 'hooks', 'guard.js')], { input: 'garbage', encoding: 'utf8' }).status, 0);
});

test('job health from synthetic records (R12–R19)', () => {
  const { LIMITS } = require('../inspector/config');
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const ev = (event, h, extra) => ({ event, ts: at(h), job: 'J-0001', decision_id: 'J-0001-D0003', ...extra });
  const job = {
    id: 'J-0001',
    state: { status: 'active', updated_at: at(0) },
    lock: null,
    events: [
      ...Array.from({ length: 5 }, (_, i) => ev('guard_deny', i, { reason: `src/x${i}.js is outside T1's allowed paths` })),
      ev('stop_block', 1, { missing: ['acs_proven'] }), ev('stop_block', 2, { missing: ['review_clean'] }),
      ev('reply_refused', 1, { code: 'stale_gate' }), ev('reply_refused', 2, { code: 'stale_gate' }),
      ev('reply_unparsed', 1, { word: 'aprove', verb: 'approve' }), ev('reply_unparsed', 2, { word: 'aprove', verb: 'approve' }),
      ...[1, 2, 3].map((h) => ev('cli', h, { cmd: 'task', sub: 'verify', ok: false, code: 'verify_failed' })),
      ev('cli', 3, { cmd: 'record', ok: true, status: 'stale', workflow: 'realize' }), ev('cli', 4, { cmd: 'record', ok: true, status: 'stale', workflow: 'realize' }),
      ev('cli', 5, { cmd: 'park', ok: true }),
      ev('SubagentStart', 1, { agent_id: 'a1', agent_type: 'factory:builder' }), ev('SubagentStop', 2, { agent_id: 'a1' }),
      ev('SubagentStart', 2, { agent_id: 'a2', agent_type: 'factory:tester' }),
    ],
    ledger: [
      { kind: 'error', workflow: 'ground', summary: 'boom', at: at(1) }, { kind: 'error', workflow: 'ground', summary: 'boom', at: at(2) },
      { kind: 'step', step: 'clarify', ok: true, at: at(1), detail: { degraded: ['security analyst'] } },
      { kind: 'step', step: 'clarify', ok: true, at: at(1), detail: { round: 1, dropped: 2 } }, { kind: 'step', step: 'clarify', ok: false, at: at(2), detail: { round: 2, intent_open: true, intent_rounds: 2, dropped: 1 } },
      ...[1, 2, 3].map((h) => ({ kind: 'step', step: 'decompose', ok: false, at: at(h) })),
      { kind: 'agents', workflow: 'realize', at: at(3), agents: [
        { label: 'build T1 #1', agent_type: 'builder', model: null, outcome: 'done' }, { label: 'build T1 #2', agent_type: 'builder', model: 'opus', outcome: 'done' }, { label: 'build T1 #3', agent_type: 'builder', model: 'opus', outcome: 'exhausted' },
        { label: 'test T1', agent_type: 'tester', outcome: 'fail' }, { label: 'scan (retry)', agent_type: 'analyst', retry: true, outcome: 'no_result' }, { label: 'scan2 (retry)', agent_type: 'analyst', retry: true, outcome: 'ok' },
      ] },
    ],
    decisions: [
      { id: 'J-0001-D0001', ts: at(0), action: 'gate', step: 'H1', recipe: 'bug@low' },
      { ts: at(60), action: 'human.approve', gate: 'H1' },
      { id: 'J-0001-D0002', ts: at(61), action: 'parked', rule: 'cap.review_rounds' }, { id: 'J-0001-D0003', ts: at(62), action: 'parked', rule: 'cap.review_rounds' },
      ...[63, 64, 65].map((h) => ({ ts: at(h), action: 'human.resume', from: 'review' })),
    ],
  };
  const found = rules.jobHealth(job, LIMITS, at(200));
  const ids = found.map((x) => x.rule);
  for (const r of ['R12.guard_denials', 'R12.stop_blocks', 'R12.replies_refused', 'R12.replies_unparsed', 'R13.cli_failures', 'R13.stale_results', 'R14.workflow_errors', 'R14.degraded', 'R14.agent_retries', 'R14.agent_failures', 'R14.escalations', 'R14.step_failures', 'R15.orphaned_agents', 'R16.park_loop', 'R16.resumed_past_caps', 'R17.idle_job', 'R18.slow_reply', 'R19.intent_parked', 'R19.question_overrun']) assert.ok(ids.includes(r), `${r} in ${ids}`);
  assert.match(found.find((x) => x.rule === 'R13.cli_failures').summary, /factory task verify" failed 3 times .* verify_failed/);
  assert.match(found.find((x) => x.rule === 'R15.orphaned_agents').summary, /factory:tester/);
  for (const x of found) assert.ok(['deviation', 'ambiguity', 'gap'].includes(x.class) && ['high', 'medium', 'low'].includes(x.severity), x.rule);
  // under the limits: nothing
  const quiet = rules.jobHealth({ ...job, events: job.events.slice(0, 2), ledger: [], decisions: [], state: { status: 'active', updated_at: at(199) } }, LIMITS, at(200));
  assert.deepEqual(quiet, []);
});

test('factory-wide health (R10 hook errors, R11 torn lines, R13 crashes) and the health report', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']).job;
  // a factory hook fails: tampered state makes session-start throw → sealed hook_error
  const st = path.join(F.jobDir(root, J), 'state.json');
  const good = fs.readFileSync(st, 'utf8');
  fs.writeFileSync(st, JSON.stringify({ ...JSON.parse(good), risk: 'high' }));
  spawnSync('node', [path.join(F.PLUGIN, 'hooks', 'session-start.js')], { input: JSON.stringify({ cwd: root, hook_event_name: 'SessionStart' }), encoding: 'utf8' });
  fs.writeFileSync(st, good);
  // the inspector's own hook fails: its register can't be written
  fs.mkdirSync(path.join(root, '.factory', 'inspect', 'register.json'), { recursive: true });
  const after = spawnSync('node', [path.join(PLUGIN, 'hooks', 'after-close.js')], { input: JSON.stringify({ cwd: root, tool_name: 'Bash', tool_input: { command: `factory close --job ${J}` } }), encoding: 'utf8' });
  assert.equal(after.status, 0);
  fs.rmSync(path.join(root, '.factory', 'inspect', 'register.json'), { recursive: true });
  assert.match(fs.readFileSync(path.join(root, '.factory', 'inspect', 'hook-errors.jsonl'), 'utf8'), /"hook":"after-close"/);
  // a torn line
  fs.appendFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), '{"ts":"2026-01-01T00:00:00Z","event":"cl\n');
  // the job is still active: --active inspects it now
  const r = inspect(root, ['run', '--active']);
  assert.deepEqual(r.inspected.map((x) => x.job), [J]);
  const fds = I.report(root).findings;
  const he = fds.find((x) => x.rule === 'R10.hook_errors');
  assert.ok(he, JSON.stringify(fds.map((x) => x.rule)));
  assert.match(he.summary, /session-start hook failed 1 time/);
  assert.ok(fds.some((x) => x.rule === 'R10.inspector_hook_errors'));
  assert.ok(fds.some((x) => x.rule === 'R11.torn_lines'));
  assert.ok(!fds.some((x) => x.rule === 'R1.unattributed_lines'), 'a torn line is R11, not a forgery');
  const md = spawnSync('node', [BIN, 'report', '--format', 'md'], { cwd: root, encoding: 'utf8' }).stdout;
  assert.match(md, /## Factory health/);
  assert.match(md, /Hook errors: session-start ×1 · inspector hooks 1/);
  assert.match(md, /torn lines 1/);
  assert.equal(inspect(root, ['health']).hook_errors[0].key, 'session-start');
  // crashes are factory-wide
  const obs = { jobs: {}, events: [{ event: 'cli', cmd: 'verify', sub: 'run', ok: false, code: 'internal', ts: 'x', job: J }], decisions: [], unsealed: { decisions: [], events: [] }, torn: { events: [], decisions: [] } };
  assert.equal(rules.factoryHealth(obs, require('../inspector/config').LIMITS)[0].rule, 'R13.cli_crash');
});

test('limits and rules_off come from config; a fixed health finding reopens only on new evidence', () => {
  const root = F.makeRepo();
  F.cli(root, ['job', 'new', '--title', 'x', '--type', 'bug', '--risk', 'low']);
  fs.mkdirSync(path.join(root, '.factory', 'inspect'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory', 'inspect', 'config.json'), JSON.stringify({ limits: { guard_denials_per_job: 2 }, rules_off: ['R9'] }));
  const guard = path.join(F.PLUGIN, 'hooks', 'guard.js');
  const deny = () => spawnSync('node', [guard], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: root }), encoding: 'utf8' });
  for (let i = 0; i < 3; i++) deny();
  inspect(root, ['run', '--active']);
  let fds = I.report(root).findings;
  const g = fds.find((x) => x.rule === 'R12.guard_denials');
  assert.ok(g && /3 guard denials \(limit 2\)/.test(g.summary), JSON.stringify(fds.map((x) => x.rule)));
  assert.ok(!fds.some((x) => x.rule.startsWith('R9.')), 'R9 switched off');
  assert.equal(inspect(root, ['status']).limits.guard_denials_per_job, 2);
  I.applyReply(root, I.parseReply(`fixed finding ${g.id}`));
  inspect(root, ['run', '--active']);
  assert.equal(I.report(root, { status: 'all' }).findings.find((x) => x.id === g.id).status, 'fixed', 'old denials do not reopen it');
  deny();
  inspect(root, ['run', '--active']);
  fds = I.report(root, { status: 'all' }).findings;
  assert.equal(fds.find((x) => x.id === g.id).status, 'open', 'a new denial does');
});

test('hooks: a job that ends outside Claude\'s Bash is caught at the end of the turn and at session start', () => {
  const root = F.makeRepo();
  const run = (hook, input) => spawnSync('node', [path.join(PLUGIN, 'hooks', hook)], { input: JSON.stringify({ cwd: root, ...input }), encoding: 'utf8' });
  const J = F.cli(root, ['job', 'new', '--title', 'Never mind', '--type', 'bug', '--risk', 'low']).job;
  assert.equal(run('catch-up.js', {}).stdout, '', 'an active job is not inspected');
  F.reply(root, 'cancel job'); // applied by the factory's prompt hook: no Bash, no PostToolUse
  assert.deepEqual(I.pending(root), [J]);
  assert.match(JSON.parse(run('catch-up.js', {}).stdout).systemMessage, new RegExp(`inspected ${J}`));
  assert.deepEqual(I.pending(root), []);
  assert.equal(run('catch-up.js', {}).stdout, '', 'nothing pending: silent');

  const J2 = F.cli(root, ['job', 'new', '--title', 'Also not', '--type', 'bug', '--risk', 'low']).job;
  F.reply(root, `abandon job ${J2}`);
  assert.match(JSON.parse(run('session-start.js', {}).stdout).hookSpecificOutput.additionalContext, new RegExp(`inspected ${J2}`));
});

test('independence: the inspector imports nothing from the factory', () => {
  for (const dir of ['inspector', 'hooks', 'bin']) {
    for (const f of fs.readdirSync(path.join(PLUGIN, dir))) {
      const src = fs.readFileSync(path.join(PLUGIN, dir, f), 'utf8');
      assert.ok(!/require\([^)]*factory\/cli/.test(src) && !/require\(['"]\.\.\/\.\.\/factory/.test(src), `${dir}/${f} must not import factory code`);
    }
  }
});

test('R19.intent_parked fires only on the park entry, not on a needs_user round that asks an intent question', () => {
  const { LIMITS } = require('../inspector/config');
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const job = {
    id: 'J-0001',
    state: { status: 'active', updated_at: at(9) },
    lock: null,
    ledger: [{ kind: 'step', step: 'clarify', ok: false, at: at(1), detail: { round: 1, questions: 1, question_ids: ['Q-1'], intent_open: true, held: 2, dropped: 0 } }],
    decisions: [{ id: 'J-0001-D0001', ts: at(1), action: 'skill', skill: 'clarify' }],
    events: [],
  };
  assert.ok(!rules.jobHealth(job, LIMITS, at(10)).some((x) => x.rule === 'R19.intent_parked'), 'a needs_user intent round is not a park');
  // the real park entry (record.js: intent_open, questions 0, no question ids) still fires
  job.ledger.push({ kind: 'step', step: 'clarify', ok: false, at: at(4), detail: { round: 2, intent_open: true, intent_rounds: 2, questions: 0, contract_problems: [] } });
  assert.ok(rules.jobHealth(job, LIMITS, at(10)).some((x) => x.rule === 'R19.intent_parked'));
});

test('guard regressions: redirects to /dev/null, prose and patterns are not inspector writes or calls; indirection is caught', () => {
  for (const c of [
    'ls .factory/inspect/ 2>/dev/null',
    "jq '.findings | length' .factory/inspect/register.json > /tmp/n.txt",
    'grep -c open .factory/inspect/register.json 2>&1',
    'cat .factory/inspect/register.json >&2',
    'grep -n "factory-inspect mark" $(git ls-files \'*.md\')',
    'git commit -m "docs: factory-inspect mode examples"',
    "echo 'Run factory-inspect mark F3 --status fixed when done'",
    'gh pr create --body "then run factory-inspect mode all off"',
    'factory-inspect report --status open 2>/dev/null | head',
    'factory-inspect run',
  ]) assert.equal(guardCheck(c), null, c);
  for (const c of [
    'factory-inspect mark F1 fixed',
    'echo x > .factory/inspect/register.json',
    'jq . x.json | tee .factory/inspect/config.json',
    'rm -f .factory/inspect/register.json',
    'sed -i s/open/fixed/ .factory/inspect/register.json',
    'bash -c "factory-inspect mode all off"',
    `env X=1 node ${BIN} mark F2 fixed`,
    'X=$(which factory-inspect); $X mark F1 fixed',
    'echo "$(factory-inspect mode all off)"',
    `I=${BIN}; node $I mark F1 --to fixed`,
    `echo mode | xargs node ${BIN}`,
    'eval "factory-inspect ma""rk F1"',
  ]) assert.ok(guardCheck(c), c);
  assert.equal(fs.readFileSync(path.join(PLUGIN, 'hooks', 'shell.js'), 'utf8'), fs.readFileSync(path.join(PLUGIN, '..', 'factory', 'hooks', 'shell.js'), 'utf8'), "the shell reader is an identical copy of the factory's");
});

test('clarify v2: R6 reads the ceiling each round recorded, R19 flags stalled rounds and re-raised issues, R7 lets clarify status, notes and your split through', () => {
  const { LIMITS } = require('../inspector/config');
  const at = (h) => new Date(Date.UTC(2026, 0, 1) + h * 36e5).toISOString();
  const step = (h, round, lg) => ({ kind: 'step', step: 'clarify', ok: false, at: at(h), detail: { round, questions: 0, question_ids: [], ledger: { opened: 0, settled: 0, deferred: 0, asked: 0, progress: false, degraded: false, ceiling: 10, counted: round, reraised: 0, ...lg } } });
  const job = { id: 'J-0002', state: { status: 'active', updated_at: at(9) }, lock: { limits: { max_intent_rounds: 4 } }, decisions: [], events: [],
    ledger: [step(1, 1, { progress: true, asked: 3, reraised: 2 }), step(2, 2, { degraded: true }), step(3, 3, { reraised: 1 }), step(4, 4, {}), step(5, 5, { progress: true, settled: 2 }), step(6, 6), step(7, 7), step(8, 8)] };
  // 8 clarify entries is over the v1 cap (4 + 2), but each v2 round was within the ceiling it recorded
  assert.ok(!rules.loops(job).some((x) => x.rule === 'R6.clarify_over_cap'));
  job.ledger.push(step(9, 11, { ceiling: 10, counted: 11 }));
  assert.match(rules.loops(job).find((x) => x.rule === 'R6.clarify_over_cap').summary, /11 counted rounds; the ceiling it recorded was 10/);
  const found = rules.jobHealth(job, LIMITS, at(10));
  const ids = found.map((x) => x.rule);
  assert.ok(ids.includes('R19.clarify_stalled'), ids.join());
  assert.match(found.find((x) => x.rule === 'R19.clarify_stalled').summary, /4 round\(s\) in a row/, 'the degraded round is not counted; the longest streak');
  assert.ok(ids.includes('R19.issues_reraised'));
  // R7: clarify status is read-only, clarify note belongs to the clarify step, your split is yours
  const exp = rules.expectationsFor({ action: 'skill', skill: 'clarify' });
  assert.ok(exp.allowed.has('clarify:note') && exp.allowed.has('answer'));
  const cli = (h, d, extra) => ({ event: 'cli', ts: at(h), job: 'J-0002', decision_id: d, ok: true, ...extra });
  const j2 = { id: 'J-0002', state: {}, lock: null, ledger: [], decisions: [{ id: 'D1', ts: at(1), action: 'gate', step: 'H1' }], events: [cli(1.1, 'D1', { cmd: 'clarify', sub: 'status' }), cli(1.2, 'D1', { cmd: 'clarify', sub: 'split' })] };
  assert.deepEqual(rules.driverFidelity(j2), [], 'clarify status while waiting at a gate is a look; a split that went through is the user acting');
  j2.events.push(cli(1.3, 'D1', { cmd: 'clarify', sub: 'split', ok: false, code: 'human_only' }));
  assert.equal(rules.driverFidelity(j2).length, 1, 'a refused split attempt is still judged');
});

test('outcome integrity: a serious finding left unverified and never settled, and a task counted done after its builder failed (e2e audit)', () => {
  const base = { id: 'J-0001', state: { status: 'active', tasks: {} }, lock: null, ledgerLines: [], decisionLines: [], eventLines: [], events: [], decisions: [] };
  const code1 = { id: 'code-1', lane: 'code', severity: 'major', file: 'src/alerts.js', line: 3, summary: 'an item without reorder_at is never alerted', status: 'unverified' };
  // the e2e run: round 1 unverified, round 2 the reviewer did not raise it, the round passed, the job shipped
  const lostJob = { ...base, ledger: [
    { kind: 'step', step: 'challenge', ok: false, at: '2026-01-01T00:00:01Z', bound: { fingerprint: 'fp' }, detail: { round: 1, findings: [code1] } },
    { kind: 'step', step: 'challenge', ok: true, at: '2026-01-01T00:00:02Z', bound: { fingerprint: 'fp' }, detail: { round: 1, findings: [] } },
    { kind: 'step', step: 'ship', ok: true, at: '2026-01-01T00:00:03Z', bound: { fingerprint: 'fp' }, detail: {} },
  ] };
  const lost = rules.evidenceChain(lostJob).find((x) => x.rule === 'R5.unverified_finding_lost');
  assert.ok(lost, 'flagged');
  assert.match(lost.summary, /the job shipped: code-1 \[major\] src\/alerts.js:3/);
  // carried (the factory since this fix) or settled later: not flagged
  const carried = { ...lostJob, ledger: [lostJob.ledger[0], { ...lostJob.ledger[1], ok: false, detail: { round: 1, findings: [{ ...code1, carried: { from_round: 1, times: 1 } }] } }] };
  assert.ok(!rules.evidenceChain(carried).some((x) => x.rule === 'R5.unverified_finding_lost'));
  const settled = { ...lostJob, ledger: [lostJob.ledger[0], { ...lostJob.ledger[1], detail: { round: 1, findings: [{ ...code1, status: 'refuted' }] } }, lostJob.ledger[2]] };
  assert.ok(!rules.evidenceChain(settled).some((x) => x.rule === 'R5.unverified_finding_lost'));
  // T2's builder crashed, its tester passed the stale branch
  const roster = { kind: 'agents', workflow: 'realize', at: '2026-01-01T00:00:05Z', agents: [
    { label: 'build T1 #1', outcome: 'done' }, { label: 'build T2 #1', outcome: 'no_result' }, { label: 'test T1', outcome: 'pass' }, { label: 'test T2', outcome: 'pass' },
  ] };
  const done = rules.evidenceChain({ ...base, ledger: [roster], state: { tasks: { T3: { outcome: 'done', outcome_at: '2026-01-01T00:00:06Z', builder: { outcome: 'blocked' } } } } }).find((x) => x.rule === 'R5.done_without_builder');
  assert.ok(done, 'flagged');
  assert.deepEqual(done.evidence, ['T2', 'T3']);
  assert.ok(!rules.evidenceChain({ ...base, ledger: [{ ...roster, agents: roster.agents.filter((a) => !/T2/.test(a.label)) }] }).some((x) => x.rule === 'R5.done_without_builder'));
});
