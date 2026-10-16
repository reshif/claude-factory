'use strict';
// Your replies about findings and inspection modes, applied before the model sees them.
const { safe, emit } = require('./lib');
const { findRoot } = require('../inspector/io');

// A prompt Claude scheduled or sent itself (the factory's guard notes its hash in
// .factory/log/agent-prompts.jsonl), or one wrapped as a notification or message, is not the
// user's typing: never applied (the UserPromptSubmit hook also fires on scheduled tasks, background
// subagents and cross-session messages: code.claude.com/docs/en/hooks).
const ENVELOPE = /^\s*<(task-notification|teammate-message|peer-message|cross-session-message|channel|scheduled-task|background-task|system-reminder|local-command-stdout|command-message)\b/i;
function notTyped(root, text) {
  if (ENVELOPE.test(String(text || ''))) return true;
  const { sha256, sealOk } = require('../inspector/io');
  const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const k = sha256(norm(String(text || '').trim()));
  try {
    const lines = require('fs').readFileSync(require('path').join(root, '.factory', 'log', 'agent-prompts.jsonl'), 'utf8').split('\n').filter(Boolean);
    const cutoff = Date.now() - 7 * 864e5;
    return lines.some((l) => {
      try {
        const e = JSON.parse(l);
        return !e.used && Date.parse(e.at) >= cutoff && (e.keys || []).includes(k) && sealOk(e) !== false;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

safe((input) => {
  const main = require('../inspector/main');
  const p = main.parseReply(input.prompt);
  if (!p) return;
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  if (notTyped(root, input.prompt)) {
    emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '[inspector] Not applied: Claude scheduled or sent this text itself (or it arrived wrapped as a notification or message). Only the user\'s own typed reply marks a finding or changes a mode.' } });
    return;
  }
  let msg;
  try {
    msg = `[inspector] Applied: ${main.applyReply(root, p).message}`;
  } catch (e) {
    msg = `[inspector] Not applied: ${e.message}`;
  }
  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msg } });
});
