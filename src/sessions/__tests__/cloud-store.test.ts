/* A card whose session is on Anthropic's cloud, and nowhere on this machine.
 *
 * A DETACHED cloud session leaves no transcript under `~/.claude/projects`, so
 * Claude Code's index never lists it — and the board's cards come from that
 * index. Without the sidecar pass in `list()` the card vanished the moment the
 * process that created it ended, which a window reload does to every one at
 * once. So this seeds NOTHING into the (throwaway) Claude store, writes one
 * cloud record the way the manager does, reads it back through a FRESH
 * MetaStore — persisted means read back, not written — and checks every
 * reader the board calls for a card: the list, the transcript, the meters,
 * rename and delete.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const claudeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-cloud-claude-'))
process.env.CLAUDE_CONFIG_DIR = claudeHome
await import('../../agent/runtimes/index.ts')
const { MetaStore } = await import('../meta.ts')
const { SessionStore } = await import('../store.ts')
const { cloudUrlFor } = await import('../../agent/cloud.ts')

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-cloud-meta-'))
const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ck-cloud-repo-')))
const ID = 'session_01StoreTest00000001'
const T1 = Date.now() + 1_000
const T2 = T1 + 60_000

try {
  const write = new SessionStore(repo, new MetaStore(dir, repo))
  await write.patch(ID, { phase: 'implementing', runtime: 'claude', worktree: path.join(repo, 'wt'), branch: 'task/x', running: 0 })
  await write.recordCloud(ID, {
    id: ID, url: `${cloudUrlFor(ID)}?from=cli&m=0`, via: 'detached', title: 'Fix the flaky auth test',
    sent: { at: T1, text: 'Fix the flaky auth test in auth.spec.ts', ok: true },
  })
  await write.recordCloud(ID, { id: ID, url: cloudUrlFor(ID), via: 'detached', sent: { at: T2, text: 'and the changelog', ok: false, error: 'archived' } })

  // A fresh store over the same files: what a restart sees.
  const store = new SessionStore(repo, new MetaStore(dir, repo))
  const list = await store.list()
  const card = list.find((s) => s.id === ID)
  ok(!!card, 'the card is listed with nothing of it on this machine')
  ok(card?.title === 'Fix the flaky auth test', 'under the title its record keeps')
  ok(card?.phase === 'implementing' && card?.runtime === 'claude', 'in its column, on its runtime')
  ok(card?.cloud?.id === ID && card?.cloud?.via === 'detached', 'carrying where it runs')
  ok(card?.updated === T2, 'dated by the last thing the board handed it — the only moment it can vouch for')
  ok(!!card?.worktree, 'with the worktree it was uploaded from')

  const t = await store.transcript(ID)
  ok(t[0]?.kind === 'prompt' && (t[0] as { text: string }).text.startsWith('Fix the flaky'), 'its transcript opens with the task')
  ok(t.some((e) => e.kind === 'notice' && /cannot read its replies/.test(e.message)), 'says where the replies are')
  ok(t.some((e) => e.kind === 'error' && /Not delivered/.test(e.message)), 'and shows the failed delivery as one')
  ok((await store.transcriptTotal(ID)) === t.length, 'the total agrees with the window, so "Load earlier" is not offered over nothing')
  ok((await store.fullTranscript(ID)).length === t.length, 'and search reads the same rows')

  const meter = await store.meter(ID)
  ok(meter.kind === 'unknown', `the meter is unknown, never $0.00 (${JSON.stringify(meter)})`)
  ok((await store.usage(ID)).contextTokens === 0, 'and no context is claimed')

  const r = await store.rename(ID, 'Auth test, fixed')
  ok(r.renamed === true, 'a rename succeeds without a session file to rename')
  ok((await store.list()).find((s) => s.id === ID)?.title === 'Auth test, fixed', 'and the card takes it')

  const d = await store.delete(ID)
  ok(d.deleted === true && /still on claude\.ai/.test(d.reason ?? ''), 'deleting removes the CARD and says the session itself is still on claude.ai')
  ok(!(await store.list()).some((s) => s.id === ID), 'and it is gone from the board')
  ok(!(await new MetaStore(dir, repo).getAll())[ID], 'and from the sidecar')
} finally {
  await fs.rm(claudeHome, { recursive: true, force: true })
  await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(repo, { recursive: true, force: true })
}

console.log(fails ? `\ncloud-store: ${fails} FAILED` : '\ncloud-store: all ok')
process.exit(fails ? 1 : 0)
