---
name: clarify
description: Writes and settles a factory job's outcome contract with the user, asking only what the repo can't answer. Used by factory:start when `factory next` returns skill clarify, and whenever a clarify workflow result needs handling (questions, a revise or retry round, degraded angles, notes).
user-invocable: false
---
# Clarify: write the outcome contract

Terms such as God Eye, envelope, fan-out and clarify ledger are defined in `${CLAUDE_PLUGIN_ROOT}/docs/GLOSSARY.md`.

The contract lives at `.factory/jobs/<job>/contract.md` (`factory job show` prints the job; the path is in the job folder). It has fixed sections the CLI parses: **Intent, Goal, Non-goals, Acceptance criteria, Constraints, Allowed paths, Verify commands, Clarifications (settled), Deferred to design, Assumptions**. The CLI writes the two marked sections (Clarifications (settled), Deferred to design) from the clarify ledger; never edit them yourself.

## Draft (before the first round only)
You write the contract once, before clarify's first round. After that, during clarify, the contract has **one writer**: the clarify workflow's contract editor, through `factory record`. The guard refuses your edits to `contract.md` until H1 is approved; don't work around it.
Write the **Intent** first, then the rest. If the intent isn't clear, nothing below it makes sense.
- **Intent**, one line each: `Problem` (what is wrong or missing today), `Who` (who has it, who asked), `Outcome` (what is true for them when done), `Why now` (optional), `Success signal` (how we'd know it worked, observably). Use the user's words and the intake restatement they confirmed.
- **Goal**: the outcome in one or two sentences — what is true when done, not how. It must agree with the Intent.
- **Acceptance criteria**: one per line, `- AC-1: <observable behaviour> (evidence: test)`. Evidence types: `test`, `run` (a command whose success proves it), `diff`, `doc`, `human` (the user confirms it). Prefer `test`. Epics use `E-AC-1`.
- **Allowed paths**: globs the change may touch, as narrow as you can (`src/cart/**`, `tests/cart/**`).
- **Verify commands**: commands from the repo root that exit non-zero on failure, with the ACs they prove: ``- `npm test -- cart` (AC-1, AC-2)``.
- Non-goals, constraints and assumptions from the request and what you read in the repo. Don't settle how it will be built (exact field names, command syntax, line ranges): design does that.
Answer everything the repo can answer yourself. Then run `factory contract check` and fix every problem it lists (an Intent line still `<…>` is a problem). (For the `bug@low` recipe, also `factory contract check --plan-fields`: it builds straight from the contract, so allowed paths and verify commands are required.)

## The clarify ledger
Clarify keeps one list of issues (`U-n`), owned by the CLI: each question is an issue with a subject, an owner (the user, or design), a status and how it was settled. `factory clarify status` prints it (id, subject, status, owner, next action, and what each round opened and settled); it is read-only and safe to run any time. Show it when the user asks what is open, or when a result is hard to explain.
- **Settled is final.** A settled issue is never asked again, in any wording; agents that raise it again only add a note. If the user says two different issues were folded into one (an alias in `factory clarify status`), they reply `split U-n <alias>` in chat (or run `factory clarify split U-n <alias>` in their own terminal); it is human-only.
- **Design's, not yours.** Implementation details are deferred to design (`## Deferred to design`) and never block H1. Don't ask the user about them.
- **Never improvise edits or answers.** Don't edit the contract, don't answer for the user. If something looks wrong, add context with `factory clarify note <U-n|contract> "…"` and run `factory next`.

## The question protocol (the CLI enforces it)
- **Order**: intent → scope → constraint → acceptance. The intent analyst runs first and alone; while any intent question is open, only intent questions are asked and the other angles wait.
- **How many**: round 1 at most **5**, later rounds at most **3**; extra ones wait for the next round.
- **Form**: each question has an id (`Q-3`), the issue it is for (`U-n`), a category, why it matters, options when possible, and the default the factory uses if it stays unanswered.
- **Defaults**: a question the user skips takes its default next round; a question with no default (an intent question, "your call") stays open until they answer it. Intent never defaults: still unclear after 2 rounds of intent questions, the job parks.
- **Progress, not rounds**: clarify parks when rounds stop settling anything (`limits.clarify_no_progress_rounds`, default 2) or at its ceiling (`limits.max_intent_rounds`, default 10). `resume` gives it more room.

## Round
1. Run the clarify fan-out the way factory:start runs any workflow (its "Running a workflow" steps):
   `factory wfargs fanout-judge --config clarify` → Workflow `factory:fanout-judge` → write the envelope → `factory record --file .factory/scratch/envelope.json`.
2. Read the result. This list is the one place these outcomes are handled; act on the record result's `status`:
   - `needs_user` with `questions`: ask them as **one numbered list**, in the order given, each on one line: id, question, options (if any) and `(default: …)`. Never add questions, split one into several, or re-ask an answered one. If `intent_first` is true, say in one line that other questions wait until the intent is settled. Questions marked `waiting` were asked before and still need an answer. Then say once how to answer: a numbered reply (`1 yes, 2 …`, `skip 2`), or `defaults` to accept every default. **Stop.**
     The reply hook records a numbered reply itself and tells you so; don't record it again. When the user answers in their own words instead, record each answer with `factory answer Q-n "<answer>"` (`factory answer Q-n --default` accepts the default). Never record an answer the user didn't give. If `factory answer --question "…"` says `no_match`, use the id it lists. Don't edit the contract: run `factory next` — clarify runs again with the answers and its contract editor writes them in.
   - `revise`: the contract still has problems or God Eye's items with nothing to ask the user; don't fix it by hand. Say in one line that clarify runs again, then `factory next`.
   - `retry`: an analyst failed in this round; it doesn't count and runs again once by itself. Say so in one line, then `factory next`.
   - `degraded` (analysts failed in two rounds in a row): ask the user: re-run, or go on without that angle. **Stop.** To go on, run the round again with `factory wfargs fanout-judge --config clarify --accept-degraded`.
   - `park`: clarify stopped (no progress, or the intent is still unclear). Follow factory:park; `factory clarify status` shows what is open.
   - `ok`: God Eye approved and confirmed the intent (`notes` are its approve-with-notes remarks). Tell the user its one-line restatement (problem → outcome), then return to the loop; `factory next` will present gate H1.

## Example
A round-1 result `needs_user` with two questions (`intent_first: false`) is shown as:

> Two questions before I finish the contract:
> 1. **Q-1** (scope) Should the discount also apply to items already on sale? Options: yes / no. (default: no)
> 2. **Q-2** (acceptance) How close must the cart total be to the checkout price? Options: exactly / within one cent. (default: exactly)
>
> Reply with the numbers (`1 yes, 2 exactly`), `skip 2` to take a default, or `defaults`.

The user replies "1 yes, skip 2": the reply hook records Q-1 = yes (Q-2 takes its default next round) and tells you; run `factory next`.
