---
name: clarify
description: Factory clarify — draft the outcome contract, run the clarify fan-out (three analysts, a judge, then God Eye), ask the user only what the repo can't answer, and loop until God Eye approves. Used by factory:start when `factory next` returns skill clarify.
user-invocable: false
---
# Clarify: write the outcome contract

The contract lives at `.factory/jobs/<job>/contract.md` (`factory job show` prints the job; the path is in the job folder). It has fixed sections the CLI parses: **Goal, Non-goals, Acceptance criteria, Constraints, Allowed paths, Verify commands, Assumptions**.

## Draft (first round)
Replace every `<…>` placeholder:
- **Goal**: the outcome in one or two sentences — what is true when done, not how.
- **Acceptance criteria**: one per line, `- AC-1: <observable behaviour> (evidence: test)`. Evidence types: `test`, `run` (a command whose success proves it), `diff`, `doc`, `human` (the user confirms it). Prefer `test`. Epics use `E-AC-1`.
- **Allowed paths**: globs the change may touch, as narrow as you can (`src/cart/**`, `tests/cart/**`).
- **Verify commands**: commands from the repo root that exit non-zero on failure, with the ACs they prove: ``- `npm test -- cart` (AC-1, AC-2)``.
- Non-goals, constraints and assumptions from the request and what you read in the repo.
Answer everything the repo can answer yourself. Then run `factory contract check` and fix every problem it lists. (For the `bug@low` recipe, also `factory contract check --plan-fields`: it builds straight from the contract, so allowed paths and verify commands are required.)

## Round
1. Run the clarify fan-out as described in factory:start section 3:
   `factory wfargs fanout-judge --config clarify` → Workflow `factory:fanout-judge` → write the envelope → `factory record --file .factory/scratch/envelope.json`.
2. Read the result:
   - `needs_user` with `questions`: ask the user those questions, numbered, short. **Stop.** When they answer, update the contract (only the contract), run `factory contract check`, and run `factory next` again — it routes back here for the next round.
   - `needs_user` with `critique`: God Eye asked for revisions. Fix what you can from the repo; ask the user only what you can't; then `factory next`.
   - `degraded`: an analyst failed twice — ask: re-run, or go on without that angle. To go on, add the missing angle under Assumptions and run the round again with `factory wfargs fanout-judge --config clarify --accept-degraded`.
   - `ok`: God Eye approved. Return to the loop; `factory next` will present gate H1.

Never re-ask a question the user already answered. The CLI caps rounds and parks a contract that isn't converging.
