/**
 * The pure half of transcript search: WHICH rows match, and what snippet
 * proves it. The request behind this module is explicit about the filtering —
 * "hide all the AI commands and all that, just filter for actual responses" —
 * so the exclusions are asserted here, each by name, the way the board tests
 * assert the fork affordance's gate on both sides.
 */
import { searchEntries, snippetOf, SNIPPET_MAX } from '../search.ts'
import type { Entry } from '../store.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

const t = (over: Partial<Entry & { text: string; at: number; kind: 'prompt' | 'text' }> = {}): Entry =>
  ({ kind: 'prompt', at: 1000, text: '', ...over }) as Entry

/** A transcript with every kind of row, so each kind's exclusion is tested
 *  against the same fixture. The needle is the word the noise rows also carry. */
const MIXED: Entry[] = [
  t({ kind: 'prompt', at: 1000, text: 'fix the jira bug please' }),
  t({ kind: 'text', at: 2000, text: 'I looked at jira and the board is green.' }),
  { kind: 'thinking', at: 3000, text: 'should I even mention jira here?' },
  { kind: 'phase', at: 4000, from: 'a', to: 'b' },
  { kind: 'notice', at: 5000, message: 'jira unrelated', urgency: 'info' },
  { kind: 'result', at: 6000, summary: 'jira noise' },
  { kind: 'error', at: 7000, message: 'jira broke' },
  { kind: 'tool', at: 8000, id: 'x1', name: 'Bash', summary: 'grep jira in the logs', status: 'ok' },
  { kind: 'tool', at: 9000, id: 'x2', name: 'Task', summary: 'run a subagent', status: 'ok',
    children: [
      t({ kind: 'prompt', at: 9100, text: 'go read jira' }),
      t({ kind: 'text', at: 9200, text: 'jira says it is fine' }),
    ] },
  { kind: 'text', at: 10_000, text: 'JIRA is fixed now.' },
  { kind: 'prompt', at: 11_000, text: '', id: 'img-only' },
]

// --- which rows match --------------------------------------------------------

{
  const hits = searchEntries(MIXED, 'jira')
  ok(hits.length === 3, 'the two real kinds match and nothing else')
  const kinds = hits.map((h) => h.kind).join(',')
  ok(kinds === 'prompt,text,text', `exactly prompt+text rows hit (${kinds})`)
  ok(hits.map((h) => h.entryIndex).join(',') === '0,1,9',
    'entry indices point at the rows that matched — the noise rows still occupy indices')
  ok(hits[2]!.snippet.endsWith('JIRA is fixed now.') && hits[2]!.at === 10_000,
    'the hit carries its row\'s time and text')
}

{
  // Tool rows, thinking, phases, notices, results and errors all carry the
  // needle in the fixture; the request named them as the noise to hide.
  const toolText = MIXED.filter((e) => e.kind === 'tool' || e.kind === 'thinking')
  ok(searchEntries(toolText, 'jira').length === 0,
    'thinking and tool rows (the command machinery) never match')
  const system = MIXED.filter((e) => ['phase', 'notice', 'result', 'error'].includes(e.kind))
  ok(searchEntries(system, 'jira').length === 0,
    'phase moves, notices, results and errors never match')
  const withChild = searchEntries(MIXED.filter((e) => e.kind === 'tool'), 'jira')
  ok(withChild.length === 0, 'and subagent frames under a Task do not either')
}

{
  // The case and edge rules.
  const hits = searchEntries(MIXED, '  JIRA  ')
  ok(hits.length === 3, 'the query is trimmed and matched case-insensitively')
  ok(searchEntries(MIXED, '  ').length === 0, 'a blank query matches nothing')
  ok(searchEntries(MIXED, 'no-such-word-anywhere').length === 0, 'a miss is a miss')
  const img = searchEntries(MIXED.slice(-1), 'jira')
  ok(img.length === 0, 'a prompt with no text cannot match — images-only rows have nothing to search')
}

// --- the snippet -------------------------------------------------------------

{
  const long = 'a'.repeat(200) + 'NEEDLE' + 'b'.repeat(400)
  const s = snippetOf(long, 200)
  ok(s.length <= SNIPPET_MAX, 'a snippet is bounded')
  ok(s.includes('NEEDLE'), 'it always contains the occurrence')
  ok(searchEntries([t({ kind: 'text', at: 1, text: long })], 'needle')[0]!.lead === true,
    'and says when the occurrence was deep enough that the clip starts mid-text')
  const front = searchEntries([t({ kind: 'text', at: 1, text: 'NEEDLE here' })], 'needle')[0]!
  ok(front.lead === false && front.snippet.startsWith('NEEDLE'),
    'an occurrence near the start leads with the row\'s own beginning')
  const wide = searchEntries([t({ kind: 'text', at: 1, text: 'x ' + 'y'.repeat(500) })], 'zy')
  ok(wide.length === 0, 'a needle that does not exist does not produce a hit with an empty snippet')
}

// --- one hit per row ---------------------------------------------------------

{
  const row = t({ kind: 'text', at: 1, text: 'jira jira jira — that is a lot of jira' })
  const hits = searchEntries([row], 'jira')
  ok(hits.length === 1, 'a row that mentions the word four times is ONE hit')
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('search: all ok')
