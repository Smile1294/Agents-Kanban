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
import { allRuntimes, type LoginState, type RuntimeId, type RuntimeStatus } from '../agent/runtime.ts'
import type { ProviderEnv } from '../agent/providers.ts'

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

export interface SettingsHost {
  getState: () => Promise<SettingsState>
  handle: (msg: SettingsMessage) => Promise<void>
}

/**
 * Ask every registered runtime where it is and who it thinks we are.
 *
 * Runs them in parallel and lets each one fail on its own: a runtime whose CLI
 * hangs must not stop the page rendering the one that answered. That is why the
 * catch produces an `unknown` login rather than propagating — "could not tell"
 * is a real, renderable state, and an exception here would blank the page.
 *
 * Never called on the render path or on activation. It spawns processes.
 */
export async function collectRuntimeStatus(
  configured: Partial<Record<RuntimeId, string | undefined>> = {},
  /** The active backend's environment patch. Passed to `login()` so the answer
   *  is about the sessions this board starts, not about the CLI on its own —
   *  see `AgentRuntime.login`. */
  providerEnv?: ProviderEnv,
): Promise<RuntimeStatus[]> {
  return Promise.all(allRuntimes().map(async (rt): Promise<RuntimeStatus> => {
    const at = Date.now()
    try {
      const location = await rt.detect(configured[rt.id])
      if (!location) {
        return {
          id: rt.id, label: rt.label, at,
          login: { kind: 'notInstalled', fix: rt.installHint },
        }
      }
      const login: LoginState = await rt.login(
        location,
        // Only where a provider profile can take effect. Handing one to a
        // runtime that signs in as itself would be configuring something that
        // cannot apply.
        rt.capabilities.providerProfiles ? providerEnv : undefined,
      )
      return { id: rt.id, label: rt.label, at, location, login }
    } catch (e) {
      return {
        id: rt.id, label: rt.label, at,
        login: { kind: 'unknown', reason: e instanceof Error ? e.message : String(e) },
      }
    }
  }))
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
