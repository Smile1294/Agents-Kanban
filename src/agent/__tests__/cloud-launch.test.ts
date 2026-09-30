/* A cloud card through the REAL manager: `start()` -> `launch()` ->
 * `startRun()` against a real git repository, with a fake runtime in place of
 * Claude Code that records the `RunSpec` it is handed and answers the way
 * `CloudRun` does — an id, then where the session is, then done.
 *
 * What this pins is the part no runtime test can see: that "run it in the
 * cloud" survives the whole trip — the queue, the launch, the resume of a
 * follow-up — and that the card is told the truth about it. The traps are all
 * places where the ordinary local path would quietly win: a brief and board
 * tools the cloud cannot use, a fork anchor on a prompt whose transcript is
 * not on this machine, a model recorded that the cloud never ran, a follow-up
 * that "resumes" a cloud session as a LOCAL turn.
 */
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { registerRuntime, type AgentRuntime, type RunSpec } from '../runtime.ts'
import { AgentManager, parseSavedQueue } from '../manager.ts'
import { WorktreeService } from '../../git/worktree.ts'
import { DEFAULT_BOARD } from '../../board/config.ts'
import { mergeCloud, type CloudRecord, type CloudUpdate } from '../cloud.ts'

const sh = (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd })
let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }
const tick = () => new Promise((r) => setTimeout(r, 30))

const CLOUD_ID = 'session_01LaunchTest000001'
const specs: RunSpec[] = []
type Mode = 'created' | 'delivered' | 'failed' | 'streamed'
const runs: Array<EventEmitter & { finish: (mode: Mode, id?: string) => void }> = []

/** A run that behaves like `CloudRun` when told to. */
const fakeRun = (spec: RunSpec) => {
  const e = new EventEmitter() as EventEmitter & { finish: (mode: Mode, id?: string) => void }
  e.on('error', () => {})
  runs.push(e)
  Object.assign(e, {
    taskId: spec.taskId, runtime: 'claude',
    run() { return new Promise(() => {}) },
    send() {}, stop() {}, clearQueue() { return 0 },
    interrupt() { return Promise.resolve() },
    get state() { return { kind: 'working' } },
    get lastEvent() { return Date.now() }, get sessionId() { return undefined },
    get meter() { return { kind: 'unknown' } },
    answerPermission() { return false }, setPermissionMode() { return Promise.resolve(false) },
  })
  e.finish = (mode, id = CLOUD_ID) => {
    if (mode === 'failed') { e.emit('error', 'Error: Unable to get organization UUID'); return }
    if (mode === 'streamed') {
      // CONNECTED: the CLI streamed the session here, the way a local run is.
      if (!spec.cloud?.id) e.emit('sessionId', id)
      e.emit('cloud', { id, url: `https://claude.ai/code/${id}`, via: 'live' } satisfies CloudUpdate)
      e.emit('text', `Answer to: ${spec.cloud?.id ? 'the follow-up' : 'the task'}`)
      e.emit('done', 'ok', { kind: 'unknown' })
      return
    }
    const url = `https://claude.ai/code/${CLOUD_ID}?from=cli&m=0`
    if (mode === 'created') e.emit('sessionId', CLOUD_ID)
    e.emit('cloud', { id: CLOUD_ID, url, via: 'detached', title: spec.cloud?.title, sent: { at: Date.now(), text: 'x', ok: true } } satisfies CloudUpdate)
    e.emit('done', 'Created on Anthropic\'s cloud.', { kind: 'unknown' })
  }
  return e
}
const runtime = (id: 'claude' | 'codex', cloud: boolean): AgentRuntime => ({
  id, label: id === 'claude' ? 'Claude Code' : 'Codex', vendor: 'test', blurb: '', installHint: 'n/a',
  capabilities: {
    providerProfiles: id === 'claude', boardTools: 'stdio', thinkingToggle: true, messageIds: true,
    ...(cloud ? { cloud: true } : {}),
  },
  async detect() { return { command: '/bin/true' } },
  async login() { return { kind: 'signedIn' as const, via: 'subscription' as const } },
  async models() { return { models: [], source: 'builtin' as const } },
  builtinModels() { return [{ id: 'm', label: 'm' }] },
  start(spec: RunSpec) { specs.push(spec); return fakeRun(spec) },
} as unknown as AgentRuntime)
registerRuntime(runtime('claude', true))
registerRuntime(runtime('codex', false))

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-launch-'))
await sh(root, 'init', '-q', '-b', 'main')
await sh(root, 'config', 'user.email', 't@example.com')
await sh(root, 'config', 'user.name', 'T')
await fs.writeFile(path.join(root, 'README.md'), '# r\n')
await sh(root, 'add', '-A')
await sh(root, 'commit', '-qm', 'init')

// The store, in memory, with the calls the manager makes on a cloud card.
const meta = new Map<string, Record<string, unknown>>()
const renamed: string[] = []
const store = {
  async card(key: string) { return { phase: 'planning', tags: [], ...(meta.get(key) ?? {}) } },
  async childrenOf() { return [] },
  async get(key: string) { const m = meta.get(key); return m ? { id: key, title: 'T', ...m } : undefined },
  async patch(key: string, p: Record<string, unknown>) { meta.set(key, { ...(meta.get(key) ?? {}), ...p }) },
  async recordCloud(key: string, u: CloudUpdate) {
    const prev = meta.get(key)?.cloud as CloudRecord | undefined
    meta.set(key, { ...(meta.get(key) ?? {}), cloud: mergeCloud(prev, u) })
  },
  async rename(id: string) { renamed.push(id); return { renamed: true } },
  async adoptKey(from: string, to: string) {
    if (from === to || !meta.has(from)) return
    meta.set(to, { ...meta.get(from), ...(meta.get(to) ?? {}) })
    meta.delete(from)
  },
  async usage() { return { costUsd: 0 } },
  async transcript() { return [] },
  // Nothing of these sessions is under ~/.claude/projects: the record is all.
  async cloudOnly(key: string) { return meta.get(key)?.cloud as CloudRecord | undefined },
  async forget(key: string) { meta.delete(key) },
  setModelBook() {},
}
const warnings: string[] = []
const mgr = new AgentManager({
  store: store as never,
  worktrees: new WorktreeService(root),
  board: DEFAULT_BOARD,
  defaults: { model: 'claude-opus-5', effort: 'high', runtime: 'claude' },
  permissionMode: 'acceptEdits',
  maxConcurrent: 4,
})
mgr.on('warning', (w: string) => warnings.push(w))

console.log('\n— a new session, asked for in the cloud')
const runId = await mgr.start('Fix the flaky auth test', { cloud: true })
await tick()
const spec = specs[0]!
ok(!!spec.cloud, 'the runtime is handed a cloud target')
ok(spec.cloud?.id === undefined && spec.cloud?.title === 'Fix the flaky auth test', 'to CREATE one, named after the card')
ok(spec.appendSystemPrompt === undefined, 'with no brief — it would tell the cloud agent to call tools it cannot reach')
ok(spec.boardTools === undefined, 'and no board tools')
ok(!!spec.cwd && spec.cwd.includes('.agentskanban'), 'from a worktree of its own: that is what gets uploaded')
const card = mgr.byKey(runId)!
ok(!!card.cloud && !card.cloud.id, 'the card says "cloud" from the first moment, before there is an id')
ok(card.live[0]?.kind === 'prompt' && !(card.live[0] as { id?: string }).id,
  'the first prompt carries no fork anchor — its transcript is not on this machine')

runs[0]!.finish('created')
await tick()
const done = mgr.byKey(CLOUD_ID)
ok(!!done, 'the card follows the cloud session id')
ok(done?.cloud?.id === CLOUD_ID && done?.cloud?.via === 'detached', 'and knows where it is and how it is attached')
const stored = meta.get(CLOUD_ID)!
ok((stored.cloud as CloudRecord | undefined)?.id === CLOUD_ID, 'the sidecar keeps the record, under the id')
ok(stored.phase === 'implementing' && stored.runtime === 'claude', 'the card is registered like any other started session')
ok(stored.model === undefined && stored.effort === undefined, 'but records no model: the cloud runs whatever its environment picks')
ok(!renamed.includes(CLOUD_ID), 'and Claude Code is not asked to rename a session file that does not exist here')
ok(stored.running === 0, 'and it is not left marked running — nothing is running HERE')

console.log('\n— a follow-up to it')
await mgr.send(CLOUD_ID, 'also update the changelog')
await tick()
const follow = specs[1]
ok(!!follow, 'a new run is started for it')
ok(follow?.cloud?.id === CLOUD_ID, 'aimed at THAT cloud session — never a local resume of its id')
ok(follow?.resume === CLOUD_ID, 'as a resume of the card')
runs[1]!.finish('delivered')
await tick()
ok(((meta.get(CLOUD_ID)!.cloud as CloudRecord).log.length) === 2, 'and the delivery is on the record')

console.log('\n— asked for the cloud on an agent that cannot go there')
const before = specs.length
const codexRun = await mgr.start('x', { cloud: true, runtime: 'codex' })
await tick()
ok(specs.length === before, 'it is not started at all — running it here instead is the one thing that was not asked for')
const refused = mgr.byKey(codexRun)
ok(refused?.state.kind === 'error' && /cannot run a session in the cloud/.test((refused.state as { message: string }).message),
  'and the card says why')

console.log('\n— a cloud card that never got a session')
const lostId = await mgr.start('y', { cloud: true })
await tick()
runs[runs.length - 1]!.finish('failed')
await tick()
const n = specs.length
await mgr.send(lostId, 'hello?')
await tick()
ok(specs.length === n, 'a message to it starts nothing')
ok(warnings.some((w) => /never reached the cloud/.test(w)), 'and says there is no session to send it to')

console.log('\n— a CONNECTED session: what the chat showed survives its follow-up')
{
  const LIVE_ID = 'session_01LaunchLive0000001'
  const first = await mgr.start('Streamed task', { cloud: true })
  await tick()
  runs[runs.length - 1]!.finish('streamed', LIVE_ID)
  await tick()
  const ended = mgr.byKey(LIVE_ID)
  ok(ended?.cloud?.via === 'live', 'the card knows it was streamed here')
  ok(!!ended && ended.live.some((e) => e.kind === 'text' && /the task/.test(e.text)), 'and holds the reply it streamed')
  ok(first !== LIVE_ID, 'under the id the session announced')

  await mgr.send(LIVE_ID, 'and the follow-up')
  await tick()
  const again = mgr.byKey(LIVE_ID)
  const shown = [...(again?.history ?? []), ...(again?.live ?? [])]
  ok(specs[specs.length - 1]?.cloud?.id === LIVE_ID, 'the follow-up continues that cloud session')
  ok(shown.some((e) => e.kind === 'text' && /the task/.test(e.text)),
    'and still shows the FIRST reply — the only copy of it on this machine is what the board saw')
  ok(shown.filter((e) => e.kind === 'prompt').length === 2, 'with both prompts, once each')
  runs[runs.length - 1]!.finish('streamed', LIVE_ID)
  await tick()
}

console.log('\n— the queue across a restart')
{
  const back = parseSavedQueue([{ prompt: 'p', queuedAt: 1, cloud: true }, { prompt: 'q', queuedAt: 2, cloud: 'yes' }])
  ok(back[0]?.cloud === true, 'a queued cloud run is still a cloud run after a restart')
  ok(back[1]?.cloud === undefined, 'and only `true` means it — parsed, not cast')
}

mgr.stopAll()
await fs.rm(root, { recursive: true, force: true })
console.log(fails ? `\ncloud-launch: ${fails} FAILED` : '\ncloud-launch: all ok')
process.exit(fails ? 1 : 0)
