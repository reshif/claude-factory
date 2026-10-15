---
name: ship
description: Ships a factory job whose pre-ship floors are met, as a pull request on GitHub or a prepared local merge, and waits for the human merge. Used by factory:start when `factory next` returns skill ship.
user-invocable: false
---
# Ship

1. Run `factory ship`. It refuses unless every pre-ship floor is met (it lists the missing ones — then run `factory next`, which routes to the missing step).
   - With a GitHub remote and an authenticated `gh`, it pushes the job branch and opens a PR whose body is the completion report (templates/docs/ship-report.md: what changed, AC → evidence, design record, risk, rollout and rollback). It also refreshes the job's `docs-index.md` (contract → design → plan → evidence traceability).
   - Otherwise it prepares a **local** merge.
2. Tell the user, briefly:
   - GitHub: the PR link; that CI (`factory-gate`) re-verifies on the merge result; that they review and merge on GitHub and then say "continue".
   - Local: the exact commands from the `next` field (`git checkout <base> && git merge --no-ff <branch>`), and that they reply **`merged <commit>`** afterwards.
3. **Stop** and wait.

After the merge:
- GitHub: `factory next` runs `factory pr sync`, which records checks and the merge commit.
- Local: once the hook applies `merged <commit>`, just continue the loop — `factory next` itself asks for `factory ci verify` (the CI re-verify floor for local merges) before distill; don't run it on your own.
- If `factory-gate` isn't set up in the repo, suggest the user run `factory ci install` themselves (it's human-only) and commit it on their base branch. Until then, after a GitHub merge, run `factory ci verify --commit <merge commit>` to re-verify locally, or the user can reply `waive ci_reverify <reason>`.
