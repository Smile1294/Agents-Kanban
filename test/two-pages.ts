/**
 * CAN TWO PAGES BE IN TWO DIFFERENT CHATS?
 *
 * The whole of contract v4 in one script. Not a gate — it needs the relay
 * checked out beside this repository and a Chromium, and the runner collects
 * only `src/**\/*.test.*` — but it is the one thing that proves the pieces
 * compose: the pure registry, the transport, the relay's frame slots and the
 * page's viewer id are each unit-tested on their own, and every one of them
 * could be right while the whole is a mirror again.
 *
 * "Every unit test was green while agents could not move their own cards" is
 * the rule this exists under. Run it after anything that touches the relay
 * contract, the pusher, or how the host decides which session a surface sees.
 *
 *   node --experimental-strip-types --no-warnings test/two-pages.ts
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { RemotePusher, type PushSnapshot } from '../src/remote/pusher.ts'
import { RemoteMessageClient, parseMessages } from '../src/remote/messages.ts'
import { boardIdOf, remoteFrame } from '../src/remote/relay.ts'
import { Watches, remoteSink, type StateSink } from '../src/board/watches.ts'
import type { UiState } from '../src/board/panel.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RELAY = path.resolve(path.dirname(HERE), '..', 'Agents-Kanban-Relay')
const BOARD = boardIdOf('two-pages-please')

let fails = 0
const ok = (c: boolean, m: string): void => {
  if (c) console.log(`  ok: ${m}`)
  else { console.error(`  FAIL: ${m}`); fails++ }
}

if (!existsSync(path.join(RELAY, 'server.js'))) {
  console.error(`No relay checkout at ${RELAY} — clone agents-kanban-relay beside this repo.`)
  process.exit(1)
}

const SESSIONS = [
  { key: 'aaaa1111-0000-4000-8000-000000000001', title: 'Wire the settings page', text: 'first session answer' },
  { key: 'bbbb2222-0000-4000-8000-000000000002', title: 'Chase the meter bug', text: 'second session answer' },
]
const COLUMNS = [{ id: 'implementing', title: 'Implementing', category: 'started' as const }]
const cards = SESSIONS.map((s) => ({
  key: s.key, sessionId: s.key, title: s.title, phase: 'implementing',
  tags: [] as string[], updated: 1_700_000_000_000,
}))
const composer = {
  model: 'claude-opus-5', effort: 'medium', thinking: 'off', efforts: [],
  thinkingSupported: false, ultracode: false, fastMode: false,
  ultracodeSupported: false, fastModeSupported: false, modelSource: 'builtin',
  agent: 'claude|inherit', agents: [], agentLocked: false, runtime: 'claude',
  runtimes: [], provider: 'inherit', providers: [], contextTokens: 0,
  permissionMode: 'acceptEdits', permissionModes: [], orchestration: 'off',
}
const MODELS = [{ id: 'claude-opus-5', label: 'Opus 5', context: '1M', contextTokens: 1_000_000 }]

/* The host's own registry, driven exactly as extension.ts drives it: a `select`
   sets the sending SINK's watch and nothing else. */
const watches = new Watches(() => ({ key: SESSIONS[0]!.key, mode: 'chat' }))

function stateFor(sink: StateSink): UiState {
  const key = watches.of(sink).key ?? ''
  const s = SESSIONS.find((x) => x.key === key)
  return {
    ready: true, mode: 'chat', selectedKey: key, columns: COLUMNS, cards,
    composer: { ...composer },
    transcript: s ? [{ kind: 'text', at: 1_700_000_000_000, text: s.text }] : [],
    running: 0, waiting: 0,
  } as unknown as UiState
}

/* --- the relay --------------------------------------------------------------- */

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ck-two-'))
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
}).catch(async (e: unknown) => { console.error(String(e)); return bye(1) })

const base = `http://127.0.0.1:${port}`
const client = new RemoteMessageClient({ baseUrl: base, boardId: BOARD, fetch })

/* --- the machine: a pusher per frame slot, exactly as the host builds them ---- */

const pushers = new Map<string, RemotePusher>()
let modelsDue = true
let keepsSlots = false

function ensurePusher(viewer: string): RemotePusher | undefined {
  const held = pushers.get(viewer)
  if (held) return held
  if (viewer && !keepsSlots) return undefined
  const sink = remoteSink(viewer || undefined)
  const made = new RemotePusher({
    now: () => Date.now(),
    baseUrl: base,
    boardId: BOARD,
    ...(viewer ? { viewer } : {}),
    enabled: true,
    fetch,
    build: (): PushSnapshot => ({
      frame: remoteFrame(stateFor(sink), modelsDue ? MODELS : undefined, 'bench:1', { available: false }),
      writes: true,
    }),
    onStatus: (st) => { if (st.ok) modelsDue = false },
    onAnswer: (a) => { if (a.viewers === true) keepsSlots = true },
  })
  pushers.set(viewer, made)
  return made
}

ensurePusher('')
await pushers.get('')!.nudge()
ok(keepsSlots, 'the relay SAYS it keeps a frame slot per viewer — the pusher never assumes it')

/* --- two pages ----------------------------------------------------------------- */

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

/** A page in its own browser CONTEXT — separate localStorage, so it makes its
 *  own viewer id. Two tabs of one profile would share one, which is the right
 *  answer for tabs and the wrong test for two devices. */
async function openPage(): Promise<Page> {
  const ctx = await browser!.newContext()
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.error(`  page error: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') console.error(`  page console: ${m.text()}`) })
  await page.goto(`${base}/#${BOARD}`)
  await page.waitForSelector('.rail-item', { timeout: 30_000 }).catch(async () => {
    console.error('  a page never drew a board. What it shows:')
    console.error((await page.evaluate(() => document.body.innerText)).slice(0, 800))
    const probe = await fetch(`${base}/board?id=${BOARD}`).then((r) => r.json()) as
      { frame?: { state?: { ready?: boolean; cards?: unknown[] } } }
    console.error(`  shared slot: frame=${!!probe.frame} ready=${probe.frame?.state?.ready} cards=${probe.frame?.state?.cards?.length}`)
    const mp = await fetch(`${base}/board?id=${BOARD}&models=1`)
    console.error(`  models: ${mp.status} ${JSON.stringify(await mp.json()).slice(0, 200)}`)
    await bye(1)
  })
  return page
}

const one = await openPage()
const two = await openPage()

/* --- the machine's message loop ------------------------------------------------ */

let stop = false
const pump = async (): Promise<void> => {
  while (!stop) {
    try {
      const { msgs, viewers } = await client.poll(20)
      if (viewers && keepsSlots) {
        for (const v of viewers) if (!pushers.has(v)) void ensurePusher(v)?.nudge({ urgent: true })
      }
      const list = parseMessages(msgs ?? [])
      if (!list.length) continue
      for (const m of list) {
        if (m.viewer) ensurePusher(m.viewer)
        // The one line this whole contract exists for: a select moves the
        // SENDING page's watch, and nobody else's.
        if (m.msg.type === 'select' && typeof m.msg.id === 'string') {
          watches.set(remoteSink(m.viewer), { key: m.msg.id })
        }
      }
      await client.ack(list.map((m) => m.nonce))
      for (const p of pushers.values()) await p.nudge({ urgent: true }).catch(() => {})
    } catch {
      if (!stop) await new Promise((r) => setTimeout(r, 50))
    }
  }
}
void pump()

const titleOf = (p: Page): Promise<string> =>
  p.evaluate(() => document.querySelector('.chat-title')?.textContent ?? '')

async function waitForTitle(p: Page, want: string): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if ((await titleOf(p)) === want) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

// Page one opens the second session; page two stays where it is.
await one.click(`.rail-item:has-text("${SESSIONS[1]!.title}")`)
ok(await waitForTitle(one, SESSIONS[1]!.title), 'page one opens the session it tapped')
ok((await titleOf(two)) === SESSIONS[0]!.title,
  'and page two is still on ITS session — not dragged along by somebody else’s tap')

// Now page two opens the first session while page one stays on the second.
await two.click(`.rail-item:has-text("${SESSIONS[0]!.title}")`)
ok(await waitForTitle(two, SESSIONS[0]!.title), 'page two opens its own')
ok((await titleOf(one)) === SESSIONS[1]!.title, 'and page one is untouched by that')

// The conversations, not just the titles: the transcript is the big object and
// the thing that used to arrive from the wrong session.
const textOf = (p: Page): Promise<string> => p.evaluate(() => document.body.innerText)
/* Wait for the CONVERSATION, not the title: the view draws its own click
   immediately (that is step 1 of the rework) and the rows arrive from the
   machine a moment later. Asserting on the title alone would pass over a
   transcript that never came. */
async function waitForText(p: Page, want: string): Promise<boolean> {
  for (let i = 0; i < 100; i++) {
    if ((await p.evaluate(() => document.body.innerText)).includes(want)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}
ok(await waitForText(one, SESSIONS[1]!.text), 'page one is sent the conversation it opened')
ok(await waitForText(two, SESSIONS[0]!.text), 'and page two the one IT opened')
const oneText = await textOf(one)
const twoText = await textOf(two)
ok(!oneText.includes(SESSIONS[0]!.text),
  "…and none of the other page's — the transcript is the object that used to arrive from the wrong session")
ok(!twoText.includes(SESSIONS[1]!.text),
  'nor the other way round, at the same time, on the same board')

const slots = [...pushers.keys()].filter(Boolean)
ok(slots.length === 2, `the machine is pushing one board per page (${slots.length})`)

stop = true
for (const p of pushers.values()) p.dispose()
console.log(fails ? `\n${fails} FAILURES` : '\nPASS — two pages, two chats, one board')
await bye(fails ? 1 : 0)
