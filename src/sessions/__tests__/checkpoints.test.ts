/**
 * Checkpoint markers and host-side file restore.
 *
 * These were verified against a real CLI rollout before being written (see
 * docs/DECISIONS.md): markers are `file-history-snapshot` JSONL entries at
 * each user message, backups are whole-file copies under
 * `file-history/<sessionId>/<hash>@v<N>`, and the CLI's own `rewindFiles`
 * restores the state the marker at the anchor message describes. The restore
 * here is the same copy, done host-side so it needs no held-open CLI query.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  applyRestore,
  checkpointMapFor,
  claudeHome,
  historyDirFor,
  planRestore,
  sessionFileFor,
  waitForQuiescent,
} from '../checkpoints.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

function marker(messageId: string, files: Record<string, unknown>, update = false): string {
  return JSON.stringify({
    type: 'file-history-snapshot',
    messageId,
    snapshot: { messageId, trackedFileBackups: files, timestamp: '2026-09-06T00:00:00.000Z' },
    isSnapshotUpdate: update,
  })
}

const LINES = [
  JSON.stringify({ type: 'user', uuid: '00000000-0000-0000-0000-000000000001' }),
  marker('00000000-0000-0000-0000-000000000001', { 'g.txt': { backupFileName: 'aaaa@v1', realParentDir: '/wt' } }),
  marker('00000000-0000-0000-0000-000000000002', { 'g.txt': { backupFileName: 'aaaa@v2', realParentDir: '/wt' } }),
  // A later update of message 1's snapshot must win over the earlier one.
  marker('00000000-0000-0000-0000-000000000001', { 'g.txt': { backupFileName: 'aaaa@v3', realParentDir: '/wt' } }, true),
  JSON.stringify({ type: 'user', uuid: '00000000-0000-0000-0000-000000000003' }),
]

// --- checkpointMapFor -------------------------------------------------------

{
  const m = checkpointMapFor(LINES, '00000000-0000-0000-0000-000000000001')
  ok(m?.['g.txt']?.backupFileName === 'aaaa@v3', 'last marker for a messageId wins')
}
{
  const m = checkpointMapFor(LINES, '00000000-0000-0000-0000-000000000003')
  ok(m === undefined, 'message with no marker yields undefined, not empty')
}
{
  const m = checkpointMapFor(LINES, '00000000-0000-0000-0000-000000000099')
  ok(m === undefined, 'unknown messageId yields undefined')
}
{
  const m = checkpointMapFor(['not json', '{}', marker('m1', {})], 'm1')
  ok(m !== undefined && Object.keys(m).length === 0, 'empty tracked set is a real (empty) map')
}
{
  // A marker whose tracked entry is malformed must not break the others.
  const lines = [marker('m1', { a: { backupFileName: 'x@v1', realParentDir: '/wt' }, b: 'nope', c: null })]
  const m = checkpointMapFor(lines, 'm1')
  ok(Object.keys(m ?? {}).length === 1, 'malformed entries are dropped, the rest kept')
}

// --- claudeHome -------------------------------------------------------------

{
  ok(claudeHome({ CLAUDE_CONFIG_DIR: '/cfg' }) === '/cfg', 'CLAUDE_CONFIG_DIR wins')
  ok(claudeHome({ HOME: '/h' }) === path.join('/h', '.claude'), 'falls back to ~/.claude')
  ok(claudeHome({ CLAUDE_CONFIG_DIR: '  ', HOME: '/h' }) === path.join('/h', '.claude'), 'blank override is ignored')
}

// --- sessionFileFor ---------------------------------------------------------

{
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-home-'))
  const projects = path.join(home, 'projects')
  await fs.mkdir(path.join(projects, '-some-worktree'), { recursive: true })
  await fs.writeFile(
    path.join(projects, '-some-worktree', 'aaaa-bbbb-cccc.jsonl'),
    '{"type":"user"}\n',
  )
  const hit = await sessionFileFor(home, 'aaaa-bbbb-cccc')
  ok(hit?.dir === path.join(projects, '-some-worktree'), 'session file found one dir under projects')
  ok(hit?.file === path.join(projects, '-some-worktree', 'aaaa-bbbb-cccc.jsonl'), 'session file path is exact')
  ok((await sessionFileFor(home, 'dead-beef')) === undefined, 'unknown session yields undefined')
  ok((await sessionFileFor(home + '-missing', 'aaaa-bbbb-cccc')) === undefined, 'no projects dir yields undefined')
  ok(historyDirFor(home, 'aaaa-bbbb-cccc') === path.join(home, 'file-history', 'aaaa-bbbb-cccc'),
    'history dir sits beside projects')
  await fs.rm(home, { recursive: true, force: true })
}

// --- planRestore ------------------------------------------------------------

{
  const map: Record<string, { backupFileName: string; realParentDir: string }> = {
    'g.txt': { backupFileName: 'aaaa@v1', realParentDir: '/wt' },
    'nested/deep.txt': { backupFileName: 'bbbb@v1', realParentDir: '/wt' },
    'escape.txt': { backupFileName: 'cccc@v1', realParentDir: '/other' },      // wrong dir
    '../up.txt': { backupFileName: 'dddd@v1', realParentDir: '/wt' },           // traversal
    'slash.txt': { backupFileName: 'aa/bb@v1', realParentDir: '/wt' },          // not a basename
  }
  const { copies, skipped } = planRestore('/wt', '/hist', map)
  ok(copies.length === 2, 'only in-worktree, same-dir files are copied')
  ok(skipped.length === 3, 'three refusals reported with reasons')
  ok(copies.some((c) => c.rel === 'nested/deep.txt' && c.from === path.join('/hist', 'bbbb@v1')),
    'nested path maps to its backup in the history dir')
  ok(skipped.some((s) => s.rel === 'escape.txt' && s.reason.includes('different directory')),
    'a marker from another checkout is refused, not copied')
}

// --- applyRestore -----------------------------------------------------------

{
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-restore-'))
  const wt = path.join(base, 'wt')
  const hist = path.join(base, 'hist')
  await fs.mkdir(path.join(wt, 'nested'), { recursive: true })
  await fs.mkdir(hist)
  // The discarded state on disk (would be the abandoned attempt's edits).
  await fs.writeFile(path.join(wt, 'g.txt'), 'discarded')
  await fs.writeFile(path.join(wt, 'nested', 'deep.txt'), 'discarded deep')
  // The checkpoints to restore.
  await fs.writeFile(path.join(hist, 'aaaa@v1'), 'original')
  await fs.writeFile(path.join(hist, 'bbbb@v1'), 'original deep')
  // A symlinked destination must be refused, not written through.
  await fs.symlink(path.join(base, 'elsewhere.txt'), path.join(wt, 'link.txt'))
  const { copies, skipped } = planRestore(wt, hist, {
    'g.txt': { backupFileName: 'aaaa@v1', realParentDir: wt },
    'nested/deep.txt': { backupFileName: 'bbbb@v1', realParentDir: wt },
    'link.txt': { backupFileName: 'aaaa@v1', realParentDir: wt },
    'missing.txt': { backupFileName: 'gone@v1', realParentDir: wt },
  })
  ok(skipped.length === 0, 'planner accepts all four')
  const { restored, failed } = await applyRestore(copies)
  ok(restored.length === 2, 'two files restored')
  ok(failed.length === 2, 'symlink target and missing backup reported, not thrown')
  ok(failed.some((f) => f.rel === 'link.txt' && f.reason.includes('symlink')), 'symlink refusal has its reason')
  ok(await fs.readFile(path.join(wt, 'g.txt'), 'utf8') === 'original', 'g.txt read back as the checkpoint')
  ok(await fs.readFile(path.join(wt, 'nested', 'deep.txt'), 'utf8') === 'original deep',
    'nested file restored through its parents')
  ok((await fs.readFile(path.join(base, 'elsewhere.txt'), 'utf8').catch(() => 'no')) === 'no',
    'nothing was written through the symlink')
  await fs.rm(base, { recursive: true, force: true })
}

// --- waitForQuiescent --------------------------------------------------------
// This function had no test and its one bug was invisible because of it: a
// plain `stat()` has no `mtimeNs`, so two reads of a still-moving file both
// returned `undefined` and the file was called quiescent while it was still
// being written — the fork would then copy a torn transcript. These two tests
// exercise both arms against real writes.

{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-quiesce-'))
  const file = path.join(dir, 'moving.jsonl')
  await fs.writeFile(file, '0\n')
  let stop = false
  let n = 0
  const writer = (async () => {
    while (!stop) {
      await fs.writeFile(file, `${++n}\n`)
      await new Promise((r) => setTimeout(r, 25))
    }
  })()
  // Written every ~25ms against 250ms sampling: any two samples 250ms apart
  // must differ, so the 600ms window cannot declare quiescence.
  const moving = await waitForQuiescent(file, 600)
  ok(moving === false, 'a file still being written is not quiescent')
  stop = true
  await writer
  // Now it is stable: two consecutive reads agree, so it settles quickly.
  const settled = await waitForQuiescent(file, 3000)
  ok(settled === true, 'a file that stopped changing is quiescent')
  await fs.rm(dir, { recursive: true, force: true })
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('checkpoints: all ok')
