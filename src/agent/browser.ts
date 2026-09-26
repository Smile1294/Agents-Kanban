/**
 * A browser an agent drives, so it can LOOK at the feature it just built.
 *
 * Reported as "I want the agents to open a web browser and test the feature
 * they worked on, and to be able to see the screen". An agent that can only
 * run unit tests hands over a test plan for a UI it has never seen; the board
 * then asks a person to find out whether the button it describes exists.
 *
 * So each card gets one headless Chromium page, driven through `playwright-core`
 * and exposed as board tools (`browser_*` in `tools.ts`). Four decisions, each
 * the answer to a way this goes wrong in comparable harnesses:
 *
 *  - **Text first, pixels when asked.** `snapshot()` returns the page's ARIA
 *    tree (a few hundred tokens, and it names the things you can click);
 *    `screenshot()` returns a JPEG at a 1280x800 viewport, ~1.4k tokens. An
 *    agent that screenshots after every click burns its context on pictures of
 *    the same page, so the descriptions steer it to the snapshot and keep the
 *    screenshot for "does this LOOK right".
 *  - **The console is part of the answer.** A page that renders and throws on
 *    every click looks fine in a screenshot. Console errors, uncaught
 *    exceptions, failed requests and HTTP >= 400 responses are collected from
 *    the moment the page opens, and `open()`/`act()` say how many arrived.
 *  - **Loopback only, unless the user said otherwise.** The page's content is
 *    another program's output that the model reads. An auto-allowed tool that
 *    can be pointed at any site is a prompt-injection channel with no click in
 *    front of it; the agent's own dev server is not. This is a boundary, so it
 *    is in code (`allowedUrl`), not in the tool description.
 *  - **One browser for all cards, one context per card, closed with the run.**
 *    A context is cookie- and storage-isolated, so two agents logged into two
 *    worktrees do not share a session; a process per card would be 150MB each.
 *
 * `playwright-core` is loaded lazily: an extension that never opens a browser
 * never pays for it, and a machine without a Chromium gets a sentence naming
 * the fix rather than a failed activation. No `vscode` import — the host hands
 * in where screenshots go.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export const VIEWPORT = { width: 1280, height: 800 } as const
/** At most this often a watched tab sends the viewer a frame. */
export const FRAME_INTERVAL_MS = 250

/** One picture of a watched tab, for the board's live browser pane. */
export interface BrowserFrame {
  /** Base64 JPEG. */
  data: string
  url: string
  at: number
  action?: string
}
/** Screenshots kept on disk per card. The newest are the ones worth opening. */
export const KEEP_SHOTS = 20

/** One thing the page said that the agent should hear about. */
export interface PageEvent {
  kind: 'console' | 'pageerror' | 'requestfailed' | 'http'
  level?: string
  text: string
  at: number
}

export interface BrowserOptions {
  /** `agentsKanban.browserExecutable`, if the user set one. */
  executable?: string
  /** Allow non-loopback URLs. Off by default; see the header. */
  allowExternal?: boolean
  /** Where screenshots are written so the USER can open them — extension
   *  storage, never the worktree (an untracked file there would be committed
   *  on the move into review). */
  shotsDir?: string
  /** Headed, for watching an agent work. Off by default. */
  headed?: boolean
  log?: (line: string) => void
}

/** Anything a page's Playwright object needs, typed loosely: this module must
 *  typecheck without `playwright-core`'s types being the contract. */
/* eslint-disable @typescript-eslint/no-explicit-any */
type Pw = any

interface Tab {
  context: Pw
  page: Pw
  events: PageEvent[]
  /** Index into `events` of the first one not yet reported. */
  seen: number
  /** Index into `events` where the current page was opened — its errors are
   *  the ones after this, which is what the card reports as the end state. */
  openedAt: number
  /** The live screencast, while somebody is watching this tab. */
  cast?: Pw
  lastFrameAt?: number
  pendingFrame?: ReturnType<typeof setTimeout>
  /** The last thing done to the page, carried on each frame — "what did it
   *  just do" is half of watching an agent test. */
  lastAction?: string
  shots: number
  /** Requests in flight, and when each started — what `settle()` waits on. */
  inflight: Map<Pw, number>
  /** The page's ARIA tree as the agent last saw it, so an action can report
   *  what CHANGED rather than making the agent ask again. */
  lastTree?: string
}

/**
 * Hosts that are never the app under test and only slow a page down or fill
 * the console with noise: analytics, session replay, ad and error-reporting
 * beacons. Aborted in the agent's browser. Not CDNs — an app may load its own
 * scripts from one, and blocking that would break the thing being tested.
 */
export const TRACKERS = /^https?:\/\/([^/]*\.)?(google-analytics\.com|googletagmanager\.com|analytics\.google\.com|doubleclick\.net|hotjar\.com|segment\.(io|com)|mixpanel\.com|plausible\.io|clarity\.ms|fullstory\.com|intercom\.io|intercomcdn\.com|ingest\.sentry\.io|facebook\.net|connect\.facebook\.net|amplitude\.com|heapanalytics\.com|posthog\.com)(\/|:|$)/i

/**
 * Animations and transitions shortened to 1ms in the agent's browser. A click
 * waits for its target to stop moving, and a screenshot mid-fade shows a state
 * the user never sees at rest. 1ms and not 0: a zero-length transition fires
 * no `transitionend`, and UIs that wait for one would hang.
 */
const CALM_CSS = '*,*::before,*::after{transition-duration:1ms!important;transition-delay:0s!important;' +
  'animation-duration:1ms!important;animation-delay:0s!important;scroll-behavior:auto!important}'

/** Requests older than this do not hold `settle()` up: a long poll, an SSE
 *  stream or a hung call would otherwise make every action wait its cap. */
const LONG_LIVED_MS = 2500

/** The interactive elements of the page, each tagged with a ref the agent can
 *  target (`e12`). Runs IN the page. Refs are stable across calls for an
 *  element that survives; a re-rendered element gets a new one. */
const REFS_SCRIPT = `(() => {
  const w = window
  w.__akRef = w.__akRef || 0
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick]'
  const out = []
  for (const el of document.querySelectorAll(sel)) {
    if (out.length >= 150) break
    const r = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    if ((r.width === 0 && r.height === 0) || style.visibility === 'hidden' || style.display === 'none') continue
    let ref = el.getAttribute('data-ak-ref')
    if (!ref) { ref = 'e' + (++w.__akRef); el.setAttribute('data-ak-ref', ref) }
    const tag = el.tagName.toLowerCase()
    const type = (el.getAttribute('type') || '').toLowerCase()
    const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'button' || type === 'submit' || type === 'button' ? 'button'
      : tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio'
      : tag === 'input' ? 'textbox' : tag === 'summary' ? 'disclosure' : 'clickable')
    const label = el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('placeholder')
      || (tag !== 'input' && tag !== 'select' && tag !== 'textarea' ? el.innerText : '') || el.getAttribute('title') || el.getAttribute('name') || ''
    const bits = []
    if ('value' in el && tag !== 'button' && el.value && type !== 'password') bits.push('value "' + String(el.value).slice(0, 40) + '"')
    if (el.checked) bits.push('checked')
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled')
    if (el.getAttribute('aria-expanded')) bits.push('expanded=' + el.getAttribute('aria-expanded'))
    out.push('[' + ref + '] ' + role + ' "' + String(label).replace(/\\s+/g, ' ').trim().slice(0, 60) + '"' + (bits.length ? ' (' + bits.join(', ') + ')' : ''))
  }
  return out
})()`

/** Is this URL one the agent may open without the user having widened it? */
export function allowedUrl(raw: string, allowExternal = false): { ok: true; url: string } | { ok: false; message: string } {
  let u: URL
  try {
    // A bare port or path is the agent's own app: `:5173/login`, `/login`.
    u = new URL(/^:\d+/.test(raw) ? `http://localhost${raw}` : raw)
  } catch {
    return { ok: false, message: `"${raw}" is not a URL. Pass e.g. "http://localhost:5173/login".` }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, message: `Only http and https pages can be opened, not ${u.protocol}` }
  }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(host) || host === '0.0.0.0'
  if (!loopback && !allowExternal) {
    return {
      ok: false,
      message: `${u.host} is not this machine. The board's browser opens the app you are working on ` +
        '(localhost) and nothing else, because a page is text you would read and act on. ' +
        'The user can allow other sites with agentsKanban.browserAllowExternal.',
    }
  }
  if (host === '0.0.0.0') u.hostname = 'localhost'
  return { ok: true, url: u.toString() }
}

/**
 * Find a Chromium to drive. The user's setting; then whatever Playwright has
 * cached (any build — `playwright-core` refuses a build it did not pin unless
 * handed the path, and any Chromium can render a page); then the browsers
 * people actually have installed.
 */
export async function findBrowser(configured?: string, home = os.homedir()): Promise<string | undefined> {
  const isFile = (p: string) => fs.stat(p).then((st) => st.isFile(), () => false)
  if (configured?.trim()) return (await isFile(configured)) ? configured : undefined
  const roots = [
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? [process.env.PLAYWRIGHT_BROWSERS_PATH] : []),
    path.join(home, '.cache', 'ms-playwright'),
    path.join(home, 'Library', 'Caches', 'ms-playwright'),
    ...(process.env.LOCALAPPDATA ? [path.join(process.env.LOCALAPPDATA, 'ms-playwright')] : []),
  ]
  for (const cache of roots) {
    const dirs = await fs.readdir(cache).catch(() => [] as string[])
    const builds = dirs
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      .sort((a, b) => Number(b.match(/\d+$/)![0]) - Number(a.match(/\d+$/)![0]))
    for (const d of builds) {
      for (const rel of [['chrome-linux', 'headless_shell'], ['chrome-linux', 'chrome'],
                         ['chrome-linux64', 'chrome'], ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
                         ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
                         ['chrome-mac', 'headless_shell'],
                         ['chrome-win', 'chrome.exe'], ['chrome-win', 'headless_shell.exe']]) {
        const exe = path.join(cache, d, ...rel)
        if (await isFile(exe)) return exe
      }
    }
  }
  const system = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
       '/Applications/Chromium.app/Contents/MacOS/Chromium',
       '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
    : process.platform === 'win32'
      ? [path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
         path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
         '/usr/bin/google-chrome-stable', '/snap/bin/chromium', '/usr/bin/microsoft-edge']
  for (const p of system) if (await isFile(p)) return p
  return undefined
}

/** A page event as one line for the agent. Long texts are cut: a minified
 *  bundle's stack is not information. */
export function describeEvents(events: readonly PageEvent[], max = 30): string {
  if (!events.length) return 'No console errors, page errors or failed requests.'
  const lines = events.slice(-max).map((e) => {
    const tag = e.kind === 'console' ? `console.${e.level ?? 'log'}` : e.kind
    const text = e.text.length > 400 ? `${e.text.slice(0, 400)}…` : e.text
    return `- [${tag}] ${text}`
  })
  const skipped = events.length > max ? `(${events.length - max} earlier not shown)\n` : ''
  return skipped + lines.join('\n')
}

export type Action =
  | { action: 'click'; target: string }
  | { action: 'fill'; target: string; text: string; submit?: boolean }
  | { action: 'press'; key: string; target?: string }
  | { action: 'select'; target: string; value: string }
  | { action: 'hover'; target: string }
  | { action: 'check' | 'uncheck'; target: string }
  | { action: 'scroll'; dy: number }
  | { action: 'wait'; target?: string; ms?: number; text?: string }

function describeAction(a: Action): string {
  switch (a.action) {
    case 'fill': return `fill ${a.target} = "${a.text.slice(0, 30)}"${a.submit ? ' + Enter' : ''}`
    case 'press': return `press ${a.key}${a.target ? ` in ${a.target}` : ''}`
    case 'select': return `select ${a.value} in ${a.target}`
    case 'scroll': return `scroll ${a.dy}`
    case 'wait': return `wait for ${a.text ? `"${a.text}"` : a.target ?? `${a.ms ?? 1000}ms`}`
    default: return `${a.action} ${a.target}`
  }
}

/** The ref list, as the agent reads it. */
export function refsBlock(refs: readonly string[], max: number): string {
  return `Controls (target them by ref, e.g. "${refs[0]?.slice(1, refs[0].indexOf(']')) ?? 'e1'}"):\n` +
    refs.slice(0, max).join('\n') + (refs.length > max ? `\n… ${refs.length - max} more — browser_snapshot lists them all` : '')
}

/**
 * What changed between two ARIA trees, as lines that changed (~), appeared (+)
 * and disappeared (−). A multiset difference, not an ordered diff: the agent needs
 * "a listitem 'milk' appeared", and a line that only MOVED is not news.
 * "The page did not change" is said out loud — it is the most useful thing a
 * click that did nothing can report.
 */
export function changeBlock(before: string, after: string, max = 30): string {
  if (before === after) return 'The page did not change.'
  const count = (t: string) => {
    const m = new Map<string, number>()
    for (const l of t.split('\n')) { const k = l.trim(); if (k) m.set(k, (m.get(k) ?? 0) + 1) }
    return m
  }
  const a = count(before), b = count(after)
  const added: string[] = [], removed: string[] = []
  for (const [k, n] of b) for (let i = (a.get(k) ?? 0); i < n; i++) added.push(k)
  for (const [k, n] of a) for (let i = (b.get(k) ?? 0); i < n; i++) removed.push(k)
  if (!added.length && !removed.length) return 'The page did not change (only reordered).'
  // A line that gained a value or children is one CHANGE, not a removal and
  // an addition: `textbox "New"` → `textbox "New": milk` reads as "~ …milk".
  // One that only gained children (`list` → `list:`) is structure, not news.
  const changed: string[] = []
  for (let i = removed.length - 1; i >= 0; i--) {
    const r = removed[i]!.replace(/:$/, '')
    const j = added.findIndex((x) => x === `${r}:` || x.startsWith(`${r}: `) || x.startsWith(`${r} [`))
    if (j < 0) continue
    const [a2] = added.splice(j, 1)
    removed.splice(i, 1)
    if (a2 !== `${r}:`) changed.unshift(a2!)
  }
  if (!added.length && !removed.length && !changed.length) return 'The page did not change (only its structure).'
  const shown = [...changed.map((l) => `~ ${l}`), ...added.map((l) => `+ ${l}`), ...removed.map((l) => `− ${l}`)]
  return `Page changed:\n${shown.slice(0, max).join('\n')}` +
    (shown.length > max ? `\n… ${shown.length - max} more lines changed — browser_snapshot for the whole page` : '')
}

/**
 * Every card's browser tab.
 *
 * Nothing here throws at a tool: every method returns text the agent can read,
 * because a thrown Playwright error ("Timeout 30000ms exceeded") inside a tool
 * handler is an error message with no page state attached, and the next thing
 * an agent needs after a failed click is to see what IS on the page.
 */
export class BrowserPool {
  private readonly options: () => BrowserOptions
  private browser: Pw | undefined
  private launching: Promise<Pw> | undefined
  private readonly tabs = new Map<string, Tab>()
  private readonly watchers = new Set<{ match: (key: string) => boolean; fn: (key: string, f: BrowserFrame) => void }>()

  /** Options may be a function, read when the browser launches and when a
   *  URL is checked — so a changed setting applies without a reload. */
  constructor(opts: BrowserOptions | (() => BrowserOptions) = {}) {
    this.options = typeof opts === 'function' ? opts : () => opts
  }

  private get opts(): BrowserOptions { return this.options() }

  has(key: string): boolean { return this.tabs.has(key) }

  private async launch(): Promise<Pw> {
    if (this.browser?.isConnected?.()) return this.browser
    this.launching ??= (async () => {
      let pw: Pw
      try {
        pw = await import('playwright-core')
      } catch {
        throw new Error('The browser tools need the playwright-core package, which this install of the extension is missing.')
      }
      const chromium = pw.chromium ?? pw.default?.chromium
      const exe = await findBrowser(this.opts.executable)
      if (!exe && this.opts.executable) {
        throw new Error(`agentsKanban.browserExecutable points at ${this.opts.executable}, which does not exist.`)
      }
      try {
        const b = await chromium.launch({
          headless: !this.opts.headed,
          ...(exe ? { executablePath: exe } : {}),
          // Containers run as root, where Chromium refuses its sandbox.
          ...(process.getuid?.() === 0 ? { args: ['--no-sandbox'] } : {}),
        })
        this.opts.log?.(`Browser for agents: ${exe ?? 'Playwright default'}`)
        return b
      } catch (e) {
        throw new Error(
          'No Chromium could be started for the browser tools. Install Google Chrome or Chromium, ' +
          'or set agentsKanban.browserExecutable to one. ' +
          `(${String(e instanceof Error ? e.message : e).split('\n')[0]})`,
        )
      }
    })()
    try {
      this.browser = await this.launching
      this.browser.on?.('disconnected', () => { this.browser = undefined; this.tabs.clear() })
      return this.browser
    } finally {
      this.launching = undefined
    }
  }

  private async tab(key: string): Promise<Tab> {
    const have = this.tabs.get(key)
    if (have && !have.page.isClosed()) return have
    const browser = await this.launch()
    const context = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true, reducedMotion: 'reduce' })
    await context.addInitScript(`(() => { const add = () => { const s = document.createElement('style'); s.setAttribute('data-ak', 'calm'); s.textContent = ${JSON.stringify(CALM_CSS)}; (document.head || document.documentElement).appendChild(s) }; if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add() })()`).catch(() => {})
    await context.route(TRACKERS, (r: Pw) => r.abort()).catch(() => {})
    const page = await context.newPage()
    const tab: Tab = { context, page, events: [], seen: 0, openedAt: 0, shots: have?.shots ?? 0, inflight: new Map() }
    page.on('request', (r: Pw) => { tab.inflight.set(r, Date.now()) })
    page.on('requestfinished', (r: Pw) => { tab.inflight.delete(r) })
    const add = (e: Omit<PageEvent, 'at'>) => {
      tab.events.push({ ...e, at: Date.now() })
      if (tab.events.length > 500) {
        tab.events.splice(0, 100)
        tab.seen = Math.max(0, tab.seen - 100)
        tab.openedAt = Math.max(0, tab.openedAt - 100)
      }
    }
    page.on('console', (m: Pw) => {
      const level = m.type()
      if (level === 'error' || level === 'warning' || level === 'assert') add({ kind: 'console', level, text: m.text() })
    })
    page.on('pageerror', (e: Error) => add({ kind: 'pageerror', text: e.stack?.split('\n').slice(0, 4).join(' | ') ?? e.message }))
    page.on('requestfailed', (r: Pw) => {
      tab.inflight.delete(r)
      const why = r.failure()?.errorText ?? 'failed'
      // Our own tracker block is not the app failing.
      if (TRACKERS.test(r.url())) return
      // Navigating away cancels in-flight requests; that is not the app's fault.
      if (/ERR_ABORTED/.test(why)) return
      add({ kind: 'requestfailed', text: `${r.method()} ${r.url()} — ${why}` })
    })
    page.on('response', (r: Pw) => {
      if (r.status() >= 400) add({ kind: 'http', text: `${r.status()} ${r.request().method()} ${r.url()}` })
    })
    this.tabs.set(key, tab)
    if ([...this.watchers].some((w) => w.match(key))) void this.startCast(key, tab)
    return tab
  }

  /**
   * Watch every tab whose key matches — including ones opened LATER — as a
   * stream of JPEG frames. Chromium's screencast sends a frame only when the
   * page repaints, so an idle page costs nothing; frames are capped at
   * `FRAME_INTERVAL_MS` apart, with the last one always delivered (a dropped
   * final frame would leave the viewer on a state the page is no longer in).
   * Returns the unsubscribe; a tab nobody matches any more stops casting.
   */
  watch(match: (key: string) => boolean, fn: (key: string, f: BrowserFrame) => void): () => void {
    const w = { match, fn }
    this.watchers.add(w)
    for (const [key, tab] of this.tabs) if (match(key)) void this.startCast(key, tab)
    return () => {
      this.watchers.delete(w)
      for (const [key, tab] of this.tabs) {
        if (tab.cast && ![...this.watchers].some((o) => o.match(key))) void this.stopCast(tab)
      }
    }
  }

  private async startCast(key: string, tab: Tab): Promise<void> {
    if (tab.cast || tab.page.isClosed()) return
    try {
      const cdp = await tab.context.newCDPSession(tab.page)
      tab.cast = cdp
      const deliver = (data: string) => {
        tab.lastFrameAt = Date.now()
        const frame: BrowserFrame = { data, url: tab.page.url(), at: tab.lastFrameAt, ...(tab.lastAction ? { action: tab.lastAction } : {}) }
        for (const w of this.watchers) if (w.match(key)) { try { w.fn(key, frame) } catch { /* a viewer's failure is its own */ } }
      }
      cdp.on('Page.screencastFrame', (e: { data: string; sessionId: number }) => {
        cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {})
        const since = Date.now() - (tab.lastFrameAt ?? 0)
        if (tab.pendingFrame) clearTimeout(tab.pendingFrame)
        if (since >= FRAME_INTERVAL_MS) deliver(e.data)
        else tab.pendingFrame = setTimeout(() => { tab.pendingFrame = undefined; deliver(e.data) }, FRAME_INTERVAL_MS - since)
      })
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 960, maxHeight: 600 })
    } catch (e) {
      tab.cast = undefined
      this.opts.log?.(`Browser screencast could not start: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async stopCast(tab: Tab): Promise<void> {
    const cdp = tab.cast
    tab.cast = undefined
    if (tab.pendingFrame) { clearTimeout(tab.pendingFrame); tab.pendingFrame = undefined }
    await cdp?.send('Page.stopScreencast').catch(() => {})
    await cdp?.detach().catch(() => {})
  }

  /** What arrived since the last time the agent was told, as a suffix line. */
  private news(tab: Tab): string {
    const fresh = tab.events.slice(tab.seen)
    tab.seen = tab.events.length
    if (!fresh.length) return ''
    const errors = fresh.filter((e) => e.kind !== 'console' || e.level === 'error').length
    return `\n\n${fresh.length} new console/network event(s)${errors ? `, ${errors} of them errors` : ''}:\n${describeEvents(fresh, 8)}`
  }

  private async where(tab: Tab): Promise<string> {
    const title = await tab.page.title().catch(() => '')
    return `${tab.page.url()}${title ? ` — "${title}"` : ''}`
  }

  async open(key: string, raw: string): Promise<string> {
    const allowed = allowedUrl(raw, this.opts.allowExternal)
    if (!allowed.ok) throw new Error(allowed.message)
    const tab = await this.tab(key)
    tab.openedAt = tab.events.length
    tab.lastAction = `open ${allowed.url}`
    const res = await tab.page.goto(allowed.url, { waitUntil: 'load', timeout: 30_000 }).catch((e: Error) => e)
    if (res instanceof Error) {
      const first = res.message.split('\n')[0] ?? ''
      if (/ERR_CONNECTION_REFUSED/.test(first)) {
        throw new Error(`Nothing is listening at ${allowed.url}. Start the app first (app_start), or check its logs (app_logs).`)
      }
      throw new Error(`Could not open ${allowed.url}: ${first}`)
    }
    // Most apps render after `load`: wait for the requests they start and
    // the DOM they build to go quiet (a websocket never counts).
    await this.settle(tab, 5000)
    const status = res?.status?.()
    tab.lastTree = await this.tree(tab)
    const refs = await this.refs(tab)
    return `Opened ${await this.where(tab)}${status && status >= 400 ? ` (HTTP ${status})` : ''}` +
      (refs.length ? `\n\n${refsBlock(refs, 60)}` : '\n\nNo buttons, links or inputs on this page.') +
      `\n\nbrowser_snapshot for the whole page as text.${this.news(tab)}`
  }

  /** Launch the browser now, in the background, so the first `browser_open`
   *  does not pay for it. Called when an agent starts its app. */
  warm(): void {
    void this.launch().catch(() => {})
  }

  /**
   * Wait for what an action set off to finish: the requests it started, then
   * the DOM going quiet — capped, never forever.
   *
   * `waitForLoadState('networkidle')` after an action was a NO-OP: a page
   * that reached network-idle once stays there, so it returned at once. A
   * click whose handler fetched something came back BEFORE the response, the
   * agent saw the page as it was before its own click, and either clicked
   * again (a duplicate) or reported a bug that was not there. Measured: a
   * click on "Add" answered in 61ms, the item arrived at ~90ms.
   */
  private async settle(tab: Tab, capMs = 3000, light = false): Promise<void> {
    const t0 = Date.now()
    const left = () => capMs - (Date.now() - t0)
    // A handler's fetch starts in a microtask or a frame after the event.
    await new Promise((r) => setTimeout(r, light ? 15 : 30))
    // Typing into a field, hovering or ticking a box usually starts nothing:
    // when nothing is in flight, do not wait out a quiet window for it.
    if (light && ![...tab.inflight.values()].some((at) => Date.now() - at < LONG_LIVED_MS)) return
    for (let round = 0; left() > 0 && round < 20; round++) {
      const now = Date.now()
      const busy = [...tab.inflight.values()].some((at) => now - at < LONG_LIVED_MS)
      if (busy) { await new Promise((r) => setTimeout(r, 25)); continue }
      const before = tab.inflight.size
      const quiet = await tab.page.evaluate(`new Promise((res) => {
        let t; const done = () => { mo.disconnect(); clearTimeout(cap); res(true) }
        const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(done, 100) })
        mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
        t = setTimeout(done, 100); const cap = setTimeout(done, ${Math.max(100, Math.min(1500, left()))})
      })`).catch(() => false)
      if (!quiet) {
        // The page navigated under us (a form post, a link): wait for the new one.
        await tab.page.waitForLoadState('domcontentloaded', { timeout: Math.max(100, left()) }).catch(() => {})
        continue
      }
      // Nothing new started while the DOM was settling: done.
      if (tab.inflight.size <= before && ![...tab.inflight.values()].some((at) => Date.now() - at < LONG_LIVED_MS)) return
    }
  }

  /** The ARIA tree of the page, or '' when it cannot be read. */
  private async tree(tab: Tab): Promise<string> {
    return await tab.page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => '') as string
  }

  /** The interactive elements, with refs. */
  private async refs(tab: Tab): Promise<string[]> {
    const r = await tab.page.evaluate(REFS_SCRIPT).catch(() => [])
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : []
  }

  /** A target the agent wrote: a ref from the list (`e12`, `[e12]`,
   *  `ref=e12`) or any Playwright selector. */
  private locate(tab: Tab, target: string): Pw {
    const ref = /^\[?(?:ref=)?(e\d+)\]?$/.exec(target.trim())
    return tab.page.locator(ref ? `[data-ak-ref="${ref[1]}"]` : target).first()
  }

  /** The ARIA tree of the page (or of one element) — the cheap way to see it. */
  async snapshot(key: string, target?: string): Promise<string> {
    const tab = this.requireTab(key)
    const loc = target ? this.locate(tab, target) : tab.page.locator('body')
    const tree: string = await loc.ariaSnapshot({ timeout: 5000 })
    if (!target) tab.lastTree = tree
    const cut = tree.length > 12_000 ? `${tree.slice(0, 12_000)}\n… (truncated; pass a target to look at one part)` : tree
    const refs = target ? [] : await this.refs(tab)
    return `${await this.where(tab)}\n\n${cut}${refs.length ? `\n\n${refsBlock(refs, 150)}` : ''}${this.news(tab)}`
  }

  /** A JPEG of the viewport, the full page or one element, and where it was saved. */
  async screenshot(key: string, opts: { fullPage?: boolean; target?: string } = {}): Promise<{ data: string; mimeType: 'image/jpeg'; saved?: string; where: string; news: string }> {
    const tab = this.requireTab(key)
    const shotOpts = { type: 'jpeg', quality: 70, timeout: 10_000 }
    const buf: Buffer = opts.target
      ? await this.locate(tab, opts.target).screenshot(shotOpts)
      : await tab.page.screenshot({ ...shotOpts, fullPage: opts.fullPage === true })
    let saved: string | undefined
    if (this.opts.shotsDir) {
      const dir = path.join(this.opts.shotsDir, safeName(key))
      await fs.mkdir(dir, { recursive: true }).catch(() => {})
      tab.shots += 1
      saved = path.join(dir, `shot-${String(tab.shots).padStart(3, '0')}.jpg`)
      await fs.writeFile(saved, buf).then(() => prune(dir, KEEP_SHOTS), () => { saved = undefined })
    }
    return { data: buf.toString('base64'), mimeType: 'image/jpeg', ...(saved ? { saved } : {}), where: await this.where(tab), news: this.news(tab) }
  }

  /** One action, and what it changed. */
  async act(key: string, a: Action): Promise<string> {
    return this.steps(key, [a])
  }

  /**
   * Several actions in order — a form is fill, fill, click — stopping at the
   * first that fails, then ONE report of what the page looks like now: what
   * appeared and disappeared, where it is, new controls with their refs, and
   * any errors. The report is what the agent would otherwise call
   * `browser_snapshot` for, which is a whole model turn per action.
   */
  async steps(key: string, list: readonly Action[]): Promise<string> {
    const tab = this.requireTab(key)
    const before = tab.lastTree ?? await this.tree(tab)
    const refsBefore = new Set((await this.refs(tab)).map((l) => l.split(' ')[0]))
    const urlBefore = tab.page.url()
    const done: string[] = []
    let failed: string | undefined
    for (const [i, a] of list.entries()) {
      try {
        await this.step(tab, a)
        done.push(describeAction(a))
      } catch (e) {
        const first = String(e instanceof Error ? e.message : e).split('\n')[0] ?? ''
        const gone = /^\[?(?:ref=)?e\d+\]?$/.test(('target' in a && a.target) || '') && /waiting for locator|Timeout/.test(first)
        failed = `Step ${i + 1}${list.length > 1 ? ` of ${list.length}` : ''} (${describeAction(a)}) failed: ` +
          (gone ? `that ref is not on the page any more (it re-rendered). Use a ref from the list below.` : first)
        break
      }
    }
    const after = await this.tree(tab)
    tab.lastTree = after
    const refsNow = await this.refs(tab)
    const lines: string[] = []
    lines.push(failed ?? `Done: ${done.join(', ')}.`)
    if (failed && done.length) lines.push(`Before that: ${done.join(', ')}.`)
    const urlNow = tab.page.url()
    lines.push(`${urlNow !== urlBefore ? 'Navigated to' : 'At'} ${await this.where(tab)}`)
    lines.push(changeBlock(before, after))
    const fresh = refsNow.filter((l) => !refsBefore.has(l.split(' ')[0]))
    if (failed) lines.push(refsBlock(refsNow, 60))
    else if (fresh.length) lines.push(`New controls:\n${fresh.slice(0, 20).join('\n')}`)
    return lines.join('\n') + this.news(tab)
  }

  private async step(tab: Tab, a: Action): Promise<void> {
    tab.lastAction = a.action === 'fill' ? `fill ${a.target} = "${a.text.slice(0, 40)}"`
      : a.action === 'press' ? `press ${a.key}`
      : a.action === 'scroll' ? `scroll ${a.dy}`
      : a.action === 'wait' ? `wait ${a.target ?? a.ms ?? ''}`
      : a.action === 'select' ? `select ${a.target} = ${a.value}`
      : `${a.action} ${a.target}`
    const page = tab.page
    const loc = (t: string) => this.locate(tab, t)
    const timeout = { timeout: 8000 }
    switch (a.action) {
      case 'click': await loc(a.target).click(timeout); break
      case 'fill':
        await loc(a.target).fill(a.text, timeout)
        if (a.submit) await loc(a.target).press('Enter', timeout)
        break
      case 'press': await (a.target ? loc(a.target).press(a.key, timeout) : page.keyboard.press(a.key)); break
      case 'select': await loc(a.target).selectOption(a.value, timeout); break
      case 'hover': await loc(a.target).hover(timeout); break
      case 'check': await loc(a.target).check(timeout); break
      case 'uncheck': await loc(a.target).uncheck(timeout); break
      case 'scroll': await page.mouse.wheel(0, a.dy); break
      case 'wait':
        if (a.text) await page.getByText(a.text).first().waitFor({ timeout: Math.min(a.ms ?? 10_000, 30_000) })
        else if (a.target) await loc(a.target).waitFor({ timeout: Math.min(a.ms ?? 10_000, 30_000) })
        else await page.waitForTimeout(Math.min(a.ms ?? 1000, 10_000))
        break
    }
    const light = (a.action === 'fill' && !a.submit) || a.action === 'hover' || a.action === 'check' || a.action === 'uncheck' || a.action === 'wait'
    await this.settle(tab, 3000, light)
  }

  /** Run an expression in the page and return its JSON. */
  async evaluate(key: string, expression: string): Promise<string> {
    const tab = this.requireTab(key)
    const value = await tab.page.evaluate(`(async () => (${expression}))()`)
    let text: string
    try { text = JSON.stringify(value, null, 2) ?? 'undefined' } catch { text = String(value) }
    return (text.length > 8000 ? `${text.slice(0, 8000)}…` : text) + this.news(tab)
  }

  /** Errors on the page as it stands now — since it was opened. */
  errorsOnPage(key: string): number {
    const tab = this.tabs.get(key)
    if (!tab) return 0
    return tab.events.slice(tab.openedAt).filter((e) => e.kind !== 'console' || e.level === 'error').length
  }

  /** The page's URL, or undefined with no page. */
  url(key: string): string | undefined {
    const tab = this.tabs.get(key)
    return tab && !tab.page.isClosed() ? tab.page.url() : undefined
  }

  console(key: string, clear = false): string {
    const tab = this.tabs.get(key)
    if (!tab) return 'No browser is open for this card. Use browser_open first.'
    const text = describeEvents(tab.events)
    tab.seen = tab.events.length
    if (clear) { tab.events = []; tab.seen = 0 }
    return text
  }

  async close(key: string): Promise<boolean> {
    const tab = this.tabs.get(key)
    if (!tab) return false
    this.tabs.delete(key)
    await this.stopCast(tab)
    await tab.context.close().catch(() => {})
    if (!this.tabs.size) await this.shutdown()
    return true
  }

  /** Rename a card's tab when the run adopts its real session id. */
  rename(from: string, to: string): void {
    const tab = this.tabs.get(from)
    if (!tab || from === to) return
    this.tabs.delete(from)
    this.tabs.set(to, tab)
  }

  async shutdown(): Promise<void> {
    const b = this.browser
    this.browser = undefined
    this.tabs.clear()
    await b?.close().catch(() => {})
  }

  private requireTab(key: string): Tab {
    const tab = this.tabs.get(key)
    if (!tab || tab.page.isClosed()) throw new Error('No page is open for this card. Use browser_open first.')
    return tab
  }
}

function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'session'
}

async function prune(dir: string, keep: number): Promise<void> {
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => /^shot-\d+\.jpg$/.test(f)).sort()
  for (const f of files.slice(0, Math.max(0, files.length - keep))) await fs.rm(path.join(dir, f), { force: true }).catch(() => {})
}
