/**
 * The write-half gate: which queued messages this machine acts on. `parseMessages`
 * is the defensive read of outsider JSON; `acceptMessages` is the policy — the
 * toggle, the nonce, the dialog-answer routing. `RemoteMessageClient` is the
 * transport, pinned here so the URL shape and the ack/event bodies are tested,
 * not just believed.
 */
import {
  acceptMessages,
  MSG_MAX_BYTES,
  NONCE_OK,
  parseMessages,
  RemoteMessageClient,
  TYPE_OK,
  type AcceptCtx,
} from '../messages.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

const msg = (type: string, extra: Record<string, unknown> = {}): { type: string } & Record<string, unknown> =>
  ({ type, ...extra })

// --- the wire rules ----------------------------------------------------------

ok(NONCE_OK.test('abc-1._x') && !NONCE_OK.test('') && !NONCE_OK.test('a/b') && !NONCE_OK.test('a'.repeat(65)),
  'a nonce is a short, dot-safe ack handle')
ok(TYPE_OK.test('sendMessage') && TYPE_OK.test('remote.dialog') && TYPE_OK.test('voiceAudio')
  && !TYPE_OK.test('1bad') && !TYPE_OK.test('') && !TYPE_OK.test('a'.repeat(41)),
  'a message type is a short, dot-safe name starting with a letter')

// --- parseMessages -----------------------------------------------------------

{
  const parsed = parseMessages([
    { nonce: 'n1', msg: { type: 'send', id: 'a', text: 'hi' } },
    { nonce: 'n2', msg: { type: 'newSession' } },
    'not an object',
    { nonce: 'bad/nonce', msg: { type: 'send' } },
    { nonce: 'n3', msg: 42 },
    { nonce: 'n4', msg: { type: 'has space' } },
    { nonce: 'n5', msg: { type: 'send', text: 'x'.repeat(MSG_MAX_BYTES + 1) } },
    null,
  ])
  ok(parsed.length === 2 && parsed[0]!.nonce === 'n1' && parsed[1]!.nonce === 'n2',
    'only well-formed queued messages survive — bad nonce, bad type, bad shape and oversize all drop')
  ok(parsed[0]!.msg.type === 'send' && parsed[0]!.msg.text === 'hi',
    'the surviving message is handed over unchanged')
  ok(parseMessages(undefined).length === 0 && parseMessages('x').length === 0,
    'a non-array is an empty batch, not a throw')
}

// --- acceptMessages: the policy ---------------------------------------------

function ctx(over: Partial<AcceptCtx> = {}): AcceptCtx & { seen: string[]; remembered: string[]; resolved: [string, unknown][] } {
  // One store, as the host keeps it: seen and remembered are the same memory.
  const seen: string[] = []
  const resolved: [string, unknown][] = []
  return {
    writesEnabled: true,
    seenNonce: (n) => seen.includes(n),
    rememberNonce: (n) => { seen.push(n) },
    resolveDialog: (id, answer) => { resolved.push([id, answer]); return true },
    ...over,
    seen, remembered: seen, resolved,
  }
}

{
  const c = ctx({ writesEnabled: false })
  const { accepted, ack } = acceptMessages([{ nonce: 'n1', msg: msg('send') }], c)
  ok(accepted.length === 0 && ack.length === 0,
    'with the toggle OFF, nothing is run and nothing is acked — the relay keeps the queue')
}

{
  const c = ctx()
  const { accepted, ack } = acceptMessages([{ nonce: 'n1', msg: msg('send') }], c)
  ok(accepted.length === 1 && accepted[0]!.nonce === 'n1', 'a fresh message is accepted')
  ok(c.remembered.includes('n1') && ack.includes('n1'), 'its nonce is remembered and acked')

  const again = acceptMessages([{ nonce: 'n1', msg: msg('send') }], c)
  ok(again.accepted.length === 0 && again.ack.includes('n1'),
    'a re-delivered nonce is re-acked and NOT run again')
}

{
  const c = ctx()
  const { accepted, ack } = acceptMessages([{ nonce: 'd1', msg: { type: 'remote.dialog', id: '7', answer: 'Delete' } }], c)
  ok(accepted.length === 0, 'a dialog answer is never dispatched to the board')
  ok(ack.includes('d1') && c.resolved.length === 1 && c.resolved[0]![0] === '7' && c.resolved[0]![1] === 'Delete',
    'it is routed to the waiting dialog and acked regardless')
}

{
  const c = ctx()
  const { ack } = acceptMessages([
    { nonce: 'n1', msg: msg('send') },
    { nonce: 'n2', msg: msg('send') },
  ], c)
  ok(ack.length === 2 && c.remembered.length === 2, 'a batch is acted on and acked together')
}

// --- RemoteMessageClient: the transport -------------------------------------

interface Call { url: string; init?: RequestInit }

function clientWith(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): { client: RemoteMessageClient; calls: Call[] } {
  const calls: Call[] = []
  const client = new RemoteMessageClient({
    baseUrl: 'https://board.example.com',
    boardId: '0123456789abcdef01234567',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return handler(url, init)
    }) as unknown as typeof fetch,
  })
  return { client, calls }
}

const res = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, json: async () => body }) as Response

{
  const { client, calls } = clientWith(() => res({ ok: true, msgs: [{ nonce: 'n1', msg: { type: 'send' } }], viewerAt: 42 }))
  const out = await client.poll()
  ok(calls.length === 1 && calls[0]!.url === 'https://board.example.com/board?id=0123456789abcdef01234567&msgs=1',
    'poll GETs the queue from the relay API path, asking for messages')
  ok(out.msgs !== undefined && out.viewerAt === 42, 'poll returns both the queue and the viewer time')
}

{
  const { client, calls } = clientWith(() => res({ ok: false }))
  let threw = ''
  try { await client.poll() } catch (e) { threw = String(e) }
  ok(!!threw && threw.includes('refused'), 'a relay that refuses the poll throws, rather than running nothing silently')
}

/* --- the HELD poll ---------------------------------------------------------
   The page has long-polled for frames since v2; the machine polled the message
   queue on a timer, so a tap sat there for up to a full interval. That was one
   of the two 0-2000 ms waits either side of ~70 ms of work. */

{
  const { client, calls } = clientWith(() => res({ ok: true, msgs: [], viewerAt: 1, longPoll: true }))
  const out = await client.poll(20)
  ok(calls[0]!.url.endsWith('&msgs=1&wait=20'), 'a held poll asks the relay to wait')
  ok(out.longPoll === true,
    'and reports that this relay HELD it — the host loops straight back only on a holder')
}

{
  const { client } = clientWith(() => res({ ok: true, msgs: [], viewerAt: 1 }))
  const out = await client.poll(20)
  ok(out.longPoll === undefined,
    'a relay that did NOT say it holds is never assumed to — Netlify and the worker answer at once')
}

{
  const { client, calls } = clientWith(() => res({ ok: true, msgs: [] }))
  await client.poll()
  ok(!calls[0]!.url.includes('wait='), 'no wait asked for means no wait in the URL')
  await client.poll(0)
  ok(!calls[1]!.url.includes('wait='), 'a wait outside the contract range is dropped, not sent')
  await client.poll(9999)
  ok(!calls[2]!.url.includes('wait='), '…at both ends')
}

{
  /* The abort budget has to cover the hold. Left at the fixed 10 s, a 20 s hold
     would abort every single time and the queue would never be read — the
     feature would look like a dead relay. */
  const seen: (number | undefined)[] = []
  const { client } = clientWith((_u, init) => {
    const sig = init?.signal as AbortSignal & { __ms?: number }
    seen.push(sig ? 1 : undefined)
    return res({ ok: true, msgs: [] })
  })
  const started = Date.now()
  await client.poll(20)
  ok(seen[0] === 1, 'a held poll still carries an abort signal — it must not hang forever')
  ok(Date.now() - started < 1_000, '…and it does not itself block')
}

{
  const { client, calls } = clientWith(() => res({ ok: true }))
  await client.ack(['n1', 'n2'])
  const body = JSON.parse(String(calls[0]!.init?.body)) as { kind: string; nonces: string[] }
  ok(calls[0]!.init?.method === 'POST' && body.kind === 'ack' && body.nonces.join(',') === 'n1,n2',
    'ack POSTs the taken nonces under kind ack')
  const hdr = calls[0]!.init?.headers as Record<string, string> | undefined
  ok(hdr?.['x-rc-key'] === '0123456789abcdef01234567',
    'the board id rides in x-rc-key on the write')
}

{
  const { client, calls } = clientWith(() => res({ ok: true }))
  await client.postEvents([{ type: 'voice', started: false, text: 'hi' }])
  const body = JSON.parse(String(calls[0]!.init?.body)) as { kind: string; events: unknown[] }
  ok(body.kind === 'event' && body.events.length === 1, 'postEvents POSTs page events under kind event')
}

{
  const { client, calls } = clientWith(() => res({ ok: true }))
  await client.ack([])
  await client.postEvents([])
  ok(calls.length === 0, 'an empty ack or event list posts nothing')
}

{
  const noUrl = new RemoteMessageClient({ baseUrl: '', boardId: 'abc', fetch: (async () => res({})) as unknown as typeof fetch })
  const noId = new RemoteMessageClient({ baseUrl: 'https://x', boardId: '', fetch: (async () => res({})) as unknown as typeof fetch })
  ok(noUrl.ready === false && noId.ready === false, 'the client is not ready without a url AND a board id')
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('messages: all ok')
