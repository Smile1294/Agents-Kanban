/**
 * Remote Control — what a push carries, decided from what CHANGED.
 *
 * The pusher decides WHEN a snapshot goes out; this module decides WHAT is in
 * it. It exists because of a rule the relay's invocation budget depends on:
 *
 *  - an index is pushed when its content differs from the last push (the
 *    pusher compares), but
 *  - a TAIL must only travel when its session's transcript GREW.
 *
 * A live agent appends entries as it works, and its tail (the last 120 rows)
 * is rebuilt from the live arrays on every push attempt. Without the growth
 * check, a board that was quiet after one finished chat would push that same
 * tail on every attempt forever — the relay would burn an invocation every
 * couple of seconds for content that never changed. With it, a session's tail
 * travels exactly when its transcript grows, and not otherwise.
 *
 * The growth check is a COUNT, kept per session. Counts are what the remote
 * page's `tv` per-card version reads too, so a card tells the page "fetch my
 * tail again" exactly when the tail actually changed. `setCount` lets the host
 * mark a session whose tail it backfilled some other way (the one-time
 * backfill when a relay is first enabled), so the next push does not resend
 * it.
 *
 * Pure: everything here is arithmetic over what the host hands in, and the
 * host hands in the arrays its own render path uses — the same entries the
 * local chat draws, in the same order.
 */
import { projectIndex, projectTail, type RemoteColumn, type RemoteCardSource, type RemoteIndex, type RemoteTail } from './relay.ts'
import type { Entry } from '../sessions/store.ts'

/** One session's transcript, as the host renders it. */
export interface TailSource {
  key: string
  /** Everything the run had when it began. */
  history: readonly Entry[]
  /** What the run has produced since. */
  live: readonly Entry[]
}

export class RemoteFeed {
  /** Entries seen per session key: the count a session had when its tail last
   *  travelled. A session whose total is unchanged since then is not in the
   *  next push. */
  private counts = new Map<string, number>()

  /** The host's write-channel toggle, carried into every index so the remote
   *  page shows its composer exactly when a command would be acted on. */
  private writes = false

  /** Set by the host from its own `remote.writes` state — the page's composer
   *  and the host's gate must agree, and both read this one value. */
  setWrites(on: boolean): void {
    this.writes = on
  }

  /** Mark a session as already sent, at `totalEntries` — used after the
   *  enable-time backfill so the first tick does not resend every backfilled
   *  tail. */
  setCount(key: string, totalEntries: number): void {
    this.counts.set(key, totalEntries)
  }

  /** Forget every session — the host calls this when the pairing code or the
   *  relay URL changes. Counts describe what THIS relay already holds; a new
   *  code names a new board that holds nothing, and counts carried over from
   *  the old one would claim tails were there when they were not. */
  reset(): void {
    this.counts.clear()
  }

  /** How many entries the remote page should believe it has for a session:
   *  the version number on its card (`tv`). Zero means nothing has been sent
   *  and there is nothing to fetch. */
  tvOf(key: string): number {
    return this.counts.get(key) ?? 0
  }

  /** Build the snapshot for one push. The card list and tail sources are the
   *  CURRENT state — this is what makes a stale relay impossible: even a
   *  heartbeat that changed nothing carries an index that was true a moment
   *  ago, and anything that grew since the last push rides along. */
  build(
    at: number,
    columns: readonly RemoteColumn[],
    cards: readonly RemoteCardSource[],
    tails: readonly TailSource[],
  ): { index: RemoteIndex; tails: RemoteTail[] } {
    const out: RemoteTail[] = []
    for (const t of tails) {
      const total = t.history.length + t.live.length
      if (total === (this.counts.get(t.key) ?? 0)) continue // nothing grew
      this.counts.set(t.key, total)
      const tail = projectTail(at, t.key, t.history, t.live)
      if (tail) out.push(tail)
    }
    return {
      index: projectIndex(at, columns, cards, (k) => this.tvOf(k), this.writes),
      tails: out,
    }
  }
}
