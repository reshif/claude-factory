# Factory glossary

One definition per term. The skills and docs use these words in exactly this sense and point here instead of redefining them.

| Term | Meaning |
|---|---|
| **Job** | One unit of work the factory takes from request to merge: one branch, one PR. Ids look like `J-0003`. |
| **Epic** | A job that is split into slice jobs (several PRs, subsystems or stages); it has its own gates (EH1–EH3). |
| **Recipe** | The ordered list of steps a job runs, chosen by work type and risk (e.g. `bug@low`, `standard@medium`). Recipes live in `recipes/*.json`; the job's copy is frozen in `recipe.lock.json`. |
| **Floor** | A step the policy requires before a milestone (e.g. "review before ship", "CI re-verify after merge"), whatever the recipe says. `factory ship` and the Stop hook refuse while a floor is missing; only the user can waive one. Floors live in `policy/floors.json`. |
| **Outcome contract** | `contract.md` for the job: Intent, Goal, Non-goals, Acceptance criteria (`AC-n`), Constraints, Allowed paths, Verify commands, Assumptions. Everything later is checked against it. |
| **Gate** | A stop where only the user's exact reply moves the job on (`approve` / `deny <what must change>`). H1 contract, H2 design, H3 plan, HF findings, HS ship sign-off, A amendment, EH1–EH3 for epics. An approval is bound to the **hash** of the documents shown; if they change, the gate is shown again. |
| **Park** | The factory stopping instead of guessing: a budget or round cap, no progress, scope drift, a conflict or a failed epic gate. The user replies `resume`, `cancel job` or `abandon job`. |
| **Workflow** | A script in `workflows/` (ground, fanout-judge, decompose, realize, reconcile) that starts the agents for one step and returns an envelope. |
| **Brief** | The JSON that `factory wfargs <workflow>` prints for a workflow: which agents to start, their prompts, models and output schemas. Pass it to the workflow unchanged. |
| **Envelope** | The JSON result a workflow returns. Write it unchanged to `.factory/scratch/envelope.json` and run `factory record --file …`; the CLI validates it against `schemas/envelope.json`. |
| **Fan-out** | Several independent agents run in parallel on the same question (analysts in clarify, options in decide, review lanes in challenge), then a judge merges their results. |
| **Lane** | One reviewer in the challenge fan-out (code, tests, security, UX…). Each confirmed or refuted finding is counted per lane. |
| **Clarify ledger** | The one list of clarify's issues (`U-n`), kept sealed by the CLI in the job's `clarify-ledger.json`. Every question clarify raises is an issue with a subject, an owner (the user, or design), a status (proposed, settled, deferred to design, dropped) and how it was settled. `factory clarify status` prints it. Settled is final: an agent that raises it again in other words only adds a note. |
| **Deferred to design** | An implementation detail (exact field names, line ranges, command syntax, parser behaviour) clarify hands to ground and decide instead of asking; it never blocks H1. |
| **God Eye** | The cold critic agent (`factory:god-eye`). It reads the contract, design or plan as if it had never seen the conversation and returns `approve` or `revise`. Clarify loops until it approves and confirms the intent. |
| **Finding verifier** | An agent that tries to reproduce or disprove one review finding; its verdict decides whether the finding is confirmed or refuted. |
| **Degraded** | A fan-out step finished without one of its angles or lanes (an agent failed twice). The user decides: re-run, or go on without it (in clarify, a second degraded round in a row parks the job and names the failed analysts). |
| **Decision record** | One line per `factory next` routing decision, with the rule that fired (`factory why` renders them). |
