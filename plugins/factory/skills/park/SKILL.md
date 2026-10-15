---
name: park
description: Explains why a factory job is parked and which replies move it on. Used by factory:start when `factory next` returns action parked.
user-invocable: false
---
# Parked

The CLI parked the job (`reason` in the `factory next` output). Parking is how the factory stops instead of guessing: budgets, round caps, no-progress loops, scope drift, conflicts, failed epic gates.

1. Run `factory why --format md` and look at the last few rows to understand how it got here.
2. Tell the user, in a few lines:
   - what stopped it and why (plain words, not the rule id),
   - what you'd suggest (e.g. "one more review round is reasonable — the last round confirmed only one small issue", or "this needs a plan change: T2 needs files outside its paths"),
   - their options, as exact replies:
     - **`resume`** — continue; the cap that stopped it gets one more round (for budgets, +50%; for a serious finding no verifier could settle, one more re-verification: it is never dropped, and it blocks ship until confirmed or refuted; the user may instead settle it: **`dismiss finding <id> <why>`** (not a problem) or **`accept finding <id> <why>`** (a known risk that ships), listed in the completion report)
     - **`cancel job`** or **`abandon job`** — stop for good; files are kept
     - **`waive ci_reverify <reason>`** — only when the CI re-verify floor can't be met (no `factory-gate` workflow and no local merge to re-verify)
     - or tell you what to change (you may then need **factory:amend**).
3. **Stop.** After the hook applies their reply, continue with `factory next`.

## Example
For `reason: "Review rounds used up (2) with confirmed serious findings still open."`:

> **J-0004 is parked.** Two review rounds ran and one confirmed major finding is still open: `src/cart/total.js` rounds before applying the discount (finding code-2).
> I'd suggest one more round — the fix is a one-line change and the last round confirmed nothing else.
> Reply **`resume`** to give the review one more round, **`cancel job`** or **`abandon job`** to stop (files are kept), or tell me what to change.
