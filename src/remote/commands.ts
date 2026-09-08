/**
 * Remote Control — the WRITE half: commands sent from the remote page.
 *
 * The read half streams a redacted board outward. This half is the one
 * direction IN: the watcher posts a `{ kind: 'command' }` to the relay, the
 * relay holds it (bounded, see board-core.mjs), and this machine picks it up
 * and decides whether it runs. The decision is the point of this module, and
 * it is code, not prose:
 *
 *  1. THE TOGGLE. The pairing code is a capability for the MIRROR. Running
 *     prompts on this machine is a separate capability, `remote.writes`,
 *     default OFF. While it is off, commands are ignored — never run, and
 *     deliberately not acked: the relay keeps them (capped), and enabling the
 *     toggle FLUSHES the queue rather than running whatever piled up while the
 *     channel was closed. Only commands sent while writes are ON ever run.
 *  2. THE NONCE. Re-delivery happens (a lost ack, a poll racing the push's
 *     piggyback), and a command that already ran must not run again. Seen
 *     nonces are re-acked and dropped. The memory is in-process: a host that
 *     dies between running a command and acking it can see that command once
 *     more — the same at-least-once trade every queue makes, and the window
 *     is the host's own crash.
 *  3. THE SESSION. The relay validates a command's session against ITS index,
 *     which is a snapshot. The host re-checks against the live board: a
 *     session that is gone is dropped and acked — never acted on later, and
 *     never turned into a new session by guessing.
 *
 * What an accepted command DOES is not this module's business: the host routes
 * it through the same paths the local webview uses (`host.sendMessage` /
 * `host.newSession`), so permission modes, model flags, worktree creation and
 * the money all flow through the existing gates.
 *
 * `parseCommands` is the defensive read of an outsider's JSON — the page is a
 * browser, and everything on the wire is untrusted input.
 */
import { KEY_OK } from './relay.ts'
import { FETCH_TIMEOUT_MS, FN_PATH } from './pusher.ts'

/** One command the relay may be holding. */
export interface RemoteCommand {
  /** Browser-generated (a UUID), the ack handle. */
  nonce: string
  /** The prompt text. */
  text: string
  /** The board key of the session to message; absent means "start a new
   *  session with this prompt". */
  session?: string
  /** The model the watcher picked, if any. Ids only — the host decides what it
   *  means, and a wrong one is dropped rather than acted on. */
  model?: string
  /** The effort level the watcher picked, if any. */
  effort?: string
  /** The thinking mode the watcher picked, if any. */
  thinking?: 'enabled' | 'disabled'
}

/** Same rule as the relay's (board-core.mjs): the nonce is an ack handle,
 *  nothing more, and it must look like one. */
export const NONCE_OK = /^[A-Za-z0-9._-]{1,64}$/
/** Same rule as the relay's: a model id / effort key is a short, blob-safe
 *  string — never a provider or a credential. */
export const SETTING_OK = /^[A-Za-z0-9._-]{1,120}$/
/** Same rule as the relay's: the thinking mode is a closed set. */
export const THINKING_OK = /^(enabled|disabled)$/
/** Mirrors the relay's cap: the relay refuses longer, and the host must not
 *  accept what the relay would have refused. */
export const CMD_TEXT_MAX = 20_000

/**
 * Defensive read of whatever the relay returned as `cmds`. Anything that is
 * not exactly a command is dropped — the input is browser-written and travels
 * through a store nobody here controls.
 */
export function parseCommands(raw: unknown): RemoteCommand[] {
  if (!Array.isArray(raw)) return []
  const out: RemoteCommand[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    const nonce = typeof c.nonce === 'string' ? c.nonce : ''
    const text = typeof c.text === 'string' ? c.text.trim() : ''
    if (!NONCE_OK.test(nonce)) continue
    if (!text || text.length > CMD_TEXT_MAX) continue
    if (c.session !== undefined) {
      if (typeof c.session !== 'string' || !KEY_OK.test(c.session)) continue
    }
    if (c.model !== undefined && (typeof c.model !== 'string' || !SETTING_OK.test(c.model))) continue
    if (c.effort !== undefined && (typeof c.effort !== 'string' || !SETTING_OK.test(c.effort))) continue
    if (c.thinking !== undefined && (typeof c.thinking !== 'string' || !THINKING_OK.test(c.thinking))) continue
    out.push({
      nonce,
      text,
      ...(typeof c.session === 'string' ? { session: c.session } : {}),
      ...(typeof c.model === 'string' ? { model: c.model } : {}),
      ...(typeof c.effort === 'string' ? { effort: c.effort } : {}),
      ...(typeof c.thinking === 'string' ? { thinking: c.thinking as 'enabled' | 'disabled' } : {}),
    })
  }
  return out
}

/** What the policy needs from the host. */
export interface AcceptCtx {
  /** The `remote.writes` toggle. THE gate — see the header. */
  writesEnabled: boolean
  /** Whether `key` names a session on THIS board right now. May be async: the
   *  answer may need a store read. */
  sessionExists(key: string): boolean | Promise<boolean>
  /** Whether this nonce has already been acted on. */
  seenNonce(nonce: string): boolean
  /** Mark the nonce as acted on, now. */
  rememberNonce(nonce: string): void
}

/**
 * The single entry point for a batch of commands off the wire: parse, gate,
 * deduplicate, validate the session, and return what to run and what to ack.
 * Commands dropped by the toggle are NOT acked — see the header for why, and
 * the host's flush-on-enable for where they go.
 */
export async function acceptCommands(
  raw: unknown,
  ctx: AcceptCtx,
): Promise<{ accepted: RemoteCommand[]; ack: string[] }> {
  const accepted: RemoteCommand[] = []
  const ack: string[] = []
  for (const c of parseCommands(raw)) {
    if (!ctx.writesEnabled) continue
    if (ctx.seenNonce(c.nonce)) {
      ack.push(c.nonce) // already ran — confirm so the relay forgets it
      continue
    }
    if (c.session !== undefined && !(await ctx.sessionExists(c.session))) {
      ack.push(c.nonce) // names a session that is gone — never act on it later
      continue
    }
    ctx.rememberNonce(c.nonce)
    accepted.push(c)
    ack.push(c.nonce)
  }
  return { accepted, ack }
}

/**
 * The command transport: poll the queue, ack what was taken. A class rather
 * than two fetches in extension.ts so the URL shape and the ack body are
 * pinned by a test — the same reason the pusher exists.
 *
 * The poll is deliberately separate from the pusher's cadence: pushes are
 * rare when the board is idle, and the moment a user sends a prompt from
 * elsewhere is exactly when the board is idle. The host polls on its own
 * timer (see extension.ts) and commands also ride back on push answers.
 */
export class RemoteCommandClient {
  private readonly deps: { baseUrl: string; boardId: string; fetch: typeof fetch }

  constructor(deps: { baseUrl: string; boardId: string; fetch: typeof fetch }) {
    this.deps = deps
  }

  get ready(): boolean {
    return !!this.deps.baseUrl && this.deps.boardId.length > 0
  }

  /** Fetch the pending command queue. Returns the raw `cmds` payload for
   *  `acceptCommands` — the client stays a transport, the policy lives there. */
  async poll(): Promise<unknown> {
    const res = await this.deps.fetch(
      `${this.deps.baseUrl}${FN_PATH}?id=${encodeURIComponent(this.deps.boardId)}&cmds=1`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
    )
    if (!res.ok) throw new Error(`relay answered ${res.status}`)
    const answer = (await res.json().catch(() => ({}))) as { ok?: boolean; cmds?: unknown }
    if (answer.ok === false) throw new Error('relay refused the command poll')
    return answer.cmds
  }

  /** Tell the relay these commands are taken. A lost ack is a re-delivery,
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
}
