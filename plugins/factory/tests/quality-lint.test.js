'use strict';
// Tier 0 quality lints: static checks across skills, agents, schemas, the CLI help and the
// docs, run on every PR at no model cost. Each check targets a weakness the quality
// benchmark found at a seam between two artifacts written by different hands:
//   - skill descriptions are triggers (what + when, no step sequence, a length budget,
//     a "Not for…" scope on user-invocable skills);
//   - every `factory …` / `factory-inspect …` command a skill names exists in that CLI's HELP;
//   - every `factory:<name>` and ${CLAUDE_SKILL_DIR}/${CLAUDE_PLUGIN_ROOT} path a skill names exists;
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

// Agents vs their output schemas (every required field named in the final-message recipe) and
// brief tool names vs each role's `tools:` are checked by tests/agents-packaging.test.js, which
// the agents work owns; they are deliberately not duplicated here.

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

// --- the confirmation code stays on the user's terminal -----------------------------------------
// A human-only command typed in the user's own terminal shows a random code there and asks for it
// there. An agent must never ask the user for it ("Paste the code back here, or just tell me it's
// done"): the code is what keeps the command the user's, and "tell me it's done" is no substitute
// for `factory next` showing what was applied. Skills, their references, agents and the CLI's and
// hooks' own messages say instead: "run this in your own terminal; it will ask you to type a code
// shown there".
const ASKS_FOR_CODE = [
  [/\b(paste|send|share|give|tell|read|copy)\b[^.\n|]{0,40}\bcode\b[^.\n|]{0,40}\b(back|here|to me|in(to)? (the |this )?chat|to the (agent|assistant|chat))\b/i, 'asks the user to bring the confirmation code to the chat'],
  [/\bcode\b[^.\n|]{0,60}\b(type|paste|send|read)\s+(it\s+)?back\b/i, 'asks for the code "back" (to whom? it is typed on the terminal only)'],
  [/\b(just|or)\s+tell\s+me\s+(it'?s|when it'?s|that it'?s|it is)\s+done\b/i, 'accepts "tell me it\'s done" in place of what factory next shows'],
];
function asksForCode(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    // a line that forbids it ("never ask … for the code") is the rule, not a breach
    if (/\b(never|don't|do not|not)\b[^.]{0,80}\bcode\b/i.test(line) && !/\bpaste the code back here\b/i.test(line)) continue;
    for (const [re, what] of ASKS_FOR_CODE) if (re.test(line)) out.push(`${what}: "${line.trim().slice(0, 120)}"`);
  }
  return out;
}

test('lint self-check: asking the user for the confirmation code is caught; the right wording is not', () => {
  assert.ok(asksForCode('It prints a short code on that terminal. Paste the code back here, or just tell me it\'s done.').length >= 2);
  assert.ok(asksForCode('(it shows a short code on their terminal for them to type back; never run it for them)').length >= 1);
  assert.deepEqual(asksForCode('Run this in your own terminal; it will ask you to type a code shown there.'), []);
  assert.deepEqual(asksForCode('Never ask the user for that code, never ask them to paste it into the chat.'), []);
});

test('skills, agents and the CLI\'s and hooks\' messages never ask the user for the confirmation code', () => {
  const problems = [];
  const files = [];
  for (const s of SKILLS) {
    files.push(s.file);
    const refs = path.join(s.dir, 'references');
    if (exists(refs)) for (const f of fs.readdirSync(refs)) files.push(path.join(refs, f));
  }
  for (const f of fs.readdirSync(path.join(FACTORY, 'agents'))) files.push(path.join(FACTORY, 'agents', f));
  for (const f of ['cli/core/human.js', 'hooks/guard-rules.js', 'hooks/prompt.js']) files.push(path.join(FACTORY, f));
  files.push(path.join(INSPECTOR, 'inspector', 'main.js'));
  for (const f of files) for (const p of asksForCode(read(f))) problems.push(`${rel(f)}: ${p}`);
  assert.deepEqual(problems, []);
  // and the skills that send the user to a terminal say how
  for (const name of ['gate', 'start']) {
    const s = SKILLS.find((x) => x.plugin === FACTORY && x.name === name);
    assert.match(read(s.file), /run this in your own terminal; it will ask you to type a code shown there/, `${name} says how the code works`);
  }
  // the guard's and the CLI's human-only messages say it too
  assert.match(read(path.join(FACTORY, 'hooks', 'guard-rules.js')), /it will ask them to type a code shown there\. Never ask them for that code or to paste it into the chat/);
  assert.match(read(path.join(FACTORY, 'cli', 'core', 'human.js')), /it will ask you to type a code shown there \(type it there; never paste it into the chat\)/);
});
