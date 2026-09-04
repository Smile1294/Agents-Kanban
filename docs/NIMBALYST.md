# How Nimbalyst works

Findings from a deep read of [nimbalyst/nimbalyst](https://github.com/nimbalyst/nimbalyst)
at commit `f9f0232` (September 2026), across seven subsystems. Every claim was
checked against the actual source by a second pass — 396 confirmed, 60
refuted-and-corrected.

**Don't re-clone and re-analyse the repo.** That cost ~3.1M tokens and half an
hour. If something here is missing, the repo is ~114MB and the useful parts are
`docs/*.md` plus `packages/{electron,runtime,tracker-core}`.

Line numbers are from that commit and will drift.

---

## 1. How the AI moves a task

The single most important mechanism, and simpler than expected.

**One tool call:** `mcp__nimbalyst-trackers__tracker_update({ id, status })`.

There is no move, set-column, or reorder tool. `tracker_update`'s input schema
has `required: ['id']`, and `status` is an unconstrained optional string
described only as `"New status"`. **The board column IS the item's status
value**; lanes come from the status field's declared options in schema order.

### The policy lives in the tool description

All the "when to move it" guidance is in the tool's own blurb, not the system
prompt — models read tool descriptions far more reliably. Verbatim:

> IMPORTANT: Use 'in-review' when work is finished but not yet committed -- do
> not set 'done' on your own judgment. Once the user commits the work, that is
> their approval: prefer closing the item through a 'Fixes <issue key>'
> reference in the commit message, which closes it automatically. Setting 'done'
> directly is acceptable only for work the user has already committed.

### Three paths, not one

| Path | Mechanism | Trigger |
|---|---|---|
| Direct | `tracker_update` → `data` JSON write → IPC event → board repaints sub-second | Agent |
| Implicit | Commit message `Fixes NIM-123` → `GitRefWatcher` → `CommitTrackerLinker` → item to `done` | Agent writes it, **the user's commit approves it** |
| Blocked | `rejectHumanOnlyStatus` refuses `approved` at the tool boundary | Nobody — code-enforced |

That second path is the elegant one: the agent moves the card *implicitly* by
writing a commit message, and the human's act of committing is the approval.

### Tool discovery is deferred

The trackers server is registered without `alwaysLoad`, and `ENABLE_TOOL_SEARCH`
defaults to true, so at turn 1 the agent sees only tool *names* and must call
`ToolSearch` to load the schema before it can call the tool.

**We diverged here:** our board server sets `alwaysLoad: true`, because an agent
that has to go looking for the tool before it can move its own card will often
just not bother.

---

## 2. Storage — the README is misleading

Nimbalyst's README claims "Plain files on disk… No proprietary store to migrate
out of." The verified finding: **partially true; materially misleading.**

- Every tracker item has a row in `tracker_items` in SQLite at
  `<userData>/sqlite-db/nimbalyst.sqlite` — **outside the git repo**.
- The default item has **no file at all**. `tracker_create` produces
  `source: 'native'` — a DB row and nothing on disk.
- Markdown is one of several *sources*: `native` (DB only), `inline` (a
  `Title #bug[id:… status:…]` marker on a line), `frontmatter` (a whole `.md`
  whose YAML carries `trackerStatus: {type: plan}`).
- Only `plan` / `decision` types (`modes.fullDocument: true`) are genuinely files.

`data` is a JSON blob column with generated columns (`title`, `status`,
`kanban_sort_order`) projected out of it for indexing.

Rank within a column is a base-62 fractional index in `data.kanbanSortOrder`,
via `generateKeyBetween` — the standard `fractional-indexing` algorithm.

---

## 3. Sessions

`ai_sessions` table. The fields that matter:

```sql
metadata TEXT NOT NULL DEFAULT '{}'   -- JSON: phase, tags, activity[]
is_archived INTEGER NOT NULL DEFAULT 0
is_pinned INTEGER NOT NULL DEFAULT 0
worktree_id TEXT REFERENCES worktrees(id) ON DELETE SET NULL
status TEXT CHECK (status IN ('idle','running','waiting_for_input','error'))
provider_session_id TEXT               -- the Claude session id, for resume
```

**Archive is a soft flag**, never a delete. The list query also excludes sessions
whose *worktree* is archived.

`metadata.activity[]` is a bounded log (max 100) of `status_changed` entries with
`field / oldValue / newValue / timestamp`. Their code comments the reasoning:

> we deliberately track only the workflow `phase`, NOT the operational `status`
> (idle/running/waiting_for_input), which flips many times per turn and would
> saturate the bounded log with noise.

**We copied this design**, with the sidecar in extension storage instead of SQLite.

---

## 4. The session board UI

One file: `SessionKanbanBoard.tsx`, exactly 1903 lines.

- **No drag-and-drop library.** Native HTML5 DnD; grep finds no react-dnd,
  dnd-kit or react-beautiful-dnd anywhere in it.
- Drag payload is a custom MIME `text/session-ids` carrying `JSON.stringify(ids)`.
- Six lanes: an Inbox pseudo-lane plus backlog / planning / implementing /
  validating / complete.
- **No transition graph** — every phase can go to every other phase.
- Phase is a plain string inside the `ai_sessions.metadata` JSON blob.
- Live updates when an *agent* moves a card: the MCP tool writes in the main
  process, then `webContents.send('sessions:session-updated')` to every window.
- React 19, Tailwind, jotai. The tracker board is a *different* component with
  schema-derived columns and `virtua` virtualisation.

---

## 5. Worktrees

`GitWorktreeService.ts`, 2648 lines. One git command does the work:

```
git worktree add -b worktree/<adjective-noun> <project>_worktrees/<name> <base>
```

- Name from a 16,384-combination adjective-noun pool, de-duplicated against three
  sources: DB names, sibling directory names, and local branch names.
- Directory is `path.resolve(workspacePath, '..', basename + '_worktrees')`.
- Collision handling is a `while (fs.existsSync(...))` counter loop.
- On git failure the directory is `rmSync`'d and the error rethrown — no
  half-registered worktrees.
- **No seeding whatsoever.** No `.env` copy, no `node_modules`, no install hook.
  Config that would need copying (`.claude` settings, permissions, MCP config) is
  resolved *upward* to the parent project at read time instead.
- A per-canonical-repo-path async mutex (`GitOperationLock`) serialises every
  destructive operation.
- Merge conflicts are not auto-resolved: they spawn a fresh AI session
  pre-loaded with a prescriptive prompt.

---

## 6. Driving Claude Code

- `@anthropic-ai/claude-agent-sdk`, pinned to exactly `0.3.257` in three places.
- `query({ prompt, options })` — the prompt is **always** an
  `AsyncIterable<SDKUserMessage>`, never a bare string, so the SDK keeps the
  child's stdin open past the result chunk. A bare string breaks `interrupt()`,
  permission round-trips and follow-ups.
- `pathToClaudeCodeExecutable` is pinned explicitly, because `require.resolve`
  fails inside a packaged Electron asar.
- `DISABLE_AUTOUPDATER=1` / `DISABLE_UPDATES=1` are set — the CLI's in-place
  self-update corrupted their bundled binary (NIM-1573).
- Effort is passed via the env var `CLAUDE_CODE_EFFORT_LEVEL` (their SDK version);
  ours has a first-class `options.effort`.
- Session resume: capture `system/init.session_id`, replay as `options.resume`,
  with a fail-loud mismatch check.

### Two bugs they shipped as fixes, worth not repeating

- **GitHub #546** — the effort picker showed the app default while the session
  ran at the CLI's built-in `high`, because the default was never written into
  session metadata. Fix: resolve session value → app default → *unset*.
- **GitHub #1034** — the thinking toggle reset to "Extended: On" every session
  because nothing persisted the choice beyond the session row.

---

## 7. Context window tracking

From `docs/CONTEXT_WINDOW_USAGE_TRACKING.md`, and the trap is worth memorising.

Context fill is **per-step**, from `assistant` chunks:

```
input_tokens + cache_read_input_tokens + cache_creation_input_tokens
```

`result.usage` is **cumulative across every step** — a 200k-window session can
report 3.1M input tokens. Their doc calls using it for fill "wildly wrong".

- Keep `lastAssistantUsage` separate; never let the result chunk overwrite it.
- Emit per assistant chunk, not at turn end, or a long agentic turn shows a
  frozen needle (NIM-868).
- `contextWindow` per model comes from `result.modelUsage`.
- On `compact_boundary` there is **no assistant message afterwards**, so the
  meter would stay pinned at the pre-compaction figure. Reset explicitly.

---

## 8. MCP hosting — and why we don't need it

One unified `node:http` server in the Electron main process, listening on
`127.0.0.1`, port-scanning up from 3456 (100 attempts, `port++` only on
EADDRINUSE). Multiplexes five first-party MCP servers onto path prefixes
(`/mcp/core`, `/mcp/host`, `/mcp/trackers`, …). A per-launch 32-byte hex bearer
token from `randomBytes(32)`, compared with `timingSafeEqual`, gates every
request. Workspace and session identity ride as query params on the connection
URL.

**None of this is needed in a VS Code extension.** Electron is multi-process; an
extension host is one Node process, so `createSdkMcpServer()` gives in-process
MCP tools with no port, no token, and no transport. That deletes the entire
subsystem.

---

## 9. Orchestration

- `MetaAgentService` injects 10 tool functions: `list_worktrees`,
  `create_session`, `spawn_session`, `get_session_status`, `get_session_result`,
  `list_queued_prompts`, `send_prompt`, `notify_user`, `respond_to_prompt`,
  `list_spawned_sessions`.
- Child sessions are ordinary `ai_sessions` rows with `created_by_session_id`
  pointing at the caller.
- Results flow back by **push, not polling**: a child completion queues a
  `[Child Session Update]` prompt on the *parent* session and re-drives its queue.
- **Tracker items never auto-launch agents.** Always an explicit user action, an
  agent calling `create_session`, or a time trigger (`schedule_wakeup`).
- "Workflows" are markdown files — `.claude/commands/*.md` — executed by the
  agent SDK when the raw `/name args` text is submitted.

---

## 10. What we took, and what we left

**Took:** column-is-status; policy in tool descriptions with the boundary in
code; per-repo git mutex; no worktree seeding; bounded phase activity log;
phase separate from operational status; native HTML5 drag and drop; the
per-step-vs-cumulative usage distinction.

**Left:** SQLite (we read Claude Code's store instead); the HTTP+SSE MCP server
with bearer auth (in-process tools instead); deferred tool loading for the board
tools (`alwaysLoad: true` instead); fractional-index ordering (sessions sort by
recency, not manual rank); the tracker/session split (one entity, two views).

---

## 11. The interaction surface, item by item

The board was built first and the *conversation* lagged behind it. This is the
honest state of each thing Nimbalyst does when you are talking to an agent
rather than looking at the board.

| Nimbalyst | Here | Note |
|---|---|---|
| `AsyncIterable` prompt, never a string | ✅ | The reason `interrupt()` and follow-ups work at all |
| `pathToClaudeCodeExecutable` pinned | ✅ | `resolveClaudeExecutable()` |
| `DISABLE_AUTOUPDATER` / `DISABLE_UPDATES` | ✅ | Was missing. Their NIM-1573: the CLI self-updated mid-run and corrupted its own binary |
| Interrupt the turn, keep the session | ✅ | Was written and **unreachable** — nothing in the UI called it |
| Follow-ups queued behind a running turn | ✅ | Shown as pending until the turn ends |
| `notify_user` | ✅ | Agent raises a VS Code notification when it is stuck |
| Workflows = `.claude/commands/*.md` | ✅ | Execution always worked; **discovery** did not. `/` now autocompletes |
| Permission mode changeable mid-run | ✅ | `setPermissionMode()` on a live session, all six modes |
| Effort / thinking / model per session | ✅ | With the unset-vs-default distinction (their #546) |
| Context meter, per-step not cumulative | ✅ | Their NIM-868 |
| Session resume with fail-loud mismatch | ⚠️ | Resume works; a session returning a *different* id is not detected |
| Conflicts spawn a fixing agent | ❌ | We surface conflicts and offer Abort; we do not spawn |
| Orchestration (`spawn_session`, `send_prompt`, …) | ❌ | Ten meta-agent tools. A whole subsystem, deliberately not started |
| `schedule_wakeup` time triggers | ❌ | Not started |
| Pin a session | ⚠️ | Stored and sorted on; no UI to set it |

The three ❌ rows are the honest remainder. Orchestration in particular is not a
missing button — it is agents spawning and driving other agents, with results
pushed back onto a parent's prompt queue.
