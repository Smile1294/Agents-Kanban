/**
 * Remote Control — the WRITE half: messages queued from the remote page.
 *
 * Relay v2 does not invent a command vocabulary of its own. The page runs the
 * very same `media/board.js` as the local webview behind a bridge, so the
 * messages it sends are the messages the webview would send — `sendMessage`,
 * `newSession`, `openWorktree`, `voiceAudio`, `remote.dialog` answers, and
 * every other entry in `dispatchBoardMessage`. The relay holds each one as a
 * `{ nonce, msg }` pair, this machine picks it up, and — the point of this
 * module — decides whether it runs. The decision is code, not prose:
 *
 *  1. THE TOGGLE. The pairing code is a capability for the MIRROR. Running
 *     webview messages on this machine is a separate capability,
 *     `remote.writes`, default OFF. While it is off, messages are ignored —
 *     never run, and deliberately not acked: the relay keeps them (capped),
 *     and enabling the toggle FLUSHES the queue rather than running whatever
 *     piled up while the channel was closed. Only messages sent while writes
 *     are ON ever run.
 *  2. THE NONCE. Re-delivery happens (a lost ack, a poll racing the push's
 *     piggyback), and a message that already ran must not run again. Seen
 *     nonces are re-acked and dropped. The memory is in-process: a host that
 *     dies between running a message and acking it can see that message once
 *     more — the same at-least-once trade every queue makes, and the window
 *     is the host's own crash.
 *  3. THE DIALOG ANSWERS. A `remote.dialog` message is NOT a board action: it
 *     is the phone answering a dialog this host posted earlier. It is routed
 *     to `resolveDialog` (which matches it to a pending overlay) and acked —
 *     never dispatched to the board, and never re-delivered to a dialog that
 *     has already timed out.
 *
 * What an accepted message DOES is not this module's business: the host runs it
 * through the same `dispatchBoardMessage` the local webview uses, so permission
 * modes, model flags, worktree creation and the money all flow through the
 * existing gates — with the dialog sink swapped to the relay by the caller.
 *
 * `parseMessages` is the defensive read of an outsider's JSON — the page is a
 * browser, and everything on the wire is untrusted input.
 */
import { FETCH_TIMEOUT_MS, FN_PATH } from './pusher.ts'

/** Same rule as the relay's (board-core.mjs): the nonce is an ack handle,
 *  nothing more, and it must look like one. */
export const NONCE_OK = /^[A-Za-z0-9._-]{1,64}$/
/** Same rule as the relay's: a webview message type is a short, dot-safe name —
 *  `sendMessage`, `remote.dialog`, `voiceAudio`. */
export const TYPE_OK = /^[A-Za-z][A-Za-z0-9._-]{0,39}$/
/** Mirrors the relay's cap: the relay refuses a longer message, and the host
 *  must not accept what the relay would have refused. */
export const MSG_MAX_BYTES = 4_000_000

/** One message the relay may be holding: the ack handle plus the webview
 *  message the page posted. `msg` is opaque here — it is validated for shape
 *  and size, then handed to the host unchanged, so `dispatchBoardMessage` is
 *  the single source of truth for what a message means. */
export interface RemoteMessage {
  nonce: string
  msg: { type: string } & Record<string, unknown>
}

/** Defensive read of whatever the relay returned as `msgs`. Anything that is
 *  not exactly a queued webview message is dropped — the input is
 *  browser-written and travels through a store nobody here controls. */
export function parseMessages(raw: unknown): RemoteMessage[] {
  if (!Array.isArray(raw)) return []
  const out: RemoteMessage[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const nonce = typeof c.nonce === 'string' ? c.nonce : ''
    const msg = c.msg
    if (!NONCE_OK.test(nonce)) continue
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) continue
    const m = msg as Record<string, unknown>
    if (typeof m.type !== 'string' || !TYPE_OK.test(m.type)) continue
    if (JSON.stringify(msg).length > MSG_MAX_BYTES) continue
    out.push({ nonce, msg: msg as { type: string } & Record<string, unknown> })
  }
  return out
}

/** What the policy needs from the host. */
export interface AcceptCtx {
  /** The `remote.writes` toggle. THE gate — see the header. */
  writesEnabled: boolean
  /** Whether this nonce has already been acted on. */
  seenNonce(nonce: string): boolean
  /** Mark the nonce as acted on, now. */
  rememberNonce(nonce: string): void
  /** Route a `remote.dialog` answer back to the waiting dialog (from
   *  `makeRelayDialogSink`). Returns true when the id matched a pending dialog;
   *  the answer is acked either way. */
  resolveDialog(id: string, answer: unknown): boolean
}

/** A message that is a dialog answer: `{ type:'remote.dialog', id, answer }`. */
function asDialogAnswer(m: RemoteMessage['msg']): { id: string; answer: unknown } | undefined {
  if (m.type !== 'remote.dialog') return undefined
  if (typeof m.id !== 'string') return undefined
  return { id: m.id, answer: 'answer' in m ? m.answer : undefined }
}

/**
 * The single entry point for a batch of messages off the wire: parse, gate,
 * deduplicate, route dialog answers, and return what to run and what to ack.
 * Messages dropped by the toggle are NOT acked — see the header for why, and
 * the host's flush-on-enable for where they go.
 */
export function acceptMessages(
  raw: unknown,
  ctx: AcceptCtx,
): { accepted: RemoteMessage[]; ack: string[] } {
  const accepted: RemoteMessage[] = []
  const ack: string[] = []
  for (const m of parseMessages(raw)) {
    if (!ctx.writesEnabled) continue
    if (ctx.seenNonce(m.nonce)) {
      ack.push(m.nonce) // already ran — confirm so the relay forgets it
      continue
    }
    const answer = asDialogAnswer(m.msg)
    if (answer) {
      ctx.resolveDialog(answer.id, answer.answer) // may be stale — ack regardless
      ack.push(m.nonce)
      continue
    }
    ctx.rememberNonce(m.nonce)
    accepted.push(m)
    ack.push(m.nonce)
  }
  return { accepted, ack }
}

/**
 * The message transport: poll the queue, ack what was taken, post page events.
 * A class rather than three fetches in extension.ts so the URL shape and the
 * ack body are pinned by a test — the same reason the pusher exists.
 *
 * The poll is deliberately separate from the pusher's cadence: pushes are rare
 * when the board is idle, and the moment a user sends a message from elsewhere
 * is exactly when the board is idle. The host polls on its own timer (see
 * extension.ts) and messages also ride back on push answers.
 */
export class RemoteMessageClient {
  private readonly deps: { baseUrl: string; boardId: string; fetch: typeof fetch }

  constructor(deps: { baseUrl: string; boardId: string; fetch: typeof fetch }) {
    this.deps = deps
  }

  get ready(): boolean {
    return !!this.deps.baseUrl && this.deps.boardId.length > 0
  }

  /** Fetch the pending message queue. Returns the raw `msgs` payload for
   *  `acceptMessages` plus the page's last poll time (for the host's cadence) —
   *  the client stays a transport, the policy lives in the host. */
  async poll(): Promise<{ msgs?: unknown; viewerAt?: number }> {
    const res = await this.deps.fetch(
      `${this.deps.baseUrl}${FN_PATH}?id=${encodeURIComponent(this.deps.boardId)}&msgs=1`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    )
    if (!res.ok) throw new Error(`relay answered ${res.status}`)
    const answer = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      msgs?: unknown
      viewerAt?: number
    }
    if (answer.ok === false) throw new Error('relay refused the message poll')
    return { msgs: answer.msgs, viewerAt: answer.viewerAt }
  }

  /** Tell the relay these messages are taken. A lost ack is a re-delivery,
   *  which the nonce memory turns into a no-op. */
  async ack(nonces: readonly string[]): Promise<void> {
    if (!nonces.length) return
    const res = await this.deps.fetch(`${this.deps.baseUrl}${FN_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rc-key': this.deps.boardId,
      },
      body: JSON.stringify({ kind: 'ack', nonces }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`ack answered ${res.status}`)
  }

  /** Append host→page events (search results, mentions, voice, remote dialogs
   *  and toasts) for the page's next poll. */
  async postEvents(events: readonly object[]): Promise<void> {
    if (!events.length) return
    const res = await this.deps.fetch(`${this.deps.baseUrl}${FN_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rc-key': this.deps.boardId,
      },
      body: JSON.stringify({ kind: 'event', events }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`event post answered ${res.status}`)
  }
}
