# Codebase map — where to look for what

The domain knowledge tree for an agent that has just been spawned into this
repository. It answers three questions: **where is X**, **what must I not
break when I touch it**, and **which test will tell me**. Checked against the
code on 2026-09-07; line numbers are deliberately absent because they drift —
grep the function names instead.

Read it in this order:

1. §1, the checklist — before your first command.
2. §4, the task index — find the rows that match your brief.
3. The **header comment of each file you are about to change.** In this
   codebase the file header IS the documentation: it states what the file owns,
   the trap it exists to avoid, and often the postmortem behind it. Then read
   its test in the sibling `__tests__/` directory.
4. [CLAUDE.md](../CLAUDE.md) for the rules, [DECISIONS.md](DECISIONS.md)
   *"Still open"* before "fixing" anything — several things are unfixed on
   purpose and say why.

---

## 1. Before you touch anything

You are in a **git worktree** at `<repo>/.agentskanban/worktrees/<name>`, on a
branch `task/<id>-<slug>`, forked from `main`. Run everything from there. Never
`cd` to the main checkout; never use bare `git stash` (the stash stack is shared
with every other agent).

| Fact | Consequence |
|---|---|
| `node_modules` is **absent** in a fresh worktree | The first `npm run …` runs `scripts/preflight.mjs`, which installs. Needs Node 22.6+. |
| `npm run verify` = preflight → typecheck → build → 54 test files → `smoke.mjs` | ~13 s once installed. Run it before you move your card to review. |
| One test: `node --experimental-strip-types --no-warnings src/<dir>/__tests__/<x>.test.ts` | `.mjs` tests run with plain `node`. No framework; they print `ok:` / `FAIL:` and exit non-zero. `scripts/test.mjs` stops at the first failing file. |
| Some tests read `dist/` | `executable.test.ts`, `board-bridge.test.ts`, `smoke.mjs`, `test/harness.mjs` load the **built bundle**. `verify` builds first; if you run tests alone, `npm run build` first. |
| Some tests need **Chromium** | `board/__tests__/layout.test.mjs`, `src/remote/__tests__/headless.test.mjs` (also `test/screenshots.mjs`). They FAIL without one, never skip. Install once: `node scripts/run-bin.mjs playwright playwright install chromium`. |
| `smoke.mjs` is hermetic | It seeds a throwaway `CLAUDE_CONFIG_DIR`; it must never read your real sessions or spawn a CLI (`discoverModels: false`). Keep it that way. |
| Nothing TRACKED goes into the user's repository | Board state lives in extension storage. The only thing this extension writes into a repo is the ignore rule for `/.agentskanban/`. |
| Every npm script starts with `node` or `npm` | No `npx`, no bare binary names, no bashisms — npm runs scripts through `sh`. Use `node scripts/run-bin.mjs <package> <bin> …`. |
| `vscode` may be imported only by `src/extension.ts` and `src/board/panel.ts` (+ `board/settings.ts`) | Everything else is plain Node and unit-tested without an editor. A new `vscode` API also goes into `test/harness.mjs` and `server/stub.mjs`. |

**Your card is your session.** Move it with the board tools you were given:
`set_phase("implementing")` at your first edit, `set_phase("validating", …)`
with a `howToTest` when you are done — that move is how a run ends, whatever
else told you to stop. `complete` is refused in code. `split_task` works only
while your worktree is clean and has no commits, once, one level deep, at most
four pieces.

---

## 2. The shape of the system

```
                         ┌────────────────────────────────────────────────────────┐
  you, or a browser ───► │  webview: media/board.js · media/settings.js           │
                         │  (vanilla JS, no innerHTML, state held at module level) │
                         └───────────────▲──────────────────────┬─────────────────┘
                     UiState frames, coalesced   postMessage {type, …}
                                         │                      ▼
                         ┌───────────────┴────────────────────────────────────────┐
                         │  host: src/extension.ts (one activate()) +              │
                         │        src/board/panel.ts (BoardHost, wire(), UiState)  │
                         │  getState() ← SessionStore + AgentManager + Worktrees   │
                         └───┬──────────────────┬───────────────────┬─────────────┘
                             │                  │                   │
              ┌──────────────▼───┐   ┌──────────▼──────────┐   ┌────▼─────────────────┐
              │ src/sessions/    │   │ src/agent/           │   │ src/git/             │
              │ what is on DISK  │   │ what is RUNNING      │   │ one worktree per task │
              │ ~/.claude/…      │   │ AgentManager → a     │   │ create · diff · commit│
              │ ~/.codex/…       │   │ runtime.start(spec)  │   │ merge --no-ff --no-   │
              │ + sidecar (meta) │   │   claude: SDK query()│   │ commit · MERGE_HEAD   │
              └──────────────────┘   │   codex: app-server  │   └──────────────────────┘
                                     │ board tools (MCP) ←──┼── the agent moves its own card
                                     └──────────────────────┘   in-process, or over a socket
```

Two ideas everything rests on: **a card and a session are the same thing**, and
**a session's column is its `phase`** — writing `phase` is the move. Two axes
that are not the same thing: a **runtime** is the agent program (Claude Code,
Codex — a different process), a **provider** is the backend behind Claude Code
(environment variables on the child). See [RUNTIMES.md](RUNTIMES.md) and
[PROVIDERS.md](PROVIDERS.md).

---

## 3. The tree, annotated

For every file: what it owns · the exports you will reach for · its test · the
trap its header states. The tests live beside the code in `__tests__/`.

### `src/` — top level

**`src/extension.ts`** (~5100 lines) — the VS Code surface, and the only file
besides `board/panel.ts` allowed to import `vscode`. It is **one enormous
`activate()`**; almost everything is a closure inside it, so grep for names
rather than looking for exports. Owns: command registration, the `Workspace`
(store + worktrees + manager, rebuilt when folders change), `const host:
BoardHost` (every board message's implementation), `getState()` (the whole
`UiState`), the coalesced `paint`/`refreshAll()`, the settings-page message
switch, schedule firing (`fireDueSchedules`, `fireScheduleNow`), the roll-up of
subtasks (`rollUpToParent`), review/merge handlers, the diff content provider.
Test: `smoke.mjs` only (it needs VS Code). Trap: `getState()` is the render
path and runs up to ten times a second while an agent streams — anything you add
to it must be memoised or cheap.

**`src/board-mcp.ts`** — its own bundle, `dist/board-mcp.js`, spawned BY Codex
as an MCP server. Holds no board logic: forwards every call over the socket in
`AGENTS_KANBAN_BRIDGE` to `agent/board-bridge.ts`. Trap: never write to stdout
except JSON-RPC; never answer a notification; a failed call returns a tool
result with `isError`, never a JSON-RPC error. Test: `agent/__tests__/board-bridge.test.ts`
(runs the built bundle; `test/package.test.mjs` asserts it ships).

### `src/board/` — the board's own concepts, and the two webviews' host side

| File | Owns | Reach for | Test |
|---|---|---|---|
| `config.ts` | Columns and phases (`DEFAULT_BOARD`: backlog · planning · implementing · validating · complete), `AgentState` union, `isHumanOnly`, `isReviewColumn`, `isStartedColumn`, `stalledSince`, `splitByAge` | Change a column, a phase rule, the stalled derivation, the age bound | `config.test.ts` (opens by asserting the approval boundary for every column) |
| `panel.ts` | `BoardHost` (the ~50-method host contract — the best index of what the board can do), `UiState`/`UiCard` (the wire shape), `wire()` (the board webview's `switch (msg.type)`), `BoardPanel` (editor) + `BoardViewProvider` (side bar), `applyBoardFocus`, `forControl()` | Add a webview message; change what the view is sent | `smoke.mjs` §live wiring, §view contract |
| `settings.ts` | The settings TAB host side: `SettingsState`, `parseMessage` (defensive), `SettingsPanel` with `retainContextWhenHidden` | Add a settings-page control | `settings-view.test.mjs`, `settings-spawn.test.mjs`, `settings-schedule.test.mjs`; host side in `smoke.mjs` §providers |
| `coalesce.ts` | The repaint rate limiter: leading edge immediate, one trailing run, never overlapping, interval scaled to measured cost (floor `intervalMs`, cap 500 ms) | Repaint cost, streaming lag | `coalesce.test.ts` (injected clock) |
| `decomposition.ts` | The orchestration dial (`minimal · balanced · maximum`), `policyFor`, `aimSentence`, `checkProposal` (the gates on a split), `decompositionLine` (the record on the card), `MAX_BRIEF` | Anything about when a session may split | `decomposition.test.ts` — the load-bearing case: identical verdicts across levels |
| `subtasks.ts` | The parent↔child thread, derived on every render from `SessionMeta.parent`: `linkSubtasks`, `subtaskProgress`, `rollUpState` | The "1/2 ready" count, the roll-up | `subtasks.test.ts` |
| `schedules.ts` | Scheduled runs, pure half: `nextFireAt` (anchored to `lastFiredAt` — catch-up fires once), `parseSchedules`, `parseScheduleDraft`, `describeWhen` | Time triggers. Firing itself is in `extension.ts` | `schedule.test.ts`, `settings-schedule.test.mjs`, a round trip in `smoke.mjs` |
| `questions.ts` | `AskUserQuestion` → a renderable picker (`parseAskQuestions`, `buildAskAnswers`) | Questions vs permissions | `questions.test.ts`, `ask.test.mjs` |

Traps: `panel.ts` never touches the primary side bar; `forControl()` DROPS
`transcript`/`streaming`/`review` for the side bar (never sends them empty);
`decomposition.ts`'s import of `RouteRule` must stay type-only or the module
cycle `meta → decomposition → routing → meta` blanks the board; `questions.ts`
files the answer under the question text **untrimmed**.

### `src/sessions/` — what is on disk, and the sidecar

| File | Owns | Reach for | Test |
|---|---|---|---|
| `store.ts` | `SessionStore`: every runtime's sessions merged with our metadata; `list()`, `card()`, `transcript()`, `usage()`, `meter()`, `adoptKey()`, `patch()`, `setPhase()`, `delete()`; the `Entry` union (every transcript row kind); `summariseTool`; `retryWhileMissing` | Transcript parsing, card data, anything read back from `~/.claude` | `store.test.ts` (seeds a real-format Claude Code store into a throwaway config dir) |
| `meta.ts` | `MetaStore` — the sidecar in global storage: phase, tags, archive, worktree, test plan, per-session model/effort/thinking/runtime/provider/orchestration, `running` mark, `fanout`, `parent`; `parseMeta`; `MODELS` (the built-in fallback list); `resolveEffort`/`resolveThinking`; recovery from sibling installs | Persisting anything per session. **A field written here must be READ BACK by a test** | `meta.test.ts` |
| `usage.ts` | Context fill and spend arithmetic from transcript token counts: `summariseUsage` (dedupes by `message.id`), `MODEL_RATES`, `MODEL_WINDOWS`, `normaliseModel`, `ModelBook` | Any number on a meter | `usage.test.ts` (case one is the ~3× deduplication bug) |
| `codex-store.ts` | Codex's rollouts read back: `codexHistory`, `parseRollout`, `codexHome` (honours `CODEX_HOME`) | Codex transcripts, its rate-limit meter | `codex-store.test.ts` |
| `subagents.ts` | Background agents (the `Agent` tool) off disk: `scanBackgroundAgents` (one walk), `readTaskNotifications` (the ONLY authoritative outcome), `agentStatus` | "Still working?" badges | `subagents.test.ts` |
| `search.ts` | `searchEntries` over every rendered row kind, nested subagent rows included; nothing invisible is matched | The search screen | `search.test.ts` |
| `checkpoints.ts` | "Try again from here": Claude Code's `file-history-snapshot` entries read from the RAW JSONL, `planRestore`/`applyRestore` | Rewind | `checkpoints.test.ts` |
| `commands.ts` | `listSlashCommands` — `.claude/commands/*.md`, project shadows user | `/` autocompletion | `commands.test.ts` |

Traps: `store.list()` is on the render path and caches the index scan;
`adoptKey()` carries metadata from the local `run-…` key to the real session id
when `system/init` arrives; Anthropic's `input_tokens` and
`cache_read_input_tokens` are disjoint (summed), Codex's `cached_input_tokens`
is a subset (not added).

### `src/agent/` — what is running

| File | Owns | Reach for | Test |
|---|---|---|---|
| `manager.ts` | `AgentManager`: at most N runs, one worktree each; `start()` (freezes `launchSettings` before the concurrency check), the queue and `drain()`, `launch()`/`startRun()` (no branch on runtime identity), `split()` (every split limit lives here), `send`, `interrupt`, `stop`, `stopAll`; `buildBrief()` (the appended system prompt); `durablePatch`; `followKey`; `MAX_SUBTASKS = 4` | Run lifecycle, splitting, the brief agents receive | `manager.test.ts`, `route-launch.test.ts` (real git repo, fake runtime) |
| `session.ts` | `AgentSession` — one SDK `query()`: `run`, `send`, `interrupt`, `stop`, `answerPermission`, `handle()` (the whole stream parser), `decide()` (the permission gate), `settleTurn` (spend vs `total_cost_usd`); `agentEnv()`; `ultracodeWarning` | Anything about a Claude Code frame, permissions, live spend, background tasks / `waiting` | `spend.test.ts`, `background-turns.test.ts` (both feed recorded frames into `handle()`) |
| `runtime.ts` | The contract: `AgentRuntime` (`detect`, `login`, `models`, `start`, `capabilities`, `history`), `RunSpec`, `AgentRun`, `Meter` union + `parseMeter`, `RuntimeHistory`, the registry (`registerRuntime`, `getRuntime`), `RuntimeId`/`parseRuntimeId` | Adding a runtime, the meter shape | `status.test.ts`, `codex.test.ts`, `route-launch.test.ts` |
| `runtimes/index.ts` | The one file that names every runtime; registration is an import side effect | Add the third runtime here | — |
| `runtimes/claude.ts` | Claude Code behind the contract: `detect` → `resolveClaudeExecutable`, `login` → `accountInfo()` under a timeout, `start` → `AgentSession` | — | `executable.test.ts`, `status.test.ts` |
| `runtimes/codex.ts` | Codex over `codex app-server` JSON-RPC: `CodexSession`, `codexRuntime`, `codexPermissions`, `parseModels`, `contextFill`; reads both `agent_message`/`agentMessage` spellings, reports unknown methods once per turn | Codex protocol | `codex.test.ts` (a stand-in app-server child; no real Codex needed) |
| `jsonrpc.ts` | `JsonRpcPeer`: newline-delimited JSON-RPC 2.0 over a child's stdio, bidirectional, routes on `method` vs `result`, tolerates the missing `"jsonrpc"` member | Any stdio-RPC runtime | via `codex.test.ts` |
| `tools.ts` | `buildBoardTools` — the TEN board tools: `set_phase`, `set_title`, `set_tags`, `list_board`, `split_task`, `notify_user`, `schedule_list/create/delete/run`; `ASKS_FIRST` (the four that prompt); `boardToolNames` (auto-allow, DERIVED); `createBoardServer` | Change what an agent can do to the board | `tools.test.ts`, `board-bridge.test.ts` |
| `board-bridge.ts` | The same tools over a unix socket / named pipe for runtimes that spawn MCP servers; per SESSION; token-gated | Codex board tools | `board-bridge.test.ts` (asserts `set_phase('complete')` is refused across the socket) |
| `routing.ts` | A subtask's route, pure: `resolveRoute`, the four refusals (`spawn-agent`, `spawn-model`, `spawn-catalogue`, `spawn-effort`), `agentKeyOf` (`<runtime>\|<profile>`), `describeSpawnAgents` | Which agent/model a piece may run on | `routing.test.ts`, `route-launch.test.ts` |
| `spawn-policy.ts` | Which models a SPLIT may spawn on, per profile — stores the disallowed half; absence means allowed | The settings-page tick | `spawn-policy.test.ts` |
| `providers.ts` | A profile → an environment patch `{set, clear}` (`envForProfile`); `ProviderProfile`, `PROVIDER_PRESETS`, `validateProfile`, `reconcileProvider`, `parseProfiles`, `credentialKey`. **The only file that knows a variable name** | Backends, gateways, Bedrock/Vertex/Foundry | `providers.test.ts` |
| `models.ts` | Which models the picker offers and from where: `catalogueFor` (the single entry point), `mergeModels`, `discoverModels` (cached per provider, never on the render path), `effortsFor`/`thinkingFor`/`ultracodeFor`/`fastModeFor`, `parseCachedChoices` | The model list, per-model capabilities | `models.test.ts` (a real CLI answer as fixture) |
| `endpoint.ts` | `fetchEndpointModels` — `GET <base>/v1/models`, ids + windows + prices, several dialects (OpenAI, OpenRouter, Ollama, LiteLLM); zero is a price, `-1` is not | Gateway catalogues | `endpoint.test.ts` (a real 431-model OpenRouter payload) |
| `probe.ts` | `probeProvider`/`checkEndpoint`: TCP connect → `max_tokens: 1` → models; four failure cases with four fixes | The Test-connection button | `probe.test.ts` |
| `connect.ts` | `withSilentQuery` — ask the CLI (`accountInfo`, `supportedModels`) without a turn; timeout + guaranteed abort | Provider probe, discovery | via `probe`/`models`/`status` tests |
| `status.ts` | `collectRuntimeStatus` — every runtime's install + login, in parallel, each with its own wall clock | The settings page's agent cards | `status.test.ts` |
| `sdk.ts` | Lazy `import()` of the ESM-only SDK; `resolveClaudeExecutable` (setting → PATH → usual places, **never `node_modules`**) | — | `executable.test.ts` (asserts on the built bundle) |
| `images.ts` | Attachments as image content blocks: `sanitiseImages`, `userContent`, caps (`MAX_EDGE 1568`, 8 images) | Pasting screenshots | `images.test.ts` |
| `dictation.ts` | Local dictation: ffmpeg capture → `whisper-cli`; `checkVoice` reports three separate failures | The microphone | `dictation.test.ts` |

### `src/git/`, `src/run/`, `src/remote/`

| File | Owns | Test |
|---|---|---|
| `git/worktree.ts` | `WorktreeService`: `create` (idempotent per branch, `ensureIgnored` + `ensureExcluded` first), `remove`, `changedFiles`/`fileStatuses`/`review`, `commitAll`, `merge` (`--no-ff --no-commit`, refuses on dirty tree / pending merge / nothing to merge / wrong branch), `pendingMerge` (reads `MERGE_HEAD`), `commitMerge`, `abortMerge`, `show`; `slug`; path containment for model-written link targets | `worktree.test.ts` (real git repos) |
| `git/lock.ts` | `withRepoLock` — per-repo FIFO mutex; the slot is claimed synchronously | `lock.test.ts` |
| `run/recipe.ts` | `detect()` what starts the app in a worktree (`runCommand` → the project's `wt` launcher → Laravel → `package.json` script) and `waitForPort`; never returns a URL it cannot justify | `recipe.test.ts` |
| `src/remote/relay.ts` | The shape of what may leave the machine for the relay (`RemoteCardSource` IS the redaction boundary), `boardIdOf` | `relay.test.ts` |
| `src/remote/cards.ts` | `toRemoteCard`, `remoteAgent` — the redaction filters | `cards.test.ts` |
| `src/remote/feed.ts` | What a push carries (a tail only when the transcript GREW) | `feed.test.ts` |
| `src/remote/pusher.ts` | When a push leaves: `MIN_INTERVAL`, idle = no push, heartbeat | `pusher.test.ts` |
| `src/remote/commands.ts` | Prompts coming back from the relay: `remote.writes` gate (default off; enabling flushes the queue), nonces, no session guessing | `commands.test.ts` |

`src/remote/__tests__/` also holds `handler`, `server`, `worker`, `viewer` (the
deployable relay's own logic, imported across the folder boundary) and
`headless.test.mjs` (the headless board through real Chromium).

### `media/` — the webviews

| File | Owns | Test |
|---|---|---|
| `board.js` (~3850 lines) | The board webview, one IIFE: `render()` (rebuilds the tree, harvesting scroll / `<details>` / caret first), `chromeSig()` (what a frame must change to force a rebuild), `syncFrame()` (the streaming fast path, one branch per screen), `disclosure()`, `renderMarkdown()` (nodes, never `innerHTML`), the screens `renderKanban` / `renderChat` / `renderSearch` / `renderControl` (side bar), `renderComposer`, `renderCard`, the review/merge/test-plan/subtask/stalled/interrupted panels; `post(type, payload)` is the only way out | `webview.test.mjs`, `ask`, `attach`, `markdown`, `scroll` `.test.mjs`; `layout.test.mjs` (Chromium); `smoke.mjs` §view contract |
| `board.css` | Tokens first (`--ctl-h` 24 px, `--ctl-h-lg` 32, `--ctl-h-xs` 20 — the ONLY control heights), then a section per screen | `layout.test.mjs`, `theme.test.mjs` |
| `settings.js` / `settings.css` | The settings page: runtime cards with four login states, provider profiles and their catalogues, spawn ticks, schedules, dictation, remote control | `settings-view`, `settings-spawn`, `settings-schedule` `.test.mjs` |
| `theme.css` | The Dark Modern palette for every `--vscode-*` variable — for the browser only; inert in the editor | `theme.test.mjs` |

Trap: anything the user typed or opened lives at module level (`draft`,
`disclosed`, `searchQ`, `askChoices`…), never in the DOM, because `render()`
replaces the tree several times a second. A new volatile field must be deleted
in `chromeSig()` or every frame rebuilds.

### `server/`, `remote/`, `scripts/`, `test/`, root

| Path | What it is |
|---|---|
| `server/server.mjs`, `stub.mjs`, `page.mjs`, `bridge.js`, `bridge.css` | The **headless board**: the built extension activated against a `vscode` stub on a box, a browser as its webview (SSE in, POST out), gated by a pairing code. `npm run remote`. See [server/README.md](../server/README.md) |
| `remote/` | The **relay** — a deployable mirror site (Netlify / Cloudflare Workers / plain Node) the extension pushes a redacted board to. A lift-out with its own `package.json`, excluded from the .vsix. See [remote/README.md](../remote/README.md) |
| `scripts/preflight.mjs` | Node ≥ 22.6, installs `node_modules` if missing, checks a fixed list of packages. Every npm script starts with it |
| `scripts/test.mjs` | Walks `src/` for `*.test.ts` / `*.test.mjs`; zero files is a failure; stops at the first red file |
| `scripts/run-bin.mjs` | Runs a dependency's bin through Node's resolver (no `node_modules/.bin`, no `npx`) |
| `scripts/with-node.sh` | Finds a Node 22.6+ for VS Code tasks (non-interactive shells skip nvm) |
| `scripts/install-local.mjs`, `make-icon.mjs` | Package + install into VS Code; render the Marketplace icon |
| `test/harness.mjs` | A fake VS Code that activates the BUILT bundle and captures what the host posts; models the workbench layout as state |
| `test/dom.mjs` | A DOM just big enough to run `board.js` / `settings.js` in a `vm` |
| `test/package.test.mjs` | What the .vsix carries (`npm run verify:package`) |
| `test/screenshots.mjs` | Renders the real view in Chromium → `docs/screenshots/` |
| `smoke.mjs` | The launch gate: activation, manifest ↔ code, no-folder, live wiring, view contract, providers — hermetic |
| `esbuild.mjs` | Two bundles: `extension.js` (externals `vscode`, the SDK, `zod`) and `board-mcp.js` (NO externals, on purpose) |
| `.vscodeignore` | What stays out of the .vsix: `src/`, `docs/`, `remote/`, `.agentskanban/`, the SDK's native binary |

---

## 4. Where to look for X

| I need to… | Start here | Then | Gate |
|---|---|---|---|
| Add or change a **board tool** the agent calls | `agent/tools.ts` `buildBoardTools` | Auto-allow is derived; `board-bridge.ts` + `board-mcp.ts` carry it to Codex unchanged; the brief in `manager.ts buildBrief()` | `tools.test.ts`, `board-bridge.test.ts` |
| Change **columns / phases / the human-only rule** | `board/config.ts` `DEFAULT_BOARD` | `isHumanOnly` is checked in `set_phase` before any write | `config.test.ts`, `board-bridge.test.ts` |
| A **board button does nothing** | `media/board.js` — find its `post('…')` | `board/panel.ts wire()` — the `case` | `extension.ts` — the method on `const host: BoardHost` | `smoke.mjs` "every inbound message is handled" |
| A **settings control does nothing** | `media/settings.js` `post({type})` | `board/settings.ts parseMessage` | `extension.ts` settings `switch (msg.type)` | `settings-view.test.mjs` |
| Add a **setting** or a **command** | `package.json` `contributes` | The reading/registering site in `extension.ts` | README's settings table | `smoke.mjs` §manifest (declared ↔ used) |
| Use a new **`vscode` API** | `extension.ts` / `panel.ts` | `test/harness.mjs` AND `server/stub.mjs` must stub it | `smoke.mjs`, `headless.test.mjs` |
| Change **what a card shows** | `UiCard` in `panel.ts`, built in `getState()` | `renderCard` in `board.js`; if the field is volatile, `chromeSig()` | `webview.test.mjs`, `layout.test.mjs` |
| The board is **laggy / repaints too much** | `board/coalesce.ts` | `paint` / `refreshAll` in `extension.ts`; what you added to `getState()` | `coalesce.test.ts`, `smoke.mjs` "a burst of events…" |
| The view **flickers / loses scroll or caret** | `chromeSig()` and `syncFrame()` in `board.js` | `data-scroll` on every scroller, `disclosure()` for every `<details>` | `scroll.test.mjs` |
| **Transcript rows** / a new row kind | `sessions/store.ts` `Entry` + `readTranscript` | Live: `agent/session.ts handle()`; Codex: `codex-store.ts parseRollout`; view: `renderEntry` in `board.js`; search: `sessions/search.ts` | `store.test.ts`, `spend.test.ts`, `search.test.ts` |
| **Context meter / spend** | `sessions/usage.ts` | Live path `session.ts settleTurn`; gateway prices via `ModelBook` from `endpoint.ts`; the `Meter` union in `runtime.ts` | `usage.test.ts`, `spend.test.ts` |
| The **model picker** is wrong or empty | `agent/models.ts catalogueFor` (the ONE fallback chain) | `endpoint.ts` for gateways; `sessions/meta.ts MODELS` is the floor | `models.test.ts`, `endpoint.test.ts`, `smoke.mjs` "the composer offers models" |
| **Backends**: Bedrock, Vertex, a gateway, env vars | `agent/providers.ts envForProfile` | `probe.ts` for the connection test; [PROVIDERS.md](PROVIDERS.md) | `providers.test.ts`, `probe.test.ts` |
| Add a **third runtime** | `agent/runtime.ts` (contract) | `runtimes/index.ts`, `package.json` enum; [RUNTIMES.md](RUNTIMES.md) | `route-launch.test.ts` with a fake runtime |
| **Codex** protocol, transcripts, meter | `agent/runtimes/codex.ts`, `agent/jsonrpc.ts` | `sessions/codex-store.ts` | `codex.test.ts`, `codex-store.test.ts` |
| **Worktrees**: create, diff, commit, merge, conflicts | `git/worktree.ts WorktreeService` | `git/lock.ts`; the banner: `renderPendingMerge` in `board.js`; handlers in `extension.ts` | `worktree.test.ts` |
| **Splitting**, subtasks, routing a piece to another agent | `manager.ts split()` | `board/decomposition.ts` (dial + gates), `agent/routing.ts` (route), `agent/spawn-policy.ts` (allowlist), `board/subtasks.ts` (roll-up), `rollUpToParent` in `extension.ts`; [ORCHESTRATION.md](ORCHESTRATION.md) | `decomposition`, `routing`, `route-launch`, `subtasks`, `manager` tests |
| **Scheduled runs** | `board/schedules.ts` | `fireDueSchedules` / `fireScheduleNow` in `extension.ts`; `scheduledSection` in `settings.js`; the `schedule_*` tools | `schedule.test.ts`, `settings-schedule.test.mjs` |
| **Background agents** (the `Agent` tool), `waiting` state | `sessions/subagents.ts` | `session.ts` task tracking; `renderBackgroundAgents` | `subagents.test.ts`, `background-turns.test.ts` |
| A card says **interrupted / stalled / failed / queued** | `sessions/meta.ts` (`running` mark), `board/config.ts stalledSince`, `AgentState` | `renderInterrupted` / `renderStalled` / `renderQueued` in `board.js` | `config.test.ts`, `smoke.mjs` "a run the host never got to finish" |
| **Permissions**, `AskUserQuestion` | `session.ts decide()` | `board/questions.ts`; `renderAskPermission` / `renderAskQuestions` | `questions.test.ts`, `ask.test.mjs` |
| **Images** in the composer | `agent/images.ts` | `addImageFiles` in `board.js` | `images.test.ts`, `attach.test.mjs` |
| **Dictation** | `agent/dictation.ts` | `voiceStart`/`voiceStop` in `panel.ts` → `extension.ts`; `insertDictation` | `dictation.test.ts` |
| **Search** | `sessions/search.ts` | `search` / `openHit` in `panel.ts`; `renderSearch` | `search.test.ts` |
| **Rewind** ("Try again from here") | `sessions/checkpoints.ts` | `forkAt` in `panel.ts` → `extension.ts` | `checkpoints.test.ts` |
| The **Run** button | `run/recipe.ts` | `runWorktree` in `extension.ts` | `recipe.test.ts` |
| **Remote** mirror | `src/remote/*`, `remote/` | The settings page's Remote Control section | `remote/__tests__/*` |
| **Headless** board | `server/*` | `media/theme.css`, `server/page.mjs` (theme first) | `headless.test.mjs`, `theme.test.mjs` |
| **Styles / layout** | `media/board.css` tokens | `settings.css`; every flex text item carries `min-width: 0` | `layout.test.mjs` — the only gate that measures pixels |
| **Markdown / anything that looks like HTML** in an answer | `renderMarkdown` in `board.js` | Links are `http(s)`/`mailto` only | `markdown.test.mjs` |
| Session **identity** (`run-…` → session id) | `manager.ts` (`followKey`, the `sessionId` listener) | `store.adoptKey`, `MetaStore.rename`; `smoke.mjs` "a live card does not restamp itself" | `manager.test.ts` |
| **Persist** something per session | `sessions/meta.ts SessionMeta` + `parseMeta` | It must be read back by `meta.test.ts` | `meta.test.ts` |
| **Packaging / publishing** | `esbuild.mjs`, `.vscodeignore` | [PUBLISHING.md](PUBLISHING.md) | `test/package.test.mjs` |
| **Is X already done?** | [PLAN.md §8](../PLAN.md) (working) and §9 (not yet) | [DECISIONS.md](DECISIONS.md) *Still open* | — |

---

## 5. The flows

**A run.** The webview posts `newSession`/`send` → `panel.ts wire()` →
`host.newSession()` / `host.sendMessage()` in `extension.ts` →
`AgentManager.start()` mints `run-<n>-<id>` and FREEZES `launchSettings` (model,
effort, thinking, flags), runtime, provider and orchestration level → over the
limit it queues (the queued run still gets a card), else `launch()` →
`launchInner()` creates or reuses the worktree (`WorktreeService.create`), reads
the prior transcript and spend off the store as the live/history boundary,
registers the `RunningAgent` → `startRun()` looks the runtime up, builds the
board tools (`createBoardServer` in-process for Claude Code, `startBoardBridge`
for Codex), resolves the provider env, builds the brief → `rt.start(spec)` →
`AgentSession.run()` (or `CodexSession`) → every frame goes through `handle()`
→ events (`sessionId`, `state`, `text`, `tool`, `usage`, `permission`,
`waiting`, `committed`, …) → the manager's listeners update the card and call
`touch()` → `change` → `refreshAll()` → `paint.schedule()` → one `getState()` →
`provider.post(state)` (side bar) + `BoardPanel.postCurrent(state)` (editor) +
`remotePusher.nudge()`. When `system/init` arrives, `adoptKey` carries the
board's metadata from the run key to the real session id. A `result` with
background tasks outstanding enters `waiting`, not `done`.

**A repaint.** Any host event → `refreshAll()` → `coalesce` (leading edge now,
one trailing run, interval scaled to the last repaint's cost) → `getState()` →
`UiState` → webview `state` message → `chromeSig() === lastChrome &&
syncFrame()` patches in place, otherwise `render()` rebuilds and restores every
`data-scroll`, `data-open`, focus and caret. `composer.models` is omitted when
unchanged; the view keeps the last list it saw.

**A split.** The agent calls `split_task` → `tools.ts` → `manager.split()`:
refused if the worktree is dirty or has commits, if this session was itself a
subtask, if it already split, over four; `checkProposal` (decomposition) then
`resolveRoute` per piece (routing, against the TARGET agent's catalogue) then
`confirmSplit` (a real click, host-side) → each piece is a real `start()` from
the parent's BASE → `SessionMeta.parent` on each child, `fanout` on the parent
→ `subtasks.ts` derives the thread on every render → when the last child
reaches review, `rollUpToParent` moves the parent and notifies the user. Nothing
re-runs the parent.

**A merge.** Review panel → `commit` (`commitAll`) → `merge` → modal → `merge()`
under the repo lock: `ensureExcluded`, refuse on `pendingMerge()`, refuse on a
dirty tree (`dirtyMessage` tells ours from theirs), `--no-ff --no-commit` → the
work is STAGED, `MERGE_HEAD` exists, the banner shows the staged files →
`commitMerge` or `abortMerge`. A conflict is the same banner in red; nothing
resolves it for you. Complete → the worktree cleanup is offered.

**A scheduled run.** Settings page or `schedule_create` → `workspaceState`
(`schedules`) → a `setInterval` in `extension.ts` calls `fireDueSchedules()`
(re-entrancy guarded) and a catch-up pass runs at activation → `nextFireAt`
anchored to `lastFiredAt`, which is stamped BEFORE the launch → `fireScheduleNow`
→ `AgentManager.start()` with the schedule's prompt → a normal card.

**A Codex run.** Same path to `rt.start(spec)`; `CodexSession` spawns `codex
app-server`, speaks `JsonRpcPeer` over stdio, receives approvals as
server→client requests (every branch ends in an answer), and the board tools
reach it through `dist/board-mcp.js` → the socket → `board-bridge.ts` → the same
`buildBoardTools` handlers in the host. Its transcript is read back by
`codex-store.ts`; its meter is a rate-limit percentage, never dollars.

---

## 6. Which gate catches what

| Gate | The seam it stands over | Needs |
|---|---|---|
| `smoke.mjs` | manifest ↔ code, activation with and without a folder, webview → host (`ready` returns a real `UiState`), host → view (the REAL state through the REAL `board.js`), providers ↔ SecretStorage, the layout model | the built bundle |
| `test/package.test.mjs` | repo ↔ `.vsix` (externals present, native binary absent, `board-mcp.js` shipped) | `vsce`; not in `verify` |
| `layout.test.mjs` | stylesheet ↔ pixels; measures every `.ctl` on the bar | Chromium |
| `headless.test.mjs` | the headless server, the gate, a real browser, zero console errors | Chromium |
| `webview.test.mjs` and friends | `board.js` renders every state without throwing (a throw is a blank panel) | stub DOM |
| `store.test.ts`, `codex-store.test.ts`, `subagents.test.ts`, `checkpoints.test.ts` | the real on-disk formats, seeded into throwaway config dirs | — |
| `worktree.test.ts`, `route-launch.test.ts` | real git repositories | git |
| `executable.test.ts`, `board-bridge.test.ts` | the built bundle's behaviour (`__filename`, the socket, the refusal) | the built bundle |
| `theme.test.mjs` | every `--vscode-*` variable used is defined for the browser | — |
| `tools.test.ts` | the auto-allow list is derived from the definitions | the SDK |

Two rules: **a new gate must be shown to fail** (break the thing, watch it go
red, put it back), and **run a real agent before believing the suite** — every
unit test was green while agents could not move their own cards.

---

## 7. Vocabulary

- **Card / session** — the same thing at two zoom levels. Keyed by
  `sessionId ?? runId`.
- **Phase / column** — one field. `complete` is `humanOnly`.
- **Runtime** — the agent program (`claude`, `codex`); a session keeps its
  runtime for life. **Provider / profile** — the backend behind Claude Code,
  chosen per launch; `inherit` writes nothing. **Agent key** — `<runtime>|<profile>`,
  one picker for both.
- **Catalogue** — the model list in force and where it came from (`endpoint` →
  `cli` → `profile` → `builtin`). **ModelBook** — prices and windows handed to
  the meters.
- **Sidecar / MetaStore** — our per-session metadata in global storage.
  **Foreign session** — one found in a runtime's store that the board never
  touched; bounded by age.
- **Brief** — the system prompt appended to every run (`buildBrief`). **Aim
  sentence** — the one line the orchestration dial changes.
- **Split / subtask / fanout / roll-up** — one card becoming 2–4 cards from the
  same base; the count asked for; the parent moving when the last child lands.
  **Route** — a piece's agent, model and effort, validated against that agent's
  catalogue.
- **Background agent / subagent** — what a session spawns with the `Agent`
  tool; lives inside the parent's transcript store; its outcome is the
  `<task-notification>` in the parent transcript and nothing else. Not a card.
- **Working / waiting / needsInput / queued / done / error** — `AgentState`,
  volatile, never persisted. **Interrupted** — the host died with the run
  (`running` mark still set). **Stalled** — a started column with no live agent.
  **Failed** — the run ended in an error.
- **Pending merge** — `MERGE_HEAD` exists; every Merge button is disabled until
  it is committed or aborted.
- **Fast path / chromeSig** — a frame that changes nothing the signature covers
  is patched, not rebuilt.
- **Test plan / howToTest** — what a card must carry to enter a review column.
