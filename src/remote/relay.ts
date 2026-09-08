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
 *    flags), so a frame built from it cannot either — a test serialises a
 *    frame and asserts no `credential`, `apiKey`, `ANTHROPIC_API_KEY` or
 *    `AUTH_TOKEN` is in it.
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
import { createHash } from 'node:crypto'
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

/** The sha-256 of a pairing code, hex, cut to the first 24 chars. The relay
 *  derives its storage names from this, so a board is addressable only by
 *  someone who knows the code — and the code itself is never stored anywhere
 *  except this machine's keychain and the head of the remote viewer. */
export function boardIdOf(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 24)
}

/** A scheme prefix, so `ftp://x.com` is refused instead of being turned into
 *  the nonsense URL `https://ftp://x.com` (which PARSES, as host `ftp:`). */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** The relay URL a code addresses. Accepts the bare site, the function path and
 *  the common API path — a user pasting any of them works. */
export function relayBase(raw: string): string | undefined {
  let url = (raw || '').trim().replace(/\/+$/, '')
  if (!url) return undefined
  if (!HAS_SCHEME.test(url)) url = 'https://' + url
  let u: URL
  try { u = new URL(url) } catch { return undefined }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  // Normalise away an API path the user may have pasted from the address bar,
  // and a site subpath: every host serves the relay at <site>/board (Netlify
  // rewrites it to /.netlify/functions/board, which is also accepted).
  const atFn = u.pathname.indexOf('/.netlify/functions/')
  if (atFn >= 0) u.pathname = u.pathname.slice(0, atFn)
  else if (u.pathname.endsWith('/board')) u.pathname = u.pathname.slice(0, -'/board'.length)
  return u.toString().replace(/\/$/, '')
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
