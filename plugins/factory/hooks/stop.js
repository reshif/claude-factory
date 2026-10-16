'use strict';
// Stop gate: no claiming a job is done while its floors fail. Checks every active
// change job the session is on: the current one, the worktree's, and any J-#### named.
// A job that is waiting on the human (a pending gate, a clarify screen, unanswered ground questions,
// a record that asked for the user since the last factory next, a wait decision) is
// skipped: Claude is right to stop there, whatever words its summary uses.

const fs = require('fs');
const path = require('path');

const { safe, emit, findRoot } = require('./lib');

const THING = '(?:job|feature|fix|bug ?fix|change|changes|work|implementation|task|pr|pull request|refactor|patch|migration|update)';
const CLAIM = new RegExp([
  '\\b(?:all|everything(?: is| has been)?|we\'re|we are|i\'m|i am)\\s+(?:now\\s+)?(?:done|finished|complete|set)\\b',
  '\\bready (?:to|for) (?:merge|ship|review|go)\\b',
  `\\b${THING}s?\\b[^.\\n]{0,40}\\b(?:is|are|has been|have been|'s)\\s+(?:now\\s+)?(?:fully\\s+)?(?:done|complete|completed|finished|ready|shipped|merged|implemented)\\b`,
  `\\b(?:i|we)(?:'ve| have)?\\s+(?:now\\s+)?(?:fully\\s+|successfully\\s+)?(?:completed|finished|wrapped up|shipped|implemented|delivered)\\s+(?:the|this|your|all|that)\\b`,
  '\\b(?:that|this|it)(?:\'s| is)\\s+(?:now\\s+)?(?:all\\s+)?(?:done|complete|finished|shipped)\\b',
  '^\\s*(?:done|shipped|complete|finished)\\s*[.!]*\\s*$',
  '\\b(?:has been|is now|now) shipped\\b',
].join('|'), 'i');
// Questions, conditionals and negations next to the claim are not claims.
const QUESTION = /\?\s*$/;
const CONDITIONAL = /^\W*(?:once|when|after|until|if|before|as soon as)\b/i;
const NEGATION = /\b(?:not|never|no longer|nothing|yet to|almost|nearly)\b|n't\b/i;

function claims(msg) {
  return String(msg || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .some((s) => {
      const m = CLAIM.exec(s);
      if (!m || QUESTION.test(s) || CONDITIONAL.test(s) || /\b(?:once|when|if|until|after|before|whether)\s+(?:the\s+)?$/i.test(s.slice(0, m.index))) return false;
      return !NEGATION.test(s.slice(Math.max(0, m.index - 25), m.index + m[0].length));
    });
}

const WAIT_ACTIONS = new Set(['wait', 'gate', 'parked', 'done', 'questions']);

// The last `factory record` and `factory next` for a job, from the tail of the event log.
function lastCli(root, jobId) {
  const out = { record: null, next: null };
  let lines = [];
  try {
    const f = path.join(root, '.factory', 'log', 'events.jsonl');
    const st = fs.statSync(f);
    const len = Math.min(st.size, 2 * 1024 * 1024);
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    lines = buf.toString('utf8').split('\n');
  } catch {
    return out;
  }
  for (let i = lines.length - 1; i >= 0 && !(out.record && out.next); i--) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (e.event !== 'cli' || e.job !== jobId) continue;
    if (e.cmd === 'record' && !out.record) out.record = { ...e, i };
    if (e.cmd === 'next' && !out.next) out.next = { ...e, i };
  }
  return out;
}

// Why the human is the one to act on this job, or null.
function waitingOnHuman(root, state) {
  if (state.status !== 'active') return `job is ${state.status}`;
  if (state.pending_gate) return `waiting at ${state.pending_gate.id}`;
  const lastAction = String(state.last_decision || '').split(':')[0];
  if (WAIT_ACTIONS.has(lastAction)) return `last factory next said ${lastAction}`;
  const { readJson } = require('../cli/lib/util');
  const { jobPaths } = require('../cli/lib/paths');
  const ledger = require('../cli/core/ledger');
  const answers = readJson(jobPaths(root, state.id).answers, []) || [];
  const answeredQs = new Set(answers.map((a) => a.question));
  // clarify v3: a read-back, a decision sheet or a redirect read-back waiting on the user
  const clarifyWait = require('../cli/core/clarify').waitingForUser(root, state);
  if (clarifyWait) return clarifyWait;
  const ground = ledger.lastStep(root, state.id, 'ground');
  const blocking = ground && !ground.ok && ground.detail ? (ground.detail.blocking || []).filter((q) => !answeredQs.has(q)) : [];
  if (blocking.length) return `${blocking.length} blocking question(s) from ground unanswered`;
  const cli = lastCli(root, state.id);
  if (cli.record && ['needs_user', 'degraded', 'park'].includes(cli.record.status) && (!cli.next || cli.next.i < cli.record.i)) return `last factory record asked for the user (${cli.record.status})`;
  return null;
}

if (require.main === module) safe((input) => {
  if (input.stop_hook_active) return;
  const cwd = input.cwd || process.cwd();
  const root = findRoot(cwd);
  if (!root) return;
  const msg = String(input.last_assistant_message || '');
  if (!claims(msg)) return;
  const job = require('../cli/core/job');
  const ids = new Set();
  const cur = job.current(root);
  if (cur) ids.add(cur);
  const wt = cwd.match(/\.factory[\\/]worktrees[\\/](J-\d+)/);
  if (wt) ids.add(wt[1]);
  for (const m of msg.matchAll(/\bJ-\d{4,}\b/g)) ids.add(m[0]);
  const steps = require('../cli/core/steps');
  const floors = require('../cli/core/floors');
  const events = require('../cli/core/events');
  const blocked = [];
  for (const id of ids) {
    let state;
    try {
      state = job.load(root, id);
    } catch {
      continue; // named but not a job here
    }
    if (!state || state.status !== 'active') continue;
    const ctx = steps.context(root, state, job.load);
    if (ctx.recipe.outcome !== 'change') continue;
    // Merging is the human's step: before it, only pre-ship floors can be owed by Claude.
    const r = floors.evaluate(ctx, state.pr && state.pr.merged ? 'full' : 'before_ship');
    if (r.ok) continue;
    if (waitingOnHuman(root, state)) continue;
    events.append(root, { event: 'stop_block', job: state.id, missing: r.missing, decision_id: state.last_decision_id || null });
    blocked.push(`${state.id} (${r.missing.join(', ')})`);
  }
  if (!blocked.length) return;
  emit({
    decision: 'block',
    reason: `[factory] Not done: floors not met for ${blocked.join('; ')}. Run \`factory next\` and keep going, or tell the user exactly what is still pending instead of calling it done.`,
  });
});

module.exports = { claims, waitingOnHuman };
