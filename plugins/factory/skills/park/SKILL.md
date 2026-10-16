---
name: park
description: Explains why a factory job is parked and which replies move it on. Used by factory:start when `factory next` returns action parked.
user-invocable: false
---
# Parked

The CLI parked the job (`reason` in the `factory next` output). Parking is how the factory stops instead of guessing: budgets, round caps, no-progress loops, scope drift, conflicts, failed epic gates.

The park is typed: `park.kind` names the cause (budget, scope_violation, review_rounds, verify_fix_rounds, unverified_finding, integration, needs_paths, dependency_conflict, regression, environment_broken, task_exhausted, clarify, …), `park.next` the step that moves it on and, for a loop or the budget, **`park.question`** with `options` and a `recommendation`; all are in the `factory next` output (and in the drive's `parked` stop). Before it parks, the factory already tried what a program can: a task whose dependencies did not merge was rebuilt once on the integrated branch, a reconcile regression was rebuilt once on the merged code, files changed outside the allowed paths were reverted once, an exhausted task got one escalated attempt, and a loop (review-fix, verify-fix, the integrator) ran while its open problems shrank, then on a stronger model, then was diagnosed by God Eye: the park's `question` is that diagnosis's, never a bare "resume".

1. Run `factory why --format md` and look at the last few rows (each park row shows its kind, its reason and the suggested next step) to understand how it got here.
2. Tell the user, in a few lines:
   - what stopped it and why (plain words, not the rule id),
   - what you'd suggest (e.g. "one more review round is reasonable — the last round confirmed only one small issue", or "this needs a plan change: T2 needs files outside its paths"),
   - the park's **`question`**, its options and the recommendation, as given;
   - their options:
     - **an answer to the question in their own words** (an option's letter, `b: …`, or words about it) — it resumes the job, and every agent that works on it next gets their words (the loop starts a new round with them). A message that does not answer it is stored, and the `[factory]` note asks you to ask them once: *Use this as your answer to "<question>"? reply yes*. Ask exactly that; never resume it yourself, and never ask them for a confirmation code. A question to you ("why is it parked?") is not a reply. In a terminal: `factory resume --job <id> <their words>`.
     - **`resume`** — continue without words (a loop starts a new segment). **The budget is absolute:** a budget park needs the grant in the reply — **`resume +50%`**, **`resume +100%`** (or the budget question's option `a` / `b`); a bare `resume` is refused and nothing changes.
     - **`cancel job`** or **`abandon job`** — stop for good; files are kept
     - **`waive ci_reverify <reason>`** — only when the CI re-verify floor can't be met (no `factory-gate` workflow and no local merge to re-verify)
     - or tell you what to change (you may then need **factory:amend**). For `needs_paths` or `dependency_conflict` that is the usual fix: an amendment that gives the task its paths or a dependency. An amendment submitted while the job is parked is shown as gate A (`factory next` or `factory drive`); approving it also resumes the job, exactly as `resume` would (a budget park stays parked: only `resume +N%` grants more), so no separate `resume` is needed.
3. **Stop.** After the hook applies their reply, continue with `factory drive` (or `factory next`).

## Example
For a review-fix loop that stopped:

> **J-0004 is parked:** the same confirmed review finding (an unchecked null in `src/cart/total.js`) survived three fix rounds, the last on a stronger model. God Eye's diagnosis: the contract says totals may be empty, the finding says they may not.
> Its question: *Can a cart total be empty?* a) yes, return 0 (recommended) · b) no, reject it.
> Reply with your answer in your own words (it resumes the job with them), **`cancel job`** or **`abandon job`** to stop (files are kept), or tell me what to change.
