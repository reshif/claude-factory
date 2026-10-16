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
// While the current job is parked, a message of yours that answers the park's question (an option,
// words about it, "yes" to a stored answer) resumes the job with your words (resume + content);
// any other is stored and Claude asks you once "Use this as your answer to …? reply yes": a job
// never resumes silently.

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

// A slash command or a factory command typed by the user: never an answer to a park.
function isFactoryPrompt(prompt) {
  const p = String(prompt || '').trim();
  return /^\/factory[:\s-]/i.test(p) || /(^|\s)factory:(start|gate|ship|review|park|amend|clarify|intake|why|distill|console)\b/i.test(p) || /^factory\s+\w/i.test(p);
}

// A reply to a park: a message of yours while the current job is parked that answers the park's
// question (an option, a reply about it, "yes" to a stored answer) resumes the job with your words
// (human.replyToPark); any other is stored and you are asked once whether it is your answer. Not a question to
// the assistant (ends with "?"), not a factory command or slash command, not a multi-paragraph text.
function parkReply(root, input) {
  const t = String(input.prompt || '').trim();
  if (!t || /\?\s*$/.test(t) || t.startsWith('/') || isFactoryPrompt(t) || t.includes('\n\n') || t.length > 2000) return false;
  const events = require('../cli/core/events');
  const ctx = events.context(root, null);
  let state;
  try {
    state = require('../cli/core/job').resolve(root, ctx.job || undefined);
  } catch {
    return false;
  }
  if (!state || state.status !== 'parked') return false;
  try {
    const r = require('../cli/core/human').replyToPark(root, { jobId: state.id, text: t, channel: 'chat' });
    if (r.pending) {
      // not an answer to the park: stored, and the user is asked once (never a silent resume)
      events.append(root, { event: 'reply_pending', reply: 'park', ...ctx });
      say(`[factory] ${state.id} is parked and this message was NOT applied: it does not answer the park's question. Ask the user exactly, in one line: Use this as your answer to "${r.question}"? reply yes. Do not resume the job yourself, and never ask for a confirmation code.`);
      return true;
    }
    events.append(root, { event: 'reply_applied', reply: 'park', ...ctx });
    say(`[factory] Applied your reply to the park: ${r.message} Continue with \`factory drive\` (skill factory:start); do not apply it again.`);
  } catch (e) {
    events.append(root, { event: 'reply_refused', reply: 'park', code: e.code || null, reason: e.message.slice(0, 200), ...ctx });
    say(`[factory] Your reply was NOT applied: ${e.message} Tell the user this in one line.`);
  }
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
  // one exact reply, or several in one message ("confirm AC-2; approve"): the ship review, the digest
  const parsed = human.parseReply(input.prompt) || human.parseBatch(input.prompt);
  const miss = parsed ? null : human.nearMiss(input.prompt);
  if (!parsed && !miss) {
    if (!clarifyReply(root, input)) parkReply(root, input);
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
