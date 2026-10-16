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
    // a variant named after one of the role's schemas uses it (interviewer.redirect, god-eye.readiness,
    // researcher.research); integrator.wave is integrate-wave; the rest use the role's first schema.
    const schema = variant && ROLE_OUTPUTS[role].includes(variant) ? variant : role === 'integrator' && variant === 'wave' ? 'integrate-wave' : ROLE_OUTPUTS[role][0];
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
      if (o.status === 'blocked' && (!o.blocked_reason || o.blocked_reason === 'needs_paths') && !(o.needs_paths || []).length) e.push('blocked without needs_paths');
      if (o.status === 'done' && !(o.commits || []).length) e.push('done without commits');
      if (o.status === 'done' && o.needs_paths && o.needs_paths.length) e.push('done but asks for paths');
      break;
    case 'tester':
      if (o.pass && o.failures.length) e.push('pass with failures');
      if (!o.pass && !o.failures.length) e.push('fail without failures');
      if (!o.evidence_id && !o.refused) e.push('no evidence_id');
      if (o.refused && o.pass) e.push('refused but pass');
      break;
    case 'integrator':
      if (o.status !== 'merged' && !o.summary.trim()) e.push(`${o.status} without a summary`);
      if (o.status === 'behavioural_conflict' && !(o.files || []).length) e.push('behavioural_conflict names no files');
      break;
    case 'integrate-wave':
      if (o.ok !== (o.kind === 'integrated')) e.push('ok exactly when kind is integrated');
      if (!o.ok && !String(o.message || '').trim() && !(o.failures || []).length) e.push('not ok, and says nothing about why');
      break;
    case 'planner':
      if (o.valid !== (o.errors.length === 0)) e.push('valid must be true exactly when errors is empty');
      if (!/(plan|slices)\.json$/.test(o.path)) e.push(`path ${o.path} is not plan.json or slices.json`);
      break;
    case 'critique':
      if (o.verdict === 'approve' && o.items.some((i) => SERIOUS.includes(i.severity))) e.push('approve with a blocker or major item');
      if (o.verdict === 'revise' && !o.items.some((i) => i.severity !== 'minor')) e.push('revise on minor items alone');
      break;
    case 'readiness':
      for (const x of o.objections) if (x.fixable_by === 'user' && (!x.question || (x.options || []).length < 2)) e.push(`a user blocker on ${x.check} without its question and options`);
      if ((o.verdict === 'ready') !== !o.objections.some((x) => x.severity === 'blocker')) e.push('ready exactly when no objection is a blocker');
      for (const [k, v] of Object.entries(o.checklist)) if (v === false && !o.objections.some((x) => x.check === k)) e.push(`${k} is false with no objection`);
      for (const x of o.objections) if (x.severity === 'blocker' && !x.fix.trim()) e.push(`a ${x.check} blocker with no fix`);
      break;
    case 'readback':
      for (const t of o.took) if (!t.quote.trim()) e.push(`took "${t.text}" with no quote`);
      for (const p of o.pins) if (p.source === 'repo' && !/^[\w./@-]+:\d+$/.test(p.file || '')) e.push(`repo pin ${p.system} without path:line`);
      for (const p of o.plan) if (p.tag === 'decision' && p.options && p.options.length === 1) e.push(`decision "${p.what}" with a single option`);
      break;
    case 'redirect':
      if (!o.clauses.length) e.push('a redirect with no clause');
      for (const c of o.clauses) if (c.action === 'research' && !c.tag) e.push(`research clause "${c.quote}" says neither docs nor repo`);
      break;
    case 'interpret':
      for (const a of o.answers) {
        if (!a.quote.trim()) e.push(`decision ${a.decision} mapped with no quote`);
        if (a.choice === 'other' && !a.text.trim()) e.push(`decision ${a.decision}: other with no words`);
      }
      break;
    case 'research':
      for (const x of o.evidence) {
        if (!x.quote.trim()) e.push(`finding "${x.claim}" with no quote`);
        if (o.mode === 'docs' && !/^https?:\/\//.test(x.source)) e.push(`docs finding "${x.claim}" not from a URL`);
        if (o.mode === 'repo' && !/^[\w./@-]+:\d+(-\d+)?$/.test(x.source)) e.push(`repo finding "${x.claim}" not at path:line`);
      }
      break;
    case 'brief':
      for (const r of o.records) if (r.recommendation !== null && !r.options.some((x) => x.key === r.recommendation)) e.push(`${r.plan}: the recommendation names no option`);
      break;
    case 'contract-write':
      if (!/^## Intent$/m.test(o.contract)) e.push('the contract has no Intent section');
      for (const c of o.covers) if (!/^((E-)?AC-\d+|[A-Z][\w -]+)$/.test(c.where)) e.push(`${c.item} covered at "${c.where}" (an AC id or a section)`);
      for (const r of o.removed || []) if (!String(r.because).trim()) e.push(`removed ${r.ref} without a reason`);
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
    case 'conformance':
      if (o.verdict === 'approve' && o.items.some((i) => SERIOUS.includes(i.severity))) e.push('approve with a blocker or major item');
      for (const i of o.items) if (SERIOUS.includes(i.severity) && !(i.evidence && i.evidence.ref && i.evidence.quote)) e.push(`${i.symbol}: a ${i.severity} item without evidence (ref and quote)`);
      for (const i of o.items) if (i.evidence && i.evidence.kind === 'source' && !/^\.factory\/deps\/[^:]+:\d+$/.test(i.evidence.ref)) e.push(`${i.symbol}: source evidence not at a .factory/deps path:line`);
      break;
    case 'diagnosis':
      if (!o.cause.trim()) e.push('a diagnosis with no cause');
      if (o.needs_user && (!o.question.trim() || o.options.length < 2)) e.push('needs_user without a question and at least two options');
      if (!o.needs_user && !o.approach.trim()) e.push('no approach and no question for the user');
      if (o.recommendation && !o.options.some((x) => x.key === o.recommendation)) e.push('the recommendation names no option');
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
    ['researcher', { topic: 't', claims: [{ claim: 'c', source: 'I think so' }], unknowns: [] }],
    ['contract-write', { contract: '# x\n\n## Goal\nno intent here', covers: [], uncovered: [], removed: [{ ref: 'AC-2', because: '' }] }],
    ['readiness', { verdict: 'ready', restatement: { problem: 'p', outcome: 'o' }, checklist: { intent_clear: false }, objections: [] }],
    ['brief', { summary: 's', records: [{ plan: 'P-1', decision: 'd', options: [{ key: 'a', text: 't', consequences: 'c' }], evidence: [], recommendation: 'b', why: 'w' }], facts: [], gaps: [] }],
    ['interpret', { answers: [{ decision: 1, choice: 'other', text: '', quote: '' }], facts: [], unclear: [] }],
    ['research', { mode: 'docs', evidence: [{ plan: 'P-1', claim: 'c', source: 'src/x.js:1', source_tier: 'official', quote: 'q', confidence: 'high' }], unresolved: [] }],
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
    // a role with several modes may list a field in more than one (god-eye's verdict): its first place counts
    const order = [...new Set(bullets.filter((b) => top.has(b)))];
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

// Clarify v3 through the real workflow, each agent answering with its golden (patched only where
// the golden names ids or files this job does not have: plan ids, item ids, the contract on disk).
// Stops at H1. Returns every screen it showed and the record results.
const { grab } = require('./helpers/clarify3-crew');
function clarifyAgents(root, J) {
  return (role, text) => {
    const inp = grab(text, 'CLARIFY INPUT (JSON):') || {};
    const planOf = (tag) => (inp.plan || []).find((p) => p.tag === tag) || {};
    switch (role) {
      case 'interviewer':
        assert.equal(inp.mode, 'readback');
        return golden('interviewer');
      case 'researcher':
        if (inp.mode === 'repo') {
          const g = golden('researcher', 'research');
          return { ...g, evidence: g.evidence.map((e) => ({ ...e, plan: planOf('repo').id })) };
        }
        return { mode: 'docs', web_available: true, versions: [], evidence: [], unresolved: inp.plan.map((p) => ({ plan: p.id, reason: 'a preference: no documentation decides it' })), failed_sources: [] };
      case 'brief-writer': {
        const g = golden('brief-writer');
        return { ...g, records: g.records.map((r) => ({ ...r, plan: planOf('decision').id })), facts: g.facts.map((f) => ({ ...f, plan: planOf('repo').id })) };
      }
      case 'contract-writer': {
        const g = golden('contract-writer');
        // the contract on disk (the rest of the job builds to it), with the golden's coverage map shape
        return { ...g, contract: fs.readFileSync(path.join(F.jobDir(root, J), 'contract.md'), 'utf8'), covers: inp.items.map((x) => ({ item: x.id, where: 'Goal', how: g.covers[0].how })) };
      }
      case 'god-eye':
        assert.match(text, /Focus: \*\*readiness/);
        return golden('god-eye', 'readiness');
      default:
        throw new Error(`unexpected clarify agent ${role}`);
    }
  };
}
async function clarifyToH1(root, J, { reply = () => 'ok' } = {}) {
  const screens = [];
  const records = [];
  for (let i = 0; i < 12; i++) {
    const n = F.cli(root, ['next']);
    if (!(n.action === 'skill' && n.skill === 'clarify')) return { next: n, screens, records };
    if (n.clarify.waiting_for_user) {
      screens.push(n.clarify);
      const r = F.cli(root, ['clarify', 'reply', reply(n.clarify)]);
      assert.ok(!r.error, JSON.stringify(r));
      continue;
    }
    const { record } = await runWorkflow(root, { workflow: 'clarify' }, clarifyAgents(root, J));
    records.push(record);
  }
  throw new Error('clarify did not reach H1');
}

test('golden replay: bug@low through the real workflows, with an unverifiable finding that keeps blocking', async () => {
  const root = F.makeRepo();
  const J = F.cli(root, ['job', 'new', '--title', 'Fix add', '--type', 'bug', '--risk', 'low', '--request', 'fix add: add(2, 3) should return 5']).job;
  fs.writeFileSync(path.join(F.jobDir(root, J), 'contract.md'), F.contractText());
  let verdict = 'unverifiable';
  const agents = (role, text, raw) => {
    switch (role) {
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
        if (/reconcile wave/.test(raw)) return F.relayWave(root, raw);
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
  const agentsWithPrompt = (role, text, prompt) => agents(role, role === 'finding-verifier' ? prompt : text, prompt);

  // clarify v3: the read-back's plan is researched; the sheet shows the brief writer's decision and
  // the repo fact; the user takes the recommendation; the writer and God Eye's readiness check pass
  const c = await clarifyToH1(root, J);
  // 0.9.0 (intentional): the read-back is shown on the sheet, not waited on
  assert.deepEqual(c.screens.map((x) => x.stage), ['sheet_wait']);
  assert.match(c.screens[0].screen, /Whether numeric strings are added or rejected/);
  assert.match(c.screens[0].screen, /a\) Reject them with a TypeError \*\*\(recommended\)\*\*/);
  assert.match(c.screens[0].screen, /add is implemented in src\/add\.js and subtracts \(src\/add\.js:1, E-1\)/, 'the repo finding, checked at its line, is a fact the sheet shows');
  const rec = JSON.parse(fs.readFileSync(path.join(F.jobDir(root, J), 'clarify.json'), 'utf8'));
  const dec = rec.items.find((x) => x.kind === 'decision');
  assert.deepEqual([dec.value, dec.strength], ['Reject them with a TypeError', 'accepted']);
  assert.equal(rec.evidence[0].verdict, 'repo');
  assert.equal(c.records[c.records.length - 1].status, 'ok');
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
  fs.writeFileSync(path.join(dir, 'contract.md'), F.contractText({ ac: '- AC-1: add(2, 3) returns 5 (evidence: test)\n- AC-2: sub(5, 3) returns 2 (evidence: test)', verify: '`node tests/add.test.js` (AC-1)\n- `node tests/sub.test.js` (AC-2)' }));
  const c = await clarifyToH1(root, J);
  assert.equal(c.next.step, 'H1', JSON.stringify(c.next).slice(0, 600));
  assert.equal(F.cli(root, ['next']).step, 'H1');
  F.reply(root, 'approve');
  // 0.10.0: the pinned dependency source is fetched first (a CLI step; nothing is pinned here)
  assert.equal(F.cli(root, ['next']).step, 'deps');
  F.cli(root, ['deps', 'fetch'], { allowFail: false });
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
      // after the critique's revise, the planner's answer to it (a rollback for each task)
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(critiques ? { tasks: plan.tasks.map((t) => ({ ...t, rollback: 'git revert the task commit' })) } : plan));
      const v = F.cli(root, ['plan', 'validate']);
      return golden('planner', null, { valid: v.valid, errors: v.errors, path: path.join(dir, 'plan.json') });
    }
    if (role === 'god-eye') {
      critiques += 1;
      return critiques === 1 ? golden('god-eye', 'plan') : { verdict: 'approve', items: [] };
    }
    throw new Error(`unexpected ${role}`);
  };
  // 0.10.0 (intentional): with the plan probe on, decompose runs in phases: the planner (factory
  // record then runs the CLI's probe), then God Eye's plan critique with the probe's record; its
  // revise sends the plan back to the planner, and the next critique approves
  let p = await runWorkflow(root, F.cli(root, ['next']), decompose);
  assert.equal(p.record.status, 'retry', JSON.stringify(p.record));
  // (review MAJ-2, intentional: the probe is the CLI's next step, not part of the record)
  assert.equal(p.record.probe_pending, true, 'the plan is valid; the CLI probes it next');
  assert.match(F.cli(root, ['next']).command, /factory plan probe/);
  for (let i = 0; i < 4 && p.record.status === 'retry'; i++) p = await runWorkflow(root, F.nextPast(root), decompose);
  assert.equal(p.record.status, 'ok', JSON.stringify(p.record));
  assert.equal(critiques, 2, 'a golden "revise" plan critique sends the plan back once');
  const n3 = F.cli(root, ['next']);
  assert.equal(n3.step, 'H3');
  assert.deepEqual(n3.review.approves, ['plan', 'environment'], 'at high risk H3 binds the plan and the build environment');
  assert.equal(n3.review.probe.ok, true);
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
