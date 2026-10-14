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
| `/factory:start <what you want>` | Intake: Claude reads the repo, restates your intent in one line, proposes work type, risk and job-vs-epic, asks you **one** question to confirm all of it, creates the job, then runs the loop until it needs you. |
| `/factory:start` | Continue the current job. |
| `/factory:why` | Every routing decision for the job, with the rule behind it. |
| `/factory:console` | A read-only operations floor for every job: a live board grouped by what needs you, a line map of all jobs on one time axis, a feed of everything that happens, and each job as a flow canvas and a readable story (`factory console` writes `.factory/console.html`; `--serve` keeps it live). |
| `/factory:review` | Monthly 30-minute telemetry review. |

The first run initialises the repo (`factory init`): a `.factory/` folder kept out of git via `.git/info/exclude`, and a commit-msg hook that adds `Factory-Job` / `Factory-Task` trailers on factory branches.

### Your replies (exact, whole message)

The UserPromptSubmit hook applies these before Claude sees them; nothing else counts as approval. Case and trailing punctuation or emoji don't matter (`Approve!`, `approve 👍`), but the reply must be the whole message: a short message that only looks like one (`aprove`, `approve the plan please`) is **not applied**, and Claude is told so, with the exact forms.

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

### Questions you may get

While writing the contract (clarify), questions come intent first: *what problem, for whom, what outcome, how we'd know*. Until that is settled you get only intent questions; scope, constraint and acceptance questions follow, in that order. At most 5 questions in the first round and 3 in later ones, as one numbered list; each has an id (`Q-3`), options where possible and the default the factory uses if you skip it. Nothing is asked twice. If the intent is still unclear after two rounds the job parks rather than guessing; reply `resume` for one more round.

### Gates you may see

H1 contract · H2 design (when there is an ADR, or always at high risk) · H3 plan (auto-approved at low risk after a God Eye plan critique, in `feature@low`) · HS ship sign-off (high risk) · H4 your merge · HF spike findings · EH1–EH3 epic contract, architecture, slices · A amendment · P parked.

## How it works (one paragraph)

`factory next` (the CLI) evaluates an **alignment vector** — contract approved → no drift → floors so far → no confirmed serious finding → criteria proven → no stale evidence — and the first failing check decides the next step; otherwise the recipe's next undone step runs. Agent work happens in five **workflow scripts** (`ground`, `fanout-judge` with configs clarify/decide/challenge, `decompose`, `realize`, `reconcile`) that return a result envelope; `factory record` validates it, rejects stale results, re-checks what it can, and writes the ledger. Builders work in per-task git worktrees; only `factory task verify` produces evidence, and only `factory verify run` proves criteria on the integrated build. `factory finalize`, `factory ship`, `factory close`, the Stop hook and CI refuse to pass a job whose floors aren't met. Every routing decision is a line in `.factory/log/decisions.jsonl`.

Full detail: [`plugins/factory/docs/ARCHITECTURE.md`](plugins/factory/docs/ARCHITECTURE.md) · design rationale: [`DESIGN-v2.md`](plugins/factory/docs/DESIGN-v2.md) · diagram: [`orchestrator-v2.mmd`](plugins/factory/docs/orchestrator-v2.mmd) · documents (templated ADRs with Mermaid architecture diagrams, threat models, reports, lessons): [`DOCS.md`](plugins/factory/docs/DOCS.md).

## The console (see the factory work)

Run `factory console`, or `/factory:console` in Claude Code, then open `.factory/console.html`. Or run `factory console --serve` and open the URL it prints: the same page, kept current as Claude works. Either way it reads `.factory/` and writes only the page. It checks seals only when this machine already has the factory key, and never creates one.

![The board: every job as a dense row, grouped by what needs you](plugins/factory/console/dev/screenshots/board-dark.png)

- **The floor.** The header has the project, a **LED** (`live` when served, `reconnecting` if the server went away, `snapshot` for a written file), the time of the last update, the seal check, any open factory-health findings from the inspector, and a filter box.
  - **Five tiles**: your turn, running, parked, stopped, done. Each is a count and a one-click filter (keys `1`–`5`). The tab title shows how many jobs wait for you, e.g. `(2) Factory Console`.
  - **Filters** on the left, with counts: status, recipe, risk, the gate a job waits at, inspector findings, epic or slice, and how recently it changed.
  - **The filter box** takes words and tokens: `is:waiting` `risk:high` `recipe:bug@low` `gate:H2` `has:finding` `has:rework` `agent:builder` `since:2d`; `-` excludes. Words match ids, titles and what happened.
- **Board.** One dense row per job, grouped by attention: your turn, then stopped, running, parked, and done (collapsed). Each row has a beacon (flashing amber on your turn), the recipe and risk, the eight stage lights, the current step or the gate and how long it has waited, the agents running now (coloured by model; `?` for one that started and never reported back), the task bar, return trips `↺`, retries `↻`, inspector findings `⚑`, a three-day activity sparkline and the age of the last change. A blue dot marks a job that changed since you last opened it. Group by status, recipe, risk, stage, epic or day; sort by urgency, updated, created or id. Slices sit under their epic.
- **Line map.** Every job as a transit line on one time axis. A line steps down one track per stage, with 45° bends. Gates are double rings, a dashed amber stretch is time waiting on you, dotted violet is parked, red marks a return trip, a buffer stop ends a cancelled or abandoned job, and a dotted transfer leads to a follow-up. Quiet hours are squeezed by default (switch to linear); zoom with `+`/`−`/Fit or ctrl-scroll, drag to pan, hover a station for the router's reason, the agents and the result.

  ![The line map](plugins/factory/console/dev/screenshots/lines-dark.png)
- **The wire.** On the right, everything that happened across all jobs, newest first: routes, results, agent runs, your replies, guard blocks, parks, hook errors, refused "done" claims and inspector findings. Pause it while you read; narrow it to the selected job; click a line to open the job at that moment.
- **A job.** Click a row (or `Enter`). The list stays on the left so `j`/`k` still switch jobs; `Esc` goes back.
  - **Line**: the flow canvas. Stages are columns and time runs downward; each visit to a step is a row. Moving on is a blue line right; going back is a red line left, labelled with why (a fix round, a verify-fix round, re-proving, your denial); a repeated step drops straight down. Parks, resumes, amendments, cancels and abandons have their own rows. Each row shows the router's reason, every agent with its model (O/S/H), runs, retries `↻`, failures `✕` and escalation `↑`, the result and findings, your replies with how long each took, and guard blocks. A crew band shows who worked in each stage, inspector findings sit in a column beside the row they cite, and **Replay** drives the job down the canvas with the router's six checks at each decision.
  - **Story**: the same job as prose, one paragraph per step visit, with return trips on a red rule and inspector findings as margin notes. A pinned **Now** card says what the job waits on and the exact reply to type, with a copy button (e.g. `approve J-0004 H3`).
  - **Tasks**, **Events** (a filterable table of every event) and **Lessons**.

  ![A job's story](plugins/factory/console/dev/screenshots/job-story.png)
- **Live.** With `--serve`, the page gets each change over server-sent events. Only the rows whose job changed are redrawn, with a short highlight, and a row that changes group slides there. A new gate brings a toast with the reply to copy, and, if you turn on the bell, a desktop notification. On an open job, new steps play in if you are watching the latest moment, and your place is kept if you are scrubbing back. The server listens on this machine only (`http://127.0.0.1:4477/`, `--port 0` for any free port), refuses foreign `Host` headers and is read-only.
- **Keys.** `j`/`k` move, `Enter` opens, `Esc` goes back, `/` filters, `⌘K` (or ctrl-K) opens a palette to jump to any job or view, `1`–`5` toggle the tiles, `g w` opens the next job waiting for you, `?` lists them all. The view, filters and open job are in the URL, so a link brings you back to the same place.
- **Recipe map and Crew.** *Recipe map* is the whole factory as a floor plan for any recipe; *Crew* lists the 19 agents and how often each ran.
- **Where the data comes from.** Each workflow returns a roster of every agent it started, and `factory record` seals it into the ledger as an `agents` entry tied to the routing decision. Hooks add timings. Parks, amendments, follow-ups, hook errors and refused "done" claims come from the event log and the job's own records. An agent that started but never stopped counts as running for two hours at most, and only while its job is active; after that it shows as stale.
- **Options.** `--job J-0003` makes the page for one job, `--out file.html` writes it elsewhere, `--label "…"` adds a banner, and `--data file.json` also writes the data as JSON. Dark is the default look when your system is dark; the half-moon button switches theme.
- **Sample.** `node plugins/factory/console/dev/make-sample.js <dir>` builds a realistic sample: nine jobs over about three days on a simulated clock. They run through the real CLI, workflows, hooks and inspector, with scripted agents. More screenshots are in [`plugins/factory/console/dev/screenshots/`](plugins/factory/console/dev/screenshots/).

## The inspector (optional, separate plugin)

`factory-inspector` audits the factory from the outside. For each job it checks whether the intended recipe was used and whether the factory behaved as that recipe says, including whether Claude did what the router told it. It also checks the factory's health from everything it logs: hook failures, repeated guard denials and blocked "done" claims, refused replies, CLI failures and crashes, stale or degraded workflow results, agent failures and retries, orphaned agents, parks, idle jobs and slow gates (thresholds are configurable). It keeps a register of deviations, ambiguities and gaps for you to decide on.

```bash
claude plugin install factory-inspector@software-factory
```

It runs whenever a job ends — closed, cancelled or abandoned — however it ended: right after Claude runs the command, at the end of the turn when you ended it with a chat reply, or at the next session start when you ended it from your own terminal. Also on demand with `/factory-inspector:inspect` (`active` also covers running jobs; `factory-inspect report` ends with a factory health summary). Once a recipe has a long clean streak it suggests sampling, then off. Disable the plugin to turn it off completely; the factory keeps logging either way. See [`plugins/factory-inspector/README.md`](plugins/factory-inspector/README.md).

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
npm test          # 64 tests (plus 14 in plugins/factory-inspector): end-to-end jobs, decision table, caps, guard, seals, hooks, workflows, schemas, console, doc templates
./bin/factory help
```

The tests drive the real CLI against throwaway git repos, play the agents and the human, and run the workflow scripts in a harness that emulates the Workflow runtime (top-level await, `agent`/`pipeline`, no fs, no `Date`/`Math.random`).

## Known limits

- Not yet exercised inside a live Claude Code session — the CLI, hooks and workflow scripts are covered by the automated tests above. Run `claude plugin validate plugins/factory` after installing, and try a `bug@low` job first.
- The guard and seals are defence in depth, not a sandbox: agents run as your OS user. CI re-verify and your own merge are the hard backstops. Details: ARCHITECTURE.md §6a.
- Budgets count agent runs and wall time, not tokens.
- v0.7.5 extras not included in this standalone build: standards packs (`python@1`, `typescript@1`). Project checks go in `policy.checks`.
