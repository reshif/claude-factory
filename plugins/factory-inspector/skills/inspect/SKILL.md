---
name: inspect
description: Audit the Software Factory — check whether jobs ran the recipe they were meant to, in the declared order, with valid gates and evidence, and whether Claude did what the router said; then walk the user through open findings (deviations, ambiguities, gaps). Use when the user types /factory-inspector:inspect, asks if the factory is behaving, or asks about inspector findings, modes or streaks.
argument-hint: "[job id | all | status]"
---
# Inspect the factory

The inspector is an independent auditor. It reads the factory's sealed records and each job's **declared rulebook** (`recipe.lock.json`: the recipe, floors and selection rules the job promised to follow) and checks what happened against it. It never blocks, approves or changes anything.

## Run
- `$ARGUMENTS` empty → `factory-inspect run` (closed jobs not yet inspected).
- A job id → `factory-inspect run --job <id>`; also show `factory-inspect trace --job <id>` if the user wants the timeline.
- `all` → `factory-inspect run --all`.
- `status` → `factory-inspect status` only (modes, clean streaks, suggestions).

Then show `factory-inspect report --format md`.

## Explain the findings
Group them by class, highest severity first, in plain words:
- **deviation** — the factory did something its declared rulebook doesn't allow (wrong recipe, skipped step, approval for a document that wasn't presented, review on an unproven build, Claude doing something other than what `factory next` said, records written outside the CLI).
- **ambiguity** — the rules left room and someone improvised (same situation routed differently, caps you keep resuming past, guard denials agents keep hitting, the same step repeating).
- **gap** — something the audit needs is missing (no rulebook snapshot, a recipe edited without a version bump).

For each, give the evidence (decision ids, job) and the inspector's question. Say what you think the likely cause is when the records support it, and what would fix it (a skill wording, a recipe version bump, a cap change) — but **don't change recipes, floors, policy or skills**; those are the user's.

## The user decides
They reply, and the inspector's hook applies it:
- `ack finding F3` — seen, being dealt with
- `fixed finding F3` — fixed; if it's seen again it reopens automatically
- `wontfix finding F3 <why>` — accepted as is
- `inspect mode <recipe|all> on|off|sample <N>` — how often to inspect

Never run `factory-inspect mark` or `factory-inspect mode` yourself (they're human-only, and blocked).

## Settling down
`factory-inspect status` lists recipes with long clean streaks and suggests sampling (e.g. 1 in 10) and later off. Mention a suggestion once; the user chooses. If a recipe's rules change (recipe, floors, selection, or the factory's skills/agents/workflows), the inspector re-arms itself and inspects every job of that recipe again. To turn the inspector off entirely, the user disables the `factory-inspector` plugin; the factory keeps logging, so they can inspect past jobs later.
