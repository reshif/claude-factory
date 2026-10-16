---
name: distill
description: Turns a merged factory job's confirmed problems into a few scoped lessons for the user to accept or reject. Used by factory:start when `factory next` returns skill distill.
user-invocable: false
---
# Distill

Under `factory drive` the drive runs steps 1 and 3 itself: with nothing worth learning it records distill done; otherwise it stops with `agent` and the context, you do step 2, save the reply to `.factory/scratch/lessons.json` and run `factory drive --lessons .factory/scratch/lessons.json`, and the drive's `done` stop lists what was proposed (step 4).

1. Run `factory distill context`.
2. If `worth_learning` is true (confirmed findings, verify-fix rounds, minor findings that also appear in other jobs, or build trouble: parks, retries, scope violations, a broken environment, integration failures, rebuilds, manual repairs, listed under `trouble`), start the agent named in its `lesson_writer.agent_type` (**factory:lesson-writer**, Agent tool) with: the distill context JSON, the cap (`cap`), the lessons already proposed, the command to record each lesson (`lesson_writer.record_command`, i.e. `factory lessons add --job <job> --text "<lesson>" --scope "<glob>,<glob>" --why "<finding id: what went wrong>"`), and `lesson_writer.reply_schema` as the JSON its final message must match.
   Each lesson becomes a card in `.factory/lessons/lessons.md` (templates/docs/lessons.md).
   Give it the `project_brief` too (.factory/project.md, the brief every later agent reads): it may propose one-line edits to it under `project_brief` in its reply. If there is nothing worth learning, skip the agent.
3. Run `factory distill done`. If the lesson-writer ran, save its reply unchanged to `.factory/scratch/lessons.json` and add `--result .factory/scratch/lessons.json`, so the CLI checks the reply against its schema; if it reports a problem, show it to the user.
4. If lessons were proposed, list them for the user with their ids, together with any project brief proposal `distill done` names (`project_brief.proposal`, P1 …, with its edits): the **end-of-job digest**. One reply settles them all, the parts separated by `;` (the drive's done stop carries the accept-all form under `digest.reply`, e.g. `accept lesson L4; accept lesson L5; accept brief P1`); the user may reject any with **`reject lesson L4 <why>`** / **`reject brief P1 <why>`**, at any time (`factory inbox` lists them). Nothing applies without their reply: nothing changes in the brief until they accept, and an accepted change reaches every later agent. Accepted lessons apply from the next plan, build and review.
5. Continue the loop (`factory drive`, or `factory next`).
