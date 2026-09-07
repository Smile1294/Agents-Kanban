---
name: extension-host
description: The VS Code surface — activation, commands, the host behind every webview message, getState() and the coalesced repaint, the settings tab, the manifest
paths:
  - src/extension.ts
  - src/board/panel.ts
  - src/board/settings.ts
  - src/board/coalesce.ts
  - package.json
tests:
  - smoke.mjs
  - src/board/__tests__/coalesce.test.ts
  - src/board/__tests__/settings-view.test.mjs
  - test/package.test.mjs
last_verified: 2026-09-07
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
`host.getState()`; `paint` = `coalesce(async () => {getState → provider.post →
BoardPanel.postCurrent → refreshStatus}, REPAINT_INTERVAL_MS)` and `refreshAll =
() => paint.schedule()` — the ONLY repaint entry point; the settings-page
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
/ `FocusMode`, `showSideBarView`, `toUiAgent`, `readImages`, `summarise`. Private
but load-bearing: `wire()` — the board webview's `switch (msg.type)`, shared by
both surfaces; `html()` — the CSP'd document (`board.css` + `board.js`, nonce,
`data-layout="board"|"control"`); `forControl()` — what the side bar is sent.
Test: `smoke.mjs` §live wiring and §view contract; `src/remote/__tests__/cards.test.ts`
imports `UiCard` as its redaction fixture.

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
npm scripts (every one starts with `node scripts/preflight.mjs`); the two
runtime dependencies (`@anthropic-ai/claude-agent-sdk`, `zod` — both externals).
Test: `smoke.mjs` §manifest (declared ↔ registered), `test/package.test.mjs`.

## How it works

**Board webview → host.** The view posts `{type, …}`; `wire()` in `panel.ts`
switches on `type` and calls the matching `BoardHost` method, implemented on the
`host` object in `extension.ts`. Groups: lifecycle (`ready`, `init`,
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
nothing"; `host.onReady` resets `sentCatalogue`, so the next state carries the
full model list. Every later frame OMITS `composer.models` when the list is the
one the view already has (`sendModels`), because a 431-entry catalogue was
161 KB of a 326 KB frame posted ten times a second.

**Settings webview → host.** `media/settings.js` posts; `parseMessage` in
`settings.ts` validates; the `switch` in `extension.ts` acts. Groups: page
(`ready`, `refresh`); runtimes (`setDefaultRuntime`, `install`, `signIn`,
`refreshModels`); providers (`selectProvider`, `addProvider`, `editProvider`,
`removeProvider`, `testProvider`, `refreshEndpoint`, `setProfileModels`,
`setSpawnAllowed`); shell-outs (`openSetting`, `openUrl`, `copyText`);
dictation (`checkVoice`); schedules (`saveSchedule`, `removeSchedule`,
`toggleSchedule`, `runSchedule`); remote (`setRemote`, `saveRemote`,
`setRemoteWrites`, `clearRemoteCode`).

**The repaint.** Any event → `refreshAll()` → `paint.schedule()` → one
`getState()` → posted to both surfaces → `remotePusher.nudge()`. `getState()`
runs up to ten times a second while an agent streams and is therefore the render
path: the model catalogue is formatted once per state, the review data is
loaded on events (select, commit, merge, the selected agent finishing) and not
recomputed here, keychain reads and the microphone facts are memoised.

**Focus mode.** `applyBoardFocus` closes the bottom panel and the secondary
side bar while the board is in front and restores them when it leaves.
**The primary side bar is never touched** — not closed, not collapsed, not
resized; the icon click that closes the board reopens the side bar first, so a
restoring toggle closed it instead (nine attempts, see DECISIONS.md). The side
bar is handed back to `agentsKanban.sideBarHome`.

## Change recipes

- **A new board message.** `media/board.js` posts it → a `case` in `wire()`
  (`panel.ts`) → a method on `BoardHost` and on `const host` in `extension.ts`.
  The smoke gate "every inbound message is handled" sweeps every `post(...)`
  name in the view against the switch.
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
- **Never swallow a rejection with a bare `void`.** A broken `getState()` once
  became a silently blank panel.
- **An editor opened from the board opens BESIDE it, inside `ownLayoutChange`.**
  A file opened into the board's group evicts the webview, and that is the very
  event the click-away rule closes on.
- **A refusal on a path the user clicked is modal, never a toast.**
- **The side bar is sent nothing it does not draw.** `forControl()` drops
  `transcript`, `streaming`, `review` — drops, never empties.
- **A merge that starts mid-turn must repaint.** `s.pendingMerge` is in
  `chromeSig()` for that reason.

## Open work

- Permission prompts do not survive a window reload (held on the `AgentSession`).
- The review panel refreshes on events, not on every render; an agent finishing
  while a different card is selected leaves stale data behind Refresh.
- A `Fixes <id>` commit-message watcher: the `set_phase` description promises
  one, nothing implements it (see PLAN.md §9).

## Recent changes

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
