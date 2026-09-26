---
name: extension-host
description: The VS Code surface — activation, commands, the host behind every webview message, getState() and the coalesced repaint, the settings tab, the manifest
paths:
  - src/extension.ts
  - src/board/panel.ts
  - src/board/settings.ts
  - src/board/dialogs.ts
  - src/board/coalesce.ts
  - src/board/watches.ts
  - package.json
tests:
  - smoke.mjs
  - src/board/__tests__/coalesce.test.ts
  - src/board/__tests__/watches.test.ts
  - src/board/__tests__/settings-view.test.mjs
  - test/package.test.mjs
last_verified: 2026-09-09
---
# The extension host

## Owns

Everything that touches `vscode`: activation, command registration, the two
webview surfaces (editor panel and side bar control), the settings tab, the host
object that implements every message the webviews can post, `getState()` (the
whole `UiState`), the coalesced repaint, schedule firing, the subtask roll-up,
and the manifest in `package.json` that declares commands, views and settings.
Only three files in the repo may import `vscode`; two of them are here.

## Files

**`src/extension.ts`** (~5100 lines). One enormous `activate()`; almost
everything is a closure inside it, so grep for names rather than looking for
exports. Inside it: the `Workspace` (`root`, `store`, `repoRoot`, `worktrees`,
`board`, `manager`), rebuilt by `rebuild()` whenever workspace folders change;
`const host: BoardHost = {…}` — the implementation of every board message;
`boardPass()` / `sessionSlice()` / `host.getState(sink)`; `paint` =
`coalesce(async () => {boardPass → applyRedirects → a slice per live surface →
provider.post / BoardPanel.postCurrent / painted → refreshStatus},
REPAINT_INTERVAL_MS)` and `refreshAll = () => paint.schedule()` — the ONLY
repaint entry point; the settings-page
`switch (msg.type)`; `fireDueSchedules()` / `fireScheduleNow()` and the catch-up
pass at activation; `rollUpToParent()`; the review/merge handlers; a
`TextDocumentContentProvider` for the left side of every diff (`git show` at the
base ref, no temp files); `pickSession()` for palette commands; `deactivate()`,
which is empty because subscriptions handle teardown. Registered commands (all
declared in `package.json`, and the smoke gate asserts the two agree): `openBoard`,
`toggleFocus`, `newSession`, `init`, `openSettings`, `selectProvider`,
`addProvider`, `testProvider`, `refreshModels`, `updateClaudeCode`, `stopTask`,
`archiveSession`, `deleteSession`, `openWorktree`. Activation is
`onStartupFinished`. Test:
`smoke.mjs` only — it activates the BUILT bundle against `test/harness.mjs`.

**`src/board/panel.ts`**. The webview surface in two places and two modes.
Exports `BoardHost` (the ~50-method host contract — the best index of what the
board can do), `UiState` / `UiCard` (the wire shape), `BoardPanel` (editor,
`static show`, `postCurrent`, `onClosed`, `onLeft`), `BoardViewProvider` (side
bar, `viewType = 'agentsKanban.board'`), `applyBoardFocus` / `setBoardFocusMode`
/ `FocusMode`, `showSideBarView`, `toUiAgent`, `readImages`, `summarise`. Also
load-bearing: `dispatchBoardMessage()` — the `switch (msg.type)` shared by BOTH
surfaces AND the remote executor (the relay v2 write channel runs the webview's
own messages through it), so the board and the remote page can never disagree
about what a message means; `html()` — the CSP'd document (`board.css` +
`board.js`, nonce, `data-layout="board"|"control"`). `forControl()` is GONE —
what the side bar is sent is now decided where it is built (`drawsTranscript`),
not stripped on the way out. Test: `smoke.mjs` §live wiring and §view contract;
`src/remote/__tests__/relay.test.ts` builds a `UiState` as its frame fixture.

**`src/board/watches.ts`**. WHO IS LOOKING AT WHAT — the registry that replaced
the `mode`/`selectedKey` pair of host globals. Pure and vscode-free on purpose:
its rules are the ones the type system cannot state. `StateSink`
(`'sidebar' | 'panel' | 'remote'`), `Mode` (declared here, re-exported by
`panel.ts`), `Watch` (`{key, mode}`), `isLocalSink()` (a PREFIX test — every `remote:<viewer>` is remote),
`remoteSink(viewer)`, `carriesModels()`, `drawsTranscript()`, and `Watches` —
`of(sink)` (falls back to the host's defaults, which IS how a brand-new surface
is seeded), `set(sink, patch)`, `keys()` (the bound on cached review data),
`followAll(follow)` (each watch crosses the run-id -> session-id swap on its
own, and KEEPS a key that resolves to nothing so the surface can be told),
`retarget(from, to)` (a fork re-keys a card; everyone watching the old id
follows), `hostSelect(key, remote, current)` (the host opening something itself:
answers what its own selection becomes and moves the local surfaces with it —
one function rather than a reset beside an `if` at ten call sites) and
`resetLocal()` and `forget(sink)` (a remote page the relay has evicted). Test: `src/board/__tests__/watches.test.ts`; the wiring end-to-end is
smoke's "the side bar and the panel can be on two different sessions".

**`src/board/dialogs.ts`**. The one indirection between "this host message wants
a dialog" and *where* it is shown: `confirm` / `input` / `pick` / `toast`, with
an AsyncLocalStorage-held sink so a remote message's dialogs and toasts answer on
the phone instead of a VS Code window. `setDefaultDialogSink` installs the
`vscode.window` sink at activation; `withRemoteDialogSink` marks a dispatch remote
and `isRemoteDispatch()` lets `dispatchBoardMessage` turn editor-only actions
(`openWorktree`, `diff`, `mergeDiff`, `openFolder`, …) into a remote toast rather
than driving the editor — and lets `selectHere` in `extension.ts` know that a
message came from the page, so a phone opening a chat does not retarget the
editor's own selection. It is a fact about the DISPATCH, which is why it is not
called `isRemoteDialog` any more. `makeRelayDialogSink` is the relay sink: it posts a
`remote` dialog/toast event and resolves the waiting promise when the matching
`remote.dialog` answer arrives. Test: `src/board/__tests__/dialogs.test.ts`.

**`src/board/settings.ts`**. The settings TAB (an editor webview with
`retainContextWhenHidden`): `SettingsState`, `SettingsMessage`, `parseMessage`
(the defensive read of the page's messages), `SettingsPanel` (`refreshIfOpen`),
the row state types (`RuntimeAgentCard`, `ProviderCard`, `ProviderModelChoice`,
`ScheduleRowState`, `VoiceRowState`, `RemoteState`). Tests:
`settings-view.test.mjs`, `settings-spawn.test.mjs`, `settings-schedule.test.mjs`
(the page in a stub DOM); host side in `smoke.mjs` §providers.

**`src/board/coalesce.ts`**. `coalesce(run, intervalMs, deps)` → `Coalescer`
(`schedule`, `flush`, `dispose`, `runs`). Leading edge immediate; a burst
collapses to one trailing run; runs never overlap; the interval adapts:
`gap = min(maxIntervalMs, max(intervalMs, cost × dutyCycle))` with the cost
smoothed. Pure and timer-injectable. Test: `coalesce.test.ts`.

**`package.json`**. The manifest: `contributes.commands`, `views`,
`configuration` (every `agentsKanban.*` setting with its description — the
descriptions are documentation, keep them true), `keybindings`, `menus`; the
npm scripts (every one starts with `node scripts/preflight.mjs`; `verify` runs
`scripts/check-contract.mjs` after the tests — see
[build-and-test.md](build-and-test.md)); the two runtime dependencies
(`@anthropic-ai/claude-agent-sdk`, `zod` — both externals); `relayRepo`, the
URL of the sibling relay repository that the contract gate falls back to when
no local `../agents-kanban-relay` exists; and `capabilities.untrustedWorkspaces`
(`supported: false` — this extension spawns agents that edit the folder and run
commands in it, so it must not run before someone has said they trust it; the
`description` is the sentence VS Code shows in the trust dialog). Every setting
that NAMES A BINARY carries `scope: "machine"` — `claudeExecutable`,
`codexExecutable`, `whisperPath`, `ffmpegPath` — because the default scope is
`window`, which lets a repository's own `.vscode/settings.json` choose the
executable we spawn. Test: `smoke.mjs` §manifest (declared ↔ registered, the
machine-scope rule by NAME SHAPE so a fifth cannot arrive on the old default,
and the trust declaration), `test/package.test.mjs`.

## How it works

**Board webview → host.** The view posts `{type, …}`; `dispatchBoardMessage()`
in `panel.ts` switches on `type` and calls the matching `BoardHost` method,
implemented on the `host` object in `extension.ts`. The same switch runs the
remote page's queued messages, wrapped in `withRemoteDialogSink` so its dialogs
and toasts answer on the phone and editor-only actions become a toast. Groups:
lifecycle (`ready`, `init`,
`openFolder`, `setMode`, `select`, `openBoard`, `closeBoard`, `openSession`,
`focus`, `openSettings`, `selectProvider`, `newSessionPrompt`); running an agent
(`newSession`, `send`, `stop`, `interrupt`, `resume`, `clearQueue`,
`dismissInterrupted`, `forkAt`, `permission` — with `selections` when an
`AskUserQuestion` was answered); cards (`move`, `archive`, `archiveMany`,
`remove`, `removeMany`, `pin`, `rename`, `toggleArchived`, `toggleOlder`,
`disclosure`, `composer` — a patch of model / effort / thinking /
permissionMode / provider / runtime / agent / orchestration / ultracode /
fastMode / forKey); worktree and review (`openWorktree`, `run`, `review`,
`diff`, `testLink`, `askTestPlan`, `commit`, `merge`, `commitMerge`,
`abortMerge`, `mergeDiff`). A few are answered with a direct `postMessage`
instead of a repaint, on purpose: `mentionFiles` → `mentions`, `search` →
`searchResults`, `voiceStart`/`voiceStop` → `voice`, `moreTranscript` and
`openHit` (widen the transcript window). The batch-id reader parses and caps at
500 ids; the whole switch is wrapped so a throw becomes `showErrorMessage`, never
a silent blank.

**`ready` and the catalogue.** `ready` means "a webview just loaded and holds
nothing"; `host.onReady(sink)` resets THAT surface's `sentCatalogue` entry, so
its next state carries the full model list. Every later frame OMITS
`composer.models` when the list is the one the view already has (`sendModels`),
because a 431-entry catalogue was 161 KB of a 326 KB frame posted ten times a
second. The memo is per SINK — because it is a claim about who has been told,
and one shared token is spent by whoever paints next: the relay's own
`getState()` used to consume the webview's (a push landing between a catalogue
change and the next repaint marked the list sent, and the local composer held
the old backend's models with nothing on screen to say why), and with two
surfaces on two backends one memo re-sends the whole list on every frame.
`'remote'` never consumes it and never carries the list, because a remote frame
splits the catalogue out onto its own version key (`mv`).

**Settings webview → host.** `media/settings.js` posts; `parseMessage` in
`settings.ts` validates; the `switch` in `extension.ts` acts. Groups: page
(`ready`, `refresh`); runtimes (`setDefaultRuntime`, `install`, `signIn`,
`refreshModels`, `updateCli`); providers (`selectProvider`, `addProvider`, `editProvider`,
`removeProvider`, `testProvider`, `refreshEndpoint`, `setProfileModels`,
`setSpawnAllowed`); shell-outs (`openSetting`, `openUrl`, `copyText`);
dictation (`checkVoice`); schedules (`saveSchedule`, `removeSchedule`,
`toggleSchedule`, `runSchedule`); remote (`setRemote`, `saveRemote`,
`setRemoteWrites`, `clearRemoteCode`).

**Which Claude Code listed the models, and updating it.** The model list is
compiled into the CLI, and every run the board spawns carries `DISABLE_UPDATES`,
so a `claude` on PATH that nothing else starts is never updated — reported as
"only Opus 5, never Opus 5.5" from a 2.1.272 CLI nine releases behind the
2.1.281 VS Code's own Claude Code extension ran. So: `versionKey()`
(`modelsFrom:<rt>:<profile>`) records the answering version beside
`catalogueKey()`'s list; unforced `refreshModels()` trusts the cache only while
`claude --version` still reports that version (after `rebuild()` at activation,
in the background, under `discoverModels`), and a failed background re-ask
keeps the cache rather than dropping to the built-in three; `newestClaudeKnown()`
reads `vscode.extensions.getExtension('anthropic.claude-code')`'s version, the
only local evidence a newer CLI exists; `cliProvenance(cat, rt)` turns both into
`composer.modelNote` ("Listed by Claude Code 2.1.272 — 2.1.281 is out") and
`composer.cliUpdate` (the picker's update row), recomputed in the session branch
so a Codex card is never told about Claude Code. `updateClaude()` is the one
update path — picker row (`updateClaude`, editor-only), settings (`updateCli`),
palette (`updateClaudeCode`): asks first only when Claude agents are live on an
install `replacedInPlace()`, runs `updateClaudeCode()` behind a progress
notification, re-reads the list whatever happened, and reports an update that
changed nothing as a MODAL in the CLI's words (an exit-0 refusal is not success).

**The repaint, and the state split.** Any event → `refreshAll()` →
`paint.schedule()` → ONE `boardPass()` → `applyRedirects(pass)` → a
`sessionSlice(pass, sink, watch)` per surface that is actually there →
`provider.post` / `BoardPanel.postCurrent` / `painted` → `remotePusher.nudge()`.

`boardPass()` is the expensive half — the session-index scan, `allMeta()`, the
background-agent walk, the card list — and it is identical for every surface, so
it runs ONCE however many are open. `sessionSlice()` is everything about one
session: transcript, streaming, meters, the composer's session overrides, that
session's model list, its review data. It is built only for a key somebody is
WATCHING, never one per card, and it shallow-copies the composer because the
session branch overwrites model, effort, agent and the model list.

A slice is built only for a surface that will actually receive it, and that is
load-bearing rather than tidy: building one consumes that sink's catalogue memo,
so a slice nobody receives marks a 431-entry list as sent to a view that never
saw it. `provider.live` and `BoardPanel.isOpen` are the guards.

`painted` is what the relay push reuses while it is fresher than `MIN_INTERVAL`:
`buildRemoteSnapshot` used to call `getState()` a second time, so with Remote
Control on, every push re-ran the session-index scan the repaint had just
finished, on the event loop the CLI's stdout is drained on. Past that freshness
it asks for its own, because a mirror one cadence behind is the bug, not the
saving.

The whole path runs up to ten times a second while an agent streams and is
therefore the render path: the model catalogue is formatted once per state, the
review data is loaded on events (select, commit, merge, a watched agent
finishing) and not recomputed here, keychain reads and the microphone facts are
memoised.

**Focus mode.** `applyBoardFocus` closes the bottom panel and the secondary
side bar while the board is in front and restores them when it leaves.
**The primary side bar is never touched** — not closed, not collapsed, not
resized; the icon click that closes the board reopens the side bar first, so a
restoring toggle closed it instead (nine attempts, see DECISIONS.md). The side
bar is handed back to `agentsKanban.sideBarHome`.

## Change recipes

- **A new board message.** `media/board.js` posts it → a `case` in
  `dispatchBoardMessage()` (`panel.ts`) → a method on `BoardHost` and on
  `const host` in `extension.ts`. The smoke gate "every inbound message is
  handled" sweeps every `post(...)` name in the view against the switch. The
  remote write channel runs the same switch, so the message is reachable from
  the relay with no further wiring — but its dialogs route through
  `src/board/dialogs.ts`.
- **A new setting.** `package.json` `contributes.configuration` (write the
  description as documentation) → read it where it is used in `extension.ts`
  (settings are read on demand, never cached across a change) → the README
  settings table. Smoke §manifest fails on a setting declared but never read.
  If it names a program to run, it needs `scope: "machine"` and a line in
  `EXECUTABLE_SETTINGS` in `smoke.mjs`; without the scope a checked-in
  `.vscode/settings.json` picks the binary.
- **A new command.** `package.json` `contributes.commands` + `registerCommand`
  in the big subscriptions block. Smoke §manifest fails on one without the other.
- **A new `vscode` API.** Add it to `test/harness.mjs` AND `server/stub.mjs`, or
  smoke reports an activation crash — which is what the real editor would do.
- **Something new on a card.** `UiCard` in `panel.ts` → built in `getState()` →
  drawn by `renderCard` in `board.js`. If the field changes every frame, delete
  it from `chromeSig()` (see [webview.md](webview.md)) or every frame rebuilds.
- **Something new in a state frame that is large or rarely changes.** Send it
  the way `composer.models` is sent: omitted when unchanged, never as `[]`.

## Invariants

- **Registration never depends on workspace state.** An early return in
  `activate()` once made every command "not found". Commands and the view
  provider register unconditionally; smoke activates once with no folder open.
- **`getState()` is the render path.** Nothing expensive per token; nothing
  that cannot have changed since the run started is re-read.
- **The board pass runs ONCE per repaint, a slice runs once per WATCHER.** Not
  once per surface and never once per card. Two surfaces on two chats must not
  double the session-index scan, and the number of open chats is bounded by the
  number of surfaces while the number of cards is not.
- **A remote surface's choice never moves the editor's selection.**
  `isLocalSink()`. In the editor "the selected card" and "the card I am looking
  at" are the same sentence — a menu item, the status bar and every deletion
  mean the former. On a phone they are not, and a page opening a chat must not
  retarget what somebody at the keyboard is about to click.
- **A surface left watching a card that is gone is TOLD, including one that
  was following the host's own selection.** `UiState.vanished` carries the key;
  `defaultVanished` carries it for the surfaces with no watch of their own,
  because clearing `selectedKey` would otherwise take the explanation with it —
  and it STANDS until something is selected rather than being cleared by the
  repaint that noticed, or no surface is ever handed it. The surface it happens to is usually not the one that did it
  — a phone left open on a card somebody deleted at the desk — and a selection
  that quietly becomes nothing is a chat disappearing with no explanation
  available anywhere on the board. A statement, never a reason: deleted,
  archived out of view and past the age bound are three different causes the
  host cannot always tell apart.
- **A state is built only for a surface that will receive it.** Building one
  spends that sink's catalogue memo, so a slice computed for a view that is not
  there marks 161 KB as delivered to nobody.
- **Never swallow a rejection with a bare `void`.** A broken `getState()` once
  became a silently blank panel.
- **An editor opened from the board opens BESIDE it, inside `ownLayoutChange`.**
  A file opened into the board's group evicts the webview, and that is the very
  event the click-away rule closes on.
- **A refusal on a path the user clicked is modal, never a toast.**
- **The side bar is sent nothing it does not draw, and is not BUILT one
  either.** `drawsTranscript(sink)` in `board/watches.ts`, read by
  `sessionSlice`. Stripping it on the way out (`forControl`, now gone) saved the
  bytes and not the work — which was free while one state served every surface,
  and is a full transcript built and thrown away ten times a second now that
  each surface gets its own. Absent, never emptied.
- **A merge that starts mid-turn must repaint.** `s.pendingMerge` is in
  `chromeSig()` for that reason.

## Open work

- Permission prompts do not survive a window reload (held on the `AgentSession`).
- The review panel refreshes on events, not on every render; an agent finishing
  while a different card is selected leaves stale data behind Refresh.
- A `Fixes <id>` commit-message watcher (PLAN.md §9). The `set_phase`
  description no longer promises one.

## Recent changes

- 2026-09-26 · claude/self-checkout-harness-overview-cvpkyy · `agentsKanban.qualityGate` (check/require/off) and `agentsKanban.checks` (parsed by `checksConfig`); `checkWorktree` feeds the manager's `quality`; `runCardQuality` runs the FULL checks after a card reaches review, AFTER the browser check (both start processes in the worktree), stamps `testPlan.quality`, and warns with Send to agent when it fails; `sendQuality`/`runQuality` host methods and dispatch; `CardState.qualityChecking`.

- 2026-09-26 · claude/self-checkout-harness-overview-cvpkyy · `queueStore` on workspace state (`agentsKanban.queue`); `rebuild()` makes the manager and calls `restoreQueue()` when a saved queue exists; the 60s heartbeat calls `manager.checkDue()`; `UiLimit.source`.

- 2026-09-26 · claude/self-checkout-harness-overview-cvpkyy · the `agentsKanban.usageLimits` enum (`resume`/`pause`/`off`) replaces the `resumeAfterLimit` boolean, passed as `limitMode` (read at every decision); `uiParked` carries `stoppedTasks` to the card.

- 2026-09-26 · claude/self-checkout-harness-overview-cvpkyy · usage limits: `resumeAfterLimit` setting and `providerFor: sessionProviderFor` into the manager; `rebuild()` makes the manager and calls `restoreParked()` when any card is parked; the board pass builds `UiState.limits` (`UiLimit`, `accountLabel`) and `CardState.parked` (which suppresses `stalled`); `resumeParked`/`holdParked` host methods and dispatch cases; the status bar says `Usage limit · back HH:MM` when nothing needs you; the 60s tick repaints while anything is limited.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · `watchBrowser` — the live browser pane: per SURFACE, matching the card's current run and its auto-check tab, frames on their own `browserFrame` channel (editor-only; cleared when a view reloads); the Run button runs a worktree's setup first under a progress notification (a failed step is a modal) and gives its terminals `recipe.env`; the auto-check is handed the agent's visited pages.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · `agentsKanban.autoVerify` (`check` default, `require`, `off`): on a move into review the host runs `runCardAutoCheck` in the background (cards carry `autoChecking`), writes `autoCheck` onto the plan as it stands then (only while still in review), and a failure is a warning with Open card / Send failure to agent; host `sendAutoCheck` / `runAutoCheck`; the manager gets `autoVerify`.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · setting `agentsKanban.maxSpendPerMessageUsd` (0 = off), handed to the manager as `spendCapUsd`.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · the board pass derives `attention` once from the cards it built; the slice carries it (omitted when empty) and the status bar leads with `attentionSummary` (`$(bell) 2 waiting on you · 3 more need you`).
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · review comments: a `agentsKanban.review` comment controller (registered unconditionally) whose `commentingRangeProvider` offers the + only on files inside a card's worktree (`cardForPath`: live runs, the store, then the sidecar); `agentsKanban.reviewComment.add` / `.delete` (comment menus, hidden from the palette) and `agentsKanban.sendReview`; host `sendReview` / `discardReview`; cards carry `reviewComments`; drafts follow a card's key in `applyRedirects`. First use of `vscode.comments`.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · `forkAt` restores from the git checkpoint when one exists for the anchor (modal names files restored, files removed, commits undone), falling back to Claude Code's file history; removing a worktree drops its checkpoints.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · composer gains `imagesUnsupported` (the selected session's runtime has `capabilities.images` false) and `imageLoadNote` (not-running path only, off the cached parse); a `sentImages` webview message (editor-only) answers with one message's images on its own channel.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · `askTestPlan` is a no-op without a worktree to resume into (an unknown key used to resume a session id nobody had — a real CLI process, and on a machine with `claude` on PATH a live agent that failed smoke's update-button block); the widened transcript window follows a card's key change in `applyRedirects`.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · an ENDED run (done/error, with a session id) is drawn off disk like any other session plus its own notes (`withRunNotes`) — it used to stay on its launch-time `history`, so after any run there was no "Load earlier", search missed older messages, fork buttons were missing on the newest prompts, and its rows changed on reload; `loadOlderTranscript`, `openHit` and search treat only in-flight runs as fixed; `transcriptHead` is counted before the notes go in.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · the agents' harness is made here — one `AppProcesses` and one `BrowserPool` per window (options read at launch, torn down on dispose), handed to `AgentManager` as `harness` unless `agentBrowser` is off; removing a worktree stops its agent app first; a test-plan file link may also point into extension storage `screens/` (the one place outside the worktree), opened with `vscode.open`; four new settings: `agentBrowser`, `browserExecutable`, `browserAllowExternal`, `browserHeaded`; `playwright-core` is a runtime dependency.
- 2026-09-24 · main · the model cache records the CLI version that wrote it and is re-asked when it moves; the picker names that version and offers "Update Claude Code…" when VS Code's own Claude Code extension is newer; `updateClaude()` behind a row, a settings button and the `updateClaudeCode` command; first `vscode.extensions` use.
- 2026-09-10 · claude/frontend-sync-chat-freeze-wb6a2s · **a repository could
  name the binary we spawn.** The four executable-path settings declared no
  `scope`, and VS Code's default (`window`) lets a workspace file override the
  user's value — so cloning a project and starting an agent ran whatever path
  that project's `.vscode/settings.json` chose, as the user, with no prompt.
  They are `scope: "machine"` now, and the manifest declares
  `untrustedWorkspaces.supported: false`, which is the lock that also covers
  `runCommand` (a shell command that stays workspace-settable on purpose — a
  per-project run command is a real thing people want, and behind trust it is a
  choice rather than a gift). The gate checks the NAME SHAPE, not a list of
  four, so the fifth `…Executable` cannot arrive with the old default.

- 2026-09-10 · claude/frontend-sync-chat-freeze-wb6a2s · second review pass, two
  fixes. `defaultVanished`: a surface with NO watch of its own follows the host's
  selection, and when that card left the board the explanation went with it —
  the panel simply arrived on the new-session screen. Reachable, because
  `openSession` (the side bar's session list) drops every local watch back to
  the default and a phone deleting that card then says nothing. The claim stands
  until something is selected; clearing it on the next repaint means no surface
  ever sees it, which is how the first attempt failed its own gate. And a
  DISPOSED `RemotePusher` no longer calls `onAnswer`/`onStatus`: a push already
  in flight lands after `syncRemoteEngine` has torn the engine down, and its
  callbacks close over the relay the user just moved away from — a late
  `viewers: true` believed about a relay that does not keep slots pushes every
  page into one frame and the board stops moving for all of them.

- 2026-09-09 · claude/frontend-sync-chat-freeze-wb6a2s · review pass over the
  per-viewer work, three fixes. `Watches.hostSelect` takes the remote SURFACE
  rather than a boolean and `dialogs.ts` carries it
  (`remoteDispatchSurface()`): it hardcoded `'remote'`, so a page starting a
  session, opening a search hit or forking a card moved the SHARED slot's watch
  and the page that asked was left behind. A remote message is dispatched under
  `remote` rather than `remote:<viewer>` until the relay has said it keeps slots
  (`relayKeepsSlots`), or against a contract-v3 relay a page's tap was recorded
  under a name nothing pushes and swallowed. And `sendModels` gates on
  `carriesModels(sink)`, not `sink === 'remote'` — that equality stopped being
  right the moment there was a slot per page, and every named push formatted and
  discarded a 431-entry catalogue. `VIEWERS_MAX` now comes from
  `src/remote/pusher.ts` and is pinned against the contract by
  `check-contract.mjs`. All shown to fail.

- 2026-09-09 · claude/frontend-sync-chat-freeze-wb6a2s · `StateSink` gained
  `remote:<viewer>`: one frame slot per remote page (relay contract v4), so the
  host keeps a `RemotePusher` per slot (`remotePushers`) and dispatches each
  remote message under the sink of the page that sent it. `painted` now holds
  the board PASS rather than a state, because a state built at repaint time is
  one page's and the others would redo the expensive half.

- 2026-09-09 · claude/frontend-sync-chat-freeze-wb6a2s · the host's redirects
  became announcements. `UiState.vanished` names the key a surface is watching
  that has no card, instead of `followAll` silently clearing the watch; a fork
  moves every watcher of the old key (`Watches.retarget`) rather than only the
  host's own selection, which missed a remote page that asked for a fork of a
  card the editor was not on. Gates: `watches.test.ts`, `webview.test.mjs` and
  smoke's "the host names the key that has no card", each shown to fail.

- 2026-09-09 · claude/frontend-sync-chat-freeze-wb6a2s · `getState()` split into
  `boardPass()` (once per repaint, identical for everyone) and
  `sessionSlice(pass, sink, watch)` (per WATCHER, never per card), and the
  `mode`/`selectedKey` pair of host globals replaced by `Watches`
  (`src/board/watches.ts`) keyed by `StateSink`. The side bar, the editor panel
  and a remote page can now be on three different sessions at once; before this
  every surface was a mirror of one pair of globals, so opening a chat anywhere
  retargeted everywhere. `followKey` moved into the slice and into
  `applyRedirects`, because the run-id -> session-id swap is per watcher. The
  catalogue memo (`sentCatalogue`) is now a Map keyed by sink, and `onReady`
  clears one entry rather than all of them. The host's own selection survives as
  what a brand-new surface opens first and what a command acts on, and a REMOTE
  sink never moves it (`isLocalSink`). Review data is keyed by session
  (`reviews`), bounded by `watches.keys()`. Gates: `watches.test.ts` and smoke's
  "the side bar and the panel can be on two different sessions"; all shown to
  fail with each fix reverted. `isRemoteDialog` renamed to `isRemoteDispatch`:
  it always answered "did this dispatch come from the page", and the host now
  reads it for selection as well as for dialogs.

- 2026-09-08 · claude/frontend-sync-chat-freeze-wb6a2s · `BoardHost.onUserAction`
  — the one signal that a PERSON did something, as opposed to a board moving on
  its own. `dispatchBoardMessage` is the single funnel every webview message
  passes through, local panel and remote page alike, and everything else that
  repaints (a streamed token, an mtime, the background-agent tick) arrives
  through the manager instead — so this is the only place that can tell the two
  apart. The host answers it with an urgent relay push. The message poll was
  reworked with it: it HOLDS the request open where the relay can, loops
  straight back on a holder, and keeps its timer for the three cases that need
  one (a relay that cannot hold, a poll that failed, and an idle board with no
  watcher, which must not hold a connection open for nobody).
- 2026-09-08 · claude/frontend-sync-chat-freeze-wb6a2s · the push path stopped
  paying twice and stopped stealing the webview's catalogue. `paint` records the
  state it built (`painted`) and `buildRemoteSnapshot` reuses it inside
  `MIN_INTERVAL` instead of running a second `getState()`; `getState(audience)`
  keys the model memo per audience so a relay push can no longer mark the
  catalogue sent on the local composer's behalf. `syncRemoteEngine` and the
  activation subscription now `dispose()` the pusher, because it can hold an
  armed trailing tick closed over the OLD relay URL.
- 2026-09-07 · task/S968q-split-the-relay-repo-out · package.json grew the
  `relayRepo` field and `verify` gained the relay-contract step
  (scripts/check-contract.mjs) between the tests and smoke.
- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
