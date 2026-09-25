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
  shots: number
}

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
  | { action: 'wait'; target?: string; ms?: number }

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
    const context = await browser.newContext({ viewport: VIEWPORT, ignoreHTTPSErrors: true })
    const page = await context.newPage()
    const tab: Tab = { context, page, events: [], seen: 0, shots: have?.shots ?? 0 }
    const add = (e: Omit<PageEvent, 'at'>) => {
      tab.events.push({ ...e, at: Date.now() })
      if (tab.events.length > 500) { tab.events.splice(0, 100); tab.seen = Math.max(0, tab.seen - 100) }
    }
    page.on('console', (m: Pw) => {
      const level = m.type()
      if (level === 'error' || level === 'warning' || level === 'assert') add({ kind: 'console', level, text: m.text() })
    })
    page.on('pageerror', (e: Error) => add({ kind: 'pageerror', text: e.stack?.split('\n').slice(0, 4).join(' | ') ?? e.message }))
    page.on('requestfailed', (r: Pw) => {
      const why = r.failure()?.errorText ?? 'failed'
      // Navigating away cancels in-flight requests; that is not the app's fault.
      if (/ERR_ABORTED/.test(why)) return
      add({ kind: 'requestfailed', text: `${r.method()} ${r.url()} — ${why}` })
    })
    page.on('response', (r: Pw) => {
      if (r.status() >= 400) add({ kind: 'http', text: `${r.status()} ${r.request().method()} ${r.url()}` })
    })
    this.tabs.set(key, tab)
    return tab
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
    const res = await tab.page.goto(allowed.url, { waitUntil: 'load', timeout: 30_000 }).catch((e: Error) => e)
    if (res instanceof Error) {
      const first = res.message.split('\n')[0] ?? ''
      if (/ERR_CONNECTION_REFUSED/.test(first)) {
        throw new Error(`Nothing is listening at ${allowed.url}. Start the app first (app_start), or check its logs (app_logs).`)
      }
      throw new Error(`Could not open ${allowed.url}: ${first}`)
    }
    // Most apps render after `load`; give client-side rendering a moment
    // without waiting on a websocket that never goes idle.
    await tab.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})
    const status = res?.status?.()
    return `Opened ${await this.where(tab)}${status && status >= 400 ? ` (HTTP ${status})` : ''}${this.news(tab)}`
  }

  /** The ARIA tree of the page (or of one element) — the cheap way to see it. */
  async snapshot(key: string, target?: string): Promise<string> {
    const tab = this.requireTab(key)
    const loc = target ? tab.page.locator(target).first() : tab.page.locator('body')
    const tree: string = await loc.ariaSnapshot({ timeout: 5000 })
    const cut = tree.length > 12_000 ? `${tree.slice(0, 12_000)}\n… (truncated; pass a target to look at one part)` : tree
    return `${await this.where(tab)}\n\n${cut}${this.news(tab)}`
  }

  /** A JPEG of the viewport, the full page or one element, and where it was saved. */
  async screenshot(key: string, opts: { fullPage?: boolean; target?: string } = {}): Promise<{ data: string; mimeType: 'image/jpeg'; saved?: string; where: string; news: string }> {
    const tab = this.requireTab(key)
    const shotOpts = { type: 'jpeg', quality: 70, timeout: 10_000 }
    const buf: Buffer = opts.target
      ? await tab.page.locator(opts.target).first().screenshot(shotOpts)
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

  async act(key: string, a: Action): Promise<string> {
    const tab = this.requireTab(key)
    const page = tab.page
    const loc = (t: string) => page.locator(t).first()
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
        if (a.target) await loc(a.target).waitFor({ timeout: Math.min(a.ms ?? 10_000, 30_000) })
        else await page.waitForTimeout(Math.min(a.ms ?? 1000, 10_000))
        break
    }
    await page.waitForLoadState('networkidle', { timeout: 1500 }).catch(() => {})
    return `Done: ${a.action}. Now at ${await this.where(tab)}${this.news(tab)}`
  }

  /** Run an expression in the page and return its JSON. */
  async evaluate(key: string, expression: string): Promise<string> {
    const tab = this.requireTab(key)
    const value = await tab.page.evaluate(`(async () => (${expression}))()`)
    let text: string
    try { text = JSON.stringify(value, null, 2) ?? 'undefined' } catch { text = String(value) }
    return (text.length > 8000 ? `${text.slice(0, 8000)}…` : text) + this.news(tab)
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
