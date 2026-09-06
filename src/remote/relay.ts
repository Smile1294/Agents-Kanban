/**
 * Remote Control — the shape of what leaves this machine.
 *
 * The board is streamed to a relay the user deploys (see remote/README.md) so
 * it can be watched from anywhere. What may leave is the question this module
 * answers, and the answer is narrower than the board itself:
 *
 *  - the COLUMNS and the CARDS — title, phase, tags, runtime, when it was last
 *    updated, and a one-line "what the agent is doing" (kind and tool name,
 *    never a command's text);
 *  - the TRANSCRIPTS — what the user asked and what the agent answered,
 *    capped to a tail. That is the "and the chats" half of the request.
 *
 * What never leaves:
 *  - the repo itself: no workspace paths, no worktree paths, no branch names,
 *    no file names, no diffs, no code. Tool rows are stripped of their summary
 *    for exactly this reason: a Bash row summarises as its COMMAND and an Edit
 *    row as its PATH, because the summary is derived from the tool's input —
 *    see `RemoteEntry`;
 *  - configuration: no providers, no credentials, no composer state, no model
 *    lists, no permission questions (those can name files);
 *  - anything the agent is about to do: no queued prompts, no test plans, no
 *    review data.
 *
 * Conversation is carried as-is otherwise: a prompt is whatever the user
 * typed, and that is the point of the feature.
 *
 * The caller (extension.ts) hands over ONLY the fields declared here; this
 * module never reaches into a card for something it did not declare. The
 * `RemoteCardSource` input type is the redaction boundary — anything not in it
 * cannot be transmitted because it is not in the payload type. Tests assert the
 * output contains exactly these fields and nothing else.
 *
 * All matching, hashing and shape logic is here and is pure; the transport
 * (what to POST, when) is pusher.ts.
 */
import { createHash } from 'node:crypto'
import type { Entry } from '../sessions/store.ts'

/** What the relay knows about one column. */
export interface RemoteColumn {
  id: string
  name: string
}

/** Everything about a session that may leave this machine. The extension maps
 *  its own cards onto this shape — the mapping is the filter, and it happens
 *  in one place. */
export interface RemoteCardSource {
  key: string
  title: string
  phase: string
  tags: string[]
  archived: boolean
  updated: number
  runtime?: string
  /** What the agent is doing RIGHT NOW, if a run is live. `tool` is the tool's
   *  NAME (Bash, Edit, Task) — a tool name is not a command, and a command can
   *  carry a secret. */
  agent?: { kind: string; tool?: string; since?: number }
}

/** One session's card as the relay stores it. */
export interface RemoteCard extends RemoteCardSource {
  /** Bumped by the host each time the session's tail is rewritten, so the
   *  remote page knows when to fetch it again without polling every session. */
  tv: number
}

/** The index: everything the board looks like, minus every transcript. Small,
 *  and pushed whenever anything on it changes. */
export interface RemoteIndex {
  v: 1
  /** When this index was WRITTEN (push time), so the page can say "live Ns
   *  ago" — and, when the number stops moving, "the extension went away". */
  at: number
  columns: RemoteColumn[]
  sessions: Record<string, RemoteCard>
}

/**
 * One transcript row as the relay may carry it. `Entry` is already reduced to
 * what the local chat draws, but one field still cannot cross: a TOOL row's
 * `summary` is derived from the tool's INPUT — a Bash row summarises as its
 * command, an Edit row as its path — so it is code, not conversation. The
 * redaction drops fields, never ROWS: the remote page's per-session `tv` is
 * the row count, and a row count must mean the same thing on both ends.
 */
export type RemoteEntry =
  | { kind: 'prompt'; at: number; text: string; images?: number }
  | { kind: 'text'; at: number; text: string }
  | { kind: 'thinking'; at: number; text: string }
  | {
      kind: 'tool'; at: number; name: string; status: 'running' | 'ok' | 'error'
      runningSince?: number
      durationMs?: number
      /** The subagent's own transcript, filtered by the same rule. */
      children?: RemoteEntry[]
    }
  | { kind: 'phase'; at: number; from: string; to: string; note?: string }
  | { kind: 'result'; at: number; summary: string; durationMs?: number }
  | { kind: 'notice'; at: number; message: string; urgency: 'info' | 'blocked' }
  | { kind: 'error'; at: number; message: string }

/** A session's transcript tail as the relay stores it — conversation, not
 *  code. */
export interface RemoteTail {
  key: string
  /** When this tail was written. */
  at: number
  entries: RemoteEntry[]
}

/** How much of a transcript the relay keeps per session. A tail this long is a
 *  readable conversation; any longer and every push of a busy session carries
 *  the same 20k-token prefix over again. */
export const TAIL_MAX = 120

/** The sha-256 of a pairing code, hex. The relay derives its storage names
 *  from this, so a board is addressable only by someone who knows the code —
 *  and the code itself is never stored anywhere except this machine's keychain
 *  and the head of the remote viewer. */
export function boardIdOf(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 24)
}

/** The relay's blob name for a board's index. */
export const indexBlob = (id: string): string => `i:${id}`

/** The relay's blob name for one session's tail. */
export const tailBlob = (id: string, key: string): string => `t:${id}:${key}`

/**
 * Build the index payload. `tvOf` supplies each session's tail version — the
 * host owns the counter, because it owns the pushes that bump it.
 */
export function projectIndex(
  at: number,
  columns: readonly RemoteColumn[],
  cards: readonly RemoteCardSource[],
  tvOf: (key: string) => number,
): RemoteIndex {
  const sessions: Record<string, RemoteCard> = {}
  for (const c of cards) {
    sessions[c.key] = { ...c, tv: tvOf(c.key) }
  }
  return {
    v: 1,
    at,
    columns: columns.map((c) => ({ id: c.id, name: c.name })),
    sessions,
  }
}

/**
 * The tail of a transcript that may be sent: the LAST `TAIL_MAX` top-level
 * entries. `history` is everything the run had when it began, `live` is what
 * it has produced since — the same two arrays the local chat renders, so the
 * remote shows the same conversation the window shows, in the same order.
 * Each kept row passes through `redactEntry`, and the redaction drops fields
 * never rows, so a row count means the same thing on both ends of the wire.
 * Returns null when the tail is empty — an empty tail is nothing to store.
 */
export function projectTail(
  at: number,
  key: string,
  history: readonly Entry[],
  live: readonly Entry[],
): RemoteTail | null {
  const all = live.length >= TAIL_MAX
    ? live.slice(live.length - TAIL_MAX)
    : [...history, ...live].slice(-TAIL_MAX)
  if (!all.length) return null
  return { key, at, entries: all.map(redactEntry) }
}

/** One row of a transcript, reduced to what may leave this machine. The type
 *  says it, but the one field a reader would trust is asserted here too: a
 *  tool row loses `summary` and `id`, keeping its name and how it went. */
export function redactEntry(e: Entry): RemoteEntry {
  switch (e.kind) {
    case 'prompt':
      return e.images
        ? { kind: 'prompt', at: e.at, text: e.text, images: e.images }
        : { kind: 'prompt', at: e.at, text: e.text }
    case 'text':
      return { kind: 'text', at: e.at, text: e.text }
    case 'thinking':
      return { kind: 'thinking', at: e.at, text: e.text }
    case 'tool': {
      const out: RemoteEntry = {
        kind: 'tool', at: e.at, name: e.name, status: e.status,
        ...(e.runningSince !== undefined ? { runningSince: e.runningSince } : {}),
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      }
      if (e.children?.length) out.children = e.children.map(redactEntry)
      return out
    }
    case 'phase':
      return { kind: 'phase', at: e.at, from: e.from, to: e.to, ...(e.note ? { note: e.note } : {}) }
    case 'result':
      return { kind: 'result', at: e.at, summary: e.summary, ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}) }
    case 'notice':
      return { kind: 'notice', at: e.at, message: e.message, urgency: e.urgency }
    case 'error':
      return { kind: 'error', at: e.at, message: e.message }
  }
}

/** A session key is user data as far as the relay is concerned (it rides in a
 *  blob name). Keys are run or session ids; anything else is refused. */
export const KEY_OK = /^[A-Za-z0-9._-]{1,80}$/

/** A scheme prefix, so `ftp://x.com` is refused instead of being turned into
 *  the nonsense URL `https://ftp://x.com` (which PARSES, as host `ftp:`). */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** The relay URL a code addresses. Accepts the bare site and the function
 *  path, so a user pasting either works. */
export function relayBase(raw: string): string | undefined {
  let url = (raw || '').trim().replace(/\/+$/, '')
  if (!url) return undefined
  if (!HAS_SCHEME.test(url)) url = 'https://' + url
  let u: URL
  try { u = new URL(url) } catch { return undefined }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  // Normalise away a function path the user may have pasted from the address
  // bar, and a site subpath: the function lives at /.netlify/functions/board.
  const idx = u.pathname.indexOf('/.netlify/functions/')
  if (idx >= 0) u.pathname = u.pathname.slice(0, idx)
  return u.toString().replace(/\/$/, '')
}
