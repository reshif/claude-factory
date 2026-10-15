'use strict';
// Tier 1 contract tests: no model calls. Each JSON-returning agent has golden outputs in
// tests/fixtures/golden/ (<role>.json is the example in its agents/<role>.md, byte for byte as
// JSON; <role>.<variant>.json are more shapes). They must
//   1. match their schema strictly (no field the schema lacks),
//   2. agree with the role's "Your final message" recipe (every schema field named, in order,
//      and no field the schema doesn't have),
//   3. hold the role's semantic invariants (checked in code below), and
//   4. replay through the real workflow scripts and `factory record` (the workflow harness),
//      so what an agent is told to return is what the CLI accepts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const F = require('./helpers/fixture');
const H = require('./helpers/workflow-harness');
const { validate } = require('../cli/lib/schema');
const { ROLE_OUTPUTS } = require('../cli/core/wfargs');

const PLUGIN = path.resolve(__dirname, '..');
const GOLDEN = path.join(__dirname, 'fixtures', 'golden');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const schemaOf = (name) => readJson(path.join(PLUGIN, 'schemas', 'agent-outputs', `${name}.json`));
const ROLES = Object.keys(ROLE_OUTPUTS);

// Every golden file: { role, variant, schema name, value }.
function goldens() {
  return fs.readdirSync(GOLDEN).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const [role, variant = null] = f.replace(/\.json$/, '').split('.');
    assert.ok(ROLE_OUTPUTS[role], `${f}: names a known role`);
    // god-eye: the base example and "intent-*" variants are intent critiques; design/plan are plain critiques.
    const schema = role === 'god-eye' && variant && !variant.startsWith('intent') ? 'critique' : ROLE_OUTPUTS[role][0];
    assert.ok(ROLE_OUTPUTS[role].includes(schema));
    return { file: f, role, variant, schema, value: readJson(path.join(GOLDEN, f)) };
  });
}
function golden(role, variant, patch = {}) {
  return { ...readJson(path.join(GOLDEN, `${role}${variant ? `.${variant}` : ''}.json`)), ...patch };
}

// Strict where safe: every object schema that lists properties forbids others. Tests only;
// the production schemas stay lenient so an extra field never costs a real run a retry.
function strict(s) {
  if (Array.isArray(s)) return s.map(strict);
  if (!s || typeof s !== 'object') return s;
  const out = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, strict(v)]));
  if (out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

function finalMessage(role) {
  const text = fs.readFileSync(path.join(PLUGIN, 'agents', `${role}.md`), 'utf8');
  const sec = text.split('\n## Your final message\n')[1];
  assert.ok(sec, `agents/${role}.md has a "## Your final message" section`);
  const m = /```json\n([\s\S]*?)\n```/.exec(sec);
  assert.ok(m, `agents/${role}.md: its final message section has a json example`);
  return { sec, prose: sec.slice(0, m.index), example: JSON.parse(m[1]) };
}

// All property names (any depth) and enum values of a schema.
function vocabulary(s, props = new Set(), enums = new Set()) {
  if (Array.isArray(s)) s.forEach((x) => vocabulary(x, props, enums));
  else if (s && typeof s === 'object') {
    for (const [k, v] of Object.entries(s.properties || {})) {
      props.add(k);
      vocabulary(v, props, enums);
    }
    for (const e of s.enum || []) enums.add(String(e));
    if (s.items) vocabulary(s.items, props, enums);
  }
  return { props, enums };
}

// ---- semantic invariants, per schema (the CLI and the workflows rely on these) ----
const SERIOUS = ['blocker', 'major'];
const SOURCE = /^(UNVERIFIED|https?:\/\/\S+|[\w./@-]+:\d+(-\d+)?|.+ → .+)$/;
function invariants(schema, o, { role } = {}) {
  const e = [];
  const uniq = (xs, what) => { if (new Set(xs).size !== xs.length) e.push(`${what} are not unique`); };
  switch (schema) {
    case 'reviewer': {
      if (!o.lane) e.push('lane is empty');
      uniq(o.findings.map((f) => f.id), 'finding ids');
      for (const f of o.findings) {
        if (!f.id.startsWith(`${o.lane}-`)) e.push(`${f.id} does not start with "${o.lane}-"`);
        if (SERIOUS.includes(f.severity) && !f.file) e.push(`${f.id}: a ${f.severity} finding points to no file (evidence rule)`);
        if (!f.summary.trim()) e.push(`${f.id}: empty summary`);
      }
      if (role === 'epic-reviewer' && o.lane !== 'conformance') e.push('the epic reviewer is the conformance lane');
      break;
    }
    case 'verifier':
      if (!o.finding_id) e.push('finding_id is empty');
      if (!o.evidence.length) e.push('a verdict without evidence');
      if (!o.reason.trim()) e.push('reason is empty');
      break;
    case 'builder':
      if (o.status === 'blocked' && !(o.needs_paths || []).length) e.push('blocked without needs_paths');
      if (o.status === 'done' && !(o.commits || []).length) e.push('done without commits');
      if (o.status === 'done' && o.needs_paths && o.needs_paths.length) e.push('done but asks for paths');
      break;
    case 'tester':
      if (o.pass && o.failures.length) e.push('pass with failures');
      if (!o.pass && !o.failures.length) e.push('fail without failures');
      if (!o.evidence_id) e.push('no evidence_id');
      break;
    case 'integrator':
      if (o.status !== 'merged' && !o.summary.trim()) e.push(`${o.status} without a summary`);
      if (o.status === 'behavioural_conflict' && !(o.files || []).length) e.push('behavioural_conflict names no files');
      break;
    case 'planner':
      if (o.valid !== (o.errors.length === 0)) e.push('valid must be true exactly when errors is empty');
      if (!/(plan|slices)\.json$/.test(o.path)) e.push(`path ${o.path} is not plan.json or slices.json`);
      break;
    case 'critique':
    case 'intent-critique':
      if (o.verdict === 'approve' && o.items.some((i) => SERIOUS.includes(i.severity))) e.push('approve with a blocker or major item');
      if (o.verdict === 'revise' && !o.items.some((i) => i.severity !== 'minor')) e.push('revise on minor items alone');
      if (schema === 'intent-critique' && o.intent_confirmed === false && o.verdict === 'approve') e.push('approve with intent not confirmed');
      break;
    case 'analyst':
      for (const q of o.questions) {
        if (q.options && (q.options.length < 2 || q.options.length > 4)) e.push(`"${q.question}": options must be 2-4`);
        if (q.question.includes('\n')) e.push('a question spans lines');
      }
      if (o.focus === 'intent' && !o.restatement) e.push('the intent gate gives no restatement');
      if (o.focus !== 'intent' && o.questions.some((q) => q.category === 'intent')) e.push('an intent question outside the intent focus');
      break;
    case 'judge':
      if (o.questions.length > 5) e.push('more questions than any budget');
      if (o.questions.some((q) => q.category === 'intent') && o.questions.some((q) => q.category !== 'intent')) e.push('intent questions mixed with others (the rest must be held)');
      if (o.held && o.held.length && !o.questions.some((q) => q.category === 'intent')) e.push('held questions with no intent question open');
      for (const d of o.dismissed) if (!d.reason.trim()) e.push(`dismissed "${d.question}" without a reason`);
      break;
    case 'contract-edit':
      if (!/^## Intent$/m.test(o.contract)) e.push('the revised contract has no Intent section');
      for (const a of o.applied) if (!a.ref.trim() || !a.change.trim()) e.push('an applied change without its ref or what changed');
      for (const s of o.skipped) if (!s.reason.trim()) e.push(`skipped ${s.ref} without a reason`);
      for (const r of o.removed || []) if (!r.because.trim()) e.push(`removed ${r.ref} without a reason`);
      break;
    case 'researcher':
      for (const c of o.claims) if (!SOURCE.test(c.source)) e.push(`claim "${c.claim}" has source "${c.source}" (file:line, "command → output", URL or UNVERIFIED)`);
      break;
    case 'architect':
      if (o.kind === 'adr' && !o.paths.some((p) => /adr-\d+/.test(p))) e.push('kind adr but no adr-NNN file');
      for (const r of o.rejected || []) if (!r.reason.trim()) e.push(`rejected ${r.option} without a reason`);
      break;
    case 'threat':
      uniq(o.threats.map((t) => t.id).filter(Boolean), 'threat ids');
      if (!/threat-model\.md$/.test(o.path)) e.push('path is not threat-model.md');
      break;
    case 'option':
      if (!o.pros.length || !o.cons.length) e.push('an option needs real pros and cons');
      for (const c of o.criteria || []) if (!/^(E-)?AC-\d+$/.test(c.id)) e.push(`criterion id ${c.id}`);
      break;
    case 'lesson':
      uniq(o.lessons.map((l) => l.id), 'lesson ids');
      if (o.nothing_to_learn !== (o.lessons.length === 0)) e.push('nothing_to_learn must be true exactly when no lessons are listed');
      break;
    default:
      e.push(`no invariants for schema ${schema}`);
  }
  return e;
}

test('every JSON agent has a golden example, and its body shows exactly that example', () => {
  const agents = fs.readdirSync(path.join(PLUGIN, 'agents')).map((f) => f.replace(/\.md$/, '')).sort();
  assert.deepEqual([...ROLES].sort(), agents, 'ROLE_OUTPUTS covers every agent file');
  for (const role of ROLES) {
    for (const s of ROLE_OUTPUTS[role]) assert.ok(fs.existsSync(path.join(PLUGIN, 'schemas', 'agent-outputs', `${s}.json`)), `${role}: schema ${s} exists`);
    assert.deepEqual(finalMessage(role).example, golden(role), `agents/${role}.md example equals tests/fixtures/golden/${role}.json`);
  }
  const used = new Set(Object.values(ROLE_OUTPUTS).flat());
  for (const f of fs.readdirSync(path.join(PLUGIN, 'schemas', 'agent-outputs'))) assert.ok(used.has(f.replace(/\.json$/, '')), `schema ${f} is some role's output`);
});

test('golden outputs match their schemas strictly and hold their semantic invariants', () => {
  const all = goldens();
  assert.ok(all.length >= ROLES.length);
  for (const g of all) {
    assert.deepEqual(validate(strict(schemaOf(g.schema)), g.value), [], `${g.file} vs ${g.schema} (strict)`);
    assert.deepEqual(invariants(g.schema, g.value, { role: g.role }), [], `${g.file}: invariants`);
  }
  // the invariants bite
  const bad = [
    ['tester', { pass: true, evidence_id: 'x', failures: ['boom'] }],
    ['reviewer', { lane: 'code', findings: [{ id: 'tests-1', severity: 'major', file: null, line: null, summary: 's', rule: null }] }],
    ['verifier', { finding_id: 'code-1', status: 'confirmed', evidence: [], reason: 'r' }],
    ['planner', { valid: true, errors: ['x'], path: 'plan.json' }],
    ['critique', { verdict: 'approve', items: [{ issue: 'i', severity: 'blocker' }] }],
    ['builder', { status: 'blocked', summary: 's' }],
    ['lesson', { lessons: [], nothing_to_learn: false }],
    ['judge', { questions: [{ question: 'a', category: 'intent', why: 'w', default: 'd' }, { question: 'b', category: 'scope', why: 'w', default: 'd' }], dismissed: [] }],
    ['researcher', { topic: 't', claims: [{ claim: 'c', source: 'I think so' }], unknowns: [] }],
    ['contract-edit', { contract: '# x\n\n## Goal\nno intent here', applied: [], skipped: [], removed: [{ ref: 'AC-2', because: '' }] }],
  ];
  for (const [schema, value] of bad) assert.ok(invariants(schema, value).length > 0, `${schema} invariant rejects ${JSON.stringify(value)}`);
  // strict mode catches a field the schema lacks (the option-generator drift the audit found)
  assert.ok(validate(strict(schemaOf('option')), { ...golden('option-generator'), files_touched: [] }).length > 0);
});

test('each "Your final message" recipe names every schema field, in order, and no field the schema lacks', () => {
  for (const role of ROLES) {
    const { prose, example } = finalMessage(role);
    const vocab = { props: new Set(), enums: new Set() };
    for (const s of ROLE_OUTPUTS[role]) vocabulary(schemaOf(s), vocab.props, vocab.enums);
    const ticked = [...prose.matchAll(/`([a-z][a-z_]*)`/g)].map((m) => m[1]);
    for (const p of vocab.props) assert.ok(ticked.includes(p), `${role}: recipe names \`${p}\``);
    for (const t of ticked) assert.ok(vocab.props.has(t) || vocab.enums.has(t), `${role}: recipe names \`${t}\`, which no schema of this role has`);
    // top-level bullets, in order, match the example's key order
    // a bullet may name several fields before its colon ("- `pros`, `cons`, `risks`: …")
    const bullets = [...prose.matchAll(/^- (`[^:\n]*?)(?: \(|:)/gm)].flatMap((m) => [...m[1].matchAll(/`([a-z_]+)`/g)].map((x) => x[1]));
    const top = new Set(ROLE_OUTPUTS[role].flatMap((s) => Object.keys(schemaOf(s).properties)));
    const order = bullets.filter((b) => top.has(b));
    for (const p of top) assert.ok(order.includes(p), `${role}: \`${p}\` has its own bullet`);
    const keys = Object.keys(example);
    assert.deepEqual(keys, order.filter((k) => keys.includes(k)), `${role}: example keys follow the recipe's order`);
    // the required fields of every schema the role uses are described
    for (const s of ROLE_OUTPUTS[role]) for (const r of schemaOf(s).required || []) assert.ok(order.includes(r), `${role}: required ${s}.${r} is in the recipe`);
  }
});

// ---- replay through the workflow scripts and factory record ----
const instructions = (prompt) => {
  const line = prompt.split('\n').find((l) => l.trim().startsWith('/'));
  return line ? fs.readFileSync(line.trim(), 'utf8') : prompt;
};
async function runWorkflow(root, next, agents, extra = []) {
  const args = ['wfargs', next.workflow];
  if (next.config) args.push('--config', next.config);
  if (next.mode) args.push('--mode', next.mode);
  if (next.scope) args.push('--scope', next.scope);
  const brief = F.cli(root, [...args, ...extra], { allowFail: false });
  const { result, calls } = await H.run(path.join(PLUGIN, 'workflows', `${next.workflow}.js`), JSON.stringify(brief), (prompt, opts) => {
    const role = opts.agentType.replace(/^factory:/, '');
    const out = agents(role, instructions(prompt), prompt);
    // what the scripted agent returns is checked like the runtime would: against the schema it was given
    if (out) assert.deepEqual(validate(opts.schema, out), [], `${role} replay output matches the schema it was given`);
    return out;
  });
  for (const c of calls) {
    const role = c.opts.agentType.replace(/^factory:/, '');
    const text = instructions(c.prompt);
    assert.match(text, /## Your tools/, `${role} brief has a tools section`);
    assert.ok(!/## Working with files/.test(text));
  }
  return { record: F.record(root, result), result, calls };
}

test('golden replay: bug@low through the real workflows, with an unverifiable finding that keeps blocking', async () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let verdict = 'unverifiable';
  let clarifyRound = 0;
  const agents = (role, text) => {
    switch (role) {
      case 'intent-analyst':
        return /Your focus: \*\*intent\*\*/.test(text) ? golden('intent-analyst', 'intent') : { ...golden('intent-analyst'), focus: (/Your focus: \*\*(\w+)\*\*/.exec(text) || [])[1], questions: [] };
      case 'judge':
        return clarifyRound === 1 ? golden('judge') : golden('judge', 'none');
      case 'god-eye':
        return golden('god-eye', 'intent-approve');
      case 'contract-editor': {
        // clarify v2: the editor applies the user's answer (round 2) to the contract it was given, as its golden shows
        const cur = fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8');
        const g = golden('contract-editor');
        return { ...g, contract: cur.replace('## Non-goals\n', '## Non-goals\n- Numeric strings are not converted\n') };
      }
      case 'researcher':
        return golden('researcher', null, { topic: (/Topic: \*\*([\w ]+)\*\*/.exec(text) || [])[1] });
      case 'builder': {
        const s = F.cli(root, ['task', 'start', 'T1'], { allowFail: false });
        F.write(s.worktree, 'src/add.js', 'module.exports = (a, b) => a + b;\n');
        F.sh(s.worktree, 'git commit -qam fix');
        return golden('builder', null, { commits: [F.sh(s.worktree, 'git log -1 --format=%h')], swept: ['src/add.js'] });
      }
      case 'tester': {
        const v = F.cli(root, ['task', 'verify', 'T1']);
        assert.equal(v.pass, true);
        return golden('tester', 'pass', { evidence_id: v.evidence_id });
      }
      case 'integrator': {
        const r = F.cli(root, ['reconcile', 'run']);
        return r.status === 'merged' ? golden('integrator', null, { files: [] }) : golden('integrator', 'failed', { summary: r.message || r.status });
      }
      case 'code-reviewer':
      case 'test-reviewer':
      case 'security-reviewer':
      case 'ux-reviewer': {
        // the golden finding, pointed at a file that exists in the fixture
        const g = golden(role);
        const f = g.findings[0];
        assert.ok(fs.existsSync(path.join(root, 'src/add.js')));
        return { ...g, findings: [{ ...f, file: 'src/add.js', line: 1 }] };
      }
      case 'finding-verifier': {
        const id = (/"id": "([a-z]+-\d+)"/.exec(text + '') || [])[1];
        return golden('finding-verifier', verdict, { finding_id: id });
      }
      default:
        throw new Error(`unexpected agent ${role}`);
    }
  };
  // finding-verifier gets the finding after its pointer, not in its instruction file
  const agentsWithPrompt = (role, text, prompt) => agents(role, role === 'finding-verifier' ? prompt : text);

  for (clarifyRound = 1; clarifyRound <= 2; clarifyRound++) {
    const { record } = await runWorkflow(root, { workflow: 'fanout-judge', config: 'clarify' }, agentsWithPrompt);
    if (clarifyRound === 1) {
      assert.equal(record.status, 'needs_user', JSON.stringify(record));
      assert.equal(record.questions[0].question, golden('judge').questions[0].question, "the judge's golden question reaches the user");
      F.cli(root, ['answer', '--id', record.questions[0].id, '--answer', 'Numbers only'], { allowFail: false });
    } else assert.equal(record.status, 'ok', JSON.stringify(record));
  }
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');

  let n;
  for (let guard = 0; guard < 20; guard++) {
    n = F.cli(root, ['next']);
    if (n.action === 'workflow' && n.config === 'challenge') break;
    if (n.action === 'workflow') {
      const { record } = await runWorkflow(root, n, agentsWithPrompt);
      assert.equal(record.status, 'ok', `${n.workflow}: ${JSON.stringify(record)}`);
    } else if (n.action === 'cli') {
      const out = F.cli(root, n.command.replace(/^factory /, '').split(' ').filter((x) => x && x !== '--job' && !/^J-\d+$/.test(x)));
      assert.ok(!out.error, `${n.command}: ${JSON.stringify(out)}`);
    } else assert.fail(`unexpected ${JSON.stringify(n)}`);
  }
  assert.equal(n.config, 'challenge');

  // all four review lanes, each returning its golden serious finding; the verifier can't settle any
  const lanes = ['--lanes', 'code,tests,security,ux'];
  let run = await runWorkflow(root, n, agentsWithPrompt, lanes);
  assert.equal(run.calls.filter((c) => c.opts.agentType === 'factory:finding-verifier').length, 4, 'every serious finding is verified');
  assert.equal(run.record.status, 'retry', JSON.stringify(run.record));
  assert.deepEqual(run.record.unverified.sort(), ['code-1', 'security-1', 'tests-1', 'ux-1'], '"unverifiable" keeps the finding unverified');
  assert.equal(run.record.ok, false, 'an unverifiable finding blocks its lane');
  assert.match(run.result.summary, /4 unverifiable \(still blocking\)/);
  const ch = fs.readFileSync(path.join(F.jobDir(root, J), 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((e) => e.step === 'challenge').pop();
  const code1 = ch.detail.findings.find((f) => f.id === 'code-1');
  assert.equal(code1.verifier, 'unverifiable');
  assert.deepEqual(code1.evidence, golden('finding-verifier', 'unverifiable').evidence, "the verifier's evidence is kept with the finding");

  // the next round's verifier refutes them all: every lane passes
  verdict = 'refuted';
  n = F.cli(root, ['next']);
  assert.equal(n.config, 'challenge');
  run = await runWorkflow(root, n, agentsWithPrompt, lanes);
  assert.equal(run.record.status, 'ok', JSON.stringify(run.record));
  assert.equal(F.cli(root, ['next']).skill, 'ship');
});

test('golden replay: full@high decide and decompose (options, threat model, architect, God Eye design and plan, planner)', async () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Auth math', '--type', 'feature', '--risk', 'high']).job;
  const dir = F.jobDir(root, J);
  fs.writeFileSync(path.join(dir, 'contract.md'), F.contractText({ ac: '- AC-1: add(2, 3) returns 5 (evidence: test)\n- AC-2: sub(5, 3) returns 2 (evidence: test)' }));
  const clarify = (role, text) => (role === 'intent-analyst' ? golden('intent-analyst', 'intent') : role === 'judge' ? golden('judge', 'none') : golden('god-eye', 'intent-approve'));
  assert.equal((await runWorkflow(root, { workflow: 'fanout-judge', config: 'clarify' }, clarify)).record.status, 'ok');
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');
  assert.equal((await runWorkflow(root, { workflow: 'ground' }, (role, text) => golden('researcher', null, { topic: (/Topic: \*\*([\w ]+)\*\*/.exec(text) || [])[1] }))).record.status, 'ok');

  const n = F.cli(root, ['next']);
  assert.equal(n.config, 'decide');
  const seen = {};
  const decide = (role, text) => {
    seen[role] = (seen[role] || 0) + 1;
    if (role === 'option-generator') {
      assert.ok(!/Write|Edit|Bash/.test(text.split('## Your tools')[1].split('## Your output')[0]), 'option-generator is told about no tool it lacks');
      return golden('option-generator', null, { criteria: [{ id: 'AC-1', how: 'a test' }, { id: 'AC-2', how: 'a test' }] });
    }
    if (role === 'threat-modeler') {
      fs.writeFileSync(path.join(dir, 'threat-model.md'), F.threatModelText({ job: J }));
      return golden('threat-modeler', null, { path: path.join(dir, 'threat-model.md') });
    }
    if (role === 'architect') {
      fs.writeFileSync(path.join(dir, 'adr-001-math.md'), F.adrText({ job: J, acs: ['AC-1', 'AC-2'], threats: ['TH-1'] }));
      assert.equal(F.cli(root, ['doc', 'check', path.join(dir, 'adr-001-math.md')]).ok, true);
      return golden('architect', null, { paths: [path.join(dir, 'adr-001-math.md')] });
    }
    if (role === 'god-eye') {
      assert.match(text, /Focus: \*\*design\*\*/);
      return golden('god-eye', 'design');
    }
    throw new Error(`unexpected ${role}`);
  };
  const d = await runWorkflow(root, n, decide);
  assert.equal(d.record.status, 'ok', JSON.stringify(d.record));
  assert.deepEqual(seen, { 'option-generator': 3, 'threat-modeler': 1, architect: 1, 'god-eye': 1 });
  assert.equal(F.cli(root, ['next']).step, 'H2');
  F.reply(root, 'approve');

  const plan = { tasks: [
    { id: 'T1', objective: 'Fix add (ADR 001)', allowed_paths: ['src/add.js', 'tests/add.test.js'], depends_on: [], criteria_ids: ['AC-1'], verify_commands: [{ cmd: 'node tests/add.test.js', covers: ['AC-1'] }] },
    { id: 'T2', objective: 'Add sub (ADR 001)', allowed_paths: ['src/sub.js', 'tests/sub.test.js'], depends_on: [], criteria_ids: ['AC-2'], verify_commands: [{ cmd: 'node tests/sub.test.js', covers: ['AC-2'] }] },
  ] };
  let critiques = 0;
  const decompose = (role, text) => {
    if (role === 'planner') {
      assert.match(text, /Validate command: `[^`]*plan validate/);
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan));
      const v = F.cli(root, ['plan', 'validate']);
      return golden('planner', null, { valid: v.valid, errors: v.errors, path: path.join(dir, 'plan.json') });
    }
    if (role === 'god-eye') {
      critiques += 1;
      return critiques === 1 ? golden('god-eye', 'plan') : { verdict: 'approve', items: [] };
    }
    throw new Error(`unexpected ${role}`);
  };
  const p = await runWorkflow(root, F.cli(root, ['next']), decompose, ['--plan-critique']);
  assert.equal(p.record.status, 'ok', JSON.stringify(p.record));
  assert.equal(critiques, 2, 'a golden "revise" plan critique sends the plan back once');
  assert.equal(F.cli(root, ['next']).step, 'H3');
});

test('lesson writer: distill context hands over the reply schema; distill done --result checks the golden reply', () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low']).job;
  const ctx = F.cli(root, ['distill', 'context'], { allowFail: false });
  assert.equal(ctx.lesson_writer.agent_type, 'factory:lesson-writer');
  assert.deepEqual(ctx.lesson_writer.reply_schema, schemaOf('lesson'));
  assert.match(ctx.lesson_writer.record_command, /factory lessons add --job J-\d+ --text/);
  const g = golden('lesson-writer');
  const added = F.cli(root, ['lessons', 'add', '--job', J, '--text', g.lessons[0].text, '--scope', g.lessons[0].scope.join(','), '--why', g.lessons[0].why], { allowFail: false });
  const reply = { ...g, lessons: [{ ...g.lessons[0], id: added.id }] };
  // an id the job never recorded is refused
  const bad = F.cli(root, ['distill', 'done', '--result', JSON.stringify({ ...reply, lessons: [{ ...reply.lessons[0], id: 'L99' }] })]);
  assert.notEqual(bad.__code, 0);
  assert.match(JSON.stringify(bad), /L99/);
  // a reply that breaks the schema is refused
  assert.notEqual(F.cli(root, ['distill', 'done', '--result', '{"lessons":[]}']).__code, 0);
  const f = path.join(root, '.factory', 'scratch', 'lesson-reply.json');
  fs.writeFileSync(f, JSON.stringify(reply));
  const ok = F.cli(root, ['distill', 'done', '--result', f], { allowFail: false });
  assert.deepEqual(ok.lessons, [added.id]);
  // without --result, distill done works as before (the distill skill's current call)
  assert.equal(F.cli(root, ['distill', 'done'], { allowFail: false }).ok, true);
  const nothing = F.cli(root, ['distill', 'done', '--result', JSON.stringify(golden('lesson-writer', 'nothing'))], { allowFail: false });
  assert.equal(nothing.nothing_to_learn, true);
});
