/**
 * The board's OWN check of an agent's work, run when the card reaches review.
 *
 * Reported as "can we make it part of the standard flow that it starts testing
 * through Playwright by itself?" The browser tools (`agent/harness.ts`) let an
 * agent check its work, and the test plan records whether it did — but whether
 * it does is still up to the agent, and a prompt is not a guarantee. So the
 * flow does it: the move into a review column is followed, host-side, by
 *
 *  1. starting the app in the card's worktree (the same recipe as the Run
 *     button and `app_start`, reusing an app the agent left running),
 *  2. opening it in the board's own headless Chromium, in a context of its
 *     own, and recording what the page reported while it loaded — console
 *     errors, uncaught exceptions, failed requests, HTTP >= 400 — plus a
 *     screenshot the user can open,
 *  3. running the project's OWN end-to-end suite when it has one
 *     (`test:e2e`, `e2e`, `playwright` or `test:browser` in package.json),
 *     with the app's URL in `BASE_URL` / `PLAYWRIGHT_BASE_URL`.
 *
 * The result rides on the test plan as `autoCheck`, beside the agent's own
 * `verified` record, and the two are kept apart on purpose: one is what the
 * agent looked at, the other is what the board saw with nobody steering.
 *
 * Nothing here decides to spend money: it never resumes an agent. A failure
 * is shown, and sending it back is a click (`sendAutoCheck`).
 *
 * Plain Node; the browser and the app table are injected.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { AppProcesses } from './app.ts'
import { killTree } from './app.ts'
import type { RunRecipe } from './recipe.ts'
import type { BrowserPool } from '../agent/browser.ts'
import type { AutoCheck } from '../sessions/meta.ts'

/** Files whose change can show up in a browser. By extension, then by the
 *  directories frameworks put views in. A heuristic that errs towards
 *  checking: a false positive costs one page load, a false negative is the
 *  UI change nobody looked at. */
export function uiFilesIn(files: readonly string[]): string[] {
  const ext = /\.(html?|css|scss|sass|less|jsx|tsx|vue|svelte|astro|mdx|hbs|ejs|pug|twig|erb|haml|liquid)$/i
  const dirs = /(^|\/)(components?|pages|views|templates|layouts|app\/routes|resources\/(views|js|css)|public|static|styles|ui)\//i
  const blade = /\.blade\.php$/i
  return files.filter((f) => ext.test(f) || blade.test(f) || (dirs.test(f) && /\.(js|ts|php|py|rb)$/i.test(f)))
}

/** The project's own browser suite, if it declares one. */
export async function e2eScript(worktree: string): Promise<string | undefined> {
  const text = await fs.readFile(path.join(worktree, 'package.json'), 'utf8').catch(() => undefined)
  if (!text) return undefined
  try {
    const scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {}
    return ['test:e2e', 'e2e', 'test:browser', 'playwright', 'test:playwright'].find((n) => typeof scripts[n] === 'string')
  } catch {
    return undefined
  }
}

export interface AutoCheckDeps {
  apps: AppProcesses
  browser: BrowserPool
  recipe: (worktree: string) => Promise<RunRecipe | undefined>
  /** Tail kept of the e2e output. */
  tailLines?: number
  e2eTimeoutMs?: number
  startTimeoutMs?: number
}

/**
 * Run the check. Never throws: every way it can fail is a result the card
 * shows, including "could not start the app", which is itself a finding.
 */
export async function runAutoCheck(
  deps: AutoCheckDeps,
  card: string,
  worktree: string,
  changed: readonly string[],
): Promise<AutoCheck> {
  const at = Date.now()
  const ui = uiFilesIn(changed)
  const script = await e2eScript(worktree)
  if (!ui.length && !script) {
    return { ok: true, at, skipped: 'no UI files changed and no e2e script — nothing a browser would show' }
  }
  const out: AutoCheck = { ok: true, at, uiFiles: ui.slice(0, 10) }

  // 1. The app.
  let url: string | undefined
  const recipe = await deps.recipe(worktree)
  if (recipe) {
    const st = deps.apps.status(worktree)?.state === 'running'
      ? deps.apps.status(worktree)!
      : await deps.apps.start(worktree, worktree, recipe, deps.startTimeoutMs ? { timeoutMs: deps.startTimeoutMs } : {})
    if (st.state === 'running' && st.url) {
      url = st.url
      out.url = url
    } else {
      out.ok = false
      out.appError = `${st.detail ?? 'the app did not start'} — ${deps.apps.logs(worktree, 8).join(' | ').slice(0, 600)}`
    }
  } else if (ui.length) {
    out.skipped = 'UI files changed, but the board cannot tell how to start this app (set agentsKanban.runCommand)'
  }

  // 2. The page, in a context of its own — never the agent's tab.
  if (url) {
    const key = `autocheck:${card}`
    try {
      await deps.browser.open(key, url)
      await new Promise((r) => setTimeout(r, 800))
      out.pageErrors = deps.browser.errorsOnPage(key)
      const errs = deps.browser.console(key)
      if (out.pageErrors) out.errorLines = errs.split('\n').filter((l) => l.startsWith('- ')).slice(0, 8)
      const shot = await deps.browser.screenshot(key, {}).catch(() => undefined)
      if (shot?.saved) out.screenshot = shot.saved
      if (out.pageErrors) out.ok = false
    } catch (e) {
      out.ok = false
      out.pageError = e instanceof Error ? e.message.split('\n')[0]! : String(e)
    } finally {
      await deps.browser.close(key).catch(() => false)
    }
  }

  // 3. The project's own suite.
  if (script) {
    const t0 = Date.now()
    const r = await runScript(worktree, `npm run ${script}`, {
      ...(url ? { BASE_URL: url, PLAYWRIGHT_BASE_URL: url } : {}),
      CI: '1',
    }, deps.e2eTimeoutMs ?? 5 * 60_000, deps.tailLines ?? 25)
    out.e2e = { command: `npm run ${script}`, ok: r.ok, tail: r.tail, durationMs: Date.now() - t0, ...(r.timedOut ? { timedOut: true } : {}) }
    if (!r.ok) out.ok = false
  }
  return out
}

async function runScript(
  cwd: string, command: string, env: Record<string, string>, timeoutMs: number, tailLines: number,
): Promise<{ ok: boolean; tail: string[]; timedOut?: boolean }> {
  return new Promise((resolve) => {
    const lines: string[] = []
    const child = spawn(command, {
      cwd, shell: true, detached: process.platform !== 'win32',
      env: { ...process.env, ...env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const push = (c: Buffer) => {
      for (const l of c.toString().split(/\r?\n/)) if (l.trim()) lines.push(l)
      if (lines.length > 400) lines.splice(0, lines.length - 400)
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; void killTree(child) }, timeoutMs)
    child.on('error', (e) => { lines.push(e.message) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && !timedOut, tail: lines.slice(-tailLines), ...(timedOut ? { timedOut: true } : {}) })
    })
  })
}

/** What "Send failure to agent" sends. Concrete, so the agent can reproduce it. */
export function autoCheckPrompt(c: AutoCheck, reviewColumn = 'validating'): string {
  const lines = ['The board ran its own check of your work when you moved to review, and it failed:', '']
  if (c.appError) lines.push(`- The app did not start: ${c.appError}`)
  if (c.pageError) lines.push(`- The page could not be opened: ${c.pageError}`)
  if (c.pageErrors) {
    lines.push(`- ${c.pageErrors} error(s) while ${c.url ?? 'the page'} loaded:`)
    for (const l of c.errorLines ?? []) lines.push(`  ${l}`)
  }
  if (c.e2e && !c.e2e.ok) {
    lines.push(`- \`${c.e2e.command}\` ${c.e2e.timedOut ? 'timed out' : 'failed'}. The end of its output:`, '```', ...c.e2e.tail, '```')
  }
  lines.push('', `Fix it — use app_start, browser_open and browser_console to reproduce — then move back to "${reviewColumn}".`)
  return lines.join('\n')
}
