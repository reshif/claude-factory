# Inspector findings: what they mean

Read this before explaining open findings to the user.

## Classes
- **deviation** — the factory did something its declared rulebook doesn't allow (wrong recipe, skipped step, approval for a document that wasn't presented, review on an unproven build, Claude doing something other than what `factory next` said, records written outside the CLI).
- **ambiguity** — the rules left room and someone improvised (same situation routed differently, caps you keep resuming past, guard denials agents keep hitting, the same step repeating).
- **gap** — something the audit needs is missing or broken (no rulebook snapshot, a recipe edited without a version bump, a hook that failed and so enforced nothing, torn log lines, a CLI crash, agents that never stopped, a job left idle).

## Health rules
The health rules count what the factory reports about itself against limits in `.factory/inspect/config.json` (`limits`, `rules_off`). A **hook error** on the guard, Stop or prompt hook is high severity: while it failed, that hook allowed everything — say what could have slipped through in that window. For repeated guard denials, refused or look-alike replies, CLI failures, stale results, degraded steps, agent retries/failures/escalations, parks and resumes, explain the pattern and the likely cause from the evidence. For clarify parks (R19.clarify_parked), say whether agents failed (crashed, past their time box, the model) or a cap stopped work that was converging; for God Eye objections the user proceeded past (R19.proceeded_past_objections), say what God Eye objected to and that H1 showed it as an objection, not approval. For research gaps (R20.research_gaps), say what research could not settle and why (web off, no web access, no page for the confirmed version, a time box too small for the risk). Older jobs: for intent parks and dropped clarify questions, say whether the request or the judge looks at fault.
