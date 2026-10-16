'use strict';
// Factory agents at work right now, from the hooks' SubagentStart / SubagentStop lines (review M4).
// The main session's own verbs (factory drive, inbox, answer, clarify reply / redirect / note) are
// refused while one is: the guard refuses them to agents by reading the command, and this is the
// layer below it for what a guard can't read (a script file an agent wrote and ran). Claude Code
// gives a subagent's shell no environment marker of its own, so the event log is the evidence.
// The main session runs these only between workflows (a Workflow call holds its turn), so a
// factory agent still open means the caller is one, or a workflow is still running.

const fs = require('fs');
const path = require('path');

const MAX_AGE_MIN = 30; // an agent that never reported stopping (crashed, Esc) stops counting after this

function tailLines(file, bytes = 2 * 1024 * 1024) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, bytes);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString('utf8').split('\n');
  } catch {
    return [];
  }
}

function open(root, { now = Date.now(), maxAgeMin = MAX_AGE_MIN } = {}) {
  const started = new Map();
  for (const l of tailLines(path.join(root, '.factory', 'log', 'events.jsonl'))) {
    let e;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (!e || !e.agent_id) continue;
    if (e.event === 'SubagentStart' && /^factory:/.test(String(e.agent_type || ''))) started.set(e.agent_id, e);
    if (e.event === 'SubagentStop') started.delete(e.agent_id);
  }
  return [...started.values()].filter((e) => now - Date.parse(e.ts) < maxAgeMin * 60000).map((e) => ({ agent_id: e.agent_id, agent_type: e.agent_type, since: e.ts }));
}

function refuseWhileAgentsWork(root, what) {
  const o = open(root);
  if (!o.length) return;
  require('../lib/util').fail(`"factory ${what}" is the main session's, run between workflows: ${o.length} factory agent(s) are at work (${o.slice(0, 3).map((a) => `${a.agent_type} since ${a.since}`).join(', ')}). A factory agent returns its result in its final message instead. (An agent that never reported stopping stops counting ${MAX_AGE_MIN} minutes after it started.)`, 'agent_at_work', { agents: o.slice(0, 6) });
}

module.exports = { open, refuseWhileAgentsWork, MAX_AGE_MIN };
