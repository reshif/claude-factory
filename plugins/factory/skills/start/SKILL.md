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

## The loop
Repeat until you reach a stop point:

1. Run `factory next` and read `action`. Running it again from the same state is harmless (it returns the same decision, with `requery: true`), but don't poll it: run it when a step is finished or the user has replied.

| action | what you do |
|---|---|
| `skill` | Follow the factory skill named in `skill` (clarify, ship, distill, amend), then go back to step 1. For clarify, `clarify` carries the ledger summary: open issues by owner, the open questions and the exact `answer_commands`. |
| `workflow` | Run it as described under **Running a workflow** below, then go back to step 1. |
| `cli` | Run exactly the `command` shown. Read its JSON. If it failed, show the user the message and run `factory next` again (the CLI decides whether to retry or park). |
| `evidence` | A criterion needs a doc or diff record, not a code change. For each AC in `acs`, check the build (the job worktree) shows it, then run its line in `commands` yourself with the real file path (relative to the repository root). If it isn't there, tell the user and stop. Then go back to step 1. |
| `gate` | Follow **factory:gate**. **Stop** and wait for the user's reply. |
| `wait` | If it lists `ready` slice jobs (epic), run `factory use <first ready id>` and continue the loop on that job. Otherwise tell the user in one or two lines what is being waited for (`reason`) and **stop**. |
| `parked` | Follow **factory:park**. **Stop.** |
| `done` | Summarise in two or three lines what shipped (`factory why --format md` if useful). **Stop.** |

2. Keep the user informed briefly between steps (one line per step is plenty). Don't narrate JSON.

## Running a workflow
1. Build the brief, passing the fields `factory next` gave you (omit the ones it didn't):
   `factory wfargs <workflow> [--config <config>] [--mode <mode>] [--scope <scope>] [--lanes a,b] [--threat-model | --no-threat-model] [--plan-critique] [--accept-degraded]`
   It prints a compact JSON brief (agent instructions live in files it references).
2. Start the workflow **`factory:<workflow>`** with the Workflow tool, passing that JSON, unchanged, as its args.
3. Write the JSON result the workflow returns, unchanged, to `.factory/scratch/envelope.json` and run `factory record --file .factory/scratch/envelope.json`.
4. Act on the record result's `status`:
   - `ok` / `fix` / `retry` / `revise` / `stale` / `error` / `park` → go back to the loop. Nothing for the user here: `factory next` handles retries, fix rounds and parking.
   - Any `needs_user` or `degraded` result from the **clarify** workflow → follow **factory:clarify** ("Read the result"); it owns how questions, revise and retry rounds and degraded angles are handled.
   - `needs_user` with `questions` from **ground** → ask the user exactly those questions, in that order, as one numbered list, then **stop**. When they answer, record each with `factory answer --question "…" --answer "…"` and continue the loop.

**No Workflow tool?** Run the same brief by hand with the Agent tool: start every item of the fan-out in one message (parallel) with `subagent_type` set to the item's `agent_type` (e.g. `factory:researcher`), its `prompt`, and the item's `model` if it has one, requiring JSON that matches its `schema`; retry a failed item once; then do the judge / critique / verifier / builder-tester steps exactly as the workflow script (`workflows/<name>.js`) does, and build the result envelope with the same fields. Record it the same way.

## Rules
- Human gates are the user's. Never approve, deny, resume, waive or confirm on their behalf, and never run those commands (the guard blocks them). The user replies in chat: `approve`, `deny <what must change>`, `resume`, `cancel job`, `abandon job`, `waive <floor> <reason>`, `merged <commit>`, `confirm AC-n`, `accept lesson Ln`, `split U-n <alias>`, and while clarify waits, numbered answers (`1 yes, 2 …`, `defaults`). The reply hook applies them before you see the message.
- During clarify you never edit the contract and never answer for the user: record what the user said with `factory answer`, add context with `factory clarify note`, show `factory clarify status` when they ask what is open, and run `factory next`.
- If the user says the requirements changed, follow **factory:amend**.
- Don't claim the job is done until `factory next` says `done` (the Stop hook checks floors).
- `factory why --format md` explains every routing decision if the user asks why something happened.
