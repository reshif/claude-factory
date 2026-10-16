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
//     schedules or sends that reads as a factory reply (looksLikeReply, the prompt hook's own
//     parsers), and records a sealed hash of every text it lets through
//     (.factory/log/agent-prompts.jsonl);
//   - the prompt hook refuses a prompt whose hash matches one Claude scheduled or sent
//     (agentOriginated: each record counts once and expires), and never treats a prompt wrapped
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
// a sheet answer's shape ("1 a", "2: …", "3 defer", "fact 1: …"), state-free: the guard can't know the sheet
// the inspector plugin's human replies (marking findings, inspection modes): human-only there too
const INSPECTOR = /^\s*((ack|fixed|wontfix|reopen)\s+finding\s+F\d+|inspect\s+mode\s+\S+\s+(on|off|sample))\b/i;
const SHEET = /^\s*(\d{1,2}\s*[:.)]?\s*(?:[a-e]\b|defer\b|other\b|:)|fact\s+\d+\s*:)/i;

// Would the prompt hook (or clarify's chat reply) take this text as the user's reply?
function looksLikeReply(text) {
  const human = require('./human');
  const C = require('./clarify');
  const t = String(text || '').trim();
  if (!t) return false;
  const candidates = [t, ...t.split('\n').map((l) => l.trim()).filter(Boolean)];
  return candidates.some((x) => Boolean(human.parseReply(x)) || Boolean(human.nearMiss(x)) || C.ACCEPT.test(x) || C.ACCEPT_HEAD.test(x) || SHEET.test(x) || INSPECTOR.test(x));
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

function record(root, text, { tool = null, agent = null } = {}) {
  const t = String(text || '').trim();
  if (!root || !t || t.length > 20000) return;
  try {
    fs.mkdirSync(path.dirname(FILE(root)), { recursive: true });
    fs.appendFileSync(FILE(root), `${JSON.stringify(seal({ at: nowIso(), keys: keysOf(t), tool, agent }))}\n`);
  } catch {
    /* noting never breaks the guard */
  }
}

// Did Claude schedule or send exactly this text (within KEEP_DAYS, not matched before)? A match is
// consumed (written as used), so the user typing the same words later is theirs again.
function agentOriginated(root, text) {
  const t = String(text || '').trim();
  if (!root || !t) return null;
  const ks = new Set(keysOf(t));
  const all = read(root);
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const used = new Set(all.filter((e) => e.used).map((e) => e.used));
  const hit = all.find((e) => !e.used && Date.parse(e.at) >= cutoff && (e.keys || []).some((k) => ks.has(k)) && !used.has(e.at + (e.keys || [])[0]));
  if (!hit) return null;
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

// The tools that put text into a session as a later prompt: Claude Code's scheduling and messaging
// tools, and MCP tools named like them (hooks.json's PreToolUse matcher names the same set).
const PROMPT_TOOLS = /^(CronCreate|ScheduleWakeup|RemoteTrigger|SendMessage)$|^mcp__.*(send_message|send_later|create_trigger|update_trigger|fire_trigger)/;
// A Bash command that reaches this session's own inbox socket (code.claude.com/docs/en/cross-session-messaging)
const SOCKET = /CLAUDE_CODE_MESSAGING_(SOCKET|TOKEN)|cc-socks-/;

module.exports = { looksLikeReply, nonHuman, record, agentOriginated, texts, PROMPT_TOOLS, SOCKET, FILE };
