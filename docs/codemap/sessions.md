---
name: sessions
description: What is on disk — Claude Code's transcripts read back, the sidecar of board metadata, context-fill and spend arithmetic, background agents, transcript search, rewind, slash-command discovery
paths:
  - src/sessions/store.ts
  - src/sessions/meta.ts
  - src/sessions/usage.ts
  - src/sessions/subagents.ts
  - src/sessions/search.ts
  - src/sessions/checkpoints.ts
  - src/sessions/commands.ts
tests:
  - src/sessions/__tests__/store.test.ts
  - src/sessions/__tests__/meta.test.ts
  - src/sessions/__tests__/usage.test.ts
  - src/sessions/__tests__/subagents.test.ts
  - src/sessions/__tests__/search.test.ts
  - src/sessions/__tests__/checkpoints.test.ts
  - src/sessions/__tests__/commands.test.ts
last_verified: 2026-09-07
---
# Sessions — what is on disk

## Owns

Everything the board shows that must not depend on a process being alive. The
transcript store is Claude Code's own (`~/.claude/projects/<encoded-cwd>/*.jsonl`,
read through the Agent SDK's session API and, for two questions the API cannot
answer, the raw JSONL); the board's own metadata is a sidecar in extension
storage; the numbers on the meters are arithmetic over the token counts in the
transcript. Codex's store is read by `codex-store.ts`, owned by
[runtimes.md](runtimes.md).

## Files

**`src/sessions/store.ts`**. `SessionStore` — every runtime's sessions merged
with our metadata: `list({includeArchived})` (cached index scan; the render
path), `get`, `card` (a `BoardSession` with phase, tags, test plan, parent,
fanout), `transcript` / `fullTranscript` (windowed to `TRANSCRIPT_LIMIT` = 400
from the tail, upward pagination by the host), `usage`, `meter`, `adoptKey(from,
to)` (carries metadata from a `run-…` key to the real session id), `patch`,
`setPhase`, `setTestPlan` / `clearTestPlan`, `archive`, `delete` (verified
against the OWNING runtime's listing), `rename`, `childrenOf`, `setModelBook`,
`runtimeOf` (falls back to the foreign scan). The `Entry` union is every
transcript row kind: `prompt | text | thinking | tool | phase | result | notice
| error`, with `tool.children` for a Task's subagent transcript, `runningSince`
and `durationMs` on live tool rows only. `summariseTool(name, input)` is the
one-line row text (also used by the Codex store); `shortenPath`;
`retryWhileMissing` (the session file does not exist yet when its id is
announced); `interruptedSessions`. Test: `store.test.ts` — seeds Claude Code's
real format into a throwaway `CLAUDE_CONFIG_DIR`, including the project
directory encoding (realpath of the cwd with every non-alphanumeric → `-`).

**`src/sessions/meta.ts`**. `MetaStore` — the sidecar in `globalStorageUri`,
keyed by workspace root: `get`, `getAll`, `update`, `rename`, `remove`;
`recover()` and `mergePreviousInstalls()` fold in what sibling storage
directories (an earlier publisher/name) remember — ADDITIVE, ours wins, only
unknown ids, once per source (`.recovered.json`). `SessionMeta`: `phase`,
`tags`, `archived`, `pinned`, `worktree`, `branch`, `base`, `testPlan`,
`title`, `model`, `effort`, `thinking`, `runtime` (PARSED, never cast),
`provider`, `switchedFrom`, `orchestration`, `decomposition`, `scope`,
`running` (the mark a killed run leaves), `contextWindow`, `parent`, `fanout`.
`parseMeta` / `normalise` / `emptyMeta`; `MODELS` + `windowLabel` (the built-in
picker list — the FALLBACK, and `context` is derived from `MODEL_WINDOWS`);
`TestPlan` / `normaliseTestPlan` / `guessLinkKind` / `targetIsClean`;
`resolveEffort`, `resolveThinking`, `resolveOrchestration` (per-session →
workspace default → unset); `normaliseTitle`, `MAX_TITLE`. Test: `meta.test.ts`
(its temp dir is one level deeper than tmpdir on purpose: the store looks for
previous installs among its siblings).

**`src/sessions/usage.ts`**. `summariseUsage(messages, book?)` → `UsageTotals`
(deduplicated by `message.id` — a streaming response is written as one record
per content block and each repeats the whole response's usage; the obvious sum
was ~2.7× high), `costOfUsage`, `contextOfUsage` (per-response `input +
cache_read + cache_creation`, never the cumulative `result.usage`),
`mainWindowOf`, `MODEL_RATES` and `MODEL_WINDOWS` (Anthropic's ids; the
hand-maintained tables), `CACHE_WRITE_5M/1H/READ`, `normaliseModel` (strips
Bedrock/Vertex prefixes and suffixes; an inference-profile ARN stays unpriced),
`rateFor`, `windowFor`, `ModelBook` (endpoint-published prices and windows),
`priced: false` for an unknown model → the view says `≥`. Test: `usage.test.ts`
— case one is the deduplication.

**`src/sessions/subagents.ts`**. Background agents (the `Agent` tool) read off
disk: `scanBackgroundAgents(home)` — ONE directory walk keyed by session (a badge
is drawn per card); `readBackgroundAgents`; `readTaskNotifications(file)` /
`parseTaskNotifications` — the `<task-notification>` blocks in the PARENT
transcript, read off the session FILE (a mid-turn notification is an
`attachment` record the SDK's reader does not return), accepting both `stopped`
and `killed`; `agentStatus` — `completed | stopped | orphaned`, and `orphaned`
renders as "no completion recorded", never "stopped". Test: `subagents.test.ts`.

**`src/sessions/search.ts`**. `searchEntries(entries, query)` → `TranscriptHit[]`
over every rendered row kind, nested subagent rows marked `nested`; a tool row's
raw input and a tool result's content are NOT matched (they never reach the
screen). `snippetOf`, `SNIPPET_MAX`. `entryIndex` is into the FULL top-level
transcript; the host translates it to the rendered window. Test: `search.test.ts`.

**`src/sessions/checkpoints.ts`**. "Try again from here": Claude Code's
`file-history-snapshot` entries are INVISIBLE to `getSessionMessages()`, so the
raw JSONL is read for this one question. `checkpointMapFor` → which backup in
`~/.claude/file-history/<sessionId>/` corresponds to each tracked path at a
message; `planRestore` / `applyRestore` copy them over the worktree;
`claudeHome`, `sessionFileFor`, `historyDirFor`, `waitForQuiescent`. A fork
rewrites history without snapshot entries, so a forked card rewinds only its own
turns. Test: `checkpoints.test.ts`.

**`src/sessions/commands.ts`**. `listSlashCommands(workspaceRoot)` — the
project's `.claude/commands/*.md` and the user's `~/.claude/commands`; project
shadows user; nested directories namespace as `parent:child`; `describeCommand`
reads frontmatter or the first heading. Execution stays with the SDK (the
composer sends the raw `/name args`); this only makes the surface discoverable.
Test: `commands.test.ts`.

## How it works

`SessionStore.list()` merges each registered runtime's `history.list()` with the
`MetaStore` and caches the index scan for about a second while the metadata
merged into it stays fresh. A transcript is parsed on demand and cached by
file size and mtime. Usage and spend are derived from the same transcript, so
the figure a card shows when its process ends is the figure the live run
showed a moment before — the live path (`AgentSession`) uses the same
arithmetic. A session's key changes once: `adoptKey` moves the sidecar entry
from `run-…` to the session id when `system/init` arrives, and
`retryWhileMissing` waits for the session file that does not exist yet.

## Change recipes

- **A new per-session field.** `SessionMeta` + `parseMeta` + `normalise` in
  `meta.ts`; write it (usually `durablePatch` in the manager); READ IT BACK in
  `meta.test.ts` — `contextWindow` was written for its whole life and never
  parsed. Remember `stripUndefined()` drops `undefined`: clear with `0`/`null`.
- **A new transcript row kind.** `Entry` here; produce it in `readTranscript`
  and in `AgentSession.handle()`; draw it in `renderEntry`; decide whether
  `search.ts` matches it.
- **A new model price or window.** `MODEL_RATES` / `MODEL_WINDOWS` (Anthropic
  ids only — other providers publish their own through `ModelBook`); the live
  drift check against `total_cost_usd` will say when the table is stale.
- **Reading something new off Claude Code's disk.** Prefer the SDK's session API;
  fall back to the raw JSONL only for records the API projects away, as
  `checkpoints.ts` and `subagents.ts` do, and say so in the header.

## Invariants

- Nothing TRACKED goes into the user's repository; the sidecar lives in
  extension storage and survives a publisher rename through the additive merge.
- Anything persisted is read back by a test.
- A number the board shows must not depend on a process being alive.
- Costs deduplicate by `message.id`; the window is applied to the TAIL (the
  SDK's `limit` takes the first n).
- The age bound is applied by the host, never in `list()`.
- A foreign session's delete is verified against ITS runtime's listing.
- Anthropic's `input_tokens` and `cache_read_input_tokens` are disjoint and
  summed; Codex's cached tokens are a subset (see runtimes.md).

## Open work

- Rehydrated entries are stamped with the time they were PARSED;
  `SessionMessage.timestamp` exists in the SDK and nothing uses it.
- A session never run here falls back to the model's maximum window.
- `MODEL_RATES` cannot know about discounts or subscriptions; the drift check
  only runs while a turn is watched.
- Commit rows in the transcript: `committed` is emitted and heard, no entry kind.

## Recent changes

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
