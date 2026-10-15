---
name: review
description: Monthly review of the Software Factory's own telemetry, ending in at most three recipe or floor changes for the user to make. Use when the user types /factory:review or asks how the factory is doing. Not for reviewing code, a diff or a pull request.
argument-hint: "[days to look back, default 30]"
---
# Monthly factory review

Telemetry informs the user; the system never changes its own recipes. Recipes, floors and policy live in the plugin and are edited by the user (the guard blocks agents).

1. Run `factory telemetry report --since <days> --format md` (days = the number in `$ARGUMENTS`, or 30) and show it.
2. Walk through these questions with the numbers:
   - **Primary**: any escaped defects or reverts within 30 days of merge? For each, which floor step would have caught it?
   - **Cost**: which recipe costs the most agent runs and hours per job? Which steps (fix rounds, review lanes) cost much and changed little?
   - **Lanes**: which review lanes raise mostly refuted or minor findings (low precision)? Which confirm real problems?
   - **Gates**: where do denials cluster — contract, design or plan? That's where drafts are weakest.
   Then the report's **Quality signals** section (how well the agents work, not what they cost):
   - **Reliability**: which roles have a high null-result or degraded rate? A role that often returns nothing, or fails twice so a step goes on without it, needs its prompt, output schema or model looked at.
   - **Reviewer precision**: which lanes have a high finding-verifier refute rate? Those lanes raise false positives. A high unverifiable rate means the verifier often can't decide (it needs a way to run or see the code); a lane that is never refuted and never confirms anything may not be earning its cost either.
   - **Parks**: which park reasons recur? A cap that keeps parking jobs the user then resumes is set too low; repeated `park.workflow` or no-progress parks point at a step that can't finish.
   - **God Eye**: a revise rate near 1 means drafts reach the critic too early; near 0 means the critique may be rubber-stamping.
   Before proposing a change from one of these numbers, open one or two of the jobs behind it (`factory why --format md --job <id>`) and check the records say what the number suggests.
3. Propose at most three concrete changes, each as a small JSON diff against `recipes/*.json`, `policy/floors.json` or the project's `.factory/policy.json`, with the evidence for it. Floor changes are policy changes — say so.
4. Recurring accepted lessons with a clear check can be promoted by the user: `factory lessons promote L4 --check "<command>"` (human-only, from their terminal).
5. For a specific open question ("is the extra lane worth it?"), suggest a paired A/B: the same task on the same base commit through both recipes, three runs each, compared as a range — not a single number.
