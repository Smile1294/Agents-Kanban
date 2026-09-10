/** Remote Control — the shape of what leaves this machine.
 *
 * Relay v2 is the FULL board, not a redacted index. The extension pushes the
 * very frames it posts to its own webview (`{ type:'state', state }`), and the
 * page is `media/board.js` verbatim behind a bridge — so there is no second
 * render path and no second redaction boundary. Worktree paths, branch names,
 * tool summaries (commands), review file lists and test-plan links all travel:
 * the owner has chosen that knowingly, and it is the point of the feature.
 *
 * Two things still never leave, and both are asserted in tests rather than
 * trusted to prose:
 *
 *  - The pairing code. `boardIdOf` hashes it, and the hash is the only address
 *    either end ever holds. The code itself is never in a frame.
 *  - Provider credentials. `UiState` never carries one (only `hasCredential`
 *    flags), so a frame built from it cannot either. That is a guarantee about
 *    the state's SHAPE, and the test asserts it that way — a provider choice
 *    carries `id`/`label`/`detail`/`support` and nothing else. Scanning the
 *    payload for token-shaped words cannot work here: the frame is the full
 *    board, so a card titled "Rotate the AUTH_TOKEN" is user content and must
 *    travel verbatim.
 *
 * The two transforms here are therefore not filters but SPLITS:
 *
 *  - `forRemote` swaps the composer's mic for the remote story (the phone
 *    records, whisper on this machine transcribes) — the one place the remote
 *    state legitimately differs from the local state.
 *  - `remoteFrame` splits `composer.models` out of the state into a `models`
 *    field, keyed by `mv` — the catalogue changes rarely and the state changes
 *    per token, so the page fetches models once and re-attaches them.
 *
 * All matching, hashing and shape logic is here and is pure; the transport
 * (what to POST, when) is pusher.ts.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { UiState } from '../board/panel.ts'

/** The model catalogue the relay stores, split out of the frame. The same
 *  shape the webview composer already carries for one entry — ids, labels,
 *  context and price — because the remote picker needs exactly what the local
 *  one draws. */
export interface RemoteModel {
  id: string
  label: string
  context: string
  detail?: string
  contextTokens?: number
  price?: string
}

/** The frame the relay stores under `f:<id>`: the webview state (with
 *  `composer.models` split out) and, when it rides along, the split-out model
 *  list. `mv` is the catalogue version key — the page refetches `models` when
 *  it changes. */
export interface RemoteFrame {
  state: UiState
  mv: string
  models?: RemoteModel[]
}

/** The whisper verdict the remote mic needs — the same `verdict(checkVoice())`
 *  the local whisper path uses, folded to just what the frame carries. */
export interface RemoteVoice {
  available: boolean
  why?: string
}

/**
 * How short a hand-typed pairing code may be.
 *
 * The board id is `sha256(code)` truncated, and it is simultaneously the
 * board's address and its ONLY credential — a GET with it returns every
 * transcript, worktree path and branch name, and with writes enabled a POST
 * with it drives this machine. The mapping is public, deterministic, unsalted
 * and cheap, so the id's search space is NOT the digest's 96 bits: it is
 * exactly the entropy of the code somebody typed. `kanban2026` falls to an
 * offline sweep in seconds, and the relay has no throttle to notice.
 *
 * So a typed code has a floor, and `newPairingCode()` is the path that should
 * be taken instead. This is deliberately not a strength meter: a rule a person
 * can satisfy with `passwordpassword` is not a defence, and the honest fix is
 * to hand them one they did not invent.
 */
export const PAIRING_CODE_MIN = 16

/** A pairing code nobody has to think of — 96 bits from the platform CSPRNG,
 *  the same shape `server/server.mjs` generates for the headless board. */
export function newPairingCode(): string {
  return randomBytes(12).toString('base64url')
}

/** Why this code is not good enough, or undefined when it is. */
export function pairingCodeProblem(code: string): string | undefined {
  const c = code.trim()
  if (!c) return 'A pairing code is required — it is the only thing protecting the board.'
  if (c.length < PAIRING_CODE_MIN) {
    return `A pairing code must be at least ${PAIRING_CODE_MIN} characters. The board's address is ` +
      'derived from it by a public, unsalted hash, so anyone who finds the relay can try codes ' +
      'offline as fast as they like — and the address is read AND write access to this board. ' +
      'Press Generate rather than inventing one.'
  }
  return undefined
}

/** The sha-256 of a pairing code, hex, cut to the first 24 chars. The relay
 *  derives its storage names from this, so a board is addressable only by
 *  someone who knows the code — and the code itself is never stored anywhere
 *  except this machine's keychain and the head of the remote viewer.
 *
 *  Truncating to 24 characters costs nothing: the id is only ever as strong as
 *  the CODE, which is why `PAIRING_CODE_MIN` and `newPairingCode()` exist. */
export function boardIdOf(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 24)
}

/** A scheme prefix, so `ftp://x.com` is refused instead of being turned into
 *  the nonsense URL `https://ftp://x.com` (which PARSES, as host `ftp:`). */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** Hosts that never leave the machine, so `http://` on them crosses no network
 *  and is the ordinary way to try a relay you are running yourself. Anything
 *  else on `http://` is the whole board — transcripts, worktree paths, branch
 *  names — plus the board id that is read AND write access to it, in the clear.
 *  Matched on the HOSTNAME, so `evil.com/?x=localhost` is not loopback. */
const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i

/**
 * Parse a pasted relay URL: the accepted base, or WHY it was refused.
 *
 * One function rather than a validator beside a normaliser, because two
 * functions that both know the rule is how the settings page ends up accepting
 * something the pusher will not use (or refusing something it would).
 * `relayBase` is the "or undefined" face of this and `relayUrlProblem` is the
 * "or the reason" face; neither decides anything itself.
 */
function parseRelay(raw: string): { url: string } | { problem: string } {
  let url = (raw || '').trim().replace(/\/+$/, '')
  if (!url) return { problem: 'A relay URL is required — it is the site the board is pushed to.' }
  if (!HAS_SCHEME.test(url)) url = 'https://' + url
  let u: URL
  try { u = new URL(url) } catch { return { problem: `"${raw.trim()}" is not a URL.` } }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { problem: `A relay URL must be https (or http on this machine). "${u.protocol}//" is neither.` }
  }
  if (u.protocol === 'http:' && !LOOPBACK.test(u.hostname)) {
    return {
      problem: `Use https for ${u.hostname}. Over http the whole board travels in the clear — every ` +
        'transcript, worktree path and branch name — and so does the board id, which is read AND ' +
        'write access to it: anyone on the network between here and the relay gets both. Every host ' +
        'this deploys to (Netlify, Cloudflare, a plain Node process behind a proxy) serves https.',
    }
  }
  // Normalise away an API path the user may have pasted from the address bar,
  // and a site subpath: every host serves the relay at <site>/board (Netlify
  // rewrites it to /.netlify/functions/board, which is also accepted).
  const atFn = u.pathname.indexOf('/.netlify/functions/')
  if (atFn >= 0) u.pathname = u.pathname.slice(0, atFn)
  else if (u.pathname.endsWith('/board')) u.pathname = u.pathname.slice(0, -'/board'.length)
  return { url: u.toString().replace(/\/$/, '') }
}

/** The relay URL a code addresses. Accepts the bare site, the function path and
 *  the common API path — a user pasting any of them works. */
export function relayBase(raw: string): string | undefined {
  const r = parseRelay(raw)
  return 'url' in r ? r.url : undefined
}

/** Why this relay URL is not usable, or undefined when it is. The same
 *  decision `relayBase` makes, with the sentence attached — a refusal on a
 *  field somebody typed into has to say what to do instead. */
export function relayUrlProblem(raw: string): string | undefined {
  const r = parseRelay(raw)
  return 'url' in r ? undefined : r.problem
}

/** The remote view of a state: identical, except the composer's mic is the
 *  phone's. Remotely there is no built-in VS Code dictation — the phone
 *  records, the bytes come over as a `voiceAudio` message, and whisper on THIS
 *  machine transcribes — so `voice` is always `{ mode:'whisper', available,
 *  why? }`, whatever the built-in path would have said locally. */
export function forRemote(state: UiState, voice: RemoteVoice): UiState {
  const voiceBlock = {
    mode: 'whisper' as const,
    available: voice.available,
    ...(voice.why ? { why: voice.why } : {}),
  }
  return { ...state, composer: { ...state.composer, voice: voiceBlock } }
}

/** Build the frame one push carries: the remote state with `composer.models`
 *  split out, and the split-out list in `models` when it is due to ride along.
 *  `models` is passed EXPLICITLY — the webview state omits the catalogue when
 *  it has not changed since the last repaint (a memo the remote must never
 *  read through), so the host hands the full list independently. */
export function remoteFrame(
  state: UiState,
  models: RemoteModel[] | undefined,
  mv: string,
  voice: RemoteVoice,
): RemoteFrame {
  const remoted = forRemote(state, voice)
  const { models: _splitOut, ...composer } = remoted.composer
  void _splitOut
  return {
    state: { ...remoted, composer },
    mv,
    ...(models && models.length ? { models } : {}),
  }
}
