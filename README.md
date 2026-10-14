# Software Factory v2 — Claude Code plugin

Turns a request into a verified, merged change through an **approved outcome contract**, **deterministic routing**, **CLI-enforced floors per risk level**, **evidence bound to the exact build**, and **human gates**. Telemetry feeds a monthly human review; the system never changes its own recipes.

```text
you: /factory:start fix the rounding bug in invoice totals
      │
      ▼
 intake ─▶ clarify ─▶ H1 ─▶ ground ─▶ decide ─▶ H2 ─▶ decompose ─▶ H3 ─▶ realize ─▶ reconcile ─▶ prove ─▶ challenge ─▶ ship ─▶ H4 ─▶ distill ─▶ closed
            (which of these run, and which gates you see, depends on the recipe the CLI picks for work type + risk)
```

## Install

Requirements: Claude Code, Node 18+, git. Optional: GitHub CLI (`gh`) logged in, for automatic PRs.

```bash
# 1. Unzip somewhere permanent, e.g. ~/claude-plugins/software-factory
# 2. Add it as a local marketplace and install the plugin
claude plugin marketplace add ~/claude-plugins/software-factory
claude plugin install factory@software-factory
```

Or inside a Claude Code session: `/plugin marketplace add ~/claude-plugins/software-factory`, then `/plugin install factory@software-factory`.

The plugin's workflows need the **Workflow tool** (available on paid plans and the API; on Pro, enable it in `/config`). Without it, the driver skill runs the same fan-outs with the Agent tool — slower, same rules.

## Use

In any git repository with at least one commit:

| You type | What happens |
|---|---|
| `/factory:start <what you want>` | Intake: Claude reads the repo, proposes work type, risk and job-vs-epic, asks you **one** question, creates the job, then runs the loop until it needs you. |
| `/factory:start` | Continue the current job. |
| `/factory:why` | Every routing decision for the job, with the rule behind it. |
| `/factory:console` | A read-only page that replays every job as a flow canvas: stages left to right and time downward, with every step, return trip, retry, park, amendment, cancel, abandon and inspector finding, plus which agents ran on which model (`factory console` writes `.factory/console.html`). |
| `/factory:review` | Monthly 30-minute telemetry review. |

The first run initialises the repo (`factory init`): a `.factory/` folder kept out of git via `.git/info/exclude`, and a commit-msg hook that adds `Factory-Job` / `Factory-Task` trailers on factory branches.

### Your replies (exact, whole message)

The UserPromptSubmit hook applies these before Claude sees them; nothing else counts as approval.

| Reply | Effect |
|---|---|
| `approve` | Approve the gate that is waiting (bound to the document's hash — if it changed since it was shown, the approval is refused). |
| `deny <what must change>` | Send it back with your reason. |
| `resume` | Un-park; the cap that stopped it gets one more round. |
| `cancel job` / `abandon job` | Stop for good; files are kept. |
| `merged <commit>` | Record a local merge (when there's no GitHub PR). |
| `confirm AC-3` | Confirm a criterion whose evidence type is `human`. |
| `waive ci_reverify <reason>` · `waive ship_size <reason>` | The only waivable floors. |
| `accept lesson L4` · `reject lesson L4 <why>` | Decide on a proposed lesson. |

From your own terminal you can also run the human-only CLI commands directly (`factory approve`, `factory resume`, `factory reseal` …).

Add a job id to target a specific job: `approve J-0007`.

### Gates you may see

H1 contract · H2 design (when there is an ADR, or always at high risk) · H3 plan (auto-approved at low risk after a God Eye plan critique, in `feature@low`) · HS ship sign-off (high risk) · H4 your merge · HF spike findings · EH1–EH3 epic contract, architecture, slices · A amendment · P parked.

## How it works (one paragraph)

`factory next` (the CLI) evaluates an **alignment vector** — contract approved → no drift → floors so far → no confirmed serious finding → criteria proven → no stale evidence — and the first failing check decides the next step; otherwise the recipe's next undone step runs. Agent work happens in five **workflow scripts** (`ground`, `fanout-judge` with configs clarify/decide/challenge, `decompose`, `realize`, `reconcile`) that return a result envelope; `factory record` validates it, rejects stale results, re-checks what it can, and writes the ledger. Builders work in per-task git worktrees; only `factory task verify` produces evidence, and only `factory verify run` proves criteria on the integrated build. `factory finalize`, `factory ship`, `factory close`, the Stop hook and CI refuse to pass a job whose floors aren't met. Every routing decision is a line in `.factory/log/decisions.jsonl`.

Full detail: [`plugins/factory/docs/ARCHITECTURE.md`](plugins/factory/docs/ARCHITECTURE.md) · design rationale: [`DESIGN-v2.md`](plugins/factory/docs/DESIGN-v2.md) · diagram: [`orchestrator-v2.mmd`](plugins/factory/docs/orchestrator-v2.mmd) · documents (templated ADRs with Mermaid architecture diagrams, threat models, reports, lessons): [`DOCS.md`](plugins/factory/docs/DOCS.md).

## The console (see the factory work)

Run `factory console`, or `/factory:console` in Claude Code, then open `.factory/console.html`. It reads `.factory/` and writes only the page. It checks seals only when this machine already has the factory key, and never creates one.

- **Job picker.** One card per job, with jobs waiting for you first. Each card has eight stage lights:
  - green: clear
  - amber: running
  - flashing amber: your turn
  - red: stopped
  - dark: ahead
- **Flow canvas.** Stages are columns, each step is a lane inside its stage, and time runs downward with a clock and day breaks. Each visit to a step is a row.
  - **Moving on** is a blue line to the right.
  - **Going back** is a red line to the left, labelled with why: a fix round, a verify-fix round, re-proving after a change, or your denial.
  - **Repeating a step**, such as a review run again for a missing lane or a second clarify round, drops straight down.
  - **Parks, resumes, amendments, cancels and abandons** get their own rows and shapes. A follow-up job is a link.
- **Each row shows:**
  - the router's reason
  - the workflow and every agent it ran: model (O/S/H), run count, retries `↻`, failures `✕`, escalation `↑`
  - the result and confirmed findings
  - your replies, with how long each one took you
  - guard blocks
- **Crew band.** The band at the top shows every agent that has worked in each stage.
- **Inspector findings.** If the inspector plugin is installed, its findings sit in a right-hand column, connected to the row they cite.
- **Replay.** Replay drives the job down the canvas one event at a time. You can scrub, step, change speed and follow. Fit and 1:1 switch the zoom. The panel shows the router's six checks at each decision, the agents in each run and every event.
- **Other tabs.** *Recipe map* is the whole factory for any recipe. *The crew* lists the 19 agents and how often each ran.
- **Where the data comes from.** Each workflow returns a roster of every agent it started, and `factory record` seals it into the ledger as an `agents` entry tied to the routing decision. Hooks add timings. Parks, amendments and follow-ups come from the event log and the job's own records.
- **Options.** `--job J-0003` makes the page for one job, `--out file.html` writes it elsewhere, `--label "…"` adds a banner, and `--data file.json` also writes the data as JSON.
- **Sample.** `node plugins/factory/console/dev/make-sample.js <dir>` builds a realistic sample: nine jobs over about three days on a simulated clock. They run through the real CLI, workflows, hooks and inspector, with scripted agents.

## The inspector (optional, separate plugin)

`factory-inspector` audits the factory from the outside. For each job it checks whether the intended recipe was used and whether the factory behaved as that recipe says, including whether Claude did what the router told it. It keeps a register of deviations, ambiguities and gaps for you to decide on.

```bash
claude plugin install factory-inspector@software-factory
```

It runs when a job closes, and on demand with `/factory-inspector:inspect`. Once a recipe has a long clean streak it suggests sampling, then off. Disable the plugin to turn it off completely; the factory keeps logging either way. See [`plugins/factory-inspector/README.md`](plugins/factory-inspector/README.md).

## CI re-verify (recommended)

From your own terminal, once per repo: `factory ci install` (human-only). It copies a self-contained CLI to `.github/factory-cli/` and adds `.github/workflows/factory-gate.yml`, which re-runs every shipped job's verify commands on the PR's merge result. Add your project's setup steps to that workflow, commit both on your base branch, and make `factory-gate` a required check. Without GitHub, `factory ci verify` re-verifies a local merge.

## Configure

Project overrides go in `.factory/policy.json` (you edit it; agents can't). Defaults: [`plugins/factory/policy/default-policy.json`](plugins/factory/policy/default-policy.json). Common ones:

```json
{
  "base_branch": "main",
  "checks": [{ "cmd": "npm run lint" }],
  "agents": { "models": { "researcher": "haiku", "builder": "sonnet" }, "builder_escalation": ["opus"] },
  "protected_paths": [".factory/**", ".git/**", ".github/workflows/**", "migrations/**"],
  "limits": { "max_review_rounds": 3, "max_parallel_tasks": 4, "max_agent_runs_per_job": 400 }
}
```

Every workflow agent runs as its real factory agent (`agents/<role>.md`), so each role's tool limits and model apply. `agents.models` sets a model per role. `agents.builder_escalation` moves a builder to a stronger model from its second attempt on.

Recipes and floors live in the plugin ([`recipes/`](plugins/factory/recipes), [`policy/floors.json`](plugins/factory/policy/floors.json)); see [`RECIPES.md`](plugins/factory/docs/RECIPES.md) and [`FLOORS.md`](plugins/factory/docs/FLOORS.md). The guard blocks agents from editing any of them.

## Develop / test

```bash
cd plugins/factory
npm test          # 42 tests (plus 10 in plugins/factory-inspector): end-to-end jobs, decision table, caps, guard, seals, hooks, workflows, schemas
./bin/factory help
```

The tests drive the real CLI against throwaway git repos, play the agents and the human, and run the workflow scripts in a harness that emulates the Workflow runtime (top-level await, `agent`/`pipeline`, no fs, no `Date`/`Math.random`).

## Known limits

- Not yet exercised inside a live Claude Code session — the CLI, hooks and workflow scripts are covered by the automated tests above. Run `claude plugin validate plugins/factory` after installing, and try a `bug@low` job first.
- The guard and seals are defence in depth, not a sandbox: agents run as your OS user. CI re-verify and your own merge are the hard backstops. Details: ARCHITECTURE.md §6a.
- Budgets count agent runs and wall time, not tokens.
- v0.7.5 extras not included in this standalone build: standards packs (`python@1`, `typescript@1`), the Inspector, display consoles. Project checks go in `policy.checks`.
