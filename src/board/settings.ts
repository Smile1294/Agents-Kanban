/** The settings page: an editor tab, not a menu.
 *
 * Everything here used to be a `showQuickPick`. That was fine while there was
 * one thing to choose, and stopped being fine as soon as there were two axes —
 * which agent program a session runs on, and which backend stands behind it.
 * A quick pick is the wrong surface for configuration for a specific,
 * reportable reason: **it closes when you look away.** Clicking the editor,
 * pressing Escape, or a notification stealing focus all dismiss it, and the
 * half-entered gateway URL goes with it. That is not a preference, it is a
 * control that loses your work.
 *
 * So this is a webview in an editor group, with `retainContextWhenHidden`, and
 * it stays open until you close it.
 *
 * ## What it does and does not own
 *
 * It owns **configuration**: which agent programs are installed, whether you
 * are signed into them, which one new sessions start on, and — for the runtimes
 * where the idea applies — provider profiles and their credentials.
 *
 * It does NOT own the per-session controls. Model, effort, thinking and the
 * session flags stay on the composer bar, because they are chosen per card,
 * next to the card, and changing them is part of writing a prompt rather than
 * part of setting the tool up. The user's own words for this split: the buttons
 * at the bottom are fine for those settings; provider settings want somewhere
 * you can click around in.
 *
 * ## The rule this page is most at risk of breaking
 *
 * *Never show a signal that cannot say "bad".* A settings page is exactly where
 * a green tick gets painted because a config file exists. So every status on it
 * comes from asking the runtime — `detect()` then `login()` — and the four
 * `LoginState` cases are rendered as four different things with four different
 * fixes. "Not installed", "installed but signed out" and "could not tell" are
 * never collapsed into one grey dot.
 */
import * as vscode from 'vscode'
import { allRuntimes, type RuntimeId, type RuntimeStatus } from '../agent/runtime.ts'
// Re-exported so the settings page stays the one import for its own callers,
// while the collection itself lives somewhere a test can reach it.
export { collectRuntimeStatus } from '../agent/status.ts'

/** What the page renders. Everything is a snapshot with a timestamp on it, so a
 *  readout can be shown as stale rather than as current. */
export interface SettingsState {
  runtimes: RuntimeAgentCard[]
  /** Which runtime new sessions start on. */
  defaultRuntime: RuntimeId
  providers: ProviderCard[]
  activeProvider?: string
  /** Set while a check is in flight, so the page can say so rather than
   *  appearing to have answered instantly. */
  busy?: string
  /**
   * The composer's voice pipeline, checked.
   *
   * Absent until "Check" is pressed: checking spawns whisper-cli and ffmpeg,
   * which is never something a page paint does. `at` rides along so the page
   * can say how stale a green row is.
   */
  voice?: { at: number; rows: VoiceRowState[] }
  /**
   * Scheduled runs, with the derived facts the page must not compute itself.
   * `canRun` is false when no git repo is open — the runs would not fire, and
   * the page says so instead of showing a countdown that can never reach zero.
   */
  schedules?: { rows: ScheduleRowState[]; canRun: boolean; problem?: string }
  /**
   * Remote Control: the board streamed to a relay site so it can be watched
   * from anywhere. Always present. `hasCode` says a pairing code is in the
   * keychain — the host reads it once at activation, so this is a cached
   * boolean, and the code itself never crosses the postMessage boundary in
   * either direction.
   */
  remote?: RemoteState
}

/**
 * Remote Control, as the settings page shows it. `status` is the relay's last
 * answer — success AND failure both, so a page cannot show a green tick that
 * no attempt ever produced. Absent before the first attempt, which the page
 * renders as "not asked yet", not as "fine".
 */
export interface RemoteState {
  enabled: boolean
  /** The relay site origin, "" when never set. */
  url: string
  /** True when a pairing code is in the keychain. The code never renders. */
  hasCode: boolean
  /** The write channel: prompts sent from the remote page run on THIS machine
   *  when true. The host's own toggle, default OFF — and the page renders the
   *  control only when a relay URL is set, because without one no command
   *  could ever arrive. */
  writesEnabled: boolean
  status?: { at: number; ok: boolean; note?: string; error?: string }
}

/** What the page sends to change Remote Control. A `saveRemote` with no code
 *  keeps the stored code — the input is a change-only field. */
export type RemoteMessage =
  | { type: 'setRemote'; enabled: boolean }
  | { type: 'saveRemote'; url: string; code?: string }
  | { type: 'clearRemoteCode' }
  | { type: 'setRemoteWrites'; enabled: boolean }

/** One scheduled run as the page shows it. The schedule itself, plus the
 *  derived facts: `when` ("Mon–Fri at 09:00") and `nextAt`, both host-computed,
 *  so the page needs no clock of its own for WHEN — only for how long ago a
 *  run was, which `since()` needs anyway. */
export interface ScheduleRowState {
  id: string
  title: string
  prompt: string
  hour: number
  minute: number
  days: number[]
  enabled: boolean
  /** "Daily at 09:00" — the one-line shape of the schedule. */
  when: string
  /** When it will next fire, host-computed. Absent when no days are picked. */
  nextAt?: number
  lastRun?: { at: number; ok: boolean; note?: string }
}

/** What the page sends to add or change a schedule. */
export interface ScheduleDraft {
  /** Present on an edit, absent on a new one. */
  id?: string
  title: string
  prompt: string
  hour: number
  minute: number
  days: number[]
  enabled: boolean
}

/** One piece of the dictation pipeline, as the settings page shows it. */
export interface VoiceRowState {
  key: string
  label: string
  ok: boolean
  /** Where it was found, or the fix for THIS piece when it was not. */
  detail: string
}

export interface RuntimeAgentCard {
  id: RuntimeId
  label: string
  vendor: string
  blurb: string
  installHint: string
  /** True when this runtime takes provider profiles at all. Codex does not, and
   *  the provider section must not offer settings that cannot take effect. */
  providerProfiles: boolean
  status?: RuntimeStatus
  /**
   * The backend a session on this agent would ACTUALLY use.
   *
   * Here because the page let two facts contradict each other: the Claude Code
   * card said *"Signed in as david@… (subscription)"* while the active profile
   * sent every request to `api.deepseek.com` with a key from the keychain. Both
   * statements were true; together they were a lie, and the visible symptom was
   * "why is Claude Code offering me DeepSeek models?".
   *
   * `usesLogin` is the reconciliation: false means the account above is real
   * and is not what pays for anything.
   */
  backend?: { label: string; detail: string; usesLogin: boolean; credential?: string }
  /** The models this runtime reports, with where the list came from. Absent
   *  until asked, because asking spawns a process. */
  models?: { id: string; label: string }[]
  modelSource?: string
  modelNote?: string
}

export interface ProviderCard {
  id: string
  label: string
  kind: string
  detail?: string
  active: boolean
  hasCredential: boolean
  /**
   * What this backend's own endpoint says it serves.
   *
   * Only a `gateway` has one — no other kind's endpoint is ours to ask — and it
   * is the answer to the question this page kept getting wrong. Claude Code's
   * `supportedModels()` describes Claude Code however `ANTHROPIC_BASE_URL` is
   * pointed, so a DeepSeek profile was told it served `sonnet` and `haiku`.
   *
   * Descriptions are deliberately NOT carried: OpenRouter lists 431 models with
   * a paragraph each, and this crosses a postMessage boundary on every refresh.
   */
  models?: ProviderModelChoice[]
  /** The host these came from, so a claim about them can name its source. */
  endpointHost?: string
  /** Why there is no list, when there is none. A page that silently shows
   *  nothing is a page that cannot say "I could not ask". */
  modelNote?: string
}

/** One model a backend serves, as the settings page shows it. */
export interface ProviderModelChoice {
  id: string
  label: string
  /** `1M`, `128K`, `?`. */
  context: string
  /** `$0.28/$0.42 per Mtok`, `Free`, or ABSENT when nobody published a price.
   *  Absent is not zero, and must not render as zero. */
  price?: string
  /** True when this id is in the profile's own list — the small human list of
   *  what to OFFER, as opposed to the big machine list of what EXISTS. */
  offered: boolean
}

/** Messages the page sends the host. Parsed on arrival, never trusted: a
 *  webview is another program and this one can change where agents run. */
export type SettingsMessage =
  | { type: 'ready' }
  | { type: 'refresh'; runtime?: RuntimeId }
  | { type: 'setDefaultRuntime'; runtime: RuntimeId }
  | { type: 'signIn'; runtime: RuntimeId }
  | { type: 'install'; runtime: RuntimeId }
  | { type: 'refreshModels'; runtime: RuntimeId }
  | { type: 'selectProvider'; id: string }
  | { type: 'addProvider' }
  | { type: 'editProvider'; id: string }
  | { type: 'removeProvider'; id: string }
  | { type: 'testProvider'; id: string }
  | { type: 'openSetting'; key: string }
  /** Ask the endpoint itself what it serves. A plain HTTP GET — no CLI, no
   *  token — so it is cheap enough to be a button. */
  | { type: 'refreshEndpoint'; id: string }
  /** Which of those models the composer should offer. An EMPTY list means
   *  "offer everything the endpoint serves", which is why it is a distinct
   *  message rather than an edit to the profile: `[]` and `undefined` have to
   *  survive the round trip as the same answer. */
  | { type: 'setProfileModels'; id: string; models: string[] }
  /** Run the voice-pipeline probe now, cache or no cache — a Check button is a
   *  check. Fills `state.voice`. */
  | { type: 'checkVoice' }
  /** Add or change a schedule. The webview validates before sending, but a
   *  message from a webview is model-written input all the same — this parses
   *  every field a fire depends on. `runSchedule` and `toggleSchedule` can
   *  START a billed session, so they parse too rather than cast. */
  | { type: 'saveSchedule'; draft: ScheduleDraft }
  | { type: 'removeSchedule'; id: string }
  | { type: 'toggleSchedule'; id: string }
  | { type: 'runSchedule'; id: string }
  | RemoteMessage

export interface SettingsHost {
  getState: () => Promise<SettingsState>
  handle: (msg: SettingsMessage) => Promise<void>
}

/**
 * The settings tab.
 *
 * One at a time: a second copy would be two views of one set of settings, each
 * able to go stale while the other is edited. Calling `show()` again reveals the
 * existing one, which is also what makes the composer's button idempotent.
 */
export class SettingsPanel {
  static readonly viewType = 'agentsKanban.settings'
  private static current?: SettingsPanel

  private readonly panel: vscode.WebviewPanel
  private readonly host: SettingsHost
  private readonly disposables: vscode.Disposable[] = []

  static show(extensionUri: vscode.Uri, host: SettingsHost): SettingsPanel {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal(undefined, false)
      void SettingsPanel.current.refresh()
      return SettingsPanel.current
    }
    const panel = vscode.window.createWebviewPanel(
      SettingsPanel.viewType,
      'Agents Kanban — Settings',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        // The whole reason this is not a quick pick. Losing a half-typed
        // gateway URL because the tab was hidden would reintroduce the exact
        // failure this page was built to fix.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      },
    )
    SettingsPanel.current = new SettingsPanel(panel, extensionUri, host)
    return SettingsPanel.current
  }

  /** Push a fresh state to the page if it is open. Safe to call when it is not. */
  static async refreshIfOpen(): Promise<void> {
    await SettingsPanel.current?.refresh()
  }

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, host: SettingsHost) {
    this.panel = panel
    this.host = host
    panel.webview.html = html(panel.webview, extensionUri)
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const msg = parseMessage(raw)
        if (!msg) return
        // Never a bare `void`: a rejected handler here is a button that does
        // nothing with no error anywhere, which this project has a postmortem
        // about.
        this.host.handle(msg)
          .then(() => this.refresh())
          .catch((e: unknown) => {
            void vscode.window.showErrorMessage(
              `Agents Kanban: ${e instanceof Error ? e.message : String(e)}`,
            )
          })
      }),
      panel.onDidDispose(() => this.dispose()),
    )
  }

  async refresh(): Promise<void> {
    try {
      const state = await this.host.getState()
      await this.panel.webview.postMessage({ type: 'state', state })
    } catch (e) {
      await this.panel.webview.postMessage({
        type: 'state',
        state: { runtimes: [], providers: [], defaultRuntime: 'claude', busy: undefined },
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  private dispose(): void {
    SettingsPanel.current = undefined
    for (const d of this.disposables.splice(0)) d.dispose()
    this.panel.dispose()
  }
}

/**
 * A message from the webview, validated.
 *
 * These messages change where agents run and can spend money, so the shape is
 * checked rather than cast — the same rule the board's own message handler
 * follows. An unrecognised message is dropped silently on purpose: it is either
 * a newer page against an older host, or something we did not send, and neither
 * is worth a dialog.
 */
export function parseMessage(raw: unknown): SettingsMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  const type = typeof m.type === 'string' ? m.type : ''
  const id = typeof m.id === 'string' ? m.id : ''
  const runtime = typeof m.runtime === 'string' ? m.runtime : ''
  const known = new Set(allRuntimes().map((r) => r.id as string))

  switch (type) {
    case 'ready':
    case 'addProvider':
    case 'checkVoice':
      return { type } as SettingsMessage
    case 'refresh':
      return known.has(runtime) ? { type, runtime: runtime as RuntimeId } : { type }
    case 'setDefaultRuntime':
    case 'signIn':
    case 'install':
    case 'refreshModels':
      return known.has(runtime) ? ({ type, runtime: runtime as RuntimeId } as SettingsMessage) : undefined
    case 'selectProvider':
    case 'editProvider':
    case 'removeProvider':
    case 'testProvider':
    case 'refreshEndpoint':
      return id ? ({ type, id } as SettingsMessage) : undefined
    case 'setProfileModels': {
      // Model ids from a webview reach a `query()` call, so they are filtered
      // rather than cast — the same treatment `parseProfiles` gives
      // `settings.json`. A junk entry is dropped, not rendered blank.
      if (!id || !Array.isArray(m.models)) return undefined
      const models = m.models
        .filter((v): v is string => typeof v === 'string' && !!v.trim())
        .map((v) => v.trim())
      return { type, id, models }
    }
    case 'openSetting':
      return typeof m.key === 'string' && m.key ? { type, key: m.key } : undefined
    case 'removeSchedule':
    case 'toggleSchedule':
    case 'runSchedule':
      return id ? ({ type, id } as SettingsMessage) : undefined
    case 'setRemote':
    case 'setRemoteWrites':
      return typeof m.enabled === 'boolean' ? { type, enabled: m.enabled } : undefined
    case 'clearRemoteCode':
      return { type }
    case 'saveRemote': {
      // The URL is validated host-side too (relayBase) — this keeps the shape
      // check here: non-empty strings with sane lengths, nothing more.
      const url = typeof m.url === 'string' ? m.url.trim().slice(0, 2000) : ''
      if (!url) return undefined
      // A blank or absent code field means "keep the stored one" — the code is
      // a change-only field, and emptying it must not wipe the keychain entry
      // (there is a dedicated message for that, `clearRemoteCode`).
      const code = typeof m.code === 'string' ? m.code.trim().slice(0, 500) : undefined
      return code ? { type, url, code } : { type, url }
    }
    case 'saveSchedule': {
      const d = m.draft as Record<string, unknown> | undefined
      if (!d || typeof d !== 'object') return undefined
      const did = typeof d.id === 'string' && d.id ? d.id.slice(0, 200) : undefined
      const title = typeof d.title === 'string' ? d.title.trim() : ''
      const prompt = typeof d.prompt === 'string' ? d.prompt : ''
      const hour = typeof d.hour === 'number' && Number.isInteger(d.hour) && d.hour >= 0 && d.hour <= 23
        ? d.hour : -1
      const minute = typeof d.minute === 'number' && Number.isInteger(d.minute) && d.minute >= 0 && d.minute <= 59
        ? d.minute : -1
      const days = Array.isArray(d.days)
        ? [...new Set(d.days.filter((v): v is number =>
            typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 6))]
        : []
      // A draft that cannot fire (no title, no prompt, bad time) is refused
      // wholesale, like every other malformed message on this page.
      if (!title || !prompt || !prompt.trim() || hour === -1 || minute === -1) return undefined
      return {
        type,
        draft: {
          ...(did ? { id: did } : {}),
          title,
          prompt,
          hour,
          minute,
          days,
          enabled: d.enabled !== false,
        },
      } as SettingsMessage
    }
    default:
      return undefined
  }
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const uri = (f: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', f))
  const nonce = nonceString()
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${uri('board.css')}" rel="stylesheet">
<link href="${uri('settings.css')}" rel="stylesheet">
<title>Agents Kanban — Settings</title>
</head>
<body class="settings">
<div id="root"></div>
<script nonce="${nonce}" src="${uri('settings.js')}"></script>
</body>
</html>`
}

function nonceString(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length))
  return out
}
