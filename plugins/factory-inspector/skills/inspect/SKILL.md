---
name: inspect
description: Audits the Software Factory against each job's declared recipe and its own health, and explains open findings. Use when the user types /factory-inspector:inspect, asks if the factory is behaving, or asks about inspector findings. Not for code review.
argument-hint: "[job id | all | active | health | status]"
---
# Inspect the factory

The inspector is an independent auditor. It reads the factory's sealed records and each job's **declared rulebook** (`recipe.lock.json`: the recipe, floors and selection rules the job promised to follow) and checks what happened against it. It never blocks, approves or changes anything.

## Run
- `$ARGUMENTS` empty → `factory-inspect run` (closed jobs not yet inspected).
- A job id → `factory-inspect run --job <id>`; also show `factory-inspect trace --job <id>` if the user wants the timeline.
- `all` → `factory-inspect run --all`.
- `active` → `factory-inspect run --active` (closed jobs not yet inspected, plus every active or parked job as it stands now). Use it when the user asks how a running job is going, or reports trouble mid-job.
- `health` → `factory-inspect health --format md` only.
- `status` → `factory-inspect status` only (modes, clean streaks, suggestions).

Then show `factory-inspect report --format md` (open findings, then a **Factory health** section).

## Explain the findings
Group them by class (**deviation**, **ambiguity**, **gap**), highest severity first, in plain words. For each, give the evidence (decision ids, job) and the inspector's question, and say what you think the likely cause is when the records support it and what would fix it (a skill wording, a recipe version bump, a cap change) — but **don't change recipes, floors, policy or skills**; those are the user's.

Before explaining any finding, read `${CLAUDE_SKILL_DIR}/references/findings-guide.md`: what each class covers, how to weigh the health rules (a failed guard, Stop or prompt hook is high severity), and what to say about intent parks and dropped questions. Skip it when the report has no open findings.

## The user decides
They reply, and the inspector's hook applies it:
- `ack finding F3` — seen, being dealt with
- `fixed finding F3` — fixed; if it's seen again it reopens automatically
- `wontfix finding F3 <why>` — accepted as is
- `inspect mode <recipe|all> on|off|sample <N>` — how often to inspect

Thresholds (`limits`) and switched-off rules (`rules_off`) are the user's to edit in `.factory/inspect/config.json`; suggest a change, don't make it.

Never run `factory-inspect mark` or `factory-inspect mode` yourself (they're human-only, and blocked).

## Settling down
`factory-inspect status` lists recipes with long clean streaks and suggests sampling (e.g. 1 in 10) and later off. Mention a suggestion once; the user chooses. If a recipe's rules change (recipe, floors, selection, or the factory's skills/agents/workflows), the inspector re-arms itself and inspects every job of that recipe again. To turn the inspector off entirely, the user disables the `factory-inspector` plugin; the factory keeps logging, so they can inspect past jobs later.
