/* The AskUserQuestion picker, driven through the real media/board.js.

   The bug: an agent's question arrived as an ordinary permission prompt —
   "Claude wants to run" and an Allow button — with the question and its options
   nowhere on screen. Pressing Allow resolved the tool with its input untouched,
   so the tool reported that nobody had answered and the agent guessed. From the
   user's side: "it said it wanted to ask me something, I pressed allow, and no
   question ever appeared."

   These assert the two halves that were missing: the options are rendered, and
   pressing Send posts what the user picked. The view posts SELECTIONS, not
   finished answer strings — the host rebuilds those from the tool's own
   questions, so a webview cannot decide what the model is told. The webview has
   no type checking, so a throw in here is a silently blank panel. */
import { boardSource, renderBoardWith, walk } from '../../../test/dom.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const click = (n) => n.onclick({ stopPropagation() {} })
const byClass = (root, cls) => walk(root).filter((n) => String(n.className || '').split(' ').includes(cls))
const buttonSaying = (root, text) =>
  walk(root).find((n) => n.tagName === 'button' && String(n.textContent).includes(text))
/** An option button by its label. Matched on the exact class, because
 *  `ask-opt-label` and `ask-opt-desc` both contain "ask-opt" as a substring and
 *  neither of them is clickable. */
const option = (root, label) => byClass(root, 'ask-opt').find((n) => n.textContent.includes(label))

const QUESTIONS = [
  {
    question: 'Which database should we use?',
    header: 'Database',
    multiSelect: false,
    options: [
      { label: 'Postgres', description: 'Relational, what the team knows' },
      { label: 'SQLite', description: 'No server to run' },
    ],
  },
  {
    question: 'Which features go in v1?',
    header: 'Features',
    multiSelect: true,
    options: [{ label: 'Auth' }, { label: 'Billing' }],
  },
]

const COMPOSER = {
  model: 'claude-opus-5', effort: 'high', thinking: 'enabled',
  models: [{ id: 'claude-opus-5', label: 'Opus 5', context: '200K' }],
  efforts: [{ key: 'high', label: 'High' }],
  contextTokens: 1000, contextWindow: 200000,
  permissionMode: 'acceptEdits', permissionModes: [{ key: 'acceptEdits', label: 'Auto', detail: 'x' }],
}
const COLUMNS = [{ id: 'implementing', name: 'Implementing', category: 'started' }]

const cardWith = (pendingPermission) => ({
  key: 'abc-123', sessionId: 'abc-123', title: 'Pick a stack', phase: 'implementing',
  tags: [], updated: Date.now(),
  agent: { kind: 'needsInput', contextTokens: 1000, contextWindow: 200000, pendingPermission },
})
const stateWith = (pendingPermission) => ({
  ready: true, mode: 'kanban', columns: COLUMNS, cards: [cardWith(pendingPermission)],
  composer: COMPOSER, running: 1, waiting: 1,
})

const src = await boardSource()

// --- an ordinary permission request is untouched -----------------------------
// The picker must not swallow the Allow/Deny prompt it sits beside.
{
  const v = renderBoardWith(src, stateWith({ id: 'p1', summary: 'Bash — rm -rf build' }))
  /* The fallback names whatever is RUNNING, not a vendor we are guessing at —
     it said "Claude wants to run" over a `deepseek-v4-pro` session. */
  ok(/wants to run/.test(v.text()), 'a real permission request still says so')
  ok(!v.text().includes('Claude wants to run'),
     'attributed to the model in front of you rather than to Claude by default')
  ok(!!buttonSaying(v.root, 'Allow'), 'and still offers Allow')
  click(buttonSaying(v.root, 'Allow'))
  const posted = v.posted.filter((m) => m.type === 'permission').pop()
  ok(posted.allow === true, 'allowing posts allow:true')
  ok(posted.selections === undefined, 'and carries no selections, because it was not a question')
}

// --- a question renders as a question ----------------------------------------
const ask = { id: 'q1', summary: 'AskUserQuestion', questions: QUESTIONS }
{
  const v = renderBoardWith(src, stateWith(ask))
  const t = v.text()
  ok(!t.includes('Claude wants to run'), 'a question is NOT dressed up as a permission request')
  ok(t.includes('Which database should we use?'), 'the first question is on screen')
  ok(t.includes('Which features go in v1?'), 'the second question is on screen too')
  ok(t.includes('Database') && t.includes('Features'), 'each header chip is shown')
  ok(t.includes('Postgres') && t.includes('SQLite'), 'the options are shown')
  ok(t.includes('Relational, what the team knows'), 'option descriptions are shown')
  ok(byClass(v.root, 'ask-opt').length === 4, 'every option across both questions is clickable')
  ok(byClass(v.root, 'ask-other').length === 2, 'each question offers a free-text answer')

  // Nothing may be sent until every question is answered — a partial record is
  // how the agent ends up inventing the decisions it stopped to ask about.
  const send = buttonSaying(v.root, 'still to answer')
  ok(!!send && send.disabled === true, 'Send is disabled while questions are unanswered')
  ok(v.text().includes('2 still to answer'), 'and says how many are outstanding')
}

// --- choosing, and surviving the repaint -------------------------------------
{
  const v = renderBoardWith(src, stateWith(ask))
  click(option(v.root, 'Postgres'))
  ok(v.text().includes('1 still to answer'), 'answering one question leaves one outstanding')

  // The rule this codebase is built on: an agent at work repaints several times
  // a second. A choice held in the DOM would be gone on the next frame.
  v.deliver(stateWith(ask))
  const chosen = option(v.root, 'Postgres')
  ok(String(chosen.className).includes('on'), 'the choice survives a repaint from the host')
  ok(v.text().includes('1 still to answer'), 'and the outstanding count survives with it')

  click(option(v.root, 'Auth'))
  const send = buttonSaying(v.root, 'Send answer')
  ok(!!send && !send.disabled, 'Send turns on once every question is answered')

  click(send)
  const posted = v.posted.filter((m) => m.type === 'permission').pop()
  ok(posted.allow === true, 'sending allows the tool')
  ok(!!posted.selections, 'and posts selections — the thing that was missing entirely')
  ok(posted.selections['Which database should we use?'].join() === 'Postgres', 'the single-select choice is sent')
  ok(posted.selections['Which features go in v1?'].join() === 'Auth', 'the multi-select choice is sent too')
  ok(posted.requestId === 'q1', 'against the request that asked')
}

// --- multi-select takes more than one ----------------------------------------
{
  const v = renderBoardWith(src, stateWith(ask))
  for (const label of ['Postgres', 'Auth', 'Billing']) {
    click(option(v.root, label))
  }
  click(buttonSaying(v.root, 'Send answer'))
  const posted = v.posted.filter((m) => m.type === 'permission').pop()
  ok(posted.selections['Which features go in v1?'].join(', ') === 'Auth, Billing', 'both multi-select choices are sent')

  // Single-select replaces rather than accumulating.
  const v2 = renderBoardWith(src, stateWith(ask))
  click(option(v2.root, 'Postgres'))
  click(option(v2.root, 'SQLite'))
  click(option(v2.root, 'Auth'))
  click(buttonSaying(v2.root, 'Send answer'))
  const p2 = v2.posted.filter((m) => m.type === 'permission').pop()
  ok(p2.selections['Which database should we use?'].join() === 'SQLite', 'a second single-select choice replaces the first')
}

// --- free text ---------------------------------------------------------------
{
  const v = renderBoardWith(src, stateWith(ask))
  const other = byClass(v.root, 'ask-other')[0]
  ok(other.getAttribute('data-focus') != null, 'the free-text box is keyed so focus survives a repaint')
  other.oninput({ target: { value: 'DuckDB, actually' } })
  click(option(v.root, 'Auth'))
  click(buttonSaying(v.root, 'Send answer'))
  const posted = v.posted.filter((m) => m.type === 'permission').pop()
  ok(
    posted.selections['Which database should we use?'].join() === 'DuckDB, actually',
    'an answer the agent never offered is sent verbatim',
  )
}

// --- free text is stored RAW, not trimmed on the way in ----------------------
// A repaint rebuilds the box from state, and any other running agent causes
// one. Trimming on write meant a trailing space vanished mid-word: type
// "hello " then "world" and the answer came out "helloworld".
{
  const v = renderBoardWith(src, stateWith(ask))
  const other = byClass(v.root, 'ask-other')[0]
  other.oninput({ target: { value: 'hello ' } })
  v.deliver(stateWith(ask))                       // a frame from another agent
  const again = byClass(v.root, 'ask-other')[0]
  ok(again.value === 'hello ', 'the trailing space survives a repaint')
  again.oninput({ target: { value: 'hello world' } })
  click(option(v.root, 'Auth'))
  click(buttonSaying(v.root, 'Send answer'))
  const posted = v.posted.filter((m) => m.type === 'permission').pop()
  ok(
    posted.selections['Which database should we use?'].join() === 'hello world',
    'and the answer is trimmed only on the way out',
  )
}

// --- free text that repeats a ticked option is not sent twice ----------------
{
  const v = renderBoardWith(src, stateWith(ask))
  click(option(v.root, 'Auth'))
  byClass(v.root, 'ask-other')[1].oninput({ target: { value: 'Auth' } })
  click(option(v.root, 'Postgres'))
  click(buttonSaying(v.root, 'Send answer'))
  const posted = v.posted.filter((m) => m.type === 'permission').pop()
  ok(
    posted.selections['Which features go in v1?'].join(', ') === 'Auth',
    'typing an option that is already ticked does not duplicate it',
  )
}

// --- typing into a single-select clears the ticked option --------------------
{
  const v = renderBoardWith(src, stateWith(ask))
  click(option(v.root, 'Postgres'))
  byClass(v.root, 'ask-other')[0].oninput({ target: { value: 'DuckDB' } })
  const pg = option(v.root, 'Postgres')
  ok(!String(pg.className).includes('on'), 'the ticked option is visibly cleared when you type instead')
  click(option(v.root, 'Auth'))
  click(buttonSaying(v.root, 'Send answer'))
  const posted = v.posted.filter((m) => m.type === 'permission').pop()
  ok(
    posted.selections['Which database should we use?'].join() === 'DuckDB',
    'and only the typed answer is sent',
  )
}

// --- skipping ----------------------------------------------------------------
{
  const v = renderBoardWith(src, stateWith(ask))
  click(buttonSaying(v.root, 'Skip'))
  const posted = v.posted.filter((m) => m.type === 'permission').pop()
  ok(posted.allow === false, 'Skip denies rather than sending a made-up answer')
  ok(posted.selections === undefined, 'and sends no selections')
}

// --- junk from the host degrades, never throws -------------------------------
// The host only sets `questions` when it parsed some, but the view must not
// depend on that: a blank panel is the worst possible failure here.
for (const [label, q] of [['missing', undefined], ['empty', []]]) {
  const v = renderBoardWith(src, stateWith({ id: 'p9', summary: 'AskUserQuestion', questions: q }))
  ok(/wants to run/.test(v.text()), `${label} questions fall back to Allow/Deny instead of an empty picker`)
}

console.log(fails === 0 ? 'PASS — questions render, choices survive repaints, and selections are posted' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
