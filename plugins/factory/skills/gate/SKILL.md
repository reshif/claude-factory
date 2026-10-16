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
| H2 / EH2 | The design record: the decision, rejected options, how criteria are met, and the ADR's architecture diagram (paste its ```mermaid block as is so it renders); the God Eye critique verdict and any open items (from `critiques/design.json`). For EH2, the contracts being frozen. |
| H3 / EH3 | The plan as a table: task, objective, allowed paths, depends on, consumes, criteria; then the interfaces as a table (interface, kind, file, owner, consumed by — `factory plan validate` prints them, with the dependencies they imply under `implied_dependencies`), so the user sees who builds what for whom; then the waves (after each wave the factory integrates it and runs the job's checks before the next starts). For EH3, the slices and their order. |
| HF | The findings summary and the recommendation (spike). |
| HS | Run `factory report` first, then show the floors table and the AC → proof table from the report. This signs off the irreversible step (push / PR). |
| A | The amendment: what changed, who asked, criteria changed, tasks that will be rebuilt. |

Read the files in `docs` yourself and summarise faithfully — don't hide open critique items.

**What clarify adds at H1.** Besides the screen, `clarify_h1` may carry these; show every part it has, as given, before the gate line:
- `god_eye_objects` (with `approved: false`): under the heading **God Eye objects**, each item as given. God Eye did not approve this contract; the user chose `proceed` at a clarify cap. Say so plainly: `approve` takes the contract on over them, `deny <what must change>` sends it back. Never call them notes or describe the contract as approved by God Eye.
- `dropped`: items clarify closed without settling them, each with who dropped it and why. The user can reopen any of them (deny, or a redirect).
- `research_incomplete`: what research could not do and which items rest on no source. Say it plainly, word for word.
- `edited_by_hand`: the user edited `contract.md` themselves; the readiness check ran on their text.
- `words.relayed`: the user's words that reached the factory only through you and match no message the reply hook saw from them (the screen marks them †). Ask them to check those are their words before they approve.

Instead of `deny`, the user may redirect clarify in their own words: run `factory clarify redirect "<their words>"` with their words verbatim. The interviewer reads it back as tracked items, and the next H1 reports each one done or not done.

**Build environment.** When `factory next` carries `environment` (no environment is confirmed for this repository yet), show it after the gate's documents, at H1 and every later gate until the user decides: its name, setup commands, env, services and the files it was detected from (`evidence`), and its `hash`. The user replies `confirm environment <hash>` to use it, or `confirm environment none` for bare worktrees; to change it, write a copy under `.factory/scratch/`, run `factory env propose --file <copy>` and show the new hash (`factory env show` prints both). Never confirm it for them: its setup commands run on their machine.

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
- After they reply, the hook applies it before you see the message and adds a `[factory]` note. If it says *Applied*, continue the loop with `factory next`. If it says *NOT applied* (e.g. the document changed), present the gate again.
- On `deny`: `factory next` routes back to the step that made the document (clarify, decide or decompose) with the user's reason; follow it, and the gate comes back afterwards. At H1, clarify reads the denial back as tracked items first (a short screen the user confirms), then restarts from the earliest stage it touches.
- A bare `deny` is refused (the `[factory]` note says it was NOT applied and asks what must change): ask the user to reply `deny <what must change>` (`deny: …` works too).
