---
name: gate
description: Presents a factory human gate (contract, design, plan, findings, ship sign-off or amendment) with its documents and hash, and waits for the user's exact reply. Used by factory:start when `factory next` returns action gate, and by factory:amend for gate A.
user-invocable: false
---
# Human gate

`factory next` returned `action: gate` with `gate: { id, hash, docs }`. The approval will be bound to that exact hash: if a document changes after you present it, the approval is refused and you present it again.

## What each gate shows
| Gate | Show |
|---|---|
| H1 / EH1 | What `factory next` carries under `clarify_h1`: its `screen` is the H1 view, in order: the **goal**, **done means** (every acceptance criterion with its evidence type), the contract **checked against what you said** (each of the user's own words, quoted, and where the contract honours it, or ✗ where it does not), the **decisions and who made them** (you, your accepted recommendation, evidence, or an assumption), the versions researched against, what **design may choose**, the **research gaps**, the user's redirects with each item done or not done, and anything dropped or taken out. Show it as it is; mention allowed paths and verify commands from the contract. Never present an unresearched item as researched. Then the parts below. |
| H2 / EH2 | The design record: the decision, rejected options, how criteria are met, and the ADR's architecture diagram (paste its ```mermaid block as is so it renders); and its **External API usage** table; then what `factory next` carries under `review` (below): the critics' verdicts and every open objection (God Eye's and the API-conformance critic's, each with its evidence and what the finding verifier found), and the API ledger. When `review.design_critique.not_rechecked` is set, say so: the final revision was not re-checked by the critics. For EH2, the contracts being frozen. |
| H3 / EH3 | The plan as a table: task, objective, allowed paths, depends on, consumes, criteria; then the interfaces as a table (interface, kind, file, owner, consumed by — `factory plan validate` prints them, with the dependencies they imply under `implied_dependencies`), so the user sees who builds what for whom; then the waves (after each wave the factory integrates it and runs the job's checks before the next starts); then the **plan probe** from `review.probe` (each verify command and what it did when the CLI linted or dry-ran it, and the problems still open). When `review.approves` lists `design` (the medium-risk combined gate), show the H2 parts first: this one approval covers the design, the plan and the build environment. When `review.environment` is a proposal, show its setup and say that approving also sets the build environment for the whole repository (other jobs build in it too). For EH3, the slices and their order. |
| HF | The findings summary and the recommendation (spike). |
| HS | Run `factory report` first, then show the floors table and the AC → proof table from the report. This signs off the irreversible step (push / PR); it is skipped in local mode (nothing is pushed). It is also the ship review at high risk: `next.ship_review` lists the user's own checks (`confirm AC-n`) and unsettled findings (`accept`/`dismiss finding <id> <why>`) to settle in the same reply (`confirm AC-2; approve`). |
| A | The amendment: what changed, who asked, criteria changed, tasks that will be rebuilt. |

Read the files in `docs` yourself and summarise faithfully — don't hide open critique items.

**What the critics add (`review`, at H2, H3 and HF).** Show every part it has, as given:
- `approves`: what this one approval covers (at medium risk, `design + plan + environment`). Say it in one line before the gate line.
- `design_critique` / `plan_critique`: the verdict and each `open` item with its critic (`god-eye` or `api-conformance`), severity, whether a finding verifier `confirmed` it or could not settle it (`unverifiable`), and its `evidence` (a dependency `path:line` with its quote, or a probe's command and output). `stop` says why the loop ended (`no_progress`, or the `ceiling`); the architect revised after the last critique, so when `not_rechecked` is set say it in one line: the final revision was not re-checked by the critics. These are objections the critics could not settle, never approval: under the heading **Open objections**, say plainly that `approve` takes the design on over them and that a `deny` naming the defect sends it to a targeted revise (the architect and the critics, not a new decide); `deny rethink <why>` asks for new options.
- `api_ledger`: how many facts were quoted from the pinned dependency source (each `L-n` with its file and line), how many quotes the CLI rejected, and every `gap` (a package whose source could not be fetched: claims about it are unverified).
- `probe`: whether every verify command can run in the build environment, and its `problems` if any are left.
- `environment`: the build environment the plan runs in (name, setup, where it came from). When its status is `proposed`, say that approving this gate also confirms it: its setup commands run in every worktree on this machine.

**What clarify adds at H1.** Besides the screen, `clarify_h1` may carry these; show every part it has, as given, before the gate line:
- `god_eye_objects` (with `approved: false`): under the heading **God Eye objects**, each item as given. God Eye did not approve this contract: the readiness loop ended without converging (`loop_end`: its rule, rounds and God Eye's diagnosis), or an older job's user said `proceed`. Say so plainly: `approve` takes the contract on over them, `deny <what must change>` sends it back. Never call them notes or describe the contract as approved by God Eye.
- `readback`: the read-back, when it was shown here and not on a sheet (nothing on it needed the user). `changes`: the user's later words that changed their earlier ones. `reworded`: contract lines the writer reworded, each with what it rests on.
- `dropped`: items clarify closed without settling them, each with who dropped it and why. The user can reopen any of them (deny, or a redirect).
- `research_incomplete`: what research could not do and which items rest on no source. Say it plainly, word for word.
- `edited_by_hand`: the user edited `contract.md` themselves; the readiness check ran on their text.
- `words.relayed`: the user's words that reached the factory only through you and match no message the reply hook saw from them (the screen marks them †). Ask them to check those are their words before they approve.

Instead of `deny`, the user may redirect clarify in their own words: run `factory clarify redirect "<their words>"` with their words verbatim. The interviewer reads it back as tracked items, and the next H1 reports each one done or not done.

**Build environment.** At a gate whose `review.environment` is shown, that gate's approval confirms it (the plan gate); otherwise, when `factory next` carries `environment` (no environment is confirmed for this repository yet), show it after the gate's documents, at H1 and every later gate until the user decides: its name, setup commands, env, services and the files it was detected from (`evidence`), and its `hash`. The user replies `confirm environment <hash>` to use it, or `confirm environment none` for bare worktrees; to change it, write a copy under `.factory/scratch/`, run `factory env propose --file <copy>` and show the new hash (`factory env show` prints both). Never confirm it for them: its setup commands run on their machine.

## Then
End with exactly this, and **stop**:

> **Gate {id}** · hash `{first 12 chars}` — reply **`approve`** to continue, or **`deny <what must change>`**.

## Example
For `gate: { id: "H3", hash: "9f2c41ab07de55…", docs: ["…/plan.json"] }` on a two-task plan:

> **Plan for J-0004** — two tasks in one wave.
>
> | Task | Objective | Allowed paths | Depends on | Criteria |
> |---|---|---|---|---|
> | T1 | Apply the discount before tax in `cartTotal` | `src/cart/**` | — | AC-1, AC-2 |
> | T2 | Add regression tests for discounted carts | `tests/cart/**` | — | AC-1 |
>
> God Eye approved the plan; no open items.
>
> **Gate H3** · hash `9f2c41ab07de` — reply **`approve`** to continue, or **`deny <what must change>`**.

## Rules
- Only the user's own reply counts. Never approve on their behalf and never run `factory approve` (the guard blocks it).
- If the user would rather act from a terminal, say: "run this in your own terminal; it will ask you to type a code shown there." Never run it for them. Never ask the user for that code, never ask them to paste it into the chat, and never offer "or just tell me it's done" as a substitute: the code belongs on their terminal only, and `factory next` (the gate state) shows whether it went through.
- If they answer with other words ("looks good", "yes"), ask them to reply exactly `approve` — the hook only applies the exact reply.
- After they reply, the hook applies it before you see the message and adds a `[factory]` note. If it says *Applied*, continue the loop (`factory drive`, or `factory next` when stepping by hand). If it says *NOT applied* (e.g. the document changed), present the gate again.
- On `deny`: `factory next` routes back to the step that made the document (clarify, decide or decompose) with the user's reason; at HS, the reason becomes the builders' finding in a fix round (then prove and review again); follow it, and the gate comes back afterwards. At the design gate, a reason that names a defect is fixed by a targeted revise (the architect and the critics); only a reason that rejects the approach (`rethink`, `a different approach`) runs the option generators again. At the combined design + plan gate, a reason about the plan (a task, a verify command, the environment) goes to decompose, anything else to decide, which re-plans. At H1, clarify reads the denial back as tracked items first (a short screen the user confirms), then restarts from the earliest stage it touches.
- A bare `deny` is refused (the `[factory]` note says it was NOT applied and asks what must change): ask the user to reply `deny <what must change>` (`deny: …` works too).
