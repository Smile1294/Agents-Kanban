import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { KANBAN_DIR, WorktreeService, findRepoRoot, realResolveInWorktree, resolveInWorktree, slug } from '../worktree.ts'

const exec = promisify(execFile)
let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-wt-'))
const repo = path.join(tmp, 'proj')
await fs.mkdir(repo)
const g = (args: string[], cwd = repo) => exec('git', args, { cwd })
await g(['init', '-b', 'main'])
await g(['config', 'user.email', 'test@example.com'])
await g(['config', 'user.name', 'Test'])
await fs.writeFile(path.join(repo, 'README.md'), '# proj\n')
await g(['add', '-A']); await g(['commit', '-m', 'init'])

const root = await findRepoRoot(repo)
ok(!!root, 'findRepoRoot locates the repo')
ok(await findRepoRoot(tmp) === undefined || root !== await findRepoRoot(tmp), 'non-repo dir handled')

const svc = new WorktreeService(root!)
ok(await svc.currentBranch() === 'main', 'reads current branch')
ok((await svc.list()).length === 0, 'no worktrees initially (main excluded)')

// branches() and checkout() — the merge target picker runs on these.
await g(['branch', 'staging'])
const branchList = await svc.branches()
ok(branchList.includes('main') && branchList.includes('staging'),
   `branches() lists every local branch: ${branchList.join(', ')}`)
await svc.checkout('staging')
ok(await svc.currentBranch() === 'staging', 'checkout() moves the repo checkout')
await svc.checkout('main')
ok(await svc.currentBranch() === 'main', 'and back again')

// create
const wt = await svc.create({ taskId: 'TASK-001', title: 'Fix the login flow' })
ok(wt.branch === 'task/TASK-001-fix-the-login-flow', `branch named from task: ${wt.branch}`)
ok(wt.path.startsWith(path.join(root!, KANBAN_DIR, 'worktrees') + path.sep),
   `worktree lives inside the repo, under .${KANBAN_DIR.slice(1)}/worktrees: ${wt.path}`)
ok((await fs.stat(path.join(wt.path, 'README.md'))).isFile(), 'worktree has repo contents')
ok((await svc.list()).length === 1, 'list sees the new worktree')

// --- the worktree directory must be IGNORED --------------------------------
// This is the gate that makes living inside the repository survivable. An
// unignored .agentskanban/ is an untracked directory in the main working tree,
// and merge() and split() both refuse outright on a dirty tree — so without
// this, creating one session blocks merging and splitting forever, and blames
// a directory the user never made.
const statusAfterCreate = (await g(['status', '--porcelain'])).stdout.split('\n').filter(Boolean)
ok(statusAfterCreate.length === 1 && statusAfterCreate[0]!.endsWith('.gitignore'),
   `creating a worktree dirties nothing but .gitignore: ${JSON.stringify(statusAfterCreate)}`)
const ignoreText = await fs.readFile(path.join(repo, '.gitignore'), 'utf8')
ok(ignoreText.includes(`/${KANBAN_DIR}/`), `the rule written is the whole directory: ${ignoreText.trim()}`)

// Idempotent: a second worktree must not append the rule again.
await svc.create({ taskId: 'TASK-IG', title: 'ignore twice' })
const twice = await fs.readFile(path.join(repo, '.gitignore'), 'utf8')
ok(twice.split(`/${KANBAN_DIR}/`).length - 1 === 1, 'the ignore rule is written once, not once per session')
await svc.remove(path.join(root!, KANBAN_DIR, 'worktrees', 'TASK-IG-ignore-twice'), { force: true })

// A rule that already exists elsewhere counts. git check-ignore is asked, not
// the file, so .git/info/exclude and a global excludes file both satisfy it.
const other = path.join(tmp, 'excluded')
await fs.mkdir(other)
const og = (args: string[]) => exec('git', args, { cwd: other })
await og(['init', '-b', 'main'])
await og(['config', 'user.email', 'test@example.com']); await og(['config', 'user.name', 'Test'])
await fs.writeFile(path.join(other, 'README.md'), '# x\n')
await og(['add', '-A']); await og(['commit', '-m', 'init'])
await fs.writeFile(path.join(other, '.git', 'info', 'exclude'), `/${KANBAN_DIR}/\n`)
const excludedSvc = new WorktreeService((await findRepoRoot(other))!)
ok((await excludedSvc.ensureIgnored()) === undefined, 'an existing exclude rule is left alone')
ok(!(await fs.access(path.join(other, '.gitignore')).then(() => true, () => false)),
   'and no .gitignore is created just to repeat it')

// A worktree root OUTSIDE the repository must not touch .gitignore at all.
const outside = new WorktreeService((await findRepoRoot(other))!, path.join(tmp, 'elsewhere'))
ok((await outside.ensureIgnored()) === undefined, 'a worktree root outside the repo writes no ignore rule')

// NO seeding by default
await fs.writeFile(path.join(repo, '.env'), 'SECRET=1\n')
const wt2 = await svc.create({ taskId: 'TASK-002', title: 'Add rate limiting' })
ok(!(await fs.access(path.join(wt2.path, '.env')).then(() => true, () => false)), '.env is NOT copied into the worktree')

// idempotent per branch
const again = await svc.create({ taskId: 'TASK-001', title: 'Fix the login flow' })
ok(again.path === wt.path, 'creating the same task twice returns the existing worktree')
ok((await svc.list()).length === 2, 'no duplicate worktree created')

// same task + equivalent slug is the SAME worktree (idempotency, not a collision)
const same = await svc.create({ taskId: 'TASK-001', title: 'Fix the login flow!!!' })
ok(same.path === wt.path, 'same task id and slug reuses the worktree rather than forking one')

// a real collision: a stray branch already occupies the name we would pick
await g(['branch', 'task/TASK-009-stray'])
const collided = await svc.create({ taskId: 'TASK-009', title: 'stray' })
ok(collided.branch === 'task/TASK-009-stray-2', `collision suffixed: ${collided.branch}`)

// onCreate hook runs when asked
let seeded = false
const wt3 = await svc.create({
  taskId: 'TASK-003', title: 'Seeded',
  onCreate: async (p) => { await fs.writeFile(path.join(p, '.env'), 'X=1\n'); seeded = true },
})
ok(seeded && await fs.access(path.join(wt3.path, '.env')).then(() => true, () => false), 'onCreate hook can seed explicitly')

// status
await fs.writeFile(path.join(wt.path, 'new.txt'), 'hi\n')
const st = await svc.status(wt.path)
ok(st.dirtyFiles === 1, `status counts dirty files (${st.dirtyFiles})`)

// changed files across a commit
await exec('git', ['add', '-A'], { cwd: wt.path })
await exec('git', ['commit', '-m', 'work'], { cwd: wt.path })
const changed = await svc.changedFiles(wt.path, 'main')
ok(changed.includes('new.txt'), `changedFiles sees committed work: ${changed.join(',')}`)

// concurrent creates do not corrupt the repo (the reason the lock exists)
const many = await Promise.all([10, 11, 12, 13].map(i =>
  svc.create({ taskId: `TASK-0${i}`, title: `Parallel ${i}` })))
ok(new Set(many.map(w => w.path)).size === 4, 'four concurrent creates produce four distinct worktrees')
const listed = await svc.list()
ok(listed.length === 8, `all worktrees registered cleanly (${listed.length})`)  // 001,002,003,009-2 + 4 parallel

// remove
await svc.remove(wt2.path, { force: true })
ok((await svc.list()).length === 7, 'remove deregisters the worktree')
const branches = (await g(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).stdout
ok(!branches.includes('TASK-002'), 'remove deletes the branch too')

// remove tolerates a directory deleted behind our back
await fs.rm(wt3.path, { recursive: true, force: true })
await svc.remove(wt3.path, { force: true })
ok(!(await svc.list()).some(w => w.path === wt3.path), 'remove recovers from a vanished directory')

// --- review: the half that gets work back out of a worktree -----------------

// The no-seeding check above left an untracked .env in the main worktree. The
// merge guards below read a dirty main worktree as a refusal — correctly — so
// clear it, or every merge assertion tests the wrong thing.
await fs.rm(path.join(repo, '.env'), { force: true })

// The .gitignore rule we wrote for the worktree directory is itself an
// uncommitted change, so the FIRST merge after the FIRST session is blocked by
// a file the user never touched. That is real and unavoidable — the rule has to
// be in the repository to be shared — so the refusal must at least say so
// instead of talking about "your own changes".
const selfInflicted = await svc.merge('main', 'main')
const whyDirty = !selfInflicted.ok && 'message' in selfInflicted ? selfInflicted.message : ''
ok(!selfInflicted.ok && selfInflicted.reason === 'dirty', 'an uncommitted ignore rule blocks the merge')
ok(whyDirty.includes('.gitignore') && whyDirty.includes('Agents Kanban'),
   `and the refusal names it rather than blaming the user: ${whyDirty}`)
await g(['add', '.gitignore']); await g(['commit', '-m', 'Ignore agent worktrees'])

// With a real edit of the user's own in the way, it goes back to the plain
// message — and lists what is actually uncommitted.
await fs.writeFile(path.join(repo, 'mine.txt'), 'mine\n')
const theirs = await svc.merge('main', 'main')
const whyTheirs = !theirs.ok && 'message' in theirs ? theirs.message : ''
ok(!theirs.ok && theirs.reason === 'dirty' && whyTheirs.includes('mine.txt') &&
   !whyTheirs.includes('Agents Kanban'),
   `someone else's edit is never attributed to us: ${whyTheirs}`)
await fs.rm(path.join(repo, 'mine.txt'))

// wt already has one commit ('work' → new.txt) plus we add uncommitted edits.
await fs.writeFile(path.join(wt.path, 'draft.txt'), 'not committed yet\n')
await fs.writeFile(path.join(wt.path, 'new.txt'), 'hi again\n')

const rev = await svc.review(wt.path, 'main')
ok(rev.ahead === 1, `review counts commits ahead of base (${rev.ahead})`)
ok(rev.dirty === 2, `review counts uncommitted files (${rev.dirty})`)
ok(rev.files.some(f => f.path === 'draft.txt' && f.status === '?' && !f.committed), 'an untracked file is reported as untracked')
ok(rev.files.some(f => f.path === 'new.txt' && !f.committed), 'a file edited after its commit reads as uncommitted, not committed')
ok(rev.lastCommit?.message === 'work', `review carries the last commit (${rev.lastCommit?.message})`)

// The case the agent brief actually produces: work finished, nothing committed.
// Merging in that state must refuse loudly rather than merge nothing.
const idle = await svc.create({ taskId: 'TASK-020', title: 'Uncommitted work' })
await fs.writeFile(path.join(idle.path, 'wip.txt'), 'wip\n')
const nothing = await svc.merge(idle.branch, 'main')
ok(!nothing.ok && nothing.reason === 'nothing-to-merge', `merging an uncommitted branch refuses: ${!nothing.ok ? nothing.reason : 'MERGED'}`)

const sha = await svc.commitAll(idle.path, 'Add wip')
ok(!!sha, `commitAll returns the new sha (${sha})`)
ok(await svc.isClean(idle.path), 'the worktree is clean after commitAll')
ok((await svc.review(idle.path, 'main')).ahead === 1, 'the committed work now counts as ahead')

// A dirty main worktree must block the merge — this is where work gets lost.
await fs.writeFile(path.join(repo, 'local-edit.txt'), 'mine\n')
const dirty = await svc.merge(idle.branch, 'main')
ok(!dirty.ok && dirty.reason === 'dirty', `a dirty main worktree refuses the merge: ${!dirty.ok ? dirty.reason : 'MERGED'}`)
await fs.rm(path.join(repo, 'local-edit.txt'))

const merged = await svc.merge(idle.branch, 'main')
ok(merged.ok, `merge succeeds into a clean base: ${merged.ok ? merged.merged : JSON.stringify(merged)}`)
ok(await fs.access(path.join(repo, 'wip.txt')).then(() => true, () => false), 'the merged file is in the main worktree')

// A genuine conflict is surfaced with its files, not swallowed.
const conflictWt = await svc.create({ taskId: 'TASK-021', title: 'Conflicting' })
await fs.writeFile(path.join(conflictWt.path, 'wip.txt'), 'branch side\n')
await svc.commitAll(conflictWt.path, 'Branch edit')
await fs.writeFile(path.join(repo, 'wip.txt'), 'main side\n')
await g(['commit', '-am', 'Main edit'])
const clash = await svc.merge(conflictWt.branch, 'main')
ok(!clash.ok && clash.reason === 'conflict', `a conflict is reported as one: ${!clash.ok ? clash.reason : 'MERGED'}`)
ok(!clash.ok && clash.reason === 'conflict' && clash.files.includes('wip.txt'), 'the conflicting file is named')
await svc.abortMerge()
ok(await svc.isClean(repo), 'abortMerge leaves the repository clean again')

// merging into a branch you are not on is refused rather than guessed at
await g(['checkout', '-q', '-b', 'other'])
const wrong = await svc.merge(conflictWt.branch, 'main')
ok(!wrong.ok && wrong.reason === 'wrong-branch', `merging while on another branch refuses: ${!wrong.ok ? wrong.reason : 'MERGED'}`)
await g(['checkout', '-q', 'main'])

// --- test-plan link targets come from the MODEL ------------------------------
// They are rendered as buttons and clicked without a second thought, so
// containment is checked on RESOLVED paths, not on how the string looks.
const wtRoot = '/tmp/proj_worktrees/task-1'
ok(resolveInWorktree(wtRoot, 'src/calc.js') === '/tmp/proj_worktrees/task-1/src/calc.js', 'a normal path resolves')
ok(resolveInWorktree(wtRoot, './a/../b.js') === '/tmp/proj_worktrees/task-1/b.js', 'an interior .. is fine once resolved')
ok(resolveInWorktree(wtRoot, '') === undefined, 'an empty target is refused')
ok(resolveInWorktree(wtRoot, '   ') === undefined, 'so is whitespace')
ok(resolveInWorktree(wtRoot, '../../.ssh/id_rsa') === undefined, 'escaping the worktree is refused')
ok(resolveInWorktree(wtRoot, '..') === undefined, 'so is the parent itself')
ok(resolveInWorktree(wtRoot, '/etc/passwd') === undefined, 'an absolute path is refused')
// A sibling whose name merely STARTS with the root is not inside it. This is
// the check that a naive startsWith() gets wrong.
ok(resolveInWorktree('/tmp/proj_worktrees/task-1', '../task-10/secret') === undefined,
   'a sibling directory sharing a name prefix is outside')
// ...and a filename that merely begins with dots is NOT an escape. The inverse
// mistake, made twice before in this repo: suspect the assertion, not the code.
ok(resolveInWorktree(wtRoot, '..hidden.txt') === '/tmp/proj_worktrees/task-1/..hidden.txt',
   'a filename starting with dots is an ordinary file, not an escape')
ok(resolveInWorktree(wtRoot, '.env') === '/tmp/proj_worktrees/task-1/.env', 'a dotfile is ordinary too')

// A symlink the AGENT created inside its own worktree resolves textually inside
// it, so lexical containment alone is not a boundary. The agent has full write
// access there, so `ln -s ~/.ssh keys` then a link to `keys/id_rsa` is one click
// from opening a real private key.
const secretDir = path.join(tmp, 'outside')
await fs.mkdir(secretDir, { recursive: true })
await fs.writeFile(path.join(secretDir, 'id_rsa'), 'PRIVATE\n')
const escapee = await svc.create({ taskId: 'TASK-030', title: 'Escapee' })
await fs.symlink(secretDir, path.join(escapee.path, 'keys'))
await fs.writeFile(path.join(escapee.path, 'ordinary.txt'), 'fine\n')

ok(resolveInWorktree(escapee.path, 'keys/id_rsa') !== undefined,
   'the LEXICAL check passes a symlinked path — which is why it is not enough')
ok(await realResolveInWorktree(escapee.path, 'keys/id_rsa') === undefined,
   'following the symlink refuses it')
ok(await realResolveInWorktree(escapee.path, 'ordinary.txt') !== undefined,
   'an ordinary file inside the worktree still resolves')
ok(await realResolveInWorktree(escapee.path, 'does/not/exist.txt') !== undefined,
   'a file that does not exist yet is allowed — only its parents can redirect it')
ok(await realResolveInWorktree(escapee.path, 'keys/nested/new.txt') === undefined,
   'and a not-yet-existing file UNDER a symlink is still refused')
ok(await realResolveInWorktree(escapee.path, '../../etc/passwd') === undefined,
   'plain traversal is still refused')

// Non-ASCII paths: git quotes and octal-escapes them by default, which turns a
// filename into a string that is no longer a path.
const uni = await svc.create({ taskId: 'TASK-031', title: 'Unicode' })
await fs.writeFile(path.join(uni.path, 'café.txt'), 'accented\n')
const uniFiles = await svc.fileStatuses(uni.path, 'main')
ok(uniFiles.some(f => f.path === 'café.txt'),
   `a non-ASCII filename survives parsing: ${JSON.stringify(uniFiles.map(f => f.path))}`)

// A merge that fails for a reason OTHER than a conflict must say so, not invent
// conflicts and tell the user to resolve a merge that was already aborted.
const lone = path.join(tmp, 'unrelated')
await fs.mkdir(lone)
const lg = (a: string[]) => exec('git', a, { cwd: lone })
await lg(['init', '-b', 'main']); await lg(['config', 'user.email', 't@e.com']); await lg(['config', 'user.name', 'T'])
await fs.writeFile(path.join(lone, 'other.txt'), 'x\n')
await lg(['add', '-A']); await lg(['commit', '-m', 'unrelated'])
await g(['remote', 'add', 'lone', lone])
await g(['fetch', '-q', 'lone'])
const bad = await svc.merge('lone/main', 'main')
ok(!bad.ok && bad.reason === 'failed', `an unrelated-histories merge reports 'failed', not 'conflict' (${!bad.ok ? bad.reason : 'MERGED'})`)
ok(!bad.ok && bad.reason === 'failed' && /refus|unrelated/i.test(bad.message), `and carries git's own reason: ${!bad.ok && 'message' in bad ? bad.message.slice(0, 70) : ''}`)
ok(await svc.isClean(repo), 'and leaves the repository clean')

ok(slug('Fix THE login!! flow') === 'fix-the-login-flow', 'slug normalises')

// A worktree name can never be changed — the session is running inside the
// directory — so the one chance to make it readable is here. The fixed
// 40-character slice cut this real title mid-word, and the directory on disk
// still reads `...-review-this-repository-figur`.
const cut = slug('Plan is now review this repository, figure out how everything works')
ok(cut.length <= 40, `a long title is still bounded (${cut.length} chars: ${cut})`)
ok(!cut.endsWith('-'), 'and does not trail a separator')
ok(cut.split('-').every((w) => 'plan is now review this repository figure out how everything works'.split(' ').includes(w)),
   `every segment is a whole word, never a fragment like "figur" (${cut})`)
ok(slug('x'.repeat(60)).length === 40, 'a single word longer than the budget is cut short rather than dropped')
ok(slug('!!!') === 'task', 'a title with nothing sluggable still names the directory')

// --- the branch model a SPLIT task produces, against real git ----------------
//
// The claim `split_task` rests on: a subtask forks from what the PARENT forked
// from — not from the parent's branch — so each subtask is an ORDINARY task
// branch. Every assertion below is a thing that would otherwise have to be
// special-cased somewhere in the review, merge or cleanup paths.
//
// Its own repository, because the merge guards read a dirty main worktree as a
// refusal (correctly) and the sections above leave one behind.
{
  const proj = path.join(tmp, 'split')
  await fs.mkdir(proj)
  const gs = (args: string[], cwd = proj) => exec('git', args, { cwd })
  await gs(['init', '-b', 'main'])
  await gs(['config', 'user.email', 'test@example.com'])
  await gs(['config', 'user.name', 'Test'])
  await fs.writeFile(path.join(proj, 'README.md'), '# split\n')
  await gs(['add', '-A']); await gs(['commit', '-m', 'init'])
  const svc2 = new WorktreeService((await findRepoRoot(proj))!)

  // What `agentsKanban.init` does, and what a project is expected to commit
  // once: the ignore rule for the worktree directory. Done up front, no merge
  // below is ever blocked by it.
  ok((await svc2.ensureIgnored()) === '/.agentskanban/', 'init writes the ignore rule before any session exists')
  await gs(['add', '.gitignore']); await gs(['commit', '-m', 'Ignore agent worktrees'])
  ok((await svc2.ensureIgnored()) === undefined, 'and says nothing the second time')

  // The parent: an ordinary session, which is all it is until it splits.
  const parent = await svc2.create({ taskId: 'S1', title: 'Add SSO and fix the flaky test' })
  ok(parent.base === 'main', `the parent records what it forked from: ${parent.base}`)

  // split() refuses once the parent has touched anything, so at the moment of a
  // split this is always true — and it is what makes forking from base safe.
  ok(await svc2.isClean(parent.path), 'a parent that has not started work has a clean worktree')
  ok(await svc2.aheadOf(parent.path, 'main') === 0, 'and no commits of its own to strand')

  // Two subtasks, forked from the PARENT'S BASE.
  const a = await svc2.create({ taskId: 'S1a', title: 'Add SSO', baseBranch: parent.base })
  const b = await svc2.create({ taskId: 'S1b', title: 'Fix the flaky test', baseBranch: parent.base })
  ok(a.path !== b.path && a.branch !== b.branch, 'each subtask gets its own worktree and branch')
  const mainHead = (await gs(['rev-parse', 'main'])).stdout.trim()
  ok(a.head === mainHead && b.head === mainHead, 'both fork from the base commit, not from each other')

  // Isolation: the whole reason for a worktree each.
  await fs.writeFile(path.join(a.path, 'sso.ts'), 'export const sso = true\n')
  await svc2.commitAll(a.path, 'Add SSO')
  await fs.writeFile(path.join(b.path, 'flaky.test.ts'), 'test("stable", () => {})\n')
  await svc2.commitAll(b.path, 'Fix the flaky test')
  ok(!(await fs.access(path.join(b.path, 'sso.ts')).then(() => true, () => false)),
     "one subtask's work is invisible to the other, which is what lets them run at once")
  ok(await svc2.aheadOf(a.path, 'main') === 1 && await svc2.aheadOf(b.path, 'main') === 1,
     'each is exactly one commit ahead of base — its own')

  // Review works per subtask, unchanged: base is `main`, so the diff is that
  // subtask's work and nothing else.
  const reviewA = await svc2.review(a.path, a.base!)
  ok(reviewA.files.length === 1 && reviewA.files[0]!.path === 'sso.ts',
     `a subtask reviews as an ordinary task: ${JSON.stringify(reviewA.files.map((f) => f.path))}`)

  // And each merges back on its own. This is the "I understand when to test
  // what" half: the user takes one subtask at a time, and taking the first does
  // not drag the second in with it.
  const mergedA = await svc2.merge(a.branch, 'main')
  ok(mergedA.ok, `the first subtask merges into base alone: ${mergedA.ok ? mergedA.merged : JSON.stringify(mergedA)}`)
  ok(await fs.access(path.join(proj, 'sso.ts')).then(() => true, () => false), 'its file lands on main')
  ok(!(await fs.access(path.join(proj, 'flaky.test.ts')).then(() => true, () => false)),
     'and the subtask still in progress is NOT dragged in with it')

  const mergedB = await svc2.merge(b.branch, 'main')
  ok(mergedB.ok, `the second merges afterwards, on top: ${mergedB.ok ? mergedB.merged : JSON.stringify(mergedB)}`)
  ok(await fs.access(path.join(proj, 'flaky.test.ts')).then(() => true, () => false), 'and both are now on main')

  // The parent never held code, so there is nothing left to merge from it —
  // which is why the two-level integration branch it would otherwise need does
  // not exist. Its branch is still exactly base.
  ok(await svc2.aheadOf(parent.path, 'main') === 0,
     'the parent branch has nothing on it: it planned, it did not build')

  // Cleanup is the ordinary path too.
  await svc2.remove(a.path)
  ok(!(await svc2.list()).some((w) => w.path === a.path), 'a finished subtask is removed like any other worktree')
}

// --- the diff's left-hand side must be the FILE, byte for byte --------------
//
// `show()` used `git()`, which ends in `stdout.trim()`. It is the sole
// implementation of the diff's left side, so trimming removed the trailing
// newline and any leading blank line — and every diff opened from the review
// panel reported a change at the head and the tail that the agent never made.
// A convenience `.trim()` in a shared helper is a data-format decision in
// disguise.
{
  const exactRepo = path.join(tmp, 'exact')
  await fs.mkdir(exactRepo)
  const ge = (args: string[]) => exec('git', args, { cwd: exactRepo })
  await ge(['init', '-b', 'main'])
  await ge(['config', 'user.email', 'test@example.com'])
  await ge(['config', 'user.name', 'Test'])
  // Leading blank line and a trailing newline: exactly what trimming eats.
  const body = '\nconst a = 1\nconst b = 2\n'
  await fs.writeFile(path.join(exactRepo, 'x.ts'), body)
  await ge(['add', '-A']); await ge(['commit', '-m', 'init'])

  const svc4 = new WorktreeService((await findRepoRoot(exactRepo))!)
  const shown = await svc4.show(exactRepo, 'HEAD', 'x.ts')
  ok(shown === body,
     `the base version is served byte for byte (${JSON.stringify(shown)} vs ${JSON.stringify(body)})`)
  ok(shown.endsWith('\n'), 'including the trailing newline the diff hinges on')
  ok(shown.startsWith('\n'), 'and the leading blank line')
  // A file that does not exist at the ref — the agent ADDED it — is legitimately
  // empty, and that is the diff's "new file" left side.
  ok(await svc4.show(exactRepo, 'HEAD', 'nope.ts') === '',
     'a file the agent added has an empty left side rather than throwing')
}

// --- a commit the SESSION made, or none at all ------------------------------
//
// A fresh task branch's HEAD is the base commit, so `review()` reported the
// BASE branch's last commit — somebody else's work — inside the session's own
// Changes panel, with no attribution, while the Merge button was correctly
// refusing on the grounds that the branch had no commits of its own.
{
  const svc5 = new WorktreeService((await findRepoRoot(repo))!)
  const fresh = await svc5.create({ taskId: 'S8', title: 'nothing committed' })
  const r0 = await svc5.review(fresh.path, 'main')
  ok(r0.ahead === 0, 'a fresh task branch is not ahead of its base')
  ok(r0.lastCommit === undefined,
     `and claims NO commit of its own (${JSON.stringify(r0.lastCommit)})`)

  await fs.writeFile(path.join(fresh.path, 'mine.txt'), 'x\n')
  await exec('git', ['add', '-A'], { cwd: fresh.path })
  await exec('git', ['commit', '-m', 'a commit this session made'], { cwd: fresh.path })
  const r1 = await svc5.review(fresh.path, 'main')
  ok(r1.ahead === 1, 'once it commits, it is ahead')
  ok(r1.lastCommit?.message.startsWith('a commit this session made') === true,
     `and the commit it names is its own (${r1.lastCommit?.message})`)

  // `status()` promised a fallback that was never written: `git worktree add`
  // never sets an upstream, so `HEAD...@{upstream}` always failed and
  // ahead/behind were constants of 0 on every worktree this extension makes.
  const st = await svc5.status(fresh.path, 'main')
  ok(st.ahead === 1, `status() counts commits ahead of the base it was given (${st.ahead})`)
  await svc5.remove(fresh.path)
}

// --- a filename with a space, against REAL git -----------------------------
//
// `status --porcelain` is space-delimited, so git C-quotes any path containing
// a space — whatever `core.quotePath` says, because the quoting is about the
// delimiter and not about non-ASCII. The tab-delimited `diff --name-status`
// used beside it does NOT. So one file arrived under two spellings, `byPath`
// could not dedupe them, and the review panel showed three rows for two files:
// one claiming a file was committed while it had newer uncommitted edits, and
// two carrying literal double quotes in the name. Clicking a quoted row opened
// a path that does not exist.
{
  const spaced = path.join(tmp, 'spaced')
  await fs.mkdir(spaced)
  const gs = (args: string[]) => exec('git', args, { cwd: spaced })
  await gs(['init', '-b', 'main'])
  await gs(['config', 'user.email', 'test@example.com'])
  await gs(['config', 'user.name', 'Test'])
  await fs.writeFile(path.join(spaced, 'README.md'), '# x\n')
  await gs(['add', '-A']); await gs(['commit', '-m', 'init'])

  const svc3 = new WorktreeService((await findRepoRoot(spaced))!)
  const wt = await svc3.create({ taskId: 'S9', title: 'spaces' })

  // Committed on the branch, then edited again — the exact state the agent
  // brief produces, since sessions are told to stop at review WITHOUT
  // committing.
  await fs.writeFile(path.join(wt.path, 'My Notes.md'), 'one\n')
  await exec('git', ['add', '-A'], { cwd: wt.path })
  await exec('git', ['commit', '-m', 'notes'], { cwd: wt.path })
  await fs.writeFile(path.join(wt.path, 'My Notes.md'), 'one\ntwo\n')
  await fs.writeFile(path.join(wt.path, 'Test Plan.md'), 'plan\n')

  const review = await svc3.review(wt.path, 'main')
  const paths = review.files.map((f) => f.path).sort()
  ok(!paths.some((p) => p.includes('"')),
     `no path carries literal quotes: ${JSON.stringify(paths)}`)
  ok(paths.filter((p) => p === 'My Notes.md').length === 1,
     `a file with a space appears ONCE, not once per command that reported it (${JSON.stringify(paths)})`)
  const notes = review.files.find((f) => f.path === 'My Notes.md')
  ok(notes?.committed === false,
     'and its newer uncommitted edit wins the entry, as the code says it should')
  ok(paths.includes('Test Plan.md'), 'an untracked file with a space is listed under its real name')
  // The path has to be openable — that is the whole point of unquoting it.
  for (const f of review.files) {
    ok(await fs.access(path.join(wt.path, f.path)).then(() => true, () => false),
       `the path the panel would open exists on disk: ${f.path}`)
  }

  const changed = await svc3.changedFiles(wt.path, 'main')
  ok(changed.includes('My Notes.md') && !changed.some((c) => c.includes('"')),
     `changedFiles reports real paths too: ${JSON.stringify(changed)}`)

  // A rename must report the NEW name — the one that exists.
  await exec('git', ['mv', 'My Notes.md', 'Their Notes.md'], { cwd: wt.path })
  const renamed = await svc3.review(wt.path, 'main')
  const rp = renamed.files.map((f) => f.path)
  ok(rp.includes('Their Notes.md') && !rp.some((p) => p.includes(' -> ')),
     `a rename reports the new name, not "old -> new": ${JSON.stringify(rp)}`)
}

await fs.rm(tmp, { recursive: true, force: true })
console.log(fails === 0 ? 'PASS — worktrees create, isolate, and clean up under concurrency' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
