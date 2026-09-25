/* Whole-worktree checkpoints against REAL git repositories. What they guard:
   a rewind that leaves the worktree half-rewound — a file first edited after
   the anchor, a file the discarded turns created, a file changed through Bash
   — looks like the old state and is not. And a snapshot must never touch the
   working tree, the index or the branch. */
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  checkpointRef, dropCheckpoints, hasCheckpoint, planCheckpointRestore, refSegment, restoreCheckpoint, takeCheckpoint,
} from '../checkpoints.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-cp-test-'))
const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' })
const write = (rel: string, body: string) => fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
  .then(() => fs.writeFile(path.join(dir, rel), body))
const read = (rel: string) => fs.readFile(path.join(dir, rel), 'utf8').catch(() => undefined)

git('init', '-q', '-b', 'task/S1-fix')
git('config', 'user.email', 't@e.com'); git('config', 'user.name', 'T')
await write('.gitignore', 'node_modules/\n')
await write('a.txt', 'a0\n')
await write('c.txt', 'c0\n')
await write('src/keep.ts', 'keep\n')
git('add', '-A'); git('commit', '-qm', 'init')
// State at the time the message is sent: one uncommitted edit, one untracked
// file, one ignored file.
await write('a.txt', 'a1 (uncommitted at the checkpoint)\n')
await write('untracked.txt', 'u0\n')
await write('node_modules/dep/index.js', 'dep0\n')
const head0 = git('rev-parse', 'HEAD').trim()
const status0 = git('status', '--porcelain')

ok(refSegment('task/S1-fix') === 'task-S1-fix' && refSegment('../x y') === 'x-y', 'ref segments are git-safe')
const sha = await takeCheckpoint(dir, 'task/S1-fix', 'msg-1')
ok(!!sha, 'a checkpoint is taken')
ok(git('status', '--porcelain') === status0, 'taking it changed nothing git status can see — not the index, not the tree')
ok(git('rev-parse', 'HEAD').trim() === head0, 'nor the branch')
ok(git('rev-parse', checkpointRef('task/S1-fix', 'msg-1')).trim() === sha, 'it lives on a private ref')
ok(await hasCheckpoint(dir, 'task/S1-fix', 'msg-1') && !(await hasCheckpoint(dir, 'task/S1-fix', 'nope')), 'hasCheckpoint answers both ways')

// The "discarded turns": an edit to a file, an edit to a file first touched
// now, a new file in a new directory, a deletion, a Bash-style change to an
// ignored file, and a commit (the move into review commits).
await write('a.txt', 'a2 (discarded)\n')
await write('src/keep.ts', 'keep EDITED LATER\n')
await write('gen/new/made.ts', 'created by the discarded turn\n')
await fs.rm(path.join(dir, 'c.txt'))
await write('node_modules/dep/index.js', 'dep1 (npm install ran)\n')
git('add', '-A'); git('commit', '-qm', 'feat: the discarded work')
await write('untracked.txt', 'u1 (discarded)\n')

const plan = await planCheckpointRestore(dir, 'task/S1-fix', 'msg-1')
ok(!!plan && plan.remove.includes('gen/new/made.ts'), 'the plan removes the file the discarded turns created')
ok(!!plan && ['a.txt', 'src/keep.ts', 'c.txt', 'untracked.txt'].every((f) => plan.restore.includes(f)),
   `and restores the four others (${plan?.restore.join(', ')})`)
ok(!!plan && !plan.restore.concat(plan.remove).some((f) => f.startsWith('node_modules/')), 'ignored files are never on it')
ok(plan?.commitsAfter === 1, `it counts the commit it will undo (${plan?.commitsAfter})`)

await restoreCheckpoint(dir, 'task/S1-fix', 'msg-1')
ok(await read('a.txt') === 'a1 (uncommitted at the checkpoint)\n', 'an edited file is back to its checkpoint content, uncommitted edit included')
ok(await read('src/keep.ts') === 'keep\n', 'a file first edited AFTER the anchor is restored too — the half-rewind bug')
ok(await read('c.txt') === 'c0\n', 'a deleted file is back')
ok(await read('gen/new/made.ts') === undefined, 'a created file is gone')
await fs.access(path.join(dir, 'gen')).then(() => ok(false, 'its now-empty directories are gone too'), () => ok(true, 'its now-empty directories are gone too'))
ok(await read('untracked.txt') === 'u0\n', 'an untracked file is back to its content')
ok(await read('node_modules/dep/index.js') === 'dep1 (npm install ran)\n', 'an ignored file is left alone')
ok(git('rev-parse', 'HEAD').trim() === head0, 'the branch is back at the HEAD the message was sent at')
ok(git('status', '--porcelain') === status0, `git status reads exactly as it did then (${JSON.stringify(git('status', '--porcelain'))})`)

ok((await restoreCheckpoint(dir, 'task/S1-fix', 'nope')) === undefined, 'no such checkpoint is undefined, not a throw')
ok((await dropCheckpoints(dir, 'task/S1-fix')) === 1 && !(await hasCheckpoint(dir, 'task/S1-fix', 'msg-1')), 'dropping a namespace removes its refs')
ok((await takeCheckpoint(path.join(dir, 'no-such-dir'), 'x', 'y')) === undefined, 'a checkpoint that cannot be taken is undefined, never a throw')

await fs.rm(dir, { recursive: true, force: true })
if (fails) { console.log(`${fails} failure(s)`); process.exit(1) }
console.log('PASS — a rewind puts the whole worktree back, and a snapshot touches nothing')
