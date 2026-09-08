/**
 * The WRITE half of Remote Control, host side: what the extension does with a
 * command queue it fetched from the relay. The policy this file pins is the
 * whole feature's safety story — the toggle, the nonce, the session re-check —
 * and it must hold for input the relay hands over as-is, because the relay's
 * queue is written by a browser the host does not control.
 *
 * The rules asserted here agree, character for character, with the relay's
 * (functions/board-core.mjs in the sibling agents-kanban-relay repository):
 * the host must not accept what the relay refused, and the relay must not
 * refuse what the host would act on. The agreement is pinned by
 * remote-contract.json, which both repos carry verbatim and which
 * scripts/check-contract.mjs checks on every verify.
 */
import {
  acceptCommands,
  CMD_TEXT_MAX,
  NONCE_OK,
  parseCommands,
  RemoteCommandClient,
  SETTING_OK,
  THINKING_OK,
  type AcceptCtx,
} from '../commands.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

/** An accept-context the test drives by hand. */
function ctx(over: Partial<AcceptCtx> = {}): AcceptCtx & { seen: Set<string>; exists: Set<string> } {
  const seen = new Set<string>()
  const exists = new Set<string>()
  return {
    writesEnabled: true,
    sessionExists: (key: string) => exists.has(key),
    seenNonce: (n) => seen.has(n),
    rememberNonce: (n) => seen.add(n),
    ...over,
    seen,
    exists,
  }
}

// --- parseCommands: a defensive read of an outsider's JSON -------------------

{
  const good = [{ nonce: 'n1', text: '  fix the build  ', session: 'abc' }, { nonce: 'n2', text: 'go' }]
  const parsed = parseCommands(good)
  ok(parsed.length === 2 && parsed[0]!.text === 'fix the build' && parsed[0]!.session === 'abc',
    'a well-formed batch parses, and text is trimmed')
  ok(parsed[1]!.session === undefined, 'a command without a session starts a new session')

  const junk = parseCommands([
    null, 42, 'hi', {},
    { nonce: 'nope nope', text: 'x' }, // nonce with a space
    { nonce: 'n3' }, // no text
    { nonce: 'n4', text: '   ' }, // blank text
    { nonce: 'n5', text: 'x'.repeat(CMD_TEXT_MAX + 1) }, // over the relay's cap
    { nonce: 'n6', text: 'x', session: 'a/b' }, // session not key-shaped
    { nonce: 'n7', text: 'x', session: 42 },
  ])
  ok(junk.length === 0,
    'anything not exactly a command is dropped — nonce, text and session are each validated')

  const mixed = parseCommands([{ nonce: 'n8', text: 'ok' }, { nonce: 'bad nonce', text: 'x' }])
  ok(mixed.length === 1 && mixed[0]!.nonce === 'n8', 'one bad row does not poison the batch')
}

// The composer picks (model / effort / thinking) ride the same command, and are
// validated by the same rules the relay applies — a model id is a blob-safe
// string, thinking is the closed enabled|disabled set.
{
  const picked = parseCommands([{
    nonce: 'n1', text: 'go', model: 'claude-sonnet-5', effort: 'high', thinking: 'disabled',
  }])
  ok(picked.length === 1 && picked[0]!.model === 'claude-sonnet-5'
    && picked[0]!.effort === 'high' && picked[0]!.thinking === 'disabled',
    'model, effort and thinking round-trip verbatim')

  const bad = parseCommands([
    { nonce: 'n1', text: 'go', model: 'not a model!' }, // space, not setting-shaped
    { nonce: 'n2', text: 'go', effort: 42 }, // not a string
    { nonce: 'n3', text: 'go', thinking: 'maybe' }, // not enabled|disabled
    { nonce: 'n4', text: 'go', model: 'x'.repeat(121) }, // over the length cap
  ])
  ok(bad.length === 0, 'a bad model, effort or thinking shape drops the whole row')

  const bare = parseCommands([{ nonce: 'n1', text: 'go' }])
  ok(bare[0]!.model === undefined && bare[0]!.effort === undefined && bare[0]!.thinking === undefined,
    'no picks means no fields — the host falls back to its own dials')
}

// --- the toggle: THE gate ----------------------------------------------------

{
  const c = ctx({ writesEnabled: false })
  const r = await acceptCommands([{ nonce: 'n1', text: 'please run this' }], c)
  ok(r.accepted.length === 0, 'with writes OFF nothing is accepted — never run')
  ok(r.ack.length === 0,
    '…and nothing is acked: the relay keeps the command, and enable-time flush discards it')
  ok(c.seen.size === 0, 'an off-channel command is not marked seen either')
}

// --- the nonce: re-delivery must not re-run ----------------------------------

{
  const c = ctx()
  const first = await acceptCommands([{ nonce: 'n1', text: 'go' }], c)
  ok(first.accepted.length === 1 && first.ack.length === 1, 'a fresh command is accepted and acked')
  const again = await acceptCommands([{ nonce: 'n1', text: 'go' }], c)
  ok(again.accepted.length === 0 && again.ack.length === 1,
    'the same nonce again is acked but never re-accepted — a retry, not a second run')
  ok(c.seen.size === 1, 'the nonce memory holds one entry')
}

// --- the session: validated against the LIVE board ---------------------------

{
  const c = ctx()
  c.exists.add('abc')
  const r = await acceptCommands([{ nonce: 'n1', text: 'go', session: 'abc' }], c)
  ok(r.accepted.length === 1, 'a command naming a session the board has is accepted')

  const gone = await acceptCommands([{ nonce: 'n2', text: 'go', session: 'gone' }], ctx())
  ok(gone.accepted.length === 0 && gone.ack.length === 1,
    'a command naming a session the board no longer has is acked and dropped — never re-targeted')
}

{
  // The async form: sessionExists may need a store read.
  const c = ctx({ sessionExists: async (key) => key === 'abc' })
  const r = await acceptCommands([{ nonce: 'n1', text: 'go', session: 'abc' }], c)
  ok(r.accepted.length === 1, 'an async existence check works the same way')
}

// --- the client: URL shape and ack body, pinned ------------------------------

{
  const calls: Array<{ url: string; method?: string; key?: string; body?: string }> = []
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method,
      key: String((init?.headers as Record<string, string> | undefined)?.['x-rc-key'] ?? ''),
      body: String(init?.body ?? ''),
    })
    return { ok: true, status: 200, json: async () => ({ ok: true, cmds: [{ nonce: 'n1', text: 'x' }] }) } as Response
  }
  const client = new RemoteCommandClient({
    baseUrl: 'https://board.example.com',
    boardId: '0123456789abcdef01234567',
    fetch: fetch as unknown as typeof fetch,
  })
  ok(client.ready === true, 'a client with a base and an id is ready')
  const cmds = await client.poll()
  ok(Array.isArray(cmds) && (cmds as unknown[]).length === 1,
    'poll() asks ?cmds=1 and returns the raw cmds payload for the policy to judge')
  ok(calls[0]!.url === 'https://board.example.com/board?id=0123456789abcdef01234567&cmds=1',
    'the poll URL is <site>/board?id=<id>&cmds=1 — the path every host serves')

  await client.ack(['n1', 'n2'])
  ok(calls[1]!.method === 'POST' && calls[1]!.url === 'https://board.example.com/board',
    'ack posts to /board')
  ok(calls[1]!.key === '0123456789abcdef01234567', '…with the board id in x-rc-key')
  ok(calls[1]!.body === JSON.stringify({ kind: 'ack', nonces: ['n1', 'n2'] }),
    '…and a { kind: "ack", nonces } body')

  const emptyAck = new RemoteCommandClient({
    baseUrl: 'https://board.example.com', boardId: '0123456789abcdef01234567',
    fetch: fetch as unknown as typeof fetch,
  })
  await emptyAck.ack([])
  ok(calls.length === 2, 'acking nothing posts nothing')
  ok(new RemoteCommandClient({
    baseUrl: '', boardId: '0123456789abcdef01234567', fetch,
  }).ready === false, 'no base, not ready')
  ok(new RemoteCommandClient({
    baseUrl: 'https://board.example.com', boardId: '', fetch,
  }).ready === false, 'no board id (no pairing code), not ready')
}

// --- the two ends agree on the limits, through the contract ------------------
// The host must not accept what the relay refused (and vice versa); a drifted
// copy of either rule is a command that dies on the wire, silently. This file
// cannot import the relay's board-core.mjs (it lives in another repository),
// so both ends are pinned to remote-contract.json — the relay side by its own
// tests/contract.test.mjs, this side by scripts/check-contract.mjs in verify.
// These literals are a sanity gate on the code itself, on top of that file.
{
  ok(NONCE_OK.source === '^[A-Za-z0-9._-]{1,64}$', 'NONCE_OK is the literal both ends carry')
  ok(CMD_TEXT_MAX === 20_000, 'CMD_TEXT_MAX is 20000 on both ends')
  ok(!NONCE_OK.test('a b') && NONCE_OK.test('n1') && NONCE_OK.test('a'.repeat(64)) && !NONCE_OK.test('a'.repeat(65)),
    'the nonce rule itself: ack-handle-shaped strings only, bounded')
  ok(SETTING_OK.source === '^[A-Za-z0-9._-]{1,120}$', 'SETTING_OK is the literal both ends carry')
  ok(THINKING_OK.source === '^(enabled|disabled)$', 'THINKING_OK is the literal both ends carry')
  ok(SETTING_OK.test('claude-sonnet-5') && !SETTING_OK.test('not a model!') && !SETTING_OK.test('a'.repeat(121)),
    'a model id / effort key is a short, blob-safe string — never a provider or a credential')
  ok(THINKING_OK.test('enabled') && THINKING_OK.test('disabled') && !THINKING_OK.test('maybe'),
    'thinking is the closed enabled|disabled set')
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('commands: all ok')
