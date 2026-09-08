/**
 * The pure half of Remote Control: what leaves this machine and how it is
 * addressed. The engine that decides WHEN things leave lives in pusher.ts and
 * is tested there; this file pins the payload shape — the redaction boundary —
 * because the whole point of the feature is that a payload contains EXACTLY
 * the declared fields, and nothing the codebase knows but the type does not.
 *
 * "A write with no round trip is not persistence" applies here as: a payload
 * whose shape nothing asserts will quietly grow a field that should never have
 * left (a git branch, a model list) and no test will notice. So the output of
 * projectIndex is asserted field-by-field and absent-field-by-absent-field.
 */
import {
  boardIdOf,
  indexBlob,
  KEY_OK,
  projectComposer,
  projectIndex,
  projectTail,
  relayBase,
  TAIL_MAX,
  tailBlob,
  type RemoteIndex,
  type RemoteTail,
} from '../relay.ts'
import type { Entry } from '../../sessions/store.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

const prompt = (at: number, text: string): Entry => ({ kind: 'prompt', at, text })
const text = (at: number, text: string): Entry => ({ kind: 'text', at, text })
const phase = (at: number, to: string): Entry => ({ kind: 'phase', at, from: 'x', to })
const result = (at: number, summary: string): Entry => ({ kind: 'result', at, summary })
const tool = (at: number, name: string, summary: string): Entry =>
  ({ kind: 'tool', at, id: name + at, name, summary, status: 'ok' })

// --- boardIdOf ---------------------------------------------------------------

{
  const a = boardIdOf('hunter2'), b = boardIdOf('hunter3')
  ok(a.length === 24 && /^[0-9a-f]+$/.test(a), 'the board id is 24 hex chars of a sha-256')
  ok(a !== b, 'a different code is a different board')
  ok(boardIdOf('hunter2') === a, 'the same code is the same board, always')
  ok(indexBlob(a) === `i:${a}` && tailBlob(a, 'abc') === `t:${a}:abc`,
    'index and tail names are derived from the id — the code itself is not in them')
  ok(KEY_OK.test('abc-1._x') && !KEY_OK.test('a/b') && !KEY_OK.test('') && !KEY_OK.test('a'.repeat(81)),
    'session keys are restricted to the characters that are safe in a blob name')
}

// --- projectIndex: the redaction boundary -----------------------------------

const CARDS = [
  {
    key: 'abc', title: 'Fix the login bug', phase: 'implementing',
    tags: ['auth', 'bug-fix'], archived: false, updated: 5000,
    runtime: 'claude-code',
    agent: { kind: 'claude', tool: 'Bash', since: 4000 },
  },
  {
    key: 'def', title: 'Research SSO', phase: 'backlog',
    tags: [], archived: true, updated: 3000,
  },
]

{
  const tvs: Record<string, number> = { abc: 7, def: 2 }
  const idx = projectIndex(9999, [{ id: 'impl', name: 'Implementing' }], CARDS, (k) => tvs[k] ?? 0, false)
  ok(idx.v === 1 && idx.at === 9999, 'the index carries its version and write time')
  ok(idx.columns.length === 1 && idx.columns[0]!.name === 'Implementing',
    'columns are copied as id and name only')
  const c = idx.sessions['abc']
  ok(c !== undefined && c.title === 'Fix the login bug' && c.phase === 'implementing',
    'a live card carries title, phase, tags')
  ok(c!.tags.join(',') === 'auth,bug-fix' && c!.updated === 5000 && c!.archived === false,
    'tags and update time survive')
  ok(c!.runtime === 'claude-code' && c!.agent?.kind === 'claude' && c!.agent?.tool === 'Bash',
    'runtime and the live agent come across')
  ok(c!.tv === 7 && idx.sessions['def']!.tv === 2, 'each card carries its tail version')
  ok(idx.sessions['def']!.archived === true && idx.sessions['def']!.agent === undefined,
    'an archived idle card has no agent row at all')
  ok(idx.writes === false, 'the host’s write-channel toggle rides the index — false when it is off')
  const keys = Object.keys(idx.sessions).sort()
  ok(keys.join(',') === 'abc,def', 'only the cards given, nothing else')
  const serialised = JSON.stringify(idx)
  const idxKeys = Object.keys(JSON.parse(serialised)).sort().join(',')
  ok(idxKeys === 'at,columns,sessions,v,writes',
    `the index carries exactly its five fields (got: ${idxKeys})`)
  const cardKeys = Object.keys(JSON.parse(serialised).sessions['abc']).sort().join(',')
  ok(cardKeys === 'agent,archived,key,phase,runtime,tags,title,tv,updated',
    `the live card carries exactly its nine declared fields, not one more (got: ${cardKeys})`)
  const idleKeys = Object.keys(JSON.parse(serialised).sessions['def']).sort().join(',')
  ok(idleKeys === 'archived,key,phase,tags,title,tv,updated',
    `the idle card carries exactly seven (got: ${idleKeys})`)
  ok(!serialised.includes('pendingPermission') && !serialised.includes('testPlan'),
    'no permission or test-plan data is in the payload')
  const sample: RemoteIndex = JSON.parse(serialised)
  ok(sample.sessions['abc']!.key === 'abc', 'round-tripped through JSON — as it will over the wire')
}

// projectIndex must never invent a card for a key the caller never named.
{
  const idx = projectIndex(1, [], CARDS, () => 0, false)
  ok(Object.keys(idx.sessions).length === 2, 'no phantom sessions in an index')
}

// The writes flag is the host's own value, carried verbatim — the page draws
// its composer from it, so a flag the relay could rewrite would be a dead or
// lying control.
{
  const idx = projectIndex(1, [], [], () => 0, true)
  ok(idx.writes === true, 'writes: true is carried true')
}

// The composer is the one place the "no configuration crosses" rule bends, and
// it bends only as far as the page needs: ids and labels. projectComposer is
// the filter — the host's composer state carries contexts, prices and providers;
// only the declared fields above may leave.
{
  ok(projectComposer(undefined) === undefined, 'no composer state publishes nothing')
  ok(projectComposer({}) === undefined, 'an empty composer publishes nothing')

  const c = projectComposer({
    model: 'claude-sonnet-5',
    effort: 'high',
    thinking: 'disabled',
    thinkingSupported: true,
    models: [
      { id: 'claude-sonnet-5', label: 'Sonnet 5', context: 200_000, price: '$3/$15' },
      { id: 'claude-opus-5', label: 'Opus 5', context: 200_000, price: '$15/$75' },
    ],
    efforts: [
      { key: 'low', label: 'Low' },
      { key: 'high', label: 'High' },
    ],
  })
  ok(c !== undefined && c.model === 'claude-sonnet-5' && c.effort === 'high'
    && c.thinking === 'disabled' && c.thinkingSupported === true,
    'the current model, effort and thinking switch come across')
  ok(c!.models!.length === 2 && c!.models![0]!.id === 'claude-sonnet-5'
    && c!.models![0]!.label === 'Sonnet 5',
    'the model list is ids and labels only')
  ok(c!.efforts!.length === 2 && c!.efforts![1]!.key === 'high' && c!.efforts![1]!.label === 'High',
    'the effort list is keys and labels only')
  const modelKeys = Object.keys(c!.models![0]!).sort().join(',')
  const effortKeys = Object.keys(c!.efforts![0]!).sort().join(',')
  ok(modelKeys === 'id,label' && effortKeys === 'key,label',
    'a model is exactly id+label and an effort exactly key+label')
  const serial = JSON.stringify(c)
  ok(!serial.includes('context') && !serial.includes('price') && !serial.includes('$'),
    'contexts, prices and per-effort model lists do not cross')

  const loose = projectComposer({ thinking: 'sometimes' })
  ok(loose === undefined, 'a thinking value the remote does not know publishes nothing')
  const narrow = projectComposer({ thinking: 'enabled' })
  ok(narrow!.thinking === 'enabled', 'thinking narrows to the two modes the remote understands')
}

// A composer rides the index only when the host has one to publish.
{
  const idx = projectIndex(1, [], [], () => 0, true, {
    model: 'claude-sonnet-5', models: [{ id: 'claude-sonnet-5', label: 'Sonnet 5' }],
  })
  ok(idx.composer?.model === 'claude-sonnet-5' && idx.composer?.models?.length === 1,
    'a composer rides the index when the host publishes one')
}

// --- projectTail -------------------------------------------------------------

{
  const hist = [prompt(1, 'hello'), text(2, 'hi there')]
  const live = [tool(3, 'Bash', 'git status'), text(4, 'done')]
  const t = projectTail(99, 'abc', hist, live)
  ok(t !== null && t!.key === 'abc' && t!.at === 99 && t!.entries.length === 4,
    'a tail carries the key, write time and the merged conversation')
  ok(t!.entries[0]!.kind === 'prompt' && t!.entries[3]!.kind === 'text' && t!.entries[3]!.text === 'done',
    'history comes first, live rows after — the order the chat renders')
}

// The redaction boundary on a row: a tool row summarises as its COMMAND, an
// Edit row as its PATH — summaries are derived from the tool input, so a
// summary must never reach the relay. Rows are preserved one-for-one; only
// fields drop, because the remote page's `tv` is a row count.
{
  const venom: Entry = {
    kind: 'tool', at: 3, id: 'call_1', name: 'Bash',
    summary: 'rm -rf /home/david/Projects/secret', status: 'ok', durationMs: 400,
    children: [
      { kind: 'prompt', at: 4, text: 'brief', id: 'msg_uuid' },
      { kind: 'tool', at: 5, id: 'call_2', name: 'Edit', summary: '/abs/path/src/x.ts', status: 'error' },
      { kind: 'text', at: 6, text: 'nested answer' },
    ],
  }
  const withCost: Entry = { kind: 'result', at: 7, summary: 'done', durationMs: 90, costUsd: 1.25 }
  const withImages: Entry = { kind: 'prompt', at: 8, text: '', images: 2 }
  const t = projectTail(1, 'abc', [venom, withCost, withImages], [])!
  const rows = t.entries
  ok(rows.length === 3, 'redaction drops fields, never rows — the count stays comparable')
  const serial = JSON.stringify(t)
  ok(!serial.includes('rm -rf') && !serial.includes('secret') && !serial.includes('/abs/path'),
    'a tool summary derived from a command or a path does not cross')
  ok(!serial.includes('call_1') && !serial.includes('msg_uuid') && !serial.includes('call_2'),
    'transcript uuids do not cross — they are this machine’s addressing, not conversation')
  ok(!serial.includes('1.25') && !serial.includes('costUsd'),
    'a dollar figure does not cross — it is a meter reading, not conversation')
  const bash = rows[0] as { kind: string; name?: string; summary?: unknown; children?: unknown[] }
  ok(bash.kind === 'tool' && bash.name === 'Bash' && bash.summary === undefined,
    'the tool row keeps its name and loses its summary')
  ok(rows[0]!.kind === 'tool' && (rows[0] as { durationMs?: number }).durationMs === 400,
    'and keeps how long the call took — the row still tells the story')
  const kids = (rows[0] as { children?: Array<{ kind: string; summary?: unknown; text?: string }> }).children
  ok(!!kids && kids.length === 3, 'a subagent transcript crosses, nested under its Task')
  ok(kids![0]!.kind === 'prompt' && kids![0]!.text === 'brief' && kids![0]!.summary === undefined,
    '…and the same rule applies inside it')
  ok(kids![2]!.kind === 'text' && kids![2]!.text === 'nested answer', 'nested conversation survives')
  const img = rows[2] as { kind: string; images?: number }
  ok(img.kind === 'prompt' && img.images === 2, 'an image-only prompt carries its image COUNT — never the bytes')
}

{
  const hist: Entry[] = []
  for (let i = 0; i < TAIL_MAX; i++) hist.push(prompt(1000 + i, `m${i}`))
  const live: Entry[] = []
  for (let i = 0; i < 50; i++) live.push(text(2000 + i, `l${i}`))
  const t = projectTail(1, 'abc', hist, live)!
  const first = t.entries[0]!, last = t.entries[TAIL_MAX - 1]!
  ok(t.entries.length === TAIL_MAX, 'a long conversation is capped at TAIL_MAX entries')
  ok(first.kind === 'prompt' && first.text === 'm50' && last.kind === 'text' && last.text === 'l49',
    'the cap keeps the newest — the head of history rolls off, the live rows stay')
  const merged: Entry[] = []
  for (let i = 0; i < 300; i++) merged.push(prompt(i, `m${i}`))
  const t2 = projectTail(1, 'abc', merged, [])!
  ok(t2.entries.length === TAIL_MAX && t2.entries[0]!.at === 180,
    'a long HISTORY alone is capped from its own tail')
}

{
  ok(projectTail(1, 'abc', [], []) === null, 'nothing to send is null, not an empty tail')
  const one: RemoteTail = projectTail(1, 'abc', [], [prompt(1, 'x')])!
  ok(one.entries.length === 1, 'a single row is a tail of one')
}

// --- relayBase ---------------------------------------------------------------

ok(relayBase('https://board.example.com') === 'https://board.example.com', 'a bare https URL passes')
ok(relayBase('board.example.com') === 'https://board.example.com', 'a missing scheme is https')
ok(relayBase('  https://board.example.com/  ') === 'https://board.example.com', 'whitespace and a slash trim')
ok(relayBase('https://board.example.com/.netlify/functions/board') === 'https://board.example.com',
  'a pasted function path normalises to the site root')
ok(relayBase('https://board.example.com/foo/.netlify/functions/board') === 'https://board.example.com/foo',
  'a subpath before the function path is kept')
ok(relayBase('https://board.example.com/board') === 'https://board.example.com',
  'the common /board API path (every host) normalises to the site root')
ok(relayBase('https://board.example.com/foo/board') === 'https://board.example.com/foo',
  'a subpath before /board is kept')
ok(relayBase('https://board.example.com/board/') === 'https://board.example.com',
  '…trailing slash and all')
ok(relayBase('') === undefined && relayBase('   ') === undefined, 'blank is undefined')
ok(relayBase('not a url') === undefined && relayBase('ftp://x.com') === undefined,
  'unparseable and non-http schemes are refused')

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('relay: all ok')
