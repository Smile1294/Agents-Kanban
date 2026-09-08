/**
 * Remote Control — sending the transcript ONCE instead of on every push.
 *
 * Measured on a realistic board (14 cards, a review panel, a full composer):
 *
 *   400-row transcript · 282 KB per frame · transcript 97.3% of it
 *   100-row transcript ·  76 KB per frame · transcript 90.1% of it
 *   everything else, at any transcript length: 7.6 KB
 *
 * At one push per `MIN_INTERVAL` that is 8.7 MB a minute out of the machine and
 * the same again into every watching phone — to re-send a transcript that is
 * almost entirely IMMUTABLE. Claude Code fixes history when a run starts and
 * only ever appends after it, which is the same property `media/board.js`
 * already relies on for its own fast path: `syncApply` appends new rows and
 * patches the last one rather than rebuilding.
 *
 * So a push may carry a PATCH instead of a state:
 *
 *   { base, state, rows?: { from, rows } }
 *
 * `state` is the whole board MINUS the transcript — 7.6 KB, sent in full every
 * time. Diffing that generically would buy 3% and cost a merge algorithm that
 * can be wrong in ways nobody would notice, so it is deliberately NOT done.
 * `rows` is the transcript from the first row that actually changed; everything
 * before it is already on the other end. `base` is the frame seq this applies
 * to, so an end that has drifted can say so instead of splicing into the wrong
 * conversation.
 *
 * Three things are load-bearing:
 *
 *  - A patch is REFUSABLE, never assumed. The relay answers `needFrame` when it
 *    cannot place one, and the pusher sends a full state next. An end that
 *    silently mis-applied a patch would show a transcript that is subtly not
 *    the board's, which is worse than sending 282 KB.
 *  - The transcript's PRESENCE changing (a session selected, or deselected)
 *    falls back to a keyframe. `rows` can express "these rows changed", not
 *    "there is no transcript now", and inventing an encoding for a case that
 *    happens on a click rather than on a token is how a format grows a corner
 *    nobody tests.
 *  - `from` is the first row whose SERIALISATION differs, so a row that grew —
 *    the block being streamed — is re-sent whole and the rows above it are not.
 *    Comparing by identity would re-send everything, the host rebuilding its
 *    array each `getState()`.
 */
import type { UiState } from '../board/panel.ts'

/** One transcript row, opaque here: this module only ever compares and slices
 *  them. `Entry` lives in sessions/store.ts and carries a dozen shapes. */
type Row = NonNullable<UiState['transcript']>[number]

/** The transcript splice a patch carries: replace everything from `from`
 *  onwards with `rows`. `from === length` is a pure append. */
export interface RowsPatch {
  from: number
  rows: Row[]
}

/** What a push carries instead of a full state. `state` is the board without
 *  its transcript; `rows` is absent when the transcript did not change at all
 *  (a card's age ticking, a meter moving). */
export interface FramePatch {
  base: number
  state: Omit<UiState, 'transcript'>
  rows?: RowsPatch
}

/** The first index at which two transcripts differ, by serialisation. Equal to
 *  the shorter length when one is a prefix of the other. */
function firstChange(prev: readonly Row[], next: readonly Row[]): number {
  const n = Math.min(prev.length, next.length)
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(prev[i]) !== JSON.stringify(next[i])) return i
  }
  return prev.length === next.length ? n : n
}

/**
 * The patch from `prev` to `next`, or `undefined` when a patch cannot express
 * the change and a full state must go instead.
 *
 * `undefined` is returned — rather than a patch that rewrites the whole
 * transcript — when the transcript's presence changed, and when the splice
 * would carry the whole thing anyway (a session switch, upward pagination).
 * A patch that is not smaller than a keyframe is only a keyframe with extra
 * ways to go wrong.
 */
export function framePatch(prev: UiState, next: UiState, base: number): FramePatch | undefined {
  const had = prev.transcript !== undefined
  const has = next.transcript !== undefined
  if (had !== has) return undefined

  const { transcript: _drop, ...state } = next
  void _drop
  if (!has) return { base, state }

  const before = prev.transcript!
  const after = next.transcript!
  const from = firstChange(before, after)
  // Nothing above the change is re-sent; if the change starts at the top, the
  // whole transcript is riding either way and a keyframe is the honest frame.
  if (from === 0 && after.length > 0) return undefined
  if (from === before.length && from === after.length) return { base, state }
  return { base, state, rows: { from, rows: after.slice(from) } }
}

/**
 * Apply a patch to the state it was built against.
 *
 * Mirrored in TWO other places, both of which need it and neither of which can
 * import this file: the relay composes patches onto the frame it stores
 * (`functions/board-core.mjs`, so a page that joins mid-stream still gets one
 * complete board), and the page rebuilds the state it hands to `board.js`
 * (`public/bridge.js`, whose whole job is to look like a VS Code webview).
 * The relay repo's own tests drive its two copies over the same inputs and
 * assert they agree; this one is what `delta.test.ts` round-trips against.
 */
export function applyPatch(prev: UiState, patch: FramePatch): UiState {
  const state = { ...patch.state } as UiState
  if (prev.transcript === undefined && patch.rows === undefined) return state
  const base = prev.transcript ?? []
  const rows = patch.rows
    ? base.slice(0, patch.rows.from).concat(patch.rows.rows)
    : base
  return { ...state, transcript: rows }
}
