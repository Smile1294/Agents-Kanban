/**
 * How to start the app in a session's worktree, and where it will answer.
 *
 * The gap this closes was reported as "I didn't know how to launch the worktree
 * stuff". An agent finishes, parks its card in a review column and hands over a
 * test plan — and then testing it by hand meant knowing that the worktree is a
 * separate checkout, that the app has to be started inside it, that the main
 * checkout is already holding port 8000, and that the tool which sorts all that
 * out has to be run from the right directory or it refuses. Four things to know
 * before looking at one change.
 *
 * So: one button. This file is the part that decides WHAT to run, kept pure and
 * away from `vscode` so it can be tested against real directories.
 *
 * Two rules it follows:
 *
 *  - **Prefer the project's own launcher over anything guessed here.** A repo
 *    with a per-worktree environment tool already knows about ports, databases
 *    and cookies, and none of that is inferable from the file tree. Guessing
 *    `php artisan serve` at a project that has `wt` would start a second server
 *    on the main checkout's database with the main checkout's session cookie.
 *  - **Never return a URL that is not known to be right.** A port is either
 *    read from the launcher's own registry, or chosen here from what is
 *    actually free, or absent. A plausible-looking `localhost:8000` that
 *    belongs to a different checkout is worse than no link, because it shows
 *    the OLD code and looks like the change did nothing.
 */
import { promises as fs } from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

/** One command to run in a terminal, in the worktree. */
export interface RunStep {
  /** Shown as the terminal's name, so several steps are tellable apart. */
  name: string
  /** The shell line. Run in the worktree, through the user's own shell. */
  command: string
  /** True when this step is the one that serves the app — the others are
   *  supporting processes (an asset watcher, a queue worker) and must not be
   *  waited on, because they never start listening on the app's port. */
  serves?: boolean
}

export interface RunRecipe {
  steps: RunStep[]
  /** The port the app will answer on, when it can be known before starting. */
  port?: number
  /** What to open once that port answers. */
  url?: string
  /** One line naming what was detected, shown to the user. A button that starts
   *  processes must say what it is about to start. */
  why: string
  /** True when the recipe came from the user's own setting rather than
   *  detection, so a failure is not reported as "we guessed wrong". */
  configured?: boolean
}

/** What `detect` needs from the outside world. Injected so the tests can run
 *  against real directories without a real `wt` or a real PATH. */
export interface RunEnv {
  /** Absolute path of the worktree to run in. */
  worktree: string
  /** The main checkout, when known. A per-worktree launcher refuses to run
   *  there, so it must not be offered as the recipe for it. */
  repoRoot?: string
  /** `agentsKanban.runCommand`, if the user set one. */
  configuredCommand?: string
  /** `agentsKanban.runUrl`, if the user set one. */
  configuredUrl?: string
  /** Where to look for the per-worktree launcher and its registry. */
  home?: string
  /** PATH, for finding the launcher. */
  pathEnv?: string
  /** Resolve a free TCP port at or above `from`. Injected for the tests. */
  freePort?: (from: number) => Promise<number>
}

const exists = async (p: string): Promise<boolean> =>
  fs.access(p).then(() => true, () => false)

const isFile = async (p: string): Promise<boolean> =>
  fs.stat(p).then((st) => st.isFile(), () => false)

/**
 * The slug `wt` files a worktree's ports under.
 *
 * Must match `slug_of()` in that script exactly, or the registry lookup misses
 * and a provisioned worktree looks unprovisioned: lowercase the basename, then
 * every character outside `a-z0-9` becomes `_`, then truncate to 40. The
 * truncation is the easy one to miss — the board's own branch names are long
 * enough to hit it routinely.
 */
export function wtSlug(worktree: string): string {
  return path.basename(worktree).toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 40)
}

/** Ports and paths `wt` recorded for a worktree, if it has been provisioned. */
export async function readWtRegistry(
  worktree: string,
  home = os.homedir(),
): Promise<Record<string, string> | undefined> {
  const file = path.join(home, '.wt', wtSlug(worktree))
  const text = await fs.readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

/** The project's own per-worktree launcher, if the machine has one. Looked for
 *  in `~/.local/bin` as well as on PATH, because that is where it lives and a
 *  GUI-launched VS Code does not inherit a login shell's PATH. */
export async function findWt(home = os.homedir(), pathEnv = process.env.PATH ?? ''): Promise<string | undefined> {
  const candidates = [
    path.join(home, '.local', 'bin', 'wt'),
    ...pathEnv.split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'wt')),
  ]
  for (const c of candidates) if (await isFile(c)) return c
  return undefined
}

/** A port nothing is listening on, at or above `from`. */
export function freeTcpPort(from: number): Promise<number> {
  const tryPort = (p: number): Promise<number> =>
    new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(0))
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(p)))
    })
  return (async () => {
    for (let p = from; p < from + 60; p++) {
      if (await tryPort(p)) return p
    }
    return from
  })()
}

/**
 * Is something answering on this port yet?
 *
 * The whole point of waiting rather than opening immediately: `wt provision`
 * can spend minutes cloning a 7GB database, and `php artisan serve` takes a
 * second or two. Opening the browser before the server answers gives the user a
 * connection error and no idea whether the button worked.
 */
export function isListening(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    const done = (answer: boolean) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(answer)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    sock.connect(port, host)
  })
}

/**
 * Wait for a port to start answering.
 *
 * Polls rather than watching, because the thing being waited for is another
 * process in a terminal we do not own. `shouldStop` is how a cancel button
 * reaches in — a caller that cannot cancel a multi-minute wait is a caller that
 * has to be killed.
 */
export async function waitForPort(
  port: number,
  opts: {
    timeoutMs?: number
    intervalMs?: number
    shouldStop?: () => boolean
    sleep?: (ms: number) => Promise<void>
    probe?: (port: number) => Promise<boolean>
  } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 180_000
  const intervalMs = opts.intervalMs ?? 700
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const probe = opts.probe ?? ((p: number) => isListening(p))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (opts.shouldStop?.()) return false
    if (await probe(port)) return true
    if (Date.now() >= deadline) return false
    await sleep(intervalMs)
  }
}

/** Does this package.json declare a script by that name? */
async function npmScript(dir: string, names: string[]): Promise<string | undefined> {
  const text = await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => undefined)
  if (text === undefined) return undefined
  let scripts: Record<string, unknown> = {}
  try {
    scripts = (JSON.parse(text) as { scripts?: Record<string, unknown> }).scripts ?? {}
  } catch {
    return undefined
  }
  return names.find((n) => typeof scripts[n] === 'string')
}

/**
 * Work out how to start this worktree.
 *
 * Order matters and is the whole design: an explicit setting, then the
 * project's own launcher, then a framework the file tree can prove is there,
 * then nothing — and "nothing" is an answer, not a failure to hide.
 */
export async function detect(env: RunEnv): Promise<RunRecipe | undefined> {
  const { worktree } = env
  const home = env.home ?? os.homedir()
  const freePort = env.freePort ?? freeTcpPort

  // 1. What the user said to do. No detection, no second-guessing — including
  //    no port, unless they also said where to look.
  if (env.configuredCommand?.trim()) {
    const command = env.configuredCommand.replace(/\$\{worktree\}/g, worktree)
    const url = env.configuredUrl?.replace(/\$\{worktree\}/g, worktree)
    const port = url ? Number(/:(\d{2,5})\b/.exec(url)?.[1] ?? 0) || undefined : undefined
    return {
      steps: [{ name: 'Run', command, serves: true }],
      ...(url ? { url } : {}),
      ...(port ? { port } : {}),
      why: 'agentsKanban.runCommand',
      configured: true,
    }
  }

  // 2. The project's own per-worktree launcher. It owns the port, the database
  //    and the session cookie; none of that is guessable from here.
  const wt = await findWt(home, env.pathEnv ?? process.env.PATH ?? '')
  const isMainCheckout = !!env.repoRoot && path.resolve(env.repoRoot) === path.resolve(worktree)
  if (wt && !isMainCheckout && (await exists(path.join(worktree, 'artisan')))) {
    const reg = await readWtRegistry(worktree, home)
    const port = Number(reg?.APP_PORT ?? 0) || undefined
    if (port) {
      return {
        steps: [{ name: 'wt serve', command: `${wt} serve`, serves: true }],
        port,
        url: `http://localhost:${port}`,
        why: `wt — provisioned, port ${port}`,
      }
    }
    // Not provisioned yet. `wt provision` is the step the user hit the wall on:
    // running `wt serve` first fails with "not provisioned yet", which reads
    // like a broken tool rather than a missing setup step. Chained with `&&` so
    // a failed provision does not leave a serve running on the wrong database.
    return {
      steps: [{ name: 'wt provision + serve', command: `${wt} provision && ${wt} serve`, serves: true }],
      // Deliberately NO port: `wt provision` picks it, and it is only knowable
      // by reading the registry after the fact. The caller re-reads it.
      why: 'wt — not provisioned yet, so this provisions first',
    }
  }

  // 3. Laravel without a per-worktree launcher. The port MUST be chosen here:
  //    the main checkout is normally already on 8000, and a second server that
  //    silently lands on another port is a page showing the wrong code.
  if (await exists(path.join(worktree, 'artisan'))) {
    const port = await freePort(8000)
    const steps: RunStep[] = []
    const dev = await npmScript(worktree, ['dev'])
    if (dev) steps.push({ name: 'npm run dev', command: `npm run ${dev}` })
    steps.push({ name: 'artisan serve', command: `php artisan serve --port=${port}`, serves: true })
    return {
      steps,
      port,
      url: `http://localhost:${port}`,
      why: dev ? `Laravel + npm run ${dev}, on port ${port}` : `Laravel, on port ${port}`,
    }
  }

  // 4. A Node project that says how to start itself. The port is whatever the
  //    tool picks, so it is discovered by watching, never assumed.
  const script = await npmScript(worktree, ['dev', 'start', 'serve'])
  if (script) {
    return {
      steps: [{ name: `npm run ${script}`, command: `npm run ${script}`, serves: true }],
      why: `package.json — npm run ${script}`,
    }
  }

  return undefined
}

/**
 * Ports worth checking when the recipe could not name one.
 *
 * A dev server prints its port and we are not reading its output, so this is a
 * short list of the conventional ones rather than a scan. Bounded on purpose:
 * probing widely would find some OTHER project's server and open it, which is
 * the same failure as guessing 8000 — a page that looks like the change did
 * nothing.
 */
export const COMMON_DEV_PORTS = [3000, 5173, 4200, 8080, 5000, 8000] as const
