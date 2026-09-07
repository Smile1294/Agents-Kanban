/** The headless board's auth hardening, end to end.
 *
 * Spawns server/server.mjs the way headless.test.mjs does — against a
 * throwaway git repo, known pairing code, ephemeral port — and drives the
 * HTTP surface with fetch. No Chromium here; the browser half of the same
 * contract (gate → exchange → token → board) is headless.test.mjs's job.
 *
 * What is guarded, and what breaks if reverted:
 *
 *  - the CODE is refused everywhere except POST /api/session and
 *    /api/revoke — sending it on /api/msg or in the stream URL is a 401
 *  - wrong-code attempts are rate limited per IP: a couple of 401s, then 429
 *    with Retry-After (exponential backoff), then a hard 403 block whose
 *    engagement is logged exactly once, which even a RIGHT code cannot pass;
 *    the block lifts on its own and a real code clears the slate
 *  - a token expires after AGENTS_KANBAN_TOKEN_TTL and the failure says
 *    "expired" rather than "unknown"
 *  - POST /api/revoke kills every token minted before it — by code or by an
 *    existing token — and a token minted after still works. An SSE stream
 *    already open on a revoked token is ENDED, not left reading: a revoked
 *    client receives no board frame after the revoke
 *  - a restart resets the epoch: a token minted before a restart is dead after
 *    it, and a fresh exchange works
 *  - the pairing code never appears in the server log during the exchange,
 *    wrong-code or revoke flows (the startup banner prints it by design; the
 *    assertion slices that print off)
 *  - startup says what is exposed: a non-loopback bind warns on stderr; a
 *    supplied code under 10 characters is called guessable; a generated code
 *    says it was generated. Loopback stays silent (headless.test.mjs checks).
 *
 * Every guard above was demonstrated RED when reverted, 2026-09-07 (S106bw):
 * accepting the code on other routes broke headless.test.mjs's two code-refusal
 * gates; bypassing the limiter broke seven backoff/block assertions; dropping
 * the expiry check and the revoke epoch bump each broke their two; skipping
 * the revoke's stream-close broke this file's two stream assertions (the
 * red run: "revoke ends every OPEN event stream" and "no board frame is
 * delivered to a revoked stream"); disabling the startup warnings broke all
 * four warning assertions; and logging the code in the wrong-code flow broke
 * the log-coverage assertion. The restart test's guard is against a change
 * that does not exist yet (persisting tokens or the epoch to storage) — that
 * is what its comment says, and it has no reversion to demonstrate.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

let failed = 0
const ok = (cond, label) => { console.log((cond ? 'ok: ' : 'FAIL: ') + label); if (!cond) failed++ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const CODE = 'auth-gate-code'

/** Spawn one headless server. Returns { base, kill, log, stderr, tmp, repo,
 *  storage } — `log` carries stdout only, `stderr` its own stream, so
 *  startup-warning tests can assert on the channel the warnings were specified
 *  for. Passing an earlier return value as `reuse` reuses its storage dir and
 *  repo WITHOUT re-initialising them — the restart test is the same board,
 *  stopped and started again. */
async function spawnServer(extraEnv, reuse) {
  const port = await new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { resolve(s.address().port); s.close() })
  })
  const tmp = reuse?.tmp ?? await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ak-auth-test-'))
  const repo = reuse?.repo ?? path.join(tmp, 'repo')
  const storage = reuse?.storage ?? path.join(tmp, 'storage')
  if (!reuse) {
    fs.mkdirSync(repo)
    spawnSync('git', ['init', '-q', repo])
    spawnSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    spawnSync('git', ['-C', repo, 'config', 'user.name', 'Gate Test'])
  }
  const server = spawn(process.execPath, [path.join(root, 'server', 'server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      AGENTS_KANBAN_REPO: repo,
      AGENTS_KANBAN_STORAGE: storage,
      AGENTS_KANBAN_PORT: String(port),
      // Pin the bind: an ambient AGENTS_KANBAN_HOST in the developer's shell
      // must not turn a loopback test into a network-bound one.
      AGENTS_KANBAN_HOST: '127.0.0.1',
      AGENTS_KANBAN_CODE: CODE,
      AGENTS_KANBAN_CONFIG: '{"focusMode":"off","discoverModels":false}',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  process.on('exit', () => { try { server.kill() } catch { /* already gone */ } })
  let log = ''
  let stderr = ''
  server.stdout.on('data', (d) => { log += d })
  server.stderr.on('data', (d) => { stderr += d })
  const base = `http://127.0.0.1:${port}`
  let up = false
  for (let i = 0; i < 200 && !up; i++) {
    try { up = (await fetch(`${base}/healthz`)).ok } catch { /* not listening yet */ }
    if (!up) await sleep(100)
  }
  if (!up) {
    server.kill()
    throw new Error('server did not come up:\n' + log + stderr)
  }
  return { base, kill: () => server.kill(), log: () => log, stderr: () => stderr, tmp, repo, storage }
}

// --- spawn A: rate limiting, the block, revoke --------------------------------
// Knobs lowered so the whole curve fits in the run: backoff after 2 failures,
// a hard block after 5, the block itself 3 seconds (0.05 minutes).
{
  const s = await spawnServer({
    AGENTS_KANBAN_AUTH_BACKOFF_AFTER: '2',
    AGENTS_KANBAN_AUTH_BLOCK_AFTER: '5',
    AGENTS_KANBAN_AUTH_BLOCK_MINUTES: '0.05',
  })
  // The startup banner prints the code on purpose — the operator has to read
  // it somewhere — so the log-coverage assertion later slices it off.
  const preLogLen = s.log().length
  const preErrLen = s.stderr().length
  const wrong = (code) => fetch(`${s.base}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
  })
  const exchange = async (code = CODE) => {
    const r = await wrong(code)
    if (r.status === 200) return (await r.json()).token
    return null
  }
  const ping = (token) => fetch(`${s.base}/api/ping`, { headers: { 'x-rc-token': token } })

  try {
    ok((await wrong('nope-1')).status === 401, 'wrong code 1 is a plain 401')
    ok((await wrong('nope-2')).status === 401, 'wrong code 2 is a plain 401')
    const r3 = await wrong('nope-3')
    ok(r3.status === 429 && Number(r3.headers.get('retry-after')) > 0, 'wrong code 3 is a 429 with Retry-After (backoff begins)')
    const r4 = await wrong('nope-4')
    ok(r4.status === 429 && Number(r4.headers.get('retry-after')) > Number(r3.headers.get('retry-after')), 'wrong code 4 backs off harder')
    ok((await wrong('nope-5')).status === 403, 'wrong code 5 engages the hard block (403)')
    ok((await wrong('nope-6')).status === 403, 'wrong code 6 stays blocked')
    ok((await wrong('nope-7')).status === 403, 'wrong code 7 stays blocked')
    ok((await wrong(CODE)).status === 403, 'even the RIGHT code is refused while the block is engaged')
    // The child's stdout reaches this pipe asynchronously — let it land before
    // asserting on what was logged.
    await sleep(300)
    ok((s.log().match(/auth block engaged/g) || []).length === 1, 'the block is logged exactly once, never per attempt')

    // The block lifts on its own; then a real code clears the slate.
    let token = null
    for (let i = 0; i < 60 && !token; i++) { await sleep(250); token = await exchange() }
    ok(!!token, 'a correct code works again once the block has run its course')
    ok((await ping(token)).status === 200, 'and the fresh token is accepted')

    // Revoke by code: every earlier token dies, later ones still work.
    ok((await fetch(`${s.base}/api/revoke`, { method: 'POST', headers: { 'x-rc-code': CODE } })).ok, 'revoke by code succeeds')
    ok((await ping(token)).status === 401, 'the token minted before the revoke is dead')
    const t2 = await exchange()
    ok(!!t2 && (await ping(t2)).status === 200, 'a token minted after the revoke still works')
    ok((await fetch(`${s.base}/api/revoke`, { method: 'POST', headers: { 'x-rc-token': t2 } })).ok, 'revoke by token succeeds — a leaker can kill the leak')
    ok((await ping(t2)).status === 401, 'the token that revoked is dead too')
    ok((await fetch(`${s.base}/api/revoke`, { method: 'POST' })).status === 401, 'revoke without a credential is refused')

    // The code route is the only one that takes the code — checked in detail
    // in headless.test.mjs; here the exchange route's shape is pinned.
    ok((await fetch(`${s.base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'nope' }) })).status === 401, 'a wrong code on the session route is 401 again after the block lifted')
    // Log coverage: NOTHING in the wrong-code, exchange or revoke flows may
    // name the pairing code — a log that leaks one is the leak the token
    // scheme exists to prevent. Only the startup banner prints it, and that
    // print was sliced off above with the lengths.
    await sleep(300)
    ok(!(s.log().slice(preLogLen) + s.stderr().slice(preErrLen)).includes(CODE), 'the pairing code never appears in the log during exchange, wrong-code or revoke flows')
  } catch (err) {
    console.error('FAIL: ' + (err?.message ?? err))
    failed++
  }
  s.kill()
  await fs.promises.rm(s.tmp, { recursive: true, force: true }).catch(() => {})
}

// --- spawn B: a token expires on its own --------------------------------------
{
  const s = await spawnServer({ AGENTS_KANBAN_TOKEN_TTL: '1' })
  await sleep(100)
  try {
    const r = await fetch(`${s.base}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: CODE }),
    })
    ok(r.status === 200, 'a code exchanges on the short-TTL server too')
    const token = (await r.json()).token
    ok((await fetch(`${s.base}/api/ping`, { headers: { 'x-rc-token': token } })).status === 200, 'the token works while it is fresh')
    await sleep(1600)
    ok((await fetch(`${s.base}/api/ping`, { headers: { 'x-rc-token': token } })).status === 401, 'the same token is refused once its TTL has passed')
    await sleep(300)
    ok(s.stderr().includes('expired token') || s.log().includes('expired token'), 'an expired token is named expired, not unknown')
    ok((await fetch(`${s.base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'nope' }) })).status === 401, 'wrong codes stay a plain 401 here (default limiter, first attempt)')
  } catch (err) {
    console.error('FAIL: ' + (err?.message ?? err))
    failed++
  }
  s.kill()
  await fs.promises.rm(s.tmp, { recursive: true, force: true }).catch(() => {})
}

// --- spawn C: a network-bound bind with a weak supplied code says so ----------
{
  const s = await spawnServer({ AGENTS_KANBAN_HOST: '0.0.0.0', AGENTS_KANBAN_CODE: 'shorty' })
  await sleep(200)
  ok(s.stderr().includes('reachable from the network'), 'binding beyond loopback warns that the board is reachable')
  ok(/characters/.test(s.stderr()) && /guessable/.test(s.stderr()), 'a supplied code under 10 characters is called guessable')
  s.kill()
  await fs.promises.rm(s.tmp, { recursive: true, force: true }).catch(() => {})
}

// --- spawn D: a generated code says it was generated ---------------------------
{
  const s = await spawnServer({ AGENTS_KANBAN_HOST: '0.0.0.0', AGENTS_KANBAN_CODE: '' })
  await sleep(200)
  ok(s.stderr().includes('reachable from the network'), 'binding beyond loopback warns even with no supplied code')
  ok(s.stderr().includes('GENERATED for this run'), 'a generated code says it was generated, on stderr')
  ok(/generated for this run/.test(s.log()), 'and the banner marks it generated rather than silently printing it')
  s.kill()
  await fs.promises.rm(s.tmp, { recursive: true, force: true }).catch(() => {})
}

// --- spawn E: revoke ends every OPEN event stream, not just future ones -------
{
  const s = await spawnServer({})
  try {
    const exchange = async (code = CODE) => {
      const r = await fetch(`${s.base}/api/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }),
      })
      return r.status === 200 ? (await r.json()).token : null
    }
    const post = (path, body, token) =>
      fetch(`${s.base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-rc-token': token },
        body: JSON.stringify(body ?? {}),
      })
    const token = await exchange()
    ok(!!token, 'a token mints for the stream-revoke test')
    ok((await post('/api/open', { surface: 'board' }, token)).ok, 'the surface opens')
    // Two streams on the SAME token, both open BEFORE the revoke — the second
    // exists so the "no frame after the revoke" check never races its own read.
    const opened = []
    for (let i = 0; i < 2; i++) {
      const sse = await fetch(`${s.base}/api/events?surface=board&token=${encodeURIComponent(token)}`)
      if (!sse.ok || !sse.body) { ok(false, 'event stream ' + i + ' opens'); s.kill(); process.exit(1) }
      opened.push(sse.body.getReader())
    }
    const [readerA, readerB] = opened
    // An SSE reader, event by event. Undici hands over whatever the socket
    // happened to coalesce — one TCP segment can carry the `retry:` preamble
    // AND a whole state frame — so a frame is counted on the EVENT boundary
    // (`\n\n`), never on the chunk boundary.
    const mkSse = (reader) => {
      let text = ''
      return {
        /** The next SSE event body ('' for an empty event), or null when
         *  nothing arrived within `timeoutMs`, or 'EOF' when the response
         *  ended. */
        async next(timeoutMs) {
          for (;;) {
            const gap = text.indexOf('\n\n')
            if (gap >= 0) {
              const event = text.slice(0, gap)
              text = text.slice(gap + 2)
              return event
            }
            const r = await Promise.race([
              reader.read().then((x) => x).catch(() => null),
              sleep(timeoutMs).then(() => 'timeout'),
            ])
            if (r === 'timeout' || r === null) return null
            if (r.done) return text ? text : 'EOF'
            text += new TextDecoder().decode(r.value)
          }
        },
      }
    }
    // A `ready` paints state frame(s) into BOTH; a repaint can broadcast a
    // second frame a beat later, so a stream's buffer is not empty just
    // because the first frame was read. Drain each to a QUIET window before
    // the revoke: the revoke assertions must observe a stream whose buffer is
    // empty, or a frame broadcast before the revoke would be handed over as
    // if the revoke had delivered it. Only `data:` counts as a board frame —
    // the controls (`retry:`, `: ping`) are not, and a heartbeat landing in
    // the window must not extend it or be counted.
    const isFrame = (event) => event.startsWith('data:')
    const drain = async (sse) => {
      let frames = 0
      for (let i = 0; i < 80; i++) {
        const ev = await sse.next(1500)
        if (ev === null || ev === 'EOF') return frames
        if (isFrame(ev)) frames++
      }
      return frames
    }
    await post('/api/msg?surface=board', { type: 'ready' }, token)
    const preA = await drain(mkSse(readerA))
    const preB = await drain(mkSse(readerB))
    ok(preA >= 1 && preB >= 1, 'both open streams deliver a board frame before the revoke')
    // The revoke goes through the CODE route, the way an operator would.
    ok((await fetch(`${s.base}/api/revoke`, { method: 'POST', headers: { 'x-rc-code': CODE } })).ok, 'revoke by code succeeds (stream test)')
    /** Read to the end of the response. Returns { done, frames }: `frames` is
     *  how many board frames were handed over while reaching the end — a
     *  drained stream reaches the end with zero, a stream receiving a post-
     *  revoke broadcast hands one over first. */
    const endedBy = async (sse) => {
      const deadline = Date.now() + 4000
      let frames = 0
      for (;;) {
        const remain = deadline - Date.now()
        if (remain <= 0) return { done: false, frames }
        const ev = await sse.next(remain)
        if (ev === null) return { done: false, frames }
        if (ev === 'EOF') return { done: true, frames }
        if (isFrame(ev)) frames++
      }
    }
    // 1. The open stream is ENDED — not left attached to a token the revoke
    //    just killed, silently reading board state for as long as it lives.
    const endA = await endedBy(mkSse(readerA))
    ok(endA.done && endA.frames === 0, 'revoke ends every OPEN event stream — a revoked client stops receiving')
    // 2. Nothing after the revoke reaches it either: the browser that revoked
    //    re-exchanges (a fresh token) and its `ready` broadcasts — the revoked
    //    stream must see none of it.
    const t2 = await exchange()
    ok(!!t2 && (await fetch(`${s.base}/api/ping`, { headers: { 'x-rc-token': t2 } })).status === 200, 'a fresh token works after the revoke (stream test)')
    await post('/api/msg?surface=board', { type: 'ready' }, t2)
    const endB = await endedBy(mkSse(readerB))
    ok(endB.done && endB.frames === 0, 'no board frame is delivered to a revoked stream')
  } catch (err) {
    console.error('FAIL: ' + (err?.message ?? err))
    failed++
  }
  s.kill()
  await fs.promises.rm(s.tmp, { recursive: true, force: true }).catch(() => {})
}

// --- spawn F: a restart resets the epoch ---------------------------------------
// That tokens die on restart is LOAD-BEARING, not an inconvenience: the token
// is the credential that rides in a URL, so it must die on a clock, a revoke
// OR a restart — and the epoch is deliberately in-memory. This guards against
// someone later persisting the tokens or the epoch into AGENTS_KANBAN_STORAGE:
// a token that survives a restart is a credential a log or browser history
// leaked on day one and that never, ever dies.
{
  const s1 = await spawnServer({})
  let tmp = s1.tmp
  try {
    const r1 = await fetch(`${s1.base}/api/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: CODE }),
    })
    ok(r1.status === 200, 'a code exchanges on the first run (restart test)')
    const token1 = (await r1.json()).token
    ok((await fetch(`${s1.base}/api/ping`, { headers: { 'x-rc-token': token1 } })).status === 200, 'and the minted token works')
    s1.kill()
    // The board is dead; a short wait lets the socket close AND the storage
    // writes settle, so the restart is not racing the previous process.
    await sleep(500)
    const s2 = await spawnServer({}, s1)
    try {
      ok((await fetch(`${s2.base}/api/ping`, { headers: { 'x-rc-token': token1 } })).status === 401, 'a token minted before the restart is dead after it')
      const r2 = await fetch(`${s2.base}/api/session`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: CODE }),
      })
      ok(r2.status === 200, 'a fresh exchange works after the restart')
      ok((await fetch(`${s2.base}/api/ping`, { headers: { 'x-rc-token': (await r2.json()).token } })).status === 200, 'and the fresh token is accepted')
    } finally {
      s2.kill()
    }
  } finally {
    s1.kill()
  }
  await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {})
}

if (failed) process.exit(1)
console.log('headless auth: all green')
