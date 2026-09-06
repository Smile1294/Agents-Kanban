/**
 * Remote Control — the engine that decides WHEN a snapshot leaves this
 * machine. The SHAPE of what leaves is pinned by relay.ts and its tests; here
 * is the cadence: never more often than it must, never so rarely that the
 * remote page cannot tell a live board from a dead one.
 *
 * Three rules, all load-bearing and all tested here:
 *
 *  1. CADENCE — at most one attempt per MIN_INTERVAL, ever. A streaming agent
 *     would otherwise push on every frame, and a push rides the same event
 *     loop as the CLI child's stdout (there is a postmortem about that loop).
 *  2. IDLE = NO PUSH — when the index is byte-identical to the last one sent
 *     and `build()` reported no new tails, nothing goes out. A board that is
 *     not moving must not burn relay invocations announcing that.
 *  3. HEARTBEAT — but a board that never announces itself is
 *     indistinguishable from one whose machine went to sleep. So when the last
 *     successful send is HEARTBEAT_MS old, the index alone goes out even
 *     though nothing changed, rewriting its `at` — that number is what the
 *     remote page's "live Ns ago" reads, and the house rule "a number the
 *     board shows must not depend on a process being alive" is exactly why it
 *     lives in the push, not in the page.
 *
 * A failed attempt backs off (BACKOFF_MS) instead of retrying every tick, and
 * `onStatus` fires on every attempt — success and failure both, so "silently
 * not connected" cannot happen. Nothing here knows what a session or a
 * transcript is: the host's `build()` decides what a changed tail is and
 * returns ONLY those. This module only decides the when.
 *
 * `fetch` and `now` are injected so the cadence rules are testable without a
 * network or a clock.
 */
import { relayBase } from './relay.ts'
import type { RemoteIndex, RemoteTail } from './relay.ts'

/** The relay path under the site root. Every host target serves the relay
 *  here — Netlify rewrites it to its function, the Cloudflare worker and the
 *  plain-Node server route it directly (see remote/README.md). */
export const FN_PATH = '/board'

/** Fastest allowed push cadence, ms. */
export const MIN_INTERVAL = 2_000

/** How long silence may last before the index alone is pushed as a heartbeat. */
export const HEARTBEAT_MS = 90_000

/** Wait after a failed attempt before trying again. */
export const BACKOFF_MS = 30_000

/** Per-attempt network timeout, ms. */
export const FETCH_TIMEOUT_MS = 10_000

export interface PushSnapshot {
  /** Everything the board looks like, minus the transcripts. */
  index: RemoteIndex
  /** Only sessions whose transcript GREW since the host's previous build. */
  tails: RemoteTail[]
}

export interface PushStatus {
  at: number
  ok: boolean
  /** A human line for the settings page: what went out, or why not. */
  note?: string
  error?: string
}

export interface PusherDeps {
  now(): number
  /** The relay site origin, or undefined when not configured. Normalised by
   *  relayBase before it reaches this module. */
  baseUrl: string | undefined
  /** The sha-256 board id (boardIdOf of the pairing code). */
  boardId: string
  enabled: boolean
  fetch: typeof fetch
  build(): PushSnapshot | Promise<PushSnapshot>
  onStatus(s: PushStatus): void
  /** Commands the relay is holding, delivered on a push's answer so a busy
   *  board picks them up without an extra poll. Optional: the host may prefer
   *  to poll only. */
  onCommands?(raw: unknown): void
}

interface PostBody {
  kind: 'update'
  index: RemoteIndex
  tails: RemoteTail[]
}

interface RelayAnswer {
  ok?: boolean
  error?: string
  cmds?: unknown
}

export class RemotePusher {
  private lastAttempt = 0
  private lastSent = 0
  private lastErrorAt = 0
  private inFlight = false
  /** JSON of the index's CONTENT as last successfully sent (`at` zeroed — the
   *  write stamp is applied at post time, so a rebuilt-but-unchanged board must
   *  compare equal), so a tick can tell a changed board from a quiet one
   *  without the host keeping a copy. */
  private lastContentJson = ''

  private readonly deps: PusherDeps

  constructor(deps: PusherDeps) {
    this.deps = deps
  }

  get connected(): boolean {
    return this.deps.enabled && !!this.deps.baseUrl && this.deps.boardId.length > 0
  }

  /** Forget cadence and error state — the host calls this when the config
   *  changes, so enabling or repointing the relay pushes immediately. */
  reset(): void {
    this.lastAttempt = 0
    this.lastErrorAt = 0
  }

  /** One tick. Cheap when there is nothing to do; the host calls it from its
   *  own timer and from its repaint path — both, because a board with no agent
   *  running produces no repaints for the second path to ride on. */
  async tick(): Promise<void> {
    if (!this.connected || this.inFlight) return
    const now = this.deps.now()
    if (now - this.lastAttempt < MIN_INTERVAL) return
    if (this.lastErrorAt && now - this.lastErrorAt < BACKOFF_MS) return
    this.lastAttempt = now

    let snapshot: PushSnapshot
    try {
      snapshot = await this.deps.build()
    } catch (err) {
      this.lastErrorAt = now
      this.deps.onStatus({
        at: now, ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
      return
    }

    // `at` is the write stamp, and only a WRITE may carry one — compare the
    // board's content with the stamp zeroed, or every rebuilt-but-unchanged
    // index would read as a change and the heartbeat rule could never hold.
    const content = { ...snapshot.index, at: 0 }
    const contentJson = JSON.stringify(content)
    const changed = contentJson !== this.lastContentJson || snapshot.tails.length > 0
    if (!changed && now - this.lastSent < HEARTBEAT_MS) return // quiet, not due yet

    const body: PostBody = {
      kind: 'update',
      index: { ...snapshot.index, at: now },
      tails: snapshot.tails,
    }
    await this.post(body, !changed)
  }

  /** The host calls this when it knows something changed, so a live board does
   *  not wait out a heartbeat. Still cadence-bound, still coalesced. */
  nudge(): Promise<void> {
    return this.tick()
  }

  /**
   * A host-driven push OUTSIDE the tick rules: the one-time backfill when a
   * relay is first enabled. The host hands a fresh index and a chunk of
   * backfilled tails and this pushes exactly that, once, honouring only
   * in-flight and the connected gate. A bounded, explicit operation — the
   * cadence exists to protect the event loop from a streaming agent, and a
   * backfill is neither streaming nor repeating.
   *
   * The pushed index refreshes `lastContentJson`, so the next tick compares
   * against what is actually on the relay. Returns whether the POST actually
   * went out — the host rolls its counts back when it did not, or a session
   * the relay never heard of would be marked as sent.
   */
  async pushRaw(index: RemoteIndex, tails: RemoteTail[]): Promise<boolean> {
    if (!this.connected || this.inFlight) return false
    this.lastAttempt = this.deps.now()
    return this.post({ kind: 'update', index, tails }, false)
  }

  private async post(body: PostBody, heartbeat: boolean): Promise<boolean> {
    this.inFlight = true
    const now = this.deps.now()
    try {
      const res = await this.deps.fetch(`${this.deps.baseUrl}${FN_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-rc-key': this.deps.boardId,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      const answer = (await res.json().catch(() => ({}))) as RelayAnswer
      if (!res.ok || answer.ok === false) {
        throw new Error(answer.error || `relay answered ${res.status}`)
      }
      // Commands ride the answer back. The pusher stays a transport: it does
      // not look at them, the host's callback does — which keeps the decision
      // about running anything in the one place that owns the gate.
      if (answer.cmds !== undefined && this.deps.onCommands) {
        this.deps.onCommands(answer.cmds)
      }
      this.lastSent = now
      this.lastErrorAt = 0
      // Store the CONTENT with its own write stamp zeroed, so the next tick's
      // comparison is against what is actually on the relay.
      this.lastContentJson = JSON.stringify({ ...body.index, at: 0 })
      const note = heartbeat
        ? 'heartbeat — the board is idle but alive'
        : body.tails.length
          ? `pushed the board and ${body.tails.length} new chat tail${body.tails.length === 1 ? '' : 's'}`
          : 'pushed the board'
      this.deps.onStatus({ at: now, ok: true, note })
      return true
    } catch (err) {
      this.lastErrorAt = now
      this.deps.onStatus({
        at: now, ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    } finally {
      this.inFlight = false
    }
  }
}

export { relayBase }
