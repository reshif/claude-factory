# Architecture (as built, v0.8.0)

This is the shipped implementation of [`DESIGN-v2.md`](DESIGN-v2.md). Where the build differs from the earlier file plan, the reason is in [§9](#9-differences-from-the-file-plan).

## 1. Who does what

| Part | Role | Can write state? |
|---|---|---|
| **`factory` CLI** (`bin/factory`, `cli/`) | Decides the next step, validates everything, runs verify commands, writes state, ledger and decision log | **Only writer** |
| **Driver skill** (`skills/start`) | Main session: runs `factory next`, executes what it says, talks to you | No (through the CLI only) |
| **Workflows** (`workflows/*.js`) | Fan agents out and in; return a result envelope | No (no fs, no shell) |
| **Agents** (`agents/*.md`) | One role each; propose; builders commit only on their task branch | No |
| **Hooks** (`hooks/`) | Guard every tool call; apply your replies; refuse false "done" | Your replies only, via the CLI |
| **You** | Approve gates, merge, accept lessons, edit recipes/floors/policy | Through chat replies or your terminal |

## 2. The loop

`factory drive` runs this loop itself up to the first thing only the main session or the user can do (a workflow, the lesson writer, a gate, a clarify turn, a park, …) and returns that as a typed stop; see [DRIVE.md](DRIVE.md). Stepping it by hand:

```text
factory next ──▶ action
  skill    → follow factory:<skill>  (clarify · ship · distill · amend)
  workflow → factory wfargs <wf> …  ─▶ Workflow factory:<wf> (args = brief) ─▶ envelope
             └─ write envelope → factory record --file … (validate · stale check · re-check · ledger)
  cli      → run the command (plan from-contract · verify run · epic spawn · epic gate · pr sync · close)
  gate     → present docs + hash; stop; your reply is applied by the prompt hook
  wait     → tell you what's awaited (merge, slice jobs); stop
  parked   → explain; stop
  done
```

## 3. Routing: alignment vector + decision table (`cli/core/alignment.js`, `decision-table.js`)

The first failing check decides; if none fails, the recipe's first undone step runs.

| # | Check | Fails when | Goes to | Rule id |
|---|---|---|---|---|
| 1 | `contract_approved` | H1/EH1 never approved | clarify, then the gate | `row1.contract_not_approved` |
| 2 | `no_drift` | approved contract changed · approved plan changed after building started | factory:amend → gate A | `row2.drift_contract` / `row2.drift_plan` |
| | | files outside allowed paths or inside protected paths on the job branch | park | `row2.drift_scope` |
| 3 | `floors_satisfied_so_far` | a pre-build floor step undone once building started · a pre-merge floor step undone once shipped | that step | `row3.floor_missing` |
| 4 | `no_confirmed_serious` | confirmed blocker/major on the current build (not yet scheduled) | realize, scope `fix` (one owner per finding: the task whose commit `git blame` shows, by its `Factory-Task` trailer; a finding with no file, or in a file no task's paths cover, reopens every task and is in every reopened task's `fix_findings`, marked `shared`) | `row4.confirmed_serious` |
| 5 | `acs_proven` | latest proof on this build failed (not yet scheduled) | a failing command or test/run proof: realize, scope `verifyFix` (owning tasks) | `row5.acs_unproven` |
| | | only a doc/diff record missing | action `evidence`: the main session runs `factory evidence add` (no fix round, no counter), then prove again | `row5.evidence_missing` / `row5.evidence_recorded` |
| | | only a human check missing | wait for `confirm AC-n` | `row5.human_confirm` |
| 6 | `no_stale_evidence` | proof exists only for an older build | prove | `row6.stale_evidence` |
| — | all pass | | recipe's next undone step | `order.next_step` |
| — | a gate was denied and its document's producer hasn't run since | | that producer (clarify, decide or decompose) with the reason in its brief; then the gate again | `gate.denied_revise` |
| — | local merge recorded, CI re-verify floor unmet | | `factory ci verify --job J` (step H4) before distill/close | `order.ci_reverify` |

`factory next` is a query: asked again with nothing tried since the last decision (no workflow brief, record or step command; read-only commands don't count) and nothing changed, it returns the same decision (same `decision_id`, `requery: true`) without writing a decision or counting a repeat. A bare `deny` is refused (`needs_reason`); `deny <reason>` and `deny: <reason>` are accepted.

Caps (all park, all explained by `factory why`): `cap.review_rounds`, `cap.verify_fix_rounds`, clarify's own caps (research passes, writer attempts, readiness cycles; it parks from `record`, and `proceed` is the user's way on with the gaps shown), `cap.decompose_rounds`, `cap.budget` (agent runs per job and per tree), `cap.repeat_guard` (same step from the same state more than twice). `resume` grants exactly one more round (budget: +50%).

## 4. Bindings and freshness (`invalidation.js`, `steps.js`)

| Binding | Hash of | A step recorded against it is stale when… |
|---|---|---|
| contract | contract.md + work type + risk + epic flag | the contract changes (risk is locked by H1) |
| findings | findings.md | findings change |
| design | ADR(s) + no-adr + recommendation + threat model + epic contracts | any design file changes |
| plan | plan.json (slices.json for epics) | the plan changes |
| fingerprint | top-level git tree of the job branch, excluding `.factory-ship/` | anything built changes |
| children | every slice job's status and merge commit | a slice merges or re-merges |

Each recipe step has a deterministic "done" predicate over these (e.g. *realize* = every task's latest evidence passed on the exact tree its branch has now; *prove* = a passing proof bound to the current fingerprint). Gate approvals store the hash they approved and a copy of what was approved (`jobs/<id>/approved/`), which amendments diff against.

## 5. Workflows and the brief/envelope contract

Every brief item names the factory agent that runs it: `agent_type: factory:<role>`, plus an optional `model` from `policy.agents.models`. Workflows pass it to `agent()` as `agentType`, so `agents/<role>.md` is that agent's system prompt and its `tools:` limits and `model:` apply. Researchers, reviewers, testers, verifiers and judges can't write; only builders, the integrator, the architect, the planner, the slicer and the threat modeler can. `factory wfargs` writes each item's run context, a "Your tools" section built from that role's `tools:` list (a read-only or shell-less role is never told to Write, Edit or use Bash), and the JSON output schema, not the role text, to `.factory/scratch/briefs/<job>/<run>/NN-<role>.md`. One owner per rule: the agent file holds the role's rules and its "Your final message" recipe (every schema field, in order, with a golden example), the brief only per-run values; `ROLE_OUTPUTS` in `wfargs.js` says which schemas each role may be given. Agent descriptions open with "Started only by factory workflows", because Claude Code has no frontmatter field that stops the main session auto-delegating to them. The brief's prompt points at that file. Builders can step up to a stronger model on retries (`policy.agents.builder_escalation`). A brief item without a factory agent type makes the workflow fail rather than run a generic agent.

| Workflow | Fan-out | Then | Returns `data` |
|---|---|---|---|
| `ground` | researcher × topic (codebase, interfaces, history, external; hotfix: failing path, blast radius) | retry failed once | `topics`, `degraded` |
| `clarify` | the agents of one clarify stage, in the groups the CLI's stage plan names (`cli/core/clarify.js` `stagePlan()`): read-back (interviewer), research (researcher × repo/docs, then the brief writer), interpret or redirect (interviewer), contract (contract writer), readiness (God Eye) | an agent with no result is tried once more (`attempts`; a researcher once: its time box is spent); every rule is the CLI's, applied by `record` | `stage`, `rev`, `outputs` (by label), `failed`, `runs` (each agent's label and outcome) |
| `fanout-judge` · decide | option-generator × 3 priors ∥ threat-modeler (high risk) | architect decides → God Eye (design) ⇄ architect revises, ≤ `max_design_critique_rounds` | `options`, `judge`, `critiques` |
| `fanout-judge` · challenge | reviewer × required lane | finding-verifier × blocker/major (confirmed, refuted, or unverifiable, which stays blocking like no result) | `lanes`, `verifications` |
| `decompose` | — | planner/slicer ⇄ `factory plan validate` ≤ rounds; optional God Eye plan critique | `planner`, `critique` |
| `realize` | by dependency, not by wave: each task starts as soon as its own dependencies are integrated (≤ `max_parallel_tasks` attempts at a time), builder then tester (it only runs `task verify` and relays it); with `limits.integrate_each_wave`, done tasks are integrated as they finish, one integration at a time, by the integrator relaying `factory reconcile wave` for the done-but-unintegrated batch. **The attempt barrier:** no attempt starts or retries while an integration's checks run or a failed integration is being repaired (except the repair itself), and `task start` starts from the job branch as last integrated green (`state.integration_green`; a task reopened to repair an integration starts from the job branch itself) | retry to `retry_limit`, each attempt fed the last one's failures (`previous_failures`, `task show` history and diff; numbering continues across runs via `attempt_base`, and builder escalation counts that global number); a builder with no result spends the attempt, with no tester run; a tester with no result is asked once more; blocked/exhausted → dependents `skipped_dependency` (an earlier-wave task on overlapping paths, or the owner of an interface it consumes, counts as a dependency; `task start` merges the job branch and dependencies first, and restarts a task that failed earlier from the job branch); the first `blocked_reason: dependency_conflict` is rebuilt once on a branch restarted from the integrated job branch without spending an attempt, a second one is final; `environment_broken` stops the run without spending the attempt; an integration failure reopens the routed tasks on the integrated branch, and an integration left broken stops every task not yet started | `tasks`, `verifications`, `integrations`, `rebuilds`, `environment_broken` |
| `reconcile` | — | integrator runs `factory reconcile run/continue/abort` | `integrator` |

A workflow script can't run a command, so the CLI steps a realize run needs are run by its agents, and the CLI's job state, not their reply, is what counts: the builder records its own reply as its last step (`factory task built`, which the guard lets only a `factory:builder` agent run), the tester relays `task verify`, and the integrator relays `factory reconcile wave`. The build environment (`.factory/environment.json`, `cli/core/environment.js`) is set up by `task start` in the task's worktree (cached by its `cache_key` files; the job's services once, under a lock), which prints the `shell_prefix` the builder starts each command with; `task verify`, `reconcile wave`, `verify run`, `ci verify` and the epic gate run their commands inside it. Only the human confirms it (`factory env set`, or the reply `confirm environment <hash|none>`).

Every workflow also returns `agents`: a roster with one entry per `agent()` call. Each entry holds `label`, `agent_type`, `model`, `retry` and `outcome`. `factory record` seals the roster into the job's ledger as `kind: agents`, with the workflow, config, mode, status, the run count and the routing `decision_id`. It does this before any other check, so failed runs are covered too. The repeat guard ignores these entries, so a run that keeps failing is still detected.

`factory record` checks: envelope schema · job matches · job active · input hash still current (else `stale`, nothing recorded) · then per workflow: clarify applies the stage's replies by its rules (below) and moves to the next stage; decide needs the design files inside the job folder, a threat model when required, and critique approval unless a human gate will show it; decompose re-runs plan validation itself; realize re-checks each task's evidence (a task is done only when `task verify` passed on the tree its branch has now, after this attempt's builder recorded done with `task built`; a relayed pass the evidence does not back is reported as `relay_mismatches`), and parks once from `environment` when the run stopped on a broken build environment; reconcile checks every task branch is merged and that no line already-merged tasks or fix-round commits (`Factory-Fix` trailer) added was dropped (else the merge is undone and the job parks: `Reconcile regression`); challenge goes through `review.record`, where **the CLI decides lane verdicts** (a lane passes only with no blocker/major left confirmed or unverified) and applies convergence rules (a new major on a file no commit touched since the last round becomes minor; a finding confirmed in any earlier round and found again — same file and lane + rule, or a line within ±10 — is a regression that keeps its severity and blocks).

### Clarify v3 (`cli/core/clarify.js`; [DESIGN-CLARIFY-v3.md](DESIGN-CLARIFY-v3.md))

The contract opens with an **Intent** section (`- Problem:`, `- Who:`, `- Outcome:`, `- Why now:` optional, `- Success signal:`). `factory contract check` fails while any line is missing or still `<…>`, and on a contract with no Intent section at all (amend and `plan from-contract` accept that, for contracts approved before the section existed).

One module owns every clarify rule; `workflows/clarify.js` (run by the Workflow tool with the brief from `factory wfargs clarify`; it cannot read files or run commands) only runs the agents a stage names and returns their raw replies. The record is `jobs/<J>/clarify.json` (sealed): `version: 3`, `rev`, `stage`, the user's words (`W-n`, verbatim), items (`I-n`), the research plan (`P-n`), findings (`E-n`), sheets (`D-n.m`), redirects (`R-n`), readiness checks, failures and counters. A ledger `kind: clarify` line records each stage the record moves to (with its counters and caps); `kind: step, step: clarify` is written once, when the contract passes its readiness check.

| Stage | Who | Rule |
|---|---|---|
| `readback` | interviewer | Intent, scope, the user's facts **quoted** (a quote not found in the user's words is dropped), version pins (a repo line the CLI checks, or the user's words), the research plan tagged repo / docs / decision. |
| `readback_wait` | the user | `ok` confirms; any other words are kept verbatim and read back again. |
| `research` | researchers (repo, docs) → brief writer | One pass, time-boxed by risk (`clarify.research_minutes`), at most `clarify.max_research_passes`. Each finding is judged: `repo` (quote at the cited line), `pinned` (a page for the confirmed version), `docs` (a system with no pin), and the unusable `other_version`, `unpinned` (stable/latest), `bad_quote`, `unsourced`. Only usable findings settle anything; another version's page never does. What could not be settled is a failure, listed — never dropped. |
| `sheet_wait` | the user | At most `clarify.max_sheet_decisions` decisions (options, evidence, recommendation) and the facts to assume. A structured reply is parsed by the CLI; prose goes to `interpret`. |
| `interpret` | interviewer | Maps prose onto the numbered decisions, each mapping quoting the reply; what it cannot map stays open. |
| `redirect`, `redirect_wait` | interviewer, the user | A denial or `factory clarify redirect` split into clauses linked to items; after the user's ok, clarify restarts at the earliest stage they touch; each clause is reported done / not done at H1. |
| `assemble` | contract writer | The whole contract and a coverage map (item → where); the CLI checks it (parses, keeps the Intent, user facts present) and writes it with its own sections: `## Decisions`, `## Facts relied on`, `## Design may choose`, `## Research gaps`. |
| `check` | the CLI, then God Eye | Deterministic checks first (criteria testable and covered by verify commands, user facts honoured, no rejected source cited outside the CLI sections), then God Eye's seven-item checklist. A blocker goes back to its stage (assemble, research, the sheet or the read-back), at most `clarify.max_writer_attempts` writer attempts and `clarify.max_readiness_cycles` send-backs before a park; never a note. |
| `ready` | — | H1 next; `h1View()` is what the gate shows. |

| Rule | Where |
|---|---|
| Identity is the item id, never word overlap; an agent names the id it means or `new` | `applyReadback()`, `applyRedirect()`, schemas |
| Strength: user > evidence > accepted > assumption. The user can always reopen an item; an agent overturns one only with stronger evidence, and a finding that contradicts the user's words becomes a sheet decision ("Go by the source" / "Keep what you said") | `setValue()`, `reopen()`, `contradiction()` |
| Routing by current state: an item's next stage is computed from its status, strength and evidence each time | `route()`, `advance()` |
| Caps park; `resume` gives one more try; `proceed` (human-only: the chat reply, or `factory proceed` from the user's own terminal with its typed code) goes on with the gaps shown. An agent with no result is tried twice, then the job parks naming it (no proceed) | `finish()`, `onResume()`, `proceed()` |
| H1 shows: goal, done means, checked against the user's words, decisions and who made them, design may choose, gaps, skipped sources, redirects, drops (who, why), God Eye objections (`approved: false` when the user proceeded over them) | `h1View()`, the gate skill |
| Replies: the prompt hook records only `ok` or a structured sheet answer; the main session records any other words verbatim with `factory clarify reply`; the same words from the other channel within 10 minutes are not recorded twice. The hook notes a SHA-256 of every prompt (never the text) in the sealed `.factory/log/prompts.jsonl`; relayed words that match one are `heard: reply hook`, the rest are marked `relayed` at H1 | `reply()`, `chatReply()`, `notePrompt()`, `hooks/prompt.js` |
| The user may edit `contract.md`; an edit after the writer or the check is checked again before H1 | `sync()`, `guard-rules` (no lock) |

Jobs in clarify under 0.15.1 or earlier (a v2 `clarify-ledger.json`, or v1's `question_log` and `answers.json`) are migrated on first touch by `cli/core/clarify-migrate.js` (DESIGN-CLARIFY-v3.md, *Upgrading to clarify v3*); jobs approved under v2 keep their ledger, which ground and decide still read ([DESIGN-CLARIFY-v2.md](DESIGN-CLARIFY-v2.md), superseded).

## 6. Hooks

| Hook | Script | Does |
|---|---|---|
| SessionStart | `session-start.js` | Tells Claude about an active job and how to continue |
| UserPromptSubmit | `prompt.js` | Applies an exact reply (`approve`, `deny …`, `resume`, …; trailing punctuation/emoji and case ignored) via the CLI's human channel; adds `[factory] Applied …` or `NOT applied …`. A short message that looks like a reply but doesn't parse (`aprove`, `approve the plan please`) is not applied; Claude is told so, with the accepted forms. While clarify waits on the user, an unmistakable clarify reply (`ok`, a structured sheet answer) is recorded too (`Recorded your reply for clarify`); every prompt is noted as a hash so relayed words can be told from the user's own |
| PreToolUse (Write, Edit, MultiEdit, NotebookEdit, Bash, Read, Grep, Glob, NotebookRead) | `guard.js` + `guard-rules.js` | Denies state edits, plugin edits, writes outside a task's allowed paths, protected paths, secret reads (real path; Grep's `glob` filter; Grep/Glob over the seal secret's folder), force-push in any spelling, `--no-verify`/`commit -n`, hook redirects, `.git/hooks`/`.git/config`, moving a job branch, human-only CLI commands. Commands are parsed like a shell (`hooks/shell.js`) into simple commands, and the factory CLI counts only in command position: after env assignments and wrappers (env, sudo, exec, nice, timeout, xargs, node …), inside eval / `sh -c` / `$( )` / backticks / heredocs or pipes fed to a shell, `find -exec`, terminal emulators (`script`, `unbuffer`, …: allowed unless they wrap the CLI), or through a variable / alias / function set to it. Quoted prose, grep/rg patterns, echo text, commit messages, `gh --body` and heredocs fed to anything but a shell are data; `$HOME/…`-style commands are allowed. `policy.secret_exempt` (`.env.example`, `*.sample`, `*.template`, `*.dist`) are not secrets. Inline interpreter code may not load CLI internals or write state, and may read only the folder of the job in scope (the job whose worktree the command runs in, else the current job) — the same for the main session and subagents. Every Bash deny quotes the command it saw |
| PostToolUse (Bash, Write, Edit, MultiEdit, NotebookEdit, Task, Agent, WebFetch, WebSearch), SubagentStart | `activity.js` | One line per event in `.factory/log/events.jsonl` (job found by explicit `--job`, worktree, or pointer). Read/Grep/Glob are not logged: they change nothing, and logging each cost a Node process |
| SubagentStop | `subagent-stop.js` | Logs each factory agent finishing, with where Claude Code keeps its transcript (`agent_transcript_path`) and what that transcript reports: tool calls, tokens per message, models (`cli/core/transcripts.js`; no hook input carries usage, and Claude Code reports no cost). It doesn't block: workflow agents return through a schema the runtime enforces, and `factory record` re-checks every artifact before it counts. |
| Stop | `stop.js` | Blocks a "done / ready to merge / shipped / I've finished the task" claim (not questions, negations or conditionals) while the owed floors fail — for the current job, the job of the worktree it runs in, and every `J-####` the message names. A job waiting on the human (pending gate, unanswered clarify/ground questions, a `needs_user`/`degraded`/`park` record since the last `factory next`, a wait/gate/parked decision) is skipped |
| (all) | `lib.js` `safe` | A hook never breaks Claude Code; when one fails it appends a sealed `hook_error` event (hook, message, job) so the inspector can report it |

Each `hooks.json` command is a launcher: `node "${CLAUDE_PLUGIN_ROOT}/hooks/<script>.js" || { … }`. Nothing extra runs on the success path. When `node` itself fails (the scripts always exit 0 through `safe`), the launcher prints one line on stderr and exits 1, which Claude Code shows as a non-blocking hook error (exit 2 would block the tool, so it is never used): `node is not on PATH; factory hooks are off (the guard allows everything)`, `node v12.22.9 is too old for the factory hooks (they need Node 14 or newer): …` (`hooks/lib.js` uses `?.`, and the CLI modules the hooks load use `??`), or `hook failed (exit N)`. The inspector's hooks use the same launcher. `factory doctor` checks the Node the hooks would run under (`hooks node`): the first `node` on its own PATH (inside Claude Code, the one its hooks get), a login shell's (`bash -lc`) when it differs, and `/usr/bin/node`, warning below 14.

## 6a. Seals and the trust boundary

Everything the floors trust is sealed with an HMAC keyed by a per-user secret outside the repository (`~/.config/software-factory/secret`, mode 0600): each job's `state.json` (verified on every load — a hand-edited file is refused until you run `factory reseal` from your terminal), every ledger line and decision record (unsealed lines are ignored), and the critique files. The guard additionally blocks agents from the secret, from human-only CLI subcommands (argv parsed the way the CLI parses it), from human-only commands reached through variables, aliases, eval, xargs or terminal emulators (`script`, `unbuffer`, `expect`, …), from inline interpreter code or written source files that reach into `.factory/` state or `cli/core`, and from shell writes into state.

This is defence in depth, not a sandbox: agents run as you, so a determined process can still read your files. The final backstops are outside the agent's reach: CI re-verifies on the merge result, and only you merge.

## 6b. Observations for auditing

The factory records what it does, so the separate `factory-inspector` plugin can audit it without reading any factory code:

- **`recipe.lock.json`.** A sealed snapshot of each job's rulebook, taken at creation. It holds the full recipe and its hash, the floors, the selection rules and the inputs that chose the recipe, the limits, and a hash of the plugin's skills, agents and workflows.
- **Decision ids.** Every routing decision has an id (`J-0001-D0007`) plus the step, workflow, config, command, skill and gate hash it chose. Human actions record which decision they happened `during`.
- **`events.jsonl`.** One sealed line per `factory` command: its arguments (long prose truncated), the job, and the decision id in force. For `wfargs` and `record` lines it also holds the workflow and config. The log also records guard denials, refused chat replies, Stop blocks, hook failures (`hook_error`), agent starts and stops, and tool activity for tools that change things (Bash, edits, Task/Agent, web fetches). Each workflow run is framed by a `workflow_start` line (from `factory wfargs`, with what the brief plans to run) and a `workflow_end` line (from `factory record`, with the envelope's roster); distill's by `distill context` and `distill done`. Both carry a run id, the job and the decision id, like the agent lines between them.

## 6c. The console (`cli/core/console.js`, `console/console.html`)

`factory console` reads `.factory/` as plain files and writes one self-contained page, by default `.factory/console.html`. It changes nothing else and is not logged.

- **Steps.** Each job's steps come from its sealed `recipe.lock.json`, plus a `request` step. Each step is mapped to one of the eight stages.
- **Timeline.** The timeline merges:
  - the job's router decisions
  - human actions, placed on their gate, or on H4 for a merge
  - ledger step results, with findings and acceptance criteria
  - `agents` rosters, placed on the step of their decision, with timings from the SubagentStart/SubagentStop hook events
  - errors, guard denials, refused replies, and park and stop records
  - parks and amendments from the event log; amendment re-binds collapse into one event
  - follow-up jobs
  - the inspector's findings from `.factory/inspect/register.json`, anchored to the decision or moment they cite
- **Workflow runs.** `cli/core/run-steps.js` folds each run into its steps. A workflow script cannot run a command and the Workflow tool shows its `phase()` calls to no hook, so the steps are worked out from what reaches the log live: each agent that starts goes to the step its role belongs to in the workflow's template (the steps in the order its script runs them), from the step in force onwards; realize's builders and testers go to the wave of the task they name. The run's `workflow_end` roster then adds each agent's label and outcome: failures and retries show once the run is recorded. A run with no end is at work while the job is active and the run was busy within two hours; a later `factory next` or brief cuts it off. The page carries the same file, so a replay folds the steps as they stood. Older logs have no `workflow_start` lines and no runs.
- **Seals.** They are checked only when this machine already has the key; the result is `verified`, `tampered` or `not_checked`. The console never creates a key (`seal.secret()` would).
- **The page.** It folds the timeline into a state per event, groups events into rows, and draws a flow canvas:
  - stage columns with a lane per step, and time running downward
  - a row for each visit, park, resume, amendment or stop
  - forward moves to the right, return trips to the left, repeats straight down
  - on each row, the agents, results, replies, guard blocks and inspector findings that belong to it
- **Rendering.** Everything is a pure function of one playhead time, so Replay, scrubbing and stepping always agree.
- **Data slot.** The data goes into the template's `/*__FACTORY_DATA__*/null` slot, with `<`, U+2028 and U+2029 escaped.
- **Review data.** Challenge results carry the CLI's lane verdicts, required and missing lanes, the round, and each finding's verifier word as `review.js` records it (`verifier: 'unverifiable'` with the status left `unverified`, the reason and evidence). Jobs carry their review lanes, policy limits and lessons with scope and decisions; the project's `policy.json` checks are listed too.
- **Blueprint.** `console/src/js/blueprint/adapter.js` folds each job's timeline into the walk through states the Blueprint view draws (stations, gates, side tracks), read-only, from the same data.
- **Build.** `console/console.html` is built by `console/build.js` from the modules in `console/src/` (order in `src/manifest.json`), with each agent's tools read from the `tools:` line of `agents/*.md`. The built page is checked in; `build.js --check` and the console tests fail when it is stale.
- **Sample.** `console/dev/make-sample.js` uses `console/dev/clock.js`, a simulated clock, to build a realistic `.factory/`: nine jobs over about three days, run through the real CLI, workflows, hooks and inspector with scripted agents.

## 6d. Documents (`cli/core/doc.js`, `templates/docs/`)

Every job document follows a versioned template (front matter, fixed sections, rules in the template itself). `factory record` rejects a decide result whose design record breaks its template — an ADR needs a Mermaid architecture diagram, a threat model a data-flow diagram with trust boundaries, both full AC/threat coverage — and the CLI renders findings, the completion report (PR body), the per-job docs index and the lessons register to their templates. See [DOCS.md](DOCS.md).

## 7. Files

**Plugin** (`plugins/factory/`): `.claude-plugin/plugin.json` · `bin/factory` · `cli/main.js`, `cli/lib/*`, `cli/core/*` (alignment, amend, budgets, clarify, console, clarify-migrate, contract, decision-table, decisions, doc, drive, epic, floors, human, inbox, invalidation, job, ledger, lessons, lifecycle, notify, plan, policy, project-brief, recipes, reconcile, record, review, setup, ship, steps, tasks, telemetry, transcripts, verify, wfargs) · `workflows/*.js` (5) · `config/workflows/{clarify,decide,challenge}.json` · `agents/*.md` · `skills/*/SKILL.md` (11) · `console/console.html` (built from `console/src/` by `console/build.js`; + `console/dev/make-sample.js`) · `hooks/` · `recipes/` (7 + `_selection.json`) · `policy/{floors,default-policy}.json` · `schemas/` · `templates/{git/commit-msg,github/factory-gate.yml,docs/*.md}` (doc templates: [DOCS.md](DOCS.md)) · `tests/` · `docs/`.

**Per repo** (`.factory/`, out of git — `factory init`, and every worktree preparation, puts it and common build caches (`__pycache__/`, `*.py[cod]`, `.pytest_cache/`, `.mypy_cache/`, `.ruff_cache/`, `.tox/`, `node_modules/.cache/`, `.DS_Store`) in the common-dir `info/exclude`, so a verify command's caches never make a worktree dirty; verify commands also run with `PYTHONDONTWRITEBYTECODE=1`): `project.json` · `project.md` (the project brief: yours to edit; the CLI keeps its `factory:auto` blocks) · `project-brief.proposals.json` · `drive.json` (the last `factory drive` and its stop) · `policy.json` (yours) · `current` · `jobs/<J>/` (`state.json`, `contract.md`, `findings.md`, design files, `plan.json`/`slices.json`, `critiques/`, `reviews/round-N/`, `evidence/`, `approved/`, `amendments/`, `ledger.jsonl`, `answers.json`, `recipe.lock.json`, `completion-report.md`, `docs-index.md`) · `log/{events,decisions}.jsonl` · `lessons/lessons.{json,md}` · `telemetry/<yyyy-mm>.json` · `worktrees/<J>` (integration) and `worktrees/<J>-<T>` (tasks) · `scratch/` (briefs, envelopes).

**On the job branch**: `.factory-ship/<J>.json` — the verify manifest CI re-runs on the merge result (excluded from the build fingerprint).

## 8. CLI reference

`factory help` prints it. Groups: setup (`init`, `doctor`, `ci install`) · jobs (`job new|show|list`, `use`) · routing (`next`, `why`, `finalize`) · drive (`drive [--record f] [--lessons f]`, `drive status`, `inbox`) · contract (`contract show|check`, `answer`) · workflows (`wfargs`, `record`) · plan (`plan validate|from-contract`) · tasks (`task start|show|verify|state`) · build (`reconcile run|continue|abort`, `verify run`, `evidence add`) · ship (`report`, `ship`, `pr sync`, `ci verify`, `close`) · change (`amend start|submit`, `park`, `followup`) · epic (`epic spawn|gate`) · docs (`doc list|template|check|index`, see [DOCS.md](DOCS.md)) · learning (`distill context|done`, `lessons …`, `telemetry report`, `recipe list|show|check|select`) · human-only (`approve`, `deny`, `resume`, `cancel`, `abandon`, `waive`, `merged`, `confirm`, `lessons accept|reject|promote`, `finding accept|dismiss <id> --reason "…"` — your chat reply, or a real terminal: there each command shows a random 4-character code on the terminal device only and asks you to type it back, and refuses a shell with an agent marker such as Claude Code's `CLAUDECODE=1` or `AI_AGENT`; see `cli/core/human.js` for the list and its sources).

## 9. Differences from the file plan

| Plan | Built | Why |
|---|---|---|
| `commands/factory.md`, `factory-why.md`, `factory-review.md` | skills `start`, `why`, `review` → `/factory:start`, `/factory:why`, `/factory:review` | Claude Code now recommends skills over commands; plugin skills are namespaced by plugin name |
| `workflows/lib/envelope.js` shared helper | helpers inlined in each workflow | Workflow scripts can't import; every `workflows/*.js` is discovered as a workflow |
| `workflows/configs/*.json` | `config/workflows/*.json`, delivered inside the brief | Workflows can't read files |
| `cli/commands/*` one file per command | `cli/main.js` dispatcher + `cli/core/*` | Less indirection; same responsibilities |
| `skills/factory-*` names | `skills/<name>` | Avoids `/factory:factory-…` |
| `stages/` folded | n/a | Standalone build; nothing to fold |
| Equivalence suite vs v0.7.5 | route tests per recipe | Standalone build; no v0.7.5 source to compare against |
