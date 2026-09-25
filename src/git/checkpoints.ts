/**
 * Whole-worktree checkpoints, in git, beside the branch rather than on it.
 *
 * "Try again from here" used to restore only what Claude Code's own file
 * history had backed up — the files an Edit/Write tool had touched BEFORE the
 * anchor message. A file first edited after the anchor kept the discarded
 * edits; a file the discarded turns created was kept; anything changed through
 * Bash (a codemod, `npm install`, a generated file) was never tracked at all.
 * The worktree came back half-rewound, which is worse than not rewinding: it
 * looks like the old state and is not.
 *
 * So the HOST takes its own snapshot before every message it sends, keyed by
 * the message's transcript id (`manager.ts` `messageIdFor` — the id the fork
 * cuts at), and a rewind makes the worktree match that snapshot EXACTLY for
 * every file git does not ignore: changed files put back, created files
 * removed, deleted files restored.
 *
 * Three rules, each load-bearing:
 *
 *  - **Nothing in the working tree, the index or the branch.** The snapshot is
 *    built in a TEMPORARY index (`GIT_INDEX_FILE`, seeded from the real one so
 *    it is fast), written as a tree, wrapped in a commit whose parent is HEAD,
 *    and pointed at by `refs/agentskanban/checkpoints/<ns>/<id>`. A ref is not
 *    a tracked file and dirties nothing, so `merge()`'s clean-tree check and
 *    the "nothing tracked in the user's repository" rule both still hold.
 *  - **Ignored files are not the worktree's.** `node_modules` and build output
 *    are neither snapshotted nor removed — `git add -A` honours `.gitignore`
 *    and `info/exclude`, and the removal list is computed from the same two
 *    trees, so an ignored file can never be on it.
 *  - **A rewind past a commit moves the branch back, and says so.** The
 *    checkpoint's parent is the HEAD the message was sent at. If the agent
 *    committed afterwards (the move into review commits), the branch is reset
 *    (`--mixed`: index to that HEAD, worktree untouched by the reset) so the
 *    card is genuinely back where it was; the commits stay reachable from the
 *    later checkpoints and the reflog, and the count is returned for the modal.
 *
 * Plain Node and git; tested against real repositories.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const CHECKPOINT_PREFIX = 'refs/agentskanban/checkpoints'

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], {
    cwd, maxBuffer: 64 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  return stdout
}

/** A ref-safe name segment. Git refuses `..`, spaces, `~^:?*[\` and more;
 *  a session's branch (`task/S1-fix`) and a uuid are what arrive here. */
export function refSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.-]+|[.-]+$/g, '').slice(0, 120) || 'x'
}

export function checkpointRef(ns: string, id: string): string {
  return `${CHECKPOINT_PREFIX}/${refSegment(ns)}/${refSegment(id)}`
}

/** The worktree's current files as a tree object, via a throwaway index. */
async function treeOfWorktree(dir: string): Promise<string> {
  const realIndex = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).trim()
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-cp-'))
  const index = path.join(tmp, 'index')
  try {
    // Seeded from the real index so `add -A` only hashes what changed — on a
    // big repository an empty index means hashing every file, every message.
    await fs.copyFile(realIndex, index).catch(() => {})
    const env = { GIT_INDEX_FILE: index }
    await git(dir, ['add', '-A', '--', '.'], env)
    return (await git(dir, ['write-tree'], env)).trim()
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Snapshot the worktree under `checkpointRef(ns, id)`. Returns the commit, or
 * undefined when it could not be taken — never a throw: a checkpoint is
 * insurance, and a message must not fail to send because git hiccupped.
 */
export async function takeCheckpoint(dir: string, ns: string, id: string): Promise<string | undefined> {
  try {
    const tree = await treeOfWorktree(dir)
    const head = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim()
    const commit = (await git(dir, [
      '-c', 'user.name=Agents Kanban', '-c', 'user.email=checkpoints@agents-kanban.invalid',
      'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `checkpoint before message ${id}`,
    ])).trim()
    await git(dir, ['update-ref', checkpointRef(ns, id), commit])
    return commit
  } catch {
    return undefined
  }
}

export async function hasCheckpoint(dir: string, ns: string, id: string): Promise<boolean> {
  return !!(await git(dir, ['rev-parse', '--verify', '-q', `${checkpointRef(ns, id)}^{commit}`]).catch(() => '')).trim()
}

export interface RestorePlan {
  /** Paths (worktree-relative) put back to their checkpoint content. */
  restore: string[]
  /** Paths the discarded turns created, removed. */
  remove: string[]
  /** Commits on the branch after the checkpoint, undone by the rewind. */
  commitsAfter: number
}

/** What a rewind to this checkpoint would do, without doing it. */
export async function planCheckpointRestore(dir: string, ns: string, id: string): Promise<RestorePlan | undefined> {
  const ref = checkpointRef(ns, id)
  const commit = (await git(dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]).catch(() => '')).trim()
  if (!commit) return undefined
  const now = await treeOfWorktree(dir)
  const out = await git(dir, ['diff-tree', '-r', '-z', '--no-renames', '--name-status', `${commit}^{tree}`, now])
  const parts = out.split('\0').filter((p) => p.length)
  const restore: string[] = []
  const remove: string[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i]!
    const file = parts[i + 1]!
    // A = in the worktree now, not at the checkpoint: the discarded turns made it.
    if (status === 'A') remove.push(file)
    else restore.push(file)
  }
  const parent = (await git(dir, ['rev-parse', '--verify', '-q', `${commit}^1`]).catch(() => '')).trim()
  const commitsAfter = parent
    ? Number((await git(dir, ['rev-list', '--count', `${parent}..HEAD`]).catch(() => '0')).trim()) || 0
    : 0
  return { restore, remove, commitsAfter }
}

/**
 * Make the worktree match the checkpoint: reset the branch to the HEAD the
 * message was sent at (when it has moved), put every changed or deleted file
 * back, remove every file created since. Returns what it did, or undefined
 * when there is no such checkpoint.
 */
export async function restoreCheckpoint(dir: string, ns: string, id: string): Promise<RestorePlan | undefined> {
  const plan = await planCheckpointRestore(dir, ns, id)
  if (!plan) return undefined
  const commit = (await git(dir, ['rev-parse', `${checkpointRef(ns, id)}^{commit}`])).trim()
  const parent = (await git(dir, ['rev-parse', '--verify', '-q', `${commit}^1`]).catch(() => '')).trim()
  const head = (await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => '')).trim()
  // Branch first — `--mixed` moves the index and leaves every file alone, so
  // the file operations below are computed against the worktree either way.
  if (parent && head && parent !== head) await git(dir, ['reset', '--mixed', '-q', parent])
  for (const rel of plan.remove) {
    const abs = path.join(dir, rel)
    await fs.rm(abs, { force: true }).catch(() => {})
    // Directories the removed file leaves empty go too, up to the root.
    let parentDir = path.dirname(abs)
    while (parentDir.startsWith(dir + path.sep)) {
      const left = await fs.readdir(parentDir).catch(() => ['?'])
      if (left.length) break
      await fs.rmdir(parentDir).catch(() => {})
      parentDir = path.dirname(parentDir)
    }
  }
  if (plan.restore.length) {
    // `restore --worktree` writes files from the checkpoint without touching
    // the index; the paths go on stdin, so a thousand of them cannot overflow
    // an argv.
    await new Promise<void>((resolve, reject) => {
      const child = execFile('git', ['-c', 'core.quotePath=false', 'restore', `--source=${commit}`, '--worktree',
        '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd: dir }, (err) => (err ? reject(err) : resolve()))
      child.stdin?.end(plan.restore.join('\0'))
    })
  }
  return plan
}

/** Drop every checkpoint under a namespace — a worktree that is gone has no
 *  message to rewind to, and each checkpoint pins a tree's objects. */
export async function dropCheckpoints(dir: string, ns: string): Promise<number> {
  const prefix = `${CHECKPOINT_PREFIX}/${refSegment(ns)}/`
  const refs = (await git(dir, ['for-each-ref', '--format=%(refname)', prefix]).catch(() => ''))
    .split('\n').map((r) => r.trim()).filter(Boolean)
  for (const r of refs) await git(dir, ['update-ref', '-d', r]).catch(() => {})
  return refs.length
}
