# Agents Kanban — development plan

A kanban board in VS Code that Claude agents run themselves. Each session works
in its own git worktree, and moves its own card across the board.

Modelled on [Nimbalyst](https://github.com/nimbalyst/nimbalyst), keeping the
ideas that are load-bearing and dropping the ones that only exist because
Nimbalyst is an Electron app.

**Companion docs** — read these before re-deriving anything:

- [docs/NIMBALYST.md](docs/NIMBALYST.md) — how Nimbalyst actually works, verified
  against its source. Don't re-clone and re-analyse it.
- [docs/SDK-NOTES.md](docs/SDK-NOTES.md) — the real Agent SDK API. **The published
  docs are wrong in several places.**
- [docs/DECISIONS.md](docs/DECISIONS.md) — why it's built this way, and the bugs
  already fallen into.
- [docs/codemap/README.md](docs/codemap/README.md) — the knowledge base: an
  index plus one file per area, each owning its source files, with exports,
  tests, traps, change recipes and the flows. Read the index, then only the
  areas your task touches — and update them for what you change; the review
  move is refused otherwise.
- [docs/RUNTIMES.md](docs/RUNTIMES.md) and [docs/PROVIDERS.md](docs/PROVIDERS.md)
  — which agent program runs a session, and which backend sits behind Claude
  Code. Two axes, not one.
- [docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) — the research behind
  `split_task`, the dial and per-piece routing, and what of it is still unbuilt.

---

## 1. The one thing to understand first

**A card and a session are the same thing at two zoom levels.** The Kanban view
shows every session grouped by phase; the chat view shows one session's
transcript. Switching modes never changes what exists.

**A session's column *is* its `phase`.** There is no move operation and no
reorder tool. Writing `phase` is the move. Lane order is the order of `columns`
in [`src/board/config.ts`](src/board/config.ts).

**A session's RUNTIME is the agent program running it, and it never changes.**
Claude Code and Codex are siblings — different processes, different protocols,
different logins, different transcript stores. Two cards can be on two agents at
once; one card cannot change agent mid-life, because its history belongs to the
one it started on. See [docs/RUNTIMES.md](docs/RUNTIMES.md).

```
Backlog → Planning → Implementing → Validating → Complete
                                                 └── humanOnly: agents cannot reach this
```

---

## 2. Where state lives, and why

This was the big correction. v1 wrote `.kanban/*.md` into the repository, so
every agent turn produced a git diff. Claude Code already stores sessions; we
read that store instead of duplicating it.

| State | Home | Why there |
|---|---|---|
| Session + transcript | `~/.claude/projects/<encoded-cwd>/*.jsonl` | Claude Code owns it. Shared with the CLI. |
| Title | `renameSession()` | Same field the CLI's `/rename` writes. |
| Phase, tags, archive flag | Extension global storage (`MetaStore`) | Claude Code has no concept of these. Sidecar, mirroring Nimbalyst's `ai_sessions.metadata` JSON column. |
| Worktree ↔ session | Same sidecar | An absolute path means nothing on another machine. |
| Model / effort / thinking / agent / backend / orchestration level | Same sidecar, recorded at launch (`durablePatch`) | Per session. The settings hold only what the NEXT new session gets; the composer describes the selected card, never the default. |
| Scheduled runs | `workspaceState` (`schedules`) | Per workspace; fire only while the window is open. |
| Provider credentials | `SecretStorage` | Never in settings, which sync and get committed. |
| Model catalogues | `globalState`, per provider | Discovery spawns a CLI; the cache keeps it off the render path. |

**Nothing is written to your repository.** The sidecar lives under the
extension's global storage directory, keyed by workspace root.

The payoff is that the board is a view over real work: a session started in the
terminal appears here, and a session started here resumes with `claude --resume`.

---

## 3. Architecture

```
src/
  extension.ts          VS Code surface: activation, commands, the host behind
                        every board message, getState(), schedule firing, roll-ups
  board-mcp.ts          Its own bundle (dist/board-mcp.js). Spawned BY Codex;
                        forwards to board-bridge and holds no board logic
  board/
    config.ts           Columns, phases, the humanOnly rule, AgentState, stalled
    panel.ts            Editor WebviewPanel + side bar control view, UiState,
                        the webview message switch, focus layout
    settings.ts         The settings TAB: agents, backends, logins, schedules
    coalesce.ts         The repaint rate limiter, scaled to what a repaint cost
    questions.ts        AskUserQuestion -> a renderable picker
    codemap.ts          Knowledge files move with the code: the gate on the
                        review move, over docs/codemap/*.md frontmatter
    decomposition.ts    The orchestration dial, the gates on a split, the record
    subtasks.ts         Parent <-> subtask thread, derived on every render
    schedules.ts        Scheduled runs: next fire time, the catch-up rule
  sessions/
    store.ts            Every runtime's sessions + our metadata, merged; Entry
    meta.ts             Sidecar metadata; per-session model/effort/thinking/
                        agent/backend; the running mark; recovery across installs
    usage.ts            Context fill and spend arithmetic; the rate/window tables
    codex-store.ts      Codex's own rollout transcripts, read back off disk
    subagents.ts        Background agents read off disk, outcomes from the parent
    search.ts           Search across every rendered transcript row
    checkpoints.ts      "Try again from here": file-history snapshots restored
    commands.ts         Slash-command discovery (.claude/commands)
  agent/
    runtime.ts          WHAT AN AGENT PROGRAM IS: the contract + the registry
    runtimes/
      claude.ts         Claude Code, behind the contract
      codex.ts          Codex, over `codex app-server` JSON-RPC
      index.ts          The one file that names them all
    jsonrpc.ts          Newline-delimited JSON-RPC 2.0 over a child's stdio
    board-bridge.ts     The board's tools over a socket, for a runtime that
                        spawns MCP servers rather than taking one in-process
    sdk.ts              Lazy ESM loader; resolves the `claude` binary
    connect.ts          Ask the CLI a question without starting a turn
    providers.ts        WHICH BACKEND: a profile -> an environment patch
    endpoint.ts         What a custom endpoint says it serves, asked of the
                        endpoint — ids, windows and prices. Never the CLI's list
    models.ts           Which models the picker offers, and where the list came
                        from (endpoint -> CLI -> built-in)
    probe.ts            Is this backend there, and will it have us?
    status.ts           Every runtime's install + login state, for settings
    tools.ts            The board tools the agent uses on its own card
    routing.ts          A subtask's route: agent, model, effort, four refusals
    spawn-policy.ts     Which models a split may spawn on, per backend
    images.ts           A pasted image -> an image content block
    dictation.ts        Local dictation: ffmpeg -> whisper-cli
    session.ts          One query() run: streaming, permissions, usage,
                        interrupt, background tasks
    manager.ts          N concurrent agents, one worktree each; queue, split
  git/
    lock.ts             Per-repo mutex
    worktree.ts         Worktree lifecycle, review, commit and merge back
  run/
    recipe.ts           What starts the app in a worktree, and on which port
  remote/               The relay's extension side: what leaves (redacted),
                        when, and prompts coming back
media/                  Board UI (vanilla JS, native HTML5 drag and drop), the
                        settings page, theme.css for outside the editor
server/                 The headless board: the built extension on a box
remote/                 The relay site (Netlify / Workers / Node), a lift-out
scripts/                preflight, the test runner, run-bin, with-node.sh
test/
  harness.mjs           A fake VS Code: activates the built bundle and talks to it
  dom.mjs               A DOM small enough to run media/board.js in
  package.test.mjs      Asserts the .vsix carries the externals it needs
  screenshots.mjs       Renders the real view in Chromium -> docs/screenshots
smoke.mjs               The launch gate
```

Per-file detail — exports, the test that covers each file, the trap its header
states, change recipes and the flows — is in [docs/codemap/](docs/codemap/README.md),
one file per area.

Everything outside `extension.ts`, `board/panel.ts` and `board/settings.ts` is
free of `vscode` imports and unit-tested in plain Node.

### Three non-obvious constraints

1. **The Agent SDK is ESM-only** (`"type": "module"`, single `sdk.mjs`) and VS Code
   extensions are CommonJS. It is loaded with a dynamic `import()` and kept out
   of the bundle, because it resolves a per-platform native `claude` binary that
   bundling would break. esbuild preserves `import()` verbatim for externals in
   CJS output — verified.
2. **`zod` must be external, not bundled.** It is a peer dependency of the SDK;
   two instances disagree during schema conversion.
3. **`prompt` must be an `AsyncIterable`, never a string.** A bare string makes
   the SDK close the child's stdin after the first result, which breaks
   `interrupt()`, permission round-trips and follow-up messages.

We do **not** ship the SDK's ~190MB native binary. `resolveClaudeExecutable()`
finds the installed CLI (setting → PATH → usual locations), keeping the `.vsix`
at ~5MB and letting the CLI update on its own schedule.

---

## 4. The message stream

`query()` yields one `SDKMessage` union. These are the members worth rendering;
the rest can be ignored safely.

| Message | Carries | Render as |
|---|---|---|
| `system` / `init` | session id, model, tools, MCP servers | Nothing visible. Capture `session_id` — the only handle for resume. |
| `stream_event` | Raw streaming events (`content_block_delta`) | Live typing. Needs `includePartialMessages: true`. |
| `assistant` | `content[]` (text, thinking, tool_use) + per-step `usage` | Settled text, thinking disclosure, tool row. **Only correct source of context fill.** |
| `user` | `tool_result` blocks, matched by `tool_use_id` | Resolves the pending tool row to ✓ / ✕. Never shown as a user message. |
| `system` / `compact_boundary` | `compact_metadata.pre_tokens` | A divider — and reset the context meter, or it sticks at the pre-compaction figure. |
| `result` | `result`, `duration_ms`, `total_cost_usd`, `modelUsage` | End-of-turn footer. `modelUsage[m].contextWindow` is the meter's denominator. |

Full type-level detail, including where the published docs disagree with the
shipped `.d.ts`, is in [docs/SDK-NOTES.md](docs/SDK-NOTES.md).

### The context-meter trap

Two usage figures that look alike. Getting this wrong displays 1,500%.

```ts
// RIGHT — per-step, from an `assistant` chunk. This is context fill.
const u = msg.message.usage
const fill = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

// WRONG — result.usage is CUMULATIVE across every step of the session.
// A 200k-window session can report 3.1M input tokens.
```

Track `lastContextTokens` separately and never let the result chunk overwrite
it. Emit on every `assistant` chunk, not just at turn end, or a ten-minute
agentic turn shows a frozen needle. Nimbalyst shipped both of these as bug fixes.

---

## 5. Composer controls

All three are plain `query()` options with the same resolution order:
**per-session → workspace default → unset.**

- **Effort** — `low · medium · high · xhigh · max`. Leaving it *unset* matters:
  skip that and the picker shows "Max" while the session quietly runs at the
  CLI's `high`.
- **Thinking** — "Extended: On" means **omit the option entirely** so the model
  runs adaptive thinking. Only "Off" sends `{ type: 'disabled' }`, and some
  models reject it.
- **Model** — per session, so two agents can run at different models. The window
  in the picker's label is derived from `MODEL_WINDOWS` in
  [`src/sessions/usage.ts`](src/sessions/usage.ts), the same number the meter
  measures against, so the two cannot disagree.

`resolveEffort()` / `resolveThinking()` in [`src/sessions/meta.ts`](src/sessions/meta.ts)
encode this; both are unit-tested.

### The two readouts on the right of the bar

`223k/1M (22%) · $8.11` — how full the context is, and what the session has
spent. Neither is a property of a running process:

| | Live run | Nothing running |
|---|---|---|
| Context fill | the `usage` event, per response | last main-thread response in the transcript |
| Window | `modelUsage[].contextWindow` from the run | the sidecar's remembered window, else `MODEL_WINDOWS` |
| Spend | priced per response as it arrives | every response in the transcript, priced |

Spend is arithmetic over published rates — input, output, cache writes by TTL,
cache reads — not a figure the service hands us. Two consequences the UI owns:
each turn's estimate is compared against the CLI's `total_cost_usd` when the
result lands and a gap over 20% is logged against `MODEL_RATES`; and a model with
no rate makes the total a floor, shown as `≥ $1.23`. Deduplicating by
`message.id` is not optional — see [docs/DECISIONS.md](docs/DECISIONS.md).

---

## 6. The approval boundary

Enforced **twice**, and both halves matter.

The policy lives in the tool *description* — where Nimbalyst puts it, because
models read tool blurbs far more reliably than a distant system prompt:

> You cannot move to "complete" — that column is the user's approval step.

And the boundary is real in code. `isHumanOnly()` is checked in `set_phase`
before any write. **Never rely on prose for a boundary that matters.**

You can still drag a card to Complete. The guard constrains the agent, not you.

---

## 7. Worktrees

`git worktree add -b task/<id>-<slug> .agentskanban/worktrees/<name> <base>`

Worktrees live inside the repository, under the one directory this extension
owns, and `.gitignore` is given `/.agentskanban/` before the first one is
created — and `.git/info/exclude` too, the copy that cannot be discarded, moved
off by a branch switch, or itself dirty the tree. The ignore rule is
load-bearing rather than tidy: `merge()` refuses on a dirty main worktree, so an
unignored scratch directory would block every merge from the first session
onwards. `agentsKanban.worktreeRoot` still moves it, and pointing it outside the
repository writes nothing to your `.gitignore`.

The session's `cwd` is that worktree — that is what makes parallel agents safe.
Destructive git operations are serialised per repository, which matters more
here than in a standalone app because VS Code's built-in Git extension issues
commands against the same repo.

**No seeding**, matching Nimbalyst: no `.env` copy, no `node_modules` link.
Copying secrets into another checkout should be a decision, not a default.
`onCreate` exists to opt in.

### Getting the work back out

A worktree that nobody can review is a dead end, so the board carries the whole
return path: **see it → commit it → merge it**.

The important detail is that **the agent is told to stop at the review column
without committing**. So the common state of a finished session is a worktree
full of *uncommitted* work — and merging a branch in that state merges nothing,
silently. The review panel therefore separates committed from uncommitted work
and disables Merge until there is something to merge, rather than appearing to
succeed.

The merge itself then **stops before the commit**. `--no-ff --no-commit`: the
work lands staged in your working tree, git stays in its merging state, and
nothing enters your history until you say so. Reviewing an agent's changes after
they are already committed is not a review — the only way back is a revert, on a
branch someone may have pulled.

```
agent stops at "validating"
      ↓
Changes panel     src/auth.ts  M            (click → native diff vs. base)
                  src/new.ts   ?  uncommitted
      ↓  Commit 2 files…
      ↓  Merge into main…      ← modal: lands UNCOMMITTED, nothing written yet
      ↓
◆ Merged task/S1 into main, not committed
  2 files staged on main. Read them, then commit the merge or abort it.
  src/auth.ts                             (click → diff vs. main's HEAD)
  src/new.ts
  [Commit merge]  [Abort merge]
      ↓
conflict?  →  same banner, in red: resolve in the editor, or Abort merge
```

`WorktreeService.merge()` refuses rather than improvises. A dirty main worktree,
a merge already waiting to be reviewed, a branch with no commits, or being on
the wrong branch each come back as a *described* failure, not an exception and
not a silent no-op. Conflicts are left in progress on purpose: aborting
automatically would throw the resolution away.

`pendingMerge()` reads `MERGE_HEAD` straight from git rather than remembering a
flag, so the banner survives a window reload and also sees a merge you started
yourself in a terminal. It is repo-level state and disables *every* card's Merge
button, which is why it renders as a banner above the review panel rather than
inside one card's. See [docs/DECISIONS.md](docs/DECISIONS.md).

All of it is serialised on the per-repo lock, because VS Code's own Git
extension issues commands against the same repository, and a merge is the least
forgiving moment for two of them to overlap.

---
## 8. Current state

`npm run verify` — typecheck, build, 55 test files, launch gates.
`npm run verify:package` — packages a `.vsix` and checks what is inside it.

Every task goes through `scripts/with-node.sh`, which finds a Node 22.6+ before
running npm. VS Code runs tasks in a non-interactive shell and nvm/fnm/asdf live
in `~/.bashrc`, which returns early for exactly that kind of shell — so without
it, whether F5 works depends on whether VS Code was started from a terminal or
from the desktop.

Working:

- **One control height, everywhere.** Every button and chip is 24px (32px on the
  composer's input row, 20px inside a card), from tokens in `board.css`; a glyph
  sits in a fixed slot so an emoji cannot resize its chip. Measured by
  `layout.test.mjs`, which fails if two controls on the bar differ
- **The headless board is the editor's dark board.** `media/theme.css` carries
  the Dark Modern palette for every `--vscode-*` variable the stylesheets use;
  `theme.test.mjs` keeps it complete. Inert in the editor, where VS Code sets
  the variables inline
- **A run waits for its background agents.** A turn that ends with agents
  still working, or with one's notification queued, leaves the process alive in
  a `waiting` state — the card names the agent and shows the age — and the CLI
  runs the follow-up turn that brings the findings back. Ending the run on the
  first `result` killed that turn every time
- Both views; sessions started from chat land on the board
- Agents run in their own worktrees and move their own cards
- Transcripts read from Claude Code, surviving reloads
- Streaming output, thinking disclosures, tool rows resolving ✓/✕
- **The answer reads as an answer.** Assistant text renders as markdown —
  headings, lists, tables, code blocks with a language label and Copy — built
  as DOM nodes, never `innerHTML`. Prompts stay exactly as typed
- **Scroll positions survive repaints.** Columns, the rail and the transcript
  keep their offset across every state message; the transcript still follows
  the tail when you are at the bottom
- Model / effort / thinking pickers
- **Context fill and spend, and neither depends on a process being alive.** Both
  are derived from Claude Code's own transcript, so they are still there after a
  restart and cover turns started in a terminal; the live run computes them the
  same way, climbing per response rather than jumping at the end of a turn. See
  [`src/sessions/usage.ts`](src/sessions/usage.ts)
- **Images in the composer.** Paste a screenshot, drop a file in, or pick one;
  it is downscaled in the webview and sent inside the message as an image
  content block, so nothing is written to disk. See
  [`src/agent/images.ts`](src/agent/images.ts)
- **One button to run a session's app.** Detects the project's own per-worktree
  launcher, provisions it if it has never been provisioned, waits for the port
  to actually answer, then opens the browser on it. See
  [`src/run/recipe.ts`](src/run/recipe.ts)
- **Two agent programs, on one board, at once.** Claude Code and Codex, each
  session in its own worktree on its own model, picked from the 🤖 control on the
  composer bar. Codex is driven natively over `codex app-server` — the same
  JSON-RPC interface its own VS Code extension uses — with **no proxy and
  nothing to configure**: if `codex login` has been run on this machine,
  sessions work. That is not a convenience, it is the only thing that can work,
  because a ChatGPT subscription cannot be spent through a translation proxy at
  all. A Codex card moves itself, writes a test plan and splits like any other,
  through the same board tools served over a socket. See
  [docs/RUNTIMES.md](docs/RUNTIMES.md)
- **A meter that does not pretend to be dollars.** A subscription session is
  billed nothing per request, so its readout is the rate-limit window it is
  actually spending — `13% of 5h · Plus` — rather than `$0.00`. `Meter` is a
  union for this reason, and `unknown` renders as `—`
- **A settings page, in an editor tab.** Agents, backends and logins, with
  `retainContextWhenHidden`, because the quick pick it replaced closed on a
  misclick and took the half-typed gateway URL with it. Whether each agent is
  installed and signed in comes from ASKING it, and "could not tell" is never
  shown as "signed out". A custom endpoint's own catalogue is browsable there,
  with a tick per model deciding what the composer offers
- **A custom endpoint's models come from the endpoint.**
  `GET <baseUrl>/v1/models`, ranked above `Query.supportedModels()` — which
  answers for Claude Code however `ANTHROPIC_BASE_URL` is pointed, and had been
  saved onto a DeepSeek profile as though DeepSeek served `sonnet` and `haiku`.
  The context window and per-token price it publishes reach the picker AND both
  spend meters, so a session on a router shows a real figure instead of
  `≥ $0.00`. See [`src/agent/endpoint.ts`](src/agent/endpoint.ts)
- **The headless board — Remote Control that runs the board itself.**
  `npm run remote` serves the built extension on a box, activated against a
  `vscode` stub (the `test/harness.mjs` technique) with the browser as its
  webview: the real `media/board.js` page, `acquireVsCodeApi` supplied by
  `server/bridge.js` — `postMessage` becomes a POST, host frames arrive over
  SSE, dialogs become overlays — and a pairing code (accepted on exactly two
  routes, sha-256 compared `timingSafeEqual`) buys a short-lived token by
  `POST /api/session`; everything else is gated by the token, which expires in
  five minutes, dies on `POST /api/revoke` (which also ends every open event
  stream) and on restart, and is re-exchanged from the stored code once per
  page life — a second death draws the gate with an explanation.
  Every webview message the extension understands works from a browser, so a
  VPS or a mini PC holding the repo is a complete board reachable from
  anywhere. The gate test (`src/remote/__tests__/headless.test.mjs`) spawns
  the server against a throwaway repo and drives the whole flow through a real
  Chromium: 401s without the code, state over the stream, the gate, the
  composer, the settings tab, the first-death recovery and the second-death
  dead end, zero console errors. The relay in `remote/`
  remains as the smaller mirror mode. See [server/README.md](server/README.md)
- Archive (soft, reversible) and permanent delete
- Permission prompts inline on the card
- Multiple tags per session
- **Review and merge**: changed files per session, native diff against base,
  commit the worktree, merge back, worktree cleanup at Complete
- **The board takes the editor area**, and lives only there. The bottom panel
  and the right side bar stand aside while it is in front and return when you
  leave. The LEFT side bar is never closed, resized or switched — it is how you
  get back, and `applyBoardFocus` issues no command that touches it. The icon
  click unavoidably evicts it (VS Code shows the clicked container and offers no
  way to decline), so it is handed straight back to `agentsKanban.sideBarHome`.
  The view there is a *control* (open/close, agent counts, a session list),
  because five columns cannot be read in 300px. The icon is the toggle; also
  `Ctrl+Alt+K`, the status bar and the palette (`agentsKanban.focusMode`)
- **A test plan on every card that reaches review.** `set_phase` refuses a review
  column without `howToTest`, and the links render as buttons: files open from
  the worktree, commands open a terminal in it, URLs open in the browser
- **A notification when an agent is ready for you to test** — the move into a
  review column is the agent saying so, and it offers Review changes / Open
  worktree rather than a badge you have to be watching
- **You can see whether it is actually running.** A spinner at the foot of the
  transcript, the tool it is on, and the **age of the last frame the CLI sent**,
  ticking every second. The age is the load-bearing half: a spinner spins over a
  wedged process too, so the indicator shows the number it is derived from
  rather than an interpretation of it. It turns amber past a minute and
  disappears entirely when the turn ends
- **Subagents are visible.** A `Task` carries its subagent's whole transcript,
  nested under it and collapsed (`Subagent · 7 steps · 4 tool calls`), and the
  status line reads `Task → Grep…` while it runs. This needs BOTH halves:
  `forwardSubagentText: true` in the query options (the SDK forwards only
  tool_use blocks from subagents by default) and a `parent_tool_use_id` check in
  `AgentSession.handle()` — without the second, a subagent's working notes get
  appended to the main thread's summary as if the agent had written them
- **Tool rows say what the tool is doing**: MCP names are unwrapped with their
  server (`Atlassian · getJiraIssue  ACME-184`), arguments are shown even for keys
  we have not listed, and absolute paths lose the worktree prefix that is
  identical on every row
- **And how long it took.** A call still outstanding ticks up on its own row; a
  finished one keeps its duration (`Atlassian · getJiraIssue  ACME-184   4m 32s`),
  shown only past two seconds so a page of instant `Read`s stays clean. The age
  of the last frame answers "is it still moving"; this answers "which call is
  spending the time", which is the question a turn that opens with one slow MCP
  round trip actually raises. A row rehydrated from disk gets no timer: the
  SDK's session API exposes no message timestamps, and an invented number is
  the failure mode this whole indicator exists to avoid
- **A task that is really two tasks splits itself.** `split_task` lets an agent
  turn one brief into 2–4 subtasks, each a real session with its own worktree,
  branch and card, running at once. Each subtask forks from what the PARENT
  forked from, never from the parent's branch — which is sound because the split
  is refused once the parent's worktree is dirty or has commits, and which is
  what keeps a subtask an ORDINARY task branch: it diffs, merges and cleans up
  through the existing paths, one at a time, without dragging its siblings in.
  The boundaries are code, not prose: at most four, one level deep, once per
  session. It is the only board tool that is not auto-allowed — starting other
  agents is worth a click
- **A subtask can run on a different agent, backend and model from its parent.**
  One objective session on Fable 5.1 can put one piece on Opus 5, one on DeepSeek
  through a gateway and one on Codex against a ChatGPT subscription — each a real
  session with its own worktree, card and meter. `split_task` takes `agent`,
  `model` and `effort` per piece; the host validates them against THAT agent's
  catalogue and refuses with one of four rules, each naming its own fix, rather
  than substituting. A piece that names nothing inherits the parent's whole
  agent — runtime AND backend, which is the half that used to be dropped
- **Subtasks say where they came from, and when the whole thing is testable.**
  The child names its parent; the parent lists its subtasks with their phases
  and a `1/2 ready` count. Subtasks stay real cards in their own columns, so you
  test each as it lands — and when the last one reaches review the parent moves
  there too and says "all N subtasks are ready", which is the news, rather than
  a second toast about one card. A subtask queued behind `maxConcurrentAgents`
  gets a card too, so the count is never short in exactly the place the count
  is the point
- **An orchestration dial per card** — `minimal · balanced · maximum`, chosen
  on the composer bar beside the model — biases how readily a session splits
  without ever dictating a number. The gate is host-side (`confirmSplit`), a
  refused split is recorded on the card rather than reaching only the model,
  and `SessionMeta.fanout` keeps the roll-up honest. See
  [`src/board/decomposition.ts`](src/board/decomposition.ts)
- **Scheduled runs.** `schedule_create` / `schedule_list` / `schedule_run` /
  `schedule_delete` board tools, and a section on the settings page: a time on
  set weekdays starts a NEW session with a fixed brief, in its own worktree, on
  the board like any other card. A schedule fires only while the window is open;
  a moment that passed while it was closed is caught up once at the next check,
  never once per missed day. Creating, deleting or running one asks first. See
  [`src/board/schedules.ts`](src/board/schedules.ts)
- **Search across transcripts** — every rendered row kind, prompts, answers,
  thinking, tool rows and nested subagent transcripts included, from the board's
  own search screen. See [`src/sessions/search.ts`](src/sessions/search.ts)
- **"Try again from here."** Claude Code's own file-history snapshots are read
  out of the raw session file and restored over the worktree, and the session
  is forked at that message. See
  [`src/sessions/checkpoints.ts`](src/sessions/checkpoints.ts)
- **Local dictation** on the composer's microphone — ffmpeg captures,
  `whisper-cli` transcribes, nothing leaves the machine — or the editor's
  built-in speech when it is installed. See
  [`src/agent/dictation.ts`](src/agent/dictation.ts)
- **A card says when its run is not running, and which way.** Interrupted (the
  host died mid-turn — "Interrupted 9m ago"), stalled (a started column with no
  live agent — the move is offered, never made), failed, waiting on background
  agents, or queued behind the concurrency limit. Each is a different readout,
  because a card that looks identical in all five states cannot say "bad"
- **Real questions.** `AskUserQuestion` renders as the question with its
  options — pick one, tick several, or type — and the answer goes back where
  the tool reads it, instead of an Allow/Deny pair with the question nowhere on
  screen. See [`src/board/questions.ts`](src/board/questions.ts)
- **Old foreign sessions are hidden by age, and the hidden count is shown and
  clickable.** Codex keys its store by date, not by directory, so opening a repo
  you used months ago would otherwise adopt every rollout on the machine.
  Anything this board ever touched is always shown, however old; search always
  finds everything (`hideSessionsOlderThanDays`)
- **Pin a session** to the top of its column, from the card menu
- **Knowledge files move with the code.** `docs/codemap/` is the knowledge
  base — an index plus one file per area, each owning source files through the
  `paths:` in its frontmatter — and `set_phase` into review is refused, naming
  the files, while an area whose source changed has an untouched file. The
  check runs host-side over the worktree's diff; a repository without a codemap
  is asked for nothing. See [docs/codemap/README.md](docs/codemap/README.md)
- **Repaints are bounded at 10Hz.** `refreshAll()` runs on every event an agent
  produces, streamed tokens included, and it used to do a full `getState()` per
  event, per surface — 105 seconds of extension-host work for every 60 seconds
  of streaming on a 20-session board. That is also a *slower agent*: the CLI's
  stdout is drained on the same event loop. `board/coalesce.ts` keeps the
  leading edge and the trailing one and never overlaps two runs; one state is
  posted to both surfaces; a run's on-disk history is captured once at launch
  rather than re-parsed per token; the session index and any on-demand
  transcript are cached for a second while the board metadata merged into them
  stays fresh

### How testing works, and why it looks like this

Every unit test passed while the extension did not launch. The bugs were never
inside a module — they were in the **seams**, and nothing crossed them. So the
gates are arranged by seam, not by file:

| Gate | Seam it stands over |
|---|---|
| `smoke.mjs` §manifest | `package.json` ↔ the code. A command declared but never registered *is* "command not found". |
| `smoke.mjs` §live wiring | webview → host. Posting `ready` must return a real `UiState`. `getState()` was never executed by any test, and a throw there is the blank panel. |
| `smoke.mjs` §view contract | host → view. The **real** state renders through the **real** `board.js`. Both sides passed against fixtures while disagreeing about the shape. |
| `test/package.test.mjs` | repo ↔ `.vsix`. The SDK and zod are externals; a package built without them installs fine and dies on the first dynamic import. |

Two rules that keep them honest:

- **Mutation-test a new gate before trusting it.** A manifest typo and a renamed
  field in `board.js` were each introduced deliberately, and each failed the
  suite. A gate that has never failed has not been shown to work.
- **A new `vscode` API must be added to `test/harness.mjs`.** That is the feature,
  not a chore: `registerTextDocumentContentProvider` was missing from the stub and
  the smoke test reported it as an activation crash — which is exactly what it
  would have been in the real editor.

**The board has now been driven end-to-end by real agents**, which is what found
the bugs in [DECISIONS.md](docs/DECISIONS.md) that no green suite had. Verified
live: two agents in parallel keeping to their own worktrees and both landing in
`validating`; one agent working, moving its own card, writing its test plan,
taking a follow-up, committing and merging back; and the permission round trip
in both directions — a denial the agent recovers from, then an approval.

`npm run screenshots` renders the real view in headless Chromium and fails on a
blank render, so the pictures in [the README](README.md) are also a check.

Notable tests:

- `agent/tools.test.ts` ties the auto-allow list to the tool definitions. A
  hand-written copy drifted once and left agents unable to move their own cards.
- `sessions/store.test.ts` runs against **real** Claude Code session data, not a mock
- `git/worktree.test.ts` runs against **real** git repositories — it is what found
  the porcelain-trimming bug in `changedFiles()`
- `board/webview.test.mjs` runs `media/board.js` in a `vm` against a stub DOM —
  the view layer has no type checking, so a runtime throw there shows up as a
  silently blank panel
- `smoke.mjs` activates the **built bundle** twice, once **with no workspace
  folder**, because an early return there once made every command "not found"

---

## 9. What to build next

Checked against the code on 2026-09-07. Items that had shipped since this list
was first written — scheduled runs, per-session model choice, transcript search,
the orchestration dial, per-piece routing — were removed rather than struck
through; §8 describes them. Each area file in [docs/codemap/](docs/codemap/README.md)
carries its own "Open work" section with the items that land there.

### Runtimes: what is not done

Codex is driven natively and the abstraction is real (`startRun()` has no branch
on runtime identity), but three things are honest gaps rather than decisions:

- **No real Codex run has been made from the board yet.** The protocol path is
  covered against a stand-in app-server — handshake, streaming, tool rows,
  approvals, interrupt, usage, and both known item spellings — and the store
  path against a rollout fixture in Codex's real format. Nothing local can
  prove the live CLI spells its methods the way this adapter does; that is why
  it reads both spellings and reports what it could not read. **Install Codex
  and run one**, as [DECISIONS.md](docs/DECISIONS.md) "the first real agent run"
  did for Claude.
- **Images do not reach a Codex session.** It takes `local_image` by path, and
  this board writes nothing to the user's repository. The composer says so
  rather than dropping them.
- **One app-server per session.** A single shared server could host every thread
  (`thread/start` takes a `cwd`), which would be cheaper; per-session matches the
  existing lifecycle exactly, so it is where this starts.

### Orchestration: what is left after `split_task`

[docs/ORCHESTRATION.md](docs/ORCHESTRATION.md) is the research. Its stage 1 —
the dial, the host-side `confirmSplit` gate, refusals recorded on the card,
`SessionMeta.fanout` — and the routing half of stage 2 are built, and the six
bugs it found in the code are fixed. What remains, in the order it hurts:

- **Nothing owns the objective after a fan-out.** The roll-up moves the parent
  card to review and notifies the USER; nothing pushes a child's result onto the
  parent's prompt queue and nothing re-runs the parent. The automatic wake is
  declined on purpose (a billed turn nobody asked for), but ORCHESTRATION.md §12
  is right that this leaves the question open: at four ready branches, who
  integrates them?
- **Nothing sequences four merges.** `merge()` is per card and runs in the main
  worktree, which holds one merge at a time; the second branch conflicting after
  the first landed has no story beyond the conflict banner.
- **A conflict-fixing agent.** Nimbalyst spawns a fresh session with a
  prescriptive prompt; we surface conflicts in the banner and offer Abort.
- **Stage 2's measurement half** — scope drift checked at merge, `MeterTotal`
  across a parent and its children, a budget. Each is gated on an experiment
  listed in ORCHESTRATION.md §13, and none of those has been run.

### Milestone 5 — resume and durability

- **Permission prompts that survive a window reload.** A pending request lives
  in memory on the `AgentSession` and is denied when the session ends.
- **Fail loudly when a resumed session comes back with a different id** than the
  one we asked for, as Nimbalyst does. The reverse case — two runs sharing an
  id — warns; this one is not detected.

### Smaller, worthwhile

- **Commit cards in the transcript.** `session.ts` emits `committed` and the
  host hears it — to reload the review panel and the Merge button. No `commit`
  entry kind exists and nothing reads the new HEAD, so a commit is not yet a row
  in the transcript.
- **A `Fixes <id>` commit-message watcher** to close a card, as Nimbalyst's
  `CommitTrackerLinker` does. **The `set_phase` description already promises
  this** — "The user marks work complete, or a commit message closes it", in
  `board/config.ts` — and nothing implements it. A prose promise the code does
  not keep is the class of bug this project keeps a rule about: build it, or
  reword the description.
- **Board config from a file**, so columns are customisable. `DEFAULT_BOARD` in
  `board/config.ts` is a constant.
- **Syntax highlighting in code blocks.** Language label and monospace only.
- **Real timestamps on rehydrated transcripts.** `readTranscript` stamps every
  entry with the time it was PARSED; `SessionMessage.timestamp` now exists in
  the SDK and nothing uses it.

### Known limits

- **Sessions are per-directory.** `listSessions({ dir })` is keyed on cwd, and an
  agent's worktree is a different directory — hence `includeWorktrees: true`.
  Without it every agent session vanishes from the board the moment it starts.
- **A run has no session id for its first moment.** Claude Code assigns it at
  `system/init`, so a run starts keyed by a local `runId` and adopts its real id
  moments later. `AgentManager.byKey()` accepts either, board state is keyed by
  `sessionId ?? runId`, and `MetaStore.rename()` carries the entry across when
  the real id arrives — so a card the agent moved during that window is not
  orphaned. Keying on the session id alone left agents unable to move themselves
  at all until it appeared.

  Two consequences that both shipped as bugs, and that anything touching this
  window has to respect:
  - The **card's key changes** when the id arrives. Anything holding a key across
    that moment must follow it — `followKey()` in `manager.ts` — or it silently
    stops matching. `getState()` used to just clear the selection, which sent the
    open chat back to the new-session screen a few seconds into every first turn.
  - The **session file does not exist yet** when the id is announced. Any SDK call
    that resolves a session by id (`renameSession`, `getSessionInfo`) can lose that
    race and report "not found in any project directory". `retryWhileMissing()` in
    `store.ts` waits it out, and only for that one error.
- **The bundled `claude` binary is not an option.** `resolveClaudeExecutable`
  looks at the configured path, PATH, then the usual install locations, and
  stops. It must never reach into `node_modules` — see the postmortem; the short
  version is that the SDK's copy is a Bun executable that SIGBUSes on some Linux
  boxes, and reaching for it means a dev checkout runs a different Claude Code
  from the one the user maintains.

---

## 10. Working on this

**Node 22.6+**, because the tests run through `node --experimental-strip-types`.

```bash
npm run verify         # preflight (installs if needed) → typecheck → build → tests → smoke
npm run verify:package # package a .vsix and check what is inside it
npm run watch          # rebuild on change
npm run install-local  # package and install into VS Code, on any platform
npm run screenshots    # render the real view -> docs/screenshots
npm run remote         # build, then serve the headless board (server/README.md)
```

Every script begins with `scripts/preflight.mjs`. It installs dependencies on a
fresh clone rather than failing with `tsc: not found`, and names the fix when an
install is only partial. npm runs scripts through `sh`, so script logic lives in
`scripts/*.mjs` rather than in shell — a `**` glob in the old test script
covered two directory levels by accident.

Press <kbd>F5</kbd> for an Extension Development Host. It runs `verify` first —
about thirteen seconds once dependencies are installed — because building alone
will launch an extension whose manifest and code disagree. Open a **git
repository**: the board renders without one, but agents cannot run, since each
session needs a worktree.

Two things about a fresh worktree, which is what every agent session works in:
it has no `node_modules` (preflight installs them on the first `npm run`), and
the layout, theme and headless gates need a Chromium that Playwright can find —
they FAIL without one rather than skip, and say so.

Conventions worth keeping:

- Tests run through `node --experimental-strip-types`, so no parameter
  properties in constructors (they emit code, not just types)
- Keep `vscode` imports confined to `extension.ts` and `board/panel.ts`
- Never swallow a promise rejection with a bare `void` — that is how a broken
  `getState()` became a silently blank panel
