/**
 * WHAT DOES A TAP ON THE PHONE COST, END TO END?
 *
 * A benchmark, not a gate — it prints numbers and exits 0, and the test runner
 * only collects `src/**\/*.test.*`, so it never runs as part of `verify`. The
 * numbers in docs/REMOTE-LATENCY.md §6 come from this script; re-run it after
 * anything that touches the cadence, the relay contract or the state shape,
 * and put what it says back into that document rather than believing the old
 * figures.
 *
 * It was a scratch file for the first measurement, which is why §6 could not be
 * re-checked afterwards. It is checked in now.
 *
 * Everything in the loop is REAL:
 *
 *   - the relay is the sibling repository's `server.js`, spawned on an
 *     ephemeral port with its own throwaway store;
 *   - the page is the real `public/index.html` + `bridge.js` + the extension's
 *     own `media/board.js`, in real Chromium;
 *   - the cadence is the real `RemotePusher`, with the real `remoteFrame`
 *     shape and the real message client.
 *
 * The five marks:
 *
 *   1. tap                  a real click on a rail row
 *   2. relay HAS it         the page's `msg` POST has landed
 *   3. machine PICKED it UP the message poll returned it
 *   4. machine PUSHED       the frame POST answered
 *   5. the phone SHOWS it   a MutationObserver in the page fired on the new
 *                           chat title — so "shows it" means it was drawn
 *
 * RUN IT SEVERAL TIMES. One run is meaningless: the answer used to depend on
 * where in two independent 2 s windows the tap landed, and that being the
 * finding is the reason this script exists at all.
 *
 *   node --experimental-strip-types --no-warnings test/remote-latency.ts [taps]
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { RemotePusher, type PushSnapshot } from '../src/remote/pusher.ts'
import { RemoteMessageClient } from '../src/remote/messages.ts'
import { boardIdOf, remoteFrame } from '../src/remote/relay.ts'
import type { UiState } from '../src/board/panel.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.dirname(HERE)
const RELAY = path.resolve(REPO, '..', 'Agents-Kanban-Relay')
const TAPS = Number(process.argv[2] ?? 10)
const CODE = 'measure-me-please'
const BOARD = boardIdOf(CODE)

if (!existsSync(path.join(RELAY, 'server.js'))) {
  console.error(`No relay checkout at ${RELAY} — clone agents-kanban-relay beside this repo.`)
  process.exit(1)
}

/* --- a board to tap around on ---------------------------------------------
   Two sessions with different transcripts, because the thing being timed is
   the board CHANGING: a tap that lands on what is already drawn cannot be
   measured by watching the DOM. */
const SESSIONS = [
  { key: 'aaaa1111-0000-4000-8000-000000000001', title: 'Wire the settings page', text: 'first session answer' },
  { key: 'bbbb2222-0000-4000-8000-000000000002', title: 'Chase the meter bug', text: 'second session answer' },
]

const COLUMNS = [
  { id: 'planning', title: 'Planning', category: 'unstarted' as const },
  { id: 'implementing', title: 'Implementing', category: 'started' as const },
]

const cards = SESSIONS.map((s) => ({
  key: s.key, sessionId: s.key, title: s.title, phase: 'implementing',
  tags: [] as string[], updated: 1_700_000_000_000,
}))

const composer = {
  model: 'claude-opus-5', effort: 'medium', thinking: 'off',
  efforts: [], thinkingSupported: false, ultracode: false, fastMode: false,
  ultracodeSupported: false, fastModeSupported: false, modelSource: 'builtin',
  agent: 'claude|inherit', agents: [], agentLocked: false,
  runtime: 'claude', runtimes: [], provider: 'inherit', providers: [],
  contextTokens: 0, permissionMode: 'acceptEdits', permissionModes: [],
  orchestration: 'off',
}

/** The state the host would build for the surface watching `key`. */
function stateFor(key: string): UiState {
  const s = SESSIONS.find((x) => x.key === key)
  return {
    ready: true, mode: 'chat', selectedKey: key, columns: COLUMNS, cards,
    composer: { ...composer },
    transcript: s ? [{ kind: 'text', at: 1_700_000_000_000, text: s.text }] : [],
    running: 0, waiting: 0,
  } as unknown as UiState
}

/* --- the relay -------------------------------------------------------------- */

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ck-relay-'))
let relay: ChildProcess | undefined
let browser: Browser | undefined

const bye = async (code: number): Promise<never> => {
  await browser?.close().catch(() => {})
  relay?.kill()
  await rm(dataDir, { recursive: true, force: true }).catch(() => {})
  process.exit(code)
}

const port = await new Promise<number>((resolve, reject) => {
  relay = spawn(process.execPath, ['server.js'], {
    cwd: RELAY,
    env: { ...process.env, PORT: '0', RC_DATA: dataDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const timer = setTimeout(() => reject(new Error('the relay never announced a port')), 10_000)
  let out = ''
  relay.stdout?.on('data', (b: Buffer) => {
    out += String(b)
    const m = /http:\/\/localhost:(\d+)/.exec(out)
    if (m?.[1]) { clearTimeout(timer); resolve(Number(m[1])) }
  })
  relay.on('exit', (c) => { clearTimeout(timer); reject(new Error(`the relay exited (${c})`)) })
}).catch(async (e: unknown) => {
  console.error(String(e))
  return bye(1)
})

const base = `http://127.0.0.1:${port}`
console.log(`  relay on ${base}, board ${BOARD}`)

/* --- the machine: the real pusher, the real message client ------------------ */

/** What the surface on the phone is watching. A `select` message moves it,
 *  exactly as `host.select(id, 'remote')` does in the extension. */
let watched = SESSIONS[0]!.key
/** Node-side marks for the two middle hops. The page's own clock has a
 *  different origin, so only these three are on one timeline; the last mark is
 *  the total, measured here, of a promise the page resolves when it has drawn.
 *  Zero means "not yet this tap". */
let pickedAt = 0
let pushedAt = 0
/** The model catalogue rides the first push only — see `build`. */
let modelsDue = true
const MODELS = [
  { id: 'claude-opus-5', label: 'Opus 5', context: '1M', contextTokens: 1_000_000 },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', context: '200K', contextTokens: 200_000 },
]

const pusher = new RemotePusher({
  now: () => Date.now(),
  baseUrl: base,
  boardId: BOARD,
  enabled: true,
  fetch,
  build: (): PushSnapshot => ({
    /* The catalogue rides the FIRST push and no other, which is what the host
       does: it is 431 entries with a paragraph each, and the page keeps the
       last one it saw. A frame with no models ever pushed leaves the page's
       `fetchModels()` with nothing to fetch. */
    frame: remoteFrame(stateFor(watched), modelsDue ? MODELS : undefined, 'bench:1', { available: false }),
    writes: true,
  }),
  onStatus: (st) => {
    if (st.ok) { pushedAt = performance.now(); modelsDue = false }
    else console.error(`  push failed: ${st.error ?? st.note ?? '?'}`)
  },
})

const client = new RemoteMessageClient({ baseUrl: base, boardId: BOARD, fetch })

await pusher.nudge()
{
  const probe = await fetch(`${base}/board?id=${BOARD}`).then((r) => r.json()) as
    { ok?: boolean; frame?: { state?: { ready?: boolean; cards?: unknown[] } } }
  console.log(`  relay holds a frame: ${!!probe.frame}`
    + `, ready=${probe.frame?.state?.ready}, cards=${probe.frame?.state?.cards?.length}`)
}

/* --- the page --------------------------------------------------------------- */

/* The same search `layout.test.mjs` does, and for the same reason:
   PLAYWRIGHT_BROWSERS_PATH is the ONLY place a browser exists on a container
   image, the default cache does not exist at all, and the build number under it
   need not match the one the installed playwright package wants. */
async function findChromium(): Promise<string | undefined> {
  const roots = [
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? [process.env.PLAYWRIGHT_BROWSERS_PATH] : []),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ]
  for (const cache of roots) {
    const dirs = await readdir(cache).catch(() => [] as string[])
    const builds = dirs
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      .sort((a, b) => Number(/\d+$/.exec(b)?.[0] ?? 0) - Number(/\d+$/.exec(a)?.[0] ?? 0))
    for (const d of builds) {
      for (const rel of [['chrome-linux', 'headless_shell'], ['chrome-linux', 'chrome'],
                         ['chrome-linux64', 'chrome'],
                         ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
                         ['chrome-win', 'chrome.exe']]) {
        const exe = path.join(cache, d, ...rel)
        if (await stat(exe).then((st) => st.isFile(), () => false)) return exe
      }
    }
  }
  return undefined
}
const exe = await findChromium()
browser = await chromium.launch(exe ? { executablePath: exe } : {})
const page: Page = await browser.newPage()
page.on('pageerror', (e) => console.error(`  page error: ${e.message}`))
page.on('console', (m) => { if (m.type() === 'error') console.error(`  page console: ${m.text()}`) })
await page.goto(`${base}/#${BOARD}`)
await page.waitForSelector('.rail-item', { timeout: 15_000 }).catch(async () => {
  console.error('the page never drew a board — nothing to tap. What it shows:')
  console.error((await page.evaluate(() => document.body.innerText)).slice(0, 1200))
  await bye(1)
})

/** The mark the phone itself provides: a MutationObserver resolves when the
 *  chat title becomes `want`, so "the phone shows it" is what was DRAWN and
 *  not what was received. */
await page.exposeFunction('__benchMark', () => {})
async function waitForTitle(want: string): Promise<number> {
  return page.evaluate((title: string) => new Promise<number>((resolve) => {
    const seen = () => document.querySelector('.chat-title')?.textContent === title
    if (seen()) { resolve(performance.now()); return }
    const ob = new MutationObserver(() => { if (seen()) { ob.disconnect(); resolve(performance.now()) } })
    ob.observe(document.body, { childList: true, subtree: true, characterData: true })
    setTimeout(() => { ob.disconnect(); resolve(-1) }, 20_000)
  }), want)
}

/* --- the loop the extension runs ------------------------------------------- */

let stop = false
const pumpMessages = async (): Promise<void> => {
  while (!stop) {
    try {
      const { msgs } = await client.poll(20)
      const list = Array.isArray(msgs) ? msgs : []
      if (!list.length) continue
      const nonces: string[] = []
      for (const raw of list) {
        const m = raw as { nonce?: string; msg?: { type?: string; id?: string } }
        if (m.nonce) nonces.push(m.nonce)
        if (m.msg?.type === 'select' && typeof m.msg.id === 'string') {
          watched = m.msg.id
          if (!pickedAt) pickedAt = performance.now()
        }
      }
      if (nonces.length) await client.ack(nonces)
      // The one signal that a PERSON did something. Same call the host makes.
      await pusher.nudge({ urgent: true })
    } catch {
      if (!stop) await new Promise((r) => setTimeout(r, 50))
    }
  }
}
void pumpMessages()

/* --- taps -------------------------------------------------------------------- */

const runs: number[] = []
const hops: { picked: number; pushed: number; total: number }[] = []
for (let i = 0; i < TAPS; i++) {
  const target = SESSIONS[(i + 1) % SESSIONS.length]!
  const drawn = waitForTitle(target.title)
  const t0 = performance.now()
  pickedAt = 0
  pushedAt = 0
  await page.click(`.rail-item:has-text("${target.title}")`)
  const at = await drawn
  const took = performance.now() - t0
  if (at < 0) { console.error(`  tap ${i + 1}: the phone never showed it — giving up`); break }
  runs.push(took)
  hops.push({ picked: pickedAt ? pickedAt - t0 : -1, pushed: pushedAt ? pushedAt - t0 : -1, total: took })
  console.log(`  tap ${i + 1}: ${took.toFixed(0)}ms`)
}
stop = true
pusher.dispose()

if (!runs.length) { console.error('nothing was measured'); await bye(1) }
const ms = [...runs].sort((a, b) => a - b)
const median = ms[Math.floor(ms.length / 2)]!

console.log(`\n— a tap on the phone, end to end`)
console.log(`  ${runs.length} taps, sorted: ${ms.map((m) => m.toFixed(0)).join(', ')} ms`)
console.log(`  median ${median.toFixed(0)}ms`)
const mid = (pick: (h: typeof hops[number]) => number): string => {
  const xs = hops.map(pick).filter((x) => x >= 0).sort((a, b) => a - b)
  return xs.length ? `${xs[Math.floor(xs.length / 2)]!.toFixed(0)}ms` : '—'
}
console.log(`\n  the hops, median of each:`)
console.log(`    + ${'0ms'.padStart(6)}   1. tap on the phone`)
console.log(`    + ${mid((h) => h.picked).padStart(6)}   2. the machine PICKED IT UP off the message poll`)
console.log(`    + ${mid((h) => h.pushed).padStart(6)}   3. the machine PUSHED the new board`)
console.log(`    + ${mid((h) => h.total).padStart(6)}   4. the phone SHOWS it (a MutationObserver in the page)`)
console.log(`\n  Local relay, so no internet round trips: a real deployment adds`)
console.log(`  four of them (~200ms at 50ms RTT), which is then the dominant term.`)
console.log(`  The view draws its own click immediately (the rail row highlights`)
console.log(`  and the chat title changes with no round trip at all); what is`)
console.log(`  timed here is the CONVERSATION arriving from the machine.\n`)

await bye(0)
