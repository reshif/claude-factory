---
name: clarify
description: Settles a factory job's outcome contract with the user, in a few short stages - a read-back, one research pass pinned to the versions they confirm, one decision sheet, the contract and its readiness check. Used by factory:start when `factory next` returns skill clarify, and whenever a clarify result needs handling.
user-invocable: false
---
# Clarify: settle the outcome contract

Terms such as God Eye, envelope, read-back and decision sheet are defined in `${CLAUDE_PLUGIN_ROOT}/docs/GLOSSARY.md`.

Clarify is a short sequence of stages, each a rule in the factory CLI. Agents run inside the clarify workflow; you never play their part. The user normally types two short replies: **ok** on the read-back, and one answer to the decision sheet.

| Stage | Who works | What you do |
|---|---|---|
| read-back | the interviewer (one short call) | run it |
| waiting on the read-back | the user | show the screen, stop |
| research | the repo and docs researchers, then the brief writer (one time-boxed pass) | run it |
| waiting on the sheet | the user | show the screen, stop |
| interpret | the interviewer, when the sheet answer was plain prose | run it |
| redirect / waiting on the redirect | the interviewer, then the user | run it; show the screen; stop |
| contract | the contract writer | run it |
| readiness check | the CLI's checks, then God Eye's fixed checklist | run it |

## The contract
It lives at `.factory/jobs/<job>/contract.md`. Before the first stage you may draft it from the request (Intent first: Problem, Who, Outcome, Why now, Success signal; then Goal, Non-goals, Acceptance criteria `- AC-1: <observable behaviour> (evidence: test)`, Constraints, Allowed paths, Verify commands ``- `cmd` (AC-1)``, Assumptions) and run `factory contract check`. After that the contract writer writes it from what clarify settled, and the CLI adds its own sections (`## Decisions`, `## Facts relied on`, `## Design may choose`, `## Research gaps`); don't edit those. **The user may edit `contract.md` at any time**; the CLI checks their text again before H1, the next writer keeps their edits, and if an edit takes out what honoured something they said (an AC they deleted) the sheet asks them whether to put it back or leave it out. Don't state facts about the outside world from memory: research settles them against the confirmed versions.

## Each turn
Under `factory drive` (the start skill), the drive does steps 1 and 2's CLI parts itself: it hands you the clarify workflow's brief (stop `workflow`), records its result (`factory drive --record`), and stops with `clarify` (the `screen`) when clarify waits on the user, with `parked` at a cap, or at H1 (`gate`). The status rules below are what it applies; you show what the stop carries.

1. `factory next` returns skill clarify with a `clarify` block: `stage`, and either `run` (agents work) or `waiting_for_user` with a `screen`. If it has `error` (the clarify record fails its seal), say it to the user as given and stop: only their `factory reseal` in their own terminal moves it.
2. **When `run` is set**, run the stage as factory:start runs any workflow ("Running a workflow"): `factory wfargs clarify` → Workflow **`factory:clarify`** with that brief, unchanged → write the result to `.factory/scratch/envelope.json` → `factory record --file .factory/scratch/envelope.json`. Act on the record result's `status`:
   - `needs_user`: clarify now waits on the user. Show its `screen` **as it is** (do not summarise, reorder or add questions) and **stop**.
   - `continue`: run `factory next` again (the next stage runs).
   - `ok`: the contract passed its readiness check; `factory next` presents H1. With `approved: false` and `god_eye_objects`, God Eye did **not** approve (the user chose to proceed over its objections): say so first; H1 lists them.
   - `park`: follow factory:park. The `park_reason` names what failed or which cap was reached. The user replies `resume` for one more try, or, at a research, contract or readiness cap (never after an agent failure), `proceed` to go on with the gaps shown. Both are the user's words: never type them yourself. While the job is parked, `factory clarify reply` and `redirect` are refused: tell the user their words wait until they resume or proceed.
   - `stale`: the record moved on while the stage ran; run `factory next`.
   - When the result lists research failures (`research.failures`), say them in one line; they also appear on the sheet, in the contract's Research gaps and at H1.
3. **When `waiting_for_user` is set**, show the `screen` as it is and **stop**. Your turn ends there.

## Recording the user's reply
The reply hook records a plain `ok` or a structured sheet answer (`ok, but 2 b`, `1 a, 3: other: …`, `2 defer`, `fact 1: <correction>`) by itself and tells you so (`[factory] Recorded your reply for clarify`); don't record it again, run `factory next`. Anything else the user says, record **verbatim**, their whole message as they typed it:

`factory clarify reply "<the user's words>"`

- Anything the user says counts: corrections to the read-back, free prose on the sheet ("whatever's standard, but keep the old names"), a fact they state. The interviewer maps prose to the sheet; it never answers for them.
- Never paraphrase, never shorten, never pick an option for the user, never answer a question they did not answer. The reply hook noted what they typed: words you relay exactly are counted as theirs; anything else is marked at H1 as relayed by you, for the user to check.
- To change direction (at any stage, or at H1 instead of denying): `factory clarify redirect "<the user's words>"`. The interviewer reads it back as tracked items; each one is reported done or not done at H1.
- The user can always reopen something clarify settled: record what they say with `factory clarify reply`.
- `factory clarify status` prints every item with who decided it, the findings with their source and verdict, the gaps and what was dropped (read-only; show it whenever the user asks what is open).

## What the screens contain
- **Read-back**: what the factory understood (intent, scope), the user's own facts quoted, the versions research will use (from a repo file, or from the user's own words), and what research will find out (each tagged repo, docs or decision). The user replies ok or says what to change.
- **Decision sheet**: at most five decisions, each with options, the evidence and a recommendation, then **Facts I'll assume** (with their sources) and any research gaps. One reply answers all of it.
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
