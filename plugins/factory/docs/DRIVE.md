# factory drive, the inbox, typed recovery and the project brief

This page covers what drive, inbox, typed recovery and the project brief add to how a job moves: `factory drive` (the router loop run
by the CLI), `factory inbox` and desktop notifications, typed parks and the automatic recoveries,
realize scheduling by dependency, agent transcripts and usage, per-role models, and the project
brief. It is the Claude Code version of copilot-factory 0.8.0's Phase 3 and Phase 4; the
differences come from Claude Code running the agents itself (see *Why it differs* at the end).

## factory drive

Claude Code runs every agent through the Workflow tool (or the Agent tool), so the CLI can't run
a workflow. The drive does everything else, in one call, and returns only when the main session
or the user must act:

```text
factory drive [--record <envelope.json>] [--lessons <reply.json>] [--max-seconds 480] [--max-steps 200]
factory drive status
```

It loops over `factory next` and, for each action:

| `factory next` says | the drive |
|---|---|
| `cli` | runs the command (it refuses a human-only verb or a relay of the user's words, which the router never names) |
| `workflow`, or clarify with `run` | runs `factory wfargs …` with exactly the fields given and returns a **`workflow`** stop with the brief as `args` |
| skill `ship` | runs `factory ship` (or stops with `ship` under `policy.drive.stop_before_ship`) |
| skill `distill` | runs `factory distill context`; with nothing worth learning (`worth_learning: false`) it runs `distill done` itself, otherwise it returns an **`agent`** stop for the lesson writer |
| `evidence` | records a doc or diff itself when exactly one file of that kind was changed by the tasks covering the criterion and the criterion's text names it; otherwise an **`evidence`** stop |
| `wait` with ready slices, or a slice `done` | `factory use <slice>` / back to the epic, and on |
| `gate`, clarify waiting, `parked`, `wait`, `done` | stops there |

`--record <file>` first records a workflow result the main session saved (`factory record`):
clarify's `needs_user` becomes a `clarify` stop with the screen, ground's becomes `questions`.
`--lessons <file>` first runs `distill done --result <file>`. Then the loop goes on.

Each step is its own `factory` child process (logged like the main session's commands, with
`via: "drive"`), so the stop hook, the console and the inspector see what a hand-stepped job
shows. A drive needs a few hundred milliseconds per step and returns before `--max-seconds`
(480 s, under the Bash tool's 10-minute ceiling) with a **`yield`** stop when it has more to do.

### Stops

| kind | for | notified |
|---|---|---|
| `workflow` | the main session: run Workflow `factory:<workflow>` with `args`, save the result to `.factory/scratch/envelope.json`, run `factory drive --record .factory/scratch/envelope.json` | no |
| `agent` | the main session: start factory:lesson-writer with `context`, save its reply, run `factory drive --lessons .factory/scratch/lessons.json` | no |
| `evidence` | the main session: check the build, run the evidence line with the real path | no |
| `skill`, `yield` | the main session: follow the skill / run `factory drive` again | no |
| `gate`, `clarify`, `questions`, `parked`, `wait`, `amend`, `ship`, `step_too_long`, `done` | the user | yes |
| `superseded` | nobody: another drive took this one over | no |
| `error`, `limit` | the user (exit code 1) | yes |

Every stop is a `drive_stop` event (`kind`, `handoff`, the gate, the park kind, the clarify
stage, whether a notification was sent) and the last one is kept in `.factory/drive.json` (without
the brief). A stop carries `summary`, the replies the user can give (`reply`), the terminal
command for a human-only one (`command`; it asks for a code shown on that terminal only), the
`factory next` output at that stop (`next`, which the gate, park and clarify skills read), and
the last record's result (`recorded`). A rerun that stops at the same gate, park or clarify turn
tells the user once only (`notified: "repeat"`).

### Replies are the user's own: scheduled and sent prompts

The reply hook (UserPromptSubmit) also fires on a scheduled task firing (CronCreate,
ScheduleWakeup, `/loop`), a background subagent reporting back, and a message from another
session or from this session's own Bash command or hook through its inbox socket; its input has
`prompt` (and `session_title`) and nothing saying where the prompt came from
(code.claude.com/docs/en/hooks, *UserPromptSubmit*; code.claude.com/docs/en/cross-session-messaging).
A cron prompt fires verbatim, so a scheduled `approve` would read as the user's. So:

- the guard also runs on `CronCreate`, `ScheduleWakeup`, `RemoteTrigger`, `SendMessage` and MCP
  tools named like `send_message`, `send_later`, `create_trigger`, `update_trigger`,
  `fire_trigger`, and refuses any text that the reply hook's own parsers would take as a reply
  (`cli/core/reply-origin.js`); it refuses a Bash command that names this session's inbox socket
  (`CLAUDE_CODE_MESSAGING_SOCKET`, `CLAUDE_CODE_MESSAGING_TOKEN`, `cc-socks-`);
- every text it lets through is noted as a sealed hash in `.factory/log/agent-prompts.jsonl`, and
  the reply hook refuses a prompt with a matching hash (each note counts once, for 7 days);
- a prompt wrapped in an envelope tag (a task notification, a teammate or peer message) is never
  applied and never noted as heard from the user.

The limit: text that reaches the session some other way (a script file Claude wrote and ran that
posts to the socket, an MCP tool named otherwise, a background subagent whose final text is a
bare reply) is not seen by the guard, and the hook can't tell it from typing. Setting
`crossSessionInbound` to `refuse` in your settings closes the socket path.

### What the drive never does

It runs no human-only verb (approve, deny, resume, proceed, cancel, abandon, waive, merged,
confirm, reseal, finding, lessons accept/reject), no `clarify reply` or `redirect`, no `answer`.
Its children run in Claude Code's agent environment with no terminal, where the CLI's human
channel refuses anyway. The guard refuses `factory drive` and `factory inbox` (and relays of the
user's words) to factory agents, also fed on stdin through xargs or parallel, and refuses any
agent factory command whose verb is computed (`$(…)`, backticks, a variable). Below the guard,
the CLI refuses `drive`, `inbox`, `answer` and `clarify reply|redirect|note` while a factory agent
is at work (a `SubagentStart` with no `SubagentStop`, in the last 30 minutes), which also covers a
script file an agent wrote and ran. The user's replies arrive through the prompt hook as before.

### One drive at a time

`drive.json` holds the drive's pid, the process's start time (`/proc/<pid>/stat` field 22, or
`ps -o lstart=`) and its host. While it is live, `factory next` from anyone else answers
`action: "driving"` and a second `factory drive` is refused (`drive_in_progress`). On this machine
the recorded pid alive with the recorded start time is alive however long its step takes; a pid
reused by another process is dead; where the start time can't be read, and for a drive on
another host, only a step in the last 30 minutes counts. A drive killed mid-step (a tool
timeout) leaves `status: running`: `factory drive status` says `crashed`, and the next drive
takes over (`drive_start.recovered_from`) and continues from `factory next`. If a record still
holds the repository and you know its drive is gone, `factory drive takeover` (human-only, from
your terminal; it asks for a code shown there) releases it without signalling anything.

### Long steps

A drive call returns within `--max-seconds`, but a step can't be cut in half: a step that may
run long (`verify run`, `ci verify`, `reconcile`, `pr`, `ship`, `epic`, `close`) starts only in a
fresh drive (one that has spent under 30 s; otherwise the drive returns `yield` first). The drive
remembers how long each such step took and the step a drive was cut off in: a step that was cut
off twice, or that last took 85% of the Bash tool's ceiling (`BASH_MAX_TIMEOUT_MS`, else 600 s),
comes back as **`step_too_long`** with the command for the user to run in their own terminal
(it is not human-only, only long), never as an endless run-and-take-over loop.

## factory inbox and notifications

`factory inbox [--format md]` lists, across jobs: gates (with hash and documents), clarify turns
(with the screen), parks (kind and next step), merges, criteria to confirm, project brief
proposals, and drive stops that wait on the user. Each item says what to reply to Claude and,
for a human-only one, the terminal command, which asks for a code shown on that terminal (type
it there; never paste it into a chat). It is read-only; each look is logged as `inbox_viewed`.
The console shows the same list above the board (**Waiting on you**), with the drive's last stop.

Each stop the user must answer is a desktop notification, best effort and never blocking (the
notifier is spawned detached and never waited on; errors are swallowed):

| Platform | Notifier |
|---|---|
| Linux | `notify-send` |
| WSL (`WSL_DISTRO_NAME`, or `/proc/version` naming Microsoft/WSL) | `wsl-notify-send.exe`, else a `powershell.exe` toast |
| macOS | `osascript` |
| Windows | a PowerShell toast |
| none found | a terminal bell, when there is a terminal |

Nothing a notification shows is ever script text: PowerShell reads the title and body from
`$env:FACTORY_NOTE_TITLE` / `$env:FACTORY_NOTE_BODY` (passed to Windows through `WSLENV`),
osascript runs a constant `on run argv` script with the text as argv, `notify-send` and
`wsl-notify-send` get it after `--`, and control and bidi characters are stripped. Each attempt
is a `notify` event. `policy.notify: false` turns them off; so does `FACTORY_NOTIFY=off`.

## Typed recovery

Every park carries `kind` and `next` (`state.park`, the `factory next` output, the drive's stop,
the inbox): budget, scope_violation, review_rounds, verify_fix_rounds, no_progress, plan_invalid,
environment_broken, unverified_finding, clarify, dependency_conflict, needs_paths,
task_exhausted, tasks_not_done, regression, conflict, design, epic_gate, manual, other. A
workflow's park is also its own decision row (`action: "park"`, rule `park.<kind>`), so `factory
why` lists every park with its reason and next step. A park recorded by an older factory (no kind) is
typed from its reason.

- **dependency_conflict**: the first time a builder's `task start` cannot merge its
  dependencies, realize rebuilds the task once, without spending an attempt, on a branch
  restarted from the integrated job branch (the old head is kept on a ref); a second conflict is
  the typed blocked result.
- **Reconcile regression on Tn**: the task whose merge dropped lines gets
  `needs_work: integration` with the dropped lines as its input and is rebuilt on the merged
  code automatically, once (`recovery` event, record status `retry`); a second regression parks
  with kind `regression`.
- **environment_broken** parks once with the command and its output; **scope_violation**
  restarts from the job branch; an invalid reply gets the schema's correction turn: unchanged.
- **Transient errors** (rate limits, 5xx, network): Claude Code retries API errors inside each
  agent call itself, and a workflow agent that still fails returns nothing (`no_result`, an
  attempt spent, or the "asked once more" retry for testers, integrators and reviewers). The
  factory has no place of its own to retry them, so copilot-factory's transient retry and its
  `transient` park are not part of this port.
- **An amendment submitted while parked** pre-empts the park: `factory next` presents gate A
  (`resumes_park: true`), and approving it does exactly what `resume` does (one more round of
  the cap that parked it, the budget ×1.5, clarify's onResume, the repeat guard cleared), logged
  as `human.resume` with `via: "amendment"`. Gate A can be approved only after the router
  presented it; denying it keeps the park.

## Realize by dependency

A task starts as soon as its own dependencies are integrated (done, without per-wave
integration), at most `limits.max_parallel_tasks` attempts at a time; done tasks are integrated
as they finish, one integration at a time. The guarantee from 0.15 holds per dependency: no
attempt starts or retries while an integration's checks run or a failed integration is being
repaired (except the repair), none starts on a broken integrated build, and tasks start from the
job branch as last integrated green. An integration's checks may run while other builders run
their own `task verify`; only attempts that started before the integration overlap it.

## Transcripts and usage

Claude Code keeps every subagent's transcript itself. The SubagentStop hook records its path
(`agent_transcript_path`) on the `SubagentStop` event, with what the transcript reports: tool
calls (`tool_use` blocks), tokens per model call (input, output, cache read and cache creation,
each message id counted once) and the models. No hook input carries usage and Claude Code writes
no cost into transcripts, so the factory reports tokens and tool calls only, and "—" (not zero)
where nothing was reported. `factory telemetry report` has a **Usage** section per job; the
console's job page has a **Usage** panel and each agent row links to its transcript (a `file://`
link in a snapshot; `factory console --serve` serves `/transcript?path=…` only for a `.jsonl`
inside Claude Code's transcript folders, after symlinks, that a factory agent's event of this
project names; the page and the route listen on 127.0.0.1, so another user on a shared machine
could read them, as they can the page). Where one run had several agents of a role (parallel
builders), a row lists that role's transcripts instead of claiming one, since the hooks name an
agent by id and the roster by label.
Transcripts can hold tool output (a printed `.env`, test logs): they stay where Claude Code wrote
them, under your home folder.

## Models

`policy.agents.models` names a model per role, as a Claude Code alias (`haiku`, `sonnet`,
`opus`, `fable`) or a full model id; the factory passes it as the agent call's own `model` (the
Workflow tool's per-call option, or the Agent tool's per-invocation `model`), which Claude Code
puts before an agent file's `model:` (code.claude.com/docs/en/sub-agents, *Choose a model*). The
agent files set none, so a role with no model runs on the main conversation's model.

The shipped default never runs a judgement role below the main conversation's model: only the
interviewer (it reads the user's words back) and the tester (it runs `task verify` and relays
it) are on `haiku`. Researchers (their claims become the contract's facts and the project brief),
the finding verifier (it settles serious findings, security ones included), every reviewer, God
Eye, the architect, the contract writer and the builder inherit the main conversation's model.
Builders step up through `builder_escalation` (`["opus"]`) from `builder_escalation_from_attempt`
(3), counted across realize runs. Name a tier per role in `.factory/policy.json` to trade quality
for cost on purpose (`null` or `"default"`: the main conversation's model);
`agents.models_enabled: false` (or `models: "default"`) puts every role, escalation included, on
the main conversation's model, read from the live policy so it covers jobs already in flight.
`factory doctor` lists every role by the model it runs on, and warns about a full id (the
Agent-tool path, used without the Workflow tool and for the lesson writer, documents aliases).

## The project brief

`.factory/project.md` is created at the first job and is yours to edit. Its sections:
Conventions, Module map, Test and lint commands, Environment, What ground found, Earlier
decisions (ADRs), Accepted lessons, Notes. Lines between `<!-- factory:auto NAME -->` markers are
refreshed by the CLI (from `git ls-files`, the manifests' scripts, the policy's checks, the build
environment, `.factory/jobs/*/adr-*.md` and the accepted lessons); delete a block's markers to
keep it yours. Each job's ground step replaces *What ground found* with its own cited claims
(one line each), and ground's history probe reads the ADR index. Every agent brief carries the
brief trimmed per section (the conventions, ADRs, lessons and your notes keep their room; the
module map gives way first), framed as data, not instructions.

The lesson writer may propose edits (one-line additions to Conventions, Module map, Test and lint
commands, Environment and Notes, at most 10 lines; removals only of lines an earlier accepted
proposal added). `factory distill done` stores them as a proposal (`P1` …, in
`.factory/project-brief.proposals.json`) and applies nothing. You reply `accept brief P1` or
`reject brief P1 <why>` (or run `factory lessons accept P1` in your own terminal): human-only,
like a lesson. The inbox and the drive's `done` stop list open proposals.

## Why it differs from copilot-factory 0.8.0

| copilot-factory | here | why |
|---|---|---|
| `factory drive` runs `factory run` (Copilot agents) and stops only for the human; `--detach`, `drive stop`, heartbeat, `status --wait` | the drive builds briefs and records results but hands each workflow to the main session; no detach | the CLI cannot start Claude Code subagents or the Workflow tool; a drive call is short (seconds between workflows), so it runs in the foreground under the tool's time limit |
| transient retry with backoff, `transient` park | none | Claude Code retries API errors inside each agent call; a workflow agent that still fails returns null and is handled as before |
| transcripts streamed to `.factory/scratch/runs/`, size caps, rotation, pruning, redaction | the path Claude Code already keeps, recorded by the SubagentStop hook | the transcripts exist; copying them would double the disk use and the secret exposure |
| usage and premium requests from Copilot's JSON events, a cost multiplier | tokens and tool calls from the transcript; no cost | Claude Code reports no cost in hooks or transcripts |
| model ids, a refused-model fallback, a CLI version check | aliases per call, one switch | aliases follow the main conversation's model family; a workflow agent that cannot start returns null, so a refusal can't be told apart (the switch is the escape hatch) |
| the dead-hook notice fix (`reply-watch.js`) | not applicable | claude-factory has no dead-hook notice |
| `factory run`'s `drive_in_progress` refusal | `factory next` answers `driving` | there is no `factory run` |
