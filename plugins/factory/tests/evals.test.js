'use strict';
// Tier 0 checks on the `claude plugin eval` suites (Tier 2 and Tier 3), at no model cost:
// the committed cases match their sets, the manifest points the CLI at them, and every case
// keeps the eval floor (≥3 runs, an outcome grader besides tool_used, should-not-fire cases,
// tools that let the graders pass, fixtures that stage).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const gen = require('../evals/tools/generate');

const FACTORY = path.resolve(__dirname, '..');
const INSPECTOR = path.resolve(FACTORY, '..', 'factory-inspector');
const PLUGINS = [FACTORY, INSPECTOR].filter((p) => fs.existsSync(path.join(p, 'evals', 'sets')));
const USER_INVOCABLE = { [FACTORY]: ['start', 'console', 'review', 'why'], [INSPECTOR]: ['inspect'] };

const cases = (p) => gen.build(p).filter((c) => c.yaml);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('evals: committed cases match evals/sets (run evals/tools/generate.js after editing a set)', () => {
  for (const p of PLUGINS) assert.deepEqual(gen.check(p), [], path.basename(p));
});

test('evals: each plugin manifest points `claude plugin eval` at its eval dir', () => {
  for (const p of PLUGINS) {
    const m = readJson(path.join(p, '.claude-plugin', 'plugin.json'));
    assert.ok(m.experimental && typeof m.experimental.evals === 'string', `${path.basename(p)}: experimental.evals missing`);
    assert.ok(fs.existsSync(path.join(p, m.experimental.evals)), `${path.basename(p)}: ${m.experimental.evals} missing`);
  }
});

test('evals: every case keeps the floor (schema, ≥3 runs, outcome grader, tools follow graders)', () => {
  const problems = [];
  for (const p of PLUGINS) {
    const names = new Set();
    for (const c of cases(p)) {
      const y = c.yaml;
      const where = `${path.basename(p)}/${c.file}`;
      if (!/^1\./.test(y.schema_version)) problems.push(`${where}: schema_version ${y.schema_version}`);
      if (names.has(y.name)) problems.push(`${where}: duplicate name ${y.name}`);
      names.add(y.name);
      if (!(y.runs >= 3)) problems.push(`${where}: runs ${y.runs} < 3`);
      if (!y.execution.prompt || !y.execution.prompt.trim()) problems.push(`${where}: empty prompt`);
      if (/(^|\s)(\/home\/|~\/)/.test(y.execution.prompt)) problems.push(`${where}: absolute path in prompt`);
      if (!y.graders.some((g) => g.type !== 'tool_used')) problems.push(`${where}: only tool_used graders (needs an outcome grader)`);
      const gnames = y.graders.map((g) => g.name);
      if (new Set(gnames).size !== gnames.length) problems.push(`${where}: duplicate grader names`);
      for (const g of y.graders) {
        if (g.type === 'tool_used' && (g.min === undefined || g.min >= 1)) {
          const allowed = y.execution.allowed_tools.map((t) => t.replace(/\(.*$/, ''));
          if (!allowed.includes(g.tool)) problems.push(`${where}: grader ${g.name} needs ${g.tool} in allowed_tools`);
        }
        if (g.type === 'tool_used' && g.max === 0 && g.arm !== 'both') problems.push(`${where}: must-not grader ${g.name} needs arm: both`);
        if (g.type === 'regex') {
          try {
            new RegExp(g.pattern, g.flags);
          } catch (e) {
            problems.push(`${where}: grader ${g.name}: ${e.message}`);
          }
        }
        if (g.input_match) new RegExp(g.input_match);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('evals: each suite has should-not-fire cases and ~8+8 trigger prompts per user-invocable skill', () => {
  for (const p of PLUGINS) {
    const all = cases(p);
    assert.ok(all.some((c) => c.yaml.graders.some((g) => g.type === 'tool_used' && g.max === 0)), `${path.basename(p)}: no should-not-fire case`);
    for (const skill of USER_INVOCABLE[p] || []) {
      const t = all.filter((c) => c.yaml.tags.includes(`skill:${skill}`) && c.yaml.tags.includes('trigger'));
      assert.ok(t.filter((c) => c.yaml.tags.includes('should-fire')).length >= 8, `${skill}: fewer than 8 should-fire prompts`);
      assert.ok(t.filter((c) => c.yaml.tags.includes('should-not-fire')).length >= 8, `${skill}: fewer than 8 near-miss prompts`);
    }
  }
});

test('evals: skills, agents and fixtures the cases name exist', () => {
  const problems = [];
  for (const p of PLUGINS) {
    for (const c of cases(p)) {
      for (const tag of c.yaml.tags) {
        const m = tag.match(/^(skill|agent):(.+)$/);
        if (!m) continue;
        const file = m[1] === 'skill' ? path.join(p, 'skills', m[2], 'SKILL.md') : path.join(FACTORY, 'agents', `${m[2]}.md`);
        if (!fs.existsSync(file)) problems.push(`${c.file}: ${tag} does not exist`);
      }
    }
  }
  const outcomes = readJson(path.join(FACTORY, 'evals', 'sets', 'outcomes.json'));
  for (const c of outcomes.cases) if (!fs.existsSync(path.join(FACTORY, 'evals', 'fixtures', c.fixture, 'base'))) problems.push(`outcome ${c.id}: fixture ${c.fixture} missing`);
  // Tier 3 must cover the planted defects the benchmark asked for.
  const lanes = new Set(outcomes.cases.map((c) => c.agent));
  for (const a of ['security-reviewer', 'test-reviewer', 'ux-reviewer', 'code-reviewer', 'god-eye', 'interviewer']) if (!lanes.has(a)) problems.push(`no Tier 3 case for ${a}`);
  assert.deepEqual(problems, []);
});

test('evals: every fixture stages as base + change commits, with a planted injection in each review fixture', () => {
  const fixtures = path.join(FACTORY, 'evals', 'fixtures');
  for (const name of fs.readdirSync(fixtures).filter((f) => fs.statSync(path.join(fixtures, f)).isDirectory())) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fixture-${name}-`));
    const r = spawnSync('bash', [path.join(fixtures, 'stage.sh'), name], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    const log = spawnSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' }).stdout.trim().split('\n');
    const hasChange = fs.existsSync(path.join(fixtures, name, 'change'));
    assert.equal(log.length, hasChange ? 2 : 1, name);
    const text = spawnSync('git', ['show', 'HEAD', '--format='], { cwd: dir, encoding: 'utf8' }).stdout + (hasChange ? '' : fs.readdirSync(dir).join(' '));
    if (hasChange && name !== 'security-clean') assert.match(text, /reviewer|SYSTEM:/i, `${name}: no planted prompt injection in the change`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
