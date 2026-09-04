/**
 * Ask the CLI a question without starting a turn.
 *
 * `query()` spawns the CLI and completes an `initialize` control request BEFORE
 * it reads anything from the prompt iterable — and that response already carries
 * the account (so, the provider) and the full model list. So a caller that only
 * wants to *interrogate* Claude Code can hand it a prompt that never yields, ask
 * its control questions, and abort. Nothing reaches a model: no token billed, no
 * rate limit consumed. Measured against a real CLI: ~460ms.
 *
 * This lives on its own because two callers need it — the provider probe and
 * model discovery — and the part that is easy to get wrong is not the question,
 * it is the lifecycle around it: a prompt iterable that must stay open, a
 * timeout, and an abort that MUST run whatever happens. A CLI process leaked per
 * press of a button is invisible until the machine is out of memory.
 */
import { loadSdk, resolveClaudeExecutable, type Options, type Query } from './sdk.ts'
import { agentEnv } from './session.ts'
import type { ProviderEnv } from './providers.ts'

export interface ConnectOptions {
  claudeExecutable?: string
  cwd?: string
  /** A base URL pointing at a host that silently drops packets does not fail,
   *  it hangs. Everything here is behind a button, so a wall clock is part of
   *  the contract rather than defensive habit. */
  timeoutMs?: number
}

export class ConnectError extends Error {}

/**
 * A prompt that never produces a message and never ends on its own.
 *
 * `query()` requires an AsyncIterable, and a bare string would make the SDK
 * close the child's stdin after one result — the same trap `AgentSession`
 * documents. Here we want the opposite of a turn: connect, ask, leave.
 */
async function* silentPrompt(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/**
 * Open a CLI connection with this provider's environment, run `ask`, shut it
 * down.
 *
 * `ask` is handed the live `Query` and a `race` helper: anything it awaits
 * should go through `race` so a wedged child cannot hold the button forever.
 * The whole call is bounded by `timeoutMs` regardless.
 */
export async function withSilentQuery<T>(
  env: ProviderEnv,
  opts: ConnectOptions,
  ask: (q: Query, race: <R>(p: Promise<R> | undefined) => Promise<R | undefined>) => Promise<T>,
): Promise<T> {
  const exe = await resolveClaudeExecutable(opts.claudeExecutable)
  if (!exe) {
    throw new ConnectError(
      'Could not find the `claude` executable. Install Claude Code, or set ' +
      '"agentsKanban.claudeExecutable" to its path.',
    )
  }

  const abort = new AbortController()
  const timeoutMs = opts.timeoutMs ?? 20_000
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ConnectError(`No answer within ${Math.round(timeoutMs / 1000)}s.`)),
      timeoutMs,
    )
  })
  // Never unhandled: `race` may not be called at all, and an idle rejected
  // promise is a process-level warning (and, under some hosts, a crash).
  expired.catch(() => {})

  try {
    const { query } = await loadSdk()
    const options: Options = {
      abortController: abort,
      pathToClaudeCodeExecutable: exe,
      env: agentEnv(process.env, env.set, env.clear),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      // Nothing should RUN. A question about configuration that could execute a
      // hook or start an MCP server is no longer a question about configuration.
      permissionMode: 'plan',
      mcpServers: {},
    }
    const q = query({ prompt: silentPrompt(abort.signal), options })
    const race = async <R,>(p: Promise<R> | undefined): Promise<R | undefined> =>
      p === undefined ? undefined : Promise.race([p, expired])
    return await ask(q, race)
  } finally {
    if (timer) clearTimeout(timer)
    // Always, and before returning. This is the whole reason the helper exists.
    abort.abort()
  }
}
