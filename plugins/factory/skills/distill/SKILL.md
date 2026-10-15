---
name: distill
description: Turns a merged factory job's confirmed problems into a few scoped lessons for the user to accept or reject. Used by factory:start when `factory next` returns skill distill.
user-invocable: false
---
# Distill

1. Run `factory distill context`.
2. If it shows confirmed findings, verify-fix rounds, or minor findings that also appear in other jobs, start the agent named in its `lesson_writer.agent_type` (**factory:lesson-writer**, Agent tool) with: the distill context JSON, the cap (`cap`), the lessons already proposed, the command to record each lesson (`lesson_writer.record_command`, i.e. `factory lessons add --job <job> --text "<lesson>" --scope "<glob>,<glob>" --why "<finding id: what went wrong>"`), and `lesson_writer.reply_schema` as the JSON its final message must match.
   Each lesson becomes a card in `.factory/lessons/lessons.md` (templates/docs/lessons.md).
   If there is nothing worth learning, skip the agent.
3. Run `factory distill done`. If the lesson-writer ran, save its reply unchanged to `.factory/scratch/lessons.json` and add `--result .factory/scratch/lessons.json`, so the CLI checks the reply against its schema; if it reports a problem, show it to the user.
4. If lessons were proposed, list them for the user with their ids and say they can reply **`accept lesson L4`** or **`reject lesson L4 <why>`** at any time. Accepted lessons apply from the next plan, build and review.
5. Continue the loop (`factory next`).
