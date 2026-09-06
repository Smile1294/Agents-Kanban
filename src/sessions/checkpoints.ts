/**
 * File checkpoints, read host-side.
 *
 * Claude Code's `enableFileCheckpointing` writes, before every user message of
 * a session, a `file-history-snapshot` entry into the session's JSONL and a
 * full copy of each tracked file into `~/.claude/file-history/<sessionId>/`.
 * The snapshot at message M is the answer to "what did the files look like
 * when I sent M?" — which is exactly the state a "try again from here" must
 * put the worktree back into.
 *
 * Two facts about the format are load-bearing, and neither is in the SDK:
 *
 *  - `getSessionMessages()` projects the transcript down to
 *    `user | assistant | system`, so the snapshot entries are INVISIBLE to
 *    it. The board reads the raw JSONL for this one question — and only for
 *    this question. Nothing else here re-implements the transcript parse.
 *  - A fork (`forkSession`) re-writes the kept history WITHOUT the snapshot
 *    entries, so a forked card can rewind any of ITS OWN turns but not the
 *    ones it inherited. That is the correct boundary anyway: the fork point
 *    is the new time zero.
 *
 * Restore is a plain copy of backup files over the worktree paths, mirroring
 * the CLI's own `rewindFiles` semantics (which needs a live held-open query —
 * this does not, which is why the board can offer it offline and test it
 * hermetically). A file the discarded turns CREATED is not in the snapshot
 * map and is left alone, exactly as the CLI leaves it.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/** Where Claude Code keeps its sessions, honouring `CLAUDE_CONFIG_DIR`.
 *  Same shape as `codexHome()` in codex-store.ts: not a constant, because the
 *  launch gate seeds a throwaway config dir so it does not read the machine's
 *  real sessions. */
export function claudeHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CONFIG_DIR?.trim()) return env.CLAUDE_CONFIG_DIR.trim()
  const home = env.HOME || env.USERPROFILE || ''
  return path.join(home, '.claude')
}

/**
 * The session file for a session id, wherever it lives.
 *
 * The board's own sessions run with cwd set to their WORKTREE, so their
 * transcripts sit under `~/.claude/projects/<sanitized-worktree>/<id>.jsonl`.
 * The sanitizer is Claude Code's and has drifted before (truncation plus a
 * hash for long paths), so the file is found by scanning the projects
 * directory for the id instead of re-deriving the name — a session id is
 * globally unique, which makes the scan exact rather than a guess.
 */
export async function sessionFileFor(
  home: string,
  sessionId: string,
): Promise<{ dir: string; file: string } | undefined> {
  const projects = path.join(home, 'projects')
  const wanted = `${sessionId}.jsonl`
  // One directory deep: Claude Code files sessions as
  // `projects/<sanitized-cwd>/<id>.jsonl`, and the board's own sessions run
  // with cwd set to their WORKTREE, so the dir is the worktree's sanitized
  // path. Scan rather than re-derive the sanitizer — it has truncated and
  // hashed long paths before, and the id is unique enough to make the scan
  // exact. A few dozen existence checks on a user-initiated action are
  // nothing; this is never on the render path.
  let names: string[]
  try {
    names = await fs.readdir(projects)
  } catch {
    return undefined
  }
  for (const name of names) {
    const dir = path.join(projects, name)
    const file = path.join(dir, wanted)
    try {
      await fs.access(file)
    } catch {
      continue
    }
    return { dir, file }
  }
  return undefined
}

/** The backup file for a session: `~/.claude/file-history/<sessionId>/`. */
export function historyDirFor(home: string, sessionId: string): string {
  return path.join(home, 'file-history', sessionId)
}

/**
 * Wait until a file has stopped changing — the moment a killed CLI can no
 * longer tear the transcript a fork is about to copy.
 *
 * `stop()` kills the run synchronously, but the child process takes a moment
 * to die and can flush a frame or two on the way out. A fork started inside
 * that window reads a half-written file. Two stats 250ms apart that agree
 * mean the writer is gone; anything else is still in motion.
 */
export async function waitForQuiescent(file: string, timeoutMs = 8000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  let last: bigint | undefined
  while (Date.now() < deadline) {
    // bigint, not the default: a plain `stat()` has no `mtimeNs`, so reading it
    // would have compared two `undefined`s and called a still-moving file
    // quiescent. `mtimeMs` would do, but ns granularity distinguishes two
    // writes that land within the same millisecond.
    const st = await fs.stat(file, { bigint: true }).catch(() => undefined)
    const now = st ? st.mtimeNs : undefined
    if (last !== undefined && now === last) return true
    last = now
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

export interface SnapshotFile {
  /** Basename in the history dir, e.g. `ff92322340eb7ef5@v2`. */
  backupFileName: string
  /** The worktree the file was tracked in. Restores refuse to write anywhere
   *  else — a marker from another checkout is another program's state. */
  realParentDir: string
}

export type CheckpointMap = Record<string, SnapshotFile>

interface MarkerLine {
  messageId?: string
  snapshot?: { messageId?: string; trackedFileBackups?: Record<string, unknown> }
  isSnapshotUpdate?: boolean
}

/**
 * The checkpoint map for one user message: which tracked file held which
 * backup when that message was sent.
 *
 * Takes the LAST marker carrying that messageId — a snapshot may be re-issued
 * as an update (`isSnapshotUpdate`) when the file set changed between the
 * marker's first write and the turn actually starting, and the later one is
 * the state the agent saw. A `messageId` with no marker at all (a session run
 * before checkpoints existed) is `undefined`, and the caller must SAY so
 * rather than pretending the files can be rewound.
 */
export function checkpointMapFor(
  lines: readonly string[],
  messageId: string,
): CheckpointMap | undefined {
  let found: CheckpointMap | undefined
  for (const line of lines) {
    if (!line.includes('file-history-snapshot')) continue
    let o: MarkerLine
    try {
      o = JSON.parse(line) as MarkerLine
    } catch {
      continue
    }
    const id = o.messageId ?? o.snapshot?.messageId
    if (id !== messageId) continue
    const raw = o.snapshot?.trackedFileBackups
    if (!raw) { found = undefined; continue }
    const map: CheckpointMap = {}
    for (const [rel, v] of Object.entries(raw)) {
      const file = v as Partial<SnapshotFile> | undefined
      if (!file || typeof file.backupFileName !== 'string' || typeof file.realParentDir !== 'string') {
        continue
      }
      map[rel] = { backupFileName: file.backupFileName, realParentDir: file.realParentDir }
    }
    found = map
  }
  return found
}

/**
 * Decide which backups to copy where, and which to refuse.
 *
 * Pure, so the safety rules are one place and testable: a backup name must be
 * a bare basename (the CLI stores `<hash>@v<version>`), a tracked path must
 * resolve INSIDE the worktree, and a marker whose `realParentDir` is not the
 * worktree is another checkout's state and is refused, never copied.
 */
export function planRestore(
  worktreeDir: string,
  historyDir: string,
  map: CheckpointMap,
): { copies: { rel: string; from: string; to: string }[]; skipped: { rel: string; reason: string }[] } {
  const root = path.resolve(worktreeDir)
  const copies: { rel: string; from: string; to: string }[] = []
  const skipped: { rel: string; reason: string }[] = []
  for (const [rel, f] of Object.entries(map)) {
    if (!f.backupFileName || f.backupFileName.includes('/') || f.backupFileName.includes('\\') ||
        f.backupFileName === '.' || f.backupFileName === '..') {
      skipped.push({ rel, reason: 'not a backup file name' })
      continue
    }
    if (path.resolve(f.realParentDir) !== root) {
      skipped.push({ rel, reason: 'tracked in a different directory' })
      continue
    }
    if (path.isAbsolute(rel)) {
      skipped.push({ rel, reason: 'not a relative path' })
      continue
    }
    const to = path.resolve(root, rel)
    if (to !== root && !to.startsWith(root + path.sep)) {
      skipped.push({ rel, reason: 'escapes the worktree' })
      continue
    }
    copies.push({ rel, from: path.join(historyDir, f.backupFileName), to })
  }
  return { copies, skipped }
}

/** Copy the planned backups over the worktree. Never writes through a
 *  symlink, and reports each failure with its reason rather than stopping —
 *  a missing backup is a note on the card, not a reason to skip the rest. */
export async function applyRestore(
  copies: { rel: string; from: string; to: string }[],
): Promise<{ restored: string[]; failed: { rel: string; reason: string }[] }> {
  const restored: string[] = []
  const failed: { rel: string; reason: string }[] = []
  for (const c of copies) {
    try {
      const target = await fs.lstat(c.to).catch(() => undefined)
      if (target?.isSymbolicLink()) {
        failed.push({ rel: c.rel, reason: 'destination is a symlink' })
        continue
      }
      await fs.mkdir(path.dirname(c.to), { recursive: true })
      await fs.copyFile(c.from, c.to)
      restored.push(c.rel)
    } catch (e) {
      failed.push({ rel: c.rel, reason: e instanceof Error ? e.message : String(e) })
    }
  }
  return { restored, failed }
}
