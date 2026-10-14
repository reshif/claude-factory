---
name: intake
description: Factory intake — read the repo, classify the work type, propose a risk level, decide job vs epic, confirm with the user in one question, and create the job. Used by factory:start for a new request.
user-invocable: false
---
# Intake

1. **Read the repo quickly**: top-level layout, README, the files the request clearly touches, their tests, CODEOWNERS, CI config. Don't over-read.
2. **Classify the work type**: feature · bug · hotfix · refactor · migration · dependency · docs · spike · greenfield.
3. **Propose a risk** (low / medium / high) with one-line reasons. Raise it for: security/auth/payments/data, public APIs, migrations, broad blast radius, weak tests. Policy floors hotfix and migration at high — the CLI will raise them anyway.
4. **Job or epic?** It's an epic if any of these hold: more than one PR, more than one subsystem, a migration plus its consumers, a public API plus its callers, a staged rollout, or more than ~3 days of work.
5. **Ask one question** confirming all three, e.g.:
   > I'd run this as a **bug** fix at **low** risk, as a single job (it touches only `src/cart/`). OK, or change any of those?
   Stop and wait.
6. On confirmation run:
   `factory job new --title "<short title>" --type <type> --risk <risk> [--epic]`
   Tell the user the job id and the recipe the CLI chose (one line). If `risk_raised_by_policy` is true, say so.
7. Return to the factory:start loop (`factory next`).
