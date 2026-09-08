/**
 * Remote Control — the engine that decides WHEN a frame leaves this machine.
 * The SHAPE of what leaves is pinned by relay.ts and its tests; here is the
 * cadence: never more often than it must, never so rarely that the remote page
 * cannot tell a live board from a dead one.
 *
 * Relay v2 pushes the FULL webview frame (`{ type:'state', state }`, with
 * `composer.models` split out) instead of a redacted index. The rules are the
 * same ones v1 had, re-stated for a frame:
 *
 *  1. CADENCE — at most one attempt per MIN_INTERVAL, ever. A streaming agent
 *     would otherwise push on every frame, and a push rides the same event
 *     loop as the CLI child's stdout.
 *  2. IDLE = NO PUSH — when the serialised state is byte-identical to the last
 *     one sent and no models are due, nothing goes out. A board that is not
 *     moving must not burn relay invocations announcing that.
 *  3. HEARTBEAT — but a board that never announces itself is indistinguishable
 *     from one whose machine went to sleep. So when the last successful send
 *     is HEARTBEAT_MS old, a frame goes out even though nothing changed — with
 *     NO state, just `at`/`writes`/`mv` — rewriting the live number the page
 *     reads.
 *
 *  4. A THROTTLED NUDGE IS DEFERRED, NEVER DROPPED. Rules 1 and 2 are about
 *     what leaves; neither may decide that a change never leaves at all. The
 *     cadence gate used to `return` on a nudge that landed inside
 *     MIN_INTERVAL, and nothing rescheduled it — so a board change that
 *     arrived within two seconds of the last push waited for the host's own
 *     30s ticker. Measured: a remote click ran on this machine at t=100ms and
 *     reached the relay at t=30s, because the message was delivered BY a push
 *     answer, which is precisely when the last attempt is at its freshest.
 *     That is the "I press something and the page sits there" report. So a
 *     blocked tick — by the cadence gate or by a push already in flight —
 *     arms a trailing tick at the moment the gate opens, coalesced to one.
 *
 * A failed attempt backs off (BACKOFF_MS) instead of retrying every tick, and
 * `onStatus` fires on every attempt — success and failure both, so "silently
 * not connected" cannot happen. `onAnswer` carries the relay's answer back
 * (`mv` for the models-due decision, `viewerAt` for the poll cadence, `msgs`
 * for the queued page messages), so the pusher stays a transport and every
 * decision about what to do next lives in the host.
 *
 * A frame over `FRAME_MAX_BYTES` (the transcript is the only unbounded field)
 * is cut to its last 100 transcript rows and marked `transcriptMore` — the page
 * keeps its "load older" pill rather than dropping the frame.
 *
 * `fetch` and `now` are injected so the cadence rules are testable without a
 * network or a clock.
 */
import { relayBase } from './relay.ts'
import type { RemoteFrame } from './relay.ts'

/** The relay path under the site root. Every host target serves the relay
 *  here — Netlify rewrites it to its function, the Cloudflare worker and the
 *  plain-Node server route it directly. The route is part of the contract
 *  with the relay repo (agents-kanban-relay): remote-contract.json's fnPath,
 *  checked by scripts/check-contract.mjs on every verify. */
export const FN_PATH = '/board'

/** Fastest allowed push cadence, ms. */
export const MIN_INTERVAL = 2_000

/** How long silence may last before a state-less frame is pushed as a heartbeat. */
export const HEARTBEAT_MS = 90_000

/** Wait after a failed attempt before trying again. */
export const BACKOFF_MS = 30_000

/** Per-attempt network timeout, ms. */
export const FETCH_TIMEOUT_MS = 10_000

/** The largest a frame's JSON may be (the contract's frameMaxBytes). The relay
 *  refuses larger with 413, so the host must not send one. */
export const FRAME_MAX_BYTES = 4_000_000

/** The largest transcript a frame keeps when it would otherwise exceed the
 *  bound: the last 100 rows, with `transcriptMore` set so the page still knows
 *  there is history above. */
const FRAME_TRANSCRIPT_ROWS = 100

/** What one push carries, built by the host: the frame (state with models
 *  split out) plus the write-channel toggle, carried in the body so the page
 *  shows its composer exactly when a message would be acted on. */
export interface PushSnapshot {
  frame: RemoteFrame
  writes: boolean
}

export interface PushStatus {
  at: number
  ok: boolean
  /** A human line for the settings page: what went out, or why not. */
  note?: string
  error?: string
  /** True when this successful push CARRIED models — the host clears its
   *  models-due flag on it. Absent on a heartbeat (which sends no models), so
   *  a heartbeat can never clear the flag. */
  models?: boolean
}

/** The relay's answer to a frame POST, parsed. */
export interface RelayAnswer {
  ok?: boolean
  error?: string
  /** The catalogue version the relay is holding — the host compares it to its
   *  own `mv` to decide whether models must ride the next push. */
  mv?: string
  /** When a page last polled, for the host's poll cadence. */
  viewerAt?: number
  /** Queued page→host messages the relay is holding for a busy board. */
  msgs?: unknown
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
  /** The relay's answer, handed to the host on every successful POST. */
  onAnswer?(a: RelayAnswer): void
  /** Injected so the trailing tick is testable without waiting out real time —
   *  the same reason `now` and `fetch` are injected. */
  setTimeout?(fn: () => void, ms: number): unknown
  clearTimeout?(handle: unknown): void
}

interface PostBody {
  kind: 'frame'
  at: number
  writes: boolean
  mv: string
  state?: unknown
  models?: unknown
}

export class RemotePusher {
  private lastAttempt = 0
  private lastSent = 0
  private lastErrorAt = 0
  private inFlight = false
  /** JSON of the STATE as last successfully sent, so a tick can tell a changed
   *  board from a quiet one without the host keeping a copy. */
  private lastStateJson = ''
  /** The armed trailing tick, when a nudge was blocked by the cadence gate or
   *  by a push in flight. One at a time: a streaming agent nudges ten times a
   *  second and every one of those must collapse into the same trailing run. */
  private trailing: unknown
  private disposed = false

  private readonly deps: PusherDeps

  constructor(deps: PusherDeps) {
    this.deps = deps
  }

  private setT(fn: () => void, ms: number): unknown {
    return this.deps.setTimeout
      ? this.deps.setTimeout(fn, ms)
      : setTimeout(fn, ms)
  }

  private clearT(handle: unknown): void {
    if (this.deps.clearTimeout) this.deps.clearTimeout(handle)
    else clearTimeout(handle as ReturnType<typeof setTimeout>)
  }

  /**
   * Arm the trailing tick for the moment the gate opens.
   *
   * `ms` is clamped to at least 1 so a zero-delay timer cannot re-enter the
   * gate in the same turn of the loop, and only ONE is ever outstanding — the
   * whole point is that a firehose of nudges costs one deferred push, not one
   * per nudge.
   */
  private arm(ms: number): void {
    if (this.disposed || this.trailing !== undefined) return
    this.trailing = this.setT(() => {
      this.trailing = undefined
      void this.tick().catch(() => { /* onStatus already carries the failure */ })
    }, Math.max(1, ms))
  }

  /** Drop the armed trailing tick. The host owns the pusher's lifetime, and a
   *  timer that outlives the extension host is a leak that fires into a
   *  disposed world. */
  dispose(): void {
    this.disposed = true
    if (this.trailing !== undefined) { this.clearT(this.trailing); this.trailing = undefined }
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
   *  own timer and from its repaint path. */
  async tick(): Promise<void> {
    if (!this.connected || this.disposed) return
    const now = this.deps.now()
    // A push is already going out. Whatever prompted this tick is NEWER than
    // what that push carries, so it must be retried once that one lands —
    // dropping it here is how a board goes stale one frame behind itself.
    if (this.inFlight) { this.arm(MIN_INTERVAL); return }
    const sinceAttempt = now - this.lastAttempt
    if (sinceAttempt < MIN_INTERVAL) { this.arm(MIN_INTERVAL - sinceAttempt); return }
    if (this.lastErrorAt && now - this.lastErrorAt < BACKOFF_MS) {
      // Backing off is not the same as forgetting: the relay is unreachable,
      // not uninteresting. Come back when the backoff expires rather than
      // waiting for whatever nudges next, which on an idle board is nothing.
      this.arm(BACKOFF_MS - (now - this.lastErrorAt))
      return
    }
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

    // A state over the bound is cut, never dropped: the transcript is the one
    // field that grows without limit, so trim it to the last rows and mark
    // "more" — the page keeps its "load older" pill.
    let state = snapshot.frame.state
    if (state.transcript && JSON.stringify(state).length > FRAME_MAX_BYTES
        && state.transcript.length > FRAME_TRANSCRIPT_ROWS) {
      const dropped = state.transcript.length - FRAME_TRANSCRIPT_ROWS
      state = {
        ...state,
        transcript: state.transcript.slice(-FRAME_TRANSCRIPT_ROWS),
        transcriptMore: true,
        transcriptHead: (state.transcriptHead ?? 0) + dropped,
      }
    }

    const stateJson = JSON.stringify(state)
    const stateChanged = stateJson !== this.lastStateJson
    // Models ride the frame when the host says they are due (an mv mismatch on
    // the relay's answer, or a `ready` message) — that is a reason to push all
    // on its own, because the relay is holding a stale catalogue.
    const modelsDue = snapshot.frame.models !== undefined
    const changed = stateChanged || modelsDue
    if (!changed && now - this.lastSent < HEARTBEAT_MS) return // quiet, not due yet

    const body: PostBody = {
      kind: 'frame',
      at: now,
      writes: snapshot.writes,
      mv: snapshot.frame.mv,
    }
    if (stateChanged) body.state = state
    if (modelsDue) body.models = snapshot.frame.models
    await this.post(body, stateChanged ? stateJson : this.lastStateJson, !changed)
  }

  /** The host calls this when it knows something changed, so a live board does
   *  not wait out a heartbeat. Still cadence-bound, still coalesced. */
  nudge(): Promise<void> {
    return this.tick()
  }

  private async post(body: PostBody, stateJson: string, heartbeat: boolean): Promise<boolean> {
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
      this.lastSent = now
      this.lastErrorAt = 0
      // Only a WRITE may update what the relay is recorded to hold: a heartbeat
      // sent no state, so the relay's frame is still the last full push's.
      if ('state' in body) this.lastStateJson = stateJson
      // The answer drives the host's next move (models-due, poll cadence,
      // queued messages) — the pusher itself does not look at it.
      this.deps.onAnswer?.(answer)
      this.deps.onStatus({
        at: now, ok: true,
        note: heartbeat ? 'heartbeat — the board is idle but alive' : 'pushed the board',
        ...('models' in body ? { models: true } : {}),
      })
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
