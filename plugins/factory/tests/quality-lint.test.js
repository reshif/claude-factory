'use strict';
// Tier 0 quality lints: static checks across skills, agents, schemas, the CLI help and the
// docs, run on every PR at no model cost. Each check targets a weakness the quality
// benchmark found at a seam between two artifacts written by different hands:
//   - skill descriptions are triggers (what + when, no step sequence, a length budget,
//     a "Not for…" scope on user-invocable skills);
//   - every `factory …` / `factory-inspect …` command a skill names exists in that CLI's HELP;
//   - every `factory:<name>` and ${CLAUDE_SKILL_DIR}/${CLAUDE_PLUGIN_ROOT} path a skill names exists;
//   - every required property of an agent's output schema is named in its final-message section;
//   - hard-coded counts ("19 agents", "R10–R19") that drift are flagged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FACTORY = path.resolve(__dirname, '..');
const PLUGINS = path.resolve(FACTORY, '..');
const REPO = path.resolve(PLUGINS, '..');
const INSPECTOR = path.join(PLUGINS, 'factory-inspector');

const read = (p) => fs.readFileSync(p, 'utf8');
const exists = (p) => fs.existsSync(p);
const rel = (p) => path.relative(REPO, p);

// ---------- skills ----------

// A deliberately small frontmatter reader: `key: value` lines, values optionally quoted.
// It also reports what YAML would reject (an unquoted value containing ": ").
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const fm = {};
  const problems = [];
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^".*"$/.test(v)) v = JSON.parse(v);
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
    else if (/: /.test(v) || / #/.test(v)) problems.push(`${kv[1]}: unquoted value contains ": " or " #" (invalid YAML)`);
    fm[kv[1]] = v;
  }
  return { fm, body: text.slice(m[0].length), problems };
}

function skillFiles() {
  const out = [];
  for (const plugin of [FACTORY, INSPECTOR]) {
    const dir = path.join(plugin, 'skills');
    if (!exists(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name, 'SKILL.md');
      if (exists(file)) out.push({ plugin, pluginName: path.basename(plugin), name, file, dir: path.join(dir, name) });
    }
  }
  return out;
}

const SKILLS = skillFiles();
const HARD_LIMIT = 1024; // agentskills.io / Claude Code limit
const BUDGET = 350; // our own budget: triggers, not catalogues
const BUDGET_BY_SKILL = { console: 260, inspect: 260 }; // the two that used to be UI/rule catalogues

// Base-form verbs that, three or more times as clause heads, mean the description narrates a
// step sequence instead of stating triggers (agents then follow the description and skip the body).
const STEP_VERBS = new Set('read run write draft check ask create classify propose decide confirm restate commit push open prepare wait loop turn present explain show audit walk record build merge verify review summarise summarize approve deny fix'.split(' '));
function isStepVerb(word) {
  const w = word.toLowerCase();
  return STEP_VERBS.has(w) || (w.endsWith('es') && STEP_VERBS.has(w.slice(0, -2))) || (w.endsWith('s') && STEP_VERBS.has(w.slice(0, -1)));
}
function stepClauses(desc) {
  return desc
    .replace(/\([^)]*\)/g, '')
    .split(/[,;—–→]|\bthen\b/i)
    .map((c) => c.trim().replace(/^(and|or|then)\s+/i, ''))
    .filter((c) => isStepVerb(c.split(/\s+/)[0] || ''));
}

test('skills: every skill has a name matching its folder and a description', () => {
  assert.ok(SKILLS.length > 0, 'no skills found');
  for (const s of SKILLS) {
    const f = frontmatter(read(s.file));
    assert.ok(f, `${rel(s.file)}: no frontmatter`);
    assert.deepEqual(f.problems, [], rel(s.file));
    assert.equal(f.fm.name, s.name, `${rel(s.file)}: name must match the folder`);
    assert.ok(f.fm.description, `${rel(s.file)}: no description`);
  }
});

test('skills: descriptions are triggers — what + when, within budget, no step sequence', () => {
  const problems = [];
  for (const s of SKILLS) {
    const { fm } = frontmatter(read(s.file));
    const d = fm.description;
    const where = `${s.pluginName}:${s.name}`;
    const budget = BUDGET_BY_SKILL[s.name] || BUDGET;
    if (d.length > HARD_LIMIT) problems.push(`${where}: ${d.length} chars, over the ${HARD_LIMIT} hard limit`);
    if (d.length > budget) problems.push(`${where}: ${d.length} chars, over its ${budget}-char budget (move detail into the body)`);
    if (!/\bUsed? (when|by|for)\b/.test(d)) problems.push(`${where}: no trigger clause ("Use when …" / "Used by … when …")`);
    if (/\b(I|you|your)\b/.test(d)) problems.push(`${where}: written in first or second person`);
    const capability = d.split(/\bUsed? (?:when|by|for)\b|\bNot for\b/)[0]; // the "what" part, before any trigger
    const steps = stepClauses(capability);
    if (steps.length >= 3) problems.push(`${where}: narrates a step sequence (${steps.map((c) => c.split(/\s+/)[0]).join(' → ')}); state triggers instead`);
    const userInvocable = fm['user-invocable'] !== 'false';
    if (userInvocable && !/\bNot for\b/.test(d)) problems.push(`${where}: user-invocable skills need a "Not for …" clause naming the nearest near-miss`);
  }
  assert.deepEqual(problems, []);
});

test('skills: the step-sequence lint catches the descriptions it was written for', () => {
  // Regression guard for the heuristic itself, using the pre-benchmark wording.
  const old = {
    clarify: 'Factory clarify — draft the outcome contract intent first, run the clarify fan-out (intent gate, then three analysts, a judge, then God Eye), ask the user only what the repo can\'t answer, in a fixed order and budget, and loop until God Eye approves.',
    intake: 'Factory intake — read the repo, restate the intent in one line, classify the work type, propose a risk level, decide job vs epic, confirm all of it with the user in one question, and create the job.',
    ship: 'Factory ship — check pre-ship floors, write the completion report, commit the ship manifest, push and open the PR (or prepare a local merge), then wait for the human merge.',
  };
  for (const [k, d] of Object.entries(old)) assert.ok(stepClauses(d).length >= 3, k);
  assert.ok(stepClauses('Reads the repo, writes the contract, then asks the user.').length >= 3, 'third-person verbs count too');
  assert.ok(stepClauses('Explains why a factory job is parked and which replies move it on.').length < 3);
});

// ---------- CLI commands named in skills ----------

function helpText(file) {
  const src = read(file);
  const m = src.match(/const HELP = `([\s\S]*?)`;/);
  assert.ok(m, `${rel(file)}: HELP template not found`);
  return m[1];
}

// HELP → { cmd: { subs:Set, flags:Set } }. Segments are separated by " · " and newlines; a
// segment's first word is the command, a bare lowercase second word (or a|b|c list) its sub.
function parseHelp(text) {
  const cmds = {};
  const flags = new Set((text.match(/--[a-z][\w-]*/g) || []));
  for (const rawLine of text.split('\n').slice(1)) {
    const line = rawLine.replace(/^[A-Z][a-z]+(?: only)?\s{2,}/, '').trim();
    for (const seg of line.split(' · ')) {
      const toks = seg.trim().split(/\s+/);
      const cmd = toks[0];
      if (!/^[a-z][\w-]*$/.test(cmd)) continue;
      const c = (cmds[cmd] = cmds[cmd] || { subs: new Set() });
      const sub = toks[1] || '';
      const alts = sub.match(/^<([a-z][\w|-]*)>$/) ? sub.slice(1, -1) : sub;
      if (/^[a-z][\w-]*(\|[a-z][\w-]*)*$/.test(alts)) for (const a of alts.split('|')) c.subs.add(a);
    }
  }
  return { cmds, flags };
}

function commandsIn(text, bin) {
  const re = new RegExp('`' + bin.replace('-', '\\-') + ' ([^`]+)`', 'g');
  const out = [];
  let m;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function checkCommands(skills, bin, help) {
  const { cmds, flags } = parseHelp(help);
  const problems = [];
  for (const s of skills) {
    for (const c of commandsIn(read(s.file), bin)) {
      const toks = c.split(/\s+/);
      const [cmd, sub] = toks;
      const entry = cmds[cmd];
      if (!entry) {
        problems.push(`${s.name}: \`${bin} ${c}\` — "${cmd}" is not in ${bin} HELP`);
        continue;
      }
      if (sub && /^[a-z][\w-]*$/.test(sub) && entry.subs.size && !entry.subs.has(sub)) problems.push(`${s.name}: \`${bin} ${c}\` — "${cmd} ${sub}" is not in ${bin} HELP (${[...entry.subs].join('|')})`);
      for (const f of c.match(/--[a-z][\w-]*/g) || []) if (!flags.has(f)) problems.push(`${s.name}: \`${bin} ${c}\` — flag ${f} is not in ${bin} HELP`);
    }
  }
  return problems;
}

test('skills: every `factory …` command a skill names exists in the factory CLI HELP', () => {
  const help = helpText(path.join(FACTORY, 'cli', 'main.js'));
  const skills = SKILLS.filter((s) => s.plugin === FACTORY);
  assert.ok(commandsIn(skills.map((s) => read(s.file)).join('\n'), 'factory').length > 20, 'expected the skills to name factory commands');
  assert.deepEqual(checkCommands(skills, 'factory', help), []);
});

test('skills: every `factory-inspect …` command a skill names exists in the inspector HELP', { skip: !exists(INSPECTOR) && 'factory-inspector not in this checkout' }, () => {
  const help = helpText(path.join(INSPECTOR, 'inspector', 'main.js'));
  assert.deepEqual(checkCommands(SKILLS.filter((s) => s.plugin === INSPECTOR), 'factory-inspect', help), []);
});

test('the command check rejects unknown commands, subcommands and flags', () => {
  const help = 'x\nJobs       job new --title "…" · job show · next\nShip       ci verify [--commit sha]';
  const fake = path.join(require('os').tmpdir(), `lint-${process.pid}.md`);
  fs.writeFileSync(fake, 'Run `factory next`, `factory job show`, `factory ci verify --commit X`, `factory nope`, `factory job delete`, `factory next --force`.');
  try {
    const p = checkCommands([{ name: 'fake', file: fake }], 'factory', help);
    assert.equal(p.length, 3, p.join('\n'));
  } finally {
    fs.unlinkSync(fake);
  }
});

test('skills: every factory:<name> reference and every ${CLAUDE_SKILL_DIR}/${CLAUDE_PLUGIN_ROOT} path exists', () => {
  const names = new Set([
    ...SKILLS.filter((s) => s.plugin === FACTORY).map((s) => s.name),
    ...fs.readdirSync(path.join(FACTORY, 'agents')).map((f) => f.replace(/\.md$/, '')),
    ...fs.readdirSync(path.join(FACTORY, 'workflows')).filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')),
  ]);
  const problems = [];
  for (const s of SKILLS) {
    const text = read(s.file);
    for (const m of text.matchAll(/\bfactory:([a-z][\w-]*)/g)) if (!names.has(m[1])) problems.push(`${s.name}: factory:${m[1]} is not a skill, agent or workflow`);
    for (const m of text.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([^\s`)]+)/g)) if (!exists(path.join(s.dir, m[1]))) problems.push(`${s.name}: \${CLAUDE_SKILL_DIR}/${m[1]} does not exist`);
    for (const m of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`)]+)/g)) if (!exists(path.join(s.plugin, m[1]))) problems.push(`${s.name}: \${CLAUDE_PLUGIN_ROOT}/${m[1]} does not exist`);
    for (const m of text.matchAll(/\bsection \d+\b/gi)) problems.push(`${s.name}: "${m[0]}" — refer to a named heading, not a section number`);
  }
  assert.deepEqual(problems, []);
});

test('skills: every references/ file is pointed to by its SKILL.md with a load condition', () => {
  const problems = [];
  for (const s of SKILLS) {
    const refDir = path.join(s.dir, 'references');
    if (!exists(refDir)) continue;
    const text = read(s.file);
    for (const f of fs.readdirSync(refDir)) {
      const at = text.indexOf(`references/${f}`);
      if (at < 0) problems.push(`${s.name}: references/${f} is never mentioned`);
      else if (!/\b(when|before|if|only)\b/i.test(text.slice(Math.max(0, at - 300), at + 200))) problems.push(`${s.name}: references/${f} has no load condition (when/before/if/only) next to it`);
    }
  }
  assert.deepEqual(problems, []);
});

// ---------- agents vs their output schemas ----------

// Split a call's argument list at top-level commas, respecting quotes and template literals.
function callArgs(src, open) {
  const args = [];
  let depth = 0;
  let cur = '';
  let i = open + 1;
  const stack = [];
  for (; i < src.length; i++) {
    const ch = src[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      cur += ch;
      if (ch === '\\') cur += src[++i];
      else if (ch === top) stack.pop();
      continue;
    }
    if (top === '`') {
      cur += ch;
      if (ch === '\\') cur += src[++i];
      else if (ch === '`') stack.pop();
      else if (ch === '$' && src[i + 1] === '{') {
        stack.push('${');
        cur += src[++i];
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      stack.push(ch);
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
      stack.push(ch);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (top === '${' && ch === '}') {
        stack.pop();
        cur += ch;
        continue;
      }
      if (depth === 0) break;
      depth -= 1;
      stack.pop();
    } else if (ch === ',' && depth === 0) {
      args.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) args.push(cur.trim());
  return args;
}

const lastLiteral = (expr) => {
  const all = [...(expr || '').matchAll(/'([\w-]+)'/g)];
  return all.length ? all[all.length - 1][1] : null;
};

function walk(obj, fn) {
  if (Array.isArray(obj)) obj.forEach((x) => walk(x, fn));
  else if (obj && typeof obj === 'object') {
    fn(obj);
    Object.values(obj).forEach((x) => walk(x, fn));
  }
}

// role → Set(schema names), derived from where the CLI actually pairs them:
//  1. workflow configs: any { role, schema } object;
//  2. wfargs.js: every prompt('<role>', …, '<schema>') call;
//  3. wfargs.js: prompt(<expr>.role, …) calls take the config fan-out roles, prompt(role, …)
//     the challenge lane roles (the two places wfargs passes a role it read from config);
//  4. otherwise a schema with the agent's own name (builder, tester, integrator, planner …).
function roleSchemas() {
  const schemaDir = path.join(FACTORY, 'schemas', 'agent-outputs');
  const schemaNames = new Set(fs.readdirSync(schemaDir).map((f) => f.replace(/\.json$/, '')));
  const map = {};
  const add = (role, s) => {
    if (role && s && schemaNames.has(s)) (map[role] = map[role] || new Set()).add(s);
  };
  const cfgDir = path.join(FACTORY, 'config', 'workflows');
  const fanoutRoles = new Set();
  const laneRoles = new Set();
  for (const f of fs.readdirSync(cfgDir)) {
    const cfg = JSON.parse(read(path.join(cfgDir, f)));
    walk(cfg, (o) => {
      if (typeof o.role === 'string' && typeof o.schema === 'string') add(o.role, o.schema);
    });
    for (const x of cfg.fanout || []) if (x.role) fanoutRoles.add(x.role);
    for (const r of Object.values(cfg.lanes || {})) laneRoles.add(r);
  }
  const src = read(path.join(FACTORY, 'cli', 'core', 'wfargs.js'));
  for (const m of src.matchAll(/\bprompt\(/g)) {
    const args = callArgs(src, m.index + m[0].length - 1);
    if (args.length < 3) continue;
    const schemaName = lastLiteral(args[2]);
    const literals = [...args[0].matchAll(/'([\w-]+)'/g)].map((x) => x[1]); // 'x', or a ? 'x' : 'y'
    if (literals.length) {
      for (const r of literals) add(r, schemaName);
    } else if (/\.role$/.test(args[0])) {
      for (const r of fanoutRoles) if (!map[r]) add(r, schemaName);
    } else if (/^role$/.test(args[0])) {
      for (const r of laneRoles) add(r, schemaName);
    }
  }
  for (const f of fs.readdirSync(path.join(FACTORY, 'agents'))) {
    const role = f.replace(/\.md$/, '');
    if (!map[role] && schemaNames.has(role)) add(role, role);
  }
  return map;
}

function requiredProps(schema, out = new Set()) {
  if (!schema || typeof schema !== 'object') return out;
  for (const r of schema.required || []) out.add(r);
  for (const v of Object.values(schema.properties || {})) requiredProps(v, out);
  if (schema.items) requiredProps(schema.items, out);
  for (const k of ['oneOf', 'anyOf', 'allOf']) for (const v of schema[k] || []) requiredProps(v, out);
  return out;
}

const FINAL_HEADING = /^(#{1,4})\s+(?:your\s+)?(?:final message|output|what to return|return)\b.*$/im;
function finalSection(body) {
  const m = body.match(FINAL_HEADING);
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = rest.search(new RegExp(`^#{1,${m[1].length}}\\s`, 'm'));
  return next < 0 ? rest : rest.slice(0, next);
}

test('roles are paired with schemas the way wfargs pairs them', () => {
  const map = roleSchemas();
  // Sanity anchors: if these move, wfargs changed shape and the derivation above needs a look.
  assert.ok(map['code-reviewer'] && map['code-reviewer'].has('reviewer'), JSON.stringify(Object.keys(map)));
  assert.ok(map['god-eye'] && map['god-eye'].has('critique'));
  assert.ok(map['intent-analyst'] && map['intent-analyst'].has('analyst'));
  assert.ok(map['finding-verifier'] && map['finding-verifier'].has('verifier'));
  assert.ok(map.builder && map.builder.has('builder'));
});

test('the final-message check finds the section and nested required fields', () => {
  const body = '# Role\nDo things.\n\n## Your final message\nReturn `lane` and `findings`, each with `id`, `severity` and `summary`.\n\n## Notes\nverdict';
  const s = finalSection(body);
  assert.ok(s.includes('findings') && !s.includes('verdict'));
  const req = requiredProps(JSON.parse(read(path.join(FACTORY, 'schemas', 'agent-outputs', 'reviewer.json'))));
  assert.deepEqual([...req].sort(), ['findings', 'id', 'lane', 'severity', 'summary']);
  assert.equal(finalSection('# Role\nNo output section here.'), null);
});

const agentFiles = fs.readdirSync(path.join(FACTORY, 'agents')).filter((f) => f.endsWith('.md'));
const anyFinalSection = agentFiles.some((f) => finalSection(read(path.join(FACTORY, 'agents', f))));

test(
  'agents: every required schema property is named in the agent\'s final-message section',
  { skip: !anyFinalSection && 'no agent has a final-message section yet (added by the agents work); enforced as soon as one does' },
  () => {
    const map = roleSchemas();
    const problems = [];
    for (const [role, names] of Object.entries(map)) {
      const file = path.join(FACTORY, 'agents', `${role}.md`);
      if (!exists(file)) continue;
      const section = finalSection(read(file));
      if (!section) {
        problems.push(`${role}: no final-message section ("## Your final message")`);
        continue;
      }
      for (const n of names) {
        const schema = JSON.parse(read(path.join(FACTORY, 'schemas', 'agent-outputs', `${n}.json`)));
        for (const prop of requiredProps(schema)) if (!new RegExp(`\\b${prop}\\b`).test(section)) problems.push(`${role}: required field "${prop}" (${n}.json) is not named in its final-message section`);
      }
    }
    assert.deepEqual(problems, []);
  },
);

// ---------- hard-coded counts ----------

const COUNT_NOUNS = 'agents|skills|rules|roles|workflows|recipes|hooks|lanes|reviewers|analysts';
const COUNT_PATTERNS = [
  [new RegExp(`\\b\\d+ (?:${COUNT_NOUNS})\\b`, 'g'), 'a number of components that drifts as they are added'],
  [/\bR\d+\s*[–-]\s*R\d+\b/g, 'a rule-id range that drifts as rules are added'],
];
// Historical design docs describe what was planned at the time; they are not kept current.
const COUNT_EXEMPT = new Set(['plugins/factory/docs/DESIGN-v2.md']);

function countTargets() {
  const files = [path.join(REPO, 'README.md')];
  for (const plugin of [FACTORY, INSPECTOR]) {
    if (!exists(plugin)) continue;
    files.push(path.join(plugin, 'README.md'));
    const docs = path.join(plugin, 'docs');
    if (exists(docs)) for (const f of fs.readdirSync(docs)) if (f.endsWith('.md')) files.push(path.join(docs, f));
  }
  for (const s of SKILLS) {
    files.push(s.file);
    const refs = path.join(s.dir, 'references');
    if (exists(refs)) for (const f of fs.readdirSync(refs)) files.push(path.join(refs, f));
  }
  return files.filter((f) => exists(f) && !COUNT_EXEMPT.has(rel(f)));
}

function countProblems(file, text) {
  const out = [];
  for (const [re, why] of COUNT_PATTERNS) for (const m of text.matchAll(re)) out.push(`${rel(file)}: "${m[0]}" — ${why}`);
  return out;
}

test('docs and skills: no hard-coded component counts or rule-id ranges', () => {
  const problems = countTargets().flatMap((f) => countProblems(f, read(f)));
  assert.deepEqual(problems, []);
});

test('the count lint flags what it was written for', () => {
  assert.equal(countProblems('x.md', 'the 19 agents with how often each ran; health rules (R10–R19)').length, 2);
  assert.equal(countProblems('x.md', 'at most 3 questions; R21 and R22').length, 0);
});
