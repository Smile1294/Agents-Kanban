/**
 * Which Claude Code this board runs, and bringing it up to date.
 *
 * The model picker asks the CLI what it can run (`models.ts`), and the CLI
 * answers from a table compiled into THAT VERSION of itself. So the list is
 * exactly as new as the binary on PATH and never newer: Claude Code 2.1.272
 * does not contain the string `claude-opus-5-5` anywhere in its 210MB — not
 * behind a flag, not at all — while 2.1.281 lists Opus 5.5 as the default. No
 * amount of refreshing a list that 2.1.272 answers can produce the model.
 *
 * And this extension is why the binary goes stale. `agentEnv()` sets
 * `DISABLE_AUTOUPDATER` and `DISABLE_UPDATES` on every process it spawns, and
 * rightly — a self-update that ran mid-session corrupted the binary under a
 * running agent (Nimbalyst's NIM-1573). But on a machine whose interactive
 * Claude Code is the VS Code extension, which carries its own binary and is
 * updated by the marketplace, nothing else ever runs the `claude` on PATH, so
 * nothing ever updates it. Reported as "I reload the models and only get Opus
 * 5": the CLI was nine releases behind, and the board gave no hint which
 * version had answered, so the list looked hardcoded.
 *
 * So the version is read and SHOWN, and updating is one click that runs the
 * CLI's own updater. Never automatic: swapping the binary agents run on is not
 * a side effect a model list gets to have.
 *
 * Two traps, both load-bearing:
 *
 *  - `DISABLE_UPDATES` does not only stop the background updater. `claude
 *    update` itself prints "Updates are disabled by your administrator" and
 *    EXITS 0. So this environment is built here and never by `agentEnv()`, and
 *    the outcome is judged by the VERSION before and after, never by the exit
 *    code — an exit 0 that changed nothing is not an update, and a board that
 *    reported it as one would be a signal that cannot say "bad".
 *  - A native install keeps every version in its own file under
 *    `…/claude/versions/` and repoints a symlink, so a running agent keeps the
 *    inode it started on. Any other install (npm, a package manager) is
 *    replaced in place, which is precisely the NIM-1573 failure — so
 *    `replacedInPlace()` exists for the host to ask before updating one of
 *    those under live agents.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { HOST_SESSION_VARS } from './session.ts'

/** `2.1.272 (Claude Code)` → `2.1.272`. Undefined for anything without a
 *  three-part version in it, rather than a guess. */
export function parseCliVersion(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1]
}

/** Numeric, part by part: `2.1.281` > `2.1.272` > `2.1.99`. A string compare
 *  gets the last one wrong, which is the one that matters on a patch bump. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * The environment `claude --version` and `claude update` run with.
 *
 * The host's own, minus the identity of the session it may be running inside —
 * and deliberately NOT through `agentEnv()`, which ADDS `DISABLE_UPDATES` and
 * would turn the update into a silent no-op. What the user's own environment
 * sets is left alone: an administrator's `DISABLE_UPDATES` is a policy, and the
 * CLI's refusal is reported to them rather than routed around.
 */
export function updateEnv(base: Record<string, string | undefined>): Record<string, string> {
  const drop = new Set<string>(HOST_SESSION_VARS)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !drop.has(k)) out[k] = v
  }
  return out
}

interface Ran { code: number | null; out: string; error?: string }

/**
 * Run a command to completion and keep what it said.
 *
 * `stdin` is IGNORED, not left as an open pipe: an updater that stops to ask a
 * question would otherwise wait on a pipe nobody writes to until the wall clock
 * ran out, and the button would look like a slow download for five minutes.
 */
function run(cmd: string, args: string[], env: Record<string, string>, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const done = (r: Ran): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(r) } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: null, out: '', error: e instanceof Error ? e.message : String(e) })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      done({ code: null, out, error: `No answer within ${Math.round(timeoutMs / 1000)}s.` })
    }, timeoutMs)
    // Bounded: an updater printing progress bars must not grow this forever.
    const keep = (d: Buffer): void => { out = (out + d.toString('utf8')).slice(-20_000) }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.on('error', (e) => done({ code: null, out, error: e.message }))
    child.on('close', (code) => done({ code, out }))
  })
}

/** The version of the CLI at `exe`, or undefined when it would not say. */
export async function claudeVersion(
  exe: string,
  env: Record<string, string> = updateEnv(process.env),
  timeoutMs = 10_000,
): Promise<string | undefined> {
  const r = await run(exe, ['--version'], env, timeoutMs)
  return r.code === 0 ? parseCliVersion(r.out) : undefined
}

/**
 * Whether updating the install at `exe` rewrites the file a running agent is
 * executing.
 *
 * False only for a native install, whose versions each live in their own file
 * under `…/claude/versions/` behind a symlink. Anything we cannot recognise is
 * TRUE, because that is the direction in which being wrong is cheap: one extra
 * question, against an agent whose binary was replaced underneath it.
 */
export async function replacedInPlace(exe: string): Promise<boolean> {
  try {
    const real = await fs.realpath(exe)
    return !/[\\/]claude[\\/]versions[\\/][^\\/]+$/.test(real)
  } catch {
    return true
  }
}

export type UpdateOutcome =
  /** The version on disk went up. */
  | { kind: 'updated'; from?: string; to: string; said: string }
  /** It did not, and the CLI said why: already current, managed by a package
   *  manager, or disabled by an administrator. Their words, not ours. */
  | { kind: 'unchanged'; version?: string; said: string }
  /** It could not run, or did not finish. */
  | { kind: 'failed'; version?: string; said: string }

/** Lines that carry no information about the outcome. */
const NOISE = [/^current version:/i, /^checking for updates/i, /^update: /i]

/** The CLI's own account of what happened, in one line a dialog can show. */
export function saidOf(out: string): string {
  return out
    .split(/\r?\n/)
    // Progress bars and colours are terminal furniture, not words.
    .map((l) => l.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim())
    .filter((l) => l && !NOISE.some((re) => re.test(l)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 400)
}

/**
 * Decide what an update did.
 *
 * Pure, so every branch — including the exit-0 refusal — is testable without
 * installing anything. The version is the evidence; the exit code only decides
 * between "the CLI told us why nothing changed" and "it broke".
 */
export function judgeUpdate(p: {
  before?: string
  after?: string
  out: string
  code: number | null
  error?: string
}): UpdateOutcome {
  const said = saidOf(p.out)
  if (p.after && p.before && compareVersions(p.after, p.before) > 0) {
    return { kind: 'updated', from: p.before, to: p.after, said }
  }
  // Without a "before" there is nothing to compare against, so the CLI's own
  // claim is the only evidence — and it is only taken when it names a version.
  if (p.after && !p.before && /successfully updated/i.test(said)) {
    return { kind: 'updated', to: p.after, said }
  }
  const version = p.after ?? p.before
  if (p.error || p.code !== 0) {
    const why = [p.error, said].filter(Boolean).join(' — ')
    return { kind: 'failed', ...(version ? { version } : {}), said: why || `claude update exited with ${p.code}.` }
  }
  return {
    kind: 'unchanged',
    ...(version ? { version } : {}),
    said: said || (version ? `Claude Code is still ${version}.` : 'Claude Code did not say what happened.'),
  }
}

/**
 * Run the CLI's own updater, and report what really changed.
 *
 * Five minutes on the wall clock: this downloads a ~200MB binary, and a timeout
 * that fires mid-download reports a failure the user would then retry into the
 * same wall.
 */
export async function updateClaudeCode(
  exe: string,
  opts: { env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<UpdateOutcome> {
  const env = updateEnv(opts.env ?? process.env)
  const before = await claudeVersion(exe, env)
  const r = await run(exe, ['update'], env, opts.timeoutMs ?? 300_000)
  const after = await claudeVersion(exe, env)
  return judgeUpdate({
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
    out: r.out,
    code: r.code,
    ...(r.error ? { error: r.error } : {}),
  })
}
