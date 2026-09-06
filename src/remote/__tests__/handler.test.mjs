/* The relay half of Remote Control, exercised in-repo.
 *
 * The extension pushes to a Netlify function (`remote/functions/board.mjs`)
 * that this repository does not run — but the function's LOGIC lives in
 * `remote/functions/board-core.mjs` with the blob store injected, so it runs
 * here against a fake store. This file pins the relay's contract: the write
 * gate, the storage names, replacement-not-merge, and the garbage collection
 * of tails whose session left the board.
 *
 * The import path is deliberate: remote/ is a lift-out folder (its own repo,
 * its own package.json). Importing across the boundary from src/ keeps the
 * lifted code under this repo's test runner without duplicating it.
 */
import { handle, ID_OK, KEY_OK } from '../../../remote/functions/board-core.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.error('FAIL:', m); fails++ } else console.log('ok:', m) }

/** A blob store in a Map, with just enough of @netlify/blobs' surface. */
function fakeStore() {
  const m = new Map()
  return {
    map: m,
    async set(k, v) { m.set(k, v) },
    async get(k) { return m.has(k) ? m.get(k) : null },
    async delete(k) { m.delete(k) },
    async list({ prefix }) {
      return { blobs: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }
    },
  }
}

const ID = 'a'.repeat(24) // any 24 hex chars: the derived board id
const index = (over = {}) => ({
  v: 1, at: 1000,
  columns: [{ id: 'backlog', name: 'Backlog' }],
  sessions: { abc: { key: 'abc', title: 'Fix it', phase: 'backlog', tags: [], archived: false, updated: 1000, tv: 1 } },
  ...over,
})
const tail = (key = 'abc', over = {}) => ({
  key, at: 1000,
  entries: [{ kind: 'prompt', at: 900, text: 'hello' }],
  ...over,
})
const post = (store, over = {}) => handle({
  method: 'POST',
  boardId: ID,
  key: ID,
  body: { kind: 'update', index: index(), tails: [] },
  ...over,
}, store)

// --- the write gate ----------------------------------------------------------

{
  const store = fakeStore()
  const missing = await post(store, { key: '' })
  ok(missing.status === 401, 'a POST without the board key is refused')
  const wrong = await post(store, { boardId: ID, key: 'b'.repeat(24) })
  ok(wrong.status === 401, 'a POST with another board’s key is refused')
  const badId = await post(store, { boardId: 'not-hex!' })
  ok(badId.status === 400, 'a board address that is not 24 hex chars is refused')
  ok(store.map.size === 0, '…and nothing was stored by any of them')
}

// --- a valid update stores index and tails under derived names --------------

{
  const store = fakeStore()
  const r = await post(store, { body: { kind: 'update', index: index(), tails: [tail()] } })
  ok(r.status === 200 && r.json.ok === true, 'a valid update is accepted')
  const keys = [...store.map.keys()].sort()
  ok(keys.join(',') === `i:${ID},t:${ID}:abc`, 'the index and tail blob names derive from the board id')
  const idx = JSON.parse(store.map.get(`i:${ID}`))
  ok(idx.v === 1 && idx.sessions.abc.title === 'Fix it', 'the stored index is the pushed index, verbatim')
  const t = JSON.parse(store.map.get(`t:${ID}:abc`))
  ok(t.key === 'abc' && t.entries[0].kind === 'prompt', 'the stored tail is the pushed tail')
}

// --- garbage: bad payloads store nothing -------------------------------------

{
  const store = fakeStore()
  const noKind = await post(store, { body: { index: index(), tails: [] } })
  ok(noKind.status === 400 && noKind.json.error.includes('update'), 'a body without kind "update" is refused')
  const badIdx = await post(store, { body: { kind: 'update', index: { v: 99 }, tails: [] } })
  ok(badIdx.status === 400, 'a malformed index is refused')
  const badKey = await post(store, {
    body: { kind: 'update', index: index({ sessions: { 'a/b': index().sessions.abc } }), tails: [] },
  })
  ok(badKey.status === 400 && badKey.json.error.includes('blob name'),
    'a session key that is not safe in a blob name is refused')
  const rogue = await post(store, { body: { kind: 'update', index: index(), tails: [tail('nope')] } })
  ok(rogue.status === 400 && rogue.json.error.includes('index does not'),
    'a tail naming a session the index does not carry is refused — the page could never reach it')
  ok(store.map.size === 0, '…and none of the rejects stored anything')
}

// --- replacement, not merge, and orphan-tail GC ------------------------------

{
  const store = fakeStore()
  await post(store, {
    body: {
      kind: 'update',
      index: index({ sessions: { abc: { ...index().sessions.abc, tv: 1 } } }),
      tails: [tail('abc')],
    },
  })
  const second = await post(store, {
    body: {
      kind: 'update',
      index: index({ at: 2000, sessions: { def: { key: 'def', title: 'New one', phase: 'backlog', tags: [], archived: false, updated: 2000, tv: 2 } } }),
      tails: [tail('def', { at: 2000 })],
    },
  })
  ok(second.status === 200, 'the second update is accepted')
  const keys = [...store.map.keys()].sort()
  ok(keys.join(',') === `i:${ID},t:${ID}:def`,
    'the board is replaced, never merged: abc is gone (tail garbage-collected), def is stored')
  const idx = JSON.parse(store.map.get(`i:${ID}`))
  ok(idx.at === 2000 && idx.sessions.def && !idx.sessions.abc, 'the index is the new one, verbatim')
}

// --- reads -------------------------------------------------------------------

{
  const store = fakeStore()
  const empty = await handle({ method: 'GET', boardId: ID }, store)
  ok(empty.status === 404 && empty.json.error.includes('first push'),
    'a board no one pushed to yet reads as "waiting for the first push", not as an empty board')
  await post(store, { body: { kind: 'update', index: index(), tails: [tail()] } })
  const got = await handle({ method: 'GET', boardId: ID }, store)
  ok(got.status === 200 && got.json.index.sessions.abc.tv === 1, 'the index reads back as stored')
  const t = await handle({ method: 'GET', boardId: ID, tailKey: 'abc' }, store)
  ok(t.status === 200 && t.json.tail.entries.length === 1, 'a tail reads back by session key')
  const none = await handle({ method: 'GET', boardId: ID, tailKey: 'zzz' }, store)
  ok(none.status === 404, 'a tail that was never pushed reads as 404')
  const badTail = await handle({ method: 'GET', boardId: ID, tailKey: 'a/b' }, store)
  ok(badTail.status === 400, 'a session key that is not safe is refused on reads too')
  const method = await handle({ method: 'DELETE', boardId: ID }, store)
  ok(method.status === 405, 'anything but GET and POST is refused')
}

// --- the two regexes agree with the extension's ------------------------------
// The extension has the same two rules in src/remote/relay.ts (KEY_OK and the
// 24-hex id). A drift between the two ends would push fine and store nothing.
{
  ok(ID_OK.test('0123456789abcdef01234567') && ID_OK.test('ABCDEF'.repeat(4).toLowerCase()),
    'the id rule accepts 24 hex chars')
  ok(!ID_OK.test('x'.repeat(23)) && !ID_OK.test('x'.repeat(25)) && !ID_OK.test('zz'),
    'and refuses anything else')
  ok(KEY_OK.test('abc-1._x') && !KEY_OK.test('a/b') && !KEY_OK.test('') && !KEY_OK.test('a'.repeat(81)),
    'session keys: the same rule the extension enforces before anything is sent')
}

console.log(fails ? `\n${fails} failure(s)` : '\nrelay handler: all ok')
process.exit(fails ? 1 : 0)
