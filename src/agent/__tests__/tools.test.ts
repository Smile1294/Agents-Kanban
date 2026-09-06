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
ok(names.length === 6, `six board tools are auto-allowed (${names.join(', ')})`)
ok(names.includes(boardToolName('set_phase')), 'set_phase is among them — moving a card is the whole point')
ok(names.includes(boardToolName('notify_user')), 'and notify_user, for when the agent is stuck mid-run')
ok(names.includes(boardToolName('set_title')),
   'and set_title — a card named from the first line of a request needs no permission to be corrected')
ok(names.includes(boardToolName('schedule_list')),
   'and schedule_list — reading the triggers costs nothing, so it never stops for a click')

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

// `reason` reaches the handler. Its schema promises "Shown when they approve the
// split", and the handler called `ctx.onSplit(args.subtasks ?? [])` — so the one
// sentence explaining why a card became four billed agents reached nothing at
// all, and the approval prompt rendered the bare string `split_task`.
{
  const seen: { subtasks: unknown[]; reason: string }[] = []
  const [splitTool] = buildBoardTools(DEFAULT_BOARD, ctxFor({
    onSplit: async (subtasks, reason) => {
      seen.push({ subtasks, reason })
      return { ok: true, started: [{ key: 'k', title: 't', branch: 'b' }] }
    },
  }), tool).filter((x) => x.name === 'split_task')
  const two = [
    { title: 'Add SSO', prompt: 'Add SSO.' },
    { title: 'Fix the test', prompt: 'Fix it.' },
  ]
  await (splitTool as unknown as { handler: (a: unknown, e: unknown) => Promise<unknown> })
    .handler({ reason: 'Two unrelated jobs.', subtasks: two }, {})
  ok(seen.length === 1, `split_task reaches the host once (${seen.length})`)
  ok(seen[0]?.reason === 'Two unrelated jobs.',
     `and carries the agent's own reason, rather than dropping it (${JSON.stringify(seen[0]?.reason)})`)
  ok(seen[0]?.subtasks.length === 2, 'alongside the subtasks themselves')
}

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

// --- the spawn allowlist reaches the DESCRIPTION, not just the gate -----------
//
// The gate in `AgentManager.split()` is the fence; the description is what the
// agent reads before it ever calls. An agent can only ask for a model it has
// been told exists, so the allowed set must be named here — and an empty set
// must say the tool will be refused, rather than inviting a doomed call.
{
  const splitWith = (spawnModels: string[] | undefined) => {
    const [t] = buildBoardTools(DEFAULT_BOARD, ctxFor({ spawnModels }), tool)
      .filter((x) => x.name === 'split_task')
    return t as unknown as {
      description?: string | string[]
      inputSchema?: { subtasks?: { element?: { shape?: Record<string, unknown> } } }
    }
  }
  const textOf = (t: { description?: string | string[] }) =>
    Array.isArray(t.description) ? t.description.join('\n') : String(t.description ?? '')

  const withList = splitWith(['haiku-5', 'deepseek-chat'])
  ok(textOf(withList).includes('one of: haiku-5, deepseek-chat'),
     'the split_task description names the models a spawned agent may run on')
  ok(withList.inputSchema?.subtasks?.element?.shape?.model !== undefined,
     'and the schema offers the `model` field to ask for one')

  const plain = splitWith(undefined)
  ok(!textOf(plain).includes('may name a `model`'), 'with no allowlist the description says nothing about models')
  ok(plain.inputSchema?.subtasks?.element?.shape?.model === undefined,
     'and the schema has no model field — a control with no gate behind it cannot be offered')

  const empty = splitWith([])
  ok(textOf(empty).includes('will be refused'),
     'an empty allowlist says the tool will be refused rather than inviting a doomed call')
  ok(empty.inputSchema?.subtasks?.element?.shape?.model === undefined,
     'and offers no model field, because there is nothing to offer')
}

// --- the scheduled-run tools --------------------------------------------------
//
// A schedule fires a session with a bill, so the boundary is the same one
// `split_task` has: the description is policy, `parseScheduleDraft` in the
// handler is the fence, and the tools that create, delete or fire are in
// ASKS_FIRST (checked by the drift guard above). What this block adds is the
// behaviour behind the names: junk never reaches the host callback, and the
// list marks whose each schedule is.
import type { Schedule } from '../../board/schedules.ts'
{
  const created: { drafts: unknown[]; by: string[] } = { drafts: [], by: [] }
  const schedCtx = ctxFor({
    onScheduleList: async () => [
      {
        id: 'a1', title: 'Bug patrol', prompt: 'Fix them.', hour: 9, minute: 0,
        days: [1, 2, 3, 4, 5], enabled: true, createdAt: 1,
        createdBy: 'Pricing, spawn policy and schedules',
      },
      {
        id: 'a2', title: 'Build check', prompt: 'Run the build.', hour: 14, minute: 30,
        days: [0], enabled: false, createdAt: 1,
        createdBy: 'Some other card',
      },
      {
        id: 'a3', title: 'Deploy watch', prompt: 'Watch the deploy.', hour: 8, minute: 0,
        days: [6], enabled: true, createdAt: 1,
        lastRun: { at: 2, ok: false, note: 'no provider' },
      },
    ] as Schedule[],
    onScheduleCreate: async (draft, by) => {
      created.drafts.push(draft)
      created.by.push(by)
      return { ok: true, id: 'new-1' }
    },
    sessionTitle: () => 'Pricing, spawn policy and schedules',
  })
  const all = buildBoardTools(DEFAULT_BOARD, schedCtx, tool)
  const by = (name: string) => all.find((t) => t.name === name) as unknown as {
    handler: (a: unknown, e: unknown) => Promise<unknown>
  }

  const createTool = by('schedule_create')
  const createdRes = await createTool.handler({
    title: ' Nightly sweep ', prompt: 'Sweep the board.', hour: 3, minute: 15,
    days: [1, 1, 5], enabled: false,
  }, {})
  ok(created.drafts.length === 1, 'schedule_create reaches the host callback once')
  ok(created.drafts[0] !== null && typeof created.drafts[0] === 'object'
    && (created.drafts[0] as { title?: string }).title === 'Nightly sweep',
    'with the title trimmed — the host stamps the id, not the agent')
  ok(created.by[0] === 'Pricing, spawn policy and schedules',
    'and the creator stamp is this session\'s card title, from sessionTitle')
  ok(String((createdRes as { content?: { text?: string }[] }).content?.[0]?.text ?? '')
    .includes('new-1'),
    'and the result carries the id the next tools key on')
  const paused = created.drafts[0] as { enabled?: boolean }
  ok(paused.enabled === false, 'an explicit enabled:false is kept, not defaulted away')

  const before = created.drafts.length
  const junkRes = await createTool.handler({
    title: 'Bad time', prompt: 'x', hour: 42, minute: 0, days: [1],
  }, {})
  ok(created.drafts.length === before, 'a junk draft never reaches the host callback')
  ok(String((junkRes as { content?: { text?: string }[] }).content?.[0]?.text ?? '').includes('hour'),
    'and the refusal names the field so the agent can fix it')

  const listRes = await by('schedule_list').handler({}, {})
  const listText = String((listRes as { content?: { text?: string }[] }).content?.[0]?.text ?? '')
  ok(listText.includes('Bug patrol') && listText.includes('Mon–Fri at 09:00'),
    'schedule_list shows each schedule with its one-line when')
  ok(listText.includes('you created this'), 'a schedule whose creator is THIS session says "you created this"')
  ok(listText.includes('created by "Some other card"'), 'another agent\'s schedule names its creator card')
  ok(listText.includes('user-created'), 'a schedule with no stamp reads as the user\'s')
  ok(listText.includes('paused') && listText.includes('last run did not start: no provider'),
    'and the flags say paused and the failed last run — the signals that cannot say bad are absent')

  const delCtx = ctxFor({
    onScheduleDelete: async (id) => (id === 'a1' ? { ok: true } : { ok: false, message: 'No schedule with id "x".' }),
    onScheduleRun: async () => ({ ok: false, message: 'No git repo open.' }),
  })
  const delTool = buildBoardTools(DEFAULT_BOARD, delCtx, tool).find((t) => t.name === 'schedule_delete') as unknown as {
    handler: (a: unknown, e: unknown) => Promise<unknown>
  }
  const delRes = await delTool.handler({ id: 'a1' }, {})
  ok(String((delRes as { content?: { text?: string }[] }).content?.[0]?.text ?? '').includes('deleted'),
    'schedule_delete reports the deletion')
  const delMiss = await delTool.handler({ id: 'x' }, {})
  ok(String((delMiss as { content?: { text?: string }[] }).content?.[0]?.text ?? '').includes('No schedule'),
    'and relays the host\'s refusal rather than inventing success')
  const runTool = buildBoardTools(DEFAULT_BOARD, delCtx, tool).find((t) => t.name === 'schedule_run') as unknown as {
    handler: (a: unknown, e: unknown) => Promise<unknown>
  }
  const runRes = await runTool.handler({ id: 'a1' }, {})
  ok(String((runRes as { content?: { text?: string }[] }).content?.[0]?.text ?? '').includes('No git repo open'),
    'schedule_run relays the host\'s reason when the run could not start')

  const bare = ctxFor({})
  const bareCreate = buildBoardTools(DEFAULT_BOARD, bare, tool).find((t) => t.name === 'schedule_create') as unknown as {
    handler: (a: unknown, e: unknown) => Promise<unknown>
  }
  const bareRes = await bareCreate.handler({ title: 'x', prompt: 'y', hour: 1, minute: 2, days: [1] }, {})
  ok(String((bareRes as { content?: { text?: string }[] }).content?.[0]?.text ?? '').includes('not available'),
    'with no host behind them the tools say unavailable, never invent a store')
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

// `set_phase`'s `note` reaches the board. Its own description promises "shown
// on the board" and the handler dropped it, so the model was invited to explain
// every move and wrote into nothing.
{
  let phase = 'implementing'
  const changes: unknown[] = []
  const ctxNote = ctxFor({
    store: {
      get: async () => ({ phase, tags: [] }),
      card: async () => ({ phase, tags: [] }),
      childrenOf: async () => [],
      setPhase: async (_id: string, p: string) => { phase = p },
      setTags: async () => {}, setTestPlan: async () => {}, clearTestPlan: async () => {},
      list: async () => [],
    } as never,
    onChanged: (c) => { changes.push(c) },
  })
  const sp = byName(buildBoardTools(DEFAULT_BOARD, ctxNote, tool), 'set_phase')
  await (sp as unknown as { handler: (a: unknown, e: unknown) => Promise<unknown> })
    .handler({ phase: 'planning', note: 'Backing out: the migration needs a decision first.' }, {})
  const c = changes[0] as { note?: string } | undefined
  ok(c?.note === 'Backing out: the migration needs a decision first.',
     `the note travels with the move (${JSON.stringify(c?.note)})`)

  // Bounded HOST-side: a length asked for in a description is not a limit.
  changes.length = 0
  phase = 'implementing'
  await (sp as unknown as { handler: (a: unknown, e: unknown) => Promise<unknown> })
    .handler({ phase: 'planning', note: 'x'.repeat(5000) }, {})
  const long = changes[0] as { note?: string } | undefined
  ok((long?.note?.length ?? 0) <= 200,
     `and is bounded where it can be enforced, not where it is described (${long?.note?.length})`)
}

// Leaving a review column retracts the plan that got it there.
{
  let phase = 'validating'
  let cleared = 0
  const plan = { summary: 'run it', steps: ['npm test'], links: [], at: 1 }
  const ctxPlan = ctxFor({
    store: {
      get: async () => ({ phase, tags: [] }),
      card: async () => ({ phase, tags: [], testPlan: plan }),
      childrenOf: async () => [],
      setPhase: async (_id: string, p: string) => { phase = p },
      setTags: async () => {}, setTestPlan: async () => {},
      clearTestPlan: async () => { cleared++ },
      list: async () => [],
    } as never,
  })
  const sp = byName(buildBoardTools(DEFAULT_BOARD, ctxPlan, tool), 'set_phase')
  const call = (a: unknown) =>
    (sp as unknown as { handler: (x: unknown, e: unknown) => Promise<unknown> }).handler(a, {})

  await call({ phase: 'implementing' })
  ok(cleared === 1, `moving OUT of review retracts the stale test plan (${cleared})`)

  // And it must not fire on a move that keeps the card in review, or on a move
  // that carries a fresh plan.
  cleared = 0
  phase = 'implementing'
  await call({ phase: 'planning' })
  ok(cleared === 0, 'a move between non-review columns clears nothing')
  phase = 'validating'
  await call({ phase: 'implementing', howToTest: { summary: 's', steps: ['x'] } })
  ok(cleared === 0, 'and a move that supplies a NEW plan keeps it rather than clearing it')
}

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
  const titleCtx: BoardToolContext = { ...ctx, onRename: (t) => { renames.push(t); return { renamed: true } } }
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
      onRename: () => ({ renamed: true }),
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
