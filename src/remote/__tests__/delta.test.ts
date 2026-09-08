/**
 * The transcript delta: what a push carries instead of the whole board.
 *
 * Two properties, and the second is the one that matters. FIRST, a patch must
 * round-trip: `applyPatch(prev, framePatch(prev, next))` is `next`, for every
 * shape the board actually produces — a token appended to the streaming row, a
 * finished row plus a new one, a tool call settling, a card's age ticking with
 * the transcript untouched. SECOND, a patch must be REFUSED rather than
 * approximated where it cannot be exact: a session switch, upward pagination,
 * a transcript appearing or disappearing. A format that quietly does its best
 * on those would show a transcript that is subtly not the board's.
 */
import { applyPatch, framePatch } from '../delta.ts'
import type { UiState } from '../../board/panel.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

type Row = NonNullable<UiState['transcript']>[number]
const text = (t: string): Row => ({ kind: 'text', text: t } as unknown as Row)
const tool = (id: string, status: string): Row =>
  ({ kind: 'tool', id, name: 'Bash', summary: 'npm test', status } as unknown as Row)

const base = (over: Partial<UiState> = {}): UiState => ({
  ready: true, mode: 'chat', selectedKey: 'a', columns: [], cards: [],
  composer: { model: 'm', effort: 'high', thinking: 'off', efforts: [],
    permissionMode: 'default', permissionModes: [], agent: 'claude|inherit', agents: [],
    runtime: 'claude', runtimes: [], provider: 'inherit', providers: [], contextTokens: 0,
  } as unknown as UiState['composer'],
  running: 0, waiting: 0,
  ...over,
})

/** Every patch this file builds is asserted to round-trip, so a case added
 *  later cannot pass by only being small. */
function roundTrips(prev: UiState, next: UiState, what: string): ReturnType<typeof framePatch> {
  const patch = framePatch(prev, next, 7)
  if (patch) {
    ok(JSON.stringify(applyPatch(prev, patch)) === JSON.stringify(next),
      `${what} — applying the patch reproduces the state exactly`)
    ok(patch.base === 7, `${what} — the patch names the frame it applies to`)
  }
  return patch
}

// --- a streaming turn: the tail grows -----------------------------------------

{
  const prev = base({ transcript: [text('a'), text('b'), text('cc')] })
  const next = base({ transcript: [text('a'), text('b'), text('cccc')] })
  const patch = roundTrips(prev, next, 'the last row grew')
  ok(patch?.rows?.from === 2 && patch.rows.rows.length === 1,
    'a growing row re-sends only itself, never the rows above it')
}

{
  const prev = base({ transcript: [text('a'), text('b')] })
  const next = base({ transcript: [text('a'), text('b'), text('c'), text('d')] })
  const patch = roundTrips(prev, next, 'two rows appended')
  ok(patch?.rows?.from === 2 && patch.rows.rows.length === 2,
    'appended rows ride alone — `from` is the old length')
}

{
  const prev = base({ transcript: [text('a'), tool('t1', 'running')] })
  const next = base({ transcript: [text('a'), tool('t1', 'ok')] })
  const patch = roundTrips(prev, next, 'a tool call settled')
  ok(patch?.rows?.from === 1, 'a row that CHANGED in place is found by content, not by identity')
}

// --- the transcript did not move ---------------------------------------------

{
  const rows = [text('a'), text('b')]
  const prev = base({ transcript: rows, running: 1 })
  // The host rebuilds its array on every getState(), so the rows are equal and
  // not identical — comparing by identity would re-send the whole transcript
  // on every single push.
  const next = base({ transcript: [text('a'), text('b')], running: 2 })
  const patch = roundTrips(prev, next, 'only a counter changed')
  ok(patch !== undefined && patch.rows === undefined,
    'an unchanged transcript sends NO rows at all — this is the 97%')
}

// --- the size claim, on the real proportions ---------------------------------

{
  const long = Array.from({ length: 400 }, (_, i) => text('Lorem ipsum dolor sit amet. '.repeat(12) + i))
  const prev = base({ transcript: long, cards: [{ key: 'a', title: 'x', phase: 'p', tags: [], updated: 1 }] })
  const next = base({
    transcript: long.slice(0, 399).concat([text('Lorem ipsum dolor sit amet. '.repeat(12) + 399 + ' more')]),
    cards: [{ key: 'a', title: 'x', phase: 'p', tags: [], updated: 2 }],
  })
  const patch = roundTrips(prev, next, 'a 400-row board, one row growing')
  const whole = JSON.stringify(next).length
  const delta = JSON.stringify(patch).length
  ok(delta * 10 < whole,
    `a patch is at least 10x smaller than the frame it replaces (${delta} vs ${whole} bytes)`)
}

// --- where a patch must be REFUSED --------------------------------------------

{
  const prev = base({ transcript: [text('a'), text('b')] })
  const next = base({ transcript: [text('x'), text('y')], selectedKey: 'b' })
  ok(framePatch(prev, next, 1) === undefined,
    'a session switch is refused — the whole transcript is riding either way')
}

{
  // Upward pagination PREPENDS: every row shifts, so nothing above is reusable.
  const prev = base({ transcript: [text('c'), text('d')] })
  const next = base({ transcript: [text('a'), text('b'), text('c'), text('d')] })
  ok(framePatch(prev, next, 1) === undefined,
    '"load earlier" is refused — a prepend changes row 0')
}

{
  const prev = base({ transcript: [text('a')] })
  const next = base({})
  ok(framePatch(prev, next, 1) === undefined,
    'a transcript disappearing is refused — `rows` cannot say "there is none"')
  ok(framePatch(next, prev, 1) === undefined, '…and so is one appearing')
}

{
  const prev = base({})
  const next = base({ running: 3 })
  const patch = framePatch(prev, next, 1)
  ok(patch !== undefined && patch.rows === undefined,
    'a board with no transcript at all still patches — kanban is 7.6 KB, not 282')
  ok(patch && JSON.stringify(applyPatch(prev, patch)) === JSON.stringify(next),
    '…and round-trips')
}

// --- the patch never carries the transcript twice -----------------------------

{
  const prev = base({ transcript: [text('a')] })
  const next = base({ transcript: [text('a'), text('b')] })
  const patch = framePatch(prev, next, 1)!
  ok(!('transcript' in patch.state),
    'the patch’s `state` has NO transcript field — that is the entire point')
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('delta: all ok')
