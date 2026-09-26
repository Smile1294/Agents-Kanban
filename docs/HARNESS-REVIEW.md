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

## 4c. Fourth round — the whole stack in a worktree, a live browser, verified on Laravel

- **A fresh worktree is set up before it runs** (`prepareFor` / `runPrepare`):
  - the main checkout's `.env`, or `.env.example` plus `key:generate`;
  - `composer install` when `vendor/` is missing, and the lockfile's install when `node_modules/` is missing (`npm install --no-package-lock` when none is committed);
  - the worktree's own SQLite database, created and migrated. A shared database is never migrated from here.
- **Laravel starts everything it runs as:** `npm run dev`, `php artisan queue:listen` (unless `QUEUE_CONNECTION` is sync), and `php artisan serve` on a free port, with `APP_URL` on that port.
- **The live browser pane** ("🖥 Browser" in the chat head) streams the agent's headless page beside the conversation, with the URL and the last action. It also shows the board's own check when a card reaches review.

**Verified, not assumed.** A real Laravel 13 app with a Vite-built page and a queued job, in a fresh board worktree:
- The recipe set up `.env`, `composer install`, `npm install` and SQLite plus `migrate`, then started Vite, the queue worker and artisan serve. The first start took 61–85s, most of it the installs.
- A job dispatched from the page was processed by the worker, in the worktree; the main checkout was untouched.
- A watcher received frames tagged with each action.
- The board's check opened `/` and `/counter` with 0 errors.
- `git status` in the worktree stayed clean. The first run found the new lockfile, which is why `--no-package-lock` is used.

Then a **real agent** (Claude Code, `autoVerify: require`), asked to fix "+1 adds 2":
- It called `app_start`, which brought up all three processes.
- It fixed `counter.js`, opened `/counter`, clicked +1 and read the count.
- It moved to validating with `verified: {pages: 1, actions: 1, consoleErrors: 0, urls: [/counter]}`.
- The pane showed its steps, and the board's check of `/` and `/counter` passed.

It edited before reproducing rather than after.

**The honest limit.** A page-load check catches crashes, console errors and failed requests, not a wrong number: it passed on the unfixed page too. Behaviour is caught by the agent's own browser testing and by the project's e2e suite, which the board runs at review. So the brief now asks for an e2e test when a suite exists.

## 4d. Fifth round — account usage limits, tracked by the board

Asked for: "agents keep track of the account's session limit and set timers for when to wake up and continue — VS Code based rather than the agent, so it works no matter which company the model is from."

**Why the host.** A limited agent cannot run a turn to decide anything. A prompt telling it to watch its budget is a request, not a mechanism. The host sees every frame from every runtime, so it keeps one reading per ACCOUNT: `<runtime>|<profile>`, the same pair the agent picker uses.

**Signals** (`src/agent/limits.ts`), most specific first:

| Source | What it gives | Notes |
|---|---|---|
| Claude Code `rate_limit_event` | status, the window's reset, and `unifiedWindows` with every window's utilisation | Probed on a real CLI: `five_hour 0.33`, `seven_day 0.44`. `resetsAt` is Unix **seconds**. `unifiedWindows` is not in `sdk.d.ts`. One per turn. |
| Claude Code `api_retry` with status 429 | the CLI is retrying by itself | A warning, never a park. |
| Codex plan meter | `usedPercent` and reset per window | A full window holds the account's new runs. It never parks a turn that finished. |
| Any vendor's failed turn | the error text | Reset time read as an epoch, an ISO time, a duration ("try again in 1 hour 23 minutes", "retry in 32.5s") or a clock time in a named zone ("resets 3pm (Europe/Prague)"). Context-window and "overloaded" errors are **not** limits. |

When no reset time is stated, the board backs off: 15m, doubling, capped at 2h. The time is shown with `~` because it is a guess.

**What happens**:
- **The refused run is parked.** `SessionMeta.parked` records the reset time, the reason, the account, the attempt count and whether to auto-resume. The card says "Resumes 15:02 (in 1h 4m)", with *Resume now* and *Don't resume*. A first turn with no session to resume goes back in the queue instead of becoming a red card.
- **The account's new work is held.** `start()` and `drain()` skip any run whose account is limited. This is per account: a Codex task still starts while Claude is out. The queued card says what it is waiting for.
- **Wake-up.** One timer per account fires at the reset plus 60s. It lifts the limit, drains the queue, and resumes each parked card with a prompt that allows "it was already finished". A resume into the same limit counts as an attempt; after three the board stops resuming by itself. The user's *Resume now* is not bounded.
- **After a restart**, `restoreParked()` rebuilds each account's limit from the sidecar and re-arms its timer. A reset that passed while the editor was closed wakes about five seconds after activation.
- **What you see:** a strip above the board with each account's windows as numbers ("5-hour 97% · 7-day 44%"), turning amber when limited, with the reset time and how many cards resume then. The status bar shows `Usage limit · back 15:02` when nothing else needs you.
- **What the agent sees:** `usage_status`, a read-only, auto-allowed board tool that returns the same reading as sentences.
- **Setting:** `agentsKanban.usageLimits`, read at every decision so a change applies at once:
  - `resume` (default): park, hold, and resume by itself.
  - `pause`: park and hold; nothing resumes until you press Resume.
  - `off`: only show the readings (strip, status bar). Nothing is parked or held, and a refused run ends as the error it was.
- **Subagents.**
  - A `split_task` subtask is its own card, so it is parked, held and resumed on its own, on whichever account its route named. A subtask routed to another account starts while this one is out.
  - Claude Code's own background agents (the `Agent`/`Task` tool) run inside the parent's process and die with it when the limit ends the run. The manager reads the live ones at park time (`AgentRun.backgroundTasks()`) and records them on the park (`stoppedTasks`). The card says they were stopped, and the resume names each one and tells the agent to relaunch the ones it still needs instead of waiting for reports that will never come.
  - A subagent's 429 retry reaches the tracker too. Limit frames are routed before the subagent early-return, the same way money is.

**When things go wrong.**

| What happens | What the board does |
|---|---|
| VS Code closed, laptop shut down, or the extension host crashes while a card is parked | The park is in the sidecar. At the next start `restoreParked()` re-arms the timer, or wakes about 5s after activation if the reset has already passed. |
| The laptop SLEEPS through the reset | `setTimeout` runs on a clock that stops during sleep (Linux `CLOCK_MONOTONIC`, macOS uptime), so the wake would fire late by the length of the sleep. The host's once-a-minute heartbeat calls `checkDue()`, which compares against the **wall** clock, so the resume happens within a minute of the laptop waking. |
| VS Code closes with tasks still QUEUED (held by the limit, or waiting for a slot) | The queue was only in memory, so those prompts vanished without a word. It is now saved to workspace state on every change (`queueStore`). `stopAll()` deliberately does not clear the saved copy, since the restart is exactly the event it is kept for. At the next start `restoreQueue()` puts each task back through `start()`: held if its account is still limited, otherwise queued or started. The card says "Kept in the queue across a VS Code restart". Images and the provider's environment (which carries keys) are not saved. The image count is, and the card says to attach them again. The backend is re-resolved from its profile id. |
| The board's resume fails because the machine is OFFLINE (woke without Wi-Fi or VPN) | The text is recognised (`isOfflineError`, checked against what a real CLI printed: `…(ECONNREFUSED)`, `…(ERR_PROXY_TUNNEL)`). The card is parked again with a retry in 5 minutes. This counts as an attempt, so a machine that stays offline stops being tried after three. It applies only to a run the board resumed by itself; the same error on a run you started is shown as an error. The strip says "could not be reached — trying again", not "at its usage limit". |

Checked on a real CLI: a run pointed at a dead port reached the manager as `API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)`, and `isOfflineError` recognised it.

Not handled: two VS Code windows open on the SAME folder would both hold the parked cards, and both would resume them.

**Tests.** `limit-resume.test.ts` also covers `pause`, `off`, a run with two background agents whose names reach the resume message, an offline resume, a wall-clock wake with the timer asleep, and a queue that survives `stopAll()` and is restored held, then started. Each gate goes red when the code it guards is broken. `limits.test.ts` is pure parsing, run on the real probed frame, and passes in two time zones. `limit-resume.test.ts` drives the real manager and a real git repo through park → hold → another account unaffected → first turn re-queued → wake → resume → attempt bound → setting off → restart re-arm. Breaking `park()` or the wake timer turns it red, and so does removing the parked view from `webview.test.mjs`.

**Verified live, for the part that can be.** A real Claude Code 2.1.283 turn went through the real `AgentManager`. One `rate_limit_event` reached the tracker as `claude|` with "five_hour 40%, seven_day 45%" and both reset times, and `usage_status` answered "Your account (claude|): available. 5-hour 40% used, resets 16:20; 7-day 45% used, resets 20:00."

A second real run launched one background agent ("Sleep twenty seconds") and ended its turn. While the agent was still running, `backgroundTasks()` returned `["Sleep twenty seconds"]`, which is what a park would record and the resume would name. Each of its two turns delivered its own `rate_limit_event` (5-hour 41% → 42%).

**Not verified live.** A real subscription limit was not hit during this work, so the `rejected` path has been tested on the recorded shape, not on a live refusal. The first real one will show whether Claude Code reports it as a result error, as a synthetic answer (`LIMIT_ANSWER`), or both. All three are handled.

## 4e. Sixth round — what measurably raises acceptance and cuts bugs, and the checks built from it

Asked for: "research-based features that really prove the acceptance rate of code and fewer bugs — proper testing". arXiv could not be fetched from this environment, so the figures below come from search excerpts and abstracts.

**What the research says** (September 2026):

| Finding | Source |
|---|---|
| Agent-written tests for their own fix barely help. Claude Opus 4.5 wrote a test in ~83% of tasks and resolved 2.6 points more than GPT-5.2, which almost never did (74.4% vs 71.8%). Encouraging or suppressing tests left 83.2% of outcomes unchanged. | [Rethinking the Value of Agent-Generated Tests](https://arxiv.org/abs/2602.07900) |
| When one trajectory writes both the patch and the test, their errors agree and create false confidence. Fixed, independently written tests are what help. | [ExecCritic](https://arxiv.org/abs/2609.09133) |
| Refining a patch until it passes its test raises overfitting: 14 of 22 newly-passing patches failed hidden tests. | [Investigating Test Overfitting on SWE-bench](https://arxiv.org/abs/2511.16858) |
| Reusing the project's EXISTING regression tests: +8.0–12.9% relative resolution across Agentless, SWE-agent and Trae. | [Can Old Tests Do New Tricks](https://arxiv.org/abs/2510.18270) (FSE 2026) |
| On agentic PRs, each failed CI check cuts merge odds by ~15%. Unmerged PRs are larger and touch more files. | [Why Are Agentic PRs Merged or Rejected](https://arxiv.org/abs/2605.22534), [Where Do AI Coding Agents Fail](https://arxiv.org/abs/2601.15195) |
| Feeding static-analysis results back to the model: security issues >40% → 13%, reliability warnings >50% → 11%. | [Static Analysis as a Feedback Loop](https://arxiv.org/abs/2508.14419) |
| A reproduction test proven to fail before the fix and pass after: +8.0–8.9 points on SWE-bench Pro. | [SWE-Doctor](https://arxiv.org/html/2607.00990), [SWT-Bench](https://arxiv.org/abs/2406.12952) |
| Mutation-guided tests at Meta: engineers accepted 73%. | [Mutation-Guided LLM-based Test Generation at Meta](https://arxiv.org/abs/2501.12862) (FSE 2025) |
| The dominant failure is a confident, plausible and wrong patch. Given an already-fixed bug, most models edit it anyway (action bias). | [Confident and Wrong](https://arxiv.org/abs/2603.25764) |
| Passing tests and an LLM reviewer both missed patches that kept or introduced vulnerabilities. | [When Passing Tests Hides Vulnerabilities](https://arxiv.org/abs/2609.10548) |

**The conclusion that shaped the build:** the board should not ask the agent for more tests. It should check the work itself, with execution the agent does not steer, and prove whether the agent's tests test anything.

**Built** (`src/run/quality.ts`, setting `agentsKanban.qualityGate`):
1. **The project's own checks.** Lint, typecheck, and the tests related to the change, found by name. The whole suite runs when the related tests cannot be found. A failing test is re-run once; a pass then is marked *flaky*, not failed. A failure is re-run on the base branch. It is marked *pre-existing* only if the base also fails **and** no new failure line names a file the change touched. The exit code alone blamed main for the agent's bug, and the test caught that.
2. **Proof.** Each new or edited test file runs on the base branch with only the tests copied in; it must fail there and pass on the change. A test that passes without the change is named: "it does not test what changed".
3. **Mutation probe.** The changed lines are deliberately broken one at a time, up to 8, spread across lines: `>`→`>=`, `&&`→`||`, `true`→`false`, `===`→`!==`, and so on. Each break runs against the tests that cover that file. A break nobody catches is named by file, line and edit; it is the next test to write.
4. **Diff size.** Changes over 400 lines or 15 files are flagged.
5. **Where it runs.**
   - Agents get `run_checks` (auto-allowed) to iterate before handing back.
   - At review the board runs the full check in the background and puts it on the test plan: one row per check with numbers, the proof, the mutation score and survivors, plus **Send findings to agent** and **Check again**.
   - `require` refuses the move into review while a lint, typecheck or test failure caused by the change remains. That is the fast half only; the proof and probe are evidence, never a bar, because a number an agent is refused on becomes a number it games.
6. **The brief**, one line per finding: reproduce first and watch the test fail; if nothing is broken, change nothing; keep the diff small; run `run_checks`; never weaken, skip or special-case a test.

**Everything runs in sandboxes.** The base branch and the mutants run in throwaway `git worktree`s under the OS temp directory, with `node_modules`/`vendor`/`.venv` symlinked in. The agent's worktree and the user's checkout are never touched, and the test checks both.

**Verified with a real agent** (Claude Sonnet 4.6, `qualityGate: require`, a boundary bug: "an order of exactly 50.00 is charged shipping"):
- It said "I'll write the failing test first", saw it fail, fixed `>` → `>=`, and called `run_checks` on its own.
- The gate let it into review with the report on the plan.
- The board's full check: tests ✓, the new test **proven** (fails on main, passes on the change), mutants 1/1 caught (the boundary test catches `>=`→`>`).
- 3-line diff, 63 seconds, $0.30.
- The first attempt stalled on an unanswered Bash permission prompt. Even then the board reported the half-done state correctly: the new test fails without the change, but also fails with it.

**Not built yet, and next by the same evidence:**
- A reviewer on a *different* model (Phase 8), with the caveat that LLM reviewers missed security flaws.
- A security scanner (Semgrep/Bandit) as a fourth check.
- PR/CI feedback (Phase 9).

## 4f. Seventh round — the agent's browser, faster and correct

Asked for: "the harness able to use the browser faster or better, especially when it is just local". I measured the tools before changing them (a benchmark driving the real `BrowserPool` through open → look → fill → fill → click → verify, against a local page with an 80ms API call and a CSS transition).

**The measurement found a correctness bug first.** After a click whose handler fetched, the tool returned in 61ms, before the response arrived at about 90ms. So the agent saw the page as it was *before* its own click. The `networkidle` wait after each action was a no-op: a page that reached network-idle at load stays there. An agent that clicks "Add" and sees no item either clicks again (a duplicate) or reports a bug that is not there.

**Built** (`src/agent/browser.ts`, `src/agent/harness.ts`):
- **Settle.** After an action, wait for the requests it set off (requests older than 2.5s, like a long poll or SSE, do not count), then for the DOM to go quiet (a MutationObserver, 100ms of stillness), all capped. Typing, hovering and ticking a box skip the quiet window when nothing is in flight.
- **Refs.** `browser_open` and `browser_snapshot` list the page's controls as `[e12] button "Add"`. `browser_act` accepts `e12`, so there are no guessed selectors. A ref that has gone (the page re-rendered) is reported with the current list.
- **Actions report what changed.** `~` for a line that changed, `+` for one that appeared, `−` for one that disappeared, or "The page did not change". Also where the page is and new controls, so a follow-up `browser_snapshot` is rarely needed.
- **Batches.** `browser_act` takes `steps: [...]`, so a form is one call: fill, fill, click. It stops at the first failure and says which step.
- **`wait` takes `text`.**
- **Warm start.** `app_start` launches Chromium while the app boots.
- **Calmer pages.** `reducedMotion` is set and animations and transitions are cut to 1ms (not 0, so `transitionend` and `animationend` still fire). Analytics and error-reporting beacons are aborted and not reported as the app failing; CDNs are left alone.

**Numbers** (the same local flow, 3 runs each):

| | Tool calls | Browser time | Sees the result of its click |
|---|---|---|---|
| Before | 6 | ~1,250 ms | **no** |
| After, same calls | 6 | ~1,480 ms | yes (the settle costs ~150ms per click) |
| After, refs + batch + warm | **2** | **~710 ms** | yes |

Each tool call saved is a model turn, which costs seconds and tokens, far more than the browser time.

**Real agent** (Sonnet 4.6, "+1 adds 2", the counter updates through a 120ms API call): `app_start`, `browser_open`, then ONE `browser_act` batch of 3 actions. It moved to review with `verified: {pages: 1, actions: 3, consoleErrors: 0}`. 28 seconds, $0.33.

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
