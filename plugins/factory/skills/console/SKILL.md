---
name: console
description: Opens the Factory Console, a read-only web page of every factory job and what its agents did. Use when the user types /factory:console or asks to see, watch or visualise the factory or its jobs. Not for explaining one routing decision (factory:why).
argument-hint: "[job id, e.g. J-0003 — optional, to open that job first]"
---
# Factory Console

1. Run `factory console`. It reads `.factory/` without changing anything and writes `.factory/console.html`. Add `--job $ARGUMENTS` only if the user wants a page for that one job; otherwise include every job. The page opens on the board, with the jobs waiting for the user at the top.
2. Tell the user the path from the JSON's `written` field and that they can open it in a browser. If the session can show files to the user, send it. To open a particular job, add `#J-0003` (or that job's id) to the end of the file's URL. To open the Blueprint (the jobs as an engineering drawing set), add `#blueprint`.
3. In two or three lines, summarise the `jobs` list from the JSON: which jobs wait for them (`waiting`), which are running, parked or closed.
   - If `integrity` is `tampered`, say plainly that some records fail their seal and suggest `/factory:why` for that job.
   - If `integrity` is `not_checked`, say this machine has no factory key, so seals were not checked.

## Explaining the page
When the user asks what something on the page means or how to find something (a tile, the line map, the wire, a job's canvas, the Blueprint's sheets, an unverified finding, filters, keys), read `${CLAUDE_SKILL_DIR}/references/ui-tour.md` and answer from it. Don't read it just to open the page.

## Watching live
If the user wants to watch a job as it runs (or asks for the console while a job is active), serve it instead: run `factory console --serve` **in the background** (it keeps running; with the Bash tool, set `run_in_background`). Its first output line gives the `serving` URL (`http://127.0.0.1:4477/` by default; `--port 0` picks a free port). Give the user that URL and say the page updates by itself as the job runs. It listens on this machine only and is still read-only. Don't start a second one if one is already serving.

Above the board, **Waiting on you** lists what `factory inbox` lists (gates, clarify turns, parks, merges, project brief proposals) with the reply for each, and the last `factory drive` stop. Each agent row links to its transcript (where Claude Code keeps it; served only by `--serve`) with its tool calls and tokens, and a job's page has a **Usage** panel (what the transcripts report; Claude Code reports no cost).

A written file says **snapshot** instead of live. Never edit the page or `.factory/` to change what it shows. Re-run `factory console` to refresh a static page.
