/**
 * The dialog indirection: one code path, two sinks. This pins the sink choice —
 * default vs. per-context vs. remote — and the relay sink's post/resolve loop,
 * because a dialog that never answers, or answers the wrong dialog, is a host
 * method stranded on a Promise that can never settle.
 */
import {
  confirm,
  input,
  isRemoteDialog,
  makeRelayDialogSink,
  pick,
  setDefaultDialogSink,
  toast,
  withDialogSink,
  withRemoteDialogSink,
  type DialogSink,
  type RemoteDialogSpec,
} from '../dialogs.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

const recordSink = (calls: string[]): DialogSink => ({
  confirm: async (t, o) => { calls.push(`confirm:${t}:${o.modal ?? false}`); return 'yes' },
  input: async (o) => { calls.push(`input:${o.prompt}`); return 'typed' },
  pick: async (items, o) => { calls.push(`pick:${items.length}:${o.many ?? false}`); return items },
  toast: (l, t, url) => { calls.push(`toast:${l}:${t}:${url ?? ''}`) },
})

// --- no sink installed: an honest cancel, never a throw ----------------------

{
  ok(await confirm('q') === undefined, 'no sink installed: confirm resolves undefined')
  ok(await input({}) === undefined, 'no sink installed: input resolves undefined')
  ok(await pick([{ label: 'a' }]) === undefined, 'no sink installed: pick resolves undefined')
  toast('info', 'x') // must not throw
  ok(true, 'no sink installed: toast is a no-op, not a throw')
}

// --- the default sink --------------------------------------------------------

{
  const calls: string[] = []
  setDefaultDialogSink(recordSink(calls))
  ok(await confirm('delete?', { modal: true }) === 'yes', 'confirm routes to the default sink')
  ok(await input({ prompt: 'name' }) === 'typed', 'input routes to the default sink')
  ok(await pick([{ label: 'a' }, { label: 'b' }]) !== undefined, 'pick routes to the default sink')
  toast('warning', 'careful', 'https://x')
  ok(calls.join('|') === 'confirm:delete?:true|input:name|pick:2:false|toast:warning:careful:https://x',
    'each dialog reaches the default sink with its args intact')
}

// --- the context marks remote vs local ---------------------------------------

{
  // Read through an object so TS does not narrow the flag to its initialiser:
  // the mutation happens inside a callback TS cannot see ran.
  const remote = { v: true }
  await withRemoteDialogSink(recordSink([]), async () => { remote.v = isRemoteDialog() })
  ok(remote.v === true, 'withRemoteDialogSink marks the dispatch remote')

  const local = { v: true }
  await withDialogSink(recordSink([]), async () => { local.v = isRemoteDialog() })
  ok(local.v === false, 'withDialogSink marks the dispatch local')

  ok(isRemoteDialog() === false, 'outside any context is not remote')
}

// --- the relay sink: post, wait, resolve -------------------------------------

function relay(timeoutMs = 60_000): { handle: ReturnType<typeof makeRelayDialogSink>; posts: object[] } {
  const posts: object[] = []
  return { handle: makeRelayDialogSink((ev) => posts.push(ev), timeoutMs), posts }
}

{
  const { handle, posts } = relay()
  const p = handle.sink.confirm('Delete this?', { choices: ['Delete', 'Cancel'], level: 'warning' })
  const posted = posts[0] as { type: string; kind: string; id: string; spec: RemoteDialogSpec }
  ok(posted.type === 'remote' && posted.kind === 'dialog', 'a remote confirm posts a dialog event')
  ok(posted.spec.text === 'Delete this?' && posted.spec.level === 'warning'
    && posted.spec.choices!.join(',') === 'Delete,Cancel',
    'the dialog spec carries text, level and choices for the bridge to draw')
  ok(handle.resolve(posted.id, 'Delete') === true, 'resolve matches the pending dialog')
  ok(await p === 'Delete', '…and the waiting confirm resolves with the answer')
  ok(handle.resolve(posted.id, 'Cancel') === false, 'a second resolve of the same id is stale')
}

{
  const { handle, posts } = relay()
  void handle.sink.pick([{ label: 'a' }, { label: 'b' }], { many: true })
  const posted = posts[0] as { spec: RemoteDialogSpec }
  ok(posted.spec.quickpick?.many === true && posted.spec.quickpick.items.length === 2,
    'a remote multi-pick posts a quickpick spec with many:true')
}

{
  const { handle, posts } = relay()
  handle.sink.toast('error', 'nope', 'https://x')
  const posted = posts[0] as { type: string; kind: string; spec: { level: string; text: string; url: string } }
  ok(posted.type === 'remote' && posted.kind === 'toast'
    && posted.spec.level === 'error' && posted.spec.text === 'nope' && posted.spec.url === 'https://x',
    'a remote toast posts a toast event with level, text and url')
}

{
  const { handle } = relay(5)
  const p = handle.sink.confirm('will anyone answer?', {})
  ok(await p === undefined, 'a dialog nobody answers times out to an honest cancel')
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('dialogs: all ok')
