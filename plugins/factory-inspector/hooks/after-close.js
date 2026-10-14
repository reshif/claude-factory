'use strict';
// After a factory job closes, inspect it (and any other closed job not yet inspected).
// Reports in one line; never blocks.

const { safe, emit } = require('./lib');
const { findRoot } = require('../inspector/io');

safe((input) => {
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!/\bfactory\b[^|;&\n]*\s(close)\b/.test(cmd)) return;
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  const r = require('../inspector/main').run(root, {});
  if (!r.inspected.length && !r.added.length && !r.reopened.length && !r.rearmed.length) return;
  const parts = [];
  if (r.inspected.length) parts.push(`inspected ${r.inspected.map((i) => i.job).join(', ')}`);
  if (r.added.length || r.reopened.length) parts.push(`${r.added.length} new finding(s)${r.reopened.length ? `, ${r.reopened.length} came back` : ''} — ${r.open.open} open (${r.open.high} high)`);
  else parts.push('no new findings');
  if (r.rearmed.length) parts.push(`rules changed for ${r.rearmed.map((x) => x.recipe).join(', ')}: inspecting every job again`);
  if (r.suggestions.length) parts.push(`suggestion: ${r.suggestions[0].suggest} (${r.suggestions[0].why})`);
  emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `[inspector] ${parts.join('; ')}. Tell the user in one line; details with /factory-inspector:inspect.` } });
});
