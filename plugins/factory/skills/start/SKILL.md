---
name: start
description: Runs the Software Factory, which takes a request to a verified, merged change through an approved contract, evidence and human gates. Use when the user types /factory:start, asks the factory to build, fix or change something, or wants to continue the current factory job. Not for ordinary coding requests that don't ask for the factory.
argument-hint: "[what you want built or fixed — leave empty to continue the current job]"
---
# Software Factory — driver

You run the factory loop. **The `factory` CLI decides every next step; you carry it out.** Never pick the next step yourself, never skip one, and never write factory state by hand (the guard hook blocks it anyway).

The CLI is on your PATH as `factory` (from this plugin's `bin/`). If it isn't, use `node <plugin root>/bin/factory`. Every command prints JSON. Words such as recipe, floor, gate, park, brief, envelope and God Eye are defined once in `${CLAUDE_PLUGIN_ROOT}/docs/GLOSSARY.md`; read it only if one of them is unclear.

## Setup (once per repo)
- Run `factory doctor`. If it says not initialized, run `factory init` and tell the user in one line what it set up (`.factory/` kept out of git, a commit-msg hook that adds `Factory-Job` trailers).
- If doctor reports errors (no commits, no git identity), tell the user how to fix them and stop.

## New request or continue?
- If the user gave a request (`$ARGUMENTS` or their message) and there is no active job for it: follow the **factory:intake** skill to create the job.
- Otherwise continue the current job.

## The loop: `factory drive`
`factory drive` steps the job for you: every CLI step the router asks for, each workflow's brief and its record, ship, distill's bookkeeping, the epic's slice switches and the evidence records it can check. It never starts an agent (the Workflow tool and subagents are yours) and never answers for the user. It returns one JSON **stop**: either a hand-off (something only you can run) or a point where the user is needed, and each of those also sends the user a desktop notification. Run it with your shell tool's longest timeout (10 minutes); it returns before that (`--max-seconds`, 480 by default).

1. Run `factory drive`. Read `kind`. If the stop carries `environment` (no build environment is confirmed for this repository), show its `message` once; at a gate the gate skill shows the proposal in full. Never confirm it yourself: its setup runs on the user's machine.
2. Act on `kind`:

| kind | what you do | then |
|---|---|---|
| `workflow` | Start the Workflow **`factory:<workflow>`** with the stop's `args` (the brief), unchanged. Write the JSON result the workflow returns, unchanged, to `.factory/scratch/envelope.json`, then run `factory drive --record .factory/scratch/envelope.json` (the `then` field). No Workflow tool: see **Running a workflow by hand** below. | read the new stop |
| `agent` | The distill step has something to learn: start **factory:lesson-writer** (Agent tool; its `model` is in `context.lesson_writer.model` when there is one) with the stop's `context` (the distill context JSON, its cap, the lessons already proposed, the record command and reply schema), as the **distill** skill says. Save its final message, unchanged, to `.factory/scratch/lessons.json` and run `factory drive --lessons .factory/scratch/lessons.json`. | read the new stop |
| `evidence` | For each AC in `acs`, check the job worktree shows it, then run its line in `commands` with the real path (relative to the repository root). If it isn't there, tell the user and **stop**. | `factory drive` |
| `skill` | Follow the factory skill named in `skill`. | `factory drive` |
| `yield` | The drive used its time budget between steps. | `factory drive` |
| `gate` | Follow **factory:gate** with the stop's `next` (it carries the gate, `clarify_h1` and `environment`). If the stop has `recorded` from the clarify workflow with `approved: false` and `god_eye_objects`, say first that God Eye did not approve. | **stop** |
| `clarify` | Show the stop's `screen` **as it is** (the **factory:clarify** skill says how to record what the user says). If `recorded.research.failures` lists research failures, say them in one line. | **stop** |
| `questions` | Ask exactly the `questions`, in order, as one numbered list. When they answer, record each with `factory answer --question "…" --answer "…"`. | **stop**, then `factory drive` |
| `parked` | Follow **factory:park**: `next.reason`, `park.kind` and `park.next` (the suggested step). | **stop** |
| `wait` | Say in one or two lines what is awaited (`summary`; after a ship, the **factory:ship** skill's PR link or local merge commands, from `ship`). | **stop** |
| `amend` | Follow **factory:amend**. | `factory drive` |
| `ship` | `policy.drive.stop_before_ship` is on: every pre-ship floor is met and the push, PR or local merge waits for the user. Run `factory report` and show its summary; when the user says to ship, follow **factory:ship**. | **stop**, then `factory drive` |
| `done` | Summarise in two or three lines what shipped (`factory why --format md` if useful); list any `lessons` and `briefs` the user can accept (`accept lesson Ln`, `accept brief Pn`). | **stop** |
| `error`, `limit` | Show the `summary`. `factory why --format md` explains the last decisions. | **stop** |

3. After the user replies to a stop (the reply hook applies `approve`, `ok`, `resume`, …), run `factory drive` again: it continues from where the job is. Between stops, one short line to the user is plenty; don't narrate JSON. A stop the user must answer ends your turn; a hand-off never does (the stop hook sends you back if you claim the job is done while floors are unmet).

`factory next` while a drive runs answers `driving`: don't run it alongside one. `factory drive status` shows the last stop; **`factory inbox`** lists everything waiting on the user across jobs, each with the reply and the terminal command. Suggest it when the user asks what is waiting, or when several jobs are open.

## Running a workflow by hand
**No Workflow tool?** Run the same brief by hand with the Agent tool: start every item of the fan-out in one message (parallel) with `subagent_type` set to the item's `agent_type` (e.g. `factory:researcher`), its `prompt`, and the item's `model` if it has one, requiring JSON that matches its `schema`; retry a failed item once; then do the judge / critique / verifier / builder-tester steps exactly as the workflow script (`workflows/<name>.js`) does (realize: a task starts once its dependencies are integrated, and no attempt starts while an integration runs or is repaired), and build the result envelope with the same fields. Record it the same way (`factory drive --record`).

## Without `factory drive`
The drive is a convenience over the same CLI. Stepping by hand works too: run `factory next`, do what `action` says (`skill`: the factory skill named; `workflow`: build the brief with `factory wfargs <workflow>` and the fields `factory next` gave (`--config`, `--mode`, `--scope`, `--lanes a,b`, `--threat-model` or `--no-threat-model`, `--plan-critique`), run it as above, write the result to `.factory/scratch/envelope.json` and run `factory record --file .factory/scratch/envelope.json`; `cli`: run exactly the `command`; `evidence`, `gate`, `parked`, `done` as in the table; `wait`: with `ready` slice jobs run `factory use <first ready id>` and continue on that job), then `factory next` again. Running it again from the same state is harmless (it returns the same decision, with `requery: true`), but don't poll it.

## Rules
- Human gates are the user's. Never approve, deny, resume, proceed, waive or confirm on their behalf, and never run those commands (the guard blocks them). The user replies in chat: `approve`, `deny <what must change>`, `resume`, `proceed` (go on from a clarify cap with the gaps shown), `cancel job`, `abandon job`, `waive <floor> <reason>`, `merged <commit>`, `confirm AC-n`, `accept lesson Ln`, `accept brief Pn`, `dismiss finding <id> <why>`, `accept finding <id> <why>`, `confirm environment <hash|none>`, and while clarify waits, `ok` or a structured sheet answer (`ok, but 2 b`, `fact 1: …`). The reply hook applies them before you see the message.
- When the user has to run a human-only command themselves (`factory approve`, `factory resume`, `factory reseal`, …), say: "run this in your own terminal; it will ask you to type a code shown there." Never ask them for that code, never ask them to paste it here, and never accept "it's done" in its place: run `factory next` to see what was applied.
- During clarify you never research on your own and never answer for the user: record what they said, verbatim, with `factory clarify reply "…"` (or `factory clarify redirect "…"` when they change direction), show `factory clarify status` when they ask what is open, and run `factory next`. The user may edit `contract.md` themselves; the CLI checks it again.
- If the user says the requirements changed, follow **factory:amend**.
- Don't claim the job is done until `factory next` says `done` (the Stop hook checks floors).
- `factory why --format md` explains every routing decision and every park (its kind and suggested next step) if the user asks why something happened.
- Never answer a gate, a clarify turn or a park for the user, and never type their replies (`approve`, `ok`, `resume`, `proceed`) yourself: `factory drive` stops there so the user can answer.
