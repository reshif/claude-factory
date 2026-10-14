'use strict';
// Shared hook plumbing. Hooks must never crash Claude Code: every entry point
// catches everything and falls back to "allow".

const fs = require('fs');
const path = require('path');

function readInput() {
  try {
    const t = fs.readFileSync(0, 'utf8');
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function findRoot(...starts) {
  const { findRoot: f } = require('../cli/lib/paths');
  for (const s of starts) {
    if (!s) continue;
    const r = f(s);
    if (r) return r;
  }
  return null;
}

function safe(fn) {
  try {
    fn(readInput());
  } catch (e) {
    if (process.env.FACTORY_HOOK_DEBUG) process.stderr.write(`factory hook error: ${e.stack}\n`);
  }
  process.exit(0);
}

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  }
}

module.exports = { readInput, emit, findRoot, safe, realpath };
