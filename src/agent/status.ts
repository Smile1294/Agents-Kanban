/**
 * Where each agent program is, and who it thinks we are.
 *
 * Here rather than in `board/settings.ts` for the reason this project states as
 * a rule: that file imports `vscode`, so nothing in it can be unit-tested — and
 * what this does is exactly the kind of thing that needs to be. It gathers
 * answers from other people's processes, and the failure it has to survive is
 * one of them never answering at all.
 */
import {
  allRuntimes,
  type AgentRuntime, type LoginState, type RuntimeId, type RuntimeStatus,
} from './runtime.ts'
import type { ProviderEnv } from './providers.ts'

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
  /** Injectable so the failure below can be tested: the registry is global and
   *  a real runtime cannot be made to hang on demand. */
  runtimes: readonly AgentRuntime[] = allRuntimes(),
  /** How long any one runtime may take to answer. */
  timeoutMs = 20_000,
): Promise<RuntimeStatus[]> {
  return Promise.all(runtimes.map(async (rt): Promise<RuntimeStatus> => {
    const at = Date.now()
    /* A WALL CLOCK around each runtime, not just a try/catch.
       The catch below handles a runtime that throws; it does nothing at all for
       one that never answers, and `Promise.all` then waits forever — a settings
       page that paints nothing, with no error, which is this project's oldest
       failure mode. `claudeRuntime.login()` had exactly that shape until it was
       routed through `withSilentQuery`: an unbounded `accountInfo()` that only
       ever answered because it only ever ran first-party. Pointing it at a
       gateway is what made it reachable, and a second adapter will forget its
       own timeout eventually. Bounded here as well, so forgetting is survivable.
       "Could not tell" is a renderable state; a page that never paints is not. */
    const bounded = <T>(p: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${rt.label} did not answer within ${Math.round(timeoutMs / 1000)}s.`)),
        timeoutMs,
      )
      p.then(resolve, reject).finally(() => clearTimeout(timer))
    })
    try {
      const location = await bounded(rt.detect(configured[rt.id]))
      if (!location) {
        return {
          id: rt.id, label: rt.label, at,
          login: { kind: 'notInstalled', fix: rt.installHint },
        }
      }
      const login: LoginState = await bounded(rt.login(
        location,
        // Only where a provider profile can take effect. Handing one to a
        // runtime that signs in as itself would be configuring something that
        // cannot apply.
        rt.capabilities.providerProfiles ? providerEnv : undefined,
      ))
      return { id: rt.id, label: rt.label, at, location, login }
    } catch (e) {
      return {
        id: rt.id, label: rt.label, at,
        login: { kind: 'unknown', reason: e instanceof Error ? e.message : String(e) },
      }
    }
  }))
}
