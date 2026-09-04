/* The board tools, and the permission gate that decides whether an agent can
   actually reach them.

   This file exists because of a shipped bug: the auto-allow list was written out
   by hand, the tools were later renamed, and nobody noticed. Every `set_phase`
   call then stopped for a permission prompt — so the headline feature, an agent
   moving its own card, silently required a click. Nothing failed; it just never
   happened on its own. Found by the first real agent run, not by any unit test. */
import { loadSdk } from '../sdk.ts'
import { DEFAULT_BOARD, type BoardConfig } from '../../board/config.ts'
import { ASKS_FIRST, boardToolName, boardToolNames, buildBoardTools, type BoardToolContext } from '../tools.ts'
import { guessLinkKind, normaliseTestPlan } from '../../sessions/meta.ts'
import { AUTO_ALLOWED_FOR_TEST } from '../session.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const { tool } = await loadSdk()

/** A context that answers everything with a default. The drift guard only needs
 *  the tools to EXIST; the behavioural tests below build a real one. */
const ctxFor = (over: Partial<BoardToolContext> = {}): BoardToolContext => ({
  store: {
    get: async () => ({ phase: 'planning', tags: [] }),
    card: async () => ({ phase: 'planning', tags: [] }),
    childrenOf: async () => [],
    setPhase: async () => {}, setTags: async () => {}, setTestPlan: async () => {},
    list: async () => [],
  } as never,
  key: () => 'sess-1',
  onChanged: () => {},
  ...over,
})

// --- the drift guard ---------------------------------------------------------
// Every board tool the agent is handed must also be one it may call without
// stopping. This is the assertion that would have caught the shipped bug.
const names = boardToolNames(DEFAULT_BOARD, tool)
ok(names.length === 5, `five board tools are auto-allowed (${names.join(', ')})`)
ok(names.includes(boardToolName('set_phase')), 'set_phase is among them — moving a card is the whole point')
ok(names.includes(boardToolName('notify_user')), 'and notify_user, for when the agent is stuck mid-run')
ok(names.includes(boardToolName('set_title')),
   'and set_title — a card named from the first line of a request needs no permission to be corrected')

// `split_task` starts other agents, so it is the one board tool the user is
// asked about. The exclusion is by NAME, which is the same shape as the bug at
// the top of this file — so it is checked against the real definitions rather
// than trusted.
const allTools = buildBoardTools(DEFAULT_BOARD, ctxFor(), tool)
for (const n of ASKS_FIRST) {
  ok(allTools.some((t) => t.name === n), `"${n}" asks first, and is a real tool — not a stale name`)
  ok(!names.includes(boardToolName(n)), `"${n}" is therefore NOT in the auto-allow list`)
}
ok(allTools.length === names.length + ASKS_FIRST.size, 'every board tool is either auto-allowed or asks first')

for (const n of names) {
  ok(n.startsWith('mcp__board__'), `${n} is namespaced the way the model sees it`)
  // The built-in set must NOT contain them: they are passed per session, from
  // the definitions, so that a rename cannot silently un-allow them.
  ok(!AUTO_ALLOWED_FOR_TEST(n), `${n} is auto-allowed from its definition, not from a hand-written list`)
}
for (const n of ['Read', 'Grep', 'Glob']) {
  ok(AUTO_ALLOWED_FOR_TEST(n), `${n} is auto-allowed as a read-only built-in`)
}
for (const n of ['Bash', 'Edit', 'Write']) {
  ok(!AUTO_ALLOWED_FOR_TEST(n), `${n} still goes through the user`)
}

// --- the approval boundary, enforced at the tool boundary --------------------
let phase = 'planning'
const writes: string[] = []
let savedPlan: unknown
const ctx: BoardToolContext = {
  store: {
    get: async () => ({ phase, tags: [] }),
    card: async () => ({ phase, tags: [] }),
    setPhase: async (_id: string, p: string) => { phase = p; writes.push(p) },
    setTags: async () => {},
    setTestPlan: async (_id: string, p: unknown) => { savedPlan = p },
    list: async () => [],
  } as never,
  key: () => 'sess-1',
  onChanged: () => {},
}
/** By NAME, never by position: this file adds tools, and a positional
 *  destructure silently hands the tests the wrong one when it does. */
const byName = (list: ReturnType<typeof buildBoardTools>, name: string) => list.find((t) => t.name === name)
const built = buildBoardTools(DEFAULT_BOARD, ctx, tool)
const setPhase = byName(built, 'set_phase')
const setTags = byName(built, 'set_tags')
const notifyUser = byName(built, 'notify_user')
const run = async (t: NonNullable<typeof setPhase>, args: unknown) =>
  (await t.handler(args as never, {})) as { content: { text: string }[]; isError?: boolean }

// The one rule that must never be relaxed: an agent cannot approve its own work.
const blocked = await run(setPhase!, { phase: 'complete' })
ok(blocked.isError === true, 'set_phase("complete") is refused')
ok(phase === 'planning' && writes.length === 0, 'and the refusal happens BEFORE any write')
ok(/approval/i.test(blocked.content[0]!.text), 'the refusal explains that it is the user\'s step')

const moved = await run(setPhase!, { phase: 'implementing' })
ok(!moved.isError && phase === 'implementing', 'a normal move is written through')
await run(setPhase!, { phase: 'implementing' })
ok(writes.length === 1, 'moving to the phase it is already in does not write again')
ok((await run(setPhase!, { phase: 'not-a-column' })).isError === true, 'an unknown column is refused, not stored')

// A run that has no Claude Code session id yet — its first moment, or one whose
// id was refused as a duplicate — must STILL be able to move its own card. It is
// keyed by its run id until the real id arrives and the entry is carried across.
// This previously answered "not on the board yet" and the agent gave up.
let runPhase = 'planning'
const byRunId = buildBoardTools(
  DEFAULT_BOARD,
  {
    ...ctx,
    key: () => 'run-7-abc',
    store: {
      get: async () => undefined,
      card: async () => ({ phase: runPhase, tags: [] }),
      setPhase: async (_id: string, p: string) => { runPhase = p },
      setTags: async () => {},
      setTestPlan: async () => {},
      list: async () => [],
    } as never,
  },
  tool,
)
const moved2 = await run(byName(byRunId, 'set_phase')!, { phase: 'implementing' })
ok(!moved2.isError && runPhase === 'implementing', 'a run with no session id yet can still move its own card')

// A board with no human-only column must not invent one.
const open: BoardConfig = {
  statusField: 'status',
  columns: [{ id: 'a', name: 'A', category: 'started' }, { id: 'b', name: 'B', category: 'done' }],
}
const [openPhase] = buildBoardTools(open, ctx, tool)
ok(!(await run(openPhase!, { phase: 'b' })).isError, 'a board without an approval column lets the agent finish')

// --- renaming its own card ---------------------------------------------------
// The card is named from the first line of the request, and a request that
// opens "Okay." named this repository's own session **Okay.** for its whole
// life. The agent is the only party that knows what the work turned out to be,
// so it gets to say — and it must not need permission to fix a name.
{
  const renames: string[] = []
  const titleCtx: BoardToolContext = { ...ctx, onRename: (t) => { renames.push(t) } }
  const setTitle = byName(buildBoardTools(DEFAULT_BOARD, titleCtx, tool), 'set_title')
  ok(!!setTitle, 'set_title exists')

  const done = await run(setTitle!, { title: 'Add SSO to the admin app' })
  ok(!done.isError && renames[0] === 'Add SSO to the admin app', 'a title is written through')

  await run(setTitle!, { title: '  "Fix the flaky snapshot test."  ' })
  ok(renames[1] === 'Fix the flaky snapshot test',
     `quotes and a trailing full stop are stripped, because models add both (${renames[1]})`)

  const before = renames.length
  const empty = await run(setTitle!, { title: '   ' })
  ok(empty.isError === true, 'an empty title is refused')
  ok(renames.length === before, 'and refused BEFORE anything is written')

  await run(setTitle!, { title: 'w '.repeat(60) })
  ok(renames[renames.length - 1]!.length <= 72 && renames[renames.length - 1]!.endsWith('…'),
     `an over-long title is bounded the same way a derived one is (${renames[renames.length - 1]!.length} chars)`)

  // The ask rides on the move into the started column, because that is the one
  // a real agent actually reads. A brief paragraph asking for the same thing was
  // ignored by a real run that moved its card TWICE without renaming it.
  {
    let p = 'planning'
    const nudged: BoardToolContext = {
      ...ctx,
      store: {
        get: async () => ({ phase: p, tags: [] }),
        card: async () => ({ phase: p, tags: [] }),
        setPhase: async (_id: string, next: string) => { p = next },
        setTags: async () => {}, setTestPlan: async () => {}, list: async () => [],
      } as never,
      onRename: () => {},
      derivedTitle: () => 'Okay.',
    }
    const phaseTool = byName(buildBoardTools(DEFAULT_BOARD, nudged, tool), 'set_phase')
    const moved = await run(phaseTool!, { phase: 'implementing' })
    ok(/set_title/.test(moved.content[0]!.text),
       'moving into the started column asks the agent to name the card')
    ok(/"Okay\."/.test(moved.content[0]!.text), 'and quotes the guess, so the agent can judge it')

    // Once a title has been chosen, the ask must stop — nagging about a name
    // somebody picked on purpose is worse than not asking.
    p = 'planning'
    const chosen = byName(
      buildBoardTools(DEFAULT_BOARD, { ...nudged, derivedTitle: () => undefined }, tool),
      'set_phase',
    )
    const again = await run(chosen!, { phase: 'implementing' })
    ok(!/set_title/.test(again.content[0]!.text), 'and does not ask again once the agent has named it')

    // A review column is not the moment: the work is over, and the move already
    // has to carry a whole test plan.
    p = 'planning'
    const review = await run(phaseTool!, {
      phase: 'validating',
      howToTest: { summary: 's', steps: ['one'] },
    })
    ok(!/set_title/.test(review.content[0]!.text), 'the ask is on the started column only')
  }

  // No manager behind it — the tool must say so rather than report a rename
  // that never happened.
  const orphan = byName(buildBoardTools(DEFAULT_BOARD, ctx, tool), 'set_title')
  ok((await run(orphan!, { title: 'Anything' })).isError === true,
     'with nothing wired to rename it, the tool fails loudly')
}

// --- reaching a review column requires saying how to test ---------------------
// A card that says "ready" and nothing else hands the user a puzzle: which
// files, run what, look where. The description asks for a plan; this makes it
// so, because prose alone is not a boundary.
phase = 'implementing'
const bare = await run(setPhase!, { phase: 'validating' })
ok(bare.isError === true, 'moving to review with NO test plan is refused')
ok(phase === 'implementing', 'and the card does not move')
ok(/howToTest/.test(bare.content[0]!.text), 'the refusal names the field to supply')
ok(/summary/.test(bare.content[0]!.text) && /steps/.test(bare.content[0]!.text), 'and what to put in it')

const withPlan = await run(setPhase!, {
  phase: 'validating',
  howToTest: {
    summary: 'Adds subtract() to calc.js',
    steps: ['Run npm test', 'Check calc.js exports subtract'],
    links: [
      { label: 'calc.js', target: 'calc.js', kind: 'file' },
      { label: 'Run the tests', target: 'npm test', kind: 'command' },
    ],
  },
})
ok(!withPlan.isError && phase === 'validating', 'with a plan, the move goes through')
ok((savedPlan as { steps: string[] }).steps.length === 2, 'the plan is stored')
ok((savedPlan as { links: unknown[] }).links.length === 2, 'with its links')

// Non-review columns must NOT demand one, or the agent cannot even start.
phase = 'planning'
ok(!(await run(setPhase!, { phase: 'implementing' })).isError, 'moving to a non-review column needs no plan')

// --- link kinds --------------------------------------------------------------
ok(guessLinkKind('https://localhost:3000') === 'url', 'an http target is a url')
ok(guessLinkKind('src/calc.js') === 'file', 'a bare path is a file')
ok(guessLinkKind('npm test') === 'command', 'anything with an argument is a command')
ok(normaliseTestPlan({}) === undefined, 'an empty plan is no plan')
ok(normaliseTestPlan({ summary: 'x' })?.links.length === 0, 'a plan with no links still stands')
const messy = normaliseTestPlan({
  summary: '  spaced  ', steps: ['a', '', '  ', 'b'],
  links: [{ target: 'x.js' }, { label: 'bad', target: '' }, 'nonsense'],
})
ok(messy?.steps.length === 2, 'blank steps are dropped')
ok(messy?.links.length === 1 && messy.links[0]!.kind === 'file', 'a link with no kind is classified, and a targetless one dropped')
ok(messy?.links[0]!.label === 'x.js', 'a link with no label falls back to its target')

// --- notify_user: the agent asking for attention mid-run ---------------------
// Distinct from a phase move. A phase move says "I am finished"; this says "I am
// stuck and cannot continue without you", and it has to reach someone who is not
// looking at the board.
const notices: unknown[] = []
const notifier = byName(
  buildBoardTools(DEFAULT_BOARD, { ...ctx, onNotice: (n) => notices.push(n) }, tool),
  'notify_user',
)
const sent = await run(notifier!, { message: 'Which auth provider?', urgency: 'blocked' })
ok(!sent.isError, 'notify_user succeeds')
ok(notices.length === 1, 'and raises exactly one notice')
ok((notices[0] as { urgency: string }).urgency === 'blocked', 'carrying its urgency')
ok((notices[0] as { key: string }).key === 'sess-1', 'and the key of the session that sent it')
const defaulted = await run(notifier!, { message: 'FYI the schema changed' })
ok(!defaulted.isError && (notices[1] as { urgency: string }).urgency === 'info', 'urgency defaults to info')
ok((await run(notifier!, { message: '   ' })).isError === true, 'an empty notification is refused')
const nd = notifyUser!.description
ok(/stuck/i.test(nd), 'the description says when to use it')
ok(/do not use it to report progress/i.test(nd) || /Do NOT use it/i.test(nd), 'and when not to')

// --- the description carries the policy --------------------------------------
// Nimbalyst's finding: models read tool descriptions far more reliably than a
// distant system prompt. Description AND code guard, always both.
const d = setPhase!.description
ok(d.includes('complete'), 'the description names the column the agent may not set')
for (const c of DEFAULT_BOARD.columns) ok(d.includes(c.id), `the description lists "${c.id}"`)
ok(setTags!.description.length > 40, 'set_tags explains what tags are for')
ok(d.includes('howToTest'), 'the description tells the agent a test plan is required')
ok(d.includes('file') && d.includes('command') && d.includes('url'), 'and what the link kinds do')

console.log(fails === 0 ? 'PASS — board tools are reachable, and the approval boundary holds' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
