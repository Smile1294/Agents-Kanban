#!/usr/bin/env node
/** Agents Kanban, headless: the whole board on a box, driven from a browser.
 *
 * Run it on a rented VPS, a Mac mini or a mini PC:
 *
 *   git clone <repo> && cd <repo>
 *   npm install
 *   npm run remote
 *
 * It builds the extension, activates it against a small `vscode` stub (no
 * editor anywhere), and serves the REAL board UI (`media/board.js`, the same
 * file the extension renders) to any browser that knows the pairing code.
 * Every webview message the extension understands — send, start a chat, move a
 * card, approve a permission, review, commit, merge — works from that browser,
 * because the host half is the built extension itself, not a reimplementation.
 *
 * The pairing code gates everything except this page. Set it with
 * `AGENTS_KANBAN_CODE` or `--code`; when neither is given, one is generated
 * and printed. It is the ONLY long-lived secret, and it is never put in a URL
 * and never logged: the gate page exchanges it ONCE for a short-lived token
 * (POST /api/session), keeps the code in sessionStorage only to re-exchange
 * when a token expires or a revoke kills it, and sends the token from then on
 * — as `x-rc-token` on every request except the event stream, which takes
 * `?token=` in the query because EventSource cannot set headers. A token in a
 * URL is the reason tokens die: 5 minutes by default, sooner on
 * `POST /api/revoke` or a restart.
 *
 *   AGENTS_KANBAN_PORT=4310   port (default 4310)
 *   AGENTS_KANBAN_HOST=0.0.0.0  bind beyond localhost (know what that means
 *                              before you do it — the board starts agents that
 *                              spend money; a VPN or SSH tunnel is the safer
 *                              way to reach a box remotely, and the startup
 *                              warnings say so)
 *   AGENTS_KANBAN_REPO=/path  the repository the board works on (default: cwd)
 *   AGENTS_KANBAN_STORAGE=~   where the sidecar and extension state live
 *                             (default ~/.agents-kanban — never in the repo)
 *   AGENTS_KANBAN_CONFIG={}   JSON merged into `agentsKanban` settings
 *   AGENTS_KANBAN_TOKEN_TTL=300          seconds a session token lives (5m)
 *   AGENTS_KANBAN_AUTH_BACKOFF_AFTER=5   wrong codes before 429 backoff starts
 *   AGENTS_KANBAN_AUTH_BLOCK_AFTER=20    wrong codes before the hard block
 *   AGENTS_KANBAN_AUTH_BLOCK_MINUTES=15  how long the hard block lasts
 *   AGENTS_KANBAN_TRUST_PROXY=1          honour X-Forwarded-For — ONLY when
 *                                        the port is firewalled behind a proxy
 *                                        that overwrites it (see README)
 *
 * Everything the box needs that the extension also needs: Node 22.6+, git,
 * and the agent CLI the runtime uses (Claude Code, or Codex, signed in).
 */
import * as http from 'node:http'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { promises as fsp } from 'node:fs'
import { createRequire } from 'node:module'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { makeVscodeStub } from './stub.mjs'
import { pageHtml } from './page.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist', 'extension.js')

// --- configuration -----------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => a.split('=', 2)).filter((a) => a[0].startsWith('--')).map(([k, v]) => [k.slice(2), v ?? '']),
)
const port = confNum('AGENTS_KANBAN_PORT', 'port', 4310)
const host = process.env.AGENTS_KANBAN_HOST ?? args.host ?? '127.0.0.1'
const repo = path.resolve(process.env.AGENTS_KANBAN_REPO ?? args.repo ?? process.cwd())
const storageDir = path.resolve(process.env.AGENTS_KANBAN_STORAGE ?? args.storage ?? path.join(os.homedir(), '.agents-kanban'))
// An empty value counts as unset: `AGENTS_KANBAN_CODE=` must generate, not
// lock the board behind a code nobody knows.
const codeEnv = process.env.AGENTS_KANBAN_CODE || args.code
const codeSupplied = Boolean(codeEnv)
const code = codeEnv || randomBytes(12).toString('base64url')
const codeDigest = createHash('sha256').update(code).digest()
const tokenTtlS = confNum('AGENTS_KANBAN_TOKEN_TTL', 'token-ttl', 5 * 60)
const authBackoffAfter = confNum('AGENTS_KANBAN_AUTH_BACKOFF_AFTER', 'auth-backoff-after', 5)
const authBlockAfter = confNum('AGENTS_KANBAN_AUTH_BLOCK_AFTER', 'auth-block-after', 20)
const authBlockMinutes = confNum('AGENTS_KANBAN_AUTH_BLOCK_MINUTES', 'auth-block-minutes', 15)
const trustProxy = confFlag('AGENTS_KANBAN_TRUST_PROXY', 'trust-proxy')
const configSeed = (() => {
  const base = { focusMode: 'off' }
  const raw = process.env.AGENTS_KANBAN_CONFIG ?? args.config ?? ''
  if (!raw) return base
  try { return { ...base, ...JSON.parse(raw) } } catch {
    console.error('AGENTS_KANBAN_CONFIG is not valid JSON — ignoring it')
    return base
  }
})()

/** Env var or --arg, positive number, else the default. */
function confNum(envKey, argKey, dflt) {
  const raw = process.env[envKey] ?? args[argKey]
  const n = raw === undefined || raw === '' ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : dflt
}
function confFlag(envKey, argKey) {
  const raw = String(process.env[envKey] ?? args[argKey] ?? '').toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

if (!fs.existsSync(dist)) {
  console.error('dist/extension.js is missing — run: npm run build')
  process.exit(1)
}

// --- auth: the pairing code buys a short-lived token -------------------------
// Two credentials. The PAIRING CODE is the long-lived secret an operator types
// once; it is accepted on exactly two routes — POST /api/session (in the JSON
// body) and POST /api/revoke (x-rc-code header) — never in a URL and never on
// any other route, so it cannot land in a request log or a proxy's access log.
// It exchanges for a TOKEN: 32 random bytes, held here as its sha-256, live
// for tokenTtlS seconds (5 minutes by default), carried as `x-rc-token` on
// every request except the event stream, which takes `?token=` in the query
// because EventSource cannot set headers. A credential that rides in a URL
// must be the one that dies — that is what expiry and revocation are for.
const tokens = new Map() // sha-256(token) hex -> { expiry, epoch }
let authEpoch = 0 // bumped by POST /api/revoke; not persisted, so a restart revokes too
const tokenSweep = setInterval(() => {
  // Tokens die when they expire even if nobody checks them again.
  const now = Date.now()
  for (const [digest, e] of tokens) if (now > e.expiry) tokens.delete(digest)
}, 10 * 60 * 1000)
tokenSweep.unref()

function mintToken() {
  const raw = randomBytes(32).toString('base64url')
  tokens.set(sha256Hex(raw), { expiry: Date.now() + tokenTtlS * 1000, epoch: authEpoch })
  return raw
}

/** 'ok', 'stale' (expired, or minted before the last revoke) or 'unknown'. */
function tokenStatus(raw) {
  if (typeof raw !== 'string' || !raw) return 'absent'
  const e = tokens.get(sha256Hex(raw))
  if (!e) return 'unknown'
  if (e.epoch !== authEpoch || Date.now() > e.expiry) return 'stale'
  return 'ok'
}

// --- auth failure limiting ----------------------------------------------------
// Wrong-CODE attempts are counted per client IP: exponential backoff (429 +
// Retry-After) after authBackoffAfter failures, a hard block (403 for
// authBlockMinutes) after authBlockAfter. Only the CODE is limited: it is the
// low-entropy, human-typed secret and the one thing a scanner can guess.
// Tokens are 32 random bytes — nobody guesses one — and a failing token is
// usually our OWN, expired by the clock or by a restart (the epoch is not
// persisted), which every browser re-exchanges. Counting those would lock a
// real user out of their own board after every restart, so token failures are
// never counted. The table is in memory on purpose: a restart forgets every
// block, and that is honest — the block was protecting the code, and the code
// did not change. X-Forwarded-For is honoured ONLY behind
// AGENTS_KANBAN_TRUST_PROXY: an attacker who can reach the port directly
// forges the header and the limit dies (worse — it implicates other IPs). A
// reverse proxy that overwrites XFF, as the TLS setup in server/README.md
// does, is what makes it trustworthy.
const authFailures = new Map() // ip -> { count, windowStart, blockedUntil }
const AUTH_WINDOW_MS = 10 * 60 * 1000 // how long a failure count lives

function sha256Hex(s) {
  return createHash('sha256').update(String(s)).digest('hex')
}
function codeOk(given) {
  const digest = createHash('sha256').update(String(given)).digest()
  return timingSafeEqual(digest, codeDigest)
}
function ipOf(req) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for']
    if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim()
  }
  return req.socket.remoteAddress ?? 'unknown'
}
function pruneAuthFailures() {
  if (authFailures.size < 1024) return
  const now = Date.now()
  for (const [ip, e] of authFailures) {
    if (now - e.windowStart > AUTH_WINDOW_MS && e.blockedUntil <= now) authFailures.delete(ip)
  }
}
/** Record a wrong-code attempt. Returns { status, wait, fresh } — wait seconds
 *  is the Retry-After; `fresh` is true only on the attempt that ENGAGES the
 *  block, the one log line the block is allowed. */
function recordAuthFail(ip) {
  const now = Date.now()
  let e = authFailures.get(ip)
  if (!e) { e = { count: 0, windowStart: now, blockedUntil: 0 }; authFailures.set(ip, e) }
  if (now - e.windowStart > AUTH_WINDOW_MS || (e.count >= authBlockAfter && e.blockedUntil <= now)) {
    // A stale count — or a block that has run its course — clears the slate,
    // or the first attempt after a block would re-engage it forever.
    e.count = 0; e.windowStart = now; e.blockedUntil = 0
  }
  if (e.blockedUntil > now) return { status: 403, wait: Math.ceil((e.blockedUntil - now) / 1000), fresh: false }
  e.count++
  if (e.count >= authBlockAfter) {
    e.blockedUntil = now + authBlockMinutes * 60_000
    return { status: 403, wait: authBlockMinutes * 60, fresh: true }
  }
  if (e.count > authBackoffAfter) {
    return { status: 429, wait: Math.min(2 ** (e.count - authBackoffAfter), authBlockMinutes * 60), fresh: false }
  }
  return { status: 401, wait: 0, fresh: false }
}

// --- the vscode stub, and the extension inside it ----------------------------
const ctl = {
  repo,
  config: configSeed,
  log: (line) => console.log(line.trimEnd()),
  clients: new Map(), // surface -> Map<ServerResponse, interval> — the interval
  // is stored so a revoke that ENDS the streams can clear it too
  broadcast(surface, msg) {
    for (const res of ctl.clients.get(surface)?.keys() ?? []) {
      try { res.write(`data: ${JSON.stringify(msg)}\n\n`) } catch { /* gone; pruned on close */ }
    }
  },
  dialogs: new Map(), // id -> { resolve }
  nextDialogId: 1,
  /** A dialog (modal warning, input box, quick pick) → an overlay in every
   *  browser; the first answer resolves the waiting extension call. */
  dialog(spec) {
    const id = String(ctl.nextDialogId++)
    return new Promise((resolve) => {
      ctl.dialogs.set(id, { resolve })
      ctl.broadcast('agentsKanban.panel', { type: 'remote', kind: 'dialog', id, spec })
      ctl.broadcast('agentsKanban.settings', { type: 'remote', kind: 'dialog', id, spec })
    })
  },
  toast(spec) {
    ctl.broadcast('agentsKanban.panel', { type: 'remote', kind: 'toast', spec })
    ctl.broadcast('agentsKanban.settings', { type: 'remote', kind: 'toast', spec })
  },
  openExternal(url) {
    ctl.toast({ level: 'info', text: `The board asked to open ${url}`, url })
  },
}

const vscode = makeVscodeStub(ctl)
const extension = loadBundle(vscode)

// --- context: storage lives in the user's home on the box, never in the repo -
await fsp.mkdir(storageDir, { recursive: true })
const context = makeContext(storageDir, ctl)

// --- activate ----------------------------------------------------------------
const startedAt = Date.now()
await extension.activate(context)
console.log(`[server] extension activated in ${Date.now() - startedAt}ms, repo ${repo}`)

// --- http --------------------------------------------------------------------
const server = http.createServer(handle)
server.listen(port, host, () => {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  // What is exposed, on stderr where the warnings cannot be missed: a board
  // anyone can reach with the code is a box that runs agents that spend
  // money. All of it is silent on the default loopback bind.
  if (!loopback) {
    console.error('')
    console.error(`  WARNING: AGENTS_KANBAN_HOST is ${host} — the board is reachable from the network.`)
    console.error('  Whoever holds the pairing code can run agents that spend money on this box.')
    console.error('  The safer ways to reach it are an SSH tunnel or a VPN. If this is deliberate,')
    console.error('  put TLS in front of it and firewall the port — see server/README.md.')
    if (codeSupplied && code.length < 10) {
      console.error('')
      console.error(`  WARNING: the pairing code you supplied is ${code.length} characters. A code that short`)
      console.error('  is guessable against a reachable board — set AGENTS_KANBAN_CODE to a long secret.')
    } else if (!codeSupplied) {
      console.error('')
      console.error('  The pairing code was GENERATED for this run — printed below, and different after')
      console.error('  the next restart. Set AGENTS_KANBAN_CODE to a long secret of your own.')
    }
    console.error('')
  }
  console.log('')
  console.log('  Agents Kanban — headless board')
  console.log('')
  console.log(`  Watching : ${repo}`)
  console.log(`  Open      : http://${host}:${port}/`)
  console.log(`  Code      : ${code}${codeSupplied ? '' : '  (generated for this run)'}`)
  console.log('')
  console.log('  From any device that can reach this address, open the URL and enter')
  console.log('  the code. The board is the same one the extension shows.')
  console.log('')
})

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://x')
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return ok(res, 200, 'ok')
    }

    // Pages and assets are public: they carry nothing until a surface is
    // opened, and the gate itself has to render to ask for the code.
    if (req.method === 'GET' && url.pathname === '/settings') return page(res, 'settings')
    if (req.method === 'GET' && url.pathname === '/') return page(res, 'board')
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) return file(res, path.join(root, 'media', path.basename(url.pathname)))
    if (req.method === 'GET' && url.pathname === '/bridge.js') return file(res, path.join(root, 'server', 'bridge.js'), 'text/javascript')
    if (req.method === 'GET' && url.pathname === '/bridge.css') return file(res, path.join(root, 'server', 'bridge.css'), 'text/css; charset=utf-8')
    // Browsers ask for this unconditionally; without it the request falls into
    // the authed section below and every tab logs a 401.
    if (req.method === 'GET' && url.pathname === '/favicon.ico') {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' })
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#0078d4"/><rect x="3" y="3" width="4" height="4" fill="#1f1f1f"/><rect x="9" y="3" width="4" height="4" fill="#1f1f1f"/><rect x="3" y="9" width="10" height="4" fill="#1f1f1f"/></svg>')
      return
    }

    // The pairing code is accepted on exactly two routes: the exchange that
    // turns it into a short-lived token, and the revoke that kills every
    // token. Everything below the code routes takes a TOKEN and never the
    // code — so a URL or a log that leaks one leaks a credential that dies,
    // never the secret that would mint another.
    if (req.method === 'POST' && url.pathname === '/api/session') return await codeExchange(req, res, url)
    if (req.method === 'POST' && url.pathname === '/api/revoke') return revoke(req, res, url)

    // The stream is the ONE route that may read the token from the query —
    // EventSource cannot set headers. Everywhere else the header only.
    const given = req.headers['x-rc-token'] ?? (url.pathname === '/api/events' ? url.searchParams.get('token') : '') ?? ''
    const verdict = tokenStatus(String(given))
    if (verdict !== 'ok') return tokenAuthFail(req, res, url, verdict)
    const surface = url.searchParams.get('surface') === 'settings' ? 'agentsKanban.settings' : 'agentsKanban.panel'

    if (req.method === 'GET' && url.pathname === '/api/events') return sse(req, res, surface)
    if (req.method === 'POST' && url.pathname === '/api/msg') return await inbound(req, res, surface)
    if (req.method === 'POST' && url.pathname === '/api/dialog') return answerDialog(req, res)
    if (req.method === 'GET' && url.pathname === '/api/ping') return ok(res, 200, 'ok')
    /** The first page load opens its surface: the board panel (and the
     *  settings tab) exist only once the extension creates them, which the
     *  editor used to do when the user clicked. A browser is the click. */
    if (req.method === 'POST' && url.pathname === '/api/open') {
      const which = surface === 'agentsKanban.settings' ? 'agentsKanban.openSettings' : 'agentsKanban.openBoard'
      try { await vscode.commands.executeCommand(which) } catch (err) { console.error('[server] open failed:', err) }
      return ok(res, 200, 'opened')
    }
    return ok(res, 404, 'not found')
  } catch (err) {
    console.error('[server]', err)
    try { ok(res, 500, 'error') } catch { /* socket gone */ }
  }
}

// --- the pairing-code routes --------------------------------------------------
async function codeExchange(req, res, url) {
  const ip = ipOf(req)
  const body = await readJson(req)
  const given = String(body?.code ?? '')
  if (!given || !codeOk(given)) return codeAuthFail(req, res, url, given ? 'wrong code' : 'no code')
  const e = authFailures.get(ip)
  if (e && e.blockedUntil > Date.now()) {
    // A hard block refuses even the RIGHT code: the block exists because the
    // code may have reached whoever earned it. Not a new failure, so no count
    // and no log line — the block already had its one.
    const wait = Math.ceil((e.blockedUntil - Date.now()) / 1000)
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(wait) })
    res.end(`blocked for too many failed attempts — retry in about ${wait}s`)
    return
  }
  authFailures.delete(ip) // a real code clears the slate
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(JSON.stringify({ token: mintToken() }))
}

function revoke(req, res, url) {
  const ip = ipOf(req)
  const givenCode = req.headers['x-rc-code']
  const givenToken = req.headers['x-rc-token']
  if (typeof givenCode === 'string' && codeOk(givenCode)) return doRevoke(res, ip)
  // A token holder can revoke too: whoever stole a token has full access until
  // it dies, so the person who lost it is the one who needs revoke the most.
  if (typeof givenToken === 'string' && tokenStatus(givenToken) === 'ok') return doRevoke(res, ip)
  return codeAuthFail(req, res, url, givenCode ? 'wrong code' : 'no code')
}

function doRevoke(res, ip) {
  authEpoch++ // every token minted before this instant is dead
  revokeStreams() // ...and no stream opened on one of them keeps reading
  authFailures.delete(ip)
  ok(res, 200, 'revoked')
}

/** A wrong or missing pairing code, run through the per-IP limiter. */
function codeAuthFail(req, res, url, reason) {
  pruneAuthFailures()
  const ip = ipOf(req)
  const v = recordAuthFail(ip)
  // The block is logged ONCE — the attempt that engages it — never per attempt;
  // a blocked attempt is silent, or a single IP could fill the log regardless
  // of what the limiter was for.
  if (v.fresh) {
    console.log(`[server] ${v.status} ${req.method} ${url.pathname} — ${reason}, ip ${ip}; auth block engaged for ${authBlockMinutes}m`)
  } else if (v.status !== 403) {
    console.log(`[server] ${v.status} ${req.method} ${url.pathname} — ${reason}, ip ${ip}`)
  }
  const body = v.status === 429
    ? `too many failed attempts — retry in about ${v.wait}s`
    : v.status === 403
      ? `blocked for too many failed attempts — retry in about ${v.wait}s`
      : 'wrong or missing pairing code'
  res.writeHead(v.status, {
    'content-type': 'text/plain; charset=utf-8',
    ...(v.wait ? { 'retry-after': String(v.wait) } : {}),
  })
  res.end(body)
}

/** A missing or invalid session token on a token-gated route. Not run through
 *  the limiter (see the auth-failure comment above): the PATHNAME is all that
 *  is ever logged — never the query, which is where a token would be. */
function tokenAuthFail(req, res, url, verdict) {
  const what = verdict === 'absent' ? 'no' : verdict === 'stale' ? 'expired' : 'unknown'
  console.log(`[server] 401 ${req.method} ${url.pathname} — ${what} token`)
  res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('missing or invalid session token — re-enter the pairing code (a restart or revoke expires tokens)')
}

function ok(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(body)
}

async function file(res, p, type) {
  try {
    const data = await fsp.readFile(p)
    res.writeHead(200, { 'content-type': type ?? guessType(p), 'cache-control': 'no-cache' })
    res.end(data)
  } catch {
    ok(res, 404, 'not found')
  }
}

function guessType(p) {
  return p.endsWith('.css') ? 'text/css; charset=utf-8'
    : p.endsWith('.js') ? 'text/javascript'
    : p.endsWith('.svg') ? 'image/svg+xml'
    : p.endsWith('.html') ? 'text/html; charset=utf-8'
    : 'application/octet-stream'
}

function page(res, which) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(pageHtml(which))
}

// --- SSE: one stream per browser tab, fanned out per surface -----------------
const HEARTBEAT_MS = 25_000
function sse(req, res, surface) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  res.write('retry: 2000\n\n')
  let set = ctl.clients.get(surface)
  if (!set) { set = new Map(); ctl.clients.set(surface, set) }
  const beat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, HEARTBEAT_MS)
  set.set(res, beat)
  req.on('close', () => { clearInterval(beat); set.delete(res) })
}

/** A revoke kills every token, so a stream opened on one of them is a reading
 *  door the bumped epoch no longer protects. Every open response is ENDED:
 *  the browser sees the stream close, reconnects, gets a 401, and re-exchanges
 *  (a page with no code to re-exchange with draws the gate). Nothing is
 *  delivered after the revoke — the sets are cleared in the same tick the
 *  epoch bumped, and each ended response has its heartbeat timer stopped. */
function revokeStreams() {
  for (const [surface, set] of ctl.clients) {
    for (const [res, beat] of set) {
      clearInterval(beat)
      try { res.end() } catch { /* socket already gone */ }
    }
    set.clear()
  }
}

// --- inbound messages: the browser IS the webview ----------------------------
/** The settings panel object we last told the board's browsers about, so the
 *  "open /settings in a new tab" notice fires when it is created, and only
 *  then. */
let settingsSeen = null
async function inbound(req, res, surface) {
  const body = await readJson(req)
  const handlers = ctl.stub.handlers.get(surface) ?? []
  if (!handlers.length) return ok(res, 409, 'surface not open')
  // Answer IMMEDIATELY: a real webview's postMessage does not wait for the
  // handler either, and a handler that opens a dialog (newSessionPrompt,
  // remove, merge) would otherwise hold this request open until the browser
  // answers it — a POST that hangs while the answer comes in on another
  // channel.
  ok(res, 200, 'ok')
  for (const fn of handlers) {
    // The extension registers several listeners per surface, and not all of
    // them return a promise (a sync handler must not abort the loop or crash
    // the dispatch of the ones after it).
    try {
      const r = fn(body)
      if (r && typeof r.catch === 'function') r.catch((err) => console.error('[server] message handler:', err))
    } catch (err) {
      console.error('[server] message handler:', err)
    }
  }
  // The gear click on the board creates the settings panel behind this
  // message. A browser has no tab for it until we say so.
  const settingsPanel = ctl.stub.panels.get('agentsKanban.settings')
  if (settingsPanel && settingsPanel !== settingsSeen) {
    settingsSeen = settingsPanel
    ctl.broadcast('agentsKanban.panel', { type: 'remote', kind: 'settings-opened' })
  }
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return {} }
}

// --- dialog answers ----------------------------------------------------------
function answerDialog(req, res) {
  void readJson(req).then((body) => {
    const d = ctl.dialogs.get(String(body.id ?? ''))
    if (d) {
      ctl.dialogs.delete(String(body.id))
      d.resolve(body.answer)
    }
  })
  ok(res, 200, 'ok')
}

// --- shutdown: stop agents, put the board down cleanly -----------------------
let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  console.log('[server] shutting down')
  extension.deactivate?.()
  for (const d of context.subscriptions) { try { d.dispose?.() } catch { /* last moments */ } }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// --- loading the bundle with `vscode` resolved to the stub (harness.mjs) -----
function loadBundle(vscode) {
  const require_ = createRequire(path.join(root, 'package.json'))
  const stubPath = path.join(root, 'vscode-stub-headless.cjs')
  require_.cache[stubPath] = { id: stubPath, filename: stubPath, loaded: true, exports: vscode }
  const Module = require_('node:module')
  if (!Module.__ckPatched) {
    const orig = Module._resolveFilename
    Module._resolveFilename = function (request, ...rest) {
      return request === 'vscode' ? stubPath : orig.call(this, request, ...rest)
    }
    Module.__ckPatched = true
  }
  return require_(dist)
}

// --- context: real, FILE-BACKED stores ---------------------------------------
function makeContext(storageDir, ctl) {
  const jsonStore = (name, init, mode) => {
    const file = path.join(storageDir, name)
    let state = init
    let pending = null
    try { state = { ...init, ...JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { /* first run */ }
    const flush = async () => {
      await fsp.mkdir(storageDir, { recursive: true })
      const tmp = file + '.tmp'
      await fsp.writeFile(tmp, JSON.stringify(state, null, 2), { mode: mode ?? 0o644 })
      await fsp.rename(tmp, file)
    }
    return {
      file,
      get: (k, fallback) => (k in state ? state[k] : fallback),
      keys: () => Object.keys(state),
      update: async (k, v) => {
        if (v === undefined) delete state[k]
        else state[k] = v
        // Coalesced flush: many updates arrive in bursts; one write at the end.
        pending ??= setTimeout(() => { pending = null; void flush().catch((e) => console.error('[server] store write failed:', e)) }, 50)
      },
      flush,
    }
  }
  const globalState = jsonStore('global-state.json', {})
  const workspaceState = jsonStore('workspace-state.json', {})
  /** API keys in here: 0600, and nothing else ever gets written to this file. */
  const secretsStore = jsonStore('secrets.json', {}, 0o600)

  ctl.stores = { globalState, workspaceState, secrets: secretsStore }

  const context = {
    subscriptions: [],
    extensionUri: { fsPath: root },
    globalStorageUri: { fsPath: storageDir },
    globalState: {
      get: (k, f) => globalState.get(k, f),
      update: (k, v) => globalState.update(k, v),
      keys: () => globalState.keys(),
      setKeysForSync: () => {},
    },
    workspaceState: {
      get: (k, f) => workspaceState.get(k, f),
      update: (k, v) => workspaceState.update(k, v),
      keys: () => workspaceState.keys(),
    },
    /** Secrets on a box: a 0600 file in the storage dir. Not a keychain, but
     *  this machine is the one the credentials are FOR, and the alternative is
     *  asking the user to type an API key into every restart. */
    secrets: {
      get: async (k) => secretsStore.get(k, undefined),
      store: async (k, v) => secretsStore.update(k, v),
      delete: async (k) => secretsStore.update(k, undefined),
      onDidChange: () => ({ dispose() {} }),
    },
  }
  return context
}
