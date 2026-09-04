import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { MetaStore, resolveEffort, resolveThinking } from '../meta.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// One level deeper than the temp directory on purpose. The store looks for a
// previous install among its SIBLINGS, and the system temp directory is full of
// siblings left by earlier runs of this very file — which is how these tests
// started reading each other's state.
const box = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-meta-'))
const dir = path.join(box, 'test.agents-kanban')
await fs.mkdir(dir, { recursive: true })
const root = '/Users/x/proj'
const meta = new MetaStore(dir, root)

ok((await meta.get('s1')).phase === 'planning', 'unknown session gets a default phase')
ok((await meta.get('s1')).tags.length === 0, 'and no tags')

await meta.update('s1', { phase: 'implementing', tags: ['auth', 'bug-fix'] })
const m1 = await meta.get('s1')
ok(m1.phase === 'implementing' && m1.tags.join(',') === 'auth,bug-fix', 'phase and MULTIPLE tags stored')

// Nimbalyst records each phase change as bounded activity; so do we.
ok(m1.activity.some((a) => a.action === 'phase_changed' && a.oldValue === 'planning' && a.newValue === 'implementing'),
   'phase change recorded as activity with old and new value')
ok(m1.activity.some((a) => a.action === 'tags_changed'), 'tag change recorded')

// survives a reload — this is the whole point of the sidecar
const fresh = new MetaStore(dir, root)
const r = await fresh.get('s1')
ok(r.phase === 'implementing' && r.tags.length === 2, 'metadata survives a fresh store')

// archive is a soft flag
await meta.update('s1', { archived: true })
ok((await new MetaStore(dir, root).get('s1')).archived === true, 'archive persists as a flag')
await meta.update('s1', { archived: false })
ok((await meta.get('s1')).activity.filter((a) => a.action === 'archived' || a.action === 'unarchived').length === 2,
   'archive and unarchive both logged')

// per-workspace isolation: another folder must not see these sessions
const other = new MetaStore(dir, '/Users/x/other')
ok((await other.get('s1')).phase === 'planning', 'a different workspace does not see this metadata')

// tags are de-duplicated and blanks dropped
await meta.update('s2', { tags: ['a', 'a', '', '  ', 'b'] })
ok((await meta.get('s2')).tags.join(',') === 'a,b', 'tags de-duplicated and blanks dropped')

// activity stays bounded
for (let i = 0; i < 130; i++) await meta.update('s3', { phase: i % 2 ? 'planning' : 'implementing' })
ok((await meta.get('s3')).activity.length <= 100, `activity log bounded (${(await meta.get('s3')).activity.length})`)

// corrupt file must not take the board down
await fs.writeFile(path.join(dir, 'sessions', `${encodeURIComponent(root)}.json`), '{ not json', 'utf8')
ok((await new MetaStore(dir, root).get('s1')).phase === 'planning', 'a corrupt sidecar degrades to defaults')

// --- resolution order: session -> workspace default -> unset ---
ok(resolveEffort('low', 'max') === 'low', 'per-session effort wins')
ok(resolveEffort(undefined, 'max') === 'max', 'workspace default is next')
ok(resolveEffort(undefined, undefined) === undefined, 'unset leaves the CLI on its own default')
ok(resolveEffort('nonsense', 'high') === 'high', 'invalid value falls through rather than being sent')

// "Extended: On" must mean OMIT, so callers send nothing for 'enabled'
ok(resolveThinking(undefined, undefined) === 'enabled', 'thinking defaults to enabled (i.e. omit the option)')
ok(resolveThinking('disabled', 'enabled') === 'disabled', 'per-session thinking wins')

await fs.rm(dir, { recursive: true, force: true })
// Clearing the worktree after removing it. `undefined` cannot do this —
// stripUndefined() drops the key — so the card would keep offering to open a
// directory that is gone.
await meta.update('clear-me', { worktree: '/tmp/wt', branch: 'task/x' })
ok((await meta.get('clear-me')).worktree === '/tmp/wt', 'a worktree path is recorded')
await meta.update('clear-me', { worktree: undefined })
ok((await meta.get('clear-me')).worktree === '/tmp/wt', 'undefined does NOT clear it — that is why we use empty string')
await meta.update('clear-me', { worktree: '' })
ok((await meta.get('clear-me')).worktree === '', 'an empty string clears the worktree')
ok((await meta.get('clear-me')).branch === 'task/x', 'clearing the worktree keeps the branch, which still holds the commits')

// A failed write must not swallow the NEXT one.
//
// The chain was `writing.then(write, () => {})`, which reads like "ignore the
// previous failure" and does the opposite: on a rejection the handler ran
// INSTEAD of the write, so the following update wrote nothing — and resolved,
// telling its caller the phase change had been saved. One transient error
// (disk full, a lock, a permissions blip) silently lost the change after it.
const hostile = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-flush-'))
await fs.writeFile(path.join(hostile, 'sessions'), 'in the way\n')   // block the mkdir
const fragile = new MetaStore(hostile, '/proj')

let firstFailed = false
await fragile.update('a', { phase: 'implementing' }).catch(() => { firstFailed = true })
ok(firstFailed, 'a write into an unwritable location rejects, rather than pretending')

await fs.rm(path.join(hostile, 'sessions'))                          // clear the obstruction
await fragile.update('b', { phase: 'validating' })

const written = await fs.readFile(
  path.join(hostile, 'sessions', encodeURIComponent('/proj') + '.json'), 'utf8',
).catch(() => '')
ok(written !== '', 'the write AFTER a failure actually reaches disk')
ok(written.includes('"b"') && written.includes('validating'), 'and carries the change it claimed to save')
await fs.rm(hostile, { recursive: true, force: true })

// Board state is keyed by `sessionId ?? runId`, because a run has no session id
// for its first moment. Whatever the agent wrote in that window has to follow
// the real id when it arrives, or its phase and test plan are orphaned under a
// key nothing ever looks up again.
await meta.update('run-9-abc', {
  phase: 'implementing',
  tags: ['auth'],
  testPlan: { summary: 'check it', steps: ['run the tests'], links: [], at: 1 },
})
await meta.rename('run-9-abc', 'sess-real')
const carried = await meta.get('sess-real')
ok(carried.phase === 'implementing', 'the phase written under the run id survives adoption')
ok(carried.tags.join() === 'auth', 'so do the tags')
ok(carried.testPlan?.summary === 'check it', 'and the test plan')
ok((await meta.get('run-9-abc')).phase === 'planning', 'the run-id entry is gone, not duplicated')

// If the real id already has state, that is newer and wins — but neither half
// of the run loses its activity trail.
await meta.update('run-10-x', { phase: 'planning', tags: ['old'] })
await meta.update('sess-two', { phase: 'validating', tags: ['new'] })
await meta.rename('run-10-x', 'sess-two')
const merged = await meta.get('sess-two')
ok(merged.phase === 'validating', 'state already under the real id wins the merge')
ok(merged.activity.length >= 2, `both halves keep their activity (${merged.activity.length} entries)`)

await meta.rename('nothing-here', 'sess-two')
ok((await meta.get('sess-two')).phase === 'validating', 'renaming a key that does not exist is a no-op')
await meta.rename('sess-two', 'sess-two')
ok((await meta.get('sess-two')).phase === 'validating', 'renaming a key to itself does not delete it')

// --- subtasks follow their parent across the same swap -----------------------
//
// A split happens seconds into the parent's first turn, which is exactly when
// the parent's key changes from its run id to Claude Code's session id. The
// subtasks point AT that key. Without repointing them here they are orphaned
// the moment the parent gets its real identity: still running, still burning
// tokens, with nothing on the board joining them to the task they came from.
await meta.update('run-11-parent', { phase: 'planning' })
await meta.update('run-12-childA', { phase: 'implementing', parent: 'run-11-parent' })
await meta.update('run-13-childB', { phase: 'implementing', parent: 'run-11-parent' })
await meta.rename('run-11-parent', 'sess-parent')
ok((await meta.get('run-12-childA')).parent === 'sess-parent', 'a subtask follows its parent to the real id')
ok((await meta.get('run-13-childB')).parent === 'sess-parent', 'and so does every sibling')

// And the child's own key changes too, a moment later. Its pointer must survive
// its own adoption unchanged.
await meta.rename('run-12-childA', 'sess-childA')
ok((await meta.get('sess-childA')).parent === 'sess-parent',
   "a subtask adopting its OWN session id keeps pointing at its parent")
ok((await meta.get('run-12-childA')).parent === undefined, 'and leaves nothing behind under the run id')

// A parent with no entry of its own — deleted, or archived away — must still
// have its children repointed, or they dangle at a key that will never exist.
await meta.update('run-14-orphan', { phase: 'implementing', parent: 'run-15-ghost' })
await meta.rename('run-15-ghost', 'sess-ghost')
ok((await meta.get('run-14-orphan')).parent === 'sess-ghost',
   'children are repointed even when the parent has no sidecar entry to move')

// Reloading from disk must see the same thing: `parent` has to be one of the
// fields the sidecar actually persists, not one that only lives in memory.
const reloaded = new MetaStore(dir, root)
ok((await reloaded.get('sess-childA')).parent === 'sess-parent', 'the parent link survives a reload')

// --- the model picker's own data ---------------------------------------------
//
// The picker shipped saying every model had a 200K context. Two of the three
// are 1M. Nothing failed — the live meter reads the window the SDK reports per
// run, so the wrong number sat under the picker as a plain lie about which
// model to pick for a big job.

const { MODELS, windowLabel } = await import('../meta.ts')

ok(MODELS.length > 0, `the picker offers ${MODELS.length} models`)

// The documented context windows, stated here rather than imported: this file
// is deliberately the second place that has to be edited, so a wrong number has
// to be typed twice to get through. It said 200K for all three once.
const CONTEXT: Record<string, string> = {
  'claude-opus-5': '1M',
  'claude-sonnet-5': '1M',
  'claude-haiku-4-5': '200K',
}
for (const m of MODELS) {
  const expected = CONTEXT[m.id]
  ok(expected !== undefined, `model id is one this file knows the window for: ${m.id}`)
  if (expected) ok(m.context === expected, `${m.label} shows its real window: ${m.context} (expected ${expected})`)
}

// The label under the picker and the denominator of the meter beside it are now
// ONE number. They were two, and a session on a 1M model was drawn against a
// 200K label — the sort of disagreement nobody notices until the meter is
// wrong by a factor of five.
const { MODEL_WINDOWS } = await import('../usage.ts')
for (const m of MODELS) {
  ok(!!MODEL_WINDOWS[m.id], `${m.label} has a window the meter can measure against`)
  ok(m.context === windowLabel(MODEL_WINDOWS[m.id]),
     `${m.label}'s picker label is derived from that same window (${m.context})`)
}

// Dated snapshot suffixes are not the documented ids, and they go stale as
// snapshots move. `claude-haiku-4-5-20251001` was one.
for (const m of MODELS) {
  ok(!/-\d{8}$/.test(m.id), `${m.label} uses the canonical undated id: ${m.id}`)
}

// --- fields that must survive a reload, not just a write ---------------------
//
// `contextWindow` was written by every run and dropped by the reader, so the
// figure the meter measures against was lost on the next launch — the exact
// failure it was added to prevent. The running mark would have gone the same
// way. Anything persisted is worth reading back at least once.
await meta.update('s-reload', { contextWindow: 200_000, running: 1_700_000_000_000 })
{
  const reloaded = await new MetaStore(dir, root).get('s-reload')
  ok(reloaded.contextWindow === 200_000, `the context window survives a reload (${reloaded.contextWindow})`)
  ok(reloaded.running === 1_700_000_000_000, `and the running mark (${reloaded.running})`)
}
// Zero is how the mark is cleared, and `undefined` cannot do it: stripUndefined
// drops it from the patch, so the old value would simply stay.
await meta.update('s-reload', { running: 0 })
ok(!(await new MetaStore(dir, root).get('s-reload')).running, 'and zero clears it, through a reload too')

// --- surviving the extension changing its own identity -----------------------
//
// The board's phases live in VS Code's global storage, whose path is derived
// from `<publisher>.<name>`. Rename either — as this extension did, from
// `david.claude-kanban` to `smile1294.agents-kanban` — and the next install
// reads an EMPTY sidecar while Claude Code still has every session. Every card
// then falls back to the default phase, which is what "all my tasks moved to
// Planning after reinstalling" actually was. So a missing sidecar looks for a
// previous incarnation of itself before concluding this is a first run.
{
  const gs = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-gs-'))
  const ws = '/Users/x/proj'
  const file = `${encodeURIComponent(ws)}.json`

  const old1 = path.join(gs, 'david.claude-kanban', 'sessions')
  await fs.mkdir(old1, { recursive: true })
  await fs.writeFile(path.join(old1, file), JSON.stringify({
    s1: { phase: 'complete', tags: ['done'], archived: false, pinned: false, activity: [] },
    s2: { phase: 'validating', tags: [], archived: false, pinned: false, activity: [] },
  }))

  const renamed = new MetaStore(path.join(gs, 'smile1294.agents-kanban'), ws)
  ok((await renamed.get('s1')).phase === 'complete', 'a renamed extension recovers the phase it recorded before')
  ok((await renamed.get('s2')).phase === 'validating', 'for every session, not just the first')
  ok((await renamed.get('s1')).tags.join(',') === 'done', 'and the tags with it')

  // Recovered once and written through, so the next launch has its own copy
  // and does not depend on the old install still being on disk.
  const copied = path.join(gs, 'smile1294.agents-kanban', 'sessions', file)
  ok(await fs.access(copied).then(() => true, () => false), 'the recovered state is written to the new location')
  await fs.rm(path.join(gs, 'david.claude-kanban'), { recursive: true, force: true })
  ok((await new MetaStore(path.join(gs, 'smile1294.agents-kanban'), ws).get('s1')).phase === 'complete',
     'and survives the old install being removed')

  // The newest wins: renamed twice, the board should come back as it was left.
  const gs2 = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-gs2-'))
  for (const [id, phase, age] of [['a.one', 'backlog', 20_000], ['b.two', 'complete', 1_000]] as const) {
    const d = path.join(gs2, id, 'sessions')
    await fs.mkdir(d, { recursive: true })
    const f = path.join(d, file)
    await fs.writeFile(f, JSON.stringify({ s1: { phase, tags: [], archived: false, pinned: false, activity: [] } }))
    const when = new Date(Date.now() - age)
    await fs.utimes(f, when, when)
  }
  ok((await new MetaStore(path.join(gs2, 'c.three'), ws).get('s1')).phase === 'complete',
     'the most recently written previous install wins')

  // Never at the expense of state we already have.
  const gs3 = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-gs3-'))
  const mineDir = path.join(gs3, 'mine.ext')
  const theirs = path.join(gs3, 'other.ext', 'sessions')
  await fs.mkdir(theirs, { recursive: true })
  await fs.writeFile(path.join(theirs, file), JSON.stringify({
    s1: { phase: 'backlog', tags: [], archived: false, pinned: false, activity: [] },
    // Sessions the new install never heard of. This is the real shape of the
    // bug: the rename happened, one session was worked on afterwards, and the
    // other four were left behind in a directory nothing reads.
    s2: { phase: 'complete', tags: ['old'], archived: false, pinned: false, activity: [] },
    s3: { phase: 'validating', tags: [], archived: false, pinned: false, activity: [] },
  }))
  // Written straight to disk, NOT through a store: the new install's file must
  // already exist before anything reads it, or the first store to touch it
  // adopts the old file wholesale and the case under test never happens. That
  // is the user's actual situation — reinstall, work on one session, and the
  // other four are stranded behind a file that now exists.
  await fs.mkdir(path.join(mineDir, 'sessions'), { recursive: true })
  await fs.writeFile(path.join(mineDir, 'sessions', file), JSON.stringify({
    s1: { phase: 'implementing', tags: [], archived: false, pinned: false, activity: [] },
  }))
  {
    const merged = new MetaStore(mineDir, ws)
    ok((await merged.get('s1')).phase === 'implementing',
       'an existing sidecar is never overwritten by an older one')
    // ...but a session it has NEVER heard of is not a conflict. Session ids are
    // globally unique, so an entry we do not have cannot be about something
    // else — and the alternative is showing it in the default column, which is
    // the bug. Without this the four sessions stranded by the real rename stay
    // stranded, because the new install had already written a file.
    ok((await merged.get('s2')).phase === 'complete', 'a session only the old install knew about is adopted')
    ok((await merged.get('s2')).tags.join(',') === 'old', 'with its tags')
    ok((await merged.get('s3')).phase === 'validating', 'all of them, not just the first')
  }

  // Once, and only once. Merging on every load would resurrect a session the
  // user deleted, every time they deleted it.
  await new MetaStore(mineDir, ws).remove('s2')
  ok((await new MetaStore(mineDir, ws).get('s2')).phase === 'planning',
     'a deleted session stays deleted — the merge does not run again')

  // A genuine first run stays a first run.
  const gs4 = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-gs4-'))
  ok((await new MetaStore(path.join(gs4, 'mine.ext'), ws).get('s1')).phase === 'planning',
     'with nothing to recover, a first run is still a first run')

  // Another WORKSPACE's file is not this workspace's, however old this one is.
  const gs5 = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-gs5-'))
  const strangers = path.join(gs5, 'old.ext', 'sessions')
  await fs.mkdir(strangers, { recursive: true })
  await fs.writeFile(path.join(strangers, `${encodeURIComponent('/Users/x/somewhere-else')}.json`),
    JSON.stringify({ s1: { phase: 'complete', tags: [], archived: false, pinned: false, activity: [] } }))
  ok((await new MetaStore(path.join(gs5, 'new.ext'), ws).get('s1')).phase === 'planning',
     'recovery is per workspace — another folder\'s board is not adopted')
}

console.log(fails === 0 ? 'PASS — session metadata persists outside the repo, with multiple tags' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
