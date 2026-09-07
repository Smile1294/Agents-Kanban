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
 *    existing token — and a token minted after still works
 *  - startup says what is exposed: a non-loopback bind warns on stderr; a
 *    supplied code under 10 characters is called guessable; a generated code
 *    says it was generated. Loopback stays silent (headless.test.mjs checks).
 *
 * Every guard above was demonstrated RED when reverted, 2026-09-07 (S106bw):
 * accepting the code on other routes broke headless.test.mjs's two code-refusal
 * gates; bypassing the limiter broke seven backoff/block assertions; dropping
 * the expiry check and the revoke epoch bump each broke their two; disabling
 * the startup warnings broke all four warning assertions.
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

/** Spawn one headless server. Returns { base, kill, log, stderr } — `log`
 *  carries stdout only, `stderr` its own stream, so startup-warning tests can
 *  assert on the channel the warnings were specified for. */
async function spawnServer(extraEnv) {
  const port = await new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => { resolve(s.address().port); s.close() })
  })
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ak-auth-test-'))
  const repo = path.join(tmp, 'repo')
  const storage = path.join(tmp, 'storage')
  fs.mkdirSync(repo)
  spawnSync('git', ['init', '-q', repo])
  spawnSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
  spawnSync('git', ['-C', repo, 'config', 'user.name', 'Gate Test'])
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
  return { base, kill: () => server.kill(), log: () => log, stderr: () => stderr, tmp }
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

if (failed) process.exit(1)
console.log('headless auth: all green')
