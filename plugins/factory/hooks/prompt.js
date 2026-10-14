'use strict';
// UserPromptSubmit: your own reply ("approve", "deny …", "resume", "accept lesson L4", "merged <sha>", …)
// is applied by the CLI before the model sees it. Subagent prompts never pass through here.

const { safe, emit, findRoot } = require('./lib');

safe((input) => {
  const human = require('../cli/core/human');
  const parsed = human.parseReply(input.prompt);
  if (!parsed) return;
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  let msg;
  try {
    const r = human.applyReply(root, parsed, 'chat');
    msg = `[factory] Applied your reply: ${r.message || JSON.stringify(r)} Continue with \`factory next\` (skill factory:start).`;
  } catch (e) {
    msg = `[factory] Your reply "${String(input.prompt).trim()}" was NOT applied: ${e.message}`;
    require('../cli/core/events').append(root, { event: 'reply_refused', reply: parsed.cmd, gate: parsed.gate || null, code: e.code || null, reason: e.message.slice(0, 200), ...require('../cli/core/events').context(root, parsed.jobId) });
  }
  emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msg } });
});
