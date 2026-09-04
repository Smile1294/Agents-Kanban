/* Testing a provider: does the check ever come back BAD?
 *
 * This file exists because of a bug found by running the thing rather than by
 * testing it. The probe originally asked the CLI `accountInfo()` and reported
 * what it said — and pointed at `http://127.0.0.1:1`, where nothing is
 * listening, the CLI initialised happily and reported `firstParty`. It has made
 * no API request at that point, so it cannot know the endpoint is dead. The
 * button said "Connected" and every agent run afterwards would have failed.
 *
 * So the interesting cases here are all failures, and they are separate cases
 * because they have DIFFERENT FIXES: start your proxy, correct the path, fix
 * the credential, switch the header it goes in. A single "could not connect"
 * covering all four is unactionable.
 *
 * `fetch` and the TCP connect are injected, so every answer is reachable
 * without a server — which is the point: these are the states nobody can
 * conveniently reproduce on demand.
 */
import { checkEndpoint } from '../probe.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

/** A connect that always succeeds — "something is listening". */
const listening = async () => true
/** A fetch that returns one status and records what it was asked. */
const responder = (status: number, seen?: { url?: string; headers?: Record<string, string>; body?: string }) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    if (seen) {
      seen.url = String(url)
      seen.headers = init?.headers as Record<string, string>
      seen.body = String(init?.body ?? '')
    }
    return { status } as Response
  }) as unknown as typeof fetch

// --- nothing is listening ---------------------------------------------------
// The overwhelmingly common failure, and the one the original probe called
// "Connected".
{
  const r = await checkEndpoint('http://127.0.0.1:3456', {}, { connect: async () => false })
  ok(!r.ok, 'a dead port is NOT ok — this is the bug this file exists for')
  ok(!r.reachable, 'and is reported as unreachable, not as an auth problem')
  ok(r.message.includes('3456'), 'the message names the port that was tried')
  ok(/[Ss]tart the proxy/.test(r.message), 'and says what to do about it')
  ok(r.status === undefined, 'with no HTTP status, because there was no HTTP')
}

// --- the default port is derived from the scheme ----------------------------
// A gateway URL usually has no port. Defaulting to 0 would make every https
// gateway "unreachable".
{
  const ports: number[] = []
  await checkEndpoint('https://gw.example.com/anthropic', {}, {
    connect: async (p) => { ports.push(p); return false },
  })
  ok(ports[0] === 443, 'https with no port is checked on 443, not on 0')
  const http: number[] = []
  await checkEndpoint('http://gw.example.com', {}, { connect: async (p) => { http.push(p); return false } })
  ok(http[0] === 80, 'and http on 80')
}

// --- reachable, but not an Anthropic endpoint -------------------------------
{
  const r = await checkEndpoint('http://localhost:8080', {}, { connect: listening, fetchImpl: responder(404) })
  ok(!r.ok, 'a 404 is not a pass — something is listening, but not the thing we need')
  ok(r.reachable, 'though it IS reachable, which is a different fix from a dead port')
  ok(r.status === 404, 'the status is carried')
  ok(r.message.includes('/v1/messages'), 'and the message names what was missing')
}

// --- reachable, credential wrong --------------------------------------------
// Including the single most common cause, which is a correct key in the wrong
// header. The message has to name that, or the user re-types a key that was
// always right.
for (const status of [401, 403]) {
  const r = await checkEndpoint('http://localhost:4000', {}, { connect: listening, fetchImpl: responder(status) })
  ok(!r.ok, `a ${status} is not a pass`)
  ok(r.reachable, `a ${status} means reachable — the credential is the problem, not the address`)
  ok(/x-api-key/.test(r.message) && /Bearer/.test(r.message),
     `a ${status} suggests the other credential style, which is the usual cause`)
}

// --- the gateway is there but its upstream failed ---------------------------
{
  const r = await checkEndpoint('http://localhost:4000', {}, { connect: listening, fetchImpl: responder(502) })
  ok(!r.ok, 'a 502 is not a pass: the gateway answered, its upstream did not')
  ok(r.message.includes('upstream'), 'and the message says whose problem it is')
}

// --- it works ---------------------------------------------------------------
{
  const r = await checkEndpoint('http://localhost:4000', {}, { connect: listening, fetchImpl: responder(200) })
  ok(r.ok, 'a 200 is a pass')
  ok(r.status === 200, 'with the status')
  ok(/accepted the credential/.test(r.message), 'and says what was actually verified')
}
{
  // A 400 counts as a pass. The endpoint understood the request well enough to
  // object to it — usually because the model id is not one it serves — which is
  // a real answer from a real Anthropic-format endpoint. Failing here would
  // make every router serving only non-Claude models look broken.
  const r = await checkEndpoint('http://localhost:3456', {}, { connect: listening, fetchImpl: responder(400) })
  ok(r.ok, 'a 400 is a pass: only something speaking this API could produce it')
  ok(!/accepted the credential/.test(r.message), 'but it does not claim the credential was accepted')
}

// --- what the request actually looks like -----------------------------------
// It must be the request the gateway documentation prescribes, and it must be
// CHEAP: one token, so this can be a button.
{
  const seen: { url?: string; headers?: Record<string, string>; body?: string } = {}
  await checkEndpoint(
    'http://localhost:4000/',
    { authorization: 'Bearer sk-test', 'x-team': 'core' },
    { connect: listening, fetchImpl: responder(200, seen) },
  )
  ok(seen.url === 'http://localhost:4000/v1/messages',
     'the Messages endpoint is derived from the base URL, with no double slash')
  ok(seen.headers?.authorization === 'Bearer sk-test', 'the credential header is passed through verbatim')
  ok(seen.headers?.['x-team'] === 'core', 'and so are custom headers — a gateway may require them to route at all')
  ok(seen.headers?.['anthropic-version'] === '2023-06-01', 'the API version is sent, as the docs require')
  const body = JSON.parse(seen.body ?? '{}')
  ok(body.max_tokens === 1, 'max_tokens is 1, so a success costs one token and this can be a button')
  ok(body.messages?.length === 1 && body.messages[0].content === '.',
     'and the prompt is a single character')
}

// --- it never throws --------------------------------------------------------
// The caller is a notification. An exception here is a "Test connection" button
// that reports nothing at all.
{
  const r = await checkEndpoint('http://localhost:4000', {}, {
    connect: listening,
    fetchImpl: (async () => { throw new Error('socket hang up') }) as unknown as typeof fetch,
  })
  ok(!r.ok, 'a thrown fetch is a failure')
  ok(r.message.includes('socket hang up'), 'and the reason survives into the message')

  const abort = await checkEndpoint('http://localhost:4000', {}, {
    connect: listening,
    fetchImpl: (async () => {
      const e = new Error('aborted'); e.name = 'AbortError'; throw e
    }) as unknown as typeof fetch,
  })
  ok(!abort.ok, 'a timeout is a failure')
  ok(/did not answer within/.test(abort.message),
     'and says it timed out rather than blaming the credential — a host that drops packets hangs, it does not refuse')

  const bad = await checkEndpoint('not a url', {}, { connect: listening })
  ok(!bad.ok && !bad.reachable, 'an unparseable base URL is reported, not thrown')
}

console.log(fails ? `\n${fails} probe test(s) failed` : '\nall probe tests passed')
process.exit(fails ? 1 : 0)
