/**
 * The transport half of Remote Control: the cadence rules that decide when a
 * snapshot leaves this machine. fetch and the clock are injected, so the whole
 * engine is driven deterministically: a tick is awaited, time is advanced by
 * hand, and the fake fetch records what — if anything — went out.
 *
 * The three rules this file pins: never faster than MIN_INTERVAL; nothing at
 * all when nothing changed (until the heartbeat is due); and a failed attempt
 * backs off instead of hammering the relay.
 */
import {
  BACKOFF_MS,
  HEARTBEAT_MS,
  MIN_INTERVAL,
  RemotePusher,
  type PushSnapshot,
  type PushStatus,
} from '../pusher.ts'
import type { RemoteIndex } from '../relay.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

const index = (at: number, title = 'same'): RemoteIndex => ({
  v: 1, at,
  columns: [{ id: 'c', name: 'Backlog' }],
  sessions: { abc: { key: 'abc', title, phase: 'backlog', tags: [], archived: false, updated: at, tv: 0 } },
})

interface Posted {
  at: number
  url: string
  key: string
  body: { kind: string; index: RemoteIndex; tails: unknown[] }
}

interface Rig {
  pusher: RemotePusher
  now: number
  statuses: PushStatus[]
  posts: Posted[]
  /** What build() answers. Callers replace this before a tick. */
  next: PushSnapshot
  failFetchWith: Error | null
  build(): Promise<PushSnapshot>
}

function rig(opts: { enabled?: boolean; baseUrl?: string } = {}): Rig {
  const state = {
    now: 1_000_000,
    statuses: [] as PushStatus[],
    posts: [] as Posted[],
    next: { index: index(1_000_000), tails: [] } as PushSnapshot,
    failFetchWith: null as Error | null,
  }
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (state.failFetchWith) throw state.failFetchWith
    const body = JSON.parse(String(init?.body)) as Posted['body']
    state.posts.push({
      at: state.now, url: String(input),
      key: String((init?.headers as Record<string, string> | undefined)?.['x-rc-key'] ?? ''),
      body,
    })
    return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
  }
  // `now`, `next` and `failFetchWith` are accessors into `state`, NOT spread
  // copies: the tests write `r.now += n`, `r.next = …` and `r.failFetchWith`
  // while the pusher reads `state.*`. A copied field would diverge the instant
  // either side wrote it, and every cadence test would quietly test nothing
  // (it did; the heartbeat never fired until `now` became an accessor).
  const rig: Rig = {
    ...state,
    build: async (): Promise<PushSnapshot> => state.next,
    pusher: undefined as unknown as RemotePusher,
    get now(): number { return state.now },
    set now(v: number) { state.now = v },
    get next(): PushSnapshot { return state.next },
    set next(v: PushSnapshot) { state.next = v },
    get failFetchWith(): Error | null { return state.failFetchWith },
    set failFetchWith(v: Error | null) { state.failFetchWith = v },
  }
  rig.pusher = new RemotePusher({
    now: () => state.now,
    baseUrl: opts.baseUrl ?? 'https://board.example.com',
    boardId: '0123456789abcdef01234567',
    enabled: opts.enabled ?? true,
    // build goes through rig.build() so tests can swap the whole builder.
    fetch: fetch as unknown as typeof fetch,
    build: async () => rig.build(),
    onStatus: (s) => state.statuses.push(s),
  })
  return rig
}

// --- the gate ----------------------------------------------------------------

{
  const r = rig()
  r.pusher.reset()
  await r.pusher.tick()
  ok(r.posts.length === 1 && r.posts[0]!.url === 'https://board.example.com/.netlify/functions/board',
    'the first tick posts the snapshot to the relay function')
  ok(r.posts[0]!.key === '0123456789abcdef01234567', 'the board id rides in x-rc-key')
  ok(r.posts[0]!.body.index.sessions['abc']!.tv === 0, 'the index travels as posted')
}

{
  const r = rig({ enabled: false })
  await r.pusher.tick()
  ok(r.posts.length === 0 && r.statuses.length === 0,
    'a disabled relay never fetches and never reports')
}

{
  const r = rig()
  await r.pusher.tick()
  await r.pusher.tick()
  ok(r.posts.length === 1, 'a second tick within MIN_INTERVAL does nothing')
  r.now += MIN_INTERVAL
  await r.pusher.tick()
  ok(r.posts.length === 1, 'the cadence gate applies to ATTEMPTS: still nothing, nothing changed')
}

// --- dirty pushes only -------------------------------------------------------

{
  const r = rig()
  await r.pusher.tick()
  // r.next is still the byte-identical snapshot that was just pushed; time
  // passes but nothing on the board changes.
  r.now += MIN_INTERVAL + 1
  await r.pusher.tick()
  ok(r.posts.length === 1, 'an unchanged index and no tails does not push again')

  r.now += HEARTBEAT_MS
  await r.pusher.tick()
  ok(r.posts.length === 2, '…but when HEARTBEAT_MS passes since the last send, the index goes anyway')
  ok(r.statuses.at(-1)?.note === 'heartbeat — the board is idle but alive',
    'an unchanged push is labelled a heartbeat, not a change')
  ok(r.posts[1]!.body.index.at === r.now, 'the heartbeat carries a FRESH write stamp — that is the live number')
}

{
  const r = rig()
  await r.pusher.tick()
  r.now += MIN_INTERVAL + 1
  r.next = {
    index: index(r.now, 'renamed'),
    tails: [{ key: 'abc', at: r.now, entries: [{ kind: 'prompt', at: r.now, text: 'hi' }] }],
  }
  await r.pusher.tick()
  ok(r.posts.length === 2 && r.posts[1]!.body.tails.length === 1,
    'a changed title pushes; the new tail rides along in the same POST')
  ok(r.statuses.at(-1)?.ok === true && r.statuses.at(-1)?.note === 'pushed the board and 1 new chat tail',
    'the status names what went out')
}

// --- backoff -----------------------------------------------------------------

{
  const r = rig()
  r.failFetchWith = new Error('network unreachable')
  r.pusher.reset()
  await r.pusher.tick()
  ok(r.posts.length === 0 && r.statuses.length === 1 && r.statuses[0]!.ok === false &&
    r.statuses[0]!.error === 'network unreachable',
    'a failed fetch reports failure with its reason')
  r.now += MIN_INTERVAL + 1
  r.failFetchWith = null
  await r.pusher.tick()
  ok(r.posts.length === 0, 'a retry within BACKOFF_MS is refused — no hammering a dead relay')
  r.now += BACKOFF_MS
  await r.pusher.tick()
  ok(r.posts.length === 1, 'after the backoff, a healthy relay is tried again')
  ok(r.statuses.at(-1)?.ok === true, 'the recovery is reported as success')
}

{
  // A build error is a failure like any other: it backs off and reports.
  const r = rig()
  let broken = true
  r.build = async () => {
    if (broken) throw new Error('store hiccup')
    return { index: index(r.now), tails: [] }
  }
  await r.pusher.tick()
  ok(r.statuses.length === 1 && r.statuses[0]!.ok === false && r.statuses[0]!.error === 'store hiccup',
    'a build failure is reported and backs off like a network failure')
  r.now += MIN_INTERVAL + 1
  await r.pusher.tick()
  ok(r.posts.length === 0, 'the backoff holds for build failures too')
  r.now += BACKOFF_MS
  broken = false
  await r.pusher.tick()
  ok(r.posts.length === 1 && r.statuses.at(-1)!.ok === true,
    '…and recovers once the build heals')
}

// --- reset -------------------------------------------------------------------

{
  const r = rig({ enabled: false })
  await r.pusher.tick()
  r.pusher.reset() // forget the error state so enabling pushes immediately
  const real = rig()
  await real.pusher.tick()
  ok(real.posts.length === 1, 'a fresh pusher pushes on its first tick after reset')
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('pusher: all ok')
