/** The webview surface, in two places and two modes.
 *
 * Places: a compact WebviewView in the sidebar, and a full WebviewPanel in the
 * editor area. Both render the same app.
 *
 * Modes: `kanban` (every session as a card, grouped by phase) and `chat` (one
 * session's transcript). A card and a session are the same thing seen at two
 * zoom levels, which is why switching modes never changes what exists.
 *
 * Neither surface holds state. They render what the host hands them.
 */
import * as vscode from 'vscode'
import type { RunningAgent } from '../agent/manager.ts'
import type { WorktreeReview } from '../git/worktree.ts'
import type { Entry } from '../sessions/store.ts'
import type { AttachedImage } from '../agent/images.ts'
import type { TestPlan } from '../sessions/meta.ts'
import type { Meter } from '../agent/runtime.ts'
import type { SlashCommand } from '../sessions/commands.ts'
import type { ColumnDef } from './config.ts'
import { parseAskQuestions, type AskQuestion } from './questions.ts'

export type Mode = 'kanban' | 'chat'

/**
 * How much of the window the board takes when it is open.
 *
 * The board is a workspace of its own — five columns, a session rail and a
 * transcript — and squeezed into the editor area beside a terminal and a chat
 * panel it is too narrow to use. Nimbalyst gets a full window for free by being
 * a whole application; here it has to be asked for.
 *
 *  - `off`   never touch the layout
 *  - `wide`  while the board is open the terminal and the secondary side bar
 *            step aside, and both come back when it closes
 *  - `zen`   VS Code's own Zen Mode, which also hides the activity and status
 *            bars and restores the previous layout itself
 *
 * THE PRIMARY SIDE BAR IS NOT TOUCHED. Not closed, not collapsed, not resized.
 * It is the one part of the window that is never this extension's to take: it
 * is where your files are and it is how you get back.
 *
 * That is a correction, not a preference. A previous version collapsed it on the
 * way in and ran `toggleSidebarVisibility` on the way out, and the two do not
 * cancel — because the icon click that closes the board ALSO reopens the side
 * bar, so the toggle that was meant to restore it closed it instead. Worse,
 * clicking Explorer while the board was open opened the side bar, closed the
 * board, and the restore then collapsed the Explorer you had just asked for.
 * The left bar disappeared on almost every path through this code.
 *
 * Only two of the four workbench areas are ours, so only two commands appear
 * here. Handing the side bar back to the view the icon click stole it from is a
 * separate job, done by `showSideBarView` below.
 */
export type FocusMode = 'off' | 'wide' | 'zen'

let focusMode: FocusMode = 'off'
/** Whether WE changed the layout, so we only ever undo our own change. */
let focusApplied = false

export function setBoardFocusMode(mode: FocusMode): void {
  focusMode = mode
}

export function boardFocusApplied(): boolean {
  return focusApplied
}

/** Test seam: forget any applied state between activations. */
export function _resetBoardFocus(): void {
  focusApplied = false
}

/**
 * Take the window, or give it back.
 *
 * Closing uses the `close*` commands, which do nothing when the thing is already
 * closed; restoring uses the `toggle*` ones, which is safe precisely because we
 * are the ones who closed them, and because nothing else in the window can have
 * reopened them in between. VS Code exposes no way to read the current layout,
 * so `focusApplied` is the only record that the change was ours.
 *
 * That "nothing else can have reopened them" is exactly what stopped being true
 * of the side bar once it was added here, and why it is no longer in this list.
 * The activity-bar icon reopens the side bar as part of the very click that
 * closes the board, so the restoring toggle found it open and closed it.
 */
export async function applyBoardFocus(on: boolean, mode: FocusMode = focusMode): Promise<void> {
  if (mode === 'off') return
  const run = async (...ids: string[]) => {
    for (const id of ids) {
      try { await vscode.commands.executeCommand(id) } catch { /* older VS Code */ }
    }
  }

  if (mode === 'zen') {
    // Zen Mode is a single toggle, so it is the one case that must not repeat.
    if (on === focusApplied) return
    focusApplied = on
    await run('workbench.action.toggleZenMode')
    return
  }

  if (on) {
    // Not guarded by `focusApplied`: these are `close*` commands, so repeating
    // them on something already closed does nothing, and re-running is harmless.
    focusApplied = true
    await run('workbench.action.closePanel', 'workbench.action.closeAuxiliaryBar')
    return
  }

  // Restoring, by contrast, uses toggles and must happen exactly once.
  if (!focusApplied) return
  focusApplied = false
  await run('workbench.action.togglePanel', 'workbench.action.toggleAuxiliaryBar')
}

/**
 * Hand the primary side bar back to the view it was showing.
 *
 * Clicking an activity-bar icon makes VS Code show that extension's view in the
 * side bar. There is no API to prevent it and no API to ask what was there
 * before — so the board's icon unavoidably evicts your Explorer for as long as
 * it takes us to put it back, which is what this does.
 *
 * `which` is a `workbench.view.*` command id and comes from a setting, not from
 * a guess. An earlier version hardcoded the Explorer, which was wrong for
 * anyone who lives in Source Control; empty means "leave it wherever the click
 * put it", which is the honest option for anyone who would rather we did not
 * choose at all.
 */
export async function showSideBarView(which: string): Promise<void> {
  const id = which.trim()
  if (!id) return
  await vscode.commands.executeCommand(id)
}

export interface UiCard {
  /** sessionId when Claude Code has assigned one, else the local run id. */
  key: string
  sessionId?: string
  title: string
  phase: string
  tags: string[]
  updated: number
  archived?: boolean
  pinned?: boolean
  branch?: string
  worktree?: string
  /** The card this one was split out of, and its title — so a subtask says
   *  where it came from without the view having to look it up. */
  parent?: string
  parentTitle?: string
  /** The cards split out of THIS one. Present only on a parent, and the answer
   *  to "what do I test, and when": each subtask is tested on its own, and the
   *  parent is ready when all of them are. */
  subtasks?: { key: string; title: string; phase: string; ready: boolean }[]
  /**
   * One line about how this card's work was divided — or why it was not.
   *
   * DERIVED host-side from the stored record, never a string the record holds,
   * so a wording change cannot make old cards lie. It exists because a REFUSED
   * split used to reach the model and nothing else: a session that tried to
   * split, was refused, and did the work alone was byte-identical on the board
   * to the correct adaptive outcome. On a feature whose whole principle is
   * adaptivity, that is the feature working and the feature broken rendering
   * the same.
   */
  decomposition?: { line: string; stated?: string; refused: boolean }
  /** How to test this session's work, if the agent said. */
  testPlan?: TestPlan
  /**
   * When a run was cut off by the extension host going away — a reload, a
   * reinstall, a crash. The process is gone and cannot be re-attached; the
   * session can be resumed. The TIME is carried, not a flag, because "cut off
   * 3 minutes ago" and "cut off last Tuesday" call for different reactions and
   * a bare badge cannot tell them apart.
   */
  interrupted?: number
  /** Follow-ups typed while this turn is still running. */
  queued?: string[]
  agent?: {
    kind: string
    /** When a queued run was accepted. The card shows its age, so "waiting for
     *  a slot" is a number rather than a claim. */
    since?: number
    tool?: string
    /** What a Task's subagent is running, so a long Task is not a dead row. */
    subagent?: string
    /** When the CLI last emitted anything. The view shows its AGE — a claim the
     *  user can check, unlike a dot that pulses whether or not anything moved. */
    lastEventAt?: number
    message?: string
    costUsd?: number
    contextTokens: number
    contextWindow?: number
    /** The backend the CLI reported this run is ACTUALLY on, and its label.
     *  Not the profile that was requested — see AgentSession.checkProvider. A
     *  card only carries it once the CLI has answered, so an older CLI shows
     *  nothing rather than the provider we hoped for. */
    resolvedProvider?: string
    providerLabel?: string
    /** `questions` is set only for AskUserQuestion, and turns the Allow/Deny
     *  prompt into a real picker. Without it the view has nothing to show but
     *  the tool's name, which is how a question could be "allowed" and never
     *  answered. See board/questions.ts. */
    pendingPermission?: {
      id: string; summary: string; waiting?: number; questions?: AskQuestion[]
      /** The RUNTIME's own rendered sentence, when it gave one. Codex sends
       *  "Codex wants to run: rm -rf build" and it was computed and then
       *  dropped here — so a Codex patch approval rendered as "Claude wants to
       *  run / Edit", naming the wrong vendor and withholding the file list on
       *  a dialog that authorises a write to the user's worktree. */
      prompt?: string
    }
  }
}

export interface UiState {
  ready: boolean
  /** No folder is open, so there is nothing to show yet. */
  noWorkspace?: boolean
  /** A folder is open but it is not a git repository, so agents cannot run. */
  noRepo?: boolean
  mode: Mode
  selectedKey?: string
  showArchived?: boolean
  columns: ColumnDef[]
  cards: UiCard[]
  /** Only for the selected session — sending every transcript would be wasteful. */
  transcript?: Entry[]
  /** The block currently streaming in, appended after `transcript`. */
  streaming?: string
  /** What the selected session changed in its worktree. Computed on demand, not
   *  on every refresh — it costs four git calls and refreshes fire per token. */
  review?: WorktreeReview
  /** Set while a merge is in progress so the view can disable the button. */
  busy?: string
  /** True while the board has taken over the window. */
  focused?: boolean
  /** True while the board is open in the editor — what the side bar toggles. */
  boardOpen?: boolean
  /** `.claude/commands/*.md`, for the composer's `/` autocomplete. */
  commands?: SlashCommand[]
  /**
   * Which collapsible sections the user has opened or closed.
   *
   * Seeds the view's own map on the FIRST state message and is ignored after
   * that. It has to be one-way: the view is where the clicks happen, and a
   * host copy that kept being applied would race the click that produced it —
   * which is the bug this whole mechanism exists to fix, in a new place.
   */
  disclosures?: Record<string, boolean>
  composer: {
    model: string
    effort: string
    thinking: string
    /**
     * The models to offer, with the two facts that make a list of ids a
     * CHOICE: how much context each one has, and what it costs.
     *
     * `context` is the label (`1M`, `128K`, `?`) and `price` is the shorthand
     * (`$0.28/$0.42 per Mtok`, `Free`). Both are formatted host-side, in
     * `models.ts`, so the two surfaces that show them cannot round money
     * differently — and so `board.js` does no arithmetic on a price at all.
     * `price` is ABSENT rather than "unknown" when nothing published one: a
     * blank says "not stated", where `$0.00` would say "free".
     */
    models: {
      id: string; label: string; context: string; detail?: string
      contextTokens?: number; price?: string
    }[]
    /** The effort levels THIS model accepts. Empty means it accepts none, and
     *  the control must disappear: Haiku 4.5 was being shown a five-level
     *  picker it ignores, which is a control that cannot say "no". */
    efforts: { key: string; label: string }[]
    /** False when the selected model has no adaptive thinking, so the toggle
     *  should not be drawn either. */
    thinkingSupported?: boolean
    /** Ultracode: xhigh effort plus standing workflow orchestration. Offered
     *  ONLY when the CLI says this model can run it — the flag itself is
     *  accepted without validation, so the capability gate is the only check
     *  available before the run starts. */
    ultracode?: boolean
    ultracodeSupported?: boolean
    fastMode?: boolean
    fastModeSupported?: boolean
    /** Where the model list came from — `endpoint` (the custom endpoint's own
     *  answer), `cli` (Claude Code's), `profile` (declared in settings), or
     *  `builtin` (the fallback). Shown in the picker, because "why is Fable
     *  missing?" is only answerable if you can see whether we managed to ask —
     *  and because `cli` against a custom endpoint is a list about Claude Code
     *  rather than about that endpoint. */
    modelSource?: string
    /** Why the CLI's list is not in use, when it is not. */
    modelNote?: string
    contextTokens: number
    contextWindow?: number
    /**
     * What the selected session has consumed, in the unit its runtime can
     * justify. Present whether or not it is running: a finished session's
     * figure is totalled from its transcript, which is why it survives a
     * restart.
     *
     * A `Meter`, not a dollar figure, and that is the whole point. This was
     * `spentUsd` + `spendPriced`, and `spend` is emitted by exactly ONE runtime
     * — so every Codex session, live or finished, arrived here as `0` and the
     * bar read **`$0.00`** on a card that had just spent 13% of a five-hour
     * window. That is not a rounding problem, it is the signal-that-cannot-say-
     * bad rule broken on the readout the rule was written for.
     *
     * The view renders three cases and `unknown` must render as "—", never as
     * zero. Serialised through `structuredClone` to the webview, so it stays a
     * plain object.
     */
    meter?: Meter
    permissionMode: string
    permissionModes: { key: string; label: string; detail: string }[]
    /** Which agent program the NEXT session runs on. */
    /**
     * The (agent program × backend) combination the next session runs on, as
     * one key — `claude|openrouter`.
     *
     * ONE picker, not two, and that is the point. The two were a cross product
     * the user had to do in their head: the bar said "Claude Code" while the
     * model list was DeepSeek's, because the backend was chosen on a different
     * screen. Reported as *"how the fuck does that make sense"*, and fairly.
     * Now every runnable combination is one entry, and picking it sets both.
     */
    agent: string
    /** Every combination available on this machine. A runtime that is not
     *  installed is ABSENT rather than disabled: it is not a thing you can run
     *  on, and a session started on it fails at its first step. */
    agents: {
      key: string; label: string; detail: string; runtime: string; provider: string
    }[]
    runtime: string
    /** Every agent program this build can drive. `providerProfiles` is carried
     *  so the chip can name a backend only where one is a real choice — a Codex
     *  session has nothing behind it to name, and inventing one would be the
     *  board claiming a provider that is not billing anything. */
    runtimes: { id: string; label: string; detail?: string; providerProfiles: boolean }[]
    /** The provider profile the NEXT session will run on. */
    provider: string
    /** Everything selectable. `support` is carried so the view can mark a
     *  community setup as one, rather than listing it beside Bedrock as though
     *  Anthropic supported it. */
    providers: { id: string; label: string; detail: string; support: string }[]
    /**
     * Something the user needs to know about the provider, in one sentence.
     *
     * Carries the two cases a picker cannot: a profile that is missing a
     * required field (so no session can start on it), and a live run whose CLI
     * reported a DIFFERENT backend from the one this profile asked for. The
     * second is the important one — it is the only way an outranked profile
     * becomes visible instead of being believed.
     */
    providerNote?: string
  }
  running: number
  waiting: number
}

export interface BoardHost {
  getState(): Promise<UiState>
  init(): Promise<void>
  openFolder(): Promise<void>
  setMode(mode: Mode): void
  select(id: string | undefined): void
  newSession(prompt: string, images?: AttachedImage[]): Promise<void>
  sendMessage(id: string, text: string, images?: AttachedImage[]): Promise<void>
  move(key: string, phase: string): Promise<void>
  stop(key: string): Promise<void>
  /** End this turn, keep the session. Distinct from stop(), which ends the run. */
  interrupt(key: string): Promise<void>
  /** Pick a session back up after its run was killed by a host restart. */
  resume(key: string): Promise<void>
  /** Accept that a killed run is not coming back, and clear its banner. */
  dismissInterrupted(key: string): Promise<void>
  clearQueue(key: string): Promise<void>
  openWorktree(key: string): Promise<void>
  /** Start the app in this session's worktree and open it in the browser. */
  runWorktree(key: string): Promise<void>
  /** `selections` is set only when the user filled in an AskUserQuestion
   *  picker. The answer strings are built host-side; see agent/session.ts. */
  answerPermission(
    key: string,
    requestId: string,
    allow: boolean,
    selections?: Record<string, string[]>,
  ): void
  refreshReview(key: string): Promise<void>
  openDiff(key: string, file: string): Promise<void>
  openTestLink(key: string, kind: string, target: string): Promise<void>
  commitWorktree(key: string): Promise<void>
  mergeWorktree(key: string): Promise<void>
  archive(key: string, archived: boolean): Promise<void>
  pin(key: string, pinned: boolean): Promise<void>
  remove(key: string): Promise<void>
  rename(key: string, title: string): Promise<void>
  /** The user opened or closed a collapsible section. Remembered so it stays
   *  that way — including across closing and reopening the board. */
  setDisclosure(key: string, open: boolean): void
  setComposer(patch: {
    model?: string; effort?: string; thinking?: string; permissionMode?: string
    provider?: string; runtime?: string; orchestration?: string; ultracode?: string; fastMode?: string; forKey?: string
    /** `<runtime>|<providerId>` — both halves at once, so the two switches
     *  cannot race each other's model refresh. */
    agent?: string
  }): void
  toggleArchived(): void
  /** Give the board the whole window, or hand it back. */
  toggleFocus(): Promise<void>
  /** Open the full board in the editor area. */
  openBoard(): Promise<void>
  /** Close it and put the panels back. */
  closeBoard(): Promise<void>
  /** Open the board on one session's transcript. */
  openSession(key: string): Promise<void>
  /** Ask for a prompt, then start a session. */
  newSessionPrompt(): Promise<void>
  /** Open the provider quick pick. Reached from the last entry of the composer's
   *  provider menu, which is how a FIRST provider gets configured — a picker
   *  that could only choose between profiles that already exist would leave the
   *  feature reachable only from the command palette. */
  selectProvider(): Promise<void>
  /** Open the settings tab: agents, backends and logins. Synchronous because
   *  showing a panel is not something to await — the page fills itself in. */
  openSettings(): void
}

/** Shared message plumbing for both the sidebar view and the editor panel. */
function wire(webview: vscode.Webview, host: BoardHost, refresh: () => Promise<void>): vscode.Disposable {
  return webview.onDidReceiveMessage(async (msg: Record<string, unknown>) => {
    try {
      const id = () => String(msg.id ?? '')
      switch (msg.type) {
        case 'ready': await refresh(); break
        case 'init': await host.init(); break
        case 'openFolder': await host.openFolder(); break
        case 'setMode': host.setMode(msg.mode === 'chat' ? 'chat' : 'kanban'); refresh(); break
        case 'select': host.select(msg.id ? String(msg.id) : undefined); await refresh(); break
        case 'newSession':
          await host.newSession(String(msg.text ?? ''), readImages(msg.images))
          break
        case 'send':
          await host.sendMessage(id(), String(msg.text ?? ''), readImages(msg.images))
          break
        case 'move': await host.move(id(), String(msg.phase)); break
        case 'stop': await host.stop(id()); break
        case 'interrupt': await host.interrupt(id()); await refresh(); break
        case 'resume': await host.resume(id()); await refresh(); break
        case 'dismissInterrupted': await host.dismissInterrupted(id()); await refresh(); break
        case 'clearQueue': await host.clearQueue(id()); await refresh(); break
        case 'openWorktree': await host.openWorktree(id()); break
        case 'run': await host.runWorktree(id()); break
        case 'review': await host.refreshReview(id()); await refresh(); break
        case 'diff': await host.openDiff(id(), String(msg.file ?? '')); break
        case 'testLink':
          await host.openTestLink(id(), String(msg.kind ?? ''), String(msg.target ?? ''))
          break
        case 'commit': await host.commitWorktree(id()); await refresh(); break
        case 'merge': await host.mergeWorktree(id()); await refresh(); break
        case 'archive': await host.archive(id(), msg.archived !== false); break
      case 'pin': await host.pin(id(), msg.pinned !== false); break
        case 'remove': await host.remove(id()); break
        case 'rename': await host.rename(id(), String(msg.title ?? '')); break
        case 'disclosure':
          host.setDisclosure(String(msg.key ?? ''), msg.open !== false)
          break
        case 'composer':
          host.setComposer({
            ...(msg.model ? { model: String(msg.model) } : {}),
            ...(msg.effort ? { effort: String(msg.effort) } : {}),
            ...(msg.thinking ? { thinking: String(msg.thinking) } : {}),
            ...(msg.permissionMode ? { permissionMode: String(msg.permissionMode) } : {}),
            ...(msg.provider ? { provider: String(msg.provider) } : {}),
            ...(msg.runtime ? { runtime: String(msg.runtime) } : {}),
            ...(msg.agent ? { agent: String(msg.agent) } : {}),
            ...(msg.orchestration ? { orchestration: String(msg.orchestration) } : {}),
            ...(msg.ultracode ? { ultracode: String(msg.ultracode) } : {}),
            ...(msg.fastMode ? { fastMode: String(msg.fastMode) } : {}),
            ...(msg.id ? { forKey: id() } : {}),
          })
          refresh()
          break
        case 'toggleArchived': host.toggleArchived(); await refresh(); break
        case 'focus': await host.toggleFocus(); await refresh(); break
        case 'openBoard': await host.openBoard(); break
        case 'closeBoard': await host.closeBoard(); break
        case 'openSession': await host.openSession(id()); await refresh(); break
        case 'newSessionPrompt': await host.newSessionPrompt(); break
        case 'selectProvider': await host.selectProvider(); break
        case 'openSettings': host.openSettings(); break
        case 'permission':
          host.answerPermission(id(), String(msg.requestId), Boolean(msg.allow), selectionsOf(msg.selections))
          break
      }
    } catch (e) {
      vscode.window.showErrorMessage(`Agents Kanban: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri, layout: 'board' | 'control' = 'board'): string {
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f))
  const nonce = nonceString()
  return `<!DOCTYPE html>
<html lang="en" data-layout="${layout}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('board.css')}" rel="stylesheet">
<title>Agents Kanban</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${uri('board.js')}"></script>
</body>
</html>`
}

/**
 * The side bar view: a control, deliberately not a board.
 *
 * Its real job is the TOGGLE. Clicking the activity-bar icon shows it, clicking
 * it again collapses the side bar and hides it — and those two events are what
 * open and close the board. That works only because nothing here closes the side
 * bar itself; a view we hid could never report being switched away from, which
 * is the trap every earlier version fell into.
 */
export class BoardViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'agentsKanban.board'

  private readonly extensionUri: vscode.Uri
  private readonly host: BoardHost
  private readonly disposables: vscode.Disposable[] = []
  private view?: vscode.WebviewView
  private readonly onVisibility?: (visible: boolean) => void

  constructor(extensionUri: vscode.Uri, host: BoardHost, onVisibility?: (visible: boolean) => void) {
    this.extensionUri = extensionUri
    this.host = host
    this.onVisibility = onVisibility
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    }
    view.webview.html = html(view.webview, this.extensionUri, 'control')
    this.disposables.push(wire(view.webview, this.host, () => this.refresh()))
    view.onDidChangeVisibility(() => {
      if (view.visible) void this.refresh()
      this.onVisibility?.(view.visible)
    })
    view.onDidDispose(() => { for (const d of this.disposables.splice(0)) d.dispose() })
  }

  async refresh(): Promise<void> {
    // No visibility guard: posting to a hidden webview is harmless, and an early
    // return here is how the view ends up blank when the state message is the
    // only thing that ever paints it.
    if (!this.view) return
    await this.post(await this.host.getState())
  }

  /** Paint a state someone else has already computed.
   *
   *  Both surfaces used to call `getState()` for themselves, so every repaint
   *  did the work twice — and `getState()` reads Claude Code's whole session
   *  index. One state, two views. */
  async post(state: UiState): Promise<void> {
    if (!this.view) return
    await this.view.webview.postMessage({ type: 'state', state })
  }
}

/** The editor-area panel. This is the main surface. */
export class BoardPanel {
  private static current?: BoardPanel
  /** Set by the host: the board has actually closed, so put the layout back. */
  static onClosed?: () => void
  /** Set by the host: the user clicked away from the board. */
  static onLeft?: () => void

  private readonly panel: vscode.WebviewPanel
  private readonly host: BoardHost
  private readonly disposables: vscode.Disposable[] = []

  static show(extensionUri: vscode.Uri, host: BoardHost, column?: vscode.ViewColumn): BoardPanel {
    if (BoardPanel.current) {
      BoardPanel.current.panel.reveal(column ?? vscode.ViewColumn.Active)
      void BoardPanel.current.refresh()
      return BoardPanel.current
    }
    const panel = vscode.window.createWebviewPanel(
      'agentsKanban.panel',
      'Agents Kanban',
      column ?? vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    )
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'board.svg')
    BoardPanel.current = new BoardPanel(panel, extensionUri, host)
    return BoardPanel.current
  }

  static get isOpen(): boolean { return BoardPanel.current !== undefined }

  /** Is the board actually on screen right now? A `visible: false` event that
   *  arrives while it still is was a transient reshuffle, not the user leaving. */
  static get isVisible(): boolean { return BoardPanel.current?.panel.visible === true }

  /** Close the board outright. The board is a mode, not a document: leaving it
   *  should not park it in the editor area where your code belongs. */
  static close(): void {
    const open = BoardPanel.current
    // Cleared first, so the dispose it triggers does not come back round here.
    BoardPanel.current = undefined
    open?.panel.dispose()
  }
  static refreshCurrent(onError?: (e: unknown) => void): void {
    BoardPanel.current?.refresh().catch((e) => onError?.(e))
  }

  /** Paint a state the caller already has. See BoardViewProvider.post(). */
  static postCurrent(state: UiState): Promise<void> {
    return BoardPanel.current?.post(state) ?? Promise.resolve()
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, host: BoardHost) {
    this.panel = panel
    this.host = host
    panel.webview.html = html(panel.webview, extensionUri)
    this.disposables.push(wire(panel.webview, host, () => this.refresh()))
    panel.onDidChangeViewState(() => {
      if (panel.visible) { void this.refresh(); return }
      // Clicking away — a file, another tab — closes the board, the same as the
      // icon or the X. Guarded by the host, because closing three things at once
      // reshuffles focus and the webview reports `visible: false` while that
      // settles, which once closed the board immediately after opening it.
      BoardPanel.onLeft?.()
    }, null, this.disposables)
    panel.onDidDispose(() => this.dispose(), null, this.disposables)
  }

  async refresh(): Promise<void> {
    await this.post(await this.host.getState())
  }

  async post(state: UiState): Promise<void> {
    await this.panel.webview.postMessage({ type: 'state', state })
  }

  private dispose(): void {
    // Cleared before onLeave, so a host that responds by closing the board finds
    // nothing left to close rather than recursing.
    BoardPanel.current = undefined
    for (const d of this.disposables.splice(0)) d.dispose()
    this.panel.dispose()
    BoardPanel.onClosed?.()
  }
}

/**
 * Attachments as they arrive from the webview.
 *
 * Shaped here rather than trusted: the webview is another program by the time
 * this runs, and this data is about to be embedded in a message to a child
 * process. `sanitiseImages` does the format and size checks; this only gets it
 * into the right shape to be checked.
 */
export function readImages(raw: unknown): AttachedImage[] {
  if (!Array.isArray(raw)) return []
  const out: AttachedImage[] = []
  for (const item of raw.slice(0, 32)) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.data !== 'string' || typeof o.mediaType !== 'string') continue
    out.push({
      name: typeof o.name === 'string' ? o.name : 'image',
      mediaType: o.mediaType,
      data: o.data,
    })
  }
  return out
}

/** Narrow a `selections` payload posted by the webview.
 *
 * Checked rather than cast, because it decides what the agent is told the user
 * chose. Only arrays of non-blank strings survive; `undefined` when there is
 * nothing usable, so the session passes the original input straight through.
 * The selections are turned into answer strings host-side, against the tool's
 * own questions — see AgentSession.inputWith. */
function selectionsOf(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v)) continue
    const vals = v.filter((x): x is string => typeof x === 'string' && !!x.trim())
    if (vals.length) out[k] = vals
  }
  return Object.keys(out).length ? out : undefined
}

export function summarise(toolName: string, input: Record<string, unknown>): string {
  const name = toolName.replace(/^mcp__[^_]+__/, '')
  const detail =
    (typeof input.command === 'string' && input.command) ||
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.path === 'string' && input.path) ||
    (typeof input.url === 'string' && input.url) ||
    ''
  return detail ? `${name} — ${String(detail).slice(0, 200)}` : name
}

function nonceString(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

/** Map a live agent onto the card shape the UI renders. */
export function toUiAgent(a: RunningAgent): NonNullable<UiCard['agent']> {
  const s = a.state
  return {
    kind: s.kind,
    ...(s.kind === 'queued' ? { since: s.since } : {}),
    ...(s.kind === 'working' && s.tool ? { tool: s.tool } : {}),
    ...(s.kind === 'working' && s.subagent ? { subagent: s.subagent } : {}),
    ...(s.kind === 'error' ? { message: s.message } : {}),
    ...(a.lastEventAt ? { lastEventAt: a.lastEventAt } : {}),
    ...(a.costUsd !== undefined ? { costUsd: a.costUsd } : {}),
    contextTokens: a.contextTokens,
    ...(a.contextWindow !== undefined ? { contextWindow: a.contextWindow } : {}),
    ...(a.resolvedProvider ? { resolvedProvider: a.resolvedProvider } : {}),
    ...(a.providerLabel ? { providerLabel: a.providerLabel } : {}),
    ...(a.pendingPermission
      ? {
          pendingPermission: {
            id: a.pendingPermission.id,
            summary: summarise(a.pendingPermission.toolName, a.pendingPermission.input),
            // How many are waiting in total. One slot used to hold them all, so
            // a turn that asked twice showed one prompt and silently lost the
            // other; the count is what makes the rest visible rather than a
            // card that says "working" over a blocked agent.
            ...((a.pendingPermissions?.length ?? 0) > 1
              ? { waiting: a.pendingPermissions!.length }
              : {}),
            ...(a.pendingPermission.prompt ? { prompt: a.pendingPermission.prompt } : {}),
            ...(() => {
              const questions = parseAskQuestions(
                a.pendingPermission.toolName,
                a.pendingPermission.input,
              )
              return questions ? { questions } : {}
            })(),
          },
        }
      : {}),
  }
}
