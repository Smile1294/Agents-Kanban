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
 *  4. A CHANGE A PERSON CAUSED IS NOT A STREAMED TOKEN. `nudge({urgent:true})`
 *     lowers the cadence floor to URGENT_INTERVAL for that one change. Rule 1
 *     exists to keep ten pushes a second off the event loop the CLI's stdout is
 *     drained on; a tap is one change, and making it wait out a rule written
 *     for a firehose was half the measured lag on the remote board.
 *  5. A THROTTLED NUDGE IS DEFERRED, NEVER DROPPED. Rules 1 and 2 are about
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
 * WHAT a changed push carries is delta.ts's decision: a PATCH (the board minus
 * its transcript, plus the transcript rows that actually changed — 7.6 KB
 * against 282 KB on a 400-row session) when the relay has said it speaks them
 * and this end knows which frame it holds, and a whole state otherwise. Both
 * halves of that condition are things the relay SAID, never things assumed: a
 * v2 relay handed a patch stores nothing and the board silently stops.
 *
 * `fetch` and `now` are injected so the cadence rules are testable without a
 * network or a clock.
 */
import { framePatch } from './delta.ts'
import type { FramePatch } from './delta.ts'
import { relayBase } from './relay.ts'
import type { RemoteFrame } from './relay.ts'
import type { UiState } from '../board/panel.ts'

/** The relay path under the site root. Every host target serves the relay
 *  here — Netlify rewrites it to its function, the Cloudflare worker and the
 *  plain-Node server route it directly. The route is part of the contract
 *  with the relay repo (agents-kanban-relay): remote-contract.json's fnPath,
 *  checked by scripts/check-contract.mjs on every verify. */
export const FN_PATH = '/board'

/** Fastest allowed push cadence for a board moving on its own, ms.
 *
 *  This number is about a STREAMING AGENT: a push rides the same event loop the
 *  CLI child's stdout is drained on, and ten pushes a second would slow the
 *  agent down. It was never about a click. */
export const MIN_INTERVAL = 2_000

/**
 * Fastest allowed push cadence for a change a PERSON caused, ms.
 *
 * A tap produces exactly one state change, so the reason `MIN_INTERVAL` exists
 * does not apply to it — and applying it anyway was half the remote board's
 * lag. Measured end to end, tap to the board moving: two independent waits of
 * 0–2000 ms either side of ~70 ms of actual work, one of them this gate. Six
 * runs came out 370, 2679, 2394, 2729, 370 and 498 ms, bimodal on whether the
 * gates happened to be open.
 *
 * Still a floor rather than zero, because a burst of messages (a page catching
 * up after a reconnect) is several changes, not one, and it must still coalesce.
 */
export const URGENT_INTERVAL = 200

/** How long silence may last before a state-less frame is pushed as a heartbeat. */
export const HEARTBEAT_MS = 90_000

/** Wait after a failed attempt before trying again. */
export const BACKOFF_MS = 30_000

/** Per-attempt network timeout, ms. */
export const FETCH_TIMEOUT_MS = 10_000

/** The largest a frame's JSON may be (the contract's frameMaxBytes). The relay
 *  refuses larger with 413, so the host must not send one. */
export const FRAME_MAX_BYTES = 4_000_000

/**
 * HOW MANY FRAME SLOTS a board keeps past the shared one — the relay's
 * `viewersMax`, held here because the host must not build a pusher for a slot
 * the relay will not keep. Pinned against `remote-contract.json` by
 * `scripts/check-contract.mjs`: two numbers that must agree and can drift is
 * the shape this project has a postmortem about.
 */
export const VIEWERS_MAX = 4

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
  /** The seq the stored frame now carries — the base the NEXT patch applies
   *  to. Absent from a v2 relay, which is one of the two ways this end learns
   *  it must keep sending whole states. */
  frameSeq?: number
  /** This relay understands patch frames. Absent or false means it does not,
   *  and it is never inferred: a v2 relay handed a patch would store nothing
   *  and the board would simply stop moving. */
  patches?: boolean
  /** The relay could not place the patch — it holds no frame, or a different
   *  one. Not an error: the next push carries a full state. */
  needFrame?: boolean
  /** The relay keeps a FRAME SLOT PER VIEWER (contract v4). Answered on every
   *  frame POST, and never inferred, for the reason `patches` is not: a v3
   *  relay ignores `viewer` and every page silently shares one frame again —
   *  which is the bug slots exist to fix, arriving as a downgrade. */
  viewers?: boolean
}

export interface PusherDeps {
  now(): number
  /** The relay site origin, or undefined when not configured. Normalised by
   *  relayBase before it reaches this module. */
  baseUrl: string | undefined
  /** The sha-256 board id (boardIdOf of the pairing code). */
  boardId: string
  /**
   * WHICH FRAME SLOT this pusher writes — one remote page, by the id that page
   * made for itself. Absent is the SHARED slot, which is what a contract-v3
   * relay stores and what a page with no id of its own reads.
   *
   * One pusher per slot rather than one pusher pushing a map, because every
   * rule in this file — the cadence floor, the idle comparison, the held frame
   * a patch is built against — is per board, and a board is what a slot holds.
   * Sharing them across slots would mean one page's tap spending another's
   * urgency and one page's patch naming another's base.
   */
  viewer?: string
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
  viewer?: string
  state?: unknown
  patch?: FramePatch
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
  /**
   * The frame the relay is holding, as far as this end knows: the seq it was
   * stored under and the state it composed to. A patch is built against THIS,
   * never against the last state we happened to build — the two differ the
   * moment a push fails or the relay refuses a patch, and splicing into the
   * wrong conversation is the one failure worth 282 KB to avoid.
   *
   * Cleared whenever the relay says it could not place a patch, whenever a
   * push fails, and whenever the config changes.
   */
  private held: { seq: number; state: UiState } | undefined
  /** The relay answered a frame POST saying it understands patches. Never
   *  assumed: a v2 relay handed one stores nothing and the board stops. */
  private patchesOk = false
  /** A person caused what is waiting to go out, so the cadence floor is
   *  URGENT_INTERVAL rather than MIN_INTERVAL. Sticky until something actually
   *  leaves: a tap that arrives during a streaming burst must not lose its
   *  urgency to the next token's ordinary nudge. */
  private urgent = false
  /** Something asked to be pushed while a push was already in flight. Retried
   *  the moment that one lands rather than on a timer of its own — see `post`. */
  private againAfterFlight = false
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
    this.againAfterFlight = false
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
    // A repointed relay holds nothing of ours, and a re-enabled one may have
    // been restarted since. Either way the next push is a full state.
    this.held = undefined
    this.lastStateJson = ''
  }

  /** One tick. Cheap when there is nothing to do; the host calls it from its
   *  own timer and from its repaint path. */
  async tick(): Promise<void> {
    if (!this.connected || this.disposed) return
    const now = this.deps.now()
    // A push is already going out. Whatever prompted this tick is NEWER than
    // what that push carries, so it must be retried once that one lands —
    // dropping it here is how a board goes stale one frame behind itself.
    // The floor this tick is held to. A change a person caused gets the short
    // one; a board moving on its own gets the one that protects the event loop.
    const floor = this.urgent ? URGENT_INTERVAL : MIN_INTERVAL
    // Retried when the flight ENDS, not on a timer of its own. Arming a whole
    // floor here made a tap arriving mid-push wait that floor and then the
    // gate's floor on top: measured, one run in seven came out ~536 ms where
    // the rest were ~45 ms, and this was the difference.
    if (this.inFlight) { this.againAfterFlight = true; return }
    const sinceAttempt = now - this.lastAttempt
    if (sinceAttempt < floor) { this.arm(floor - sinceAttempt); return }
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
      // Which slot this frame is for. Omitted rather than sent empty: a v3
      // relay ignores an unknown key either way, but `''` would be a claim.
      ...(this.deps.viewer ? { viewer: this.deps.viewer } : {}),
    }
    if (stateChanged) {
      // A PATCH when the relay has said it speaks them AND we know what it is
      // holding AND the change is expressible as one. Any of those missing and
      // a full state goes: this is the field where 97% of the bytes are, and
      // the wrong 97% is worse than all of it. See delta.ts.
      const patch = this.patchesOk && this.held
        ? framePatch(this.held.state, state, this.held.seq)
        : undefined
      if (patch) body.patch = patch
      else body.state = state
    }
    if (modelsDue) body.models = snapshot.frame.models
    await this.post(body, stateChanged ? stateJson : this.lastStateJson, !changed,
      stateChanged ? state : undefined)
  }

  /**
   * The host calls this when it knows something changed, so a live board does
   * not wait out a heartbeat. Still cadence-bound, still coalesced.
   *
   * `urgent` means a PERSON caused it — a message from the remote page, a click
   * in the panel — as opposed to a token an agent streamed. It lowers the floor
   * for this change only, and is sticky until a push actually goes out, so a
   * tap that lands mid-stream is not demoted by the next frame's ordinary nudge.
   */
  nudge(opts?: { urgent?: boolean }): Promise<void> {
    if (opts?.urgent) this.urgent = true
    return this.tick()
  }

  private async post(
    body: PostBody, stateJson: string, heartbeat: boolean, sent?: UiState,
  ): Promise<boolean> {
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
      // Spent — but only if this push carried the change it belongs to. A tap
      // that arrived WHILE this push was in flight is not in it, so clearing
      // here would demote it to the streaming floor and it would wait 2 s
      // having already waited for the flight. Cleared here rather than in
      // tick() for the same reason in the other direction: a tick that decided
      // the board was quiet has delivered nothing, and the urgency stands.
      if (!this.againAfterFlight) this.urgent = false
      // Only a WRITE may update what the relay is recorded to hold: a heartbeat
      // sent no state, so the relay's frame is still the last full push's.
      if ('state' in body || 'patch' in body) this.lastStateJson = stateJson

      // What the relay is now holding. `patches` and `frameSeq` are the relay
      // SAYING so — a v2 relay sends neither, and this end then never builds a
      // patch at all. `needFrame` is the relay saying it could not place the
      // one it just got, so what it holds is unknown and the next push is
      // whole.
      if (answer.patches === true) this.patchesOk = true
      if (answer.needFrame === true) {
        this.held = undefined
        // The relay did not store what we just sent, so our record of what it
        // holds is stale AND the change is unsent: force the next tick to
        // treat the board as changed rather than as quiet.
        this.lastStateJson = ''
      } else if (sent !== undefined && typeof answer.frameSeq === 'number') {
        this.held = { seq: answer.frameSeq, state: sent }
      } else if (sent !== undefined) {
        // A relay that stored the frame but will not say under which seq
        // cannot be patched against. Whole states from here.
        this.held = undefined
      }
      /* A DISPOSED pusher says nothing back. `dispose()` means this engine is
         finished, but a push already in flight lands afterwards — and its
         callbacks are the OLD engine's, closing over the old relay. The host
         learns things from them that outlive one engine: whether the relay
         keeps a frame slot per viewer, the connection status line, the queued
         messages to run. A late answer from the relay the user just moved AWAY
         from would teach the new one facts about the old, and the sharpest is
         `viewers` — believed about a relay that does not keep slots, every page
         is pushed into one frame and the board stops moving for all of them. */
      if (this.disposed) return true
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
      // The push may have reached the relay and failed on the way back, so
      // what it holds is no longer known. Guessing here is how a patch gets
      // spliced into a frame that was never stored.
      this.held = undefined
      // Silent once disposed, for the reason the success arm is: this engine's
      // failure is not the new engine's, and a red status line the user cannot
      // clear is the "signal that cannot say good" half of the same rule.
      if (this.disposed) return false
      this.deps.onStatus({
        at: now, ok: false,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    } finally {
      this.inFlight = false
      // A tick that arrived mid-flight is due now. The gate is re-evaluated
      // from THIS push's attempt time, so it arms whatever is genuinely left of
      // the floor rather than a fresh one. Failures ride `onStatus` already.
      if (this.againAfterFlight && !this.disposed) {
        this.againAfterFlight = false
        void this.tick().catch(() => { /* already reported through onStatus */ })
      }
    }
  }
}

export { relayBase }
