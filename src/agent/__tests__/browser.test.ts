/* The agents' browser, against a REAL Chromium and a REAL local server.
   What it guards: that an agent can open its own app, see it as text and as a
   picture, act on it, and HEAR the console errors a screenshot hides — and that
   it cannot be pointed at a site that is not this machine. Needs a Chromium
   (like layout.test.mjs); FAILS without one rather than skipping. */
import { promises as fs } from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { allowedUrl, BrowserPool, describeEvents, findBrowser } from '../browser.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// ---------------------------------------------------------------------------
// 1. The boundary, in code.
ok(allowedUrl('http://localhost:5173/login').ok, 'the agent\'s own app is allowed')
ok(allowedUrl(':5173/x').ok && (allowedUrl(':5173/x') as { url: string }).url === 'http://localhost:5173/x', 'a bare port means localhost')
ok(allowedUrl('http://127.0.0.1:8000').ok && allowedUrl('http://[::1]:3000').ok, 'loopback in both address families is allowed')
ok(allowedUrl('http://app.localhost:3000').ok, '*.localhost is loopback by definition')
ok(!allowedUrl('https://example.com').ok, 'another site is refused by default')
ok(allowedUrl('https://example.com', true).ok, '…and allowed only when the user widened it')
ok(!allowedUrl('file:///etc/passwd').ok, 'file: is never a page the agent opens')
ok(!allowedUrl('javascript:alert(1)').ok, 'neither is javascript:')
ok(describeEvents([]).startsWith('No console errors'), 'no events is SAID, not left blank')

// ---------------------------------------------------------------------------
// 2. A real page.
const exe = await findBrowser()
if (!exe) { console.log('FAIL: no Chromium to drive — run `node scripts/run-bin.mjs playwright playwright install chromium`'); process.exit(1) }

const page = `<!doctype html><title>Todo</title>
<h1>Todos</h1>
<label>New <input id="new" name="new"></label>
<button id="add" onclick="add()">Add</button>
<ul id="list"></ul>
<button id="broken" onclick="undefinedFn()">Broken</button>
<script>
function add(){ const li=document.createElement('li'); li.textContent=document.getElementById('new').value; document.getElementById('list').append(li) }
console.error('boot warning from the app')
fetch('/missing')
</script>`
const server = http.createServer((q, s) => {
  if (q.url === '/missing') { s.statusCode = 404; s.end('nope'); return }
  s.setHeader('content-type', 'text/html'); s.end(page)
})
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
const port = (server.address() as { port: number }).port

const shots = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-shots-'))
const pool = new BrowserPool({ shotsDir: shots })
try {
  const opened = await pool.open('card-1', `http://localhost:${port}/`)
  ok(opened.includes('"Todo"'), 'open names the page it landed on')
  ok(/console\.error\] boot warning/.test(opened), 'a console error during load is reported WITH the open, unasked')
  ok(/\[http\] 404 GET .*\/missing/.test(opened), 'a 404 from the app is reported too')

  const snap = await pool.snapshot('card-1')
  ok(/heading "Todos"/.test(snap) && /button "Add"/.test(snap), 'the snapshot is the ARIA tree, naming what can be clicked')
  ok(!/boot warning/.test(snap), 'events are reported once, not on every call')

  await pool.act('card-1', { action: 'fill', target: '#new', text: 'buy milk' })
  const clicked = await pool.act('card-1', { action: 'click', target: 'role=button[name="Add"]' })
  ok(clicked.startsWith('Done: click'), 'a role selector clicks')
  ok(/listitem: buy milk/.test(await pool.snapshot('card-1', '#list')), 'the effect of the click is visible in a targeted snapshot')

  const broke = await pool.act('card-1', { action: 'click', target: '#broken' })
  ok(/pageerror\].*undefinedFn/.test(broke), 'an uncaught exception from a click comes back with the click — the thing a screenshot hides')

  ok((await pool.evaluate('card-1', 'document.querySelectorAll("li").length')).startsWith('1'), 'evaluate returns JSON')

  const shot = await pool.screenshot('card-1')
  ok(shot.mimeType === 'image/jpeg' && Buffer.from(shot.data, 'base64').subarray(0, 2).toString('hex') === 'ffd8', 'a screenshot is a real JPEG')
  ok(!!shot.saved && (await fs.stat(shot.saved)).size > 1000, 'and it is saved where the USER can open it')
  const elem = await pool.screenshot('card-1', { target: '#list' })
  ok(Buffer.from(elem.data, 'base64').length < Buffer.from(shot.data, 'base64').length, 'an element screenshot is smaller than the page')

  let refused = ''
  try { await pool.open('card-1', 'https://example.com') } catch (e) { refused = String(e) }
  ok(/not this machine/.test(refused), 'opening another site is refused in the handler, not only in prose')

  // A port that was free a moment ago (Chromium refuses port 1 outright as
  // "unsafe", which is a different error from nothing listening).
  const closed = await new Promise<number>((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)) }) })
  let nothing = ''
  try { await pool.open('card-2', `http://127.0.0.1:${closed}/`) } catch (e) { nothing = String(e) }
  ok(/Nothing is listening.*app_start/.test(nothing), 'a dead port names the fix (start the app)')

  // Two cards, two contexts: storage does not leak between agents.
  await pool.evaluate('card-1', 'localStorage.setItem("who", "one")')
  await pool.open('card-3', `http://localhost:${port}/`)
  ok((await pool.evaluate('card-3', 'localStorage.getItem("who")')).startsWith('null'), 'each card has its own storage')

  let noTab = ''
  try { await pool.snapshot('card-9') } catch (e) { noTab = String(e) }
  ok(/browser_open first/.test(noTab), 'acting before opening says what to do')

  ok(await pool.close('card-1') && !pool.has('card-1'), 'close drops the card\'s page')
} finally {
  await pool.shutdown()
  server.close()
  await fs.rm(shots, { recursive: true, force: true })
}

if (fails) { console.log(`${fails} failure(s)`); process.exit(1) }
