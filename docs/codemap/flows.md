---
name: flows
description: The cross-area flows — a run, a repaint, a split, a merge, a scheduled run, a Codex run, remote — naming the functions along each path
last_verified: 2026-09-07
---
# Flows

Each flow crosses several areas. The area files describe the parts; this file
describes the path. When you change a step, update the owning area file — this
file has no `paths:` and is never required by the gate, so keep it honest by
hand when a flow changes shape.

## A run

The webview posts `newSession` or `send` → `wire()` in `src/board/panel.ts` →
`host.newSession()` / `host.sendMessage()` in `src/extension.ts` →
`AgentManager.start()` mints `run-<n>-<id>` and **freezes** what the run is on —
`launchSettings()` (model, effort, thinking, ultracode, fast mode), runtime,
provider profile and orchestration level — before the concurrency check. Over
`maxConcurrentAgents` it goes onto the queue, and the queued run still gets a
card. Otherwise `launch()` → `launchInner()`: `WorktreeService.create()` (idempotent
per branch; `ensureIgnored` + `ensureExcluded` first), the prior transcript and
spend are read off `SessionStore` as the live/history boundary, the
`RunningAgent` is registered and its runtime fixed for life. `startRun()` looks
the runtime up, builds the board tools (`createBoardServer` in-process for Claude
Code, `startBoardBridge` for Codex), resolves the provider env, builds the brief
(`buildBrief`), and calls `rt.start(spec)`.

`AgentSession.run()` pushes the user content onto the prompt iterable and runs
`query()`; every SDK frame goes through `handle()` and becomes events —
`sessionId`, `state`, `partial`, `text`, `tool`/`toolResult`, `thinking`,
`usage`, `spend`/`meter`, `permission`, `committed`, `waiting`. The manager's
listeners (wired in `launchInner`) update the card and call `touch()` → `change`
→ `refreshAll()`. When `system/init` arrives, the `sessionId` listener refuses a
clash with another RUNNING agent, then `store.adoptKey()` carries the board's
metadata from the run key to the real session id and `followKey()` moves the
selection with it. A `result` frame with background tasks outstanding enters
`waiting`, never `done`; a grace timer finishes the run when only a follow-up is
owed and none comes.

## A repaint

Any host event → `refreshAll()` → `paint.schedule()`; `paint` is `coalesce()`
around one `host.getState()` — leading edge immediate, one trailing run for a
burst, never overlapping, interval scaled to what the last repaint cost (floor
`REPAINT_INTERVAL_MS`, cap 500 ms). The one `UiState` goes to the side bar
(`provider.post`, through `forControl()`, which DROPS `transcript`, `streaming`,
`review`) and the editor panel (`BoardPanel.postCurrent`), then
`remotePusher.nudge()`. In the webview, `state` arrives; if `chromeSig()` equals
the recorded signature, `syncFrame()` patches in place (one branch per screen);
otherwise `render()` rebuilds and restores every `data-scroll`, every
`data-open`, focus and the caret. `composer.models` is omitted when the list is
the one the view already has, and the view keeps the last one it saw.

## A split

The agent calls `split_task` → `tools.ts` → `AgentManager.split()`: refused if
the worktree is dirty or has commits, if this session is itself a subtask, if
it already split, or over four pieces. `checkProposal()` (decomposition: the
gates, identical at every dial level) → `resolveRoute()` per piece (routing,
against the TARGET agent's catalogue; four refusals, each naming its fix) →
`confirmSplit` (a real click, host-side; `ASKS_FIRST` is only the soft layer).
Each piece is a normal `start()` forked from the parent's BASE, with
`SessionMeta.parent` on the child and `fanout` on the parent; a refused split is
recorded on the parent (`decompositionLine`). `linkSubtasks()` derives the thread
on every render. When the last child reaches a settled column,
`rollUpToParent()` moves the parent to review and notifies the user. Nothing
re-runs the parent.

## Handing work back, and the merge

`set_phase("validating", { howToTest })` → the plan is normalised and stored,
the knowledge-file check runs (`knowledgeCheck` over `changedFiles()` against
the base and the `paths:` in `docs/codemap/*.md` — refused with the file names
if an area you changed has an untouched file), the phase is written, the note
rides with the move, then `commitWorktree` commits the worktree with the
agent's message or one derived from the title. The host turns the move into a
notification with *Review changes* / *Open worktree*.

Review panel → `commit` (`commitAll`) → `merge` → a modal → `merge()` under the
repo lock: `ensureExcluded()`, refuse on `pendingMerge()`, refuse on a dirty
main tree (`dirtyMessage()` tells our mess from theirs), then `--no-ff
--no-commit`. The work is STAGED, `MERGE_HEAD` exists, the banner lists the
staged files, and every card's Merge button is disabled until `commitMerge` or
`abortMerge`. A conflict is the same banner in red; nothing resolves it for you.
At `complete`, the worktree cleanup is offered.

## A scheduled run

Settings page or `schedule_create` → `workspaceState` (`schedules`) → a
`setInterval` in `extension.ts` calls `fireDueSchedules()` (re-entrancy guarded)
and a catch-up pass runs at activation. `nextFireAt()` is anchored to
`lastFiredAt`, which is stamped BEFORE the launch, so a missed window fires
once, never once per missed day. `fireScheduleNow()` → `AgentManager.start()`
with the schedule's prompt → an ordinary card, its creator recorded.

## A Codex run

Same path to `rt.start(spec)`. `CodexSession` spawns `codex app-server`, speaks
`JsonRpcPeer` over stdio (bidirectional, routed on `method` vs `result`), takes
approvals as server→client requests where every branch ends in an answer, and
reads both `agent_message` and `agentMessage` spellings, reporting unknown
methods once per turn. Board tools reach it through `dist/board-mcp.js` → the
per-session socket → `board-bridge.ts` → the same `buildBoardTools` handlers in
the host, so `isHumanOnly()` and the knowledge check run host-side. Its
transcript is read back by `codex-store.ts`; its meter is a rate-limit
percentage, never dollars.

## Remote

Mirror: every repaint nudges `RemotePusher`; at most one push per
`MIN_INTERVAL`, nothing when idle, a heartbeat after `HEARTBEAT_MS`.
`RemoteFeed.build()` decides what travels (a tail only when its transcript
grew); `projectIndex`/`projectTail` in `relay.ts` decide what MAY travel —
`RemoteCardSource` is the redaction boundary. The relay — its own sibling
repository, `agents-kanban-relay` — stores it under `boardIdOf(code)`; the
viewer page fetches it. Prompts back:
`RemoteCommandClient` polls, `acceptCommands()` gates on `remote.writes`
(default off; enabling flushes the queue), nonces, and a live-session check,
then routes through the same `host.sendMessage` / `host.newSession` as the local
webview.

Headless: `server/server.mjs` activates the built extension against
`server/stub.mjs`; the browser gets `server/page.mjs`'s document with
`media/theme.css` first, `server/bridge.js` supplies `acquireVsCodeApi()`, host
frames arrive over SSE, `postMessage` becomes `POST /api/msg`, and the pairing
code gates everything as a header (`x-rc-code`) or `?code=` on the stream.
