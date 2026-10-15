'use strict';
// The boundaries of each workflow run, in .factory/log/events.jsonl, for the console's step list
// (run-steps.js). A workflow script runs inside Claude Code's Workflow tool and can neither run a
// command nor write a file, so its run is framed by the commands around it: `factory wfargs`
// (the brief: workflow_start, with what the brief plans to run) and `factory record` (the
// envelope: workflow_end, with its roster); distill by `distill context` and `distill done`. The
// agents in between reach the log through the SubagentStart/SubagentStop hooks. Observation only:
// nothing here can fail a command.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const events = require('./events');

function start(root, brief) {
  try {
    const RS = require('./run-steps');
    const ctx = events.context(root, brief.job);
    const id = crypto.randomUUID();
    events.append(root, {
      event: 'workflow_start', wf_run: id, job: brief.job, decision_id: ctx.decision_id,
      workflow: brief.workflow, config: brief.config || null, mode: brief.mode || brief.scope || null,
      round: typeof brief.round === 'number' ? brief.round : null, plan: RS.planOf(brief),
    });
    return id;
  } catch {
    return null;
  }
}

// The run this end closes: the latest workflow_start of the job and workflow with no end yet.
function openRun(root, job, workflow, config) {
  let lines;
  try {
    lines = fs.readFileSync(path.join(root, '.factory', 'log', 'events.jsonl'), 'utf8').split('\n');
  } catch {
    return null;
  }
  const ended = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i] || !lines[i].includes('"workflow_')) continue;
    let e;
    try { e = JSON.parse(lines[i]); } catch { continue; }
    if (e.event === 'workflow_end') ended.add(e.wf_run);
    if (e.event !== 'workflow_start' || e.job !== job) continue;
    if (ended.has(e.wf_run)) return null;   // the job's latest run already ended
    if (e.workflow === workflow && (e.config || null) === (config || null)) return e;
    return null;   // the job's latest run is another workflow
  }
  return null;
}

function end(root, { job, workflow, config, outcome, status, error, roster }) {
  try {
    const s = openRun(root, job, workflow, config);
    if (!s) return null;
    const ctx = events.context(root, job);
    events.append(root, {
      event: 'workflow_end', wf_run: s.wf_run, job, decision_id: ctx.decision_id, workflow, config: config || null,
      outcome, status: status || null, error: error ? String(error).slice(0, 300) : null,
      ms: Math.max(0, Date.now() - Date.parse(s.ts)),
      roster: (roster || []).slice(0, 200).map((a) => ({ agent_type: String(a.agent_type || '').slice(0, 60), label: String(a.label || '').slice(0, 120), retry: Boolean(a.retry), outcome: a.outcome ? String(a.outcome).slice(0, 40) : null })),
    });
    return s.wf_run;
  } catch {
    return null;
  }
}

module.exports = { start, end, openRun };
