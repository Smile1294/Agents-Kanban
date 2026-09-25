/**
 * The tools an agent uses to LOOK at its own work: start the app in its
 * worktree, open it in a browser, see it, act on it, read what it logged.
 *
 * Reported as "I want the agents to control the project by themselves, open a
 * web browser and test the feature they worked on, and see the screen". Before
 * this, an agent's evidence that a UI change worked was that the code compiled;
 * the test plan it handed over described a screen it had never seen.
 *
 * They ride the BOARD server (`tools.ts` includes them), so both transports —
 * in-process for Claude Code, the socket bridge for Codex — carry them without
 * a second copy, and the auto-allow list is derived from them like every other
 * board tool. Auto-allowed on purpose: an agent that has to ask before every
 * click cannot verify anything, and the two boundaries that matter are in code
 * rather than in a prompt —
 *
 *  - the app command is the HOST's recipe (`run/recipe.ts`: the user's
 *    `runCommand`, the project's own launcher, or a framework the file tree
 *    proves), never a command the agent wrote; the agent already has Bash for
 *    that, behind its own permission prompt;
 *  - the browser opens loopback URLs only unless the user widened it
 *    (`browser.ts` `allowedUrl`).
 *
 * The app is keyed by WORKTREE, not by run, and outlives the turn: the test
 * plan the agent hands over links to it, and killing it with the run would
 * leave the user a link to nothing. It stops when the worktree is removed, when
 * more than `MAX_APPS` are up, or with the host. The browser is keyed by RUN
 * and closes with it — nobody else looks at it, and it is ~150MB.
 */
import { z } from 'zod'
import type { AppProcesses, AppStatus } from '../run/app.ts'
import type { RunRecipe } from '../run/recipe.ts'
import type { Action, BrowserPool } from './browser.ts'
import type { loadSdk } from './sdk.ts'
import type { Verification } from '../sessions/meta.ts'

/** Agent-started apps kept alive at once. The oldest goes when a new one starts. */
export const MAX_APPS = 4

export type ToolContent = {
  content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  isError?: boolean
}
const ok = (text: string): ToolContent => ({ content: [{ type: 'text', text }] })
const err = (text: string): ToolContent => ({ content: [{ type: 'text', text }], isError: true })

/** What the manager hands in, once, for every run. */
export interface HarnessDeps {
  apps: AppProcesses
  browser: BrowserPool
  /** The host's recipe for a worktree — the Run button's, same settings. */
  recipe: (worktree: string) => Promise<RunRecipe | undefined>
  /** Extra environment for the app, e.g. what a provisioned launcher needs. */
  appEnv?: Record<string, string>
  startTimeoutMs?: number
}

/** One run's view of it: the worktree it may start, the tab it owns. */
export interface Harness {
  appStart(): Promise<ToolContent>
  appLogs(lines?: number): ToolContent
  appStop(): Promise<ToolContent>
  open(url?: string): Promise<ToolContent>
  snapshot(target?: string): Promise<ToolContent>
  screenshot(opts: { fullPage?: boolean; target?: string }): Promise<ToolContent>
  act(a: Action): Promise<ToolContent>
  evaluate(expression: string): Promise<ToolContent>
  console(clear?: boolean): ToolContent
  close(): Promise<ToolContent>
  /** Close this run's browser. Called when the run ends. */
  dispose(): Promise<void>
  /** What this run was seen to check in its browser, or undefined when it
   *  opened nothing. Stamped onto the test plan by `set_phase`. */
  ledger(): Verification | undefined
}

export function describeApp(s: AppStatus, logTail: string[] = []): string {
  const head = s.state === 'running'
    ? `The app is running at ${s.url}.`
    : s.state === 'starting'
      ? `The app is still starting${s.url ? ` (expected at ${s.url})` : ''}.`
      : `The app is not running: ${s.detail ?? s.state}.`
  const lines = [head, `Started from: ${s.why} — \`${s.commands.join(' && ')}\``]
  if (logTail.length) lines.push('', `Last ${logTail.length} line(s) of its output:`, ...logTail)
  return lines.join('\n')
}

/**
 * Bind the harness to one run. `worktree` is where the app is started;
 * `runKey` is the run's own id (stable for its whole life, unlike the card key,
 * which changes when the session id arrives).
 */
export function bindHarness(deps: HarnessDeps, worktree: () => string | undefined, runKey: string): Harness {
  const wrap = async (f: () => Promise<ToolContent>): Promise<ToolContent> => {
    try { return await f() } catch (e) { return err(e instanceof Error ? e.message : String(e)) }
  }
  // The ledger: counted HERE, where the calls happen, not asked of the agent.
  let pages = 0
  let actions = 0
  const shots: string[] = []
  let lastErrors = 0
  let lastUrl: string | undefined
  const visited: string[] = []
  const settle = () => {
    lastErrors = deps.browser.errorsOnPage?.(runKey) ?? lastErrors
    lastUrl = deps.browser.url?.(runKey) ?? lastUrl
    if (lastUrl && /^https?:/.test(lastUrl) && !visited.includes(lastUrl)) {
      visited.push(lastUrl)
      if (visited.length > 6) visited.shift()
    }
  }
  const dir = () => {
    const d = worktree()
    if (!d) throw new Error('This session has no worktree, so there is no app of its own to start.')
    return d
  }
  return {
    appStart: () => wrap(async () => {
      const cwd = dir()
      const have = deps.apps.status(cwd)
      if (have && (have.state === 'running' || have.state === 'starting')) {
        return ok(`${describeApp(have)}\nIt was already started — use app_logs for its output, app_stop to restart it.`)
      }
      const recipe = await deps.recipe(cwd)
      if (!recipe) {
        return err(
          'The board could not work out how to start this project: no agentsKanban.runCommand setting, ' +
          'no per-worktree launcher, and no dev/start/serve script in package.json. Start it yourself ' +
          'with Bash (in the background), then pass its URL to browser_open.',
        )
      }
      // The oldest agent app goes first when there are too many — a dev
      // server per card the user ever ran is a machine full of node processes.
      const running = deps.apps.keys()
      if (running.length >= MAX_APPS) {
        const oldest = running
          .map((k) => ({ k, at: deps.apps.status(k)?.startedAt ?? 0 }))
          .sort((a, b) => a.at - b.at)[0]
        if (oldest) await deps.apps.stop(oldest.k)
      }
      const st = await deps.apps.start(cwd, cwd, recipe, {
        ...(deps.appEnv ? { env: deps.appEnv } : {}),
        ...(deps.startTimeoutMs ? { timeoutMs: deps.startTimeoutMs } : {}),
      })
      const tail = st.state === 'running' ? deps.apps.logs(cwd, 15) : deps.apps.logs(cwd, 60)
      const text = describeApp(st, tail)
      return st.state === 'running'
        ? ok(`${text}\n\nNext: browser_open (no url needed — it opens this one).`)
        : err(text)
    }),
    appLogs: (lines = 80) => {
      const d = worktree()
      const st = d ? deps.apps.status(d) : undefined
      if (!d || !st) return ok('No app has been started for this worktree. Use app_start.')
      return ok(describeApp(st, deps.apps.logs(d, Math.min(Math.max(lines, 1), 400))))
    },
    appStop: () => wrap(async () => {
      const d = worktree()
      return ok(d && (await deps.apps.stop(d)) ? 'Stopped the app and everything it started.' : 'No app was running for this worktree.')
    }),
    open: (url) => wrap(async () => {
      let target = url?.trim()
      if (!target) {
        const d = worktree()
        const st = d ? deps.apps.status(d) : undefined
        if (st?.state !== 'running' || !st.url) {
          return err('No url given and no app running for this worktree. Call app_start first, or pass a url.')
        }
        target = st.url
      }
      const text = await deps.browser.open(runKey, target)
      pages += 1
      settle()
      return ok(text)
    }),
    snapshot: (target) => wrap(async () => ok(await deps.browser.snapshot(runKey, target))),
    screenshot: (opts) => wrap(async () => {
      const shot = await deps.browser.screenshot(runKey, opts)
      if (shot.saved) { shots.push(shot.saved); if (shots.length > 6) shots.shift() }
      settle()
      return {
        content: [
          { type: 'image', data: shot.data, mimeType: shot.mimeType },
          {
            type: 'text',
            text: `Screenshot of ${shot.where}${shot.saved ? `\nSaved to ${shot.saved} — link it in howToTest (kind "file") to show the user.` : ''}${shot.news}`,
          },
        ],
      }
    }),
    act: (a) => wrap(async () => {
      const text = await deps.browser.act(runKey, a)
      actions += 1
      settle()
      return ok(text)
    }),
    evaluate: (expression) => wrap(async () => {
      const text = await deps.browser.evaluate(runKey, expression)
      settle()
      return ok(text)
    }),
    console: (clear) => ok(deps.browser.console(runKey, clear)),
    close: () => wrap(async () => ok((await deps.browser.close(runKey)) ? 'Closed the browser.' : 'No browser was open.')),
    dispose: async () => { await deps.browser.close(runKey).catch(() => false) },
    ledger: () => {
      if (!pages) return undefined
      // The page may have logged more since the last call (a timer, a poll).
      settle()
      return {
        pages, actions, screenshots: [...shots], consoleErrors: lastErrors,
        ...(lastUrl ? { url: lastUrl } : {}), ...(visited.length ? { urls: [...visited] } : {}), at: Date.now(),
      }
    },
  }
}

/** The SDK's `tool` helper, as `tools.ts` receives it. */
type ToolFn = Awaited<ReturnType<typeof loadSdk>>['tool']

const TARGET = 'A Playwright selector: CSS ("#save", "form input[name=email]"), text ("text=Sign in") or role ("role=button[name=\\"Save\\"]"). The names in browser_snapshot are what role selectors match.'

/**
 * The definitions. Always built, whatever the context, so the auto-allow list
 * derived from them is complete; a context without a harness answers each call
 * with the reason, rather than the tools being absent — a missing tool looks
 * to the model exactly like one it was never given, and it would try Bash
 * with a browser it does not have.
 */
export function buildHarnessTools(h: Harness | undefined, tool: ToolFn) {
  const none = () => err('The browser and app tools are not available in this session (the board was started without them).')
  const hint = { readOnlyHint: true }
  return [
    tool(
      'app_start',
      'Start the app in YOUR worktree (the same recipe as the board\'s Run button) and wait until it answers. ' +
        'Returns its URL, or why it did not come up with the tail of its output. Keeps running after your turn so the ' +
        'user can open it; a second call returns the running one.',
      {},
      async () => (h ? h.appStart() : none()),
      { searchHint: 'dev server run app start' },
    ),
    tool(
      'app_logs',
      'The recent output (stdout and stderr) of the app app_start started. Read it when a page errors or does not load.',
      { lines: z.number().int().optional().describe('How many lines, newest last. Default 80, max 400.') },
      async (args) => (h ? h.appLogs(args.lines) : none()),
      { annotations: hint },
    ),
    tool(
      'app_stop',
      'Stop the app app_start started, and everything it spawned. Use it to restart after a change the server does not hot-reload.',
      {},
      async () => (h ? h.appStop() : none()),
    ),
    tool(
      'browser_open',
      'Open a page in your own headless browser (1280x800) and report its title plus any console errors or failed requests. ' +
        'Omit url to open the app app_start is running. Only this machine\'s addresses (localhost) can be opened.',
      { url: z.string().optional().describe('e.g. "http://localhost:5173/settings", or ":5173/settings"') },
      async (args) => (h ? h.open(args.url) : none()),
      { searchHint: 'browser open page navigate test ui' },
    ),
    tool(
      'browser_snapshot',
      'The page as text: its accessibility tree (headings, buttons, links, inputs, their names and states). Cheap — ' +
        'prefer it over a screenshot to find things and to check text and state. Pass a target to look at one part.',
      { target: z.string().optional().describe(TARGET) },
      async (args) => (h ? h.snapshot(args.target) : none()),
      { annotations: hint },
    ),
    tool(
      'browser_screenshot',
      'A picture of the page, for checking what it LOOKS like: layout, overflow, colours, images. ~1.5k tokens each — ' +
        'use browser_snapshot for everything else. Saved to a file you can link in howToTest.',
      {
        fullPage: z.boolean().optional().describe('The whole scrollable page, not just the viewport.'),
        target: z.string().optional().describe(`Only this element. ${TARGET}`),
      },
      async (args) => (h ? h.screenshot(args) : none()),
      { annotations: hint },
    ),
    tool(
      'browser_act',
      'Do one thing on the page: click, fill (optionally submit with Enter), press a key, select an option, hover, ' +
        'check/uncheck, scroll, or wait for an element. Reports where the page ended up and any new console errors.',
      {
        action: z.enum(['click', 'fill', 'press', 'select', 'hover', 'check', 'uncheck', 'scroll', 'wait']),
        target: z.string().optional().describe(`${TARGET} Required for all but press, scroll and a timed wait.`),
        text: z.string().optional().describe('fill: the text to type. select: the option value or label.'),
        key: z.string().optional().describe('press: e.g. "Enter", "Escape", "Control+A".'),
        submit: z.boolean().optional().describe('fill: press Enter afterwards.'),
        dy: z.number().optional().describe('scroll: pixels down (negative is up).'),
        ms: z.number().optional().describe('wait: how long, or the timeout when waiting for a target.'),
      },
      async (a) => {
        if (!h) return none()
        const need = (v: string | undefined, what: string) => {
          if (!v) throw new Error(`${a.action} needs \`${what}\`.`)
          return v
        }
        try {
          const action: Action =
            a.action === 'click' || a.action === 'hover' || a.action === 'check' || a.action === 'uncheck'
              ? { action: a.action, target: need(a.target, 'target') }
              : a.action === 'fill' ? { action: 'fill', target: need(a.target, 'target'), text: a.text ?? '', ...(a.submit ? { submit: true } : {}) }
              : a.action === 'select' ? { action: 'select', target: need(a.target, 'target'), value: need(a.text, 'text') }
              : a.action === 'press' ? { action: 'press', key: need(a.key, 'key'), ...(a.target ? { target: a.target } : {}) }
              : a.action === 'scroll' ? { action: 'scroll', dy: a.dy ?? 600 }
              : { action: 'wait', ...(a.target ? { target: a.target } : {}), ...(a.ms ? { ms: a.ms } : {}) }
          return h.act(action)
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    ),
    tool(
      'browser_eval',
      'Evaluate a JavaScript expression in the page and return its value as JSON (awaited if it is a promise). ' +
        'For reading state the tree does not show: localStorage, a computed style, an element count.',
      { expression: z.string().describe('e.g. "getComputedStyle(document.querySelector(\'h1\')).color"') },
      async (args) => (h ? h.evaluate(args.expression) : none()),
    ),
    tool(
      'browser_console',
      'Everything the page reported since it opened: console errors and warnings, uncaught exceptions, failed requests, HTTP errors.',
      { clear: z.boolean().optional().describe('Forget them afterwards, to see only what the next steps cause.') },
      async (args) => (h ? h.console(args.clear) : none()),
      { annotations: hint },
    ),
    tool(
      'browser_close',
      'Close your browser. It also closes on its own when your run ends.',
      {},
      async () => (h ? h.close() : none()),
    ),
  ]
}

/** The brief's paragraph. Stated only where the tools work. */
export function harnessBrief(required = false): string[] {
  return [
    'You can LOOK at your work. If the change shows up in a UI, check it before you hand it over:',
    '`app_start` (starts the app in this worktree), `browser_open`, then `browser_snapshot` to',
    'find things and `browser_act` to use them. `browser_screenshot` when appearance matters.',
    'Console errors and failed requests are reported with every step — fix them, or say why not.',
    'Put what you checked, and the screenshot paths, in `howToTest`.',
    ...(required
      ? ['On this board it is REQUIRED: a change to files a browser shows cannot move to review until you have opened it.']
      : []),
    'When you move to review the board also runs its own check (the pages you opened, and the project\'s e2e suite',
    'if it has one — test:e2e, e2e, playwright…) and shows the result. A page load cannot see a wrong NUMBER, so if',
    'there is such a suite, add or update a test for what you changed: that is what makes the check able to say bad.',
    '',
  ]
}
