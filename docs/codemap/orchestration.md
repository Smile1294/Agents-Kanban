---
name: orchestration
description: One card becoming several — the orchestration dial and the gates on a split, a piece's route to another agent/backend/model and its four refusals, the spawn allowlist, the derived parent-child thread and the roll-up
paths:
  - src/agent/routing.ts
  - src/agent/spawn-policy.ts
  - src/board/decomposition.ts
  - src/board/subtasks.ts
tests:
  - src/board/__tests__/decomposition.test.ts
  - src/agent/__tests__/routing.test.ts
  - src/agent/__tests__/route-launch.test.ts
  - src/agent/__tests__/spawn-policy.test.ts
  - src/board/__tests__/subtasks.test.ts
last_verified: 2026-09-07
---
# Orchestration — splitting work

## Owns

The policy around `split_task`: how eagerly a session should split (the dial),
whether a proposed split is acceptable (the gates), where each piece may run
(routing and the spawn allowlist), and how the parent and its children are shown
and rolled up. The mechanism itself — `AgentManager.split()` — is owned by
[agent-runs.md](agent-runs.md); the research and what is still unbuilt is
[ORCHESTRATION.md](../ORCHESTRATION.md).

## Files

**`src/board/decomposition.ts`**. `OrchestrationLevel` = `minimal | balanced |
maximum`, `ORCHESTRATION_LEVELS`, `ORCHESTRATION_CHOICES` (label + detail for
the picker), `DEFAULT_ORCHESTRATION = 'balanced'`, `parseOrchestrationLevel`;
`policyFor(level)` → `OrchestrationPolicy` (`aim` prose, `maxPieces`);
`aimSentence(policy)` — the ONE line of the brief the level changes;
`checkProposal(pieces, reason, policy, …)` → `ProposalVerdict` with
`ProposalRule`s (`ALL_PROPOSAL_RULES`: piece count, brief length `MAX_BRIEF =
6000`, a stated reason `MAX_STATED`, scope present, overlap as a NOTE not a
refusal …) — and it must return IDENTICAL verdicts for two policies differing
only in `level`; `decompositionLine(record, started)` — what the card says
about a split that happened or was refused (`DecompositionRecord` is persisted
in `SessionMeta.decomposition`). The `RouteRule` import is type-only, or the
cycle `meta → decomposition → routing → meta` blanks the board. Test:
`decomposition.test.ts` — the identical-verdicts case is the one that matters.

**`src/agent/routing.ts`**. Pure: `resolveRoute(ask, catalogue, parent)` →
`RouteVerdict`; `RouteRule` = `spawn-agent | spawn-model | spawn-catalogue |
spawn-effort` (`ALL_ROUTE_RULES`) — four refusals because each has a different
fix: name an agent on offer; name a model that agent serves; nobody has READ
that backend's catalogue yet (the built-in Anthropic list is standing in, so
refusing on it as fact would be the probe bug again); name an effort the model
supports. `agentKeyOf(runtime, provider)` → `<runtime>|<profile>` — the
composer's key and the agent's vocabulary are the SAME string (`smoke.mjs`
asserts the picker, the spawn catalogue and a live run agree); `parseAgentKey`,
`spawnKeyFor`, `slugFor`, `findSpawnAgent`, `describeSpawnAgents` (the prose in
the brief); `SpawnCatalogue` / `SpawnAgent` / `SpawnModel` / `PieceRoute`. Tests:
`routing.test.ts`, `route-launch.test.ts` (the resolved route reaches the
runtime's `RunSpec`).

**`src/agent/spawn-policy.ts`**. Which models an agent-SPAWNED session may run
on, per provider profile — the settings page's "allowed for spawned agents"
tick. Stores the DISALLOWED half: `SpawnPolicy = Record<profileId, string[]>`,
absence means allowed, an emptied profile's key is deleted. `parseSpawnPolicy`,
`toggledSpawn`, `allowedSpawnModels`. The gate lives in `manager.ts`. Test:
`spawn-policy.test.ts` (a round trip: what `toggledSpawn` writes,
`parseSpawnPolicy` reads back).

**`src/board/subtasks.ts`**. The relation is stored ONCE, on the child
(`SessionMeta.parent`); the parent's half is DERIVED on every render:
`linkSubtasks(cards, board)`, `subtaskProgress(card)` (`1/2 ready`),
`rollUpState(phases, fanout, board)` → `RollUp` (`pending` when fewer children
exist than `fanout` approved — the case that made "All 2 subtasks are ready" a
lie over a four-way split). Test: `subtasks.test.ts`.

## How it works

The level is chosen per card on the composer bar (the setting is only the
default for NEW sessions), captured at launch on `RunningAgent.orchestration`,
and baked into the brief as the aim sentence. When the agent calls `split_task`,
`AgentManager.split()` runs the fences (clean worktree, no commits, not itself a
subtask, not already split, ≤ `MAX_SUBTASKS`), then `checkProposal`, then
`resolveRoute` per piece against the TARGET agent's catalogue
(`catalogueForProfile(p, rt)`, per runtime and per profile), then
`confirmSplit` — a real click, host-side, because `ASKS_FIRST` is skipped under
`dontAsk`/`bypassPermissions` and Codex never reads `autoAllow`. Each piece is
an ordinary `start()` from the parent's BASE with the route frozen into it; a
piece naming nothing inherits the parent's WHOLE agent (runtime AND backend).
`fanout` is written on the parent; a refusal is recorded on the parent and
drawn (`decompositionLine`). Children are real cards in their own columns;
`linkSubtasks` threads them; when the last reaches a settled column,
`rollUpToParent` moves the parent to review and notifies the user. Nothing
re-runs the parent — deliberately.

## Change recipes

- **A new gate on a split.** A `ProposalRule` in `decomposition.ts` and a branch
  in `checkProposal`; it MUST NOT read `level` (the identical-verdicts test
  fails if it does); record the refusal so the card can say what happened.
- **A new routing refusal.** A `RouteRule` with its own fix in the message;
  `routing.test.ts`; the description of `split_task` in `tools.ts` names the
  fields it checks.
- **Changing what a piece may name.** `split_task`'s schema in `tools.ts`,
  `PieceRoute`, `resolveRoute`, and `route-launch.test.ts` proving the value
  reaches the `RunSpec`.
- **Changing the dial's wording.** `policyFor` / `aimSentence` only; the
  operational half of the brief (split before editing, `scope`, standalone
  briefs) is invariant.

## Invariants

- No gate anywhere else reads `level`; the level may only ask for more and
  allow less.
- Routing is CHECKING, not DECIDING: the agent names, the host refuses.
- The route is ONE field naming a combination, validated against the target
  agent's catalogue, never the active one.
- Subtasks fork from the parent's BASE, which is sound only because the split
  is refused once the parent's worktree is dirty or has commits.
- At most four, one level deep, once per session — all in `split()`, none in
  the description.
- `fanout` is the denominator; a queued child gets a card.
- The parent half of the thread is derived, never stored.

## Open work

- Nothing owns the objective after a fan-out: no parent re-run, no sequencing of
  four merges, no conflict-fixing agent.
- Stage 2's measurement half (scope drift at merge, `MeterTotal`, a budget) is
  gated on experiments in ORCHESTRATION.md §13 that have not been run.

## Recent changes

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
