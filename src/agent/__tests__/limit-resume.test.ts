/* The account's usage limit, driven through the REAL manager: a real
 * `start()` -> `launch()` -> `startRun()` chain, a real git repo, and a fake
 * runtime that emits what Claude Code emits when a subscription runs out.
 *
 * What it guards, each of which is silent when broken: a limited run left as a
 * red error card instead of parked; a new task started into an account that is
 * known to be out (a billed failure, and the prompt gone); one limited account
 * holding up ANOTHER account's queue; the timer not firing, or firing without
 * resuming; a resume that loops into the same limit forever; and a restart that
 * forgets every card was waiting. */
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { registerRuntime, type AgentRuntime, type RunSpec } from '../runtime.ts'
import { AgentManager } from '../manager.ts'
import { MAX_AUTO_RESUMES, RESUME_PROMPT, type ParkedRecord } from '../limits.ts'
import { WorktreeService } from '../../git/worktree.ts'
import { DEFAULT_BOARD } from '../../board/config.ts'

const run = promisify(execFile)
const sh = (cwd: string, ...args: string[]) => run('git', args, { cwd })
let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- a fake runtime that records every run ------------------------------------
type Fake = EventEmitter & { spec: RunSpec; prompt?: string }
const runs: Fake[] = []
const descriptor = (id: 'claude' | 'codex', providerProfiles: boolean): AgentRuntime => ({
  id, label: id, vendor: 'test', blurb: '', installHint: 'n/a',
  capabilities: { providerProfiles, boardTools: 'stdio', thinkingToggle: false },
  async detect() { return { command: '/bin/true' } },
  async login() { return { kind: 'signedIn' as const } },
  async models() { return { models: [] } },
  builtinModels() { return [{ id: `${id}-m`, label: 'm' }] },
  start(spec: RunSpec) {
    const e = new EventEmitter() as Fake
    e.spec = spec
    Object.assign(e, {
      run(prompt: string) { e.prompt = prompt; return new Promise(() => {}) },
      send() {}, stop() {}, interrupt() { return Promise.resolve() }, get state() { return { kind: 'working' } },
      get lastEvent() { return Date.now() }, get sessionId() { return undefined }, dispose() {},
    })
    runs.push(e)
    return e
  },
} as unknown as AgentRuntime)
registerRuntime(descriptor('claude', true))
registerRuntime(descriptor('codex', false))

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limits-e2e-'))
await sh(root, 'init', '-q', '-b', 'main')
await sh(root, 'config', 'user.email', 't@example.com')
await sh(root, 'config', 'user.name', 'T')
await fs.writeFile(path.join(root, 'README.md'), '# repo\n')
await sh(root, 'add', '-A')
await sh(root, 'commit', '-qm', 'init')

const meta = new Map<string, Record<string, unknown>>()
const store = {
  async card(key: string) { return { phase: 'implementing', tags: [], ...(meta.get(key) ?? {}) } },
  async childrenOf() { return [] },
  async setTags() {},
  async get(key: string) { return meta.get(key) },
  async allMeta() { return Object.fromEntries(meta) },
  async patch(key: string, patch: Record<string, unknown>) {
    const next: Record<string, unknown> = { ...(meta.get(key) ?? {}), ...patch }
    if (patch.parked === null) delete next.parked
    meta.set(key, next)
  },
  async rename() { return { renamed: true } },
  async adoptKey() {},
  async forget() {},
  async usage() { return { costUsd: 0 } },
  async entries() { return [] },
  async transcript() { return [] },
  setModelBook() {},
}

let resumeSetting = true
AgentManager.WAKE_GRACE_MS = 0
const make = () => new AgentManager({
  store: store as never,
  worktrees: new WorktreeService(root),
  board: DEFAULT_BOARD,
  defaults: { runtime: 'claude' },
  permissionMode: 'acceptEdits',
  maxConcurrent: 8,
  resumeAfterLimit: () => resumeSetting,
})
const mgr = make()
const until = (cond: () => boolean, ms = 8000) => (async () => {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await sleep(50)
  return cond()
})()

// --- 1. a run hits the limit --------------------------------------------------
const nowS = Math.floor(Date.now() / 1000)
const resetS = nowS + 3
await mgr.start('Build the thing.')
const a = runs.at(-1)!
a.emit('sessionId', 'sess-A')
await sleep(50)
a.emit('limit', { status: 'allowed', rateLimitType: 'five_hour', resetsAt: resetS, unifiedWindows: { five_hour: { utilization: 0.97, resetsAt: resetS } } })
ok(mgr.limits.get('claude|')?.status === 'ok' && mgr.limits.get('claude|')!.windows[0]!.used === 0.97,
   'every turn\'s allowed frame is kept as the account\'s reading, with its windows')
a.emit('limit', { status: 'rejected', rateLimitType: 'five_hour', resetsAt: resetS })
a.emit('state', { kind: 'error', message: 'x' })
a.emit('error', `Claude AI usage limit reached|${resetS}`)
await sleep(100)
const parked = meta.get('sess-A')?.parked as ParkedRecord | undefined
ok(!!parked && parked.until === resetS * 1000 && parked.auto && parked.account === 'claude|' && parked.attempts === 0,
   `a run stopped by the limit is PARKED on its card, until the stated reset (${JSON.stringify(parked)})`)
ok(!!mgr.limits.limitedUntil('claude|', Date.now()), 'and the account is limited')
const liveA = mgr.list().find((x) => x.sessionId === 'sess-A')
ok(!!liveA?.live.some((e) => e.kind === 'notice' && /resumes this session at/.test((e as { message: string }).message)),
   'the card SAYS it is paused and when it resumes')

// --- 2. new work for that account is held; another account's is not ------------
const before = runs.length
const heldId = await mgr.start('A second task on the same account.')
const held = mgr.byKey(heldId)
ok(runs.length === before && held?.state.kind === 'queued', 'a new task on a limited account is HELD, not started into the limit')
ok(!!held?.live.some((e) => e.kind === 'notice' && /usage limit until/.test((e as { message: string }).message)),
   'and its card says what it is waiting for')
await mgr.start('A task on Codex.', { runtime: 'codex' })
ok(runs.length === before + 1 && runs.at(-1)!.prompt === 'A task on Codex.',
   'another account\'s task starts at once — one limited account holds up nobody else')

// --- 3. a first turn refused by the limit goes back in the queue ---------------
{
  const fresh = new AgentManager({ store: store as never, worktrees: new WorktreeService(root), board: DEFAULT_BOARD,
    defaults: { runtime: 'claude' }, permissionMode: 'acceptEdits', maxConcurrent: 8 })
  const n = runs.length
  await fresh.start('Brand new, and the account is already out.')
  const f = runs.at(-1)!
  f.emit('state', { kind: 'error', message: 'x' })
  f.emit('error', "You've hit your usage limit. Try again in 3 hours.")
  await sleep(100)
  const requeued = fresh.list().find((x) => x.title.startsWith('Brand new'))
  ok(runs.length === n + 1 && requeued?.state.kind === 'queued',
     `a first turn with no session to resume is re-queued and held, not lost as a red card (${requeued?.state.kind})`)
  fresh.stopAll()
}

// --- 4. the timer fires: held work starts, parked work resumes ----------------
const woke = await until(() => runs.some((r) => r.spec.resume === 'sess-A'))
ok(woke, 'when the account resets, the parked session is RESUMED by the board, with nobody pressing anything')
const resumed = runs.find((r) => r.spec.resume === 'sess-A')
ok(resumed?.prompt === RESUME_PROMPT, 'with a prompt that says why, and allows "it was already finished"')
ok(await until(() => runs.some((r) => r.prompt === 'A second task on the same account.')), 'and the held task started')
ok(!meta.get('sess-A')?.parked, 'the resume ended the park on the card')

// --- 5. resuming into the same limit is bounded -------------------------------
resumed!.emit('sessionId', 'sess-A')
resumed!.emit('state', { kind: 'error', message: 'x' })
resumed!.emit('error', '429 Too Many Requests')
await sleep(100)
const again = meta.get('sess-A')?.parked as ParkedRecord | undefined
ok(again?.attempts === 1 && again.estimated === true && again.auto,
   `hit again with no stated reset: parked again, attempt 1, time marked as an estimate (${JSON.stringify(again)})`)
meta.set('sess-A', { ...meta.get('sess-A'), parked: { ...again!, attempts: MAX_AUTO_RESUMES - 1, until: Date.now() - 1 } })
mgr.limits.lift('claude|', Date.now())
await mgr.resumeParked({ account: 'claude|' })
const third = runs.at(-1)!
ok(third.spec.resume === 'sess-A', 'the next automatic resume ran')
third.emit('sessionId', 'sess-A')
third.emit('state', { kind: 'error', message: 'x' })
third.emit('error', 'Claude AI usage limit reached')
await sleep(100)
const stopped = meta.get('sess-A')?.parked as ParkedRecord | undefined
ok(stopped?.attempts === MAX_AUTO_RESUMES && stopped.auto === false,
   `after ${MAX_AUTO_RESUMES} resumes straight into the limit, the board stops resuming by itself (${JSON.stringify(stopped)})`)
ok((await mgr.resumeParked({ account: 'claude|' })).length === 0, 'and a later wake leaves it alone')
const n5 = runs.length
ok((await mgr.resumeParked({ key: 'sess-A' }, true)).length === 1 && runs.length === n5 + 1, 'but Resume, pressed by the user, still works')

// --- 6. an answer ABOUT rate limits is ordinary work --------------------------
{
  const n = runs.length
  await mgr.start('Add rate limiting.', { runtime: 'codex' })
  const r = runs[n]!
  r.emit('sessionId', 'sess-rl')
  r.emit('state', { kind: 'done' })
  r.emit('done', 'I added a rate limit middleware: requests over quota now get 429 Too Many Requests.')
  await sleep(50)
  ok(!meta.get('sess-rl')?.parked, 'a finished answer that talks about rate limits is NOT parked')
}

// --- 7. the setting off: parked, but not resumed -------------------------------
{
  resumeSetting = false
  const n = runs.length
  await mgr.start('Off.', { runtime: 'codex' })
  const r = runs[n]!
  r.emit('sessionId', 'sess-off')
  r.emit('state', { kind: 'error', message: 'x' })
  r.emit('error', 'You have hit your usage limit. Try again in 2 hours.')
  await sleep(100)
  const p = meta.get('sess-off')?.parked as ParkedRecord | undefined
  ok(!!p && p.auto === false && p.account === 'codex|', 'with resumeAfterLimit off, the card is parked and says it will not resume by itself')
  resumeSetting = true
}

// --- 8. a restart re-arms every parked card ------------------------------------
{
  meta.set('sess-R', { parked: { until: Date.now() + 60 * 60_000, account: 'claude|dsk', reason: '5-hour limit reached', attempts: 0, auto: true } })
  const after = make()
  const n = await after.restoreParked()
  ok(n >= 1 && !!after.limits.limitedUntil('claude|dsk', Date.now()), 'after a restart the account is limited again from the sidecar, until the recorded time')
  const heldAfter = await after.start('Held after restart.', {
    providerFor: { profile: { id: 'dsk', kind: 'gateway', label: 'DeepSeek', baseUrl: 'https://x' }, env: { set: {}, clear: [] } },
  })
  ok(after.byKey(heldAfter)?.state.kind === 'queued', 'and new work for that account is held from the first moment')
  after.stopAll()
}

mgr.stopAll()
await fs.rm(root, { recursive: true, force: true })
if (fails) { console.log(`${fails} failure(s)`); process.exit(1) }
console.log('PASS — a limited account parks its cards and resumes them when it resets')
process.exit(0)
