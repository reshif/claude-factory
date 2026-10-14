'use strict';
// The outcome contract: a markdown file with fixed sections the CLI can parse.
// Its hash includes work type and risk, so risk is locked by the H1 approval.

const { readText, sha256 } = require('../lib/util');
const { jobPaths } = require('../lib/paths');

const EVIDENCE_TYPES = ['test', 'run', 'diff', 'doc', 'human'];

function template({ title, workType, risk, epic }) {
  const ac = epic ? 'E-AC' : 'AC';
  return `# ${title}

<!-- factory contract · work_type: ${workType} · risk: ${risk}${epic ? ' · epic' : ''} -->

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
    goal,
    nonGoals: items(s['non-goals']),
    acs,
    constraints: items(s.constraints),
    allowedPaths,
    verifyCommands,
    assumptions: items(s.assumptions),
  };
}

function problems(parsed, { requirePlanFields = false } = {}) {
  const p = [];
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

module.exports = { EVIDENCE_TYPES, template, parse, problems, read, hash, isPlaceholder };
