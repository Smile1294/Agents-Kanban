import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { MetaStore, resolveEffort, resolveThinking } from '../meta.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-meta-'))
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

console.log(fails === 0 ? 'PASS — session metadata persists outside the repo, with multiple tags' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
