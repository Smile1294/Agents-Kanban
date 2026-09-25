# Harness review — what exists, what was missing, what to build next

Written 2026-09-25 for the brief *"make an overview of all the implemented
features, review what is missing; let agents control the project themselves
(open a browser, test the feature they worked on, see the screen); fix the
history; let me highlight things in images; check online for must-have harness
features and optimisations; then implement in phases."*

The first three phases are **built** on branch
`claude/self-checkout-harness-overview-cvpkyy`, one commit each (§3). Everything
after §5 is the roadmap: ranked, with the files each item would touch.

---

## 1. What is implemented today

Checked against the code, not against older docs. [PLAN.md §8](../PLAN.md)
describes each item in depth; this is the map.

| Area | Feature | Where |
|---|---|---|
| **Board model** | A card and a session are the same thing; a card's column *is* its `phase`, and writing `phase` is the move | `board/config.ts`, `agent/tools.ts` `set_phase` |
| | Approval columns the agent cannot reach, enforced in code (`isHumanOnly`) | `board/config.ts` |
| | Stalled cards (started column, nothing running) with a "resume and ask for the test plan" button; interrupted runs say "Interrupted 9m ago" | `stalledSince`, `SessionMeta.running` |
| | Pinning, tags, age bound for foreign sessions with a clickable hidden count | `board/config.ts` `splitByAge` |
| **Isolation** | One git worktree per task on a `task/<id>-<slug>` branch; the `/.agentskanban/` ignore rule in `.gitignore` *and* `.git/info/exclude` | `git/worktree.ts` |
| **Agents** | Two runtimes side by side — Claude Code (Agent SDK) and Codex (app-server) — behind one `AgentRuntime` interface | `agent/runtime.ts`, `agent/runtimes/*` |
| | Provider profiles for Claude Code: Bedrock, Vertex, gateways, local models; credentials in `SecretStorage`; endpoint probe that can say "bad" | `agent/providers.ts`, `probe.ts`, `endpoint.ts` |
| | Per-session model / effort / thinking / ultracode / fast mode; model list from the CLI (with version and "update Claude Code" button) or the endpoint | `agent/models.ts`, `cli-update.ts` |
| | Concurrency limit with a queue whose runs have cards | `agent/manager.ts` |
| | Background agents tracked past the turn that spawned them; a run with live background tasks waits instead of ending | `sessions/subagents.ts`, `agent/session.ts` |
| | Subagent (Task) transcripts nested under their Task | `sessions/store.ts`, `session.ts` |
| | Permission prompts on the card, `AskUserQuestion` rendered as a real picker | `board/questions.ts` |
| **Board tools** | `set_phase`, `set_title`, `set_tags`, `list_board`, `notify_user`, `split_task`, `schedule_*` — one definition, in-process for Claude Code and over a socket bridge for Codex | `agent/tools.ts`, `board-bridge.ts`, `board-mcp.ts` |
| | A test plan (`howToTest`) is required on the move into review; the worktree is committed on that move; knowledge files (`docs/codemap/`) are checked host-side | `set_phase`, `board/codemap.ts` |
| **Orchestration** | `split_task`: at most four subtasks, one level deep, only before any change; per-piece routing to another agent/backend/model; orchestration dial; roll-up to the parent | `agent/routing.ts`, `spawn-policy.ts`, `board/subtasks.ts` |
| | Scheduled runs with catch-up | `board/schedules.ts` |
| **Review & merge** | Changed files, native diff against the fork point, Run button (project launcher → framework detection, waits for the port), `merge --no-ff --no-commit` with `MERGE_HEAD` as the only truth, conflict banner | `git/worktree.ts`, `run/recipe.ts` |
| **Transcript** | Streaming markdown (no `innerHTML`), tool rows with timings, thinking collapsed, compaction dividers, search across every session, "try again from here" (file-history rewind + fork) | `media/board.js`, `sessions/search.ts`, `checkpoints.ts` |
| **Meters** | Context fill and spend derived from the transcript (survive restarts), checked against the CLI's billed figure; subscription meters are a different unit, never `$0.00` | `sessions/usage.ts`, `Meter` union |
| **Input** | Images in the composer as image content blocks; local dictation (ffmpeg + whisper) or VS Code's built-in | `agent/images.ts`, `dictation.ts` |
| **Surfaces** | Side bar, editor panel, full-window focus mode, settings page, notifications on review, status bar | `extension.ts`, `board/panel.ts`, `settings.ts` |
| | Remote Control: the relay mirror (per-viewer frame slots) and the headless board | `remote/*`, `server/*` |
| **Gates** | Real-data store tests, real-git worktree tests, stub-DOM view tests, Chromium layout measurement, launch smoke against the built bundle, package-content test | `scripts/test.mjs`, `smoke.mjs` |

---

## 2. What was missing against the brief

| The brief asked for | State before this round |
|---|---|
| Agents control the project themselves: start the app, open a browser, test their feature | **Absent.** The Run button started the app for the *user* in terminals an agent cannot read. An agent's evidence was "it compiles"; its test plan described a screen it had never seen. |
| Agents can see the screen | **Absent.** No screenshot or page-reading tool. |
| History that behaves | **Two real bugs** (§4.1): a false and sticky "Load earlier", search hits on the wrong row, and finished runs frozen at their launch-time history. |
| Highlight things in images | **Absent**, and images were being **silently lost** on the most common path (§4.2). |

---

## 3. Built in this round

### Phase 1 — agents look at their own work (`feat(harness)`)

Ten tools on the board server, so both runtimes get them and they are
auto-allowed like the card tools:

| Tool | What it does |
|---|---|
| `app_start` | Starts the **host's** Run recipe (your `runCommand`, the project's own launcher, or a detected dev script) as child processes in the agent's worktree, waits until it answers, returns the URL — or why it did not come up, with the tail of its output |
| `app_logs` / `app_stop` | The server's stdout/stderr; stop it (the whole process group) |
| `browser_open` | Opens a page in the agent's own headless Chromium (1280×800). No URL = the app it started. Reports console errors, uncaught exceptions, failed requests and HTTP ≥ 400 that happened while loading |
| `browser_snapshot` | The page as its accessibility tree — cheap text, names what can be clicked |
| `browser_screenshot` | A JPEG the model **sees** (image content block), also saved under extension storage so you can open it from the test plan |
| `browser_act` | click · fill (+submit) · press · select · hover · check/uncheck · scroll · wait — each reports where the page ended up and any new errors |
| `browser_eval` / `browser_console` / `browser_close` | JSON of an expression; everything the page reported; close |

Decisions worth knowing (each is in the file headers):

- **The port is never scanned for.** Accepted only from the recipe, a `PORT` we
  chose, or a URL printed on the child's own output. Another worktree's server
  on 3000 shows old code and looks fine.
- **Loopback only**, enforced in code (`browser.ts` `allowedUrl`), because the
  tools run without a prompt and a page is text the model acts on.
  `agentsKanban.browserAllowExternal` widens it.
- **Text first, pixels when asked** — the descriptions steer agents to the
  snapshot; a screenshot is ~1.5k tokens.
- **The browser closes with the run; the app stays** (the test plan links to
  it) until its worktree is removed, a fifth app starts, or the window closes.
- Screenshots are the one place outside the worktree a test-plan file link may
  point to.
- Settings: `agentBrowser` (on), `browserExecutable` (machine scope),
  `browserAllowExternal`, `browserHeaded` (watch it work).
- `playwright-core` is now a runtime dependency (the .vsix grows to 7.3MB); it
  drives any Chromium — Playwright's cache, or an installed Chrome/Chromium/Edge.

**Verified with a real agent run** (Claude Code CLI, `claude-sonnet-5`, a temp
repo with a todo page whose Add button threw on a typo'd element id). Unprompted
beyond "reproduce it in the browser", the agent called `app_start` →
`browser_open` → `browser_snapshot` → `browser_act` fill/click, got the
`TypeError` back in the click's own result, read and fixed `index.html`,
`app_stop` + `app_start`, re-checked with fill/click/snapshot, took one
`browser_screenshot`, and moved to validating with the screenshot's path as a
`howToTest` file link. 21 tool calls, no permission prompt for any harness tool.

### Phase 2 — the history (`fix(history)`)

1. **One unit.** The window was cut in *messages* and compared with a count of
   *entries*. A tool-result-only message draws nothing, so in a tool-heavy
   session "Load earlier" appeared with nothing above, a click brought back
   the same rows and left the pill stuck busy, and search hits flashed the
   wrong row. The store now parses the whole file into entries once (cached),
   windows the entries and totals entries.
2. **Finished runs read off disk.** A finished run stays in the manager's list,
   and its chat was still drawn from the launch-time copy: no paging, search
   blind to older messages, no fork button on the newest prompts, and rows that
   changed on the next reload. It is now drawn like any other session, with its
   own phase/result/notice rows laid back in by time.
3. The pill is released by a frame that says nothing more is above.

### Phase 3 — images (`feat(images)`)

- **Annotation editor.** Click an attached image: box and arrow (numbered), pen,
  label, four colours, undo. Marks are flattened into the image that is sent,
  the vectors are kept for re-editing, and the message says which images carry
  your markings — so "#2 is misaligned" lands on a place.
- **A follow-up to a finished session dropped every image**, silently — the
  most likely cause of "images have problems nowadays". Fixed; also a message
  to a still-queued card.
- BMP/SVG/AVIF/`image/jpg` and over-3.5MB files are re-encoded in the view
  instead of being refused on the host after the draft was cleared; HEIC, the
  8-image cap and duplicates are now *said*.

---

## 4. Findings that are not fixed yet

### 4.1 History

- **Rewind may restore only part of the worktree.** `forkAt` restores files in
  the anchor's snapshot; a file first edited *after* the anchor keeps the
  discarded edits, and "created" entries (null backup) are skipped. Verify
  against a real CLI's `rewindFiles` behaviour before changing it
  (`sessions/checkpoints.ts`).
- In-flight runs: the newest prompts have no message id until the run ends, so
  no fork button on them mid-run.
- `transcriptWindows` stays keyed by the old id after `adoptKey`/fork, so a
  widened window resets.

### 4.2 Images

- **Codex sessions still show 📎**; `capabilities.images` is never read, the
  images become a note to the model.
- **Remote Control drops a message over 4MB** (`remote-contract.json`
  `msgMaxBytes`) without telling the phone — one or two full screenshots.
- The transcript shows a **count**, never a thumbnail. The bytes are in Claude
  Code's JSONL, so a thumbnail could be loaded on demand (never per repaint).
- Every turn re-sends every earlier image; nothing on the board warns as a
  conversation approaches the API's 32MB request limit.

### 4.3 Elsewhere

- `smoke.mjs`'s update-button block fails on a machine that has a real
  `claude` on PATH (this container): an earlier step leaves an agent live, so
  the updater stops at "an agent is running on this Claude Code". Environmental
  and pre-existing; it needs the smoke to stop its agents before that block.

---

## 5. What comparable harnesses have (research, September 2026)

Sources were read directly where the network allowed; cursor.com,
conductor.build and vibekanban.com were known only from search excerpts.

- **Browser self-verification is table stakes.** GitHub Copilot's coding agent
  ships Playwright MCP on by default and posts screenshots to the PR
  ([changelog](https://github.blog/changelog/2025-07-02-copilot-coding-agent-now-has-its-own-web-browser/));
  Anthropic's long-running-agent harness found browser end-to-end testing
  "dramatically improved performance"
  ([article](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents));
  Cursor 2.x, Cline/Roo (`browser_action`), Claude Code `--chrome`, Vibe Kanban
  and Windsurf Previews all have one. Reference tool sets:
  [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) and
  [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp).
  Pitfalls they report: snapshots of complex pages run to hundreds of KB, a
  shared browser profile breaks parallel agents, orphaned browsers pile up.
- **Element picker + annotate-before-send.** Lovable draw mode, Vibe Kanban /
  Windsurf "send element" (selector, component and source file as text — cheaper
  and more precise than pixels).
- **Best-of-N.** Cursor (up to 8 in parallel worktrees), Codex cloud
  (`--attempts`), with side-by-side comparison.
- **A critic before the human.** Jules' planning critic, Devin Review, Sculptor
  suggestions, Anthropic's evaluator–optimizer pattern
  ([building effective agents](https://www.anthropic.com/engineering/building-effective-agents)).
- **Checkpoints that include Bash side effects.** Claude's `/rewind` covers
  Write/Edit only; Conductor snapshots the whole tree into a private git ref
  before every turn — nothing in the working tree, which fits this project's
  storage rule.
- **Setup scripts and environment caching** per worktree (Conductor setup
  scripts, Jules snapshots).
- **OS sandboxing** (Claude Code's bubblewrap/seatbelt sandbox, reported 84%
  fewer permission prompts) and autonomy tiers instead of per-tool prompts.
- **Handoff instead of compaction** (Amp), a progress file plus git as memory
  (Anthropic).
- **Cache-hit rate as a first-class metric**
  ([prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything)).

---

## 6. Roadmap — the next phases, ranked

Each phase is one branch-sized piece. "Touches" names the files; the gate is
what must go red if it is broken.

### Phase 4 — verification becomes evidence on the card

- Record, per run, what the agent verified: pages opened, screenshots taken,
  console error count at the end. Show it in the review panel beside
  `howToTest` ("3 screenshots · 0 console errors"). The error count is a number
  that can say bad; "tested in browser ✓" is not.
- Render screenshots as thumbnails in the transcript's tool rows, loaded on
  demand from extension storage through `asWebviewUri` (never inline in state).
- Touches: `agent/harness.ts` (a per-run ledger), `SessionMeta` + `parseMeta`
  (round-trip test), `media/board.js` review panel. Gate: a meta round-trip test
  and a smoke assertion that the panel shows the count.

### Phase 5 — an element picker for the user

- "Pick element" in the agent's browser (headed) or on a screenshot: click an
  element, the composer gets its selector, role/name and bounding box as text,
  plus the cropped screenshot. The research is unanimous that structured
  context beats pixels.
- Touches: `agent/browser.ts` (an `elementAt(x, y)` evaluate), a composer chip
  in `media/board.js`.

### Phase 6 — the remaining image gaps (§4.2)

- Hide 📎 for a runtime without `capabilities.images` (send the capability in
  `composer`), check the total against the relay's 4MB before posting from a
  remote page, and on-demand thumbnails of sent images in the transcript.

### Phase 7 — whole-tree checkpoints

- Before each turn, snapshot the worktree (tracked + untracked, not ignored)
  into `refs/agentskanban/checkpoints/<session>/<n>` with `git stash create` /
  `git write-tree` on a temporary index. Rewind restores from the ref, so Bash
  side effects and files created after the anchor are covered (fixes §4.1's
  partial restore). Nothing is written to the working tree or a branch.
- Touches: `git/worktree.ts`, `extension.ts` `forkAt`. Gate: a real-git test
  where a Bash-created file disappears on rewind.

### Phase 8 — a critic before review

- Optional per board: on the move into review, spawn a short read-only review
  session (cheaper model, `Read`/`Grep` + the diff) whose findings land on the
  card as notes; the move is not blocked. Uses the existing routing and the
  `split_task` machinery for "another agent", not a new mechanism.

### Phase 9 — best-of-N

- "Run ×N" on a new session: N sibling cards from the same prompt (optionally
  different agents/models, via the existing routing), grouped under one parent,
  with a compare view of their diffs and test plans; merging one archives the
  rest.

### Phase 10 — setup scripts per worktree

- `agentsKanban.setupCommand` (or `.agentskanban` config in extension storage)
  run once when a worktree is created — install dependencies, copy `.env` from
  the main checkout — so agents do not spend turns on it. Output kept like
  `app_logs`.

### Smaller, worthwhile

- Cache-hit rate beside the spend readout (the usage records already carry
  `cache_read_input_tokens`).
- Stop agent-started apps when a card is archived or merged, not only when its
  worktree is removed.
- `browser_resize` / device emulation for responsive checks; `storageState`
  capture so an agent can test behind a login you performed once.
- Optionally let a runtime use `@playwright/mcp` instead of the built-in tools
  for sites that need its larger surface — but keep the built-in set as the
  default: it is small (context cost), per-card isolated, and loopback-fenced.

---

## 7. Optimisations

- **Keep the system prompt stable.** The brief is `appendSystemPrompt`; it must
  never carry a timestamp or live state, or every turn misses the prompt cache.
  The harness paragraph is static for exactly this reason.
- **Tool surface.** The board server is `alwaysLoad: true` and now carries 20
  tools. If turn-1 context becomes a concern, move the ten `app_*`/`browser_*`
  tools to a second, deferred server (not `alwaysLoad`) on Claude Code — the
  brief names them, and deferred tools are found by tool search.
- **Pixels are the expensive part.** Snapshots before screenshots (done),
  element screenshots over full pages, JPEG at 1280×800 (done); downscale
  pasted images per model (newer models accept 2576px at up to 3× the tokens —
  1568px stays the default).
- **Don't re-send images forever.** Anthropic's Files API (`file_id`) avoids
  base64 on every turn but is unavailable on Bedrock/Vertex; at minimum, warn as
  a conversation's images approach the request limit.
- **Repaint and parse costs** are already measured and bounded (`coalesce`, one
  `boardPass()` per repaint, parse cached on file identity). Phase 2 made
  "Load earlier" and search free slices of that same cache.
- **Environment caching** (phase 10) is the biggest wall-clock win for agents in
  fresh worktrees: `npm ci` per worktree is minutes of turns.
