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
`addProvider`, `testProvider`, `refreshModels`, `stopTask`, `archiveSession`,
`deleteSession`, `openWorktree`. Activation is `onStartupFinished`. Test:
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
no local `../agents-kanban-relay` exists. Test: `smoke.mjs` §manifest (declared
↔ registered), `test/package.test.mjs`.

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
`refreshModels`); providers (`selectProvider`, `addProvider`, `editProvider`,
`removeProvider`, `testProvider`, `refreshEndpoint`, `setProfileModels`,
`setSpawnAllowed`); shell-outs (`openSetting`, `openUrl`, `copyText`);
dictation (`checkVoice`); schedules (`saveSchedule`, `removeSchedule`,
`toggleSchedule`, `runSchedule`); remote (`setRemote`, `saveRemote`,
`setRemoteWrites`, `clearRemoteCode`).

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
- **A surface left watching a card that is gone is TOLD.** `UiState.vanished`
  carries the key. The surface it happens to is usually not the one that did it
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
- A `Fixes <id>` commit-message watcher: the `set_phase` description promises
  one, nothing implements it (see PLAN.md §9).

## Recent changes

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
