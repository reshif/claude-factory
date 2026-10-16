'use strict';
// Agent transcripts and usage (P4.1, claude-native). Claude Code keeps every subagent's
// transcript itself: the SubagentStop hook names it (`agent_transcript_path`, the subagent's own
// JSONL under ~/.claude/projects/…/subagents/; code.claude.com/docs/en/hooks, SubagentStop
// input). The factory copies nothing: the hook records that path on its SubagentStop event,
// with what the transcript itself reports — each assistant message's `usage` (input, output and
// cache tokens), its `model`, and the tool calls it made (`tool_use` blocks). No hook input
// carries tokens or cost (the same page), and Claude Code writes no cost into transcripts, so
// the factory reports no cost: only tokens and tool calls, and "not reported" (never zero) when
// a transcript has no usage, is gone, or could not be read.

const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_READ = 32 * 1024 * 1024; // a transcript bigger than this is read from its tail only

// The folders Claude Code keeps transcripts in: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects.
function roots() {
  const out = [];
  if (process.env.CLAUDE_CONFIG_DIR) out.push(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  out.push(path.join(os.homedir(), '.claude', 'projects'));
  return out;
}

const expand = (p) => (typeof p === 'string' && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

// A path the factory may link or serve: an existing .jsonl inside one of Claude Code's
// transcript folders, after symlinks are resolved. Anything else is null.
function safePath(p) {
  const f = expand(p);
  if (typeof f !== 'string' || !path.isAbsolute(f) || !/\.jsonl$/.test(f)) return null;
  try {
    const real = fs.realpathSync(f);
    for (const r of roots()) {
      let base;
      try {
        base = fs.realpathSync(r) + path.sep;
      } catch {
        continue;
      }
      if (real.startsWith(base) && fs.statSync(real).isFile()) return real;
    }
  } catch {
    return null;
  }
  return null;
}

function readTail(file) {
  const st = fs.statSync(file);
  if (st.size <= MAX_READ) return { text: fs.readFileSync(file, 'utf8'), partial: false };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_READ);
    fs.readSync(fd, buf, 0, MAX_READ, st.size - MAX_READ);
    const t = buf.toString('utf8');
    return { text: t.slice(t.indexOf('\n') + 1), partial: true };
  } finally {
    fs.closeSync(fd);
  }
}

// What one subagent transcript reports: tool calls, tokens (an assistant message is written
// once per content block with the same id and usage, so each message id counts once, its last
// line), the models it ran on. { transcript, tool_calls, usage: { reported, … }, models }.
function summarize(p) {
  const file = expand(p);
  const out = { transcript: typeof file === 'string' ? file : null, tool_calls: null, usage: { reported: false }, models: [] };
  let text;
  try {
    const r = readTail(file);
    text = r.text;
    if (r.partial) out.partial = true;
  } catch {
    out.unreadable = true;
    return out;
  }
  const byMsg = new Map();
  const tools = new Set();
  let seen = false;
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = e && e.message;
    if (!m || (e.type !== 'assistant' && m.role !== 'assistant')) continue;
    seen = true;
    for (const c of Array.isArray(m.content) ? m.content : []) if (c && c.type === 'tool_use') tools.add(c.id || `${n++}`);
    const id = m.id || e.uuid || `${n++}`;
    byMsg.set(id, { usage: m.usage || null, model: m.model || null });
  }
  if (seen) out.tool_calls = tools.size;
  const sum = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
  let any = false;
  const models = new Set();
  for (const { usage: u, model } of byMsg.values()) {
    if (model && model !== '<synthetic>') models.add(model);
    if (!u || typeof u !== 'object') continue;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const parts = [['input_tokens', num(u.input_tokens)], ['output_tokens', num(u.output_tokens)], ['cache_read_tokens', num(u.cache_read_input_tokens)], ['cache_creation_tokens', num(u.cache_creation_input_tokens)]];
    for (const [k, v] of parts) {
      if (v === null) continue;
      sum[k] += v;
      any = true;
    }
  }
  if (any) out.usage = { reported: true, ...sum, messages: byMsg.size };
  out.models = [...models];
  return out;
}

// Totals over agent records (SubagentStop events carrying the above): tokens summed, tool calls
// summed, null where nothing reported it (unknown, not zero), and how many runs reported nothing.
function totals(runs) {
  const t = { agent_runs: runs.length, agent_seconds: 0, tool_calls: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null, unreported_runs: 0, models: [] };
  const models = new Set();
  for (const r of runs) {
    if (typeof r.ms === 'number') t.agent_seconds += Math.round(r.ms / 1000);
    if (typeof r.tool_calls === 'number') t.tool_calls = (t.tool_calls || 0) + r.tool_calls;
    const u = r.usage || {};
    if (!u.reported) t.unreported_runs += 1;
    else for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens']) if (typeof u[k] === 'number') t[k] = (t[k] || 0) + u[k];
    for (const m of r.models || []) models.add(m);
  }
  t.models = [...models];
  return t;
}

module.exports = { summarize, totals, safePath, roots, MAX_READ };
