'use strict';
// SubagentStop: records that a factory agent finished. It no longer blocks: workflow agents
// return through a JSON schema the runtime enforces, and factory record re-checks every
// artifact an agent was meant to write (design files, threat model, plan) before it counts.
// It also records where Claude Code keeps the agent's own transcript (agent_transcript_path) and
// what that transcript reports: tool calls, tokens, models (cli/core/transcripts.js). The
// transcript stays where Claude Code wrote it; the console links it.

const { safe } = require('./lib');

safe((input) => {
  const role = String(input.agent_type || '').split(':').pop() || null;
  let extra = { role };
  if (input.agent_transcript_path) {
    try {
      const s = require('../cli/core/transcripts').summarize(input.agent_transcript_path);
      extra = { ...extra, transcript: s.transcript, tool_calls: s.tool_calls, usage: s.usage, models: s.models, ...(s.partial ? { transcript_partial: true } : {}), ...(s.unreadable ? { transcript_unreadable: true } : {}) };
    } catch {
      extra.transcript = String(input.agent_transcript_path);
    }
  }
  require('./activity-log').log(input, 'SubagentStop', extra);
});
