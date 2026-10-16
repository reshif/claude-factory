'use strict';
// UserPromptSubmit: your own reply ("approve", "deny …", "resume", "proceed", "accept lesson L4",
// "merged <sha>", …) is applied by the CLI before the model sees it. Subagent prompts never pass
// through here. A short message that only looks like a reply ("aprove", "approve the plan
// please") is never applied; Claude is told so, with the exact forms.
// Clarify v3: while the current job waits on a clarify screen, an unmistakable reply (ok on the
// read-back or a redirect, a structured sheet reply such as "ok, but 2 b") is recorded through the
// same path as `factory clarify reply`; other words are left for the main session, which records
// them verbatim with `factory clarify reply`. Every message you type is also noted as a hash (never
// the text) in .factory/log/prompts.jsonl, so words the main session relays that are exactly yours
// count as yours (heard directly), not as relayed.

const { safe, emit, findRoot } = require('./lib');

const say = (msg) => emit({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: msg } });

// A reply to clarify's current screen, recorded through factory clarify reply; anything else is
// left for the main session. Returns true when it was recorded (or refused with a reason).
function clarifyReply(root, input) {
  const events = require('../cli/core/events');
  const ctx = events.context(root, null);
  let r;
  try {
    r = require('../cli/core/clarify').chatReply(root, input.prompt, { jobId: ctx.job || undefined });
  } catch (e) {
    events.append(root, { event: 'reply_refused', reply: 'clarify', code: e.code || null, reason: e.message.slice(0, 200), ...ctx });
    say(`[factory] Your reply was NOT recorded: ${e.message} Tell the user this in one line; do not record it yourself.`);
    return true;
  }
  if (!r) return false;
  events.append(root, { event: 'reply_applied', reply: 'clarify', stage: r.stage || null, ...ctx });
  say(`[factory] Recorded your reply for clarify: ${r.message} Continue with \`factory drive\` (skill factory:start); do not record it again.`);
  return true;
}

safe((input) => {
  const human = require('../cli/core/human');
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  // Not the user's typing (review B1): a prompt wrapped in an envelope (a task notification, a
  // peer or teammate message), or one Claude itself scheduled or sent (the guard noted its hash).
  // It is never applied as a reply and never noted as heard from the user.
  const O = require('../cli/core/reply-origin');
  const from = O.nonHuman(input.prompt) ? { why: 'it arrived wrapped as a notification or message, not typed' } : O.agentOriginated(root, input.prompt) ? { why: 'Claude scheduled or sent this text itself' } : null;
  if (from) {
    const events = require('../cli/core/events');
    if (O.looksLikeReply(input.prompt)) {
      events.append(root, { event: 'reply_refused', reply: 'agent_originated', code: 'agent_originated', reason: from.why, ...events.context(root, null) });
      say(`[factory] This prompt was NOT applied as a factory reply: ${from.why}. Only the user's own typed reply approves, denies, resumes or answers. Tell the user in one line and wait for their reply.`);
    }
    return;
  }
  // what you typed, as a hash: relayed words that are exactly yours are heard directly
  require('../cli/core/clarify').notePrompt(root, input.prompt);
  const parsed = human.parseReply(input.prompt);
  const miss = parsed ? null : human.nearMiss(input.prompt);
  if (!parsed && !miss) {
    clarifyReply(root, input);
    return;
  }
  const events = require('../cli/core/events');
  let msg;
  if (miss) {
    msg = `[factory] "${String(input.prompt).trim().slice(0, 80)}" looks like a factory reply but is not one, so NOTHING was applied (no approval, denial or resume was recorded). Replies must be the whole message, exactly one of: ${miss.forms.map((x) => `\`${x}\``).join(', ')}. Tell the user this in one line and ask them to resend the exact form if that is what they meant; do not act as if it was applied.`;
    events.append(root, { event: 'reply_unparsed', word: miss.word.slice(0, 30), verb: miss.verb, ...events.context(root, null) });
  } else {
    try {
      const r = human.applyReply(root, parsed, 'chat');
      msg = `[factory] Applied your reply: ${r.message || JSON.stringify(r)} Continue with \`factory drive\` (skill factory:start).`;
    } catch (e) {
      msg = `[factory] Your reply "${String(input.prompt).trim()}" was NOT applied: ${e.message}`;
      events.append(root, { event: 'reply_refused', reply: parsed.cmd, gate: parsed.gate || null, code: e.code || null, reason: e.message.slice(0, 200), ...events.context(root, parsed.jobId) });
    }
  }
  say(msg);
});
