# How Paperclip works

Findings from a read of [paperclipai/paperclip](https://github.com/paperclipai/paperclip)
(`master`, MIT, Node + React + Postgres) — the source, not the marketing. Read:
126 Drizzle table files under `packages/db/src/schema/`, 238 numbered migrations,
`server/src/services/heartbeat.ts`, `budgets.ts`, `issues.ts`,
`cross-issue-influence-limit.ts`, `decision-signing.ts`, `packages/adapter-utils/src/types.ts`,
the `ui/` components, and — the two most valuable documents in the repo —
`doc/execution-semantics.md` and `doc/TASK-WATCHDOG.md`.

**Don't re-clone and re-analyse it**, same rule as [NIMBALYST.md](NIMBALYST.md).
If something here is missing, the schema directory and those two docs are where
to look first.

**Confidence.** Everything below is quoted from a file that was actually read,
**except** §5's five-condition split test, which comes from a WebFetch summary of
`skills/paperclip-converting-plans-to-tasks/SKILL.md` and is corroborated —
though not word-for-word — by `doc/execution-semantics.md` §7 in the repo's own
voice. Line numbers will drift.

---

## What it is, and why the framing misleads

Paperclip models a **company**: agents are persistent employees with org charts,
monthly budgets, scheduled heartbeats, and hiring approvals. *"If OpenClaw is an
employee, Paperclip is the company."*

Almost none of that metaphor transplants to Agents Kanban, where an "agent" is a
session that lives twenty minutes. **That is not why it is worth reading.** It is
worth reading because Paperclip has already fought — and written the postmortems
for — every failure this project's orchestration will hit:

- a task owned by two agents at once
- a decomposition that half-completed and then retried
- an agent that declared "done" without proof
- a validator that judged a stale version of the work
- a run whose process died while the row still said `running`
- a card nobody will ever move again
- an agent that talked its way into infinite retries

---

## 1. The data model — a tree **and** a DAG, deliberately separate

`issues.parentId` is a self-referencing FK. Dependencies live in a **separate**
`issue_relations` table whose `type` is typed `$type<"blocks">()` — one edge kind
— with `uniqueIndex(companyId, issueId, relatedIssueId, type)`.

The doctrine is explicit, and it is the single most transferable thing here:

> *"Do not treat `parentId` as execution dependency by itself."*
> *"If a parent is truly waiting on a child, model that with blockers."*
> — `doc/execution-semantics.md` §6

**Goal ancestry is denormalised, never walked.** Four independent columns
(`companyId`, `projectId`, `goalId`, `parentId`) on every issue row, and repeated
again on every `cost_events` row. `goals` is its own separate tree with `parentId`
and a `level`.

> For us: stamp the objective id on the card at creation rather than walking
> `parent` chains at render. `getState()` runs ten times a second while an agent
> streams — an ancestry walk per card per frame is the class of work
> [`coalesce.ts`](../src/board/coalesce.ts) exists to prevent. A denormalised
> pointer also survives the parent being archived; a walk does not.

---

## 2. Ownership is a compare-and-swap, not a lock

`checkout()` is **one conditional UPDATE**:

```sql
UPDATE issues SET assigneeAgentId=?, checkoutRunId=?, executionRunId=?, status='in_progress'
WHERE id=? AND status IN (…) AND (assignee IS NULL OR <same-run>) AND <lock condition>
RETURNING *
```

Zero rows returned means someone else won — and **only then** does it re-read the
row to produce a specific conflict message.

Two lock columns with different meanings, which is the part worth copying:

| Column | Answers |
|---|---|
| `checkoutRunId` | who currently owns **execution rights** |
| `executionRunId` | which run is **actually live right now** |

**Stale-lock recovery is deliberately narrow.** Locks are cleared or adopted only
when the run they point at is terminal or missing — never when it is non-terminal.

> *"Stale-lock recovery is crash recovery, not a retry loop… After stale cleanup,
> a checkout 409 should mean a real live owner. Agents must treat that 409 as an
> ownership conflict and stop rather than retrying the same checkout."*

> For us: the two-column split is the useful half. A card can be **owned by a
> plan** while no process is live, and the board must tell that apart from
> "waiting for a concurrency slot" — those have different user actions. And a
> read-then-write claim is not enough: an extension-host restart mid-claim
> produces two worktrees for one card.

---

## 3. Heartbeats, coalescing and the zombie guard

Agents wake on a schedule or an event. A wake for the same agent + task scope
merges into the first pending item (`queued` → `scheduled_retry` → `running`),
merging the context snapshots — **and still writes a row** with
`status: 'coalesced'`, a `coalescedCount` and a `runId` pointing at the target.

The guard is the good part: a run whose status is `running` but which is **not in
the in-process live-execution registry** is refused as a coalesce target, because
coalescing *"would refresh `updatedAt` and make it immortal."*

The pre-execution gate order in `claimQueuedRun` is fixed, and each stage
produces a **named cancellation**, never a silent skip: (1) run still queued,
(2) agent exists, (3) agent invokable, (4) budget, (5) per-agent daily cap,
(6) workspace, (7) secrets, (8) skills.

> For us: cron heartbeats are not wanted — this board is event-driven and should
> stay so. What transplants is *a button that did nothing must be visible as a
> decision*, and the zombie rule: never merge into an item the live registry does
> not actually hold.

---

## 4. Budgets — and the honest limitation

Narrower than the README implies. Budget **scopes** are only
`company | agent | project`; the **metric** is only `billed_cents`; the **window**
is only `calendar_month_utc | lifetime`. There is no per-run, per-issue,
per-goal, per-provider or per-model *budget* — those are dimensions on
`cost_events` for **reporting only**.

**Enforcement is post-hoc within a run.** `costService.createEvent()` inserts the
event, recomputes the month total by aggregate, writes the denormalised
`agents.spentMonthlyCents` / `companies.spentMonthlyCents`, and *only then*
evaluates the cap. A single expensive turn overshoots by design; the cap stops
the **next** invocation.

Billing is recorded honestly on the event and then lost in the roll-up:
`cost_events` carries `billingType`
(`metered_api | subscription_included | subscription_overage | credits | fixed | unknown`)
and `costStatus` (`reported | unpriced`), and the reporting queries split metered
from subscription — but the budget aggregate does not.

> For us: monthly per-agent budgets are meaningless for a twenty-minute session.
> What transplants is the **named-cancellation gate order**, and the confirmation
> that `Meter` being a union was right — Paperclip records the same distinction
> per event and then throws it away at the aggregate, which is exactly the
> `$0.00`-on-a-subscription failure one layer up.

---

## 5. Decomposition is a first-class, exact-once, resumable record

`issue_plan_decompositions`: `sourceIssueId`, `acceptedPlanRevisionId`,
`requestFingerprint`, `requestedChildCount`, `requestedChildren` (jsonb),
`childIssueIds` (jsonb), `status` (default `in_flight`), `ownerRunId`, with
`uniqueIndex(companyId, sourceIssueId, acceptedPlanRevisionId)`.

> *"the claim is durable before fan-out starts; partial progress is durable while
> fan-out is underway; the completed child result set is durable after fan-out
> finishes"* … *"if a run creates some children and then dies, retries must
> continue from the same fingerprint and reuse the already-recorded partial
> result."*

> For us, directly: `AgentManager.split()` creates 2–4 worktrees and sessions in a
> loop, and **there is no recovery path if the host dies after the second one** —
> "once per session" then either blocks the repair or permits a duplicate. Write
> the claim *before* the first worktree, key it on the plan hash so re-accepting
> the same plan is a no-op, and resume from `created[]`.

### The five-condition split test

Split only when one of these holds:

1. different specialist ownership
2. parallelizable deliverables
3. a hard dependency requiring explicit blocking
4. an independent review or approval gate
5. substantial follow-up work needing separate tracking

Around it: *"use the fewest issues needed to complete and verify work"*, *"prefer
one end-to-end task with one owner over separate tasks for each step, file,
component, or phase"*, and the hard rule that *"a child must not be created
merely because a plan was accepted."*

> For us: this is "adaptive, not maximalist" as a **named test** rather than a
> preference, and it goes in both places `set_phase` already uses — the tool
> description *and* code. The checkable half: a proposed split where every child
> has the same runtime and model, no declared blockers between them, no separate
> review gate and the same base is a split satisfying none of the five. Refuse it
> with that sentence — `split()` already refuses *"if the work is one thing, just
> do it."*

---

## 6. Child → parent reporting is a prompt-injection surface

Write authority is **subtree-scoped per run**, and there are exactly three
sanctioned channels:

1. **The always-on completion signal.** `issue_blockers_resolved` wakes the
   parent; no report comment needed — *"the child's own thread is the deliverable
   record."*
2. **A direct-parent comment**, widening the boundary *"exactly one hop upward"*,
   comments only, never grandparents or siblings — and **off by default** under
   `low_trust_review`, because a contained run reads untrusted input and its prose
   comment is *"a prompt-injection promotion path."*
3. **A system-attributed stop-only relay** on `blocked` / `cancelled` only,
   depth-1 by construction, deduped per (child, target status).

Lateral coordination is the **courier pattern**: create a new self-contained issue
assigned to the target.

> For us this is the most important finding in the repo. It is the reason to
> decline Nimbalyst's parent-wake: `manager.send()` pushes `{kind: 'prompt'}`,
> indistinguishable from the user typing, into a session holding `split_task` — a
> tool that starts billed processes. If a results channel is ever built, it passes
> a **typed object with named fields**, never transcript prose, and a validator's
> deliverable is **its own card that the human reads**, not a message into the
> worker's context.

---

## 7. Independent validation, as a three-value enum

```ts
ISSUE_REVIEW_POLICIES = ["anyone", "not_creator", "human_only"]
```

`not_creator` is resolved by finding, **in the activity log**, the actor who moved
the issue into `in_review`, and refusing that same actor's verdict. When the
requester cannot be determined it **fails closed**. Refusals carry
`{code: 'review_policy_denied', policy, allowedActor, remediation}`. Legacy
ambiguous rows are narrowed, never widened: *"Pending cards are never silently
widened."*

Above it sits an evidence chain for "why did this card move?":

`completion_contracts` (`revision` and `canonicalSha256` unique per issue, `risk`,
`completionAuthority`, a supersedes chain)
→ `work_assessments` (`inputDigest` **unique per (company, issue)** so identical
evidence is judged once; `priorIssueStatus` + `priorStatusVersion` +
`priorDecisionId` bind the verdict to the version it judged)
→ `status_decisions` (`decisionVersion` and `decisionDigest` unique per issue,
`applicationState` default `proposed`, applied by bumping `issues.statusVersion`).

Composite foreign keys make it **structurally impossible** for an assessment to
reference another issue's run, contract or result.

> Two things to take even at small scale. **(a) The completion contract:** write
> the acceptance criteria once, hash it, and make the validator judge against that
> hash — otherwise criteria drift to match whatever the worker produced. We have
> `howToTest` on the card; hashing it at dispatch turns it into a contract.
> **(b) `priorStatusVersion`:** a validator that started before a follow-up turn
> must not apply its verdict to the newer state. That is CLAUDE.md's *"a value
> captured before an `await` must be re-checked after it"* at the scale of
> minutes — and a validator run **is** an await of several minutes.
>
> `human_only` is already our `complete` column. `not_creator` is four lines of
> enum plus one host-side guard, and it is the precise answer to *"without letting
> the agent grade its own homework"* — expressed as a property of the card a user
> can see, rather than asserted by construction.

---

## 8. The task watchdog, and its anti-loop design

One per issue. It walks the subtree by `parentId` while **excluding** every issue
whose `originKind = 'task_watchdog'` and everything below it, so it can never
trigger on its own review tasks. It fires only when the whole subtree is at rest
**and** no included issue has a live run, queued wake or scheduled retry.

Suppression is by a **SHA-256 stop fingerprint** over the stopped leaves'
identifiers, statuses, blockers, pending interactions **and the watchdog's own
configuration** — stored as *both* `lastObservedFingerprint` and
`lastReviewedFingerprint`. The wake's idempotency key is
`(watchdogId, stopFingerprint)`.

Its mandate treats every stopped leaf as a **claim to verify against evidence**,
and explicitly does not accept *"I could not"* or *"waiting for approval"* as
valid. Custom instructions *"can narrow focus or veto specific shortcuts. They
cannot grant authority the server does not already give the watchdog"* — enforced
at the route layer regardless of the prompt.

> The fingerprint is the key idea: **a validator that re-fires on an unchanged
> state is a money loop**, and hashing the state it judged stops it without a
> timer. The observed-vs-reviewed pair matters too — a state seen but not yet
> judged is still pending, which one field cannot express. And *"instructions can
> narrow, never expand"* is CLAUDE.md rule 7 in its hardest form: a user-authored
> validator prompt is untrusted **with respect to authority**.

---

## 9. The liveness contract — the strongest single idea in the repo

For every agent-owned non-terminal issue, the system must be able to answer
**"what moves this forward next?"** from an *enumerated* list of durable
primitives: an active run; a queued wake; a typed execution-policy participant; a
pending interaction or approval naming a responder; a one-shot monitor with
`nextCheckAt`; a human owner; a blocker chain whose unresolved leaves are
themselves healthy; or an open recovery action naming owner and action.

**Anything else is STALLED and must be surfaced.**

Correspondingly, entering `blocked` requires a **routable waiting path**:

> *"Prose-only blocked — free-text that names an owner or action in a comment
> without any of the paths above — routes to nobody. It is rejected at the API or
> auto-classified as `needs_attention`."*

And explicitly: *"A PID, session id, log file, comment, or promise to check later
is evidence only"* — a local background process is **not** a durable path.

> This generalises *"never show a signal that cannot say bad"* from one indicator
> to the whole board, and it is the rule orchestration most needs, because a plan
> of eight cards has eight ways to silently stop. Concretely: a card in a
> non-terminal column with no running session, no queued dispatch, no unresolved
> blocker and no pending permission prompt is **stalled**, and the board should
> say so with an age. And `notify_user({urgency: 'blocked'})` should require a
> structured `{waitingOn}`, or it is prose that routes to nobody.

**Output silence is classified but never acted on** — `ok | suspicious | critical
| snoozed | not_applicable`, and *"they do not create an issue or recovery action…
do not wake an agent, cancel the active process, or change the run."* Operator
decisions are recorded per run: `snooze` with an until-time, `continue` (a
30-minute re-arm, *"only a short acknowledgement of the current evidence"*),
`dismissed_false_positive` with a reason.

> Our frame-age indicator is exactly this signal and is already correctly scoped:
> it shows the number, it does not act. Resist escalating off it — a quiet agent
> mid-`Task` is not a failed agent. What is worth adding is the **snooze with an
> until-time**, so a known-slow task stops nagging without weakening the indicator
> for everything else.

---

## 10. Failure feedback is bounded three ways, and prose cannot extend the bound

- **Recovery: exactly one automatic wake**, preserving the existing owner —
  *"Auto-recovery preserves the existing owner. It does not choose a replacement
  agent."* Then `blocked` plus a board-owned recovery action. The retry bound is
  keyed by *"an idempotent durable source-state fingerprint"*, and
  **"Comments, repeated parked summaries, and equivalent prose do not reset it."**
- **Deliberate-wait repair:** five attempts at 0 / 60 / 120 / 240 / 480 s with up
  to 10% jitter.
- **Review ping-pong:** `DEFAULT_MAX_REVIEW_ROUNDS = 3` consecutive
  **agent-initiated** changes-requested rounds before escalating to the
  responsible human, and **"human decisions always reset the counter."**

Recovery runs carry capability guards — `allowDeliverableWork: false`,
`allowDocumentUpdates: false`, `resumeRequiresNormalModel: true` — and must hand
back to a worker run before real work resumes.

> All three transplant. A round counter incremented only on agent-initiated
> rejections and reset by a human decision bounds the machine loop without
> penalising a human who wants two more passes. *"Never substitute a different
> agent automatically"* is a product stance worth adopting: silently retrying a
> failed subtask on a bigger model hides the failure and doubles the bill. And
> bounding retries on the card's **durable state** rather than a comment count is
> the rule that stops an agent from explaining its way into more attempts.

---

## 11. The adapter contract is richer than `AgentRuntime`

Four fields solve problems this project has already hit:

| Field | What it does |
|---|---|
| `usageBasis: 'per_run' \| 'session_cumulative' \| null` | the adapter **declares** whether its token counts are per-invocation or running totals; *"the server must delta consecutive runs"*. Absent = unknown. |
| `errorFamily` + `retryNotBefore` | six cases — `transient_upstream`, `provider_quota`, `model_refusal`, and three refresh-token states — so wait-vs-retry-vs-stop is a typed decision |
| `refreshModels?()` | explicit cache bypass *"so the UI can fetch newly released models without waiting for cache expiry or a code update"* |
| `getConfigSchema?()` | a declarative field list, so the UI renders adapter-specific settings without shipping components |

Also present and absent from ours: `sessionCodec.deserialize` with `clearSession`;
`getQuotaWindows()` returning `ProviderQuotaResult { ok, errorFamily, error, windows[] }`
where each `QuotaWindow` is `{label, usedPercent|null, resetsAt|null, valueLabel|null}`;
`detectModel()`; `loginCapability` (*"holds no secret"*);
`runtimeToolDelivery: 'native_mcp' | 'invocation_context'`; and `testEnvironment()`
returning per-check `{level: error|warn|info, message, hint, code}`.

> `usageBasis` is [PLAN.md §4](../PLAN.md)'s context-meter trap **as a declared
> field** instead of a convention every adapter must remember — and this project
> has fallen into it in two dialects already. `errorFamily` is what lets a plan
> decide retry-vs-stop without regexing an error string: `provider_quota` with a
> reset time is a *wait*, `model_refusal` is a *stop*, and today both look
> identical. `refreshModels` is a real gap — our picker discloses the built-in
> fallback but offers no way to re-ask. And `QuotaWindow[]` as a **list** beats
> `Meter.plan`'s primary-plus-optional-secondary, because Anthropic already
> publishes 5h, 7d and a per-model 7d window.
>
> **What ours has and theirs does not:** mid-run streaming, interrupt, steer,
> interactive approvals, and history read from the runtime's *own* store. Theirs
> is a batch `execute()` that persists its own captured stdout.

---

## 12. Governance is narrower than the framing suggests

`APPROVAL_TYPES = ["hire_agent", "approve_ceo_strategy", "budget_override_required", "request_board_approval"]`
— four types on a generic `approvals` table. Pure company metaphor; none applies
to a laptop.

The notable mechanism is elsewhere: user-facing `decisions` rows carry a
**`signedSpec`** — an HMAC-SHA256 over a canonically serialised (recursively
key-sorted) JSON of the decision spec, verified with `timingSafeEqual` — plus
`targetSnapshots` and a **NOT NULL `expiresAt`**. Config changes are versioned for
rollback in `agent_config_revisions`; `activity_log` is append-only.

> An HMAC is overkill in-process, but the **principle** applies exactly to plan
> approval: hash what the user accepted and refuse to fan out if the hash no
> longer matches — the same guarantee `acceptedPlanRevisionId` provides.
> `expiresAt NOT NULL` on a pending decision is also worth copying: **a permission
> prompt with no expiry is a card that waits forever.**

---

## 13. Self-created work is deduplicated by uniqueness, not by checking

`issues` carries `originKind`, `originId`, `originFingerprint` (default
`'default'`), and then **six partial unique indexes**, each of the form *"at most
one non-terminal, non-hidden issue per (company, originKind, originId)"* — for
`task_watchdog`, `harness_liveness_escalation`, `stale_active_run_evaluation`,
`issue_productivity_review`, `stranded_issue_recovery`, and open
`routine_execution`.

One carries the reasoning explicitly:

> *"concurrent creates race on the pre-insert count check and this index is what
> atomically rejects the loser."*

> For us: every card orchestration creates on its own behalf — a re-plan card, a
> validator card, a fix-the-failure card — needs an origin identity and a
> uniqueness rule, or a retry produces duplicates that look like the plan
> expanding. Without a database that is a check in one host-side function keyed on
> `{originKind, originId}`, in the same place `split()`'s limits already live.
> **And a read-then-create check is not enough where two triggers can fire at
> once** — ours genuinely can: a run ending, a reconcile tick, and a user click.

---

## 14. The UI ships no graph library

The only relevant dependency in `ui/package.json` (57 deps) is `mermaid`. The org
chart is a hand-rolled recursive `subtreeWidth` / `layoutTree` layout **in plain
divs**; the goal tree is an indented expandable list with a status badge. Live-run
polling is 3s and is slowed or stopped for hidden tabs.

The one distinctive view is `WorkTimelineChart`, a custom-SVG Gantt described in
its own header as:

> *"actor rows with concurrency sub-lanes, run bars (no issue IDs on the bar —
> identity is the thin left colour tab; truncated title shows on hover), human
> kickoff chips at the first matching run's leading edge, straight hover-revealed
> agent→agent delegation connectors (dashed for retries), an in-progress fade to
> 'now', a hover tooltip, and a full-window mini-map with a draggable brush."*

> **A company-scale product with org charts, goal trees and dependency graphs
> still did not ship a node-graph canvas.** That is the strongest available
> evidence against building one here. Hover-revealed edges also solve the density
> problem that kills DAG views past about eight nodes.
>
> The Gantt is tempting and carries more information per pixel than a node graph —
> but see [ORCHESTRATION.md §7](ORCHESTRATION.md): SVG is disqualified here for a
> different reason, that `layout.test.mjs`'s `scrollWidth - clientWidth` idiom
> returns **0** for SVG text escaping its box by 178px, so the one gate in this
> repo that can fail on a stylesheet would report PASS over an unreadable view.

---

## 15. What to take, and what to refuse

**Take:** tree and DAG as separate relations; the two-column ownership split;
the durable decomposition claim written *before* fan-out; the five-condition split
test; `not_creator` as a per-card review policy; the completion contract hash and
`priorStatusVersion`; the stop fingerprint with observed-vs-reviewed; the liveness
contract and structured `blocked`; the agent-round counter with human reset;
durable-state retry fingerprints; zombie-aware coalescing; origin-triple
uniqueness; `usageBasis` and `errorFamily` on the runtime contract; named
cancellations in a fixed gate order; `expiresAt` on a pending decision; and the
evidence that no graph library is needed.

**Refuse:** monthly and lifetime budgets; per-agent budgets; post-hoc cost
enforcement; org charts and reporting lines; cron heartbeats; the four company
approval types; HMAC-signed specs; immutable audit logs; config versioning with
rollback; and the `paperclipApiRequest` escape hatch — a generic API tool is a
hole in exactly the boundary CLAUDE.md rule 7 exists to keep.

---

## Sources

- [github.com/paperclipai/paperclip](https://github.com/paperclipai/paperclip) — `master`, MIT
- `doc/execution-semantics.md` — ownership, blocked, reporting, liveness, recovery
- `doc/TASK-WATCHDOG.md` — the validator, and its anti-loop design
- `packages/db/src/schema/` — 126 tables; `issues.ts`, `issue_relations.ts`,
  `issue_plan_decompositions.ts`, `issue_watchdogs.ts`, `completion_contracts.ts`,
  `work_assessments.ts`, `status_decisions.ts`, `cost_events.ts`
- `packages/adapter-utils/src/types.ts` — the adapter contract
- `docs/adapters/creating-an-adapter.md`
