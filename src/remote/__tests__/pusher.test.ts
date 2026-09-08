/**
 * The transport half of Remote Control: the cadence rules that decide when a
 * frame leaves this machine. fetch and the clock are injected, so the whole
 * engine is driven deterministically: a tick is awaited, time is advanced by
 * hand, and the fake fetch records what — if anything — went out.
 *
 * The rules this file pins: never faster than MIN_INTERVAL; nothing at all
 * when nothing changed (until the heartbeat is due); a failed attempt backs
 * off instead of hammering the relay; and the frame body splits state from
 * models, so a heartbeat carries neither.
 */
import {
  BACKOFF_MS,
  HEARTBEAT_MS,
  MIN_INTERVAL,
  RemotePusher,
  type PushSnapshot,
  type PushStatus,
  type RelayAnswer,
} from '../pusher.ts'
import type { RemoteFrame, RemoteModel } from '../relay.ts'
import type { UiState } from '../../board/panel.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

const MODELS: RemoteModel[] = [{ id: 'm', label: 'M', context: '1M' }]

/** A minimal state the pusher only ever serialises and compares — its shape is
 *  relay.ts's business, so a cast keeps this test on cadence and transport. */
const frame = (mv: string, title = 'same', models?: RemoteModel[]): RemoteFrame => ({
  state: { ready: true, mode: 'kanban', title, cards: [] } as unknown as UiState,
  mv,
  ...(models ? { models } : {}),
})

interface Posted {
  at: number
  url: string
  key: string
  body: { kind: string; at: number; writes: boolean; mv: string; state?: unknown; models?: unknown }
}

interface Rig {
  pusher: RemotePusher
  now: number
  statuses: PushStatus[]
  posts: Posted[]
  answers: RelayAnswer[]
  /** What build() answers. Callers replace this before a tick. */
  next: PushSnapshot
  /** What the relay answers (defaults to { ok: true }). */
  answer: RelayAnswer
  failFetchWith: Error | null
  build(): Promise<PushSnapshot>
}

function rig(opts: { enabled?: boolean; baseUrl?: string } = {}): Rig {
  const state = {
    now: 1_000_000,
    statuses: [] as PushStatus[],
    posts: [] as Posted[],
    answers: [] as RelayAnswer[],
    next: { frame: frame('1'), writes: false } as PushSnapshot,
    answer: { ok: true } as RelayAnswer,
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
    return { ok: true, status: 200, json: async () => state.answer } as Response
  }
  const rig: Rig = {
    ...state,
    build: async (): Promise<PushSnapshot> => state.next,
    pusher: undefined as unknown as RemotePusher,
    get now(): number { return state.now },
    set now(v: number) { state.now = v },
    get next(): PushSnapshot { return state.next },
    set next(v: PushSnapshot) { state.next = v },
    get answer(): RelayAnswer { return state.answer },
    set answer(v: RelayAnswer) { state.answer = v },
    get failFetchWith(): Error | null { return state.failFetchWith },
    set failFetchWith(v: Error | null) { state.failFetchWith = v },
  }
  rig.pusher = new RemotePusher({
    now: () => state.now,
    baseUrl: opts.baseUrl ?? 'https://board.example.com',
    boardId: '0123456789abcdef01234567',
    enabled: opts.enabled ?? true,
    fetch: fetch as unknown as typeof fetch,
    build: async () => rig.build(),
    onStatus: (s) => state.statuses.push(s),
    onAnswer: (a) => state.answers.push(a),
  })
  return rig
}

// --- the gate ----------------------------------------------------------------

{
  const r = rig()
  r.pusher.reset()
  await r.pusher.tick()
  ok(r.posts.length === 1 && r.posts[0]!.url === 'https://board.example.com/board',
    'the first tick posts the frame to the relay API path (/board)')
  ok(r.posts[0]!.key === '0123456789abcdef01234567', 'the board id rides in x-rc-key')
  const body = r.posts[0]!.body
  ok(body.kind === 'frame' && body.mv === '1' && body.writes === false,
    'the body is a frame: kind, mv and the write toggle')
  ok(body.state !== undefined && (body.state as { title: string }).title === 'same',
    'a first push carries the full state')
  ok('models' in body === false, 'no models due means no models field on the first push')
}

// --- the relay's answer rides back -------------------------------------------

{
  const r = rig()
  r.answer = { ok: true, mv: '2', viewerAt: 1_000_100, msgs: [{ nonce: 'n1', msg: { type: 'send', id: 'a', text: 'x' } }] }
  await r.pusher.tick()
  ok(r.answers.length === 1 && r.answers[0]!.mv === '2' && r.answers[0]!.viewerAt === 1_000_100,
    'the relay answer (mv, viewerAt, msgs) is handed to the host for its next move')
  ok(r.statuses.at(-1)?.ok === true, 'and the push itself still reports success')
}

{
  const r = rig()
  await r.pusher.tick()
  ok(r.answers.length === 1 && r.answers[0]!.mv === undefined && r.answers[0]!.msgs === undefined,
    'an empty answer is still an answer — the host sees the push succeeded')
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
  r.now += MIN_INTERVAL + 1
  await r.pusher.tick()
  ok(r.posts.length === 1, 'an unchanged frame and no models does not push again')

  r.now += HEARTBEAT_MS
  await r.pusher.tick()
  ok(r.posts.length === 2, '…but when HEARTBEAT_MS passes since the last send, a frame goes anyway')
  ok(r.statuses.at(-1)?.note === 'heartbeat — the board is idle but alive',
    'an unchanged push is labelled a heartbeat, not a change')
  const body = r.posts[1]!.body
  ok('state' in body === false && 'models' in body === false,
    'a heartbeat carries NO state and NO models — just at, writes, mv')
  ok(body.at === r.now, 'the heartbeat carries a FRESH write stamp — that is the live number')
}

{
  const r = rig()
  await r.pusher.tick()
  r.now += MIN_INTERVAL + 1
  r.next = { frame: frame('1', 'renamed'), writes: false }
  await r.pusher.tick()
  ok(r.posts.length === 2 && (r.posts[1]!.body.state as { title: string }).title === 'renamed',
    'a changed state pushes, with the new state in the body')
  ok(r.statuses.at(-1)?.ok === true && r.statuses.at(-1)?.note === 'pushed the board',
    'the status names what went out')
}

// --- the models split --------------------------------------------------------

{
  const r = rig()
  await r.pusher.tick()
  r.now += MIN_INTERVAL + 1
  r.next = { frame: frame('2', 'same', MODELS), writes: true }
  await r.pusher.tick()
  ok(r.posts.length === 2, 'models becoming due is itself a reason to push')
  const body = r.posts[1]!.body
  ok(body.models !== undefined && Array.isArray(body.models) && body.models.length === 1,
    'the models ride in the body, split out of the state')
  ok(body.mv === '2', 'the frame carries the new catalogue version')
  ok(r.statuses.at(-1)?.models === true, 'the host is told this push CARRIED models — it clears its due flag')
}

{
  const r = rig()
  await r.pusher.tick()
  ok(r.statuses.at(-1)?.models === undefined,
    'a push without models does not set the models flag — a heartbeat must not clear it')
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
    return { frame: frame('1'), writes: false }
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

// --- a frame over the byte bound is cut, never dropped -----------------------

{
  const r = rig()
  const rows = Array.from({ length: 101 }, (_, i) => ({
    kind: 'text' as const, at: i, text: 'x'.repeat(45_000),
  }))
  r.next = { frame: { state: { ready: true, mode: 'kanban', transcript: rows } as unknown as UiState, mv: '1' }, writes: false }
  await r.pusher.tick()
  const sent = r.posts[0]!.body.state as { transcript: unknown[]; transcriptMore?: boolean; transcriptHead?: number }
  ok(sent.transcript.length === 100, 'a frame over FRAME_MAX_BYTES is cut to its last 100 transcript rows')
  ok(sent.transcriptMore === true && sent.transcriptHead === 1,
    '…and marked `transcriptMore` so the page keeps its "load older" pill')
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
