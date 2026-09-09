/* What does switching chats cost IN THE EDITOR?
 *
 * A benchmark, not a gate — it prints numbers and exits 0, and the runner only
 * collects `src/**\/*.test.*`, so it never runs as part of `verify`.
 *
 * Every latency number this project has produced so far has been about the
 * REMOTE page. But the round trip is the same one locally: a click posts
 * `select`, the host changes its one `selectedKey`, and a whole state comes
 * back. Nobody had measured it, so the rework had no local before-and-after.
 * This is that baseline.
 *
 * It drives the BUILT bundle through the same stub the smoke gate uses, so what
 * is measured is the real host: the real `getState()`, the real session-index
 * scan, the real transcript parse, the real payload.
 *
 *   node test/switch-latency.mjs [sessions] [entriesEach]
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadBundle, makeContext, makeRepo, makeVscodeStub } from './harness.mjs'

const SESSIONS = Number(process.argv[2] ?? 6)
const ENTRIES = Number(process.argv[3] ?? 150)
const ROUNDS = 12

const repo = await makeRepo('ck-switch-')
const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-store-'))
const claudeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-claude-'))
process.env.CLAUDE_CONFIG_DIR = claudeHome

/* Sessions with real transcripts, seeded the way smoke.mjs does — the project
   directory is the REALPATH with every non-alphanumeric replaced by `-`. */
const cwd = await fs.realpath(repo)
const projectDir = path.join(claudeHome, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
await fs.mkdir(projectDir, { recursive: true })

const ids = Array.from({ length: SESSIONS }, (_, i) =>
  `${String(i + 1).repeat(8)}-2222-3333-4444-555555555555`)

const meta = {}
for (const [i, id] of ids.entries()) {
  const common = {
    sessionId: id, cwd, isSidechain: false, userType: 'external',
    version: '2.0.0', gitBranch: 'main',
  }
  const lines = [{
    ...common, type: 'user', uuid: 'u0', parentUuid: null,
    timestamp: new Date(1e12).toISOString(),
    message: { role: 'user', content: `session ${i} prompt` },
  }]
  for (let e = 0; e < ENTRIES; e++) {
    lines.push({
      ...common, type: 'assistant', uuid: `a${e}`, parentUuid: e ? `a${e - 1}` : 'u0',
      timestamp: new Date(1e12 + (e + 1) * 1000).toISOString(),
      message: {
        id: `msg_${i}_${e}`, model: 'claude-opus-5', role: 'assistant', type: 'message',
        content: [{ type: 'text', text: 'Lorem ipsum dolor sit amet consectetur. '.repeat(12) + e }],
        usage: { input_tokens: 100, output_tokens: 200 },
      },
    })
  }
  await fs.writeFile(path.join(projectDir, `${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  meta[id] = { phase: 'implementing', tags: [], archived: false, pinned: false, activity: [] }
}
await fs.mkdir(path.join(storage, 'sessions'), { recursive: true })
await fs.writeFile(path.join(storage, 'sessions', encodeURIComponent(repo) + '.json'),
  JSON.stringify(meta))

const ctl = {
  repo, noFolder: false,
  config: {
    model: 'claude-opus-5', maxConcurrentAgents: 3, permissionMode: 'acceptEdits',
    worktreeRoot: '', discoverModels: false,
  },
}
const stub = makeVscodeStub(ctl)
const ext = loadBundle(stub.vscode)
await ext.activate(await makeContext(storage))
// The editor panel is what installs a message handler — the board is a webview
// in an editor group, and until the command opens it there is nobody to talk to.
await stub.cmds.get('agentsKanban.openBoard')()

const send = async (msg) => { for (const h of stub.handlers) await h(msg) }
const lastState = () => {
  const states = stub.posted.filter((m) => m.type === 'state').map((m) => m.state)
  return states[states.length - 1]
}

await send({ type: 'ready' })
const first = lastState()
if (!first?.ready) { console.error('the host never became ready — cannot measure'); process.exit(1) }
const cards = (first.cards ?? []).filter((c) => ids.includes(c.key))
if (cards.length < 2) {
  console.error(`only ${cards.length} seeded sessions reached the board — cannot measure`)
  process.exit(1)
}

/** One switch: post what a click posts, and wait until a state for that
 *  session has actually been handed to the webview. */
async function switchTo(key) {
  const t0 = performance.now()
  await send({ type: 'select', id: key })
  await send({ type: 'setMode', mode: 'chat' })
  const st = lastState()
  const took = performance.now() - t0
  return { took, ok: st?.selectedKey === key, rows: (st?.transcript ?? []).length,
           bytes: JSON.stringify(st ?? {}).length }
}

// Warm up: the first call pays for caches nobody pays for twice.
await switchTo(cards[0].key)
await switchTo(cards[1].key)

const runs = []
for (let i = 0; i < ROUNDS; i++) {
  const r = await switchTo(cards[i % cards.length].key)
  if (!r.ok) { console.error('a switch did not take effect — the measurement would be a lie'); process.exit(1) }
  runs.push(r)
}

const ms = runs.map((r) => r.took).sort((a, b) => a - b)
const median = ms[Math.floor(ms.length / 2)]
const last = runs[runs.length - 1]

console.log(`\n— switching chats in the editor`)
console.log(`  ${cards.length} sessions on the board, ${ENTRIES} transcript entries each`)
console.log(`  ${ROUNDS} switches: min ${ms[0].toFixed(0)}ms  median ${median.toFixed(0)}ms  max ${ms[ms.length - 1].toFixed(0)}ms`)
console.log(`  each one ships ${last.rows} transcript rows, ${(last.bytes / 1024).toFixed(0)} KB of state`)
console.log(`\n  This is the round trip piece 1 removes: the click cannot draw`)
console.log(`  anything until the host has rebuilt and re-sent the whole board.`)
console.log(`  (Excludes the webview's own render, and any coalesce delay when`)
console.log(`   an agent is streaming at the same time.)\n`)

/* The host keeps timers alive — the remote poll, the push ticker, the
   background-agent tick — so nothing would ever end this process on its own.
   A benchmark that never exits reads as a hang. */
process.exit(0)
