# Clarify v2: a convergent clarify stage (design)

> **Superseded** by [DESIGN-CLARIFY-v3.md](DESIGN-CLARIFY-v3.md) in factory 0.16.0. Kept for jobs approved under clarify v2, whose `clarify-ledger.json` ground and decide still read, and for the migration.

Clarify used to be a fan-out that re-ran every round over the whole contract: analysts, a
judge and God Eye, with the chat agent editing the contract between rounds. This design makes
it **converge**: one ledger of issues that the CLI owns, identity by subject instead of
wording, one answer channel, rounds that review only what changed, implementation details
handed to design, a single writer for the contract, and a park rule that measures progress
instead of counting rounds. It is the port of copilot-factory's clarify v2 to this factory;
the parts that belong to copilot-factory's research phase (scouts, an evidence verifier,
unreachable sources) have no counterpart here and were left out (see "Not ported").

## Why

On a real job (Nautobot interface VLAN sync, standard@medium) clarify ran 9 rounds in about
2.5 hours and parked 4 times on the round cap. Every round re-reviewed the whole contract,
paraphrases of a settled question got new ids, free-form answers never settled anything,
God Eye's "revise" left the user with nothing to answer, and implementation details (the
exact switch command) were treated as intent. The same shape exists here: the judge's
questions were deduplicated on exact text only, `factory answer --question` matched nothing,
God Eye's revise sent the chat agent off to edit the contract by hand, and the round cap was
`max_intent_rounds + 2`, however much each round achieved.

## The ledger (one source of truth)

`jobs/<J>/clarify-ledger.json`, sealed like the other records (a hand-edited one fails its
seal and is rebuilt from the question log). Each question clarify raises is an **issue**:

| Field | Meaning |
|---|---|
| `id` | `U-n` |
| `subject` | a short stable key, e.g. `nxos.switchport-command` (agent-given, or derived) |
| `text`, `kind`, `impact` | `kind`: intent, scope, constraint, acceptance, decision or user |
| `owner` | `user` or `design` |
| `status` | `proposed` → `settled`, or `deferred_to_design` / `dropped` (`open` only transiently) |
| `settled_by` | `user`, `assumption_accepted` or `design_deferral` |
| `question_id`, `answer`, `default`, `options` | the Q-n it was asked as, the answer, the proposed default |
| `aliases` | folded duplicates (`[{id, text, question_id?}]`) |
| `notes`, `history` | `{round, event, actor, text?}` |
| `applied_round`, `edit_attempts` | the round whose contract revision applied this settled issue |

Top level: `rounds` (per round a `ledger` block: `opened`, `settled`, `deferred`, `dropped`,
`asked`, `revised`, `progress`, `degraded` and the `totals`), `notes` (God Eye's
approve-with-notes remarks, user notes on the contract), `sections` (the contract's section
hashes at the last round: what changed since) and `migration` (the report, for a v1 job).

**Settled is final.** A paraphrase or an agent's new question about a settled subject is
recorded as a note on the issue, never a reopen. Only the user changes their own answer
(`factory answer U-n "…"`), and after H1 only through an amendment.

## Identity: the dedup rule

Every agent output that raises an issue (analyst and judge questions, God Eye items) carries
`same_as` (`"U-n"` or `"new"`) and a `subject`.

1. `same_as: "U-n"` naming a live issue (or one of its aliases) attaches to it.
2. Otherwise the subject keys are compared: equal keys are the same issue when at least one
   side's key was given by an agent (a key derived from the text's first words is no identity
   on its own).
3. Otherwise significant tokens are compared (subject and text, lower-cased, stop words out,
   plurals stripped, a few synonyms: `cli`/`syntax`/`cmd` → `command`, `NX-OS` → `nxos`; for
   the comparison also `-ed`/`-ing`/`-e` endings): at least 3 shared tokens and Jaccard ≥ 0.5
   or overlap coefficient ≥ 0.75. When a word is swapped for another (each side lacks as many
   of the other's tokens), at least 5 shared tokens are required ("native VLAN" vs "allowed
   VLANs", "leaf" vs "spine"). When both sides carry an agent-given subject that differs,
   Jaccard ≥ 0.6 is required.

The rule is deterministic and written twice (`cli/core/clarify.js` and
`workflows/fanout-judge.js`, which cannot import); the tests check both agree. Every clarify
brief carries the ledger (CLARIFY LEDGER, after the pointer to the run file): settled issues as
"do not re-raise", open issues as "the only things to ask about", deferred ones as "not
clarify's".

## Owner: implementation facts go to design

Clarify settles what the user wants, the scope, the constraints and how done is judged; how it
is built is design. An issue is `owner: design` when the judge says so (`owner: "design"`, or a
dismissal whose reason says "design"), or, as the CLI fallback, when a non-intent issue's text
is about exact API field names, source line ranges, command syntax or parser behaviour (a
keyword rule). Design-owned issues become `deferred_to_design`; they are listed in the
contract's `## Deferred to design`, handed to ground and decide in their briefs, and never block
H1.

Clarify here has no research lane: the analysts read the repository themselves and the judge
dismisses what it answers. An agent's `owner: "research"` is therefore read as the user's.

## One answer channel

- `factory answer U-n "<answer>"` or `factory answer Q-n "<answer>"` settles the issue
  (`settled_by: user`); `factory answer Q-n --default` (or the answer `default`) accepts the
  proposed default. `--id Q-n --answer "…"` still works.
- `factory answer --question "…" --answer "…"` matches the text to an issue (the exact question
  text, then subject and overlap). No match during clarify: it fails with `no_match` and lists
  the open ids; nothing is silently dropped. After H1, free text is ground's (recorded by its
  question text, never matched to a clarify issue) and a U-n / Q-n answer is refused
  (`approved`: start an amendment).
- Chat: the prompt hook reads a numbered reply ("1 yes, 2 trunk ports too", one per line or
  comma-separated; "Q-4 no" names the question by id; "skip 2" leaves one to its default;
  "defaults" accepts every default there is) as the answers to the questions the last round
  showed, in the order shown (`state.clarify_shown`), through the same function. All or
  nothing: a number outside the set, a question twice, one already settled or a default that
  does not exist refuses the whole reply before anything is written. A reply none of whose
  numbers is in the set, or with an item ending in "?", is an ordinary message and is left
  alone.
- `factory clarify note <U-n|contract> "…"` adds context for the next round.
- `factory clarify split U-n <alias>` (human-only: the chat reply `split U-n <alias>`, or the
  user's own terminal, like `approve` and `resume`) undoes a wrong fold: the alias becomes its
  own issue again and is asked next round.

The user's relay stays the main session's: the guard refuses `factory answer` and
`factory clarify note` from a subagent (the hook payload names it), and `clarify split` from
anyone but the user.

## Rounds review only what changed

Round N's brief carries the answers, accepted defaults and notes since round N−1, the open
issues, and the contract sections whose hash changed since the last recorded round; the
analysts and the judge review only those. With nothing changed and nothing new (`nothing_new`),
the analysts and the judge are skipped and the ledger's own proposals are the questions.

God Eye answers a fixed checklist (`intent_clear`, `scope_bounded`, `acs_testable`,
`no_open_blockers`, `constraints_consistent`), and each item points at an AC, a section or an
issue (`ref`). Then:

- an item about a settled issue, or a duplicate subject, is a note;
- an item with a `ref` and severity blocker or major is **actionable**: the contract editor
  revises the contract and God Eye looks once more;
- what is still an actionable blocker after that becomes a user issue whose proposed default
  is God Eye's suggestion (one word to accept); an unconfirmed intent becomes an intent
  question with no default;
- "revise" with nothing actionable left is **approve-with-notes**: the notes are recorded.

So a round never ends `needs_user` with zero questions; with nothing for the user and the
contract not approvable it ends `revise` and runs again.

## One writer

During clarify the contract changes only through the workflow and `factory record`:

- the **contract-editor** agent (Read, Grep, Glob only) returns the revised contract text; the
  CLI validates it (it must parse, keep the Intent section, add no contract problems or foreign
  sections, and lose no acceptance criterion, constraint or non-goal unless the editor lists it
  under `removed` with a reason that holds up: a settled or dropped issue, or the God Eye item,
  user note or gate denial it was given) and writes it when it records the round. When the CLI
  refuses a revision, the round is not `ok` even if God Eye approved the revision. The editor
  runs at the start of a round when settled issues are not in the contract yet, notes or a
  denial reason are new (a denial goes to it once), or the contract has problems; and once
  after God Eye's actionable items;
- the CLI writes `## Clarifications (settled)` (user answers and accepted defaults) and
  `## Deferred to design` from the ledger.

The guard denies Write/Edit (and shell writes) of `.factory/jobs/<J>/contract.md` while the
job is in clarify: at least one clarify round recorded, no H1/EH1 approval, no amendment open.
The first draft (intake, the clarify skill, before round 1) and amendments after H1 stay
allowed. The deny names `factory answer`, `factory clarify note`, `factory clarify status` and
`factory next`.

## Convergence: progress, not rounds

- A round makes **progress** when something was settled, deferred or dropped since the last
  round, or the round asked the user new questions, or the contract editor's revision changed
  the text and applied what it was given (a settled issue, a note, a denial) or fixed a
  contract problem. A rewrite that applies nothing is not progress.
- A round with questions still waiting for the user (no default to fall back on) is
  `needs_user`, never a park: the user is the one to act.
- Clarify parks ("not converging") after `limits.clarify_no_progress_rounds` (default 2) rounds
  in a row without progress, or at the hard ceiling `limits.max_intent_rounds` (now default
  10; `factory next` parks with `cap.clarify_rounds`).
- A degraded round (analysts failed after their retry) is retried once automatically
  (`status: retry`); it counts toward neither rule. A second degraded round in a row parks the
  job (0.15.1), naming the failed analysts: `resume` to try again, or resume and run the round
  with `--accept-degraded`. A round that went on without an angle says so (`analysis_incomplete`)
  in its result and at H1.
- `resume` resets the no-progress counter and, after a ceiling park, allows
  `clarify_no_progress_rounds` more rounds. The round counter itself stays monotonic.

## Migration

A job that ran clarify before v2 has no ledger: its questions are in `state.question_log`
(sealed) and its answers in `answers.json`. The first v2 touch (status, answer, note, split,
the next round) builds the ledger from them; `factory clarify status` and the console migrate
in memory only, so they work right after an upgrade with no new round:

1. Each asked question becomes an issue, `U-n` in the order asked; subjects are derived.
2. Paraphrases (the token rule on wording alone) are folded into the earliest; the others
   become aliases, keeping their Q-n.
3. Answers by Q-n, or by the exact question text, settle by user (a later answer replaces an
   earlier one); free-form answers are matched by overlap (the report lists each match, so the
   user can check it); answers given after H1 are ground's and never matched.
4. Questions still open whose text is an implementation fact are deferred to design (listed).
5. Pre-v2 policy snapshots (no `clarify_no_progress_rounds`) get the ceiling
   `max(max_intent_rounds + 2, the live default)`, and the rounds the job ran before its first
   v2 round (`counters.clarify_v2_from`) are not counted against it.

## Visibility

- `factory clarify status [--job J] [--json]`: the issue table (id, subject, status, owner,
  next action, aliases), per-round counts with the trend, the answer commands, and the
  migration report. Read-only, open to agents.
- `factory next` for clarify carries `clarify`: open issues by owner, the open questions and
  the exact `factory answer` commands.
- Console: a Clarify block in the Blueprint's section view and in the Job view's Story (issues
  with status, owner and next action; the per-round opened/settled trend; what was handed to
  design; the questions waiting on you). The Board's "Your turn · Clarify" shows "N
  questions" from the ledger.
- Inspector: R6 checks counted rounds against the ceiling each round recorded; R19 flags
  stalled rounds (`R19.clarify_stalled`) and settled issues re-raised by agents
  (`R19.issues_reraised`); R7 treats `clarify status` as a look and `clarify note` as part of
  the clarify step.

## Not ported

copilot-factory's clarify has a research phase (an intent mapper, repo and web scouts, an
evidence verifier) and so research-owned issues, research attempts with a longer retry,
unreachable-source exits, failed sources and evidence verdicts. This factory's clarify does
not research: its analysts read the repository and its judge dismisses what the repository
answers. Those parts have nothing to attach to here, and an issue is the user's or design's.

## Known limits

- The token rule keeps short texts one telling word apart, but longer texts that share five or
  more words can still be folded ("Does the Nautobot interface VLAN API expose tagged VLANs?"
  vs "… the native VLAN?"): no word rule tells that apart from a paraphrase. A folded issue
  shows its aliases in `factory clarify status`, and `split` undoes it.
- The implementation-fact rule is a keyword rule; it applies only to non-intent issues without
  an agent-given owner.
- The contract editor rewrites the whole text; the CLI rejects a revision that adds contract
  problems or drops criteria without a reason, but cannot judge that a rewording is faithful
  (God Eye's second look does).
- Subagent detection for the user's relay relies on Claude Code's hook payload naming the
  agent (`agent_id` / `agent_type`); a shell an agent starts outside the hooks is not seen.
