'use strict';
const { safe, emit } = require('./lib');
const { findRoot } = require('../inspector/io');

safe((input) => {
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  const { report } = require('../inspector/main');
  const r = report(root, { status: 'open', health: false });
  if (!r.counts.open) return;
  emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `[inspector] ${r.counts.open} open factory finding(s) (${r.counts.high} high). If the user asks about the factory's health, use /factory-inspector:inspect.` } });
});
