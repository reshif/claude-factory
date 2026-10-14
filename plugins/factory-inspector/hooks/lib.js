'use strict';
const fs = require('fs');

function input() {
  try {
    const t = fs.readFileSync(0, 'utf8');
    return t ? JSON.parse(t) : {};
  } catch {
    return {};
  }
}

// Hooks never break Claude Code: any failure means "do nothing".
function safe(fn) {
  try {
    fn(input());
  } catch (e) {
    if (process.env.FACTORY_HOOK_DEBUG) process.stderr.write(`inspector hook error: ${e.stack}\n`);
  }
  process.exit(0);
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

module.exports = { safe, emit };
