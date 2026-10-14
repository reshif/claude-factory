# factory-inspector

An independent auditor for the Software Factory. It answers two questions about every job:

1. **Was the intended recipe the one used?**
2. **Did the factory behave the way that recipe says?** That covers the order of steps, gates, the evidence chain and caps, and whether Claude did what `factory next` told it to.

It also finds **ambiguities**: places where the rules left room and someone had to improvise. Each one goes into a register for you to decide on.

It never blocks, approves or changes a job, a recipe or a policy.

## Why it is independent

The inspector does not import any factory code. It reads two things:

- **The rulebook each job declared.** `recipe.lock.json` is a sealed snapshot taken when the job was created. It holds the full recipe, the floors, the selection rules and the inputs that chose the recipe, plus a hash of the factory's skills, agents and workflows.
- **What happened.** That is the job's sealed state, ledger, decision log and observation log (`events.jsonl`). The observation log has every `factory` command, tied to the routing decision in force at the time, plus guard denials, refused replies and stop blocks.

The inspector has its own implementations of three things: seal verification, recipe selection, and the allowed-path model. A bug in the factory's router can't hide itself, because the inspector never asks the router what should have happened.

## What it checks

| Rule | Class | Checks |
|---|---|---|
| R1 seals | deviation | Records written outside the factory CLI (state, lock, ledger, decision log, event log) |
| R2 intended recipe | deviation / gap | Replays the selection rules from the job's inputs. Checks the risk floor, the lock hash, and the recipe version every decision used. Flags a recipe file edited without a version bump |
| R3 conformance | deviation / ambiguity | Steps outside the recipe; steps reached before earlier ones completed; closed without a step; moving backwards with no recorded cause |
| R4 gates | deviation | Approvals that were never presented, or presented for a different document hash; automatic approvals the recipe doesn't allow |
| R5 evidence chain | deviation | Review on a build with no passing proof; proof on a build never integrated; shipping without both on the same build |
| R6 loops | deviation | Fix or clarify rounds beyond their caps plus your resumes |
| R7 driver fidelity | deviation | Claude didn't run what `factory next` asked for, ran something else, or changed things while waiting at a gate |
| R8 consistency | ambiguity / deviation | The same failing check routed by different rules under the same rulebook; identical inputs picking different recipes |
| R9 friction | ambiguity | Repeated patterns (3+ by default): the same guard denial, refused replies, refused workflow results, caps you nearly always resume past, the same floor waived, denials clustering at one gate, a step repeating with no progress |

## Use

| | |
|---|---|
| `/factory-inspector:inspect` | Inspect closed jobs not yet inspected, then walk through open findings |
| `/factory-inspector:inspect J-0007` | One job, plus its timeline |
| `/factory-inspector:inspect status` | Modes, clean streaks, suggestions |

It also runs on its own when a job closes, and adds one line to the conversation. At session start it says how many findings are open.

**Your replies:** `ack finding F3` · `fixed finding F3` · `wontfix finding F3 <why>` · `inspect mode <recipe|all> on|off|sample <N>`

A finding marked fixed that is seen again reopens automatically (marked ↺).

**CLI** (`factory-inspect`, on the PATH): `run [--job J | --all]` · `report [--format md]` · `status` · `show F3` · `trace --job J`. The commands `mark` and `mode` are human-only: use them from your own terminal, or reply in chat.

## Turning it down and off

- **Per recipe:** `on` inspects every closed job. `sample N` inspects one job in N. `off` inspects none.
- **Suggestions:** after 20 clean jobs in a row on the current rules (configurable), it suggests sampling. After 60 while sampling, it suggests off. It never changes the mode itself.
- **Re-arming:** when a recipe's rules change (the recipe, floors, selection, or the factory's skills, agents or workflows), it resets that recipe's streak and inspects every job again.
- **Off entirely:** disable the `factory-inspector` plugin. The factory keeps logging, so you can install it again later and run `factory-inspect run --all` over past jobs.

Settings live in `.factory/inspect/config.json`: `mode`, `sample_every`, `settle_after`, `threshold`, plus per-recipe overrides. The register is `.factory/inspect/register.json`.

## Test

```bash
npm test   # 10 tests: a clean job has no findings; forged records, gate-window actions, skipped work,
           # synthetic deviations, cross-job ambiguity, friction, marks/regressions/modes/re-arming, hooks, independence
```
