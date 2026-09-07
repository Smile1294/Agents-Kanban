/** Lazy loader for the Claude Agent SDK.
 *
 * The SDK is ESM-only (`"type": "module"`, single `sdk.mjs` entry) and a VS Code
 * extension is CommonJS, so it cannot be `require`d. It also must stay OUT of
 * the bundle: it resolves a per-platform native `claude` binary at runtime and
 * bundling breaks that resolution.
 *
 * Verified: esbuild preserves `import()` verbatim for external packages in CJS
 * output, so this loads correctly from the bundled extension.
 *
 * Types are imported with `import type` and erased at compile time, so they
 * cost nothing at runtime and stay CJS-safe.
 */
export type {
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKSessionInfo,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'

type Sdk = typeof import('@anthropic-ai/claude-agent-sdk')

let cached: Promise<Sdk> | undefined

/** Load (once) and return the SDK module. */
export function loadSdk(): Promise<Sdk> {
  cached ??= import('@anthropic-ai/claude-agent-sdk')
  return cached
}

/** Locate the `claude` executable to spawn.
 *
 * The SDK ships a ~190MB per-platform binary. Bundling that into the .vsix
 * makes an 87MB extension, so we exclude it and use the Claude Code CLI you
 * already have. It also means the CLI updates on its own schedule rather than
 * being pinned to whatever we shipped.
 *
 * Order: explicit setting -> `claude` on PATH -> the usual install locations.
 * That is the whole list. This function does NOT reach into `node_modules`.
 *
 * It used to, first in the order, and that was the opposite of the design
 * above: preferring a copy inside `node_modules` means a dev checkout silently
 * runs a *different* Claude Code from the one on the machine.
 *
 * It also broke outright. The bundled binary is a Bun executable, and this one
 * died on startup on a stock Linux 6.8 / glibc 2.39 box:
 *
 *     panic(main thread): Bus error at address 0xD097FD5
 *     oh no: Bun has crashed.
 *
 * Every agent run failed instantly with that while `claude` on PATH — the same
 * product, installed normally — worked. It is gone rather than demoted, because
 * a fallback that only ever fires in a dev checkout, and crashes when it does,
 * is pure liability: it is excluded from the .vsix, so no user ever reaches it.
 * With no `claude` anywhere, session.ts already says so and names the fix.
 *
 * Note what hid it. The lookup ran through `createRequire(__filename)`, and
 * `__filename` does not exist in ESM — so under the test runner it threw, was
 * caught, and the branch was skipped. In the built bundle, which esbuild emits
 * as CJS, `__filename` is real and the branch fired. A unit test could not see
 * this code path at all; it behaved differently in the only place that matters.
 */
export async function resolveClaudeExecutable(configured?: string): Promise<string | undefined> {
  const { promises: fs } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)

  const usable = async (p: string): Promise<boolean> => {
    try { await fs.access(p, (await import('node:fs')).constants.X_OK); return true } catch { return false }
  }

  if (configured?.trim()) {
    return (await usable(configured)) ? configured : undefined
  }

  try {
    const { stdout } = await exec('which', ['claude'])
    const found = stdout.trim()
    if (found && (await usable(found))) return found
  } catch { /* not on PATH */ }

  for (const p of [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    path.join(os.homedir(), '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]) {
    if (await usable(p)) return p
  }

  return undefined
}
