---
name: agent-runs
description: What is running — AgentManager (N runs, one worktree each, the queue, split, the brief), AgentSession (one Claude Code query, permissions, live spend, background tasks), the board tools and their two transports, images and dictation as inputs to a run
paths:
  - src/agent/manager.ts
  - src/agent/session.ts
  - src/agent/tools.ts
  - src/agent/board-bridge.ts
  - src/agent/images.ts
  - src/agent/dictation.ts
  - src/board-mcp.ts
tests:
  - src/agent/__tests__/manager.test.ts
  - src/agent/__tests__/route-launch.test.ts
  - src/agent/__tests__/spend.test.ts
  - src/agent/__tests__/background-turns.test.ts
  - src/agent/__tests__/tools.test.ts
  - src/agent/__tests__/board-bridge.test.ts
  - src/agent/__tests__/images.test.ts
  - src/agent/__tests__/dictation.test.ts
last_verified: 2026-09-07
---
# Agent runs — what is running

## Owns

The live half of the board: starting, queueing, streaming, interrupting and
stopping agent runs; the tools an agent uses on its own card and the two
transports that carry them; the system prompt every run receives; what goes
into a message (images, dictated text). The per-runtime protocol lives in
[runtimes.md](runtimes.md); the split policy in [orchestration.md](orchestration.md).

## Files

**`src/agent/manager.ts`** (~2060 lines). `AgentManager`: `start(prompt, opts)`
mints `run-<n>-<id>` and FREEZES everything the run is decided on —
`launchSettings(opts, defaults)` (model, effort, thinking, ultracode, fastMode;
`??` is correct only because the absent value is `undefined`), runtime, provider
(`providerFor` for a resumed session), orchestration level — then queues past
`maxConcurrentAgents` (the queued run gets a card) or `launch()`es. `launch()`
never throws: failures become a `warning` and a card. `launchInner()` creates or
reuses the worktree, reads the prior transcript and `priorUsd` as the
live/history boundary, registers the `RunningAgent`, wires the session's events
(`sessionId` → `adoptKey`, refusing a clash with another running agent; `state`
→ `drain()` on terminal states; `text`/`tool`/`meter`/`committed`/`permission`
…) each ending in `touch()` → `change`. `startRun()` has NO branch on runtime
identity: `getRuntime()`, `boardToolsFor()` (in-process server or socket
bridge), the provider env, `buildBrief()`, `rt.start(spec)`. Also: `split()`
(every split limit; see orchestration.md), `send` (queues behind a running
turn), `interrupt`, `stop` (clears the `running` mark), `stopAll` (deliberately
does NOT — that is the event being recorded), `answerPermission`, `list`,
`byKey` (run id or session id), `followKey`, `durablePatch` (what the sidecar
records at launch), `boardContext()` (every host callback the tools get — the
wiring is asserted in `manager.test.ts`), `buildBrief()`, `titleFrom()` (a card
title from a prompt, no model call), `MAX_SUBTASKS = 4`. Tests: `manager.test.ts`,
`route-launch.test.ts` (the real `start → launch → startRun` chain against a
real git repo with a fake runtime).

**`src/agent/session.ts`** (~1140 lines). `AgentSession` implements `AgentRun`
for Claude Code: `run(prompt, images)` builds `Options` (`includePartialMessages`,
`forwardSubagentText`, `enableFileCheckpointing`, `resume`, `permissionMode`,
`mcpServers: {board}`, `canUseTool: decide`, `settings` for the flags) and
iterates `query()`; `handle(msg)` is the whole stream parser (`system/init` →
`sessionId`; `stream_event` → `partial`; `assistant` → text / thinking / tool
rows, usage per response, routed on `parent_tool_use_id` into the Task's
children; `user` → tool results; `compact_boundary` → meter reset; `result` →
`settleTurn` and `done` or `waiting`; `task_started` / `task_updated` /
`background_tasks_changed` / `task_notification` → live tasks); `send`,
`interrupt`, `stop`, `answerPermission`, `setPermissionMode`; `decide()` — the
permission gate (auto-allow set + board tools; everything else surfaces as a
`permission` event with the parsed question if it is `AskUserQuestion`);
`settleTurn(billed)` compares our spend against `total_cost_usd` and logs a
>20 % drift; `agentEnv()` — the ONE seam where a provider's `set`/`clear` is
applied and `HOST_SESSION_VARS` are stripped; `ultracodeWarning()` — one-sided,
looks for the `Workflow` tool on init; `MessageQueue` — the prompt as an
`AsyncIterable`, never a string. Tests: `spend.test.ts`,
`background-turns.test.ts` (recorded frames into `handle()`).

**`src/agent/tools.ts`**. `buildBoardTools(board, ctx, tool)` — the ten board
tools, ONE set of definitions: `set_phase` (the approval boundary, the
`howToTest` requirement, the knowledge-file check, the commit on entering
review, the rename nudge on entering the started column), `set_title`,
`set_tags`, `list_board`, `split_task` (schema names `agent`, `model`, `effort`,
`scope` per piece and the `reason`), `notify_user`, `schedule_list` /
`schedule_create` / `schedule_delete` / `schedule_run`. `ASKS_FIRST` — the four
that always prompt (`split_task` and the three schedule writes); `boardToolNames`
— the auto-allow list DERIVED from the definitions (a hand copy drifted once and
left agents unable to move their cards); `boardToolName`; `createBoardServer`;
`conventionalMessage(title)`; `BoardToolContext` — everything a tool may do,
bound to ONE session (`key()`, `onChanged`, `onNotice`, `onSplit`,
`spawnAgents`, `commitWorktree`, `knowledgeCheck`, `onRename`, `derivedTitle`,
`sessionTitle`, `onSchedule*`). Tests: `tools.test.ts`, `board-bridge.test.ts`.

**`src/agent/board-bridge.ts`**. `startBoardBridge(board, ctx, {dir, script})`
serves the same definitions over a unix socket / named pipe for a runtime that
spawns MCP servers; per SESSION (the tools take no id, so a Codex agent cannot
move somebody else's card); a token as well, because a socket path is
guessable. Returns the `BridgeDescriptor` (command, args, env) and the derived
`autoAllow`. Test: `board-bridge.test.ts` — the real bridge, the real built
`dist/board-mcp.js`, a real socket; asserts `set_phase('complete')` is refused
ACROSS the socket.

**`src/board-mcp.ts`**. Its own bundle (`dist/board-mcp.js`, no externals on
purpose), spawned BY Codex. stdio ↔ Codex is MCP over newline JSON-RPC
(`initialize`, `tools/list`, `tools/call`, `ping`); socket ↔ host is a private
`hello`/`call` protocol. Holds NO board logic. Never writes to stdout except
JSON-RPC; never answers a notification; a failed call is a tool result with
`isError`, never a JSON-RPC error (a call that never returns blocks the agent's
turn forever).

**`src/agent/images.ts`**. Attachments as Anthropic image content blocks inside
the user message — nothing staged on disk. `sanitiseImages`, `userContent(text,
images)`, `approxTokens` (~`w×h/750`), `describeImages`, `MAX_EDGE = 1568`,
`MAX_BYTES`, `MAX_IMAGES = 8`. The transcript keeps the COUNT, never the bytes.
Test: `images.test.ts`.

**`src/agent/dictation.ts`**. Local dictation in the extension host: `startCapture`
(ffmpeg, 16 kHz mono WAV, platform device from `recordDevice`), `transcribeWav`
(`whisper-cli`), `checkVoice` → three SEPARATE checks (binary, model, ffmpeg —
three different fixes), `verdict`, `builtinDictationAvailable`. Nothing leaves
the machine. Test: `dictation.test.ts` (the pure half).

## How it works

See [flows.md](flows.md) *A run*. The parts worth holding in your head: a run is
keyed by `run-…` until `system/init`, and everything holding a key across that
moment must follow it (`followKey`); `waiting` counts as busy everywhere
`working` does, and a `result` with background tasks outstanding never ends the
run (the CLI runs the follow-up turn that carries the findings back — kill it
and the findings die); the brief is `appendSystemPrompt` and says the move into
review is "how a run ENDS", because a project's own slash command once ended
with "Then STOP" and finished work sat in Implementing.

**The brief** (`buildBrief`): the card name and branch, the two moves, the
`howToTest` requirement, `set_tags`, `set_title`, the aim sentence for the
orchestration level, the split rules and the spawn catalogue (parent sessions
only), and — when the repository carries a `docs/codemap/` — the knowledge-file
rule and the fact that the review move is refused without it.

**The move into review**, in order inside `set_phase`: valid column → not
human-only → `howToTest` present → `knowledgeCheck` (host-side, over the
worktree's diff) → test plan stored → phase written → note with the move →
`commitWorktree` (the agent's message or `conventionalMessage(title)`) →
the reply says what was committed, and nudges `set_title` on the way into the
started column while the title is still the guess.

## Change recipes

- **A new board tool.** Define it in `buildBoardTools`; add its host callback to
  `BoardToolContext` and wire it in `boardContext()`; decide whether it belongs
  in `ASKS_FIRST`; `tools.test.ts` asserts the auto-allow list derives from the
  definitions and `manager.test.ts` asserts the wiring; the bridge carries it to
  Codex unchanged. Policy in the description, the fence in code — both.
- **A new frame kind from the SDK.** Read it in `handle()`; feed a recorded
  frame into `handle()` in `spend.test.ts` / `background-turns.test.ts`. Never
  drop subagent frames (`parent_tool_use_id`) and never merge them into the
  main thread.
- **Something new decided at launch.** Resolve it in `start()` into the queue
  entry, read it in `launch()` from `opts`, record it with `durablePatch`; never
  recompute it from `this.opts.defaults` (the fourth piece of a fan-out always
  drains late).
- **A new line in the brief.** Add it to `buildBrief`; `manager.test.ts` asserts
  the load-bearing sentences as whole lines — a line break inside one made a
  guard silently miss.
- **A new session flag.** Gate it HOST-side after the assignment from the
  model's capability (`supportedModels()`); the CLI validates nothing.

## Invariants

- `prompt` is an `AsyncIterable`, never a string; `cwd` is the worktree.
- `startRun()` has no branch on runtime identity — the test of the abstraction.
- Everything a run is decided ON is frozen when it is asked for.
- `stop()` clears the `running` mark; `stopAll()` does not; `0` clears, never
  `undefined`.
- Two live runs must never become one card: a duplicate session id is refused.
- A turn ending is not the run ending while background agents are live; a
  repeated `init` with the same id is not re-announced.
- The auto-allow list is derived; `isHumanOnly()` runs in the host, whichever
  transport; `board-mcp.js` holds no logic.
- An attachment goes to the model, never to a file.
- A question is not a permission request: the answer goes in `updatedInput`.

## Open work

- Permission prompts do not survive a window reload.
- A resume that returns a DIFFERENT id is reported but not repaired — the turn
  is already running on the new session by the time the id arrives.
- Images do not reach a Codex session (it takes `local_image` by path).
- Nothing re-runs a parent once its subtasks land.

## Recent changes

- 2026-09-10 · claude/frontend-sync-chat-freeze-wb6a2s · `AUTO_ALLOW_BUILTIN` lost
  `WebFetch`, `WebSearch` and `Read`. The comment above it said "Read-only, and
  the agent is confined to its own worktree anyway" and both halves were false:
  `Read` takes an absolute path and nothing confined it, and read-only stops
  being a containment property the moment an egress tool sits in the same
  allow-list. Together they were an exfiltration channel with no prompt anywhere
  on it — an injection in anything an agent reads could `Read`
  `~/.aws/credentials` and `WebFetch` it out, no dialog, no `needsInput`, one
  truncated transcript row. The two that reach the network now take the ordinary
  prompt (Claude Code's own default); `Read` is auto-allowed per CALL for a
  target inside the worktree, symlinks followed
  (`AgentSession.allowedInWorktree` → `realContains`). `dontAsk` and
  `bypassPermissions` are not consulted here and still mean what they say.
  Gates in `tools.test.ts` and `worktree.test.ts`, both shown to fail.

- 2026-09-10 · claude/frontend-sync-chat-freeze-wb6a2s · a resume that comes back
  as a DIFFERENT session id is reported. The runtime started a fresh
  conversation instead of continuing the one asked for, so the follow-up went
  somewhere the transcript on screen will never show and the card re-keyed onto
  a session with no history — silently, reading as a lost transcript. Reported
  and not repaired: the turn is already running by the time we hear, so the
  warning names BOTH ids and the original stays findable. Gate in
  `manager.test.ts` drives the real handler rather than mirroring its condition.

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit; `knowledgeCheck` added to `BoardToolContext`, wired in `boardContext()`, and the brief gained the knowledge-file paragraph when a codemap exists.
- 2026-09-07 · task/S116g8 · dead-code sweep: dictation tuning constants `WHISPER_BIN`, `FFMPEG_BIN`, `DICTATION_MIN_VERSION` de-exported — module-private, referenced only inside dictation.ts.
