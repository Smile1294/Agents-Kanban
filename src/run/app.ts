/**
 * The app an AGENT starts in its own worktree, so it can look at its own work.
 *
 * The Run button (`runWorktree` in extension.ts) starts the app for the USER:
 * it opens terminals, because a person reads a terminal. An agent cannot read a
 * VS Code terminal, so the same recipe (`recipe.ts`) is started here as child
 * processes whose output is kept in a ring buffer the agent can ask for. That
 * difference is the whole reason this file exists: "the server crashed on
 * boot" is only something an agent can fix if it can see the stack trace.
 *
 * Three rules, each the answer to a failure the Run button already had to
 * learn:
 *
 *  - **The port is one this process ANNOUNCED, or one we chose, never one we
 *    found.** The Run button falls back to scanning conventional ports, and for
 *    a person that is a reasonable last resort. For an agent it is the exact
 *    failure `recipe.ts` warns about: another worktree's server answering on
 *    3000 shows the OLD code, the screenshot looks fine, and the agent reports
 *    a change it never saw. So a port is accepted only from the recipe, from a
 *    `PORT` we set ourselves, or from a URL printed on THIS child's own output.
 *  - **Everything it starts, it stops.** A server is a process group, and a
 *    `kill` of the shell leaves `node vite` running holding the port forever.
 *    Groups are killed whole, on `stop`, when the run ends, and on dispose.
 *  - **Nothing is written into the worktree.** Output lives in memory.
 *
 * Plain Node, no `vscode`: unit-tested against real child processes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import type { PrepareStep, RunRecipe } from './recipe.ts'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { freeTcpPort, isListening } from './recipe.ts'

/** Lines kept per app. Enough for a stack trace and the boot banner above it. */
export const LOG_LINES = 400

/** The longest a start waits for the port by default. `wt provision` can clone
 *  a database; a plain dev server answers in seconds. */
export const START_TIMEOUT_MS = 120_000

export interface AppStatus {
  /** `starting` until something answers, `running` after, `exited` when the
   *  serving process is gone (with its code), `failed` when it never came up. */
  state: 'starting' | 'running' | 'exited' | 'failed'
  url?: string
  port?: number
  /** Why the state is what it is, in one line — "exited with code 1". */
  detail?: string
  /** What was started, from the recipe. */
  why: string
  commands: string[]
  startedAt: number
}

interface App {
  status: AppStatus
  children: ChildProcess[]
  log: string[]
  /** A partial last line, per stream, carried until its newline arrives. */
  partial: Map<string, string>
}

/**
 * The first local URL a dev server printed, if it printed one.
 *
 * Vite prints `➜  Local:   http://localhost:5173/`, Next prints
 * `- Local: http://localhost:3000`, artisan prints
 * `Server running on [http://127.0.0.1:8000]`. Only loopback hosts count — a
 * `Network: http://192.168…` line names the same server, and an external URL in
 * a log is not the app. ANSI colour codes are stripped first, because Vite
 * paints the port number in a different colour from the rest of the URL.
 */
export function announcedUrl(line: string): { url: string; port: number } | undefined {
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  const m = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})(?:\/[^\s\]\)'"]*)?/i.exec(plain)
  if (!m) return undefined
  const port = Number(m[1])
  if (!port || port > 65535) return undefined
  // `0.0.0.0` is where it LISTENS, not somewhere a browser can go.
  const url = m[0].replace('0.0.0.0', 'localhost').replace(/\[::1?\]/, 'localhost').replace(/\/$/, '')
  return { url, port }
}

/** The longest the setup of a fresh worktree may take: `composer install`
 *  and `npm ci` on a cold cache are minutes. */
export const PREPARE_TIMEOUT_MS = 15 * 60_000

/**
 * Run a recipe's setup, in order, each to completion (`PrepareStep`). Every
 * line goes to `onLine`, so the agent reading `app_logs` and the user reading
 * the output channel see WHICH step failed and why — "the app did not start"
 * about an `npm ci` that failed is the report this exists to replace.
 */
export async function runPrepare(
  steps: readonly PrepareStep[], cwd: string, env: Record<string, string>, onLine: (line: string) => void,
  timeoutMs = PREPARE_TIMEOUT_MS,
): Promise<{ ok: true } | { ok: false; step: string; detail: string }> {
  const deadline = Date.now() + timeoutMs
  for (const step of steps) {
    onLine(`# setup: ${step.name}`)
    try {
      if ('copy' in step) {
        await fs.copyFile(step.copy.from, step.copy.to)
        continue
      }
      if ('touch' in step) {
        await fs.mkdir(path.dirname(step.touch), { recursive: true })
        await fs.writeFile(step.touch, '', { flag: 'a' })
        continue
      }
    } catch (e) {
      return { ok: false, step: step.name, detail: e instanceof Error ? e.message : String(e) }
    }
    onLine(`$ ${step.command}`)
    const code = await new Promise<number | 'timeout'>((resolve) => {
      const child = spawn(step.command, {
        cwd, shell: true, detached: process.platform !== 'win32',
        env: { ...process.env, ...env, FORCE_COLOR: '0', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      const feed = (prefix: string) => (c: Buffer) => { for (const l of c.toString().split(/\r?\n/)) if (l.trim()) onLine(prefix + l) }
      child.stdout?.on('data', feed(''))
      child.stderr?.on('data', feed('! '))
      const timer = setTimeout(() => { void killTree(child).then(() => resolve('timeout')) }, Math.max(1000, deadline - Date.now()))
      child.on('error', (e) => onLine(`! ${e.message}`))
      child.on('close', (c) => { clearTimeout(timer); resolve(c ?? 1) })
    })
    if (code !== 0) {
      return { ok: false, step: step.name, detail: code === 'timeout' ? 'timed out' : `exited with code ${code}` }
    }
  }
  return { ok: true }
}

export interface StartOptions {
  /** Environment for the child, over `process.env`. */
  env?: Record<string, string>
  timeoutMs?: number
  /** Injected by tests. */
  freePort?: (from: number) => Promise<number>
  listening?: (port: number) => Promise<boolean>
}

/**
 * Every app agents have started, keyed by the card that started it.
 *
 * One app per key: a second `start` for the same card returns the one already
 * running rather than starting another on a second port, which is what an
 * agent retrying after a slow boot would otherwise do to itself.
 */
export class AppProcesses {
  private readonly apps = new Map<string, App>()

  status(key: string): AppStatus | undefined {
    const a = this.apps.get(key)
    return a ? { ...a.status } : undefined
  }

  /** The last `n` lines of output, both streams interleaved as they came. */
  logs(key: string, n = 80): string[] {
    const a = this.apps.get(key)
    if (!a) return []
    const tail = [...a.log]
    for (const [stream, rest] of a.partial) if (rest) tail.push(`${stream === 'stderr' ? '! ' : ''}${rest}`)
    return tail.slice(-Math.max(1, n))
  }

  keys(): string[] { return [...this.apps.keys()] }

  /**
   * Start the recipe's steps in `cwd` and wait until the app answers.
   *
   * Resolves with the status either way — a failure to come up is an answer
   * the agent needs (with the log tail), never a throw that loses it.
   */
  async start(key: string, cwd: string, recipe: RunRecipe, opts: StartOptions = {}): Promise<AppStatus> {
    const existing = this.apps.get(key)
    if (existing && (existing.status.state === 'running' || existing.status.state === 'starting')) {
      return { ...existing.status }
    }
    if (existing) await this.stop(key)

    const listening = opts.listening ?? ((p: number) => isListening(p))
    const env: Record<string, string> = { ...(opts.env ?? {}) }
    // A port we can name before starting: the recipe's, or one we choose and
    // hand over as PORT — which Next, Express, CRA, Remix, Nuxt and artisan's
    // wrappers all honour. A server that ignores it will still announce the
    // port it did take, and that is read off its output below.
    let chosen = recipe.port
    if (!chosen && !recipe.configured) {
      chosen = await (opts.freePort ?? freeTcpPort)(3100)
      env.PORT = String(chosen)
    }

    const app: App = {
      status: {
        state: 'starting',
        why: recipe.why,
        commands: recipe.steps.map((s) => s.command),
        startedAt: Date.now(),
        ...(chosen ? { port: chosen } : {}),
        ...(recipe.url ? { url: recipe.url } : chosen ? { url: `http://localhost:${chosen}` } : {}),
      },
      children: [],
      log: [],
      partial: new Map(),
    }
    this.apps.set(key, app)

    // A fresh worktree first gets what it lacks (`vendor/`, `node_modules/`,
    // `.env`, a SQLite file) — logged into the same buffer, so `app_logs`
    // shows `npm ci` failing rather than a server that "did not start".
    Object.assign(env, recipe.env ?? {})
    if (recipe.prepare?.length) {
      app.status.detail = `setting up: ${recipe.prepare.map((p) => p.name).join(', ')}`
      const pushLine = (l: string) => {
        app.log.push(l)
        if (app.log.length > LOG_LINES) app.log.splice(0, app.log.length - LOG_LINES)
      }
      const prep = await runPrepare(recipe.prepare, cwd, env, pushLine)
      if (this.apps.get(key) !== app) return { ...app.status }
      if (!prep.ok) {
        app.status.state = 'failed'
        app.status.detail = `setup step "${prep.step}" failed: ${prep.detail}`
        return { ...app.status }
      }
      delete app.status.detail
    }

    let announced: { url: string; port: number } | undefined
    const push = (stream: string, chunk: Buffer | string) => {
      const text = (app.partial.get(stream) ?? '') + chunk.toString()
      const lines = text.split(/\r?\n/)
      app.partial.set(stream, lines.pop() ?? '')
      for (const line of lines) {
        app.log.push(`${stream === 'stderr' ? '! ' : ''}${line}`)
        announced ??= announcedUrl(line)
      }
      if (app.log.length > LOG_LINES) app.log.splice(0, app.log.length - LOG_LINES)
    }

    for (const step of recipe.steps) {
      app.log.push(`$ ${step.command}`)
      const child = spawn(step.command, {
        cwd,
        shell: true,
        // Its own process group, so `stop` can take the whole tree down.
        detached: process.platform !== 'win32',
        env: { ...process.env, ...env, FORCE_COLOR: '0', BROWSER: 'none' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      app.children.push(child)
      child.stdout?.on('data', (c) => push('stdout', c))
      child.stderr?.on('data', (c) => push('stderr', c))
      child.on('error', (e) => app.log.push(`! ${step.name}: ${e.message}`))
      if (step.serves) {
        child.on('exit', (code, signal) => {
          if (this.apps.get(key) !== app) return
          if (app.status.state === 'failed') return
          app.status.state = 'exited'
          app.status.detail = signal ? `stopped by ${signal}` : `exited with code ${code ?? '?'}`
        })
      }
    }

    const deadline = Date.now() + (opts.timeoutMs ?? START_TIMEOUT_MS)
    while (Date.now() < deadline) {
      if (this.apps.get(key) !== app) return { ...app.status }
      if (app.status.state === 'exited') {
        app.status.state = 'failed'
        app.status.detail = `${app.status.detail} before it answered`
        return { ...app.status }
      }
      const port = announced?.port ?? chosen
      if (port && (await listening(port))) {
        app.status.state = 'running'
        app.status.port = port
        app.status.url = announced && announced.port === port ? announced.url
          : recipe.url && recipe.port === port ? recipe.url
          : `http://localhost:${port}`
        return { ...app.status }
      }
      await new Promise((r) => setTimeout(r, 300))
    }
    app.status.state = 'failed'
    app.status.detail = announced || chosen
      ? `nothing answered on port ${announced?.port ?? chosen} within ${Math.round((opts.timeoutMs ?? START_TIMEOUT_MS) / 1000)}s`
      : 'it never printed a local URL, and the recipe names no port — set agentsKanban.runUrl'
    return { ...app.status }
  }

  /** Stop one app: its whole process group, then SIGKILL whatever ignored that. */
  async stop(key: string): Promise<boolean> {
    const app = this.apps.get(key)
    if (!app) return false
    this.apps.delete(key)
    await Promise.all(app.children.map((c) => killTree(c)))
    return true
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.apps.keys()].map((k) => this.stop(k)))
  }
}

/** Kill a child and everything it started. Resolves when the whole group is
 *  gone, or after the SIGKILL grace — never hangs a run's shutdown on a
 *  stubborn server.
 *
 *  Waiting for the CHILD's exit is not enough, and was the first version: the
 *  child is `sh -c`, which dies on SIGTERM at once while the server it started
 *  is still closing its socket — so `stop` returned, the port still answered,
 *  and the next start on that port found the old server. The group is polled
 *  until it is empty. */
export async function killTree(child: ChildProcess, graceMs = 3000): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    if (child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
        .on('error', () => resolve()).on('exit', () => resolve())
    })
    return
  }
  const alive = () => { try { process.kill(-pid, 0); return true } catch { return false } }
  const signal = (sig: NodeJS.Signals) => {
    try { process.kill(-pid, sig) } catch { try { child.kill(sig) } catch { /* already gone */ } }
  }
  if (!alive()) return
  signal('SIGTERM')
  const deadline = Date.now() + graceMs
  while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  if (alive()) {
    signal('SIGKILL')
    const hard = Date.now() + 1000
    while (alive() && Date.now() < hard) await new Promise((r) => setTimeout(r, 50))
  }
}
