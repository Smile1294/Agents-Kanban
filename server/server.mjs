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
 * and printed. It is the ONLY secret: keep it out of the URL bar's history
 * (the gate page keeps it in sessionStorage, not in the location).
 *
 *   AGENTS_KANBAN_PORT=4310   port (default 4310)
 *   AGENTS_KANBAN_HOST=0.0.0.0  bind beyond localhost (know what that means
 *                              before you do it — the board starts agents that
 *                              spend money; a VPN or SSH tunnel is the safer
 *                              way to reach a box remotely)
 *   AGENTS_KANBAN_REPO=/path  the repository the board works on (default: cwd)
 *   AGENTS_KANBAN_STORAGE=~   where the sidecar and extension state live
 *                             (default ~/.agents-kanban — never in the repo)
 *   AGENTS_KANBAN_CONFIG={}   JSON merged into `agentsKanban` settings
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
const port = Number(process.env.AGENTS_KANBAN_PORT ?? args.port ?? 4310)
const host = process.env.AGENTS_KANBAN_HOST ?? args.host ?? '127.0.0.1'
const repo = path.resolve(process.env.AGENTS_KANBAN_REPO ?? args.repo ?? process.cwd())
const storageDir = path.resolve(process.env.AGENTS_KANBAN_STORAGE ?? args.storage ?? path.join(os.homedir(), '.agents-kanban'))
const code = process.env.AGENTS_KANBAN_CODE ?? args.code ?? randomBytes(12).toString('base64url')
const codeDigest = createHash('sha256').update(code).digest()
const configSeed = (() => {
  const base = { focusMode: 'off' }
  const raw = process.env.AGENTS_KANBAN_CONFIG ?? args.config ?? ''
  if (!raw) return base
  try { return { ...base, ...JSON.parse(raw) } } catch {
    console.error('AGENTS_KANBAN_CONFIG is not valid JSON — ignoring it')
    return base
  }
})()

if (!fs.existsSync(dist)) {
  console.error('dist/extension.js is missing — run: npm run build')
  process.exit(1)
}

// --- the vscode stub, and the extension inside it ----------------------------
const ctl = {
  repo,
  config: configSeed,
  log: (line) => console.log(line.trimEnd()),
  clients: new Map(), // surface -> Set<ServerResponse>
  broadcast(surface, msg) {
    for (const res of ctl.clients.get(surface) ?? []) {
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
  console.log('')
  console.log('  Agents Kanban — headless board')
  console.log('')
  console.log(`  Watching : ${repo}`)
  console.log(`  Open      : http://${host}:${port}/`)
  console.log(`  Code      : ${code}`)
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

    // Everything below moves board state or answers for it: the code gates it.
    if (!authed(req, url)) return authFail(req, res)
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

function authed(req, url) {
  const given = req.headers['x-rc-code'] ?? url.searchParams.get('code') ?? ''
  if (!given) return false
  const digest = createHash('sha256').update(String(given)).digest()
  return timingSafeEqual(digest, codeDigest)
}

function authFail(req, res) {
  const given = req.headers['x-rc-code'] ?? ''
  console.log(`[server] 401 ${req.method} ${req.url} ${given ? 'wrong code' : 'no code'}`)
  res.writeHead(401, { 'content-type': 'text/plain' })
  res.end('wrong or missing pairing code')
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
  const set = ctl.clients.get(surface) ?? new Set()
  set.add(res)
  ctl.clients.set(surface, set)
  const beat = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, HEARTBEAT_MS)
  req.on('close', () => { clearInterval(beat); set.delete(res) })
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
