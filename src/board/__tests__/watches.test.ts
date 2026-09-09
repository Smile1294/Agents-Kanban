/**
 * The watch registry: who is looking at what.
 *
 * Every rule here is one the type system cannot state and a mirror-shaped board
 * gets wrong. The registry is pure and vscode-free precisely so these can be
 * asserted without an editor; `smoke.mjs` then checks the wiring — that the
 * side bar and the panel really are answered with two different sessions.
 */
import { Watches, isLocalSink, type Mode, type Watch } from '../watches.ts'

let failures = 0
const ok = (cond: boolean, msg: string): void => {
  if (cond) console.log(`  ok: ${msg}`)
  else { console.log(`  FAIL: ${msg}`); failures++ }
}

console.log('— the watch registry')

/** A stand-in for the host's own selection, which moves for reasons that have
 *  nothing to do with a surface: a new run, a fork, an archive. */
const defaults: Watch = { key: 'host-default', mode: 'kanban' as Mode }
const make = () => new Watches(() => ({ ...defaults }))

{
  const w = make()
  ok(w.of('panel').key === 'host-default',
     'a surface that has never said anything opens what the host says — that IS the seeding')
  ok(w.of('remote').key === 'host-default', 'including a remote page on its first load')
  ok(w.sinks().length === 0, 'and nothing had to be written to make that true')
}

{
  const w = make()
  w.set('panel', { key: 'A' })
  w.set('sidebar', { key: 'B' })
  ok(w.of('panel').key === 'A' && w.of('sidebar').key === 'B',
     'two surfaces hold two sessions at once — neither is a mirror of the other')
  ok(w.of('remote').key === 'host-default',
     'and a third that has said nothing still opens the host default, not the last thing clicked')
}

{
  const w = make()
  w.set('panel', { key: 'A' })
  w.set('panel', { mode: 'chat' })
  ok(w.of('panel').key === 'A' && w.of('panel').mode === 'chat',
     'a patch merges over what the surface already had rather than replacing it')
  ok(w.of('sidebar').mode === 'kanban',
     'and the panel going to chat does not put the side bar into it')
}

{
  ok(isLocalSink('panel') && isLocalSink('sidebar'), 'the editor surfaces are local')
  ok(!isLocalSink('remote'), 'a remote page is NOT — its choice never moves the editor selection')
  ok(isLocalSink(undefined),
     'and an unnamed sink counts as local: the host acting on its own is the editor acting')
}

{
  const w = make()
  w.set('panel', { key: 'A' })
  w.set('remote', { key: 'B' })
  const keys = w.keys()
  ok(keys.has('A') && keys.has('B'), 'every watched session is named')
  ok(keys.has('host-default'),
     "the host's own default is one of them — a command still acts on it, so its review data is still needed")
  ok(keys.size === 3, 'and nothing else: this set is the BOUND on what review data is kept')
}

{
  const w = make()
  w.set('panel', { key: 'run-1' })
  w.set('sidebar', { key: 'other' })
  // A run gets its Claude Code session id a few seconds in, and its card key
  // changes with it. Only the surface watching THAT run moves.
  w.followAll((k) => (k === 'run-1' ? 'session-1' : k))
  ok(w.of('panel').key === 'session-1', 'a watch follows its run across the run-id -> session-id swap')
  ok(w.of('sidebar').key === 'other', 'and the other surface is left exactly where it was')
}

{
  const w = make()
  w.set('panel', { key: 'gone' })
  w.followAll((k) => (k === 'gone' ? undefined : k))
  ok(w.of('panel').key === 'gone',
     'a watch on a card that no longer exists is KEPT, so the surface can be told it is gone')
  ok(w.sinks().includes('panel'), 'the surface itself is untouched')
}

{
  // A fork RE-KEYS a card: it adopts the old one's phase, tags and worktree
  // under a new id, and the old id stops existing.
  const w = make()
  w.set('panel', { key: 'old' })
  w.set('sidebar', { key: 'elsewhere' })
  w.set('remote', { key: 'old' })
  w.retarget('old', 'fork-1')
  ok(w.of('panel').key === 'fork-1' && w.of('remote').key === 'fork-1',
     'every surface watching the old key follows the fork, wherever it was asked for')
  ok(w.of('sidebar').key === 'elsewhere',
     'and a surface that was looking at something else is not dragged along')
}

{
  const w = make()
  w.set(undefined, { key: 'A' })
  ok(w.sinks().length === 0, 'a message with no sink writes no watch — there is no surface to record')
  ok(w.of(undefined).key === 'host-default', 'and reading without one answers the host default')
}

{
  const w = make()
  w.set('panel', { key: 'A', mode: 'chat' })
  w.set('sidebar', { key: 'B' })
  w.set('remote', { key: 'C' })
  // The host opened something itself — the side bar's session list, a search
  // hit, a new run. In the editor that has to land on the editor's surfaces.
  w.resetLocal()
  ok(w.of('panel').key === 'host-default' && w.of('sidebar').key === 'host-default',
     'the host opening a session drops every LOCAL surface back to what it opened')
  ok(w.of('panel').mode === 'kanban',
     'including the screen it was on — openSession sets the mode, and a stale one would ignore it')
  ok(w.of('remote').key === 'C',
     'and a remote page keeps its own: somebody else is looking at it')
  ok(w.sinks().length === 1 && w.sinks()[0] === 'remote',
     'only the local entries are gone — nothing was invented to replace them')
}

{
  const w = make()
  w.set('panel', { key: 'A' })
  w.set('remote', { key: 'C' })
  ok(w.hostSelect('B', false, 'host-default') === 'B',
     "a local dispatch moves the host's own selection to what it opened")
  ok(w.of('panel').key === 'host-default',
     'and the panel follows it, because that is the editor acting on itself')
  ok(w.of('remote').key === 'C', 'while the remote page is left where it was')

  const w2 = make()
  w2.set('panel', { key: 'A' })
  w2.set('remote', { key: 'C' })
  ok(w2.hostSelect('B', true, 'host-default') === 'host-default',
     "a REMOTE dispatch does NOT move the host's selection — the answer comes back untouched")
  ok(w2.of('remote').key === 'B', 'the page moves itself instead')
  ok(w2.of('panel').key === 'A',
     'and the editor panel is not dragged along by somebody opening a chat on their phone')
}

if (failures) { console.log(`\n${failures} FAILURES`); process.exit(1) }
console.log('\nPASS — the registry answers per surface, and only a local one moves the editor')
