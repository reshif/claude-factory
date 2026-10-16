'use strict';
// Who a prompt came from (review B1). The UserPromptSubmit hook fires not only on what the user
// types: also on a scheduled task firing (CronCreate, ScheduleWakeup, /loop), a background
// subagent reporting back, and a message another session (or this session's own Bash command or
// hook, through its inbox socket) sends (code.claude.com/docs/en/hooks, "UserPromptSubmit"; its
// input has `prompt` and `session_title` and no field saying where the prompt came from). A
// scheduled prompt fires verbatim, so a cron "approve" would read as the user's reply.
//
// Two ends close it:
//   - the guard (PreToolUse on the scheduling and messaging tools) refuses any text Claude
//     schedules or sends that reads as a factory reply (human.readReply, the prompt hook's own
//     reader), and any short text while a job waits on the user; it records a sealed hash of
//     every text it lets through
//     (.factory/log/agent-prompts.jsonl);
//   - the prompt hook refuses a prompt whose hash matches one Claude scheduled or sent
//     (agentOriginated: a one-shot note counts once, a recurring one every firing; both expire), and never treats a prompt wrapped
//     in an envelope tag (a task notification, a teammate or peer message) as the user's words.
// The limit, honestly: text that reaches the session some other way (a script file Claude wrote
// and ran that posts to the inbox socket, an MCP tool the matcher does not name, a background
// subagent whose plain final text is a bare reply) is not seen by the guard; the prompt hook then
// cannot tell it from typing. crossSessionInbound "refuse" in your settings closes the socket
// path for good.

const fs = require('fs');
const path = require('path');
const { nowIso } = require('../lib/util');
const { seal, valid } = require('../lib/seal');

const FILE = (root) => path.join(root, '.factory', 'log', 'agent-prompts.jsonl');
const KEEP_DAYS = 7;
// What the hook takes as the user's reply is decided by ONE reader, human.readReply (exact replies,
// ";" batches, near misses, clarify's ok and sheet answers, park options and confirmations, budget
// grants, the inspector's replies). The guard refuses to schedule or send anything it reads as a
// reply; there is no second, narrower list (review B1).
const readReply = (text) => require('./human').readReply(text);

// Is a job waiting on the user's reply right now (a park question, a gate, a clarify screen, the
// ship review, a merge, a criterion to confirm, a proposal)? While one is, a short scheduled or
// sent text is refused unless it clearly is not a reply (fail closed, review B1): a free-text
// park answer or a clarify answer has no fixed form the guard could recognise.
const SHORT_WORDS = 12;
function awaitingHuman(root) {
  try {
    return require('./inbox').list(root, { plain: true }).items.filter((x) => !['amend'].includes(x.kind));
  } catch {
    return [];
  }
}

// Why the guard refuses this text from a scheduling or messaging tool, or null.
function refuseScheduled(root, text) {
  const r = readReply(text);
  if (r.reply) return `it reads as a factory reply (${r.forms.join(', ')})`;
  if (r.clearlyNot || r.words > SHORT_WORDS) return null;
  const waiting = awaitingHuman(root);
  if (waiting.length) return `${waiting[0].job} is waiting on the user's reply (${waiting[0].what || waiting[0].kind}), and a short text could be taken as it`;
  return null;
}

// Scheduling tools whose text fires more than once (a recurring cron, /loop, a trigger that can be
// fired again, a wakeup /loop re-arms): their notes match on every firing for KEEP_DAYS, never
// consumed. A one-shot message counts once.
function recurringOf(tool, input) {
  const t = String(tool || '');
  if (t === 'CronCreate') return !(input && input.recurring === false);
  if (t === 'ScheduleWakeup' || t === 'RemoteTrigger') return true;
  return /create_trigger|update_trigger|fire_trigger/.test(t);
}

// An envelope Claude Code (or a peer) wraps around text that is not the user's typing.
const ENVELOPE = /^\s*<(task-notification|teammate-message|peer-message|cross-session-message|channel|scheduled-task|background-task|system-reminder|local-command-stdout|command-message)\b/i;
const nonHuman = (text) => ENVELOPE.test(String(text || ''));

const keysOf = (text) => {
  const C = require('./clarify');
  const t = String(text || '').trim();
  return [...new Set([C.promptKey(t), C.promptKey(C.promptArgs(t))])];
};

function read(root) {
  try {
    return fs.readFileSync(FILE(root), 'utf8').split('\n').filter(Boolean).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter((e) => e && valid(e));
  } catch {
    return [];
  }
}

function record(root, text, { tool = null, agent = null, recurring = false } = {}) {
  const t = String(text || '').trim();
  if (!root || !t || t.length > 20000) return;
  try {
    fs.mkdirSync(path.dirname(FILE(root)), { recursive: true });
    fs.appendFileSync(FILE(root), `${JSON.stringify(seal({ at: nowIso(), keys: keysOf(t), tool, agent, ...(recurring ? { recurring: true } : {}) }))}\n`);
  } catch {
    /* noting never breaks the guard */
  }
}

// Did Claude schedule or send exactly this text (within KEEP_DAYS)? A one-shot note is consumed by
// its match (written as used), so the user typing the same words later is theirs again; a
// recurring schedule's note matches every firing (review B1: the second cron firing was taken as
// the user's).
function agentOriginated(root, text) {
  const t = String(text || '').trim();
  if (!root || !t) return null;
  const ks = new Set(keysOf(t));
  const all = read(root);
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const used = new Set(all.filter((e) => e.used).map((e) => e.used));
  const hit = all.find((e) => !e.used && Date.parse(e.at) >= cutoff && (e.keys || []).some((k) => ks.has(k)) && (e.recurring || !used.has(e.at + (e.keys || [])[0])));
  if (!hit) return null;
  if (hit.recurring) return { at: hit.at, tool: hit.tool || null, recurring: true };
  try {
    fs.appendFileSync(FILE(root), `${JSON.stringify(seal({ at: nowIso(), used: hit.at + (hit.keys || [])[0] }))}\n`);
  } catch {
    /* best effort */
  }
  return { at: hit.at, tool: hit.tool || null };
}

// The text leaves of a tool's input (a cron's prompt, a message's text, nested fields).
function texts(input, out = []) {
  if (typeof input === 'string') out.push(input);
  else if (Array.isArray(input)) for (const x of input) texts(x, out);
  else if (input && typeof input === 'object') for (const v of Object.values(input)) texts(v, out);
  return out;
}

// The leaves that can come back as a prompt: not a schedule's own fields (its cron spec, time,
// delay, ids, label, model), which are never delivered as text.
const NOT_PROMPT = /^(cron|cron_expression|schedule|run_once_at|at|when|time|timezone|delay\w*|interval\w*|session_id|trigger_id|environment_id|persistent_session_id|id|name|title|label|model|tags|recurring|enabled|priority|visibility|to|thread_ts|in_reply_to)$/i;
function promptTexts(input, key = null, out = []) {
  if (key && NOT_PROMPT.test(key)) return out;
  if (typeof input === 'string') {
    if (input.trim()) out.push(input);
  } else if (Array.isArray(input)) for (const x of input) promptTexts(x, null, out);
  else if (input && typeof input === 'object') for (const [k, v] of Object.entries(input)) promptTexts(v, k, out);
  return out;
}

// The tools that put text into a session as a later prompt: Claude Code's scheduling and messaging
// tools, and MCP tools named like them (hooks.json's PreToolUse matcher names the same set).
const PROMPT_TOOLS = /^(CronCreate|ScheduleWakeup|RemoteTrigger|SendMessage)$|^mcp__.*(send_message|send_later|create_trigger|update_trigger|fire_trigger)/;
// A Bash command that reaches this session's own inbox socket (code.claude.com/docs/en/cross-session-messaging)
const SOCKET = /CLAUDE_CODE_MESSAGING_(SOCKET|TOKEN)|cc-socks-/;

module.exports = { promptTexts, readReply, refuseScheduled, awaitingHuman, recurringOf, SHORT_WORDS, nonHuman, record, agentOriginated, texts, PROMPT_TOOLS, SOCKET, FILE };
