---
name: amend
description: Changes an approved factory contract or plan through an amendment the user approves, so only the affected tasks rebuild. Use when the user says requirements changed during a factory job, or when `factory next` returns skill amend. Not for edits before the contract is approved (clarify owns those).
user-invocable: false
---
# Amend

Approved documents are bound to their hash. Changing them goes through an amendment, never a silent edit.

1. If no amendment is open: ask the user what changed and who asked for it (if they haven't said), then run
   `factory amend start --reason "<what changed>" --by "<who asked>"`.
   If `factory next` sent you here because an approved document drifted, the reason is that drift — confirm with the user whether the change is intended; if not, restore the approved original from `.factory/jobs/<job>/approved/` (the CLI keeps a copy of every approved contract and plan) and run `factory next`.
2. Edit **only** the affected acceptance criteria in `contract.md` and the affected tasks in `plan.json` (or slices in `slices.json`).
3. Run `factory amend submit`. It validates both and computes the impact (criteria changed, tasks affected).
4. Run `factory drive` (or `factory next`): it presents gate **A**; follow **factory:gate**. Gate A can be approved only once presented. If the job was parked, the amendment pre-empts the park: approving it also resumes the job, as `resume` would (one more round of the cap that parked it), so the user needs no separate `resume`.
After approval, earlier steps are carried forward to the new hashes and only the affected tasks rebuild.
