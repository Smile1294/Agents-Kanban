/**
 * The pure half of transcript search: WHICH rows match, and what snippet
 * proves it. The first request behind this module narrowed the surface to
 * prompts and answers; the follow-up widened it again — "tool rows
 * (name/command/path), tool results, every user-visible text". So the
 * INCLUSIONS are asserted here, each kind by name: a row's rendered text is
 * the searchable surface, no more, no less. What stays out is asserted too:
 * a tool row's status word, because the only visible trace of a result is
 * "ok"/"error" and matching on those is noise, not search.
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

/** A transcript with every kind of row, each carrying the needle, so each
 *  kind's INCLUSION is tested against the same fixture. The Task row's own
 *  text does not carry it — its children do — and the last row is an
 *  images-only prompt with no text at all. */
const MIXED: Entry[] = [
  t({ kind: 'prompt', at: 1000, text: 'fix the jira bug please' }),
  t({ kind: 'text', at: 2000, text: 'I looked at jira and the board is green.' }),
  { kind: 'thinking', at: 3000, text: 'should I even mention jira here?' },
  { kind: 'phase', at: 4000, from: 'a', to: 'b', note: 'the jira work is done' },
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
  // Every kind whose row renders words matches: the two conversation kinds,
  // thinking, a phase's note, notices, results, errors, a tool row's
  // summary, and a nested child under the Task. Only the images-only prompt
  // has nothing to search.
  ok(hits.length === 10, `every user-visible kind matches (${hits.length} hits, want 10)`)
  const kinds = hits.map((h) => h.kind).join(',')
  ok(kinds === 'prompt,text,thinking,phase,notice,result,error,tool,prompt,text',
    `exactly those rows hit (${kinds})`)
  ok(hits.map((h) => h.entryIndex).join(',') === '0,1,2,3,4,5,6,7,8,9',
    'entry indices point at the rows that matched, in order')
}

{
  // The nested hit: found in a child under the Task at index 8, so it reports
  // the CHILD's kind and time, says `nested`, and points at the TASK — the
  // row a jump can actually land on.
  const nested = searchEntries(MIXED, 'jira')[8]!
  ok(nested.nested === true && nested.kind === 'prompt' && nested.entryIndex === 8,
    'a subagent hit is marked nested and points at the Task row that contains it')
  ok(nested.at === 9100 && nested.snippet.includes('go read jira'),
    'and carries the child row\'s own time and text')
}

{
  // A tool row's searchable surface is its NAME and SUMMARY — the command and
  // path live in the summary. Its status word is not: "ok" appears only in
  // status here, and matching on it would be noise, not search.
  const toolOnly: Entry[] = [
    { kind: 'tool', at: 1, id: 'x', name: 'Bash', summary: 'run the tests', status: 'ok' },
  ]
  ok(searchEntries(toolOnly, 'ok').length === 0, 'a tool row\'s status word never matches')
  const named = searchEntries(toolOnly, 'bash')
  ok(named.length === 1 && named[0]!.kind === 'tool', 'a tool row\'s NAME matches')
  const cmd = searchEntries(toolOnly, 'tests')
  ok(cmd.length === 1 && cmd[0]!.kind === 'tool', 'and its SUMMARY (command/path) matches')
}

{
  // One hit per top-level row, even when both the Task's own text and a
  // child's carry the needle: the row is what a jump lands on, and the own
  // text is the first thing searched.
  const task: Entry[] = [
    { kind: 'tool', at: 1, id: 'x', name: 'Task', summary: 'jira task', status: 'ok',
      children: [t({ kind: 'text', at: 2, text: 'jira again' })] },
  ]
  const hits = searchEntries(task, 'jira')
  ok(hits.length === 1 && hits[0]!.nested === undefined,
    'a Task whose own text matches is one hit, not nested — own text wins over children')
  const childOnly: Entry[] = [
    { kind: 'tool', at: 1, id: 'x', name: 'Task', summary: 'a task', status: 'ok',
      children: [t({ kind: 'text', at: 2, text: 'jira jira jira' })] },
  ]
  ok(searchEntries(childOnly, 'jira').length === 1,
    'and a matching child under a non-matching Task is still one hit, at the Task')
}

{
  // The case and edge rules.
  const hits = searchEntries(MIXED, '  JIRA  ')
  ok(hits.length === 10, 'the query is trimmed and matched case-insensitively')
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
