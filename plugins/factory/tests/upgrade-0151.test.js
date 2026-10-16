'use strict';
// Upgrade: jobs still in clarify under an older factory reach H1 under clarify v3. Their records
// are made by the real older CLIs from this repository's git history: 0.15.1 (c0141e3, clarify v2:
// clarify-ledger.json) mid-questions, waiting at H1, after a denial and parked; and 0.13.0
// (b3a46c5, clarify v1: question_log and answers.json) mid-questions. Each is then driven by this
// factory, stage by stage, to H1. Skipped outside a git checkout that has those commits.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const F = require('./helpers/fixture');
const C = require('../cli/core/clarify');

const REPO = path.resolve(F.PLUGIN, '..', '..');
const V2_REV = 'c0141e3';
const V1_REV = 'b3a46c5';
const has = (rev) => spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${rev}:plugins/factory/bin/factory`]).status === 0;
const plugins = {};
function oldCli(rev) {
  if (!plugins[rev]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `factory-${rev}-`));
    const r = spawnSync('bash', ['-c', `git -C "${REPO}" archive ${rev} plugins/factory | tar -x -C "${dir}"`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    plugins[rev] = path.join(dir, 'plugins', 'factory', 'bin', 'factory');
  }
  const bin = plugins[rev];
  const cli = (root, args) => {
    const r = spawnSync('node', [bin, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: '' } });
    try {
      return JSON.parse(r.stdout);
    } catch {
      return { raw: r.stdout, stderr: r.stderr };
    }
  };
  cli.record = (root, env) => {
    const f = path.join(root, '.factory', 'scratch', `old-env-${Date.now()}-${Math.floor(performance.now())}.json`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(env));
    return cli(root, ['record', '--file', f]);
  };
  return cli;
}

const CONTRACT = F.contractText({ ac: '- AC-1: add(2, 3) returns 5 (evidence: test)\n- AC-2: add(-1, -2) returns -3 (evidence: test)', verify: '`node tests/add.test.js` (AC-1, AC-2)' });
const Q = (question, extra = {}) => ({ question, category: 'scope', why: 'w', default: 'None: answer needed', ...extra });

// An older clarify round recorded by the older CLI: the judge's questions, God Eye's critique.
function oldRound(cli, root, { questions = [], critique = null, degraded = [], status = null } = {}) {
  cli(root, ['next']);
  const b = cli(root, ['wfargs', 'fanout-judge', '--config', 'clarify']);
  if (!b.workflow) throw new Error(`old wfargs: ${JSON.stringify(b).slice(0, 300)}`);
  return cli.record(root, F.envelope(b, status || (questions.length ? 'needs_user' : 'ok'), { analysts: [], degraded, judge: { questions, dismissed: [] }, critique }));
}

const APPROVE = { verdict: 'approve', intent_confirmed: true, restatement: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, checklist: { intent_clear: true, scope_bounded: true, acs_testable: true, no_open_blockers: true, constraints_consistent: true }, items: [] };

// This factory, stage by stage, the way the clarify skill drives it, with scripted stage outputs:
// a read-back that keeps every item, research that finds nothing, a redirect read one clause per
// sentence, the writer covering every item, God Eye's checklist all true. Sheet replies answer
// every open decision in words.
function toH1(root, J, { max = 40 } = {}) {
  const JD = F.jobDir(root, J);
  const rec = () => JSON.parse(fs.readFileSync(path.join(JD, 'clarify.json'), 'utf8'));
  const screens = [];
  for (let i = 0; i < max; i++) {
    const n = F.cli(root, ['next']);
    if (!(n.action === 'skill' && n.skill === 'clarify')) return { next: n, screens, record: rec() };
    const c = n.clarify || {};
    if (c.error) throw new Error(c.error);
    if (c.waiting_for_user) {
      screens.push(c);
      let said = 'ok';
      if (c.stage === 'sheet_wait') {
        const s = rec().sheets.slice(-1)[0];
        const open = s.decisions.filter((d) => !d.answered);
        if (open.length) said = open.map((d) => `${d.no}: answered after the upgrade ${d.no}`).join(', ');
      }
      const r = F.cli(root, ['clarify', 'reply', said]);
      if (r.error) throw new Error(JSON.stringify(r));
      continue;
    }
    const brief = F.cli(root, ['wfargs', 'clarify']);
    if (brief.error) throw new Error(JSON.stringify(brief));
    const d = rec();
    const text = fs.readFileSync(path.join(JD, 'contract.md'), 'utf8');
    const R = d.redirects[d.redirects.length - 1];
    const outputs = {
      readback: { 'read-back': { intent: { problem: 'p', who: 'w', outcome: 'o', success: 's' }, scope: { in: [], out: [] }, took: [], pins: [], plan: [], questions: [], design_may_choose: [] } },
      research: Object.fromEntries([...brief.groups.flat().filter((a) => a.label !== 'research brief').map((a) => [a.label, { mode: a.mode, evidence: [], unresolved: [] }]), ['research brief', { summary: 'nothing found', records: [], facts: [], gaps: [] }]]),
      redirect: { redirect: { clauses: C.sentences((R || {}).text || '').map((q) => ({ quote: q, item: 'new', action: 'instruction', text: q })) } },
      assemble: { contract: { contract: text, covers: d.items.map((x) => ({ item: x.id, where: 'Goal' })), uncovered: [] } },
      check: { readiness: { verdict: 'ready', restatement: { problem: 'p', outcome: 'o' }, checklist: Object.fromEntries(C.CHECKLIST.map((k) => [k, true])), objections: [] } },
    }[brief.stage];
    if (!outputs) throw new Error(`no script for ${brief.stage}`);
    F.record(root, F.envelope(brief, 'ok', { stage: brief.stage, rev: brief.rev, outputs }));
  }
  throw new Error('max steps');
}

function newJob(cli) {
  const root = F.makeRepo();
  const J = cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'feature', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), CONTRACT);
  return { root, J };
}

test('upgrade from 0.15.1 (clarify v2) mid-questions: the answered question is the user\'s, the open one is asked on the sheet, H1 is reached', { skip: !has(V2_REV) && `needs ${V2_REV} from git history` }, () => {
  const old = oldCli(V2_REV);
  const { root, J } = newJob(old);
  const r = oldRound(old, root, { questions: [Q('Should add() accept numeric strings?', { options: ['Numbers only', 'Coerce numeric strings'], default: 'Numbers only' }), Q('Who reads the totals?')] });
  assert.equal(r.status, 'needs_user', JSON.stringify(r).slice(0, 300));
  const q1 = r.questions.find((q) => /numeric strings/.test(q.question));
  assert.equal(old(root, ['answer', q1.id, 'Coerce numeric strings']).settled_by, 'user');
  // ---- upgraded
  const n = F.cli(root, ['next']);
  assert.equal(n.clarify.stage, 'readback');
  assert.equal(n.clarify.migrated.from, 2);
  const h = toH1(root, J);
  assert.equal(h.next.step, 'H1', JSON.stringify(h.next).slice(0, 300));
  const items = h.record.items;
  const strings = items.find((x) => /numeric strings/.test(x.text));
  assert.deepEqual([strings.value, strings.strength], ['Coerce numeric strings', 'user']);
  const who = items.find((x) => /reads the totals/.test(x.text));
  assert.deepEqual([who.status, who.strength], ['decided', 'user'], 'asked on the v3 sheet and answered there');
  assert.ok(h.screens.some((s) => s.stage === 'sheet_wait' && /Who reads the totals/.test(s.screen)));
  assert.match(h.screens[0].screen, /Carried over from before v3: .*clarify v2/);
  assert.ok(!h.screens.some((s) => s.stage === 'sheet_wait' && /numeric strings/.test(s.screen)), 'the answered question is not asked again');
});

test('upgrade from 0.15.1 waiting at H1: the job is read back once more and reaches H1 under v3, nothing lost', { skip: !has(V2_REV) && `needs ${V2_REV} from git history` }, () => {
  const old = oldCli(V2_REV);
  const { root, J } = newJob(old);
  let r = oldRound(old, root, { questions: [Q('Should add() accept numeric strings?', { options: ['Numbers only', 'Coerce'], default: 'Numbers only' })] });
  old(root, ['answer', r.questions[0].id, 'Numbers only']);
  r = oldRound(old, root, { critique: APPROVE });
  assert.equal(r.status, 'ok', JSON.stringify(r).slice(0, 300));
  assert.equal(old(root, ['next']).step, 'H1');
  // ---- upgraded, the gate not approved yet: clarify v3 takes the job
  const n = F.cli(root, ['next']);
  assert.equal(n.skill, 'clarify', 'the v2 contract was never approved: v3 reads it back');
  const h = toH1(root, J);
  assert.equal(h.next.step, 'H1');
  assert.ok(h.next.clarify_h1, 'the v3 H1 view');
  assert.ok(h.record.items.some((x) => x.value === 'Numbers only' && x.strength === 'user'));
  F.reply(root, `approve ${J}`);
  assert.notEqual(F.cli(root, ['next']).step, 'H1', 'past H1');
});

test('upgrade from 0.15.1 after a denial: the denial becomes a redirect, read back after the read-back, and is reported at H1', { skip: !has(V2_REV) && `needs ${V2_REV} from git history` }, () => {
  const old = oldCli(V2_REV);
  const { root, J } = newJob(old);
  oldRound(old, root, { critique: APPROVE });
  assert.equal(old(root, ['next']).step, 'H1');
  F.reply(root, `deny ${J} also handle floats; keep the error message short`);
  // the deny happened before the upgrade: the old factory's next would rerun clarify v2
  // ---- upgraded
  const h = toH1(root, J);
  assert.equal(h.next.step, 'H1', JSON.stringify(h.next).slice(0, 300));
  const stages = h.screens.map((s) => s.stage);
  assert.deepEqual(stages.slice(0, 2), ['readback_wait', 'redirect_wait'], 'read-back first, then the denial read back');
  assert.match(h.screens[1].screen, /also handle floats/);
  const R = h.next.clarify_h1.redirects[0];
  assert.equal(R.of, 2);
  assert.equal(R.done, 2, JSON.stringify(R));
});

test('upgrade from 0.15.1 parked by clarify: resume, then v3 reads it back and reaches H1', { skip: !has(V2_REV) && `needs ${V2_REV} from git history` }, () => {
  const old = oldCli(V2_REV);
  const { root, J } = newJob(old);
  // analysts failed in two rounds in a row: 0.15.1 parks
  oldRound(old, root, { degraded: ['intent-analyst:testability'], status: 'degraded' });
  const r = oldRound(old, root, { degraded: ['intent-analyst:testability'], status: 'degraded' });
  assert.equal(r.status, 'park', JSON.stringify(r).slice(0, 300));
  // ---- upgraded
  const p = F.cli(root, ['next']);
  assert.equal(p.action, 'parked');
  assert.equal(F.cli(root, ['clarify', 'reply', 'ok']).code, 'parked', 'words wait while it is parked');
  F.reply(root, `resume ${J}`);
  const n = F.cli(root, ['next']);
  assert.equal(n.clarify.stage, 'readback');
  const h = toH1(root, J);
  assert.equal(h.next.step, 'H1', JSON.stringify(h.next).slice(0, 300));
});

test('upgrade from 0.13.0 (clarify v1) mid-questions: the question log and answers.json become items by id, H1 is reached', { skip: !has(V1_REV) && `needs ${V1_REV} from git history` }, () => {
  const old = oldCli(V1_REV);
  const { root, J } = newJob(old);
  const r = oldRound(old, root, { questions: [Q('Should add() accept numeric strings?', { default: 'Numbers only' }), Q('Who reads the totals?')] });
  assert.equal(r.status, 'needs_user', JSON.stringify(r).slice(0, 300));
  assert.ok(old(root, ['answer', '--id', r.questions[0].id, '--answer', 'Coerce numeric strings']).answers >= 1);
  assert.ok(!fs.existsSync(path.join(F.jobDir(root, J), 'clarify-ledger.json')), 'a v1 job: no ledger');
  // ---- upgraded
  const n = F.cli(root, ['next']);
  assert.equal(n.clarify.migrated.from, 1);
  const h = toH1(root, J);
  assert.equal(h.next.step, 'H1', JSON.stringify(h.next).slice(0, 300));
  const strings = h.record.items.find((x) => /numeric strings/.test(x.text));
  assert.deepEqual([strings.value, strings.strength], ['Coerce numeric strings', 'user']);
  assert.ok(h.record.items.find((x) => /reads the totals/.test(x.text)).status === 'decided');
});
