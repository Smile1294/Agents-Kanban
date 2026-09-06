/* A runtime that never answers must not take the settings page with it.
 *
 * `collectRuntimeStatus` had a per-runtime try/catch, which handles a runtime
 * that THROWS and does nothing whatever for one that hangs — `Promise.all` then
 * waits forever and the page paints nothing, with no error anywhere. That is
 * this project's oldest failure mode wearing a new hat.
 *
 * It was not hypothetical. `claudeRuntime.login()` built its own `query()` and
 * awaited `accountInfo()` with no timeout and no guaranteed abort: the one CLI
 * call in the codebase with neither, while `connect.ts` states out loud that a
 * wall clock is part of the contract. It survived because it only ever ran
 * first-party, where the handshake answers. Running it with the ACTIVE
 * BACKEND's environment — which is what makes its answer true — points it at
 * whatever the profile points at, and a host that drops packets does not
 * refuse, it hangs.
 *
 * Both halves are fixed: `login()` goes through `withSilentQuery`, and this
 * bounds every runtime anyway, because the next adapter will forget too.
 */
import { collectRuntimeStatus } from '../status.ts'
import type { AgentRuntime, RuntimeLocation } from '../runtime.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const HERE: RuntimeLocation = { command: '/usr/bin/fake', source: 'path' }

/** A runtime that does whatever the test needs and nothing else. */
const fake = (id: string, over: Partial<AgentRuntime>): AgentRuntime => ({
  id: id as never,
  label: id,
  vendor: 'test',
  blurb: '',
  installHint: `install ${id}`,
  capabilities: {
    providerProfiles: true, interrupt: true, steer: true, approvals: true,
    images: true, thinkingToggle: true, durableHistory: true, boardTools: 'inProcess',
  },
  detect: async () => HERE,
  login: async () => ({ kind: 'signedIn', via: 'subscription' }),
  models: async () => ({ models: [], source: 'builtin' }),
  builtinModels: () => [],
  start: () => { throw new Error('not started in this test') },
  ...over,
} as AgentRuntime)

// --- a hang is bounded, and reported as what it is --------------------------
{
  const never = new Promise<never>(() => {})
  const started = Date.now()
  const out = await collectRuntimeStatus(
    {},
    undefined,
    [fake('hangs', { login: () => never }), fake('answers', {})],
    120,
  )
  const took = Date.now() - started

  ok(out.length === 2, 'every runtime is reported, including the one that did not answer')
  ok(took < 3_000, `and the call returns rather than waiting forever (${took}ms)`)

  const hung = out.find((r) => r.id === ('hangs' as never))
  ok(hung?.login.kind === 'unknown',
     `a runtime that never answered is "could not tell" (${hung?.login.kind})`)
  ok(hung?.login.kind === 'unknown' && /did not answer/.test(hung.login.reason),
     'saying so in words, never as "signed out" — that would be asserting a state we did not read')

  const fine = out.find((r) => r.id === ('answers' as never))
  ok(fine?.login.kind === 'signedIn',
     'and the runtime that DID answer is unaffected — one hang must not blank the others')
}

// --- a detect that hangs is bounded too -------------------------------------
// The executable search shells out. On a dead network mount, `which` blocks.
{
  const out = await collectRuntimeStatus(
    {}, undefined, [fake('slowdetect', { detect: () => new Promise<never>(() => {}) })], 100,
  )
  ok(out[0]?.login.kind === 'unknown', 'a detect that never returns is bounded as well as a login')
}

// --- a throw is still a throw ----------------------------------------------
{
  const out = await collectRuntimeStatus(
    {}, undefined, [fake('boom', { login: async () => { throw new Error('kaboom') } })], 5_000,
  )
  ok(out[0]?.login.kind === 'unknown' && /kaboom/.test((out[0].login as { reason: string }).reason),
     'and a runtime that fails outright still reports its reason')
}

// --- the backend's environment reaches the runtime that can use it ----------
//
// The whole point of the change that made the hang reachable: asked WITHOUT it,
// Claude Code reports the login it would use on its own, which is not what any
// session the board starts will use.
{
  const seen: Record<string, unknown> = {}
  const env = { set: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' }, clear: [] }
  await collectRuntimeStatus({}, env, [
    fake('withbackend', { login: async (_l, e) => { seen.with = e; return { kind: 'signedIn', via: 'subscription' } } }),
    fake('ownlogin', {
      capabilities: { ...fake('x', {}).capabilities, providerProfiles: false },
      login: async (_l, e) => { seen.without = e; return { kind: 'signedIn', via: 'subscription' } },
    }),
  ], 5_000)
  ok(seen.with === env, 'a runtime whose backend is selectable is asked in that backend’s environment')
  ok(seen.without === undefined,
     'and one that signs in as itself is not — that would be configuring something that cannot take effect')
}

console.log(fails ? `\n${fails} status test(s) failed` : '\nall runtime-status tests passed')
process.exit(fails ? 1 : 0)
