/** Git worktree lifecycle: one isolated checkout per task.
 *
 * Every agent works in its own worktree on its own branch, so three agents can
 * run at once without touching each other's files or your working tree.
 *
 * Deliberately NO seeding — we do not copy .env, symlink node_modules, or run
 * an install. Nimbalyst does the same, and it is the right default: copying
 * secrets into a sibling directory is a surprise, and install steps vary per
 * project. `onCreate` is exposed so a project can opt in.
 */
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { withRepoLock } from './lock.ts'

const exec = promisify(execFile)

export interface WorktreeInfo {
  path: string
  branch: string
  head: string
  /** The branch this worktree forked from. Needed later to diff and merge back;
   *  absent for worktrees discovered by list(), where git no longer records it. */
  base?: string
  /** A worktree whose directory is gone but which git still has registered. */
  prunable?: boolean
}

export interface WorktreeStatus {
  dirtyFiles: number
  ahead: number
  behind: number
}

/** One changed file, and how it changed. `staged` is false for working-tree edits. */
export interface ChangedFile {
  path: string
  /** git's single-letter status: A added, M modified, D deleted, R renamed, ? untracked. */
  status: string
  committed: boolean
}

/** Everything the review panel needs about one worktree, in one round trip. */
export interface WorktreeReview {
  base: string
  /** The fork point the file list was computed against; the diff's left side. */
  baseRef?: string
  ahead: number
  dirty: number
  files: ChangedFile[]
  lastCommit?: { sha: string; message: string }
}

/** The outcome of merging a task branch back. Conflicts are surfaced, never swallowed. */
export type MergeResult =
  | { ok: true; merged: string; into: string }
  | { ok: false; reason: 'conflict'; files: string[] }
  | { ok: false; reason: 'dirty' | 'nothing-to-merge' | 'wrong-branch' | 'failed'; message: string }

export class GitError extends Error {
  readonly stderr: string
  constructor(message: string, stderr: string) {
    super(message)
    this.name = 'GitError'
    this.stderr = stderr
  }
}

/**
 * Like `git`, but only the trailing newline is stripped.
 *
 * `git status --porcelain` encodes the status in the first two COLUMNS, so its
 * first line commonly starts with a space (" M file"). Trimming the whole
 * output eats that space, and every subsequent `slice(3)` then removes a
 * character of the filename — silently, and only ever for the first file, which
 * is why it survived so long.
 */
async function gitRaw(cwd: string, args: string[]): Promise<string> {
  // -c core.quotePath=false: with git's default, a path containing anything
  // non-ASCII comes back as "src/caf\303\251.ts" — quoted, octal-escaped, and
  // no longer a path. Every consumer here then joins it onto a directory and
  // finds nothing. Turning it off costs nothing and is the only place paths
  // are parsed.
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  })
  return stdout.replace(/\n$/, '')
}

/** Split newline-separated git path output, dropping blanks. */
function unquotePaths(out: string): string[] {
  return out.split('\n').map((f) => f.trim()).filter(Boolean)
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 })
    return stdout.trim()
  } catch (e: unknown) {
    const anyErr = e as { stderr?: string; message?: string }
    const stderr = (anyErr.stderr ?? '').trim()
    throw new GitError(
      `git ${args.join(' ')} failed${stderr ? `: ${stderr.split('\n')[0]}` : ''}`,
      stderr,
    )
  }
}

/** The canonical repository root for `cwd`, or undefined if not a repo. */
export async function findRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    const root = await git(cwd, ['rev-parse', '--show-toplevel'])
    // Canonical, because withRepoLock keys on this string.
    return await fs.realpath(root)
  } catch {
    return undefined
  }
}

export class WorktreeService {
  readonly repoRoot: string
  private readonly worktreeRoot: string

  /** @param worktreeRoot where checkouts go; defaults to `<repo>_worktrees` alongside the repo. */
  constructor(repoRoot: string, worktreeRoot?: string) {
    this.repoRoot = repoRoot
    this.worktreeRoot =
      worktreeRoot && worktreeRoot.trim()
        ? path.resolve(repoRoot, worktreeRoot)
        : `${repoRoot}_worktrees`
  }

  async currentBranch(): Promise<string> {
    return git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  }

  /** Parse `git worktree list --porcelain`. The main worktree is excluded. */
  async list(): Promise<WorktreeInfo[]> {
    const out = await git(this.repoRoot, ['worktree', 'list', '--porcelain'])
    const entries: WorktreeInfo[] = []
    let cur: Partial<WorktreeInfo> = {}
    const flush = () => {
      if (cur.path && cur.path !== this.repoRoot) {
        entries.push({
          path: cur.path,
          branch: cur.branch ?? '(detached)',
          head: cur.head ?? '',
          ...(cur.prunable ? { prunable: true } : {}),
        })
      }
      cur = {}
    }
    for (const line of out.split('\n')) {
      if (line.startsWith('worktree ')) { flush(); cur.path = line.slice(9) }
      else if (line.startsWith('HEAD ')) cur.head = line.slice(5)
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
      else if (line.startsWith('prunable')) cur.prunable = true
    }
    flush()
    return entries
  }

  /**
   * Create a worktree for a task. Idempotent per branch name: if the branch
   * already has a worktree, that one is returned instead of failing.
   */
  async create(opts: {
    taskId: string
    title: string
    baseBranch?: string
    onCreate?: (worktreePath: string) => Promise<void>
  }): Promise<WorktreeInfo> {
    return withRepoLock(this.repoRoot, async () => {
      const base = opts.baseBranch ?? (await this.currentBranch())
      const stem = `${opts.taskId}-${slug(opts.title)}`.slice(0, 60)

      const existing = await this.list()
      const already = existing.find((w) => w.branch === `task/${stem}`)
      if (already) return { ...already, base }

      const taken = new Set([
        ...existing.map((w) => path.basename(w.path)),
        ...(await this.localBranches()).map((b) => b.replace(/^task\//, '')),
      ])
      let name = stem
      for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`

      const dir = path.join(this.worktreeRoot, name)
      await fs.mkdir(this.worktreeRoot, { recursive: true })

      try {
        await git(this.repoRoot, ['worktree', 'add', '-b', `task/${name}`, dir, base])
      } catch (e) {
        // Leave no half-registered worktree behind on failure.
        await git(this.repoRoot, ['worktree', 'prune']).catch(() => {})
        await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
        throw e
      }

      if (opts.onCreate) {
        try { await opts.onCreate(dir) } catch { /* seeding is best-effort */ }
      }

      const head = await git(dir, ['rev-parse', 'HEAD']).catch(() => '')
      return { path: dir, branch: `task/${name}`, head, base }
    })
  }

  private async localBranches(): Promise<string[]> {
    const out = await git(this.repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    return out ? out.split('\n') : []
  }

  async status(worktreePath: string): Promise<WorktreeStatus> {
    const porcelain = await git(worktreePath, ['status', '--porcelain']).catch(() => '')
    const dirtyFiles = porcelain ? porcelain.split('\n').filter(Boolean).length : 0
    let ahead = 0, behind = 0
    try {
      // Compare against the branch this worktree forked from, via its upstream
      // if set, else the repo's current branch.
      const counts = await git(worktreePath, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
      const [a, b] = counts.split(/\s+/)
      ahead = Number(a) || 0
      behind = Number(b) || 0
    } catch {
      // No upstream configured — normal for a fresh task branch.
    }
    return { dirtyFiles, ahead, behind }
  }

  /** Remove a worktree and, unless `keepBranch`, delete its branch. */
  async remove(worktreePath: string, opts: { force?: boolean; keepBranch?: boolean } = {}): Promise<void> {
    return withRepoLock(this.repoRoot, async () => {
      const entry = (await this.list()).find((w) => w.path === worktreePath)
      const args = ['worktree', 'remove', ...(opts.force ? ['--force'] : []), worktreePath]
      try {
        await git(this.repoRoot, args)
      } catch (e) {
        if (!opts.force) throw e
        // Directory already gone by other means — clear the registration.
        await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {})
        await git(this.repoRoot, ['worktree', 'prune'])
      }
      if (entry && !opts.keepBranch && entry.branch !== '(detached)') {
        await git(this.repoRoot, ['branch', '-D', entry.branch]).catch(() => {})
      }
    })
  }

  async prune(): Promise<void> {
    return withRepoLock(this.repoRoot, async () => { await git(this.repoRoot, ['worktree', 'prune']) })
  }

  /** The most recent commit in a worktree, for the chat view's commit card. */
  async lastCommit(worktreePath: string): Promise<{ sha: string; message: string; files: string[] } | undefined> {
    try {
      const sha = await git(worktreePath, ['rev-parse', '--short', 'HEAD'])
      const message = await git(worktreePath, ['log', '-1', '--pretty=%B'])
      const namesOut = await gitRaw(worktreePath, ['show', '--name-only', '--pretty=format:', 'HEAD'])
      const files = unquotePaths(namesOut)
      return { sha, message: message.trim(), files }
    } catch {
      return undefined
    }
  }

  /** Is a checkout free of uncommitted changes? */
  async isClean(dir: string): Promise<boolean> {
    const out = await git(dir, ['status', '--porcelain']).catch(() => 'x')
    return out === ''
  }

  /**
   * Everything the review panel shows, in one call: what changed, whether it is
   * committed yet, and how far ahead of base the branch is.
   *
   * The committed/uncommitted split matters. The agent brief tells sessions to
   * stop at the review column WITHOUT committing, so the common case is a
   * worktree full of uncommitted work — and merging a branch in that state
   * merges nothing at all, silently. The UI needs to be able to say so.
   */
  async review(worktreePath: string, base: string): Promise<WorktreeReview> {
    const [files, st, lastCommit, baseRef] = await Promise.all([
      this.fileStatuses(worktreePath, base),
      this.aheadOf(worktreePath, base),
      this.lastCommit(worktreePath),
      this.mergeBase(worktreePath, base),
    ])
    return {
      base,
      ...(baseRef ? { baseRef } : {}),
      ahead: st,
      dirty: files.filter((f) => !f.committed).length,
      files,
      ...(lastCommit ? { lastCommit: { sha: lastCommit.sha, message: lastCommit.message } } : {}),
    }
  }

  /**
   * The commit this worktree forked from.
   *
   * The file list is computed against this, so the diff's left-hand side must
   * be too: using the base BRANCH instead means a base that has moved on shows
   * a teammate's commits as deletions the agent supposedly made.
   */
  async mergeBase(worktreePath: string, base: string): Promise<string | undefined> {
    const sha = await git(worktreePath, ['merge-base', 'HEAD', base]).catch(() => '')
    return sha || undefined
  }

  /** How many commits this worktree has that `base` does not. */
  async aheadOf(worktreePath: string, base: string): Promise<number> {
    const out = await git(worktreePath, ['rev-list', '--count', `${base}..HEAD`]).catch(() => '0')
    return Number(out) || 0
  }

  /** Changed files with their status letters, committed work and working tree both. */
  async fileStatuses(worktreePath: string, base: string): Promise<ChangedFile[]> {
    const byPath = new Map<string, ChangedFile>()

    const merge = await git(worktreePath, ['merge-base', 'HEAD', base]).catch(() => '')
    if (merge) {
      const out = await gitRaw(worktreePath, ['diff', '--name-status', `${merge}..HEAD`]).catch(() => '')
      for (const line of out.split('\n')) {
        if (!line.trim()) continue
        const [status, ...rest] = line.split(/\t/)
        const file = rest[rest.length - 1]
        if (file) byPath.set(file, { path: file, status: (status ?? 'M')[0] ?? 'M', committed: true })
      }
    }

    // Uncommitted work wins the entry: it is the newer truth about that file.
    const porcelain = await gitRaw(worktreePath, ['status', '--porcelain']).catch(() => '')
    for (const line of porcelain.split('\n')) {
      if (!line.trim()) continue
      const code = line.slice(0, 2).trim()
      const file = line.slice(3).trim().replace(/^.* -> /, '')
      if (file) byPath.set(file, { path: file, status: code === '??' ? '?' : (code[0] ?? 'M'), committed: false })
    }

    return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  /** Stage everything in the worktree and commit it. Returns the new short sha. */
  async commitAll(worktreePath: string, message: string): Promise<string> {
    await git(worktreePath, ['add', '-A'])
    await git(worktreePath, ['commit', '-m', message])
    return git(worktreePath, ['rev-parse', '--short', 'HEAD'])
  }

  /**
   * Merge a task branch back into `base`, in the MAIN worktree.
   *
   * Serialised on the repo lock, because VS Code's own Git extension issues
   * commands against the same repository and a merge is the least forgiving
   * moment for two of them to overlap.
   *
   * Refuses rather than improvises: a dirty main worktree, a branch with
   * nothing on it, or a conflict all come back as a described failure. A
   * conflict leaves the merge in progress so it can be resolved in the editor —
   * `abortMerge()` is the way out.
   */
  async merge(branch: string, base: string): Promise<MergeResult> {
    return withRepoLock(this.repoRoot, async () => {
      const current = await git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (current !== base) {
        return { ok: false, reason: 'wrong-branch', message: `The repository is on "${current}", not "${base}". Switch to ${base} first.` }
      }
      if (!(await this.isClean(this.repoRoot))) {
        return { ok: false, reason: 'dirty', message: 'Commit or stash your own changes first — merging into a dirty working tree is how work gets lost.' }
      }
      const ahead = await git(this.repoRoot, ['rev-list', '--count', `${base}..${branch}`]).catch(() => '0')
      if (!Number(ahead)) {
        return { ok: false, reason: 'nothing-to-merge', message: `"${branch}" has no commits that "${base}" does not. If the agent left its work uncommitted, commit the worktree first.` }
      }
      try {
        await git(this.repoRoot, ['merge', '--no-ff', branch, '-m', `Merge ${branch}`])
        return { ok: true, merged: branch, into: base }
      } catch (e) {
        const conflicted = await gitRaw(this.repoRoot, ['diff', '--name-only', '--diff-filter=U'])
          .catch(() => '')
        const files = unquotePaths(conflicted)
        if (files.length) return { ok: false, reason: 'conflict', files }
        // No unmerged files, so this was NOT a conflict: unrelated histories, a
        // rejecting hook, an ignored file that would be overwritten. Reporting
        // it as a conflict told the user to resolve something that did not
        // exist, and threw away the one message that explained the real cause.
        await git(this.repoRoot, ['merge', '--abort']).catch(() => {})
        const detail = e instanceof GitError && e.stderr ? e.stderr.split('\n')[0]! : String(e)
        return {
          ok: false,
          reason: 'failed',
          message: `git could not merge ${branch} into ${base}: ${detail}`,
        }
      }
    })
  }

  /** Back out of a conflicted merge, leaving the repository as it was. */
  async abortMerge(): Promise<void> {
    return withRepoLock(this.repoRoot, async () => {
      await git(this.repoRoot, ['merge', '--abort']).catch(() => {})
    })
  }

  /** A file's contents at a ref, for the left-hand side of a diff. */
  async show(worktreePath: string, ref: string, file: string): Promise<string> {
    return git(worktreePath, ['show', `${ref}:${file}`]).catch(() => '')
  }

  /** Files changed in a worktree relative to `base`, for the review view. */
  async changedFiles(worktreePath: string, base: string): Promise<string[]> {
    const merge = await git(worktreePath, ['merge-base', 'HEAD', base]).catch(() => '')
    const range = merge ? `${merge}..HEAD` : 'HEAD'
    const committed = await gitRaw(worktreePath, ['diff', '--name-only', range]).catch(() => '')
    const working = await gitRaw(worktreePath, ['status', '--porcelain']).catch(() => '')
    const set = new Set<string>()
    for (const f of committed.split('\n')) if (f.trim()) set.add(f.trim())
    for (const l of working.split('\n')) if (l.trim()) set.add(l.slice(3).trim())
    return [...set].sort()
  }
}

/**
 * Resolve a worktree-relative path, or undefined if it escapes.
 *
 * Test-plan link targets are written by the MODEL, so "../../.ssh/id_rsa" is a
 * path like any other and gets clicked like any other. Containment is checked
 * on the RESOLVED paths and against a trailing separator — `/a/bc` must not
 * count as inside `/a/b`, and a `..` segment must not be confused with a
 * filename that merely starts with dots.
 */
export function resolveInWorktree(worktreeRoot: string, target: string): string | undefined {
  if (!target.trim()) return undefined
  if (path.isAbsolute(target)) return undefined
  const root = path.resolve(worktreeRoot)
  const resolved = path.resolve(root, target)
  if (resolved === root) return resolved
  return resolved.startsWith(root + path.sep) ? resolved : undefined
}

/**
 * The same containment check, but following symlinks.
 *
 * Lexical resolution alone is not a boundary here: the agent has full write
 * access to its own worktree, so it can create `ln -s ~/.ssh keys` and then
 * record a test link to `keys/id_rsa`, which resolves textually inside the root
 * and opens the real private key. Both the link and the root are realpath'd —
 * the root because it may itself sit behind a symlink (/tmp on macOS), which
 * would otherwise make every path look like an escape.
 */
export async function realResolveInWorktree(
  worktreeRoot: string,
  target: string,
): Promise<string | undefined> {
  const lexical = resolveInWorktree(worktreeRoot, target)
  if (!lexical) return undefined
  const realRoot = await fs.realpath(worktreeRoot).catch(() => path.resolve(worktreeRoot))
  // A file that does not exist yet cannot be a symlink to somewhere else, but
  // its PARENT can be, so resolve the deepest part that exists.
  let probe = lexical
  for (;;) {
    const real = await fs.realpath(probe).catch(() => undefined)
    if (real) {
      const suffix = lexical.slice(probe.length)
      const resolved = real + suffix
      if (resolved === realRoot) return resolved
      return resolved.startsWith(realRoot + path.sep) ? resolved : undefined
    }
    const parent = path.dirname(probe)
    if (parent === probe) return undefined
    probe = parent
  }
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task'
}
