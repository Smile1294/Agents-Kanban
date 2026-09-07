---
name: glossary
description: The vocabulary of the codebase — card, phase, runtime vs provider, catalogue, sidecar, fanout, roll-up, the agent states, pending merge, fast path
last_verified: 2026-09-07
---
# Glossary

- **Card / session** — the same thing at two zoom levels. Keyed by
  `sessionId ?? runId`; the key changes once when Claude Code assigns the id.
- **Phase / column** — one field on the sidecar. `complete` is `humanOnly`:
  an agent cannot set it, the code refuses.
- **Review column** — `validating`. Entering it requires a `howToTest` and an
  updated knowledge file for every area changed; the board commits the worktree
  on the way in.
- **Runtime** — the agent program (`claude`, `codex`): its own process,
  protocol, login and transcript store. A session keeps its runtime for life.
- **Provider / profile** — the backend behind Claude Code, chosen per launch as
  environment variables on the child; `inherit` writes nothing. A started
  session may change backend for its NEXT launch, never its runtime.
- **Agent key** — `<runtime>|<profile>`. One picker for both halves; also what a
  `split_task` piece names as `agent`.
- **Catalogue** — the model list in force and its source: `endpoint` (a
  gateway's `/v1/models`) → `cli` (`supportedModels()`) → `profile` (declared)
  → `builtin` (`MODELS` in `meta.ts`). `catalogueFor` is the single entry point.
- **ModelBook** — prices and windows handed to both meters, so a gateway session
  is priced by what the gateway published.
- **Meter** — `usd` / `plan` / `unknown`. A subscription shows a rate-limit
  percentage; `unknown` renders as `—`, never `$0.00`.
- **Sidecar / MetaStore** — per-session metadata in the extension's global
  storage: phase, tags, archive, worktree, test plan, model/effort/thinking,
  runtime, provider, orchestration level, `running`, `parent`, `fanout`.
- **Foreign session** — one found in a runtime's store that the board never
  touched. Hidden past `hideSessionsOlderThanDays`, with the count shown.
- **Brief** — the system prompt appended to every run by `buildBrief()`: the
  board rules, the aim sentence, the spawn catalogue, the knowledge-file rule.
- **Aim sentence** — the one line of the brief the orchestration dial changes.
- **Split / subtask / fanout / roll-up** — one card becoming 2–4 cards forked
  from the same base; the count asked for (`SessionMeta.fanout`); the parent
  moving to review when the last child lands.
- **Route** — a piece's agent, model and effort, validated against that agent's
  catalogue with four refusals (`spawn-agent`, `spawn-model`, `spawn-catalogue`,
  `spawn-effort`).
- **Background agent / subagent** — what a session spawns with the `Agent`
  tool. Lives inside the parent's transcript store; its only authoritative
  outcome is the `<task-notification>` in the parent transcript. Not a card.
- **AgentState** — `idle | queued | starting | working | waiting | needsInput |
  done | error`. Volatile, never persisted. `waiting` counts as busy.
- **Interrupted** — the host died with the run: the `running` mark is still set
  at startup. **Stalled** — a started column with no live agent; the move is
  offered, never made. **Failed** — the run ended in an error.
- **Pending merge** — `MERGE_HEAD` exists in the main worktree; every Merge
  button is disabled until it is committed or aborted.
- **Fast path / chromeSig** — a frame that changes nothing in the signature is
  patched (`syncFrame`), not rebuilt (`render`).
- **Knowledge check** — the review-move gate over `docs/codemap/*.md`
  frontmatter: changed source → its area file must be in the diff too.
- **Test plan / howToTest** — what a card must carry to enter a review column:
  a summary, steps, links that become buttons.
- **Worktree / base** — `.agentskanban/worktrees/<id>-<slug>` on branch
  `task/<id>-<slug>`, forked from the base branch (`main`). `.agentskanban/`
  is ignored twice: `.gitignore` and `.git/info/exclude`.
