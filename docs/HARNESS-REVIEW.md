# Harness review — what exists, what was missing, what to build next

Written 2026-09-25 for the brief *"make an overview of all the implemented
features, review what is missing; let agents control the project themselves
(open a browser, test the feature they worked on, see the screen); fix the
history; let me highlight things in images; check online for must-have harness
features and optimisations; then implement in phases."*

Two rounds are **built** on branch `claude/self-checkout-harness-overview-cvpkyy`,
one commit per piece: phases 1–3 (§3), then every finding fixed plus phases 4 and
7 and three features from the research (§4). §5a is the research on what people
switch tools for; §6 is the roadmap that is left, ranked, with the files each
item touches.

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

## 4. Second round — the findings fixed, phases 4, 6 and 7, and three from the research

Every finding the first round listed as unfixed is fixed, each in its own
commit on this branch, each with a gate that was shown to fail.

| Was | Now |
|---|---|
| **Rewind restored only part of the worktree**: files first edited after the anchor, files the discarded turns created, and anything Bash changed were left as they were | **Whole-worktree checkpoints** (`src/git/checkpoints.ts`). Before every message it sends, the host snapshots the worktree under the message's id. It uses a temporary index seeded from the real one, `write-tree`, and a commit whose parent is HEAD, stored on `refs/agentskanban/checkpoints/<branch>/<id>`. Nothing touches the working tree, the index or the branch. A rewind makes the worktree match exactly: it restores changed and deleted files, removes created ones, never touches ignored ones, and moves the branch back past commits made after the anchor. The modal says all of that first. Older messages fall back to the file-history path. |
| No fork button on prompts of a run still in flight | Prompt rows carry their transcript id from the moment they are sent. The host mints a uuid and puts it on the streamed user message, and the CLI writes the row under exactly that uuid (verified against a real CLI). |
| `transcriptWindows` reset after a key change | The widened window follows the card's key. |
| Codex sessions showed 📎 and silently turned images into a note | No 📎 on an agent that cannot take images. A paste there says why. |
| Remote Control silently dropped a message over 4MB | On a relay page, a message over the cap is refused *before* the draft is cleared. `check-contract.mjs` pins the view's constant to `msgMaxBytes`. |
| The transcript showed an image **count** only | **Show** on a prompt row reads that one message's images back from Claude Code's own file, on the click, in the editor only, and never into state. |
| No warning as images approached the 32MB request limit | The composer warns at 60% of the limit, counting browser screenshots in tool results and resetting at a compaction. |
| `smoke.mjs` failed on a machine with a real `claude` on PATH | The cause was a **real bug**: `askTestPlan` aimed at an unknown key resumed a session id nobody had and started a real CLI. It is now a no-op, and smoke asserts that its message sweep starts no run. |

Built on top:

- **Phase 4: verification as evidence.** The harness counts, where the calls
  happen, the pages opened, the actions taken, the screenshots saved and the
  errors on the page left open. `set_phase` stamps that record on the test
  plan as `verified`, and drops any `verified` the agent wrote itself. The
  review panel shows it as numbers ("2 pages · 4 actions · 2 screenshots ·
  1 error on the last page"), amber when errors are not zero, with a button per
  screenshot.
- **Phase 6: the image gaps** and **phase 7: whole-tree checkpoints**, in the table above.
- **Research #1: review comments on the diff.** A VS Code comment controller
  offers the gutter "+" on files inside a card's worktree, so on the right side
  of every diff. A comment becomes a draft on that card. "Send to agent" resumes
  it with ONE numbered message, ordered like the diff, each comment with the
  lines it was written on quoted.
- **Research #5: "Needs you".** Everything waiting on the user, derived once
  per board pass from the cards: questions and permissions, failed,
  interrupted and stalled runs, and work ready to test. Blocking items come
  first, and each row shows how long it has waited. It is drawn on the board
  and in the rail, and the status bar leads with it.
- **Research #9: a spend cap.** `agentsKanban.maxSpendPerMessageUsd`, measured
  from the spend when the user last sent a message. Past it, the turn is
  interrupted (the session stays open) and the card says why. Dollar meters
  only.

**Verified with a second real agent run** (Claude Code CLI, a counter page
whose +1 added 2):
- The live prompt id matched the transcript row's id.
- The test plan came back with `verified: { pages: 1, actions: 1, consoleErrors: 0 }` stamped by the host.
- Rewinding to the first message restored `index.html` and moved the branch back past the agent's commit, leaving `git status` clean.

## 4b. Third round — seeing many tasks at once, and testing as part of the flow

**The problem.** With ten cards in Planning, five in Implementing and two in
testing, the board had to be read column by column to answer the only
question that matters: which of these need me?

- **The Overview layout** (toolbar: Columns | Overview) lists every card once,
  sectioned by what it **needs**, not where it sits: needs you, running now,
  ready to test, queued, not started, done.
  - Counts sit at the top: "1 needs you · 5 running now · 2 ready to test · 10 not started".
  - A running row carries the live agent strip (current tool, age of the last frame, context), kept current by the fast path.
  - A test row carries the plan summary, the browser evidence and the auto-check.
  - Not started and done begin folded, so ten planned cards are one line.
- **Columns fold.** In the Columns layout, a column header folds its column to
  a slim bar with a count and a coloured dot per card. It is still a drop target.
- Both choices are remembered like any closed panel.

**Browser testing as part of the standard flow** (`agentsKanban.autoVerify`):
- **`check` (default).** When a card moves into review, the host itself:
  - starts the app in the worktree,
  - opens it in its own Chromium context,
  - records every error while it loads, and a screenshot,
  - runs the project's own e2e suite if it declares one (`test:e2e`, `e2e`,
    `test:browser`, `playwright`…), with the app's URL in `BASE_URL` / `PLAYWRIGHT_BASE_URL`.
- **Where the result goes.** It lands on the test plan as `autoCheck`, apart
  from the agent's own `verified` record. A failure shows up in several places:
  - "Needs you" and the Overview, as "failed the board's auto-check";
  - a warning notification;
  - a **Send failure to agent** button that resumes the agent with exactly what failed.

  It never resumes an agent by itself.
- **`require`.** A diff that touches files a browser shows cannot reach review
  until the agent has opened one. This is refused in code, and the brief says
  so up front.
- **`off`.** No automatic check.

Code: `src/run/autocheck.ts` (tested against real processes and Chromium: a
page that throws on load fails, a failing suite fails with its output, an app
that dies on boot fails with its log, and a change with no UI files is skipped
without starting anything), plus `renderOverview` in `media/board.js`.

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

## 5a. What people SWITCH harnesses for (research, September 2026)

A second pass, asking which features people publicly say made them change
tools. Evidence is mostly vendor numbers, reviews and a few posts. cursor.com,
ampcode.com, conductor.build and news.ycombinator.com were only reachable
through search excerpts, so treat quoted figures as the vendors' own claims.

Three changes in the market that shape the ranking:
- **Vibe Kanban's company shut down on 10 April 2026** ([post](https://www.vibekanban.com/blog/shutdown)). The project is community-maintained, and Nimbalyst is courting its users. A VS Code-native kanban has an opening.
- **Amp removed Handoff** in its May 2026 rebuild ([ampcode.com/news/neo](https://ampcode.com/news/neo)). It is no longer a reason to switch, and fork/rewind covers it here.
- **Cursor 3 made an agents window, worktrees and `/best-of-n` its main interface** ([changelog](https://cursor.com/changelog/3-0)), and GitHub Agent HQ runs Claude, Codex and Copilot side by side ([blog](https://github.blog/news-insights/company-news/welcome-home-agents/)). Parallel agents on a dashboard are now table stakes; the review and feedback loops are what set tools apart.

Ranked by "people switch for this" against the effort to build it here:

| # | Feature | Who has it | Here |
|---|---|---|---|
| 1 | **Line comments on the diff, sent back as one batch** | Vibe Kanban, Conductor, Copilot "fix batch" | **BUILT** (§4) |
| 2 | **A second agent reviews before the human**, ideally on a different model | Jules critic, Amp Oracle, Anthropic Code Review (substantive comments on 54% of PRs, up from 16% — [blog](https://claude.com/blog/code-review)), `codex-plugin-cc` | Next (§6). This board already runs **both** runtimes, which is rare, and cross-model review is where the gain is reported. |
| 3 | **CI/PR status fed back to the agent, with fixes** | Bugbot Autofix (share fixed before merge 52%→76% — [blog](https://cursor.com/blog/bugbot-updates-june-2026)), Conductor Checks, Devin Review | Next (§6) |
| 4 | **Plan mode with an editable plan as a gate** ("the most slept-on feature in Claude Code" — Boris Cherny) | Claude Code, Cursor, Kiro specs | Next (§6) |
| 5 | **An attention inbox, with push approvals** | Claude Code Remote Control, community ntfy/Telegram bridges | Inbox **BUILT** (§4); push to the phone via the relay is next |
| 6 | **Best-of-N with side-by-side comparison** | Cursor `/best-of-n`, Codex `--attempts`, Agent HQ | §6. Mixed reviews: it helps on hard bugs and is overkill otherwise |
| 7 | **Try the agent's work in the main checkout** | Conductor Spotlight, Sculptor Pairing Mode | §6 |
| 8 | **Memory, knowledge and playbooks** | Claude Code auto memory, Devin Knowledge/Playbooks, DeepWiki | Partly (codemap). Playbooks are §6 |
| 9 | **Budgets** | Cursor spend limits (after the usage-billing backlash) | Per-message cap **BUILT** (§4); a daily cap is next |
| 10 | **Scheduled and suggested tasks** | Jules Suggested Tasks | Scheduling exists; suggested cards are §6 |
| 11 | **Sandbox or container per card** (Claude Code's sandbox cut prompts by 84%) | Claude Code `/sandbox`, container-use, Sculptor | §6 |
| 12 | **Plugin and MCP management** | Claude Code plugins | §6 |

## 6. Roadmap — the next phases, ranked

Each phase is one branch-sized piece. "Touches" names the files; the gate is
what must go red if it breaks.

### Phase 8 — a second agent reviews before you do (research #2)

- **What it does:** on the move into review (a setting: off, on, or "above N changed lines"), the host starts a read-only reviewer session on the same worktree, on the *other* runtime or model where one is installed, with the diff against base.
- **What you see:** its findings land as the same drafts as review comments (§4), so the card says "Codex reviewed: 3 findings" and you choose Send to agent or Discard. Each review shows its cost.
- **What it reuses:** `split()`'s routing picks the reviewer (`agent/routing.ts`); `board/review-comments.ts` holds the findings.
- **Tool gating:** the reviewer gets a `post_finding(file, line, text)` board tool instead of Edit/Write, and its permission gate is read-only.
- **Gate:** a manager test that a reviewer run cannot write to the worktree.

### Phase 9 — PR and CI feedback (research #3)

- **What it does:** an optional "Open PR" path beside the local merge, using `gh pr create` from the worktree branch.
- **What you see:** a checks badge with a number ("2 failing · 14m ago"), never just a dot.
- **How it polls:** the host runs `gh pr checks` on the existing 5s tick, only for cards that have a PR, backing off when nothing changes.
- **Fixing CI:** "Fix CI" resumes the agent with the failing log (`gh run view --log-failed`, keeping the tail). Auto-fix is capped at N attempts, host-side.
- **Touches:** `git/worktree.ts`, a new `git/github.ts`, `extension.ts`.

### Phase 10 — plan as a gate (research #4)

- **What it does:** cards in Planning run with `permissionMode: 'plan'`. The plan is captured from `ExitPlanMode` into the sidecar, never the repository, and shown as an editable checklist.
- **What you see:** "Approve & implement" resumes the session with the edited plan. Each item can become a subtask through `split()`.
- **At review:** the move into review lists which items were done and which were skipped.

### Phase 11 — push approvals to the phone (research #5)

- **What it does:** Web Push or ntfy from the relay for the "Needs you" items, answered through the same `board/questions.ts` path.
- **Where it lives:** mostly in the relay repository, plus one event type in the contract.

### Phase 12 — best-of-N (research #6)

- **What you see:** "Run ×N" on a new card creates N sibling cards from the same brief with different routes, grouped as a stack.
- **The compare view:** diff stat, test-plan result, `verified`, spend and duration per candidate. "Keep this one" merges it and archives the rest, removing worktrees only after you confirm. The total cost is shown before launch.

### Phase 13 — try it in the main checkout (research #7)

- **What it does:** "Try in main" is refused if the main checkout is dirty (the merge modal).
- **How it works:** it records the main checkout's HEAD on a private ref, then syncs *tracked* files from the worktree as they change. "Stop trying" puts the main checkout back exactly as it was.
- **The invariant:** it must never leave the main checkout dirty, or merge stops working. The gate is a real-git test.

### Phase 14 — the element picker

- **What it does:** "Pick element" on a screenshot or in the headed browser. The composer gets the element's selector, role, name and bounding box as text, plus the cropped screenshot. The research is unanimous that structured context beats pixels.
- **Touches:** `agent/browser.ts` (an `elementAt(x, y)` evaluate), a composer chip.

### Smaller, worthwhile

- A **daily** spend cap beside the per-message one.
- **Setup scripts per worktree** (`agentsKanban.setupCommand`, run once when a worktree is created, output kept like `app_logs`), so agents stop spending turns on `npm ci`.
- **Playbooks:** saved card templates (brief, route, flags) on the new-card menu, feeding scheduled runs too.
- **The CLI's own sandbox** as a per-card flag, checked on `init` the way ultracode is.
- **Cache-hit rate** beside the spend readout.
- **Stop agent-started apps** when a card is archived or merged, not only when its worktree is removed.
- `browser_resize` / device emulation, and `storageState` capture for testing behind a login.

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
