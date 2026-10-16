'use strict';
// PreToolUse guard: see guard-rules.js for what is denied and why.

const path = require('path');
const { safe, findRoot, traceError } = require('./lib');
const { checkWrite, checkReadTool, checkBash, checkContent, deny, loadPolicy, READ_TOOLS } = require('./guard-rules');

// The job a command works on: the one whose worktree it runs in (a builder or tester subagent),
// else the current job. Inline code may read that job's folder (guard-rules, opts.job).
function jobInScope(root, cwd) {
  const wt = String(cwd || '').match(/\.factory[\\/]worktrees[\\/](J-\d+)/);
  if (wt) return wt[1];
  try {
    return require('../cli/core/job').current(root) || null;
  } catch {
    return null;
  }
}

safe((input) => {
  const tool = input.tool_name;
  const ti = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const filePath = ti.file_path || ti.notebook_path || ti.path || null;
  const absFile = filePath ? (path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath)) : null;
  const root = findRoot(cwd, absFile && path.dirname(absFile));
  const policy = root ? loadPolicy(root) : require('../cli/core/policy').defaults();
  let why = null;
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool) && absFile) {
    why = checkWrite(root, absFile, policy);
    if (!why && root) {
      const text = [ti.content, ti.new_string, ti.new_source, ...(Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string) : [])].filter(Boolean).join('\n');
      why = checkContent(text, absFile);
    }
  }
  else if (READ_TOOLS.has(tool)) why = checkReadTool(root, tool, ti, absFile, cwd, policy);
  else if (tool === 'Bash' && root) {
    // a subagent's call carries agent_id; agent_type alone also marks a main session started
    // with --agent (code.claude.com/docs/en/hooks, common input fields), which is not an agent here
    why = checkBash(root, ti.command, policy, { job: jobInScope(root, cwd), agent: Boolean(input.agent_id), agentType: input.agent_id ? input.agent_type || null : null });
    // posting to this session's own inbox socket: it arrives as a prompt, as if the user typed it
    if (!why && require('../cli/core/reply-origin').SOCKET.test(String(ti.command || ''))) why = 'Posting to this Claude Code session\'s inbox socket is not allowed in a factory repository: the text would arrive as a prompt the factory cannot tell from the user\'s own reply. Tell the user instead.';
  } else if (root && require('../cli/core/reply-origin').PROMPT_TOOLS.test(String(tool || ''))) {
    // Scheduling or sending text that comes back as a prompt (a cron firing, a message): never a
    // factory reply, which only the user types (review B1). What is let through is noted, so the
    // prompt hook refuses it if it still reads as a reply when it arrives.
    const O = require('../cli/core/reply-origin');
    const leaves = O.texts(ti);
    if (leaves.some((t) => O.looksLikeReply(t))) why = `${tool} would deliver a factory reply (approve, deny, resume, ok, accept brief …) as a prompt: replies are the user's own words, typed by them. Show the user the stop and let them reply.`;
    else for (const t of leaves) O.record(root, t, { tool, agent: input.agent_id || null });
  }
  if (why) {
    // Say what was seen, so a block can be traced to the exact command.
    if (tool === 'Bash' && ti.command) {
      const seen = String(ti.command).replace(/\s+/g, ' ').trim();
      why = `${why} (command: "${seen.length > 120 ? `${seen.slice(0, 117)}...` : seen}")`;
    }
    deny(why);
    try {
      require('./activity-log').log(input, 'guard_deny', { reason: why });
    } catch (e) {
      traceError(input, e); // logging never blocks
    }
  }
});
