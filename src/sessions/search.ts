/**
 * Search across transcripts, filtered for what a conversation actually WAS.
 *
 * The board's rail already filters SESSIONS by title and tag. This searches
 * the CONTENT — and deliberately not all of it: the request that produced it
 * was "search across transcripts, and hide all the AI commands and all that,
 * just filter for actual responses". So the searchable kinds are exactly two:
 *
 *  - `prompt` — what the user asked (the human side of the conversation)
 *  - `text`   — what the agent answered (assistant content, not tool calls)
 *
 * Everything else is machinery and is not searched: `tool` rows (Bash, Edit,
 * every command an agent runs), `thinking` (drafts of answers, not answers),
 * phase moves, notices, results and errors, and the nested transcripts of
 * subagent frames — those are agent-generated conversations BETWEEN agents,
 * which is the command machinery the request named. If that line moves, this
 * is the module that moves it, and its tests spell the exclusion out.
 *
 * Pure. The caller owns where entries come from (a live run's history, a
 * session file) and the view owns how a hit is shown; this module owns which
 * rows match and what snippet proves it. All matching is on the row's plain
 * text — markdown markers included, exactly as the row stores it.
 */
import type { Entry } from './store.ts'

/** One matching row in one transcript. Positions are indices into the SAME
 *  array the chat view renders, so a hit can jump to the row that contains it
 *  rather than to "somewhere in this session". */
export interface TranscriptHit {
  /** Index of the entry within the top-level transcript array searched. */
  entryIndex: number
  /** When the message was written. */
  at: number
  /** Who wrote the text — the two searchable kinds, kept so the result can
   *  say "your prompt" or "the agent's answer" instead of guessing. */
  kind: 'prompt' | 'text'
  /** The row's text clipped around the first occurrence — a plain-text
   *  preview, never the whole row, which can be a 50k-token answer. `lead`
   *  says the clip starts mid-text, so the view draws a leading ellipsis
   *  rather than suggesting the snippet is the row's start. */
  snippet: string
  lead: boolean
}

/** How long a snippet may be. Long enough to read a match in context, short
 *  enough that a page of 200 hits stays a page of previews. */
export const SNIPPET_MAX = 340
/** How much of the row before the first occurrence the snippet keeps. */
const SNIPPET_LEAD = 60

/**
 * Every top-level `prompt` and `text` row containing the query, case- and
 * whitespace-insensitively at the ends (`query` is trimmed). One hit per row:
 * a row that mentions the word a hundred times is one hit, with the snippet
 * around the first mention. Rows with no text (an images-only prompt) cannot
 * match, whatever the query says.
 */
export function searchEntries(entries: readonly Entry[], query: string): TranscriptHit[] {
  const q = query.trim()
  if (!q) return []
  const ql = q.toLowerCase()
  const hits: TranscriptHit[] = []
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (!e) continue
    if (e.kind !== 'prompt' && e.kind !== 'text') continue
    const text = e.text || ''
    if (!text) continue
    const first = text.toLowerCase().indexOf(ql)
    if (first < 0) continue
    hits.push({
      entryIndex: i,
      at: e.at,
      kind: e.kind,
      snippet: snippetOf(text, first),
      lead: first > SNIPPET_LEAD,
    })
  }
  return hits
}

/** The row's text around an occurrence: up to `SNIPPET_LEAD` before it, then
 *  up to `SNIPPET_MAX` characters of context. No word-boundary gymnastics —
 *  a clip may cut mid-word and that is fine for a preview. */
export function snippetOf(text: string, first: number): string {
  const start = Math.max(0, first - SNIPPET_LEAD)
  const end = Math.min(text.length, start + SNIPPET_MAX)
  return text.slice(start, end)
}
