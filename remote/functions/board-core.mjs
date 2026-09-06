/* The relay function's logic, with the store injected.
 *
 * Netlify's function wrapper (board.mjs) supplies the real blob store; this
 * module runs in this repository's test suite against a fake one, so the
 * relay's behaviour — the write gate, the storage names, the orphan-tail GC —
 * is pinned without a network or a Netlify account.
 *
 * The threat model is small and worth stating:
 *
 *  - The relay stores NOTHING secret. A board's address is the sha-256 of the
 *    pairing code, and the pairing code exists only on the machine pushing and
 *    in the watcher's browser. The relay cannot be robbed for codes it never
 *    had.
 *  - Possession of a board's id grants read AND write of that board's mirror.
 *    That is the trade for having no server-side secret: the code is a single
 *    capability, and the mirror is disposable — a viewer gone wrong can junk
 *    the mirror, never the real board.
 *  - A board id is 24 hex chars of a sha-256 (~96 bits). Nobody guesses one;
 *    nobody can LIST the boards, because list happens under one fixed store and
 *    no endpoint enumerates ids.
 *
 * Same key rule as the extension side (`relay.ts` KEY_OK): a session key rides
 * in a blob name, so it must be safe there.
 */
export const ID_OK = /^[0-9a-f]{24}$/i
export const KEY_OK = /^[A-Za-z0-9._-]{1,80}$/
const indexBlob = (id) => `i:${id}`
const tailBlob = (id, key) => `t:${id}:${key}`

/** The store interface this module needs (the real one has more). */
export const ok = (json) => ({ status: 200, json })
export const fail = (status, error) => ({ status, json: { ok: false, error } })

/**
 * req: {
 *   method: 'GET' | 'POST',
 *   boardId: string,        // from ?id= (GET) or the x-rc-key header (POST)
 *   key: string,            // the x-rc-key header, when there was one
 *   tailKey?: string,       // GET ?tail=<session key>
 *   body?: unknown,         // POST body, parsed
 * }
 * store: { set(k, text), get(k) -> string|null, delete(k), list({prefix}) -> {blobs:[{key}]} }
 */
export async function handle(req, store) {
  const id = req.boardId || ''
  if (!ID_OK.test(id)) return fail(400, 'not a board address')

  if (req.method === 'POST') {
    // The write gate: the id IS the credential, and it travels in x-rc-key.
    // There is no stored secret to compare against — the gate is that the
    // writer knows the id that names the board.
    if (req.key !== id) return fail(401, 'this relay only accepts a board’s own key')

    const body = req.body
    if (!body || typeof body !== 'object' || body.kind !== 'update') {
      return fail(400, 'expected { kind: "update" }')
    }
    const idx = body.index
    if (!idx || idx.v !== 1 || !Array.isArray(idx.columns) || !idx.sessions
        || typeof idx.sessions !== 'object' || Array.isArray(idx.sessions)) {
      return fail(400, 'malformed index')
    }
    const keys = Object.keys(idx.sessions)
    for (const k of keys) {
      if (!KEY_OK.test(k)) return fail(400, 'a session key is not usable in a blob name')
    }
    const tails = Array.isArray(body.tails) ? body.tails : []
    for (const t of tails) {
      if (!t || typeof t !== 'object' || typeof t.key !== 'string' || !KEY_OK.test(t.key)
          || !Array.isArray(t.entries)) {
        return fail(400, 'a malformed tail')
      }
      // A tail whose session is not on the board is unreachable (the page only
      // fetches what the index tells it to), so it is a bug, not a payload.
      if (!keys.includes(t.key)) return fail(400, `a tail names a session the index does not: ${t.key}`)
    }

    // The index is REPLACED, each tail is REPLACED — the extension pushes whole
    // tails and the whole board picture, and the relay never merges, because a
    // merge is where a stale row survives a deletion.
    await store.set(indexBlob(id), JSON.stringify(idx))
    for (const t of tails) await store.set(tailBlob(id, t.key), JSON.stringify(t))

    // Garbage-collect the tails of sessions that left the board (archived or
    // removed): the index is the list of what exists, anything else is stale.
    const prefix = `t:${id}:`
    const { blobs } = await store.list({ prefix })
    for (const b of blobs) {
      const key = b.key.slice(prefix.length)
      if (!keys.includes(key)) await store.delete(b.key)
    }
    return ok({ ok: true })
  }

  if (req.method === 'GET') {
    if (req.tailKey !== undefined) {
      if (!KEY_OK.test(req.tailKey)) return fail(400, 'not a session')
      const raw = await store.get(tailBlob(id, req.tailKey))
      if (!raw) return fail(404, 'no chat for this session yet')
      return ok({ ok: true, tail: JSON.parse(raw) })
    }
    const raw = await store.get(indexBlob(id))
    if (!raw) return fail(404, 'no board here yet — waiting for the first push from the extension')
    return ok({ ok: true, index: JSON.parse(raw) })
  }

  return fail(405, 'only GET and POST are served')
}
