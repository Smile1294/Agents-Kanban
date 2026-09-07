# Orchestration — turning one objective into the right number of agents

Research for the feature asked for as *"a Composer-style multi-agent system that
can take a large objective and intelligently coordinate multiple agents."*

**It is not called the Composer.** `composer` already means the message input bar
in this codebase — `UiState.composer`, `getState().composer.spentUsd`, PLAN.md §5
"Composer controls", CLAUDE.md "per-session choices stay on the composer". A
`Composer.execute()` sitting beside `UiState.composer` is a name collision on the
exact surface where this feature's control lives. The feature is
**orchestration**; the session that decides is the **objective session**; its
pieces are **tasks**, which are ordinary sessions; the setting is
`agentsKanban.orchestration`.

Produced by 33 agents reading Paperclip's real schema (126 Drizzle tables, 238
migrations, `doc/execution-semantics.md`), the verified Nimbalyst analysis in
[NIMBALYST.md](NIMBALYST.md), this codebase, and the published work on
decomposition, routing, scheduling, context handoff, validation and rework. Every
claim about `src/` below was checked against source; line numbers will drift.

Companion: [PAPERCLIP.md](PAPERCLIP.md) — how Paperclip actually works, so nobody
has to read it again.

---

## The answer, on one page

> **Status, checked 2026-09-07.** The four items below are built: the dial is
> `agentsKanban.orchestration` and `src/board/decomposition.ts`; the gate is
> `ManagerOptions.confirmSplit`, a host-side click; a refused split is recorded
> on the card (`decompositionLine`); the count is `SessionMeta.fanout`, and a
> child queued behind the concurrency limit gets a card. Per-piece routing (§4)
> is built too — `src/agent/routing.ts`, DECISIONS.md *"Per-piece routing"* —
> and the six bugs in §11 are fixed. What is NOT built is marked in §10 and
> summarised in [PLAN.md §9](../PLAN.md). The rest of this document is the
> research as written, kept because the arguments still hold.

**The feature already exists and is called `split_task`.** What was missing was
not an orchestrator; it was four things around the one we have, all since built:

1. **A dial** — how eagerly should this card break itself up — that biases the
   agent's judgement without ever dictating a count.
2. **A gate that is real.** `ASKS_FIRST` is not a boundary: `codex.ts` never
   reads `autoAllow`, and `canUseTool` is skipped under `dontAsk` and
   `bypassPermissions`. Today `split_task` starts four billed agents with no
   click in three configurations a self-driving-board user would actually pick.
3. **A record.** A refused split reaches the model and nothing else, so a session
   that tried to split, was refused, and did the work alone is byte-identical on
   the board to the correct adaptive outcome — *the feature working and the
   feature broken render the same.*
4. **A count.** `SessionMeta.fanout`, because a child queued behind
   `maxConcurrentAgents` has no card, no worktree and no sidecar entry, so the
   roll-up says *"All 2 subtasks are ready for you to test"* over a four-way
   split in which two agents never ran.

Everything else the brief asks for — a plan document, a dependency DAG, a second
board, validator agents, a router, budgets, a decision-log subsystem — is either
**stage 3**, gated on a measurement nobody has taken, or **declined**. Five of
the eight design sections in this research had their centrepiece cut.

That is the product principle applied to the feature itself. *"Use exactly as
much orchestration as the task justifies"* is not only advice to the planner.

### What stage 1 costs

| | Cost |
|---|---|
| A trivial objective | **one sentence** in `appendSystemPrompt`. No round trip, no planner, no classifier, no plan document, no approval click, no cold start. |
| A genuinely large one | one `split_task` call, one confirmation dialog naming the pieces and the reason, at most four agents. |

There is no plan-then-execute pipeline because the decision is made by the
session that would do the work anyway, **after it has read the repository** —
which is where the question can be answered from evidence, and which is the
answer this project already reached:

> *"The decision belongs to the agent, not to a heuristic here. 'Is this one job
> or two' is a judgement about the request and the codebase, which is what the
> model is for; a regex over the prompt would be worse and would fail silently."*
> — [DECISIONS.md](DECISIONS.md), the `split_task` postmortem

---

## 1. Architecture

### Orchestration adds zero entities

| Concept | Is | Lives in | After a host restart |
|---|---|---|---|
| **Objective** | a session with no `parent` and a `decomposition` record | runtime store + sidecar | survives; `running` says if it was killed |
| **Task** | a session with `parent` set | same | same |
| **Decomposition** | a record on the **parent** | `SessionMeta.decomposition` | survives, parsed |
| **Fan-out intent** | an integer on the **parent** | `SessionMeta.fanout` | survives; `fanout − childrenOf().length` names what never started |
| **Declared scope** | a `string[]` on the **child** | `SessionMeta.scope` | survives; `rename()` carries it free |
| **Drift** | a record on the **child**, written once at merge | `SessionMeta.drift` | survives; **absent ≠ no drift** |
| **Level** | per-session override + workspace default | `SessionMeta.orchestration` | survives |
| **Meter total** | **derived, never stored** | `sessions/usage.ts` | recomputed from transcripts |
| **Plan** (stage 3 only) | a document, many per workspace | `globalStorageUri` | **paused, never resumed** |

The axiom is unchanged and this feature does not widen it:

> A card and a session are the same thing at two zoom levels. A session's column
> **is** its `phase`.

The tempting alternative — *"a card is a task; a task acquires a session when it
starts"* — was proposed and does not survive contact with the code.
`getState()` builds cards from `manager.list()` and `store.list()` only; `metas`
is used solely to **enrich** keys that already have a live agent or a stored
session, so there is no card-emitting path. Worse, `UiCard.title` and
`UiCard.updated` are non-optional and `SessionMeta` has **neither** field —
titles live in Claude Code's store. A planned card renders `undefined — NaN ago`.

The diagnosis behind that proposal is right, though, and it is a real recorded
bug: a queued child is invisible. The cheap fix that closes it is **one integer**
on the parent, not a third loop in `getState()` and new semantics for all four
`startsWith('run-')` sites — under which a planned card could never be renamed,
archived or deleted at all.

### Tree and DAG are different relations over the same nodes

This is the single most transferable thing in Paperclip, and it is enforced
doctrine there rather than an accident. `issues.parentId` is a tree;
dependencies live in a **separate** `issue_relations` table with one edge kind,
`blocks`. Their own doc:

> *"Do not treat `parentId` as execution dependency by itself. If a parent is
> truly waiting on a child, model that with blockers."*

So `SessionMeta.parent` answers *"why does this card exist"* and drives the
roll-up. It must never become the scheduling edge. Conflating them gives either a
parent that blocks on unrelated children, or children that start before their
prerequisite.

Dependency edges are **stage 3 only**, live in the plan document, and name
**plan-local node ids minted before any session exists**. No edge ever names a
card key: a card's key is its run id until `system/init`, `rename()` repoints
exactly one field, and an edge has two endpoints inside an array — so a key-named
edge stops matching seconds into the first turn, which is precisely when a plan
is being watched.

### `fanout` is a count, not a list

The one thing a parent stores about its children, and deliberately an integer.
A count cannot go stale under `rename()`; a `children[]` list is the second copy
of a truth that goes stale at the worst possible moment, which is why it was
rejected for `split_task` in the first place.

It buys four honest numbers on the parent card, all derived, none stored as a
status:

> **4 asked for · 3 on the board · 1 interrupted 9m ago · 1 never got going**

That fourth clause cannot be derived any other way. `running` is written **inside
the `sessionId` handler**, with its own comment explaining why — a run that dies
before that point has no transcript and no session to resume. So a child
dispatched and killed in the seconds before its id arrives leaves **no mark**,
and `interruptedSessions()` iterates real sessions only. Every design that
claimed a killed fan-out was reconstructible from `running` marks alone was
wrong, and would have reported that child as "never started".

---

## 2. Adaptive decomposition, and the dial

### Three levels, not four

```ts
export type OrchestrationLevel = 'minimal' | 'balanced' | 'maximum'
```

Four was asked for and four is wrong here. `MAX_SUBTASKS` is 4 and
`maxConcurrentAgents` defaults to 3, so a fourth level resolves to the same cap
**and** the same disposition sentence as its neighbour — a named position whose
entire observable effect is identical to the one beside it. That is the same
class of bug as a control that cannot say no: the user moves the dial and nothing
on the board can report that the move did nothing. The fourth level arrives if
and when the plan document is the thing that could honestly raise the ceiling.

### The mechanism is one sentence, and the invariants are structural

```ts
export interface OrchestrationPolicy {
  level: OrchestrationLevel
  /** THE mechanism: which disposition sentence buildBrief() emits. */
  aim: 'one' | 'few' | 'several'
  /** Ceiling on pieces. min()'d with MAX_SUBTASKS, floored at 2. */
  maxPieces: number
}
```

The level may only **ask for more** and **allow less**. `aim` is prose that
cannot pass a code gate, so a level can never *require* a split; `maxPieces` is a
ceiling floored at 2, so it can never *forbid* one. Both hard requirements then
hold **by construction**, with no clamping arithmetic:

- *A trivial task stays one agent at Maximum* — a ceiling cannot require a split.
- *A huge task still decomposes at Minimal* — a floor of 2 cannot forbid one.

No gate anywhere else reads `level`. **An invariant enforced by a term the dial
moves is not an invariant.** The best test in the whole proposal follows from
this: `checkProposal` returns **identical verdicts** for two policies differing
only in `level`. Break it by making any gate consult the level, and it goes red.

`aimSentence(policy)` **replaces** the disposition half of `buildBrief()`'s
existing split paragraph; the operational half (fork-from-base, split-before-
editing) is invariant. Two paragraphs that both set the disposition is two things
that know the policy — and the longer, more specific one would win, so the level
would move nothing while every unit test stayed green.

### Where the dial lives

On the **composer bar**, beside model and effort, with `agentsKanban.orchestration`
as the workspace default and `SessionMeta.orchestration` as the per-card override
— the `resolveEffort` resolution order verbatim. It is a per-card judgement made
beside the card, not workspace configuration: a user with one huge objective and
five trivial ones must not toggle a setting and remember to toggle it back.

The control is **hidden**, never greyed, where it cannot take effect: a non-git
workspace (`onSplit` undefined) and a Codex session with no board bridge. Same
rule as `providerProfiles: false`.

The level is captured **at launch** into `DecompositionRecord.level`, and the gate
reads *that*, never live config. `buildBrief()` runs once at launch and bakes the
aim sentence in; the split arrives a turn later. Reading config at split time
would refuse "at Minimal" an agent whose brief said "several". A level change
applies to the **next** session — the same honest answer `setProvider()` already
gives.

### `checkProposal` — six gates, host-side, no model call

| Rule | Refuses because |
|---|---|
| `one-piece` | splitting into one is not a split |
| `over-cap` | **refuses, never truncates**, naming the number and the level |
| `scope-missing` | a task with no files of its own is not a task |
| `brief-cross-reference` | a brief that says "as task 2 decided" cannot run alone |
| `brief-too-long` | `split_task.prompt` has no cap today and models measurably ignore length instructions |
| `unknown-runtime` / `unknown-model` | refused **before any worktree exists** |

Truncation is the failure mode to avoid above all: at Minimal with a hard cap of
2, a six-piece proposal whose briefs reference each other's boundaries becomes
two agents running against briefs that assume four siblings exist. Refuse and
say the number.

**Scope overlap is a note, never a refusal.** Refusing on declared overlap treats
a prediction as a contract, refuses two honest unrelated tasks that both add a
dependency to `package.json`, and — worst — trains the model to under-declare,
which destroys the drift readout. Drift is the only mechanism in the entire
design that can ever say the split was *wrong*. The human at the confirmation
dialog is the right decider, and that moment already exists.

`MIN_BRIEF` is deliberately absent: a character floor is a proxy for completeness
that can only reward padding and can refuse a correct 143-character brief.

### Paperclip's five-condition test

The one thing worth copying wholesale into the tool description, because it turns
"adaptive, not maximalist" from a vibe into something checkable. Split only when
one of these holds:

1. different specialist ownership
2. parallelizable deliverables
3. a hard dependency that needs explicit blocking
4. an independent review or approval gate
5. substantial follow-up work needing separate tracking

Otherwise: one end-to-end task, one owner.

---

## 3. Delegation and hierarchy

**One level, and no depth counter.** `split()` enforces it with `if (card.parent)`.
Breadth and occasions are the axes that bound spend, and they are already counted
— a depth counter would be a third cap that can disagree with the other two.

**One cap on fan-out: `MAX_SUBTASKS = 4`.** Not raised for orchestration, not
shadowed by a second constant. Two caps over one parent that cannot see each
other let a card be split into 4 *and* fanned out into 6 — for ten sessions, with
each believing itself the ceiling. The level's cap is
`min(policy.maxPieces, MAX_SUBTASKS)`, computed in **one** function.

**A child inherits the *parent's* runtime, not the workspace default.** This is a
live bug today, one line: `split()` passes `{title, parent, base}` and no
runtime, so `launch()` falls through to the workspace default — a Codex
objective's children run on Claude, **permanently**, because a session keeps the
runtime it started on.

**The approval gate moves host-side.** `ManagerOptions.confirmSplit`, awaited
inside `split()` after the structural refusals and before the first `start()`,
refused on dismissal. `ASKS_FIRST` stays as the soft layer, because rule 7 is
"both, always" — but it cannot be the boundary (§ *Bugs found*, below).

**No automatic wake of a parent by its children.** Nimbalyst pushes a
`[Child Session Update]` prompt onto the parent's queue and re-drives it, which
makes the parent a live agent woken by its children. Declined here for a specific
reason: `manager.send()` pushes `{kind: 'prompt'}`, **indistinguishable from the
user typing**, into a session that holds `split_task` — a prompt-injection
channel into a tool that starts billed processes. The existing roll-up (parent
card moves to review, one notification) is the reporting mechanism.

That decision has a cost, and §12 is about it.

---

## 4. Model, provider and runtime routing

### The agent names, the host refuses

The elegant design is *requirements in, route out*: the planner emits a
requirement vector and a pure host function picks the model. It is the right
long-run shape and **it cannot be built now**, for a verified reason:
`claudeRuntime.models()` returns the built-in list with `supportedEffort`
deliberately omitted, so a `ResolvedEffort.noConcept` branch would announce
*"Opus 5 has no effort levels"* about a model with five. A router whose facts are
absent on the default runtime is a router that fabricates.

So: **the agent names `runtime` / `model` / `effort` per piece; the host
validates against the catalogue and refuses an id it does not serve** — before
any worktree exists, because `startRun()` throws after `worktrees.create()` has
already run.

Routing is therefore *checking*, not *deciding*, in v1. That is the honest
version, and it is not a placeholder: the model choosing its own tool is exactly
how model and effort already work per session here.

### What routing must never do

- **Never substitute on `LoginState.unknown`.** Refuse and quote the reason. A
  session keeps its runtime for life, so a wrong choice cannot be undone. Four
  login cases exist because they have four different fixes; "could not tell" is
  never "signed out".
- **Never key a policy on model names.** `MODELS` was wrong three ways at once
  and none were visible from inside the extension. Anything routing-shaped keys
  on what the runtime *declares* — `supportedEffort`, `contextWindow`, a rate in
  `MODEL_RATES` — and says so when it is guessing.
- **Never accept an effort a model cannot take.** There is no `unsupported-effort`
  rule in the six gates above, and that is a gap this research found and did not
  close: a piece proposing `xhigh` on a model where `supportsEffort` is absent is
  accepted by `checkProposal`, silently dropped by `permittedFlags()` at launch,
  and nothing on the card says the request was discarded. That is rule 2 in the
  exact place this codebase already has a postmortem (`ultracodeWarning()` being
  one-sided). **Add the seventh gate.**

### Per-piece routing must be captured at enqueue — DONE (`launchSettings`)

`startRun()` reads `this.opts.defaults.model`, `.effort`, `.ultracode`,
`.fastMode`, `this.opts.provider` and `this.opts.permissionMode` **after two
awaits**; `setDefaults()` and `setProvider()` replace that state wholesale; and
`drain()` launches a queued run minutes later. `MAX_SUBTASKS` (4) exceeds the
default concurrency (3), so **the fourth piece always drains late**.

Routing by mutating manager state therefore hands one task another task's model —
and a provider switch mid-fan-out runs half the fan-out on a different backend,
with different model ids and different bills. Per-run routing goes in
`LaunchOptions`, captured **in the queue entry**, and `startRun()` reads
`opts.X ?? this.opts.defaults.X` for every one of them.

This is the "a value captured before an `await` must be re-checked after it" rule
appearing in a new place, and it is the reason `provider` is on the list.

### Provider per task — BUILT, and the shape is one field, not two

This section named it as an open gap: *"`LaunchOptions` gains
`provider`/`providerEnv`, but `PieceProposal` has no `provider` field and
`ProposalFacts.models` is keyed by runtime only — while the real catalogue is
cached per provider. So 'local LLM for the cheap piece, cloud for the hard one'
is plumbed and not reachable, and `checkProposal` would validate a model id
against the wrong catalogue if it were."*

It is now built, in [`src/agent/routing.ts`](../src/agent/routing.ts), and the
gap analysis was right about the danger and wrong about the shape.

**Not `runtime` + `provider` as two fields.** One `agent` field naming a
`<runtime>|<profile>` combination — the same flat list the composer offers, and
for the reason the composer already has a postmortem about: two pickers make the
reader do a cross product, and the answer on screen was half of it. A piece
picks a row.

**The wrong-catalogue danger was real and is what the fix is built around.** The
spawn catalogue is composed per `(runtime, profile)` through
`catalogueForProfile(profile, rt)` — the same memoised composition the composer
uses — never from the active `catalogue`. `routing.test.ts` asserts exactly the
failure this section predicted: `deepseek-reasoner` named against
`claude|inherit` is refused, because a gate built from the active list would
have passed it and the child would 404 on its first request with somebody
else's error message.

**And the seventh gate above is closed.** `spawn-effort` refuses a level the
target model does not take, one-sided: an empty `efforts` list means nobody
asked, not "none".

See [DECISIONS.md](DECISIONS.md) — *"Per-piece routing"* — for the three bugs
found while building it, all of which were the same shape: routing resolved
twice, the second time minutes later.

---

## 5. Execution

### The dependent-fork problem, and why v1 has no dependencies

`split_task` forks each subtask from **what the parent forked from** — and that
is sound *only* because a split is refused once the parent's worktree is dirty or
has commits. The payoff is enormous and easy to lose: a subtask is an **ordinary
task branch**, so the existing diff, merge and cleanup paths never learned what a
subtask is.

A task that depends on another's code cannot fork from base. Every way out was
examined and each fails on a verified git constraint:

| Option | Why not |
|---|---|
| Fork B from A's branch on completion | `merge()` runs `git merge` in the **main** worktree and requires it on the target branch; git will not let the main worktree check out a branch another worktree holds. A second merge path with its own dirty-tree, conflict and abort semantics. |
| An integration branch held by the parent | Same constraint, plus its payoff only exists when the pieces are related — the opposite of the condition that triggers a split. |
| Hand B a diff as context | Empty by construction: `buildBrief` tells every agent to **stop at review without committing**, so at B's dispatch `git diff base...base` is nothing. |
| Sequence them in one worktree | Correct — and it means **two sequential pieces of one job are one task**. |

That last row is the finding. Worker-to-worker dependency as a *fork* relation is
**declined outright, not deferred**. Stage 3's `needs` edges, if they arrive, gate
on the user's existing one-click merge: no chain-fork, no integration branch, no
rebasing under a live agent, no octopus merge.

### The uncommitted-worktree trap

The common state of finished work here is a worktree full of **uncommitted**
changes, and merging a branch in that state merges nothing, silently. Any
automated multi-merge must gate every probe and every merge on
`hasWork = ahead > 0 || dirty > 0`, and respect that `merge()` **refuses rather
than improvises** — a described failure, not an exception and not a silent no-op.

### Context handoff: pointers, not transcripts

The child is given: the objective verbatim, its own brief, its acceptance
criteria, the decisions that bind it, and **pointers** — branch, base, changed
files, a diff command — never content. In a coding agent with filesystem tools,
anything recoverable by reading the repo must not be in the handoff. What cannot
be recovered is the *implicit* half: the interface the parent chose, the naming,
the approach, and the non-goals.

Size discipline is already law here: the transcript entry keeps the **count** of
attached images and never the bytes, because that array is serialised to the
webview on every repaint. A handoff obeys the same rule.

### What the child's brief must say, and does not

**The largest unwritten piece of this design.** Every section specified the *data*
a piece carries and none specified its *instructions*:

- siblings are editing the same repository in their own worktrees
- it may not merge
- it may not split again
- its declared scope will be checked at merge
- **stopping with `notify_user({urgency: 'blocked'})` because the brief is wrong
  is a correct outcome, not a failure**

The last has the strongest evidence behind it of anything in this research — an
explicit abort option dropped measured specification-gaming from 54% to 9% — and
nobody wrote the sentence.

### Scope drift is the only thing that can say the split was wrong

At merge, `changedFiles(worktree, base)` against the child's declared scope, into
`SessionMeta.drift`. One git call on a merge event, **never on the render path**.
Compare only tracked, non-ignored source paths and report the denominator —
*"2 of 14 changed files were outside the declared scope"* — or `dist/` and
`package-lock.json` make it wallpaper on the first merge.

`drift` is **absent** until a merge happens, and absent is **not** "no drift". An
unconfirmed split rendered as clean is `$0.00`-on-a-subscription in a new place.

---

## 6. Validation

### v1 has no validator agent, and the reason is not caution

Four verified blockers, any one of which is fatal:

1. **It would validate the wrong tree.** `launch()` reuses a worktree only when
   `opts.resume` is set. A validator has nothing to resume, so it forks a *fresh*
   worktree from base, finds none of the worker's changes, runs the gates against
   unmodified base, and returns clean.
2. **A validator is a session, and every session is a card.** `SessionStore.list()`
   enumerates by directory and `SessionMeta` has no hidden flag, so every judge
   run leaves a ghost card pointing at someone else's worktree.
3. **The read-only fence is a deny list where the SDK ships a positive allowlist.**
   `Task` is in `AUTO_ALLOW_BUILTIN` and on no plausible deny list.
4. **`permissionMode: 'plan'` may block the in-process MCP call the judge reports
   through** — unmeasured. If it does, a judge that found three blockers reports
   none, and the design manufactures the exact false pass it exists to prevent.

### What ships instead: the honest half, at zero model calls

```ts
export type GateOutcome =
  | { kind: 'passed';   command: string; ms: number }
  | { kind: 'failed';   command: string; ms: number; output: string }
  | { kind: 'absent';   looked: string[] }
  | { kind: 'errored';  command: string; message: string }
  | { kind: 'timedOut'; command: string; ms: number }
```

Five cases because they have five different fixes, and because `absent` folded
into `passed` is how "green" comes to mean "we checked nothing". `errored` is the
**common** case, not an edge: a fresh worktree has no `node_modules` — no seeding,
deliberately — so `npm test` exits 127.

```ts
export type Assessment =
  | { kind: 'unassessed'; reason: string; at: number }
  | { kind: 'blocked';    gate: GateResult; at: number }
  | { kind: 'findings';   findings: Finding[]; checked: CheckedBy; at: number }
  | { kind: 'noFindings'; checked: CheckedBy; at: number }
```

**There is no `clean` case.** The whole thesis of validation is that a judge's
"looks fine" carries almost no information — and `clean` is that word, minted by
the host instead. The cited analogue, `ultracodeWarning()`, returns
`string | undefined` and **never reports success**. `noFindings` makes a claim
about the *checks*, so the card reads *"typecheck passed · no test gate in this
project"* and there is no tick to earn. `unassessed` renders `—`, never green.

A signal must be able to say bad; it need not be able to say good.

### Scope creep, as lists

```ts
export interface ScopeReport {
  outsideDeclared: string[] | 'unknown'   // NEVER [] when nothing was declared
  testsTouched: string[]
  testsDeleted: string[]
  gateCommandChanged: boolean
  churn: { files: number }
}
```

`outsideDeclared` is `'unknown'` and never `[]` when nothing was declared: an
empty list reads as "nothing outside scope", which would be the one place the
absence of measurement renders as a clean result.

`testsTouched` is a **fact on the card, never a finding**. In a repo whose own
rule is *"a new test gate must be shown to fail"*, every correct change edits a
test file. Only two cases are cheap and unambiguous: a test file **deleted**, and
a change to the **gate command** in `package.json`.

### Independence, when a judge does arrive

Paperclip enforces it as a three-value per-card enum —
`anyone | not_creator | human_only` — resolved from the **activity log** actor who
moved the card into review, **failing closed** when that actor cannot be
determined. `human_only` is our existing `complete` guard. `not_creator` is four
lines of enum plus one host-side check, and it is the precise answer to *"without
letting the agent grade its own homework"* expressed as a property of the card a
user can see, rather than asserted by construction.

And the anti-loop bound worth copying: count consecutive **agent-initiated**
changes-requested rounds; at three, escalate to the human. **A human decision
resets the counter to zero.** Bound retries by a hash of the card's *durable*
state — phase, dependencies, changed files — never by a comment count, because
*"an agent explaining itself must not buy more attempts."*

---

## 7. Visualization

### There is no second board

The one section that **measured** settled this. 20 absolutely-positioned nodes
rebuild in **0.43ms** against a 100ms coalescer, so drawing was never the
constraint — `getState()` is (40ms at 20 sessions, 104ms at 60).

And the decisive finding about SVG: `layout.test.mjs`'s own idiom,
`scrollWidth - clientWidth`, returns **0** for SVG text escaping its box by 178px.
The one gate in this repo that can fail on a stylesheet would report PASS over an
unreadable plan. That is disqualifying — the graph view would be the only surface
here with no working layout gate, in a project that has *two* postmortems about
text that was present, correct, and unreadable.

So: **HTML nodes only, no SVG, no third `Mode`, no DAG canvas, no Gantt, no
progress bar, no plan-health badge.** Hierarchy renders as an indented,
expandable list with a status badge — which is, verified, exactly what Paperclip
does: its UI ships **no graph library**, and its org chart is a hand-rolled
recursive layout in plain divs.

Anything opened from the board opens **beside** it, inside `ownLayoutChange`. An
editor tab was proposed on the precedent of the settings page — the wrong
precedent: `settings.ts` uses `ViewColumn.Active` and is called from *outside*
`ownLayoutChange`, which is precisely the "a button on the board made the board
vanish" postmortem, and strictly worse for a surface opened while agents run.

One correction any node design must respect: host-computed `defaultOpen` cannot
work through `disclosure()` — `board.js` harvests **every** on-screen `<details>`
into `disclosed` on every render with no user interaction, so `defaultOpen`
applies for exactly one frame per key. It is a first-paint default and must be
documented as one, never as a panel that follows progress.

### What a node says

Title, runtime badge, model, effort, state, current tool, files changed, spend —
and the **age of the last frame**, because a spinner spins over a wedged process
too. The state vocabulary must be distinguishable without colour alone: queued,
waiting, running, validating, needs-changes, failed, done, interrupted.

### The stalled sweep — worth taking from Paperclip

Their **liveness contract** is the strongest single idea in that repo. For every
agent-owned non-terminal card, the system must be able to answer *"what moves
this forward next?"* from an **enumerated** list of durable primitives: a live
run, a queued dispatch, an unresolved blocker, a pending permission prompt or
question, a scheduled re-check, a human owner, an open recovery note. On a
low-frequency tick — **not** per streamed token — any non-terminal card holding
none of them is **stalled**, and is shown as stalled with an age.

That is this project's "never show a signal that cannot say bad" as a board-wide
sweep, and it closes a real hole: a piece that correctly refuses its brief with
`notify_user({urgency: 'blocked'})` currently ends as an idle agent in
`implementing` — indistinguishable from one still thinking and one that quietly
finished, with no climbing frame age because there is no live agent.

Their matching rule: **refuse a "blocked" state that is only prose.** Require a
blocker card id, a pending question naming a responder, or a typed
`{owner, action}` descriptor. Everything else routes to nobody.

---

## 8. Cost, controls and transparency

### `MeterTotal` — and the reducer is *most recent*, not max

```ts
export interface MeterTotal {
  usd?: { spentUsd: number; priced: boolean; sessions: number }
  windows: Array<{
    runtime: RuntimeId; plan?: string; windowMinutes: number
    usedPercent: number; at: number; resetsAt?: number; sessions: number
  }>
  unmetered: number
  sessions: number
}
```

A sum across a mixed set is **not** a `Meter`. `usd` sums and ANDs `priced` (one
false makes the total a floor, `≥ $4.12`), and is **absent** rather than
`{spentUsd: 0}` when nothing has a dollar figure — `$0.00` is the one thing the
union exists to disprove. `unmetered` is **counted** and rendered as its own
chip: "dollars we could not price" and "sessions with no dollar unit at all" are
different claims. Every chip carries its denominator.

Rolling windows reduce by **most recent** within a `(runtime, plan, windowMinutes)`
group. Three independent designs said `Math.max` and all three were wrong for a
reason none considered: `usedPercent` is an account-level reading, monotone
*within* a window and reset at `resetsAt`. Summing gives 26% of a window that is
13% full; MAXing pins the meter to a pre-reset 90% high-water mark **forever**, on
an account that is 6% used — and the obvious `max`-vs-`plus` test passes. Carry
`at` so the readout can go visibly stale.

Home is `usage.ts`, which already owns `MODEL_RATES`, `MODEL_WINDOWS`,
`normaliseModel()` and the drift check against the CLI's `total_cost_usd`. A
second place that knows how spend adds up is the `modelsForProfile`/`mergeModels`
bug in a new column.

### Budgets: Paperclip's honest limitation, and ours

Paperclip's enforcement is **post-hoc within a run**: `createEvent()` inserts the
cost event, recomputes the month total, writes the denormalised counters, and
*only then* evaluates the cap. A single expensive turn overshoots by design; the
cap stops the *next* invocation. Their budget scopes are only
`company | agent | project`, the metric only `billed_cents`, the window only
`calendar_month_utc | lifetime` — there is no per-run, per-issue, per-provider or
per-model budget, despite the README's implication.

None of that transplants. A monthly per-agent budget is meaningless when an
"agent" is a session that lives twenty minutes. What does transplant is the
**pre-execution gate order**, where every stage produces a *named cancellation*
rather than a silent skip.

So: one setting, `maxBudgetUsd`, gated on a runtime capability and **hidden**
otherwise, whose copy says what the cap actually is — *per query*, with a resume
getting a fresh one — never *"each task stops itself at $2.00"*.

**Declined:** monthly and lifetime budgets, per-agent budgets, `warnPercent`,
org charts, cron heartbeats, config versioning with rollback, HMAC-signed specs,
immutable audit logs, a generic API escape-hatch tool, a pre-flight cost
estimate, an ETA, a complexity score, a confidence number.

The pre-flight estimate deserves its reason: an estimate that cannot say *"I do
not know"* is decorative, and an estimate presented next to a real meter will be
read as a quote.

### Transparency: recorded, not generated

A model asked *"why did you split this into three?"* produces a fluent reason
whether or not it is the real one — published work puts a model naming its actual
cause under 20% of the time. So:

- The record holds **input values** and a greppable **rule id**.
- `sentenceFor()` renders from the record; **the record never stores the rendered
  sentence.**
- The model's own words live in a separate `stated` field — **quoted, attributed,
  bounded at 240 characters host-side, and captured *ex ante* at the tool call**,
  so it is a commitment checkable against the outcome rather than a sample from a
  distribution.

`split_task` already has a `reason` field whose schema promises *"Shown when they
approve the split"*. The handler drops it (§ *Bugs found*).

What is **declined**: a 20-rule decision subsystem with `alsoConsidered`,
confidence levels and supersession chains. That is a dependency-resolution audit
system for a decision made by one integer comparison, one catalogue lookup and
one human click. And an uncapped append-only `Decision[]` carrying model prose
lands on the 10Hz repaint path — the `Entry.images` postmortem, verbatim.

### Which controls earn their place

**Keep:** the orchestration level (per card, on the composer bar), the split
confirmation, cancel, retry, model/effort per session — all of which already
exist or are one field.

**Cut:** preferred-provider lists, per-plan concurrency, budget overrides,
approval-requirement matrices, manual plan editing, and the "maximum concurrent
agents" control duplicated per plan.

**Missing and needed:** a way to stop four agents started with one click.
`agentsKanban.stopTask` is per-key and `stopAll()` runs only on teardown, so
`confirmSplit` is a single click that starts N billed processes with no single
click that ends them.

---

## 9. Extensibility — and the new cost of runtime three

[RUNTIMES.md](RUNTIMES.md) says a third runtime is *"one module and one line"*,
and `startRun()` having no branch on runtime identity is the test of whether the
abstraction is real. **This design invalidates that claim and must say so.**

A third runtime now also owes: `ProposalFacts` entries, `MeterTotal` window
grouping, a `done`/`Meter` payload that satisfies the declared union, a
board-tools transport, `confirmSplit` copy, and a statement of whether its
`split_task` equivalent is gated. That is the number the extensibility heading
was actually asking for, and pretending it is still one line is how the next
adapter ships half-wired.

Two fields from Paperclip's adapter contract are worth adding to `AgentRuntime`,
because both solve problems this project has already hit:

- **`usageBasis: 'perTurn' | 'sessionCumulative'`** — the adapter *declares* which
  arithmetic its numbers need, instead of every adapter having to remember the
  cumulative-vs-per-step trap in PLAN.md §4. This project has fallen into that
  trap in two dialects already.
- **`errorFamily` + `retryNotBefore`** — classify a run failure into a small union
  with different fixes (transient, provider quota with a reset time, model
  refusal, credential expired) so wait-vs-retry-vs-stop is a decision on a typed
  value rather than a parsed error string, and so the card can say which of the
  four it was.

New **validators** extend by adding a gate to `discoverGates()` — a data change.
New **task types** are the `role` union, which today has two arms and no third
story. New **orchestration strategies** are the honest gap: there is one, it is
`split_task`, and nothing in this design is a strategy interface.

---

## 10. The staged build

**Stage 0 — prerequisites. DONE.** Six existing bugs, each defensible alone, none
mentioning orchestration. Every one is a seam the rest sits on. See § *Bugs
found*.

**Stage 1 — the decision procedure and the fast path. BUILT.**
`src/board/decomposition.ts` (`OrchestrationLevel`, `policyFor`, `aimSentence`,
`checkProposal`); the level control on the composer bar; `aimSentence` replacing
the disposition half of `buildBrief`; `split_task` gains `scope`; `split()` gains
`reason` and `checkProposal`; `ManagerOptions.confirmSplit`; `SessionMeta.fanout`
and the roll-up guard; the roll-up single-flight; `decomposition` and `scope`
persisted **and read back by a test**; refusals made visible on the card.

**Stage 2 — routing, drift, and validation's honest half. PARTLY BUILT.**
Nothing here calls a model. Built: per-piece routing captured at enqueue
(`launchSettings`, `resolveRoute`, `src/agent/routing.ts`) and the session-flag
gate on the launch path in one place. Not built, as of 2026-09-07: scope drift
at merge; `gates.ts` + `check.ts`; `snapshot.ts` for staleness computed **on
events**; `MeterTotal`; a roll-up reconciliation pass at startup (the roll-up
runs on phase changes only); `maxBudgetUsd`.

**Stage 3 — the plan document, dependencies, validators. NOT STARTED.** Each
item blocked on something stage 1–2 builds or measures. The validator is
additionally gated on measuring its false-positive rate against this repo's own
merged history first.

**Declined outright, not deferred:** worker-to-worker dependency as a fork
relation; any automatic wake of a parent by its children; an `execute()` that
calls `start()` directly and bypasses `split()`'s refusals; a second board; a DAG
canvas; SVG labels; a Gantt; a progress bar; a model-spoken verdict; a judge
panel; auto-merge on a clean check; a "validated" column; monthly budgets; org
charts; cron heartbeats.

---

## 11. Bugs found in the current code while researching this

All six were verified against source when this was written, and **all six have
since been fixed**. Kept as a list because the pattern — a contract declared and
unenforced — is the one to watch for:

1. **The `done`/`Meter` seam.** `session.ts` now emits the `Meter` union and
   `manager.ts` settles it through one `settleMeter()`; `spend.test.ts` feeds
   both runtimes' payloads.
2. **`SessionMeta.runtime` is written** at launch (`durablePatch`) and parsed on
   the way back, so a finished Codex session's transcript, usage and meter route
   to Codex's store.
3. **`store.meter()` has a caller** — `getState()` puts the selected session's
   meter on the composer, and `unknown` renders as `—`.
4. **`ASKS_FIRST` is backed by code** — `ManagerOptions.confirmSplit` is a
   host-side click, so `dontAsk`, `bypassPermissions` and a Codex session cannot
   fan out four billed agents silently.
5. **`split_task`'s `reason` reaches the dialog** — `onSplit(subtasks, reason)`.
6. **The roll-up cannot be false** — `SessionMeta.fanout` is the denominator,
   and a child queued behind `maxConcurrentAgents` gets a card of its own.

Also fixed: a child inherits the parent's WHOLE agent, runtime and backend —
DECISIONS.md *"Per-piece routing"* — and `move()` no longer refuses a `run-`
key, so a card can be dragged before its session id has arrived.

---

## 12. The biggest risk, which is not in any section

**Every act of composition was individually declined, so what ships is
decomposition with a dial.**

- the parent wake — declined, correctly
- a pull tool (`get_session_result`) — never considered
- chain-forking and integration branches — declined, correctly
- a second split — refused, correctly
- whole-objective validation — `unassessed`, by design
- re-running the parent — still open, and it was open before this research

Each argument is sound on its own. Nobody assembled them. The composite is that
after a fan-out, **no agent and no code is responsible for the objective as a
whole.** The "objective session" is an objective *planner*. The work of turning N
branches into one working change is transferred, in full, to the human.

And the existing decision that made that acceptable is the one this feature
erodes:

> *"the split condition — unrelated work — is the case where there is nothing to
> integrate."* — DECISIONS.md, Still open

Stage 3's `needs` edges delete that premise. The proposal removes the reason an
open item was acceptable and does not notice.

The risk mirrors the product principle exactly. *Adaptive, not maximalist* means
it splits precisely when the work is large — which is precisely when integration
is hard. So the design does most of its work in the regime where the unowned half
costs most, and its only detector (`drift`) fires **after** the merge the user has
already performed.

**The concrete gap:** what does the user *do* when four branches are ready?
`merge()` is per-card and runs in the main worktree, which git will not let hold
two branches at once; `offerWorktreeCleanup` fires per card, one dialog at a time;
nothing sequences four merges, orders them by conflict risk, or says what happens
when the second conflicts after the first landed. The board's whole promise is
*"what do I test, and when"* — and at N = 4 it has no answer. **This is a
different question from dependency edges, it is larger, and it should be solved
before the dial ships.**

A close second, and the reason the first will not be caught: **the design is
self-sealing about its own dial.** The mechanism is one prompt sentence, the
invariant is "the level touches nothing else", and the flagship gate asserts that
`checkProposal` returns *identical* verdicts across levels. If the sentence turns
out to do nothing, every gate stays green, no test can fail, and the only control
the feature adds is decorative — a control that cannot say no, guarded by a suite
constructed so it cannot say so either.

---

## 13. Open questions, and the experiments that settle them

This project's rule is **run a real agent before believing the suite**, and
DECISIONS.md's *"The first real agent run found four bugs in an hour"* is the
precedent. **No agent was run for this research.** These are ordered by how much
they would change the design.

1. **Does the aim sentence move behaviour at all, or is the level a placebo?**
   The single question the whole feature rests on. Twelve real objectives against
   a temp clone — four trivial, four genuinely two-job, four ambiguous — driven
   through `AgentManager` at `minimal` and `maximum`. Twenty-four runs, recording
   `requested` and the final `fanout`. **If the two distributions are
   indistinguishable, cut the level rather than ship a control that cannot say
   bad.**
2. **Do this project's gates even run inside a fresh worktree?** No seeding is
   deliberate, so `errored` (exit 127) may be the *majority* outcome, which would
   make the gate ladder useless exactly where a split creates the most worktrees.
   Five fresh worktrees, run `discoverGates()`, record the distribution. If
   `errored` dominates, Tier 1 needs a provisioning story before it needs a judge.
3. **Is `MAX_SUBTASKS = 4` the right ceiling?** DECISIONS.md notes a four-way
   split on the default limit of 3 shows "2 subtasks" — because the parent holds a
   slot while it splits — so the useful ceiling on default settings may be **two**.
   Eight large objectives at `maximum`, instrumenting `activeCount` at each
   `start()`, against the same eight run as one agent each.
4. **What does a cold start actually cost per child?** The claim that a fresh
   worktree pays an uncached ingest of CLAUDE.md (457 lines) plus PLAN.md (560),
   because each worktree is a distinct cwd and cannot share a prompt-cache prefix,
   is asserted and never measured — and the fourth agent is priced on it. Four
   sessions in four fresh worktrees, `contextTokens` after turn one, against four
   follow-up turns in one worktree. **This decides whether "more agents cost
   tokens" is an argument or a slogan.**
5. **What is a model judge's false-positive rate on this repo's own merged
   history?** Free, offline, and the gate that decides whether stage 3's validator
   is usable at all. Thirty merged commits replayed through a judge with the diff
   and gate output, counting blocking findings on known-good shipped code. Above
   ~2 per commit it is annoying before it is ever right.
6. **Does `permissionMode: 'plan'` block an in-process MCP tool call?** One real
   session with a trivial tool. If it does, the judge's whole reporting path is
   broken in the direction that manufactures a false pass.
7. **Does a Codex agent call `split_task` at all, and does the aim sentence reach
   it?** Every behavioural claim here is reasoned from Claude Code's behaviour,
   and `codex.ts` never reads `autoAllow`. A runtime where the level cannot take
   effect must **hide** the control.
8. **Does the model under-declare `scope` once a gate has refused it for
   overlap?** The reason overlap is a note and not a refusal is a *behaviour*
   claim, not a code claim. Run the same eight two-job objectives both ways and
   compare declared scope against `changedFiles()` at merge.

### Also unresolved, and cheaper to just ask

- What the user actually wants at N = 4: four diffs, or one?
- Whether a queued child's invisibility is something users notice, or a problem
  only the code can see.
- `MAX_BRIEF = 6000` has no derivation.
- Windows path semantics and glob matching in `scope` — model-written globs
  compared against git's forward-slash paths, with no matcher named.
- Keyboard reachability and `aria` roles for the confirmation dialog's piece
  list, the decomposition disclosure and the drift line.
- The objective session's **own** cost, separately: its planning turn is a real
  billed turn and it holds a concurrency slot while it decides. *"Was the
  orchestration worth it"* cannot be answered without separating what deciding
  cost from what doing cost.

---

## Sources

- [paperclipai/paperclip](https://github.com/paperclipai/paperclip) — schema,
  migrations, `doc/execution-semantics.md`, `doc/TASK-WATCHDOG.md`. Distilled in
  [PAPERCLIP.md](PAPERCLIP.md).
- [nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst) — via
  [NIMBALYST.md](NIMBALYST.md); **do not re-clone it**.
- Cognition, *Don't Build Multi-Agents* — the context-fragmentation argument.
- Anthropic, *How we built our multi-agent research system* — orchestrator-worker,
  the token multiplier, and which task shapes benefit.
- Anthropic, *Effective context engineering for AI agents*.
- AutoGen / Magentic-One — the task ledger and progress ledger.
- LangGraph, OpenAI Agents SDK, CrewAI, MetaGPT — surveyed in full; see §4 and §7.
- This repository: [CLAUDE.md](../CLAUDE.md), [PLAN.md](../PLAN.md),
  [DECISIONS.md](DECISIONS.md), [RUNTIMES.md](RUNTIMES.md),
  [PROVIDERS.md](PROVIDERS.md).
