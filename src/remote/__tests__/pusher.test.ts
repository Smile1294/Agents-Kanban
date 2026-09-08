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

/** A state with a transcript, so the patch path has something to leave behind. */
const chat = (mv: string, rows: string[]): RemoteFrame => ({
  state: {
    ready: true, mode: 'chat', selectedKey: 'a', cards: [],
    transcript: rows.map((t) => ({ kind: 'text', text: t })),
  } as unknown as UiState,
  mv,
})

interface Posted {
  at: number
  url: string
  key: string
  body: { kind: string; at: number; writes: boolean; mv: string; state?: unknown; models?: unknown }
}

/** One armed timer. Held rather than run, so a test decides when the trailing
 *  tick fires — the same reason `now` is a number this file writes. */
interface Timer {
  at: number
  fn: () => void
  cancelled: boolean
}

interface Rig {
  pusher: RemotePusher
  now: number
  statuses: PushStatus[]
  posts: Posted[]
  answers: RelayAnswer[]
  /** Timers the pusher armed, in the order it armed them. */
  timers: Timer[]
  /** Advance the clock to `ms` and run whatever was due, once. */
  runTimersTo(ms: number): Promise<void>
  /** Let real time pass to `ms`: run every timer that comes due, INCLUDING the
   *  ones the earlier ones arm. A trailing tick that re-arms (it opened the
   *  cadence gate only to find the backoff still running) is a real sequence,
   *  and a helper that stopped at the first round could not see it through. */
  settleTo(ms: number): Promise<void>
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
    timers: [] as Timer[],
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
    timers: state.timers,
    async runTimersTo(ms: number): Promise<void> {
      state.now = ms
      // A trailing tick may arm another; run only what was already due, so a
      // test that asserts "exactly one deferred push" cannot be satisfied by a
      // loop the pusher would never run in real time either.
      const due = state.timers.filter((t) => !t.cancelled && t.at <= ms)
      for (const t of due) { t.cancelled = true; t.fn() }
      // Let the awaited tick inside the timer settle before the assertion.
      await new Promise((r) => setImmediate(r))
      await new Promise((r) => setImmediate(r))
    },
    async settleTo(ms: number): Promise<void> {
      for (let round = 0; round < 20; round++) {
        const due = state.timers.filter((t) => !t.cancelled && t.at <= ms)
        if (!due.length) break
        // Each timer fires at ITS moment, not at the end of the window — a
        // pusher that reads the clock decides on the time it actually ran.
        for (const t of due.sort((a, b) => a.at - b.at)) {
          state.now = Math.max(state.now, t.at)
          t.cancelled = true
          t.fn()
          await new Promise((r) => setImmediate(r))
          await new Promise((r) => setImmediate(r))
        }
      }
      state.now = Math.max(state.now, ms)
    },
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
    setTimeout: (fn, ms) => {
      const t: Timer = { at: state.now + ms, fn, cancelled: false }
      state.timers.push(t)
      return t
    },
    clearTimeout: (h) => { (h as Timer).cancelled = true },
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

// --- a throttled nudge is DEFERRED, never dropped -----------------------------
//
// The bug this pins, measured against the real engine: a remote click is
// delivered BY a push answer, so the host runs it, repaints, and nudges within
// milliseconds of the last attempt. The cadence gate `return`ed and nothing
// rescheduled — the change reached the relay on the host's 30s ticker. Every
// "I pressed it and the page just sat there" is this.

{
  const r = rig()
  await r.pusher.tick()
  ok(r.posts.length === 1, 'the first push goes out')

  // 100ms later the board changed (a remote message ran on this machine).
  r.now += 100
  r.next = { frame: frame('1', 'after the click'), writes: false }
  await r.pusher.nudge()
  ok(r.posts.length === 1, 'a nudge inside MIN_INTERVAL does not push immediately')
  ok(r.timers.filter((t) => !t.cancelled).length === 1,
    '…it ARMS a trailing tick instead of dropping the change')

  // Nothing else nudges — the agent is not streaming, the user is waiting.
  await r.runTimersTo(1_000_000 + MIN_INTERVAL)
  ok(r.posts.length === 2, 'the trailing tick pushes when the cadence gate opens')
  ok((r.posts[1]!.body.state as { title: string }).title === 'after the click',
    '…carrying the state as it is NOW, not as it was when the nudge was blocked')
}

{
  const r = rig()
  await r.pusher.tick()
  // A streaming agent nudges on every frame it produces.
  r.now += 100
  r.next = { frame: frame('1', 'streaming'), writes: false }
  for (let i = 0; i < 20; i++) await r.pusher.nudge()
  ok(r.timers.filter((t) => !t.cancelled).length === 1,
    'twenty blocked nudges arm exactly ONE trailing tick — a firehose costs one push')
  await r.runTimersTo(1_000_000 + MIN_INTERVAL)
  ok(r.posts.length === 2, '…and exactly one push leaves')
}

{
  const r = rig()
  await r.pusher.tick()
  r.now += MIN_INTERVAL + 1
  await r.pusher.tick()
  ok(r.posts.length === 1, 'an unchanged board still pushes nothing')
  ok(r.timers.filter((t) => !t.cancelled).length === 0,
    '…and arms nothing: the gate was open, there was simply no news')
}

{
  // A change that arrives while a push is in flight is newer than that push.
  const r = rig()
  let release: (() => void) | undefined
  r.build = async (): Promise<PushSnapshot> => {
    await new Promise<void>((res) => { release = res })
    return r.next
  }
  const first = r.pusher.tick()
  await new Promise((res) => setImmediate(res))
  await r.pusher.nudge()
  ok(r.timers.filter((t) => !t.cancelled).length === 1,
    'a nudge during an in-flight push arms a trailing tick rather than vanishing')
  release?.()
  await first
}

{
  // Backing off is not forgetting. On an idle board nothing nudges again, so a
  // relay that came back up would never be retried.
  const r = rig()
  r.failFetchWith = new Error('relay down')
  await r.pusher.tick()
  ok(r.statuses.at(-1)?.ok === false, 'a failed push reports the failure')
  ok(r.timers.filter((t) => !t.cancelled).length === 0, 'the failure itself arms nothing')
  r.now += 100
  await r.pusher.nudge()
  ok(r.timers.filter((t) => !t.cancelled).length === 1,
    'a nudge inside the backoff arms a retry, rather than leaving an idle board to nudge again')
  r.failFetchWith = null
  await r.settleTo(1_000_000 + BACKOFF_MS)
  ok(r.posts.length === 1,
    '…the retry chain reaches the relay by itself once the backoff expires')
}

{
  const r = rig()
  await r.pusher.tick()
  r.now += 100
  r.next = { frame: frame('1', 'changed'), writes: false }
  await r.pusher.nudge()
  r.pusher.dispose()
  await r.runTimersTo(1_000_000 + MIN_INTERVAL)
  ok(r.posts.length === 1,
    'dispose() cancels the trailing tick — a replaced engine must not push to the old relay')
}

// --- patches: the transcript travels once, and only when the relay says so ----
//
// 97% of a frame is the transcript, and it is almost entirely immutable — so a
// push carries the board minus its transcript plus the rows that changed. The
// whole risk is in the negotiation: a v2 relay handed a patch stores nothing
// and the board silently stops moving, so BOTH halves — "this relay speaks
// patches" and "this is the frame it holds" — must be things the relay SAID.

{
  const r = rig()
  r.next = { frame: chat('1', ['a', 'b']), writes: true }
  await r.pusher.tick()
  ok('state' in r.posts[0]!.body, 'the first push is always a whole state — nothing is held yet')

  // A v2 relay: no `patches`, no `frameSeq`.
  r.now += MIN_INTERVAL + 1
  r.next = { frame: chat('1', ['a', 'b', 'c']), writes: true }
  await r.pusher.tick()
  ok('state' in r.posts[1]!.body && !('patch' in r.posts[1]!.body),
    'a relay that never claimed to speak patches keeps getting whole states')
}

{
  const r = rig()
  r.answer = { ok: true, patches: true, frameSeq: 5 }
  r.next = { frame: chat('1', ['a', 'b']), writes: true }
  await r.pusher.tick()
  ok('state' in r.posts[0]!.body, 'even a v3 relay gets a whole state first — it holds nothing yet')

  r.now += MIN_INTERVAL + 1
  r.answer = { ok: true, patches: true, frameSeq: 6 }
  r.next = { frame: chat('1', ['a', 'b', 'c']), writes: true }
  await r.pusher.tick()
  const body = r.posts[1]!.body as { patch?: { base: number; rows?: { from: number; rows: unknown[] } }; state?: unknown }
  ok(body.patch !== undefined && body.state === undefined,
    'once the relay has said `patches` and named a `frameSeq`, the push is a patch')
  ok(body.patch!.base === 5, 'the patch names the seq the relay reported holding, not our own count')
  ok(body.patch!.rows!.from === 2 && body.patch!.rows!.rows.length === 1,
    'and it carries only the row that arrived')
}

{
  // The relay could not place it. Not an error — but the change is UNSENT, so
  // the next push must be a whole state and must not be skipped as "quiet".
  const r = rig()
  r.answer = { ok: true, patches: true, frameSeq: 5 }
  r.next = { frame: chat('1', ['a']), writes: true }
  await r.pusher.tick()

  r.now += MIN_INTERVAL + 1
  r.answer = { ok: true, patches: true, needFrame: true }
  r.next = { frame: chat('1', ['a', 'b']), writes: true }
  await r.pusher.tick()
  ok('patch' in r.posts[1]!.body, 'the patch was sent…')

  r.now += MIN_INTERVAL + 1
  r.answer = { ok: true, patches: true, frameSeq: 9 }
  await r.pusher.tick()
  ok(r.posts.length === 3, '…a refused patch is re-sent, not counted as delivered')
  ok('state' in r.posts[2]!.body && !('patch' in r.posts[2]!.body),
    '…and it is re-sent as a WHOLE state, because what the relay holds is now unknown')
}

{
  // A failed push may have reached the relay and died on the way back, so what
  // it holds is unknown. A patch built against a guess splices into the wrong
  // conversation.
  const r = rig()
  r.answer = { ok: true, patches: true, frameSeq: 5 }
  r.next = { frame: chat('1', ['a']), writes: true }
  await r.pusher.tick()

  r.now += MIN_INTERVAL + 1
  r.failFetchWith = new Error('connection reset')
  r.next = { frame: chat('1', ['a', 'b']), writes: true }
  await r.pusher.tick()

  r.failFetchWith = null
  r.now += BACKOFF_MS + 1
  r.next = { frame: chat('1', ['a', 'b', 'c']), writes: true }
  await r.pusher.tick()
  ok('state' in r.posts[1]!.body && !('patch' in r.posts[1]!.body),
    'after a failed push the next one is whole — a half-delivered frame is not a base')
}

{
  const r = rig()
  r.answer = { ok: true, patches: true, frameSeq: 5 }
  r.next = { frame: chat('1', ['a']), writes: true }
  await r.pusher.tick()
  r.now += MIN_INTERVAL + 1
  // A session switch: delta.ts refuses, so the whole board rides.
  r.next = {
    frame: {
      state: { ready: true, mode: 'chat', selectedKey: 'b', cards: [],
        transcript: [{ kind: 'text', text: 'z' }] } as unknown as UiState,
      mv: '1',
    },
    writes: true,
  }
  await r.pusher.tick()
  ok('state' in r.posts[1]!.body,
    'a change a patch cannot express falls back to a whole state, never to an approximation')
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
