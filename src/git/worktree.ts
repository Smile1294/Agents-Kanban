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

/** A merge that has landed in the working tree but is NOT committed yet.
 *
 *  Read from git itself (`MERGE_HEAD`), never from something we remembered, so
 *  it survives a window reload and so a merge the user started in their own
 *  terminal is seen too. `from` is best-effort: git records the merged commit,
 *  and the branch NAME only in MERGE_MSG, which a user can rewrite. */
export interface PendingMerge {
  /** The branch the work is landing on — the checkout's current branch. */
  into: string
  /** The branch being merged in, if git still knows its name. */
  from?: string
  /** The commit being merged in. Always known; `from` may not be. */
  head: string
  /** Staged paths, so the board can list what would be committed. */
  files: string[]
  /** True once at least one file is still unresolved — a conflicted merge. */
  conflicted: boolean
}

/** The outcome of merging a task branch back. Conflicts are surfaced, never swallowed.
 *
 *  `ok: true` does NOT mean the work is on the branch: the merge deliberately
 *  stops before the commit so it can be reviewed, so `pending` is always true
 *  and `staged` is what is waiting. See `merge()`. */
export type MergeResult =
  | { ok: true; merged: string; into: string; pending: true; staged: string[] }
  | { ok: false; reason: 'conflict'; files: string[] }
  | { ok: false; reason: 'dirty' | 'nothing-to-merge' | 'wrong-branch' | 'failed' | 'merging'; message: string }

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
/**
 * One line of `git status --porcelain`, as a status and a real path.
 *
 * `--porcelain` is SPACE-delimited, so git C-quotes any path that contains a
 * space — and it does that whatever `core.quotePath` says, because the quoting
 * is about the delimiter, not about non-ASCII. `-c core.quotePath=false` (see
 * `gitRaw`) turns off the octal escaping and nothing else.
 *
 * The tab-delimited `diff --name-status` used beside it does NOT quote spaces.
 * So `My Notes.md` arrived from one command as `My Notes.md` and from the other
 * as `"My Notes.md"`, `byPath` could not see they were the same file, and the
 * review panel showed three rows for two files — one of them claiming a file
 * was committed when it had newer uncommitted edits. Clicking the quoted row
 * opened a path with literal double quotes in it, which does not exist.
 *
 * Same parser and same class as the postmortem for `git()` trimming its own
 * output and eating a filename; that one was fixed only for the leading-space
 * half.
 */
export function parsePorcelainLine(line: string): { status: string; path: string } | undefined {
  if (!line.trim()) return undefined
  const code = line.slice(0, 2).trim()
  let rest = line.slice(3)
  // A rename is `R  old -> new`; the NEW name is the one that exists. Split
  // before unquoting, because either side may be quoted independently.
  const arrow = rest.lastIndexOf(' -> ')
  if (arrow >= 0) rest = rest.slice(arrow + 4)
  const path = unquotePath(rest.trim())
  return path ? { status: code === '??' ? '?' : (code[0] ?? 'M'), path } : undefined
}

/** Undo git's C-style quoting. A path that is not quoted is returned as-is. */
export function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"') || raw.length < 2) return raw
  const body = raw.slice(1, -1)
  let out = ''
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { out += body[i]; continue }
    const n = body[++i]
    if (n === undefined) break
    // Octal escapes are BYTES, so a multi-byte character arrives as several and
    // has to be decoded together rather than one at a time.
    if (n >= '0' && n <= '7') {
      const bytes: number[] = []
      let j = i
      for (;;) {
        const oct = body.slice(j, j + 3)
        if (!/^[0-7]{3}$/.test(oct)) break
        bytes.push(parseInt(oct, 8))
        j += 3
        if (body[j] === '\\' && /[0-7]/.test(body[j + 1] ?? '')) { j++; continue }
        break
      }
      if (bytes.length) { out += Buffer.from(bytes).toString('utf8'); i = j - 1; continue }
      out += n
      continue
    }
    out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
  }
  return out
}

/**
 * Git output as BYTES, with nothing done to it.
 *
 * `git()` ends in `stdout.trim()` and `gitRaw()` strips one trailing newline —
 * both are right for parsing a list and wrong for serving a FILE. `show()` is
 * the sole implementation of the diff's left-hand side, and trimming removed
 * the file's trailing newline and any leading blank line, so every diff opened
 * from the review panel reported a change at the top and bottom of the file
 * that the agent had not made. A convenience `.trim()` in a shared helper is a
 * data-format decision in disguise — the same lesson as the postmortem about
 * `git()` eating a filename.
 */
async function gitExact(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotePath=false', ...args], {
    cwd, maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

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

/**
 * Why a merge waiting for review is in the way, phrased so the user can act.
 *
 * Names the branch and the count, and offers the two real exits. `from` is
 * optional because git may genuinely not know the name (see `mergeSourceName`),
 * so the sha is the fallback — never a guessed branch.
 */
export function pendingMergeMessage(p: PendingMerge): string {
  const what = p.from ? `"${p.from}"` : `commit ${p.head.slice(0, 7)}`
  const n = p.files.length
  return p.conflicted
    ? `A merge of ${what} into "${p.into}" is still in progress and has unresolved conflicts. ` +
      'Resolve and commit it, or abort it, before merging again.'
    : `A merge of ${what} into "${p.into}" is waiting for you to review it — ` +
      `${n} file${n === 1 ? '' : 's'} staged, not committed yet. ` +
      'Commit or abort that merge before starting another.'
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

/**
 * The one directory this extension owns inside a repository.
 *
 * Worktrees used to live in a sibling `<repo>_worktrees`, which kept the
 * repository pristine but scattered checkouts around the parent directory,
 * where nothing cleans them up and nothing relates them back to the project.
 * They are project scratch space, so they live in the project — ignored, so
 * they are still not part of it. See `ensureIgnored()` for why the ignore rule
 * is load-bearing rather than tidy.
 */
export const KANBAN_DIR = '.agentskanban'

/** Where worktrees go by default, relative to the repository root. */
export const DEFAULT_WORKTREE_ROOT = `${KANBAN_DIR}/worktrees`

export class WorktreeService {
  readonly repoRoot: string
  readonly worktreeRoot: string

  /** @param worktreeRoot where checkouts go; relative paths resolve against the
   *  repository root. Defaults to `<repo>/.agentskanban/worktrees`. */
  constructor(repoRoot: string, worktreeRoot?: string) {
    this.repoRoot = repoRoot
    this.worktreeRoot = path.resolve(
      repoRoot,
      worktreeRoot && worktreeRoot.trim() ? worktreeRoot : DEFAULT_WORKTREE_ROOT,
    )
  }

  /**
   * The worktree root as a repo-relative POSIX path, or undefined if it is
   * outside the repository (the user pointed the setting elsewhere).
   */
  private relativeRoot(): string | undefined {
    const rel = path.relative(this.repoRoot, this.worktreeRoot)
    if (!rel || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') return undefined
    return rel.split(path.sep).join('/')
  }

  /**
   * The `.gitignore` line that covers the worktree root, or undefined when the
   * root is outside the repository.
   *
   * The whole directory we own, not just the worktrees inside it, so anything
   * added under it later is covered without a second edit to someone's file.
   */
  private ignoreEntry(): string | undefined {
    const rel = this.relativeRoot()
    if (!rel) return undefined
    const owned = rel === KANBAN_DIR || rel.startsWith(`${KANBAN_DIR}/`)
    return `/${owned ? KANBAN_DIR : rel}/`
  }

  /**
   * Make sure git ignores the worktree root, adding it to the repository's
   * `.gitignore` when nothing already does.
   *
   * This is load-bearing, not tidiness. Worktrees live INSIDE the repository,
   * so an unignored `.agentskanban/` is an untracked directory in the main
   * working tree — and `merge()` refuses outright on a dirty tree. Without the
   * rule, creating one session blocks every merge from then on, and blames a
   * directory the user never made. It also puts a permanently-growing pile of
   * untracked checkouts in front of the user's own `git status`. This runs
   * before the first `git worktree add`, so the directory is never once visible
   * as untracked.
   *
   * Idempotent, and quiet about it: `git check-ignore` is asked rather than the
   * file read, so a rule already living in `.git/info/exclude` or a global
   * excludes file counts too and no second copy is written. Does nothing at all
   * when the worktree root is outside the repository — there would be nothing
   * to ignore, and editing someone's `.gitignore` anyway is a surprise.
   *
   * @returns the line it added, or undefined if nothing needed doing.
   */
  async ensureIgnored(): Promise<string | undefined> {
    const rel = this.relativeRoot()
    const entry = this.ignoreEntry()
    if (!rel || !entry) return undefined

    // Probe the worktree ROOT, not the `.agentskanban` directory above it: git
    // will not call a non-existent path a directory, so a `/.agentskanban/`
    // rule does not match `.agentskanban` before the folder exists — but it
    // does match anything beneath it, which is what we actually care about.
    const ignored = await exec('git', ['check-ignore', '-q', '--', rel], { cwd: this.repoRoot })
      .then(() => true, () => false)
    // Asked BEFORE the belt goes on, deliberately: writing the exclude file
    // first would satisfy `check-ignore` and `.gitignore` — the copy the TEAM
    // gets, which is the whole reason that file was chosen — would never be
    // written on a fresh repository.
    await this.ensureExcluded()
    if (ignored) return undefined

    const file = path.join(this.repoRoot, '.gitignore')
    const current = await fs.readFile(file, 'utf8').catch(() => '')
    const prefix = !current ? '' : current.endsWith('\n') ? '\n' : '\n\n'
    await fs.writeFile(
      file,
      `${current}${prefix}# Agents Kanban: one git worktree per agent session lives under here.\n` +
        `# Generated, never yours — safe to delete when no session is running.\n${entry}\n`,
    )
    return entry
  }

  /**
   * The same rule, in `.git/info/exclude`: the copy that cannot be lost.
   *
   * `.gitignore` is the copy the team gets and it stays. But it is TRACKED, and
   * that makes it losable in three ordinary ways — the user discards the
   * unexplained edit in their SCM panel, they switch to a branch that predates
   * it, or it never lands at all. Found on a real repository in exactly that
   * state: `.agentskanban/` untracked, no rule anywhere, no branch that had ever
   * carried one, and so EVERY merge refused as "dirty" with a message telling
   * the user to commit changes they never made.
   *
   * This file is untracked and inside `.git`, so it cannot be discarded, cannot
   * move with a branch, and — the property that matters — cannot itself dirty
   * the tree. That is what lets `merge()` re-assert it on the way past;
   * `.gitignore` can never be re-asserted there, because an uncommitted edit to
   * it is precisely the thing that blocks the merge.
   *
   * Best-effort and silent: a repository whose `.git` we cannot write to is not
   * a reason to fail a merge, and `dirtyMessage()` still names the directory.
   */
  async ensureExcluded(): Promise<boolean> {
    const entry = this.ignoreEntry()
    if (!entry) return false
    try {
      // `--git-common-dir`, not `.git`: in a linked worktree `.git` is a FILE,
      // and the exclude file that counts belongs to the shared directory.
      const dir = await git(this.repoRoot, ['rev-parse', '--git-common-dir'])
      const base = path.isAbsolute(dir) ? dir : path.join(this.repoRoot, dir)
      const file = path.join(base, 'info', 'exclude')
      const current = await fs.readFile(file, 'utf8').catch(() => '')
      if (current.split('\n').some((l) => l.trim() === entry)) return false
      await fs.mkdir(path.dirname(file), { recursive: true })
      const gap = !current || current.endsWith('\n') ? '' : '\n'
      await fs.writeFile(
        file,
        `${current}${gap}# Agents Kanban: one git worktree per agent session lives under here.\n${entry}\n`,
      )
      return true
    } catch {
      return false
    }
  }

  /** The directory this extension owns inside the repository, as git reports
   *  it — used to tell our own mess apart from the user's. */
  private ownedDir(): string | undefined {
    const rel = this.relativeRoot()
    if (!rel) return undefined
    return rel === KANBAN_DIR || rel.startsWith(`${KANBAN_DIR}/`) ? KANBAN_DIR : rel
  }

  async currentBranch(): Promise<string> {
    return git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  }

  /** Every local branch. The merge target picker needs the real list — a
   *  branch the user can name is one they should be able to pick. */
  async branches(): Promise<string[]> {
    const out = await git(this.repoRoot, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    return out ? out.split('\n').filter(Boolean) : []
  }

  /** Switch the repository's own checkout to another branch. Callers check
   *  for a dirty tree first: git refuses to carry changes across, but the
   *  refusal names nothing, and a merge is the place work can be lost. */
  async checkout(branch: string): Promise<void> {
    await withRepoLock(this.repoRoot, async () => {
      await git(this.repoRoot, ['checkout', branch])
    })
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
        ...(await this.branches()).map((b) => b.replace(/^task\//, '')),
      ])
      let name = stem
      for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`

      const dir = path.join(this.worktreeRoot, name)
      // Before the directory exists, so it is never seen as untracked.
      await this.ensureIgnored()
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

  /** @param base the branch this worktree forked from. Without it the ahead/
   *  behind counts fall back to the repo's current branch — see the catch. */
  async status(worktreePath: string, base?: string): Promise<WorktreeStatus> {
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
      // No upstream — which is not the edge case the old comment implied, it is
      // EVERY worktree this extension makes: `git worktree add -b task/x` never
      // sets one. So `HEAD...@{upstream}` always failed and `ahead`/`behind`
      // were constants of 0, while the comment promised a fallback to "the
      // repo's current branch" that was never written. Verified: a worktree two
      // commits ahead of main reported ahead 0, while `aheadOf()` said 2.
      try {
        const against = base ?? (await this.currentBranch())
        const counts = await git(worktreePath, ['rev-list', '--left-right', '--count', `HEAD...${against}`])
        const [a, b] = counts.split(/\s+/)
        ahead = Number(a) || 0
        behind = Number(b) || 0
      } catch {
        // Neither ref resolves — a detached or freshly-initialised repo. Zero
        // is then the honest answer rather than a fallback that failed silently.
      }
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
      // Only a commit this SESSION made. A fresh task branch's HEAD is the base
      // commit, so this reported the base branch's last commit — somebody
      // else's work, rendered inside the session's own Changes panel with no
      // attribution, on a card whose Merge button was correctly refusing on the
      // grounds that the branch had no commits. The panel contradicted itself
      // and named a stranger's sha. `st` is the ahead count, already computed
      // here: zero means there is nothing of ours to show.
      ...(lastCommit && st > 0 ? { lastCommit: { sha: lastCommit.sha, message: lastCommit.message } } : {}),
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
    // `-uall`: a new directory is its files, each with its own diff row — not
    // one undiffable entry named `dir/`. Same reason as `changedFiles()`.
    const porcelain = await gitRaw(worktreePath, ['status', '--porcelain', '-uall']).catch(() => '')
    for (const line of porcelain.split('\n')) {
      const parsed = parsePorcelainLine(line)
      if (parsed) byPath.set(parsed.path, { ...parsed, committed: false })
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
   * Why the main worktree is dirty, phrased so the user can act on it.
   *
   * Worth the extra round trip because of one specific and self-inflicted case:
   * the ignore rule for the worktree directory is written by THIS extension, so
   * the first merge after the first session is very often blocked by a
   * `.gitignore` the user never touched. Generic advice to "commit your own
   * changes" is then advice about someone else's edit, and reads as a bug in
   * the merge button. Naming the files is the fallback, because a merge refused
   * without saying what is in the way is a dead end either way.
   */
  async dirtyMessage(): Promise<string> {
    // Our own mess first. A merge left for review dirties the tree by design,
    // and telling the user to "commit or stash your own changes" for it sends
    // them looking for an edit they never made.
    const waiting = await this.pendingMerge()
    if (waiting) return pendingMergeMessage(waiting)
    const porcelain = await gitRaw(this.repoRoot, ['status', '--porcelain']).catch(() => '')
    const files = porcelain.split('\n')
      .map(parsePorcelainLine)
      .filter((f): f is { status: string; path: string } => !!f)
      .map((f) => f.path)
    if (files.length === 1 && files[0] === '.gitignore' && (await this.onlyIgnoreRuleAdded())) {
      return `The only uncommitted change is the "${this.ignoreEntry()}" rule Agents Kanban added ` +
        'to .gitignore for its worktree directory. Commit that line and merge again.'
    }
    // Our own worktree directory, unignored. The user never made it, so the
    // generic message sends them hunting for an edit that does not exist —
    // which is exactly what happened on a real repository, on every merge.
    const owned = this.ownedDir()
    if (owned && files.length && files.every((f) => f === owned || f.startsWith(`${owned}/`))) {
      return `The only uncommitted thing is Agents Kanban's own worktree directory ` +
        `("${owned}/"), which should be ignored and is not — nothing of yours is in the way. ` +
        `Add "${this.ignoreEntry()}" to .gitignore, or run "Agents Kanban: Initialise", and merge again.`
    }
    const shown = files.slice(0, 5).join(', ')
    const more = files.length > 5 ? `, and ${files.length - 5} more` : ''
    return 'Commit or stash your own changes first — merging into a dirty working tree is how ' +
      `work gets lost.${files.length ? ` Uncommitted: ${shown}${more}.` : ''}`
  }

  /** Is the working copy of `.gitignore` HEAD's, plus our block and nothing
   *  else? Compared against HEAD rather than pattern-matched, so a user who
   *  edited the same file for their own reasons is never told it was us. */
  private async onlyIgnoreRuleAdded(): Promise<boolean> {
    const entry = this.ignoreEntry()
    if (!entry) return false
    const lines = (t: string) => t.split('\n').map((l) => l.trim()).filter(Boolean)
    const now = lines(await fs.readFile(path.join(this.repoRoot, '.gitignore'), 'utf8').catch(() => ''))
    const before = new Set(lines(await git(this.repoRoot, ['show', 'HEAD:.gitignore']).catch(() => '')))
    const added = now.filter((l) => !before.has(l))
    // Comments cannot ignore anything, so they only ride along; the rule itself
    // must be one of the added lines, or this was someone else's edit.
    return added.includes(entry) && added.every((l) => l === entry || l.startsWith('#'))
  }

  /**
   * Merge a task branch back into `base`, in the MAIN worktree.
   *
   * Serialised on the repo lock, because VS Code's own Git extension issues
   * commands against the same repository and a merge is the least forgiving
   * moment for two of them to overlap.
   *
   * Refuses rather than improvises: a dirty main worktree, a merge already
   * waiting to be reviewed, a branch with nothing on it, or a conflict all come
   * back as a described failure. A conflict leaves the merge in progress so it
   * can be resolved in the editor — `abortMerge()` is the way out.
   *
   * It STOPS BEFORE THE COMMIT (`--no-commit`). An agent's work reaching the
   * user's history before they have read a line of it is the wrong default: the
   * only way back out is a revert, on a branch other people may already have
   * pulled. So the incoming work lands staged in the working tree, git stays in
   * its merging state, and `commitMerge()` — the user saying yes — is what
   * writes it. `--no-ff` stays: it keeps a real two-parent merge commit, so the
   * eventual history still records where the work came from.
   */
  async merge(branch: string, base: string): Promise<MergeResult> {
    return withRepoLock(this.repoRoot, async () => {
      const current = await git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (current !== base) {
        return { ok: false, reason: 'wrong-branch', message: `The repository is on "${current}", not "${base}". Switch to ${base} first.` }
      }
      // Our own scratch directory must not be what makes the tree dirty. The
      // rule normally lands at create() time, but it lives in a TRACKED file
      // and is losable — so it is re-asserted here, in the untracked copy,
      // which cannot itself dirty anything. Without this a repository that lost
      // the rule can never merge again, and blames the user for it.
      await this.ensureExcluded()
      // Before the clean check, and it has to be: a merge left for review makes
      // the tree dirty BY DESIGN, so the generic refusal would hand the user
      // advice about "your own changes" for a mess this extension made — the
      // same failure the .gitignore case above exists to prevent.
      const waiting = await this.pendingMerge()
      if (waiting) {
        return { ok: false, reason: 'merging', message: pendingMergeMessage(waiting) }
      }
      if (!(await this.isClean(this.repoRoot))) {
        return { ok: false, reason: 'dirty', message: await this.dirtyMessage() }
      }
      const ahead = await git(this.repoRoot, ['rev-list', '--count', `${base}..${branch}`]).catch(() => '0')
      if (!Number(ahead)) {
        return { ok: false, reason: 'nothing-to-merge', message: `"${branch}" has no commits that "${base}" does not. If the agent left its work uncommitted, commit the worktree first.` }
      }
      try {
        await git(this.repoRoot, ['merge', '--no-ff', '--no-commit', branch, '-m', `Merge ${branch}`])
        return { ok: true, merged: branch, into: base, pending: true, staged: await this.stagedPaths() }
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

  /** Back out of a merge in progress, leaving the repository as it was.
   *
   *  Reached from BOTH ends now: a conflict the user does not want to resolve,
   *  and a clean merge they read and rejected. That is the point of stopping
   *  before the commit — "no" costs one click instead of a revert. */
  async abortMerge(): Promise<void> {
    return withRepoLock(this.repoRoot, async () => {
      await git(this.repoRoot, ['merge', '--abort']).catch(() => {})
    })
  }

  /**
   * A merge that has landed but is not committed, straight from git.
   *
   * `MERGE_HEAD` is the fact, not a flag of ours: it outlives a window reload,
   * and it is equally true of a merge the user started in their own terminal —
   * which the board must not offer to start a second merge on top of.
   */
  async pendingMerge(): Promise<PendingMerge | undefined> {
    const head = await git(this.repoRoot, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']).catch(() => '')
    if (!head) return undefined
    const [into, files, unmerged, from] = await Promise.all([
      git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
      this.stagedPaths(),
      gitRaw(this.repoRoot, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''),
      this.mergeSourceName(),
    ])
    return {
      into,
      ...(from ? { from } : {}),
      head,
      files,
      conflicted: unquotePaths(unmerged).length > 0,
    }
  }

  /**
   * The name of the branch being merged in, if git still knows one.
   *
   * Best effort ON PURPOSE, and it says so by being optional. git records the
   * merged COMMIT in `MERGE_HEAD`; the branch name survives only in `MERGE_MSG`,
   * which the user can rewrite, and in `name-rev`, which will happily answer
   * `main~3` for a commit that is on no branch at all. A name we cannot justify
   * is worse than none — the board falls back to the sha.
   */
  private async mergeSourceName(): Promise<string | undefined> {
    const dir = await git(this.repoRoot, ['rev-parse', '--git-dir']).catch(() => '')
    if (dir) {
      const file = path.isAbsolute(dir) ? dir : path.join(this.repoRoot, dir)
      const msg = await fs.readFile(path.join(file, 'MERGE_MSG'), 'utf8').catch(() => '')
      // Ours ("Merge <branch>") and git's own ("Merge branch 'x' into y").
      const m = /^Merge (?:(?:remote-tracking )?branch |commit |tag )?'?(.+?)'?(?: into .+)?$/
        .exec(msg.split('\n')[0]?.trim() ?? '')
      if (m?.[1]) return m[1]
    }
    // Only an EXACT branch name counts. `name-rev` answers with an offset
    // ("task/foo~2") for a commit that is merely an ancestor of a branch, and
    // reporting that as the thing being merged would be a fabricated readout.
    const named = await git(this.repoRoot, [
      'name-rev', '--name-only', '--refs=refs/heads/*', 'MERGE_HEAD',
    ]).catch(() => '')
    return named && named !== 'undefined' && !/[~^]/.test(named) ? named : undefined
  }

  /**
   * Commit a merge that is waiting for review. This is the user saying yes.
   *
   * `--no-edit` rather than a message of our own: git wrote `MERGE_MSG` when the
   * merge started, so this keeps whatever the merge was actually called and
   * keeps a conflict resolved by hand from being retitled behind the user's
   * back. Throws if the merge is still conflicted — git refuses, and inventing
   * a commit over unresolved markers is exactly the wrong recovery.
   */
  async commitMerge(): Promise<string> {
    return withRepoLock(this.repoRoot, async () => {
      await git(this.repoRoot, ['commit', '--no-edit'])
      return git(this.repoRoot, ['rev-parse', '--short', 'HEAD'])
    })
  }

  /** Paths staged against HEAD — what committing right now would record. */
  private async stagedPaths(): Promise<string[]> {
    const out = await gitRaw(this.repoRoot, ['diff', '--name-only', '--cached', 'HEAD']).catch(() => '')
    return unquotePaths(out).sort()
  }

  /** A file's contents at a ref, for the left-hand side of a diff. */
  async show(worktreePath: string, ref: string, file: string): Promise<string> {
    // `gitExact`, not `git`: this is the left-hand side of a diff, so it must be
    // the file as the base ref has it, down to the trailing newline. `git()`
    // trims, which made every diff show a spurious change at the head and the
    // tail. An empty string on failure is correct and load-bearing — `git show`
    // fails for a file the agent ADDED, and an empty left side is exactly right
    // there.
    return gitExact(worktreePath, ['show', `${ref}:${file}`]).catch(() => '')
  }

  /**
   * Files changed in a worktree relative to `base` — committed, staged, unstaged
   * and untracked alike. The review view and the knowledge-file gate read it.
   *
   * `-uall`, because plain `--porcelain` collapses an untracked directory to
   * one entry ending in `/`. The gate maps changed PATHS to the area files
   * that own them, so a new source file inside a new directory was invisible to
   * it — and so was the new area file an agent wrote to claim it, which made
   * the gate refuse a branch that had done exactly what it asked.
   */
  async changedFiles(worktreePath: string, base: string): Promise<string[]> {
    const merge = await git(worktreePath, ['merge-base', 'HEAD', base]).catch(() => '')
    const range = merge ? `${merge}..HEAD` : 'HEAD'
    const committed = await gitRaw(worktreePath, ['diff', '--name-only', range]).catch(() => '')
    const working = await gitRaw(worktreePath, ['status', '--porcelain', '-uall']).catch(() => '')
    const set = new Set<string>()
    for (const f of committed.split('\n')) if (f.trim()) set.add(f.trim())
    for (const l of working.split('\n')) {
      const parsed = parsePorcelainLine(l)
      if (parsed) set.add(parsed.path)
    }
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

/** As many characters of the title as a directory name carries. */
const SLUG_MAX = 40

/**
 * The readable half of a worktree directory and branch name.
 *
 * Cut on a hyphen, never mid-word: the fixed 40-character slice produced
 * `...-review-this-repository-figur`, which reads as a corrupted name rather
 * than a shortened one — and a worktree name can never be changed afterwards,
 * because the session is running inside it.
 */
export function slug(s: string): string {
  const full = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (full.length <= SLUG_MAX) return full || 'task'
  const room = full.slice(0, SLUG_MAX + 1)
  const at = room.lastIndexOf('-')
  // A single word longer than the budget has no boundary to cut on, so it is
  // still cut short rather than left to run the directory name off the screen.
  const cut = at > SLUG_MAX / 3 ? room.slice(0, at) : full.slice(0, SLUG_MAX)
  return cut.replace(/-+$/, '') || 'task'
}
