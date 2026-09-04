/* Does a repaint put you back where you were?

   render() rebuilds the whole tree on every state message, and an agent that is
   working produces one every few hundred milliseconds. Every scroll container
   is destroyed and recreated with it — so scrolling down a busy column, or up
   through a long transcript to read something, snapped back to the top the
   moment the agent produced a frame. The transcript had a "stick to the
   bottom" rule; nothing else had any rule at all.

   The DOM stub carries scrollTop as plain state, so this can be asserted
   without a browser. The pixel-true version lives in layout.test.mjs. */
import { boardSource, renderBoardWith, walk } from '../../../test/dom.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const src = await boardSource()
const run = (state) => renderBoardWith(src, state, { layout: 'board' })

const COLUMNS = [
  { id: 'backlog', name: 'Backlog', category: 'backlog' },
  { id: 'implementing', name: 'Implementing', category: 'started' },
  { id: 'complete', name: 'Complete', category: 'complete', humanOnly: true },
]
const cards = Array.from({ length: 12 }, (_, i) => ({
  key: 'k' + i, sessionId: 'k' + i, title: 'Session ' + i, phase: 'implementing', tags: [], updated: 1000 + i,
}))
const state = {
  ready: true, mode: 'kanban', columns: COLUMNS, cards, running: 1, waiting: 0,
  composer: { model: 'm', effort: 'high', thinking: 'enabled', models: [], efforts: [], contextTokens: 0 },
}

/** The scrollable body of the column whose header says `name`. Found by what
 *  the user sees, not by whatever attribute the fix might hang on it. */
function columnBody(root, name) {
  const col = walk(root).find((n) => n.tagName === 'section' && (n.className || '').includes('column') &&
    n.children.some((h) => (h.className || '').includes('column-head') && h.textContent.includes(name)))
  return col && col.children.find((n) => (n.className || '').includes('cards'))
}
const byClass = (root, cls) => walk(root).find((n) => (n.className || '').split(' ').includes(cls))

// --- a kanban column ---------------------------------------------------------
const board = run(state)
const before = columnBody(board.root, 'Implementing')
ok(!!before, 'the Implementing column has a scrollable body')
before.scrollTop = 120
board.deliver({ ...state, running: 0 })
const after = columnBody(board.root, 'Implementing')
ok(after && after !== before, 'a state message rebuilt the column')
ok(after && after.scrollTop === 120, `and the column is still scrolled to where it was (${after && after.scrollTop}px, not 0)`)

// A column that was NOT scrolled stays at the top — restoring must be by
// column, not one number smeared over all of them.
const other = columnBody(board.root, 'Backlog')
ok(other && other.scrollTop === 0, 'a column that was not scrolled stays at the top')

// --- the session rail ---------------------------------------------------------
const rail0 = byClass(board.root, 'rail-list')
ok(!!rail0, 'the session rail is a scroll container')
rail0.scrollTop = 80
board.deliver({ ...state, running: 1 })
const rail1 = byClass(board.root, 'rail-list')
ok(rail1 && rail1 !== rail0 && rail1.scrollTop === 80, `the rail keeps its scroll position across a repaint (${rail1 && rail1.scrollTop}px)`)

// --- the transcript, when you have scrolled UP to read -------------------------
// The stick rule follows the tail while you are at the bottom. Away from the
// bottom it must leave you exactly where you were — a frame arriving while you
// read something a minute old used to throw you to the top of the transcript.
const chatState = {
  ...state, mode: 'chat', selectedKey: 'k1',
  transcript: Array.from({ length: 30 }, (_, i) => ({ kind: 'text', at: i, text: 'paragraph ' + i })),
}
const chat = run(chatState)
const t0 = byClass(chat.root, 'transcript-scroll')
ok(!!t0, 'the transcript is a scroll container')
t0.scrollHeight = 3000; t0.clientHeight = 600; t0.scrollTop = 900   // well above the bottom
chat.deliver({ ...chatState, streaming: 'more words arriving' })
const t1 = byClass(chat.root, 'transcript-scroll')
ok(t1 && t1 !== t0 && t1.scrollTop === 900, `reading up the transcript, a new frame does not move you (${t1 && t1.scrollTop}px)`)

// --- a section you closed STAYS closed ---------------------------------------
//
// Same failure as the scroll positions above and the same fix, but reported
// separately because it is more obviously wrong: "it keeps reopening the
// Changes and how to test, I want it to be toggled by me only". Both panels
// were rebuilt with `open = true` on every frame, so while an agent worked they
// sprang back open a few hundred milliseconds after every click.
const WT_CARD = {
  key: 'k1', sessionId: 'k1', title: 'Session 1', phase: 'implementing', tags: [], updated: 1,
  worktree: '/tmp/wt/k1', branch: 'task/k1',
  testPlan: { summary: 'run the tests', steps: ['npm test'], links: [] },
}
const panelState = {
  ...state, mode: 'chat', selectedKey: 'k1', cards: [WT_CARD], transcript: [],
  review: { base: 'main', ahead: 1, dirty: 0, files: [{ path: 'a.ts', status: 'M' }] },
}
const details = (root, cls) =>
  walk(root).find((n) => n.tagName === 'details' && (n.className || '').split(' ').includes(cls))

const panels = run(panelState)
for (const cls of ['review', 'testplan']) {
  const box = details(panels.root, cls)
  ok(!!box, `the ${cls} panel is a disclosure`)
  ok(box && box.open === true, `and starts open — it is the answer to "what now?" (${cls})`)
  ok(box && box.getAttribute('data-open'),
     `and announces itself with data-open, like every rebuilt scroll container (${cls})`)
}

// The user collapses both. A browser sets `.open` itself on the click, which is
// exactly what this does.
details(panels.root, 'review').open = false
details(panels.root, 'testplan').open = false

// Now the agent produces a frame. This is the moment the bug happened.
panels.deliver({ ...panelState, streaming: 'the agent says something' })
for (const cls of ['review', 'testplan']) {
  const box = details(panels.root, cls)
  ok(box && box.open === false, `${cls} is STILL closed after a repaint — the bug this guards`)
}

// And it survives many frames, not just the next one: the harvest must read the
// state it last applied, not the state of the first render.
for (let i = 0; i < 5; i++) panels.deliver({ ...panelState, streaming: 'frame ' + i })
ok(details(panels.root, 'review').open === false, 'and after five more frames')

// Reopening one must not reopen the other — they are remembered separately.
details(panels.root, 'review').open = true
panels.deliver({ ...panelState, streaming: 'again' })
ok(details(panels.root, 'review').open === true, 'reopening Changes sticks too')
ok(details(panels.root, 'testplan').open === false, 'and does not drag the test plan open with it')

// Closing a panel is TOLD TO THE HOST, so it outlives this webview. Reopening
// the board builds a fresh view with an empty map, and without this the panel
// the user closed yesterday is open again — the same complaint, one lifetime up.
const fresh = run(panelState)
const tp = details(fresh.root, 'testplan')
tp.open = false
if (tp.ontoggle) tp.ontoggle()
const told = fresh.posted.filter((m) => m.type === 'disclosure')
ok(told.length === 1, `closing a panel tells the host once (${told.length} messages)`)
ok(told[0] && told[0].key === 'testplan' && told[0].open === false,
   `and says which panel and which way: ${JSON.stringify(told[0])}`)

// A fresh view seeded with what the host remembered starts collapsed.
const reopened = run({ ...panelState, disclosures: { testplan: false } })
ok(details(reopened.root, 'testplan').open === false,
   'a new board window honours the panel the user had closed')
ok(details(reopened.root, 'review').open === true,
   'and leaves a panel it was told nothing about at its default')

// The seed must NOT be re-applied on later frames: a state message still
// carrying `testplan: false` must not slam shut a panel just reopened.
const raced = run({ ...panelState, disclosures: { testplan: false } })
details(raced.root, 'testplan').open = true
if (details(raced.root, 'testplan').ontoggle) details(raced.root, 'testplan').ontoggle()
raced.deliver({ ...panelState, disclosures: { testplan: false }, streaming: 'a frame' })
ok(details(raced.root, 'testplan').open === true,
   'and the host\'s older copy never reopens — or closes — what the user just clicked')

console.log(fails ? `\n${fails} FAILURES` : '\nPASS — a repaint leaves scroll positions and closed panels alone')
process.exit(fails ? 1 : 0)
