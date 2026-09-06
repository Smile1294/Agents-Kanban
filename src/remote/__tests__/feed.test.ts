/**
 * The push-content half of Remote Control: what a push carries is decided from
 * what CHANGED. The rule this file pins is the one that keeps a quiet board
 * from burning a relay invocation every couple of seconds: a session's tail
 * travels exactly when its transcript grew, and not otherwise — and its card's
 * `tv` (the version the remote page refetches on) moves with it.
 */
import { RemoteFeed } from '../feed.ts'
import { TAIL_MAX } from '../relay.ts'
import type { RemoteCardSource, RemoteColumn } from '../relay.ts'
import type { Entry } from '../../sessions/store.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

const prompt = (at: number, text: string): Entry => ({ kind: 'prompt', at, text })

const COLS: RemoteColumn[] = [{ id: 'backlog', name: 'Backlog' }]
// A function declaration, not an arrow: under the repo's tsc the arrow form
// with a return-type annotation left the parser mid-parameter-list at the next
// bare `{` block below, cascading TS1003/TS1005 over the rest of the file —
// while node's strip-types runner (which this file also must pass) was fine.
function CARD(updated: number): RemoteCardSource {
  return { key: 'abc', title: 'Fix the bug', phase: 'backlog', tags: [], archived: false, updated }
}

// --- a tail travels exactly when its transcript grew -------------------------

{
  const feed = new RemoteFeed()
  const a = feed.build(1000, COLS, [CARD(1000)], [])
  ok(a.tails.length === 0, 'no live sessions, no tails')
  ok(a.index.sessions['abc']!.tv === 0, '…and the card says so: tv 0 means nothing to fetch')

  const live = (n: number): Entry[] => Array.from({ length: n }, (_, i) => prompt(2000 + i, `m${i}`))
  const b = feed.build(2000, COLS, [CARD(2000)], [{ key: 'abc', history: [], live: live(3) }])
  ok(b.tails.length === 1 && b.tails[0]!.entries.length === 3, 'a run that grew 3 rows sends its tail once')
  ok(b.index.sessions['abc']!.tv === 3, 'tv is the total the relay has for the session')

  const c = feed.build(3000, COLS, [CARD(3000)], [{ key: 'abc', history: [], live: live(3) }])
  ok(c.tails.length === 0, 'the same 3 rows again: no growth, no push')
  ok(c.index.sessions['abc']!.tv === 3, 'tv is unchanged — the page keeps its copy')

  const d = feed.build(4000, COLS, [CARD(4000)], [{ key: 'abc', history: [], live: live(6) }])
  ok(d.tails.length === 1 && d.tails[0]!.entries.length === 6, 'growth to 6 rows sends the tail again')
  ok(d.index.sessions['abc']!.tv === 6, 'tv moved with it')
}

// --- history growth counts as growth ----------------------------------------

{
  const feed = new RemoteFeed()
  const h1: Entry[] = [prompt(1, 'old')]
  const l1: Entry[] = [prompt(2, 'live')]
  const a = feed.build(1000, COLS, [], [{ key: 'abc', history: h1, live: l1 }])
  ok(a.tails.length === 1 && a.tails[0]!.entries.length === 2,
    'history and live merge into the first tail, in order')
  const b = feed.build(2000, COLS, [], [{ key: 'abc', history: [...h1, prompt(3, 'older')], live: l1 }])
  ok(b.tails.length === 1 && b.tails[0]!.entries.length === 3,
    'history rows can arrive late (a resume read more); growth still sends')
}

// --- nothing to send stays nothing ------------------------------------------

{
  const feed = new RemoteFeed()
  const a = feed.build(1000, COLS, [], [{ key: 'abc', history: [], live: [] }])
  ok(a.tails.length === 0, 'an empty run sends no tail')
  ok(a.index.sessions['abc'] === undefined, 'a session with no card is not in the index')
  ok(feed.tvOf('abc') === 0, '…and nothing to fetch is tv 0')
}

// --- cap: a long conversation sends only its tail ---------------------------

{
  const feed = new RemoteFeed()
  const many = Array.from({ length: TAIL_MAX + 40 }, (_, i) => prompt(1000 + i, `m${i}`))
  const card = CARD(1000)
  const a = feed.build(1000, COLS, [card], [{ key: 'abc', history: many, live: [] }])
  ok(a.tails[0]!.entries.length === TAIL_MAX, 'a huge transcript sends only the last TAIL_MAX rows')
  ok(a.index.sessions['abc']!.tv === TAIL_MAX + 40, 'tv counts the TOTAL — the page can still tell it grew')
  const b = feed.build(2000, COLS, [card], [{ key: 'abc', history: many, live: [prompt(1, 'x')] }])
  ok(b.tails.length === 1, 'one more row after a cap still sends (the window slid)')
  ok(b.index.sessions['abc']!.tv === TAIL_MAX + 41, '…and tv grew by one')
}

// --- setCount: the backfill marker ------------------------------------------

{
  const feed = new RemoteFeed()
  feed.setCount('old', 5)
  const live = [prompt(1, 'a'), prompt(2, 'b'), prompt(3, 'c'), prompt(4, 'd'), prompt(5, 'e')]
  const a = feed.build(1000, COLS, [{ ...CARD(1000), key: 'old' }], [{ key: 'old', history: [], live }])
  ok(a.tails.length === 0, 'a session the host backfilled is not resent by the first tick')
  ok(a.index.sessions['old']!.tv === 5, 'its tv already tells the page there is a tail to fetch')
  const b = feed.build(2000, COLS, [], [{ key: 'old', history: [], live: [...live, prompt(6, 'f')] }])
  ok(b.tails.length === 1 && b.tails[0]!.entries.length === 6, '…but growth after the backfill sends again')
}

// --- writes: the host's toggle rides every index ----------------------------

{
  const feed = new RemoteFeed()
  const a = feed.build(1000, COLS, [CARD(1000)], [])
  ok(a.index.writes === false, 'the toggle defaults off — the page shows no composer')
  feed.setWrites(true)
  const b = feed.build(2000, COLS, [CARD(2000)], [])
  ok(b.index.writes === true, 'setWrites(true) rides the next index — the page shows its composer')
  feed.setWrites(false)
  const c = feed.build(3000, COLS, [CARD(3000)], [])
  ok(c.index.writes === false, '…and off again when the host says so')
}

// --- reset: a new code names a new board -----------------------------------

{
  const feed = new RemoteFeed()
  feed.setCount('old', 5)
  feed.reset()
  ok(feed.tvOf('old') === 0, 'reset forgets what the old relay held')
  const live = [prompt(1, 'a')]
  const a = feed.build(1000, COLS, [{ ...CARD(1000), key: 'old' }], [{ key: 'old', history: [], live }])
  ok(a.tails.length === 1, '…so a session the old code had sent travels again')
  ok(a.index.sessions['old']!.tv === 1, '…and its tv starts from the new board’s count')
}

// --- two sessions are independent -------------------------------------------

{
  const feed = new RemoteFeed()
  const src = (n: number) => ({ key: 'abc', history: [], live: [prompt(1, 'x'), prompt(2, 'y')].slice(0, n) })
  const cardDef = { ...CARD(1000), key: 'def' }
  const a = feed.build(1000, COLS, [CARD(1000), cardDef], [src(2), { key: 'def', history: [], live: [prompt(1, 'z')] }])
  ok(a.tails.length === 2, 'two growing sessions send two tails')
  const b = feed.build(2000, COLS, [cardDef], [{ key: 'def', history: [], live: [prompt(1, 'z')] }])
  ok(b.tails.length === 0, 'one quiet session does not hold the other back — nor resend it')
  ok(b.index.sessions['def']!.tv === 1, 'the quiet one keeps its tv')
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('feed: all ok')
