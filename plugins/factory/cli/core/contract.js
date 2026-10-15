'use strict';
// The outcome contract: a markdown file with fixed sections the CLI can parse.
// Its hash includes work type and risk, so risk is locked by the H1 approval.

const { readText, sha256 } = require('../lib/util');
const { jobPaths } = require('../lib/paths');

const EVIDENCE_TYPES = ['test', 'run', 'diff', 'doc', 'human'];

// The Intent section is the why, written before the what. Each line is "- Label: value".
// Clarify asks about these first and alone; a line left as <…> fails the check.
const INTENT_FIELDS = [
  { key: 'problem', label: 'Problem', re: /^problem$/, required: true, hint: 'what is wrong or missing today' },
  { key: 'who', label: 'Who', re: /^who(\s+is\s+affected)?$/, required: true, hint: 'who has the problem, and who asked' },
  { key: 'outcome', label: 'Outcome', re: /^(desired\s+)?outcome$/, required: true, hint: 'what is true for them when this is done' },
  { key: 'why_now', label: 'Why now', re: /^why\s+now$/, required: false, hint: 'what prompted this now' },
  { key: 'success', label: 'Success signal', re: /^success(\s+signal)?$/, required: true, hint: 'how we would know it worked, observably' },
];

function intentLines(values = {}) {
  return INTENT_FIELDS.map((f) => `- ${f.label}: ${values[f.key] && !isPlaceholder(values[f.key]) ? values[f.key] : `<${f.hint}>`}`);
}

function template({ title, workType, risk, epic }) {
  const ac = epic ? 'E-AC' : 'AC';
  return `# ${title}

<!-- factory contract · work_type: ${workType} · risk: ${risk}${epic ? ' · epic' : ''} -->

## Intent
<!-- The why, settled first: clarify asks about it before anything else. One line each. -->
${intentLines().join('\n')}

## Goal
<the outcome in one or two sentences — what is true when this is done, not how>

## Non-goals
- <what this deliberately does not do>

## Acceptance criteria
<!-- One per line: - ${ac}-1: <observable behaviour> (evidence: test)
     Evidence types: test · run · diff · doc · human -->
- ${ac}-1: <observable behaviour> (evidence: test)

## Constraints
- <compatibility, performance, security or style constraints>

## Allowed paths
<!-- Globs this change may touch, e.g. src/auth/** -->
- <path/glob/**>

## Verify commands
<!-- Commands that prove the criteria. One per line: - \`npm test -- auth\` (${ac}-1) -->
- \`<command>\` (${ac}-1)

## Assumptions
- <anything assumed rather than confirmed>
`;
}

function sections(text) {
  const out = {};
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      cur = h[1].toLowerCase();
      out[cur] = [];
    } else if (cur) {
      out[cur].push(line);
    }
  }
  return out;
}

function stripComments(lines) {
  return lines.join('\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');
}

function items(lines) {
  return stripComments(lines || [])
    .map((l) => l.match(/^\s*[-*]\s+(.*)$/))
    .filter(Boolean)
    .map((m) => m[1].trim())
    .filter((t) => t && !/^<.*>$/.test(t));
}

// A placeholder is a whole value written as <…> (the template's own hints).
// Real text that merely contains angle brackets (e.g. "renders <Button>") is not.
function isPlaceholder(t) {
  const s = String(t || '').trim();
  return !s || /^<[^<>]*>(\s*\(.*\))?$/.test(s) || /^<[^<>]*>\/?\**\/?\**$/.test(s);
}

function parseIntent(lines) {
  if (!lines) return { present: false };
  const out = { present: true };
  for (const it of items(lines)) {
    const m = it.match(/^([^:]{2,30}):\s*(.*)$/);
    if (!m) continue;
    const f = INTENT_FIELDS.find((x) => x.re.test(m[1].trim().toLowerCase()));
    if (f && out[f.key] === undefined) out[f.key] = m[2].trim();
  }
  return out;
}

function parse(text) {
  const s = sections(text);
  const title = (String(text || '').match(/^#\s+(.+)$/m) || [])[1] || '';
  const goal = stripComments(s.goal || []).join('\n').trim();
  const acs = [];
  for (const it of items(s['acceptance criteria'])) {
    const m = it.match(/^((?:E-)?AC-\d+)\s*:\s*(.+?)\s*(?:\(evidence:\s*([a-z ,|]+)\))?\s*$/i);
    if (!m) continue;
    const types = (m[3] || 'test')
      .split(/[,|]/)
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean);
    acs.push({ id: m[1].toUpperCase(), text: m[2], evidence: types });
  }
  const allowedPaths = items(s['allowed paths']).map((p) => p.replace(/`/g, '').trim()).filter((p) => !isPlaceholder(p));
  const verifyCommands = [];
  for (const it of items(s['verify commands'])) {
    const m = it.match(/`([^`]+)`\s*(?:\(([^)]*)\))?/);
    if (!m || isPlaceholder(m[1])) continue;
    const covers = (m[2] || '')
      .split(/[,\s]+/)
      .map((x) => x.trim().toUpperCase())
      .filter((x) => /^(E-)?AC-\d+$/.test(x));
    verifyCommands.push({ cmd: m[1], covers });
  }
  return {
    title,
    intent: parseIntent(s.intent),
    goal,
    nonGoals: items(s['non-goals']),
    acs,
    constraints: items(s.constraints),
    allowedPaths,
    verifyCommands,
    assumptions: items(s.assumptions),
  };
}


// ---- clarify v2: the sections the CLI owns, written from the clarify ledger ----
const CLARIFIED_HEADING = '## Clarifications (settled)';
const CLARIFIED_COMMENT = '<!-- Written by the factory from the clarify ledger (factory clarify status); do not edit by hand. Answer with factory answer U-n "<answer>". -->';
const DEFERRED_HEADING = '## Deferred to design';
const DEFERRED_COMMENT = '<!-- Implementation details clarify handed to ground/decide; they do not block H1. Written by the factory. -->';
const CLI_OWNED = ['clarifications (settled)', 'deferred to design'];

// Replace (or add, before "## Assumptions") a section the CLI owns. With no lines and no
// section, the text is unchanged.
function setSection(text, heading, comment, lines, before = /^##\s+assumptions\s*$/i) {
  const src = String(text || '');
  const body = [heading, comment, ...lines].join('\n');
  const all = src.split('\n');
  const want = heading.replace(/^##\s+/, '').trim().toLowerCase();
  const start = all.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === want);
  if (start !== -1) {
    let end = all.findIndex((l, i) => i > start && /^##\s+/.test(l));
    if (end === -1) end = all.length;
    const tail = all.slice(end);
    const next = [...all.slice(0, start), ...body.split('\n'), ...(tail.length ? [''] : []), ...tail];
    while (tail.length === 0 && next.length && next[next.length - 1] === '') next.pop();
    return next.join('\n') + (tail.length ? '' : '\n');
  }
  if (!lines.length) return src;
  let at = all.findIndex((l) => before.test(l));
  if (at === -1) at = all.findIndex((l) => /^##\s+assumptions\s*$/i.test(l));
  if (at !== -1) return [...all.slice(0, at), ...body.split('\n'), '', ...all.slice(at)].join('\n');
  return `${src.replace(/\n*$/, '\n')}\n${body}\n`;
}
function setClarified(text, lines) {
  return setSection(text, CLARIFIED_HEADING, CLARIFIED_COMMENT, lines, /^##\s+deferred to design\s*$/i);
}
function setDeferred(text, lines) {
  return setSection(text, DEFERRED_HEADING, DEFERRED_COMMENT, lines);
}

// One hash per section (CLI-owned ones left out): what changed between two clarify rounds.
function sectionHashes(text) {
  const s = sections(text);
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (CLI_OWNED.includes(k)) continue;
    out[k] = sha256(stripComments(v).join('\n').trim()).slice(0, 16);
  }
  return out;
}

// A contract text with the CLI-owned sections taken from another text (the contract editor's
// revision keeps the CLI's own sections, whatever it returned for them).
function keepCliSections(revised, current) {
  let out = String(revised || '');
  const cur = sections(current);
  for (const [heading, comment, key] of [[CLARIFIED_HEADING, CLARIFIED_COMMENT, CLI_OWNED[0]], [DEFERRED_HEADING, DEFERRED_COMMENT, CLI_OWNED[1]]]) {
    const lines = cur[key] ? stripComments(cur[key]).filter((l) => l.trim()) : [];
    out = setSection(out, heading, comment, lines);
    if (!cur[key]) {
      // the current text has no such section: drop one the revision invented
      const all = out.split('\n');
      const start = all.findIndex((l) => /^##\s+/.test(l) && l.replace(/^##\s+/, '').trim().toLowerCase() === key);
      if (start !== -1) {
        let end = all.findIndex((l, i) => i > start && /^##\s+/.test(l));
        if (end === -1) end = all.length;
        out = [...all.slice(0, start), ...all.slice(end)].join('\n');
      }
    }
  }
  return out;
}

function intentProblems(intent, requireIntent) {
  if (!intent || !intent.present) return requireIntent ? ['No "## Intent" section: add Problem, Who, Outcome, Why now and Success signal (one line each) above the Goal'] : [];
  return INTENT_FIELDS.filter((f) => (intent[f.key] === undefined ? f.required : isPlaceholder(intent[f.key]))).map((f) => `Intent: ${f.label} is missing or still a placeholder`);
}

// requireIntent: false only for contracts approved before the Intent section existed.
function problems(parsed, { requirePlanFields = false, requireIntent = true } = {}) {
  const p = intentProblems(parsed.intent, requireIntent);
  if (isPlaceholder(parsed.goal) || parsed.goal.length < 10) p.push('Goal is missing or still a placeholder');
  if (!parsed.acs.length) p.push('No acceptance criteria (lines like "- AC-1: … (evidence: test)")');
  const ids = parsed.acs.map((a) => a.id);
  if (new Set(ids).size !== ids.length) p.push('Duplicate acceptance criterion ids');
  for (const ac of parsed.acs) {
    if (isPlaceholder(ac.text)) p.push(`${ac.id} is still a placeholder`);
    for (const t of ac.evidence) if (!EVIDENCE_TYPES.includes(t)) p.push(`${ac.id}: unknown evidence type "${t}" (use ${EVIDENCE_TYPES.join(', ')})`);
  }
  if (requirePlanFields) {
    if (!parsed.allowedPaths.length) p.push('Allowed paths is empty (needed to build straight from the contract)');
    const runnable = parsed.acs.filter((a) => a.evidence.some((t) => t === 'test' || t === 'run'));
    if (runnable.length && !parsed.verifyCommands.length) p.push('Verify commands is empty but some criteria need test/run evidence');
  }
  return p;
}

function read(root, jobId) {
  return readText(jobPaths(root, jobId).contract, '');
}

function hash(root, state) {
  const text = read(root, state.id);
  return sha256(`${text}\n--factory--\nwork_type=${state.work_type}\nrisk=${state.risk}\nepic=${Boolean(state.epic)}`);
}

module.exports = { EVIDENCE_TYPES, INTENT_FIELDS, CLARIFIED_HEADING, DEFERRED_HEADING, CLI_OWNED, intentLines, template, parse, problems, read, hash, isPlaceholder, sections, setSection, setClarified, setDeferred, sectionHashes, keepCliSections };
