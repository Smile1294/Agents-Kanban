/**
 * Search across transcripts — every word the transcript can SHOW.
 *
 * The original request ("search across transcripts, and hide all the AI
 * commands and all that, just filter for actual responses") narrowed the
 * searchable kinds to prompts and agent answers, and the tests spelled the
 * exclusions out. The follow-up widened it again: "tool rows
 * (name/command/path), tool results, every user-visible text — over the
 * FULL transcript". So the searchable surface is every row's rendered text:
 *
 *  - `prompt`   — what the user asked
 *  - `text`     — what the agent answered
 *  - `thinking` — visible when its disclosure is opened
 *  - `tool`     — the row's name and summary, which is where a Bash command
 *                 or a Read path lives
 *  - `phase`    — the move and its note
 *  - `result`   — the turn's summary
 *  - `notice` / `error` — the message
 *  - subagent transcripts nested under a Task row — visible when the Task
 *    is expanded; a hit there is marked `nested` and points at the Task
 *    that contains it, because that is the row a jump can land on.
 *
 * Two things stay OUT, both on purpose. A tool row's raw `input` that never
 * reaches the screen is not user-visible text — `summariseTool` already
 * clips what the row shows, and a match against invisible input would flash
 * a row that does not say why. And a tool RESULT's content is not rendered
 * anywhere in this view (the result's only visible trace is the tool row's
 * status word, and matching on "ok"/"error" is noise, not search), so it is
 * not searched either — the transcript the user can read is the searchable
 * surface, no more, no less.
 *
 * Pure. The caller owns where entries come from (a live run's history, a
 * session file read in full) and the view owns how a hit is shown; this
 * module owns which rows match and what snippet proves it. All matching is
 * on the row's plain text — markdown markers included, exactly as the row
 * stores it.
 */
import type { Entry } from './store.ts'

/** One matching row in one transcript. `entryIndex` is an index into the
 *  FULL top-level transcript array — the host translates it into the chat's
 *  rendered window when the hit is opened (see `openHit` / `transcriptHead`),
 *  so a hit can jump to the row that contains it rather than to "somewhere
 *  in this session". */
export interface TranscriptHit {
  /** Index of the entry within the full top-level transcript array searched. */
  entryIndex: number
  /** When the matched text was written. */
  at: number
  /** What the matched text was, so the result can say "you asked", "a tool
   *  call", "the agent's thinking" instead of guessing. */
  kind: Entry['kind']
  /** True when the match is inside a subagent transcript nested under the
   *  tool row at `entryIndex` — the label says so, and the snippet is the
   *  proof of where. */
  nested?: boolean
  /** The matched text clipped around the first occurrence — a plain-text
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

/** The text a row can SHOW — exactly what searching should see. Null when
 *  the row renders no searchable words. For a tool row this is its name and
 *  summary (the command/path live inside the summary), not its raw input;
 *  see the module comment. */
function rowText(e: Entry): string | null {
  switch (e.kind) {
    case 'prompt': case 'text': case 'thinking': return e.text || null
    case 'tool': return ((e.name || '') + ' ' + (e.summary || '')).trim() || null
    case 'phase': return [e.from, e.to, e.note].filter((x) => x).join(' ')
    case 'result': return e.summary || null
    case 'notice': case 'error': return e.message
  }
}

/** The first occurrence of `ql` (lowercased query) in a row's own text or,
 *  for a Task, in its nested subagent transcript — one hit per top-level
 *  row, because the row is what a jump can land on. The matched TEXT is
 *  what it is, so a nested hit reports the child's kind and time. */
function firstMatch(
  e: Entry,
  ql: string,
): { text: string; index: number; kind: Entry['kind']; at: number; nested: boolean } | null {
  const own = rowText(e)
  if (own) {
    const i = own.toLowerCase().indexOf(ql)
    if (i >= 0) return { text: own, index: i, kind: e.kind, at: e.at, nested: false }
  }
  if (e.kind === 'tool' && e.children?.length) {
    for (const kid of e.children) {
      const found = firstMatch(kid, ql)
      if (found) return { ...found, nested: true }
    }
  }
  return null
}

/**
 * Every top-level row containing the query, case- and whitespace-
 * insensitively at the ends (`query` is trimmed). One hit per row: a row
 * that mentions the word a hundred times is one hit, with the snippet
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
    const found = firstMatch(e, ql)
    if (!found) continue
    hits.push({
      entryIndex: i,
      at: found.at,
      kind: found.kind,
      ...(found.nested ? { nested: true } : {}),
      snippet: snippetOf(found.text, found.index),
      lead: found.index > SNIPPET_LEAD,
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
