'use strict';
// Stop gate: no claiming a job is done while its floors fail.

const { safe, emit, findRoot } = require('./lib');

const CLAIM = /\b(all done|ready to (merge|ship)|(job|feature|fix|change|work|implementation|task|pr)s?\b[^.\n]{0,40}\b(is|are)\s+(now\s+)?(done|complete|completed|finished|ready))\b/i;

safe((input) => {
  if (input.stop_hook_active) return;
  const root = findRoot(input.cwd || process.cwd());
  if (!root) return;
  const msg = String(input.last_assistant_message || '');
  if (!CLAIM.test(msg)) return;
  const job = require('../cli/core/job');
  const id = job.current(root);
  if (!id) return;
  const state = job.load(root, id);
  if (state.status !== 'active') return;
  const steps = require('../cli/core/steps');
  const floors = require('../cli/core/floors');
  const ctx = steps.context(root, state, job.load);
  if (ctx.recipe.outcome !== 'change') return;
  // Merging is the human's step: before it, only pre-ship floors can be owed by Claude.
  const mode = state.pr && state.pr.merged ? 'full' : 'before_ship';
  const r = floors.evaluate(ctx, mode);
  if (r.ok) return;
  require('../cli/core/events').append(root, { event: 'stop_block', job: state.id, missing: r.missing });
  emit({
    decision: 'block',
    reason: `[factory] ${state.id} is not done: floors not met (${r.missing.join(', ')}). Run \`factory next\` and keep going, or tell the user exactly what is still pending instead of calling it done.`,
  });
});
