---
name: console
description: Open the Factory Console, a read-only page that replays every factory job as a flow canvas. It shows stages across and time down, every step forward and every return trip, retries, parks, amendments, cancels and abandons, which agents ran on which model, and inspector findings. Use when the user types /factory:console or asks to see, show or visualise the factory, its jobs, or what the agents did.
argument-hint: "[job id, e.g. J-0003 — optional, to open that job first]"
---
# Factory Console

1. Run `factory console`. It reads `.factory/` without changing anything and writes `.factory/console.html`. Add `--job $ARGUMENTS` only if the user wants a page for that one job; otherwise include every job. The page opens on the job that is waiting for the user first.
2. Tell the user the path from the JSON's `written` field and that they can open it in a browser. If the session can show files to the user, send it. To open a particular job, add `#J-0003` (or that job's id) to the end of the file's URL.
3. In two or three lines, summarise the `jobs` list from the JSON: which jobs wait for them (`waiting`), which are running, parked or closed.
   - If `integrity` is `tampered`, say plainly that some records fail their seal and suggest `/factory:why` for that job.
   - If `integrity` is `not_checked`, say this machine has no factory key, so seals were not checked.

The page shows:
- **Live line.** Pick a job and see it on the flow canvas. Stages are columns and time runs downward; each visit to a step is a row.
  - **Lines.** Moving on is a blue line to the right. Going back is a red line to the left, labelled with why: a fix round, a verify-fix round, prove again, or a denial. A repeated step drops straight down.
  - **Other rows.** Parks, resumes, amendments, cancels and abandons have their own rows.
  - **Each row shows** the agents that ran there: model (O/S/H), run count, retries, failures and escalation. It also shows results, findings, your replies and guard blocks.
  - **Inspector findings** sit in a column on the right, beside the row they cite.
  - **Replay** drives the job down the canvas, with the router's checks at each decision.
- **Recipe map.** The whole factory as a floor plan for any recipe.
- **The crew.** All 19 agents, with how often each ran in these jobs.

## Watching live
If the user wants to watch a job as it runs (or asks for the console while a job is active), serve it instead: run `factory console --serve` **in the background** (it keeps running; with the Bash tool, set `run_in_background`). Its first output line gives the `serving` URL (`http://127.0.0.1:4477/` by default; `--port 0` picks a free port). Give the user that URL. The page then updates by itself as the hooks and the CLI write to `.factory/`, with a pulsing **live** flag: new steps play in if they're watching the latest moment, and their place is kept if they're scrubbing back. It listens on this machine only and is still read-only. Don't start a second one if one is already serving.

Never edit the page or `.factory/` to change what it shows. Re-run `factory console` to refresh a static page.
