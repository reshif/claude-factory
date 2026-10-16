'use strict';
// The factory CLI's boolean flags: a flag listed here takes no value, so the word after it is the
// next positional (`factory --check approve H1` is `approve H1`). cli/main.js parses with it and
// the guard hook (hooks/guard-rules.js) reads commands with the same list, so the two can never
// disagree about which word is the command (tests/phase3.test.js checks it).
const BOOL = new Set(['h1', 'epic', 'local', 'check', 'json', 'plan-fields', 'help', 'threat-model', 'plan-critique', 'no-threat-model', 'accept-degraded', 'serve', 'default', 'none', 'proposed']);

module.exports = { BOOL };
