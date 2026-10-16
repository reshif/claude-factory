---
name: clarify
description: Settles a factory job's outcome contract with the user, in a few short stages - a read-back, one research pass pinned to the versions they confirm, one decision sheet, the contract and its readiness check. Used by factory:start when `factory next` returns skill clarify, and whenever a clarify result needs handling.
user-invocable: false
---
# Clarify: settle the outcome contract

Terms such as God Eye, envelope, read-back and decision sheet are defined in `${CLAUDE_PLUGIN_ROOT}/docs/GLOSSARY.md`.

Clarify is a short sequence of stages, each a rule in the factory CLI. Agents run inside the clarify workflow; you never play their part. The user normally types at most one reply before H1: the answer to the decision sheet. The read-back is **shown, not waited on** (it opens the sheet, or H1 when there is no sheet); it waits for the user only when a version pin conflicts, a question only they can answer is on it, or a redirect changed a version (policy `clarify.readback: "wait"` restores the blocking read-back).

| Stage | Who works | What you do |
|---|---|---|
| read-back | the interviewer (one short call) | run it |
| waiting on the read-back (only for a pin conflict or a question only the user can answer) | the user | show the screen, stop, record their reply |
| research | the repo and docs researchers, then the brief writer (one time-boxed pass) | run it |
| waiting on the sheet | the user | show the screen, stop, record their reply |
| interpret | the interviewer, when the sheet answer was plain prose | run it |
| redirect / waiting on the redirect | the interviewer, then the user | run it; show the screen; record their reply |
| contract | the contract writer (again in automatic fix rounds) | run it |
| readiness check | the CLI's checks, then God Eye's fixed checklist | run it |
| dispute | the finding-verifier, on an objection God Eye raised again after the writer had its fix | run it |
| diagnose | God Eye, when the readiness loop stops making progress | run it |

**The readiness loop runs by itself.** A blocker the contract writer can fix from what is settled goes back to it with God Eye's fix, round after round while the open blockers shrink (the shared loop engine, `cli/core/loop.js`): after two rounds without progress the writer runs on a stronger model, then God Eye diagnoses the loop. A blocker only the user can settle becomes one question on the sheet, with options and a recommendation. When the loop stops without converging (no progress, or the ceiling `limits.clarify_writer_rounds`), the contract goes to **H1 with the open objections shown**, never to a park: the user decides there.

## The contract
It lives at `.factory/jobs/<job>/contract.md`. Before the first stage you may draft it from the request (Intent first: Problem, Who, Outcome, Why now, Success signal; then Goal, Non-goals, Acceptance criteria `- AC-1: <observable behaviour> (evidence: test)`, Constraints, Allowed paths, Verify commands ``- `cmd` (AC-1)``, Assumptions) and run `factory contract check`. After that the contract writer writes it from what clarify settled, and the CLI adds its own sections (`## Decisions`, `## Facts relied on`, `## Design may choose`, `## Research gaps`); don't edit those. **The user may edit `contract.md` at any time**; the CLI checks their text again before H1, the next writer keeps their edits, and if an edit takes out what honoured something they said (an AC they deleted) the sheet asks them whether to put it back or leave it out. Don't state facts about the outside world from memory: research settles them against the confirmed versions.

## Each turn
Under `factory drive` (the start skill), the drive does steps 1 and 2's CLI parts itself: it hands you the clarify workflow's brief (stop `workflow`), records its result (`factory drive --record`), and stops with `clarify` (the `screen`) when clarify waits on the user, with `parked` at a cap, or at H1 (`gate`). The status rules below are what it applies; you show what the stop carries.

1. `factory next` returns skill clarify with a `clarify` block: `stage`, and either `run` (agents work) or `waiting_for_user` with a `screen`. If it has `error` (the clarify record fails its seal), say it to the user as given and stop: only their `factory reseal` in their own terminal moves it.
2. **When `run` is set**, run the stage as factory:start runs any workflow ("Running a workflow"): `factory wfargs clarify` → Workflow **`factory:clarify`** with that brief, unchanged → write the result to `.factory/scratch/envelope.json` → `factory record --file .factory/scratch/envelope.json`. Act on the record result's `status`:
   - `needs_user`: clarify now waits on the user. Show its `screen` **as it is** (do not summarise, reorder or add questions) and **stop**.
   - `continue`: run `factory next` again (the next stage runs).
   - `ok`: the readiness loop ended; `factory next` presents H1. With `loop_end` (and `approved: false`, `god_eye_objects` at H1), God Eye did **not** approve: the loop stopped without converging (also on a stronger model, and after God Eye's diagnosis). Say so first; H1 lists the objections and the diagnosis. Writer-fixable objections never reach the user: the contract writer fixes them in automatic rounds while they shrink; a disputed one goes to the finding-verifier once.
   - `park`: clarify parks only when an agent failed twice (it returned nothing): follow factory:park. The user replies `resume` (with words, if they have any). `proceed` remains only for a job parked by an older factory at a cap. Words the user sends while the job is parked are **recorded, never refused** (`factory clarify reply` answers `stored: true`): their own reply resumes the job with them, and clarify reads them back as a redirect. Never type `resume` or `proceed` yourself.
   - `stale`: the record moved on while the stage ran; run `factory next`.
   - When the result lists research failures (`research.failures`), say them in one line; they also appear on the sheet, in the contract's Research gaps and at H1.
3. **When `waiting_for_user` is set**, show the `screen` as it is and **stop**. Your turn ends there.

## Recording the user's reply
The reply hook records a plain `ok` or a structured sheet answer (`ok, but 2 b`, `1 a, 3: other: …`, `2 defer`, `fact 1: <correction>`) by itself and tells you so (`[factory] Recorded your reply for clarify`); don't record it again, run `factory next`. Anything else the user says, record **verbatim**, their whole message as they typed it:

`factory clarify reply "<the user's words>"`

- Anything the user says counts: corrections to the read-back, free prose on the sheet ("whatever's standard, but keep the old names"), a fact they state. The interviewer maps prose to the sheet; it never answers for them.
- Never paraphrase, never shorten, never pick an option for the user, never answer a question they did not answer. The reply hook noted what they typed: words you relay exactly are counted as theirs; anything else is marked at H1 as relayed by you, for the user to check.
- To change direction (at any stage, or at H1 instead of denying): `factory clarify redirect "<the user's words>"`. The interviewer reads it back as tracked items; each one is reported done or not done at H1. A clause that changes what the user said before (a fact, an instruction, a scope line: scope lines are items too) changes that item, and the change is shown ("changed: X → Y because you said …"); a constraint the writer rewords because of it is listed at H1 as a cited change with the user's words quoted, not a drop. Words the interviewer could not map stay as the user's instructions, verbatim.
- The user can always reopen something clarify settled: record what they say with `factory clarify reply`.
- `factory clarify status` prints every item with who decided it, the findings with their source and verdict, the gaps and what was dropped (read-only; show it whenever the user asks what is open).

## What the screens contain
- **Read-back**: what the factory understood (intent, scope, the work type and risk intake chose), the user's own facts quoted, the versions research will use (from a repo file, or from the user's own words), and what research will find out (each tagged repo, docs or decision). When it waits, the user replies ok or says what to change; otherwise it heads the sheet (or H1) as **What I understood**, and anything the user says about it is recorded as a correction.
- **Decision sheet**: the read-back on top when it was not waited on; **Changed by your later words** (the user's later words win over their earlier ones, never silently: "changed: X → Y because you said …"); at most five decisions, each with options, the evidence and a recommendation (a question God Eye or its diagnosis says only the user can answer comes with its options too), then **Facts I'll assume** (with their sources) and any research gaps. One reply answers all of it. Words in the reply the interviewer cannot map to a decision are kept verbatim as the user's instructions, never dropped. A sheet with only facts is not shown (H1 lists them).
- **Redirect read-back**: the user's redirect split into items, each linked to what it changes.

Sources for another version than the one confirmed, or a moving page (stable, latest), are never used as evidence; the sheet lists them as skipped.

## Example
`factory next` carries `clarify: { stage: "readback_wait", waiting_for_user: true, screen: "**Read-back · J-0004 Fix the cart total** …" }`. Show the screen as it is, then stop:

> **Read-back · J-0004 Fix the cart total**
>
> **What you want** (my words; correct me)
> - Problem: shoppers with a discount code see the wrong cart total
> - Outcome: the cart total matches checkout
>
> **What I will find out**
> 1. [repo] Where the cart total is computed
>
> Reply **ok** to start research, or tell me in your own words what to change.

The user replies "ok": the reply hook records it and says so; run `factory drive` (or `factory next`): research runs. The user replies "also round to the cent": run `factory clarify reply "also round to the cent"`, then `factory drive` (the read-back runs again with their words).
