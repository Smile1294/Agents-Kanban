/** The headless board, end to end.
 *
 * Spawns server/server.mjs against a throwaway git repo on an ephemeral port
 * with a known pairing code, then drives it the way a browser would:
 *
 *  - without the code nothing but the gate page is served, and every message
 *    that could move board state is 401
 *  - with it, /api/open creates the surface and `ready` paints a state frame
 *    over the event stream
 *  - a real Chromium opens the page, passes the gate, sees the real board
 *    render, clicks the settings gear and gets the settings tab — with zero
 *    console errors anywhere
 *  - and the token-lifecycle part, in the same Chromium: a revoke is recovered
 *    ONCE, silently, by re-exchanging the stored code; a SECOND revoke is a
 *    dead end — the gate returns with an explanation and the EventSource stops
 *    retrying a dead token
 *
 * The chromium part follows test/layout.test.mjs: whatever build the
 * machine's playwright cache holds — any newer Chromium beats a fresh 170MB
 * download, and no browser at all is a FAIL, not a skip.
 */
import { chromium } from 'playwright'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CODE = 'gate-test-code'

let failed = 0
const ok = (cond, label) => { console.log((cond ? 'ok: ' : 'FAIL: ') + label); if (!cond) failed++ }

// --- a free port, a throwaway repo, a throwaway store -------------------------
const port = await new Promise((resolve) => {
  const s = createServer()
  s.listen(0, '127.0.0.1', () => { resolve(s.address().port); s.close() })
})
const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ak-headless-test-'))
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
    AGENTS_KANBAN_CODE: CODE,
    AGENTS_KANBAN_CONFIG: '{"focusMode":"off","discoverModels":false}',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
// On EVERY way out, including the process.exit(1) paths above and below: a
// server that outlives a failed test is an extension host, activated against
// this repository, that nobody knows is running.
process.on('exit', () => { try { server.kill() } catch { /* already gone */ } })
let serverLog = ''
server.stdout.on('data', (d) => { serverLog += d })
server.stderr.on('data', (d) => { serverLog += d })
const base = `http://127.0.0.1:${port}`

let up = false
for (let i = 0; i < 200 && !up; i++) {
  try { up = (await fetch(`${base}/healthz`)).ok } catch { /* not listening yet */ }
  if (!up) await new Promise((r) => setTimeout(r, 100))
}
if (!up) {
  console.error('FAIL: server did not come up\n' + serverLog)
  process.exit(1)
}
console.log('ok: server came up')
// The default bind says nothing scary at startup: loopback plus a strong
// supplied code — the exposure warnings are for the network-bound cases only.
await new Promise((r) => setTimeout(r, 100))
ok(!/reachable from the network|GENERATED for this run|pairing code you supplied/.test(serverLog), 'a loopback run prints no exposure warnings')

try {
  // --- auth: the code gates everything that could move board state -----------
  ok((await fetch(`${base}/api/msg`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status === 401, 'a message without a token is 401')
  ok((await fetch(`${base}/api/msg`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-rc-code': CODE } })).status === 401, 'the CODE itself is not accepted on the message route')
  ok((await fetch(`${base}/api/events`)).status === 401, 'the event stream without a token is 401')
  ok((await fetch(`${base}/api/events?surface=board&code=${CODE}`)).status === 401, 'the code in the stream URL is not accepted')
  ok((await fetch(`${base}/`)).ok, 'the page itself is public')

  // The code is exchanged once for a token, exactly the way the gate page does
  // it; everything after this rides the token.
  const session = await fetch(`${base}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: CODE }),
  })
  ok(session.status === 200, 'the code exchanges for a token')
  const token = (await session.json()).token
  ok(typeof token === 'string' && token.length > 20, 'the token is a long random string')
  const auth = { 'content-type': 'application/json', 'x-rc-token': token }

  // --- the HTTP round trip: open, ready, state over the event stream ---------
  ok((await fetch(`${base}/api/open`, { method: 'POST', headers: auth })).ok, 'open creates the surface')

  const sse = await fetch(`${base}/api/events?surface=board&token=${encodeURIComponent(token)}`)
  if (!sse.ok || !sse.body) { ok(false, 'the event stream opens'); process.exit(1) }
  console.log('ok: the event stream opens')
  const reader = sse.body.getReader()
  const nextFrame = async (timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    let buf = ''
    while (Date.now() < deadline) {
      const { value, done } = await reader.read()
      if (done) throw new Error('stream closed')
      buf += Buffer.from(value).toString('utf8')
      const m = buf.match(/^data: (\{.*\})\n\n/m)
      if (m) return JSON.parse(m[1])
    }
    throw new Error('no frame within ' + timeoutMs + 'ms')
  }

  await fetch(`${base}/api/msg?surface=board`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ type: 'ready' }),
  })
  const frame = await nextFrame()
  ok(frame.type === 'state', 'ready paints a state frame')
  ok(frame.state?.columns?.length === 5, 'the state carries the five columns')
  ok(Array.isArray(frame.state?.cards), 'the state carries the card list')

  // --- the same flow through a real browser -----------------------------------
  // A cached build when there is one, else whatever playwright itself resolves —
  // the same fallback layout.test.mjs has. Without it this gate could not run
  // on a Mac at all: the hunt below knew only the Linux cache path, so it
  // reported "no Chromium" on a machine with one, and did so AFTER spawning the
  // server, which it then never killed (three orphaned servers were found).
  const exe = await findChromium()
  let browser
  try {
    browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--no-sandbox'] })
  } catch (e) {
    console.log('FAIL: no Chromium to drive the page with — run `npx playwright install chromium`')
    console.log(`       (${String(e).split('\n')[0]})`)
    process.exit(1)
  }
  const errors = []
  const listen = (p) => {
    p.on('pageerror', (e) => errors.push(String(e)))
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  }
  const page = await browser.newPage()
  listen(page)
  // Every token a /api/events request on THIS page used, from the first gate
  // exchange on: each recovery opens a NEW EventSource with a new token in the
  // URL, while a retry loop keeps reusing the dead one — that difference is
  // what makes the token set the observable.
  const eventsTokens = []
  page.on('request', (r) => {
    if (r.url().includes('/api/events')) {
      const t = new URL(r.url()).searchParams.get('token')
      if (t) eventsTokens.push(t)
    }
  })
  const distinctTokens = () => new Set(eventsTokens).size

  await page.goto(base + '/')
  await page.waitForSelector('#ak-gate')
  console.log('ok: the gate shows before the code is entered')
  await page.fill('#ak-gate input', CODE)
  await page.click('#ak-gate button:not(.ak-link)')
  await page.waitForSelector('#ak-gate', { state: 'detached' })
  // The page's CSP forbids eval, which is what waitForFunction needs — so
  // wait on Playwright's own text selector instead.
  await page.waitForSelector('text=AGENT SESSIONS', { timeout: 15000 })
  console.log('ok: the real board renders after the code')

  // The gear lives on the composer bar, which is the chat screen's — and a
  // kanban with no sessions does not draw one. "+ New session" is the same
  // button the user would press: it selects nothing and switches to chat.
  await page.click('text="+ New session"')
  await page.waitForSelector('.gear-btn', { timeout: 10000 })
  console.log('ok: the composer bar renders with its settings gear')

  // The gear opens the settings tab: a full round trip — click, host command,
  // panel creation, the settings-opened notice, the toast, the popup — and the
  // popup shares the opener's sessionStorage, so it passes the gate by itself.
  await page.click('.gear-btn')
  await page.waitForSelector('.ak-toast button', { timeout: 10000 })
  console.log('ok: the gear click produced the settings toast')
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('.ak-toast button'),
  ])
  listen(popup)
  await popup.waitForSelector('text=Backends', { timeout: 15000 })
  console.log('ok: the settings tab renders in the popup')

  // --- a token death is recovered once; a SECOND one is a dead end ------------
  // A revoke ends the page's stream. The bridge's one recovery — re-exchange
  // the stored code — is allowed ONCE per page life, so the first death is
  // silent and the board comes straight back. A second death is where the old
  // bridge strand was: an EventSource left to its own devices retries a dead
  // token every `retry:` (2s) forever, behind a board that never changes — a
  // stranding tab. The gate must come back, with an explanation, and the
  // retries must stop.
  const revoke = () => fetch(`${base}/api/revoke`, { method: 'POST', headers: { 'x-rc-code': CODE } })

  await revoke()
  // First death: the stream ends, the page pings, re-exchanges and re-opens
  // ONCE. A second events token is the proof that the page recovered — the
  // gate stays gone.
  for (let i = 0; i < 60 && distinctTokens() < 2; i++) await page.waitForTimeout(200)
  ok(distinctTokens() >= 2, 'a first revoke is recovered silently — the page re-exchanges and re-opens the stream')
  ok((await page.locator('#ak-gate').count()) === 0, 'and the gate does not come back on the first death')

  await revoke()
  // Second death: nothing left to spend. The gate returns with the dead-end
  // note, and the EventSource does NOT keep retrying — no new stream requests.
  for (let i = 0; i < 60 && (await page.locator('#ak-gate').count()) === 0; i++) await page.waitForTimeout(200)
  await page.waitForSelector('#ak-gate', { timeout: 5000 })
  ok((await page.locator('#ak-gate p').innerText()).includes('no longer valid'), 'a second death draws the gate with the honest note')
  // Let any in-flight reconnect (the retry timer is 2s) land first, then watch:
  // a dead-ended page must not make another stream request.
  await page.waitForTimeout(3000)
  const requestsAtDeadEnd = eventsTokens.length
  ok((await page.locator('#ak-gate').count()) > 0, 'the gate stays up, a message instead of an empty board')
  await page.waitForTimeout(5000)
  ok(eventsTokens.length === requestsAtDeadEnd, 'a dead-ended page stops retrying the dead token (no retry loop)')

  // Re-entering the code starts over: the gate closes and a new exchange
  // opens a fresh stream on a new token.
  await page.fill('#ak-gate input', CODE)
  await page.click('#ak-gate button:not(.ak-link)')
  await page.waitForSelector('#ak-gate', { state: 'detached' })
  const tokensAfterReentry = distinctTokens()
  for (let i = 0; i < 60 && distinctTokens() === tokensAfterReentry; i++) await page.waitForTimeout(200)
  ok(distinctTokens() > tokensAfterReentry, 're-entering the code exchanges again and reconnects the board')
  await page.waitForSelector('text=AGENT SESSIONS', { timeout: 15000 })
  console.log('ok: the dead-ended page recovers from the gate with the code')

  await page.waitForTimeout(300)
  // The lifecycle section above issues dead-token /api/ping requests ON
  // PURPOSE — that 401 is the signal the bridge reads to tell a dead token
  // from a network blip. Chromium logs every non-ok resource load as
  // "Failed to load resource", so those entries are filtered here, not counted
  // as errors, and everything else still fails the gate.
  if (errors.length) console.error('server log:\n' + serverLog)
  const realErrors = errors.filter((e) => !e.includes('status of 401'))
  ok(realErrors.length === 0, 'no console errors anywhere (expected dead-token 401 resource logs are not counted)' + (realErrors.length ? ':\n  ' + realErrors.join('\n  ') : ''))

  await browser.close()
} catch (err) {
  console.error('FAIL: ' + (err?.message ?? err))
  failed++
}

server.kill()
await new Promise((r) => setTimeout(r, 500))
await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {})
if (failed) process.exit(1)
console.log('headless board: all green')

// --- the layout.test.mjs chromium hunt: newest cached build wins --------------
async function findChromium() {
  const roots = [
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? [process.env.PLAYWRIGHT_BROWSERS_PATH] : []),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
  ]
  const candidates = []
  for (const cache of roots) {
    const dirs = await fs.promises.readdir(cache).catch(() => [])
    const builds = dirs
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      .sort((a, b) => Number(b.match(/\d+$/)[0]) - Number(a.match(/\d+$/)[0]))
    for (const d of builds) {
      for (const rel of [['chrome-linux', 'headless_shell'], ['chrome-linux', 'chrome'], ['chrome-linux64', 'chrome'],
                         ['chrome-mac', 'headless_shell'], ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
                         ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]) {
        candidates.push(path.join(cache, d, ...rel))
      }
    }
  }
  for (const p of candidates) {
    if (await fs.promises.access(p).then(() => true, () => false)) return p
  }
  return null
}
