/* Does the resolved route actually REACH the runtime?
 *
 * The unit tests stub `AgentManager.start`, so they prove `split()` computes the
 * right route and hands it over — and nothing more. This drives the REAL
 * manager, the real `start()` -> `launch()` -> `startRun()` chain, a real git
 * repo and a real WorktreeService, with a fake runtime registered in place of
 * Claude Code that records the `RunSpec` it is handed.
 *
 * That is the seam every "it didn't even work in the editor" bug in this project
 * has lived in, and it is the one `launch()` broke: it recomputed `chosen` from
 * `this.opts.defaults` and overwrote whatever the caller passed.
 */
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sh = (cwd: string, ...args: string[]) => run('git', args, { cwd })

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

import { registerRuntime, type AgentRuntime, type RunSpec } from '../runtime.ts'
import { AgentManager } from '../manager.ts'
import { WorktreeService } from '../../git/worktree.ts'
import { DEFAULT_BOARD } from '../../board/config.ts'
import type { SpawnCatalogue } from '../routing.ts'
import type { ProviderEnv, ProviderProfile } from '../providers.ts'

// --- the fake runtimes -------------------------------------------------------
const specs: RunSpec[] = []
const fakeRun = () => {
  const e = new EventEmitter()
  Object.assign(e, {
    send() {}, stop() {}, interrupt() {}, get state() { return { kind: 'working' } },
    get lastEvent() { return Date.now() }, get sessionId() { return undefined },
    respondPermission() {}, dispose() {},
  })
  return e
}
/* `stdio` board tools with no `boardBridge` configured, so `boardToolsFor()`
   warns and returns undefined rather than building a real MCP server — this
   test is about the ROUTE reaching the runtime, and loading the SDK to prove
   that would be a second thing to go wrong. One cast, at the boundary: the
   stub answers the parts of the contract `launch()` actually calls. */
const descriptor = (id: 'claude' | 'codex', providerProfiles: boolean): AgentRuntime => ({
  id, label: id, vendor: 'test', blurb: '', installHint: 'n/a',
  capabilities: { providerProfiles, boardTools: 'stdio', thinkingToggle: providerProfiles },
  async detect() { return { command: '/bin/true' } },
  async login() { return { kind: 'signedIn' as const } },
  async models() { return { models: [] } },
  builtinModels() { return [{ id: `${id}-builtin`, label: 'builtin' }] },
  start(spec: RunSpec) { specs.push(spec); return fakeRun() },
} as unknown as AgentRuntime)
registerRuntime(descriptor('claude', true))
registerRuntime(descriptor('codex', false))

// --- a real repo -------------------------------------------------------------
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'route-e2e-'))
await sh(root, 'init', '-q', '-b', 'main')
await sh(root, 'config', 'user.email', 'test@example.com')
await sh(root, 'config', 'user.name', 'Test')
await fs.writeFile(path.join(root, 'README.md'), '# repo\n')
await sh(root, 'add', '-A')
await sh(root, 'commit', '-qm', 'init')

// --- an in-memory store with the shape the manager uses ----------------------
const meta = new Map<string, Record<string, unknown>>()
const store = {
  async card(key: string) { return { phase: 'planning', tags: [], ...(meta.get(key) ?? {}) } },
  async childrenOf() { return [] },
  async setTags() {},
  async get(key: string) { return meta.get(key) },
  async patch(key: string, patch: Record<string, unknown>) { meta.set(key, { ...(meta.get(key) ?? {}), ...patch }) },
  async rename() { return { renamed: true } },
  async adoptKey() {},
  async usage() { return { costUsd: 0 } },
  async entries() { return [] },
  async transcript() { return [] },
  setModelBook() {},
}

const catalogue: SpawnCatalogue = {
  agents: [
    {
      slug: 'anthropic', key: 'claude|first-party', label: 'Anthropic',
      runtime: 'claude' as const, provider: 'first-party', known: true,
      models: [{ id: 'claude-fable-5-1', efforts: ['high', 'max'] },
               { id: 'claude-opus-5', efforts: ['high', 'max'] }],
    },
    {
      slug: 'deepseek', key: 'claude|dsk', label: 'DeepSeek',
      runtime: 'claude' as const, provider: 'dsk', known: true,
      models: [{ id: 'deepseek-reasoner', efforts: [] }],
    },
    {
      slug: 'codex', key: 'codex|', label: 'Codex',
      runtime: 'codex' as const, provider: '', known: true,
      models: [{ id: 'gpt-5.5-codex', efforts: ['high'] }],
    },
  ],
}

const profiles: Record<string, ProviderProfile> = {
  'first-party': { id: 'first-party', kind: 'anthropic', label: 'Anthropic' },
  dsk: { id: 'dsk', kind: 'gateway', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic' },
}

const mgr = new AgentManager({
  store: store as never,
  worktrees: new WorktreeService(root),
  board: DEFAULT_BOARD,
  // The PARENT is on Fable 5.1, first-party. Exactly the asked-for setup.
  defaults: { model: 'claude-fable-5-1', effort: 'max', runtime: 'claude', orchestration: 'maximum' },
  permissionMode: 'acceptEdits',
  maxConcurrent: 8,
  provider: profiles['first-party'],
  providerEnv: { set: { ANTHROPIC_API_KEY: 'fp' }, clear: ['ANTHROPIC_BASE_URL'] },
  spawnCatalogue: () => catalogue,
  resolveProvider: async (id: string) => {
    const profile = profiles[id]
    if (!profile) return undefined
    const env: ProviderEnv = id === 'dsk'
      ? {
          set: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'ds' },
          clear: ['ANTHROPIC_API_KEY'],
        }
      : { set: { ANTHROPIC_API_KEY: 'fp' }, clear: ['ANTHROPIC_BASE_URL'] }
    return { profile, env }
  },
  confirmSplit: async () => true,
})

// --- the parent -------------------------------------------------------------
const parentId = await mgr.start('Build three unrelated things.')
const parentSpec = specs.find((s) => s.taskId === parentId)
ok(!!parentSpec, 'the parent actually started through the real launch path')
ok(parentSpec?.model === 'claude-fable-5-1', `the parent is on the composer model (${parentSpec?.model})`)
ok(parentSpec?.provider?.id === 'first-party', `and on the active backend (${parentSpec?.provider?.id})`)
ok(parentSpec?.env?.ANTHROPIC_API_KEY === 'fp', 'with that backend\'s environment on the child process')

const parent = mgr.byKey(parentId)
ok(parent?.provider === 'first-party',
   `the live card records WHICH BACKEND it is on, which is what split() reads (${parent?.provider})`)

// --- the fan-out ------------------------------------------------------------
specs.length = 0
const result = await mgr.split(parentId, [
  { title: 'Hard bit', prompt: 'Do the hard bit.', scope: ['src/hard/'],
    agent: 'anthropic', model: 'claude-opus-5', effort: 'max' },
  { title: 'Cheap bit', prompt: 'Do the mechanical bit.', scope: ['src/cheap/'],
    agent: 'deepseek', model: 'deepseek-reasoner' },
  { title: 'Other agent', prompt: 'Do the third bit.', scope: ['src/third/'],
    agent: 'codex', model: 'gpt-5.5-codex', effort: 'high' },
  { title: 'Same as me', prompt: 'Do the fourth bit.', scope: ['src/fourth/'] },
], 'Four unrelated jobs.')

ok(result.ok === true, `the four-way routed split ran (${result.ok ? 'yes' : result.message})`)
ok(specs.length === 4, `four children reached a runtime (${specs.length})`)

const byTitle = (t: string) => specs.find((s) => (s.appendSystemPrompt ?? '').includes(t))

const hard = byTitle('Hard bit')
ok(hard?.model === 'claude-opus-5', `the hard piece runs on Opus 5 (${hard?.model})`)
ok(hard?.provider?.id === 'first-party', `on first-party (${hard?.provider?.id})`)
ok(hard?.effort === 'max', `at the effort it asked for (${hard?.effort})`)

const cheap = byTitle('Cheap bit')
ok(cheap?.model === 'deepseek-reasoner', `the cheap piece runs on DeepSeek's model (${cheap?.model})`)
ok(cheap?.provider?.id === 'dsk', `on the DeepSeek backend (${cheap?.provider?.id})`)
ok(cheap?.env?.ANTHROPIC_BASE_URL === 'https://api.deepseek.com/anthropic',
   `with DeepSeek's base URL on its process (${cheap?.env?.ANTHROPIC_BASE_URL})`)
ok(cheap?.env?.ANTHROPIC_AUTH_TOKEN === 'ds', 'and DeepSeek\'s bearer credential')
ok((cheap?.envClear ?? []).includes('ANTHROPIC_API_KEY'),
   `and the first-party key CLEARED, not layered under it (${JSON.stringify(cheap?.envClear)})`)

const third = byTitle('Other agent')
ok(third?.model === 'gpt-5.5-codex', `the third piece runs on Codex's model (${third?.model})`)
ok(third?.provider === undefined,
   'and carries no backend profile — that runtime signs in as itself')
ok(third?.thinking === undefined, 'nor a thinking option it has no meaning for')

const same = byTitle('Same as me')
ok(same?.provider?.id === 'first-party',
   `a piece that named nothing inherits the parent's BACKEND (${same?.provider?.id})`)
ok(same?.model === 'claude-fable-5-1',
   `and the model the launch resolves, as before (${same?.model})`)

// Three different runtimes/backends, one board, at once.
ok(new Set(specs.map((s) => s.provider?.id ?? 'none')).size === 3,
   'three different backends are live off ONE objective at once: ' +
   `${[...new Set(specs.map((s) => s.provider?.id ?? 'none'))].join(', ')} ` +
   "(where 'none' is the runtime that signs in as itself)")

// --- the refusals reach the real path too -----------------------------------
specs.length = 0
meta.set(parentId, { ...(meta.get(parentId) ?? {}) })
const refused = await mgr.split(parentId, [
  { title: 'A', prompt: 'a', scope: ['src/a/'], agent: 'deepseek', model: 'claude-opus-5' },
  { title: 'B', prompt: 'b', scope: ['src/b/'] },
], 'nope')
ok(refused.ok === false, 'a model the named backend does not serve is refused end to end')
ok(specs.length === 0, `and nothing started (${specs.length})`)
const recorded = (): string | undefined =>
  (meta.get(parentId)?.decomposition as { rule?: string } | undefined)?.rule
ok(recorded() === 'spawn-model',
   `and the refusal is on the parent's card (${recorded()})`)

mgr.stopAll()
await fs.rm(root, { recursive: true, force: true })
console.log(fails ? `\n${fails} FAILED` : '\nall ok — the route reaches the runtime')
process.exit(fails ? 1 : 0)
