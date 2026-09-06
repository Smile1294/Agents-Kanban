/* Runs media/board.js against a minimal DOM to prove it renders.
   The webview is the one place with no type checking and no test coverage,
   so a runtime throw there shows up as a silently blank panel.

   The DOM stub and the vm harness live in test/dom.mjs, shared with smoke.mjs's
   view-contract gate. Keeping two copies meant any DOM API board.js started
   using had to be added twice, and missing one made a gate pass that should
   have failed. */
import { boardSource, findByTag, renderBoardWith, walk as walkAll } from '../../../test/dom.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

/** Depth-first search for a button by its label, so tests can assert on state
 *  the rendered text cannot show — `disabled`, most importantly. */
function findButton(node, label) {
  if (node.tagName === 'button' && node.textContent.includes(label)) return node
  for (const c of node.children ?? []) {
    const hit = findButton(c, label)
    if (hit) return hit
  }
  return null
}

const src = await boardSource()
// One layout. The side bar view is gone — an activity-bar icon always opens the
// board in a 300px column, which five columns never fitted in.
const run = (state) => renderBoardWith(src, state)

const COMPOSER = {
  model: 'claude-opus-5', effort: 'high', thinking: 'enabled',
  models: [{ id: 'claude-opus-5', label: 'Opus 5', context: '200K' }],
  efforts: [{ key: 'low', label: 'Low' }, { key: 'high', label: 'High' }],
  contextTokens: 82000, contextWindow: 1000000,
  meter: { kind: 'usd', spentUsd: 1.234, priced: true },
  permissionMode: 'acceptEdits',
  permissionModes: [
    { key: 'default', label: 'Ask', detail: 'Prompt before anything that writes' },
    { key: 'acceptEdits', label: 'Auto-accept edits', detail: 'File edits go through' },
  ],
}
const COLUMNS = [
  { id: 'planning', name: 'Planning', category: 'unstarted' },
  { id: 'implementing', name: 'Implementing', category: 'started' },
  { id: 'complete', name: 'Complete', category: 'done', humanOnly: true },
]
const CARD = {
  key: 'abc-123', sessionId: 'abc-123', title: 'Fix login', phase: 'implementing',
  tags: ['auth', 'ui'], updated: Date.now(), branch: 'task/S1-fix',
  agent: { kind: 'working', tool: 'Bash', contextTokens: 82000, contextWindow: 1000000 },
}
const base = { ready: true, mode: 'kanban', columns: COLUMNS, cards: [CARD], composer: COMPOSER, running: 1, waiting: 0 }

// 1. Loading the script must not throw, and must announce readiness.
const boot = run(null)
ok(boot.posted.some((m) => m.type === 'ready'), 'script posts ready on load')
ok(boot.root.children.length > 0, 'renders on load, without waiting for a state message')

// 2. Non-ready states explain themselves rather than sitting blank.
const nows = run({ ...base, ready: false, noWorkspace: true, cards: [] })
ok(nows.text().includes('No folder open'), 'no-workspace state explains itself')
const norepo = run({ ...base, ready: false, noRepo: true, cards: [] })
ok(norepo.text().includes('not a git repository'), 'non-repo folder warns that agents cannot run')

// 3. Kanban renders columns, cards and tags — in the EDITOR panel. The sidebar
// is a session rail, because five columns at 300px cannot be read and beside
// the real board it was the same thing drawn twice.
const k = run(base)
ok(k.text().includes('Planning') && k.text().includes('Complete'), 'kanban renders columns')
ok(k.text().includes('Fix login'), 'kanban renders the session card')
ok(k.text().includes('#auth') && k.text().includes('#ui'), 'card shows MULTIPLE tags')

ok(k.text().includes('Agent Sessions'), 'with the session rail beside them')

// 4. Chat renders every transcript entry kind, including thinking.
const chat = run({
  ...base, mode: 'chat', selectedKey: 'abc-123',
  transcript: [
    { kind: 'prompt', at: Date.now(), text: 'do the thing' },
    { kind: 'thinking', at: Date.now(), text: 'considering options' },
    { kind: 'text', at: Date.now(), text: 'working on it' },
    { kind: 'tool', at: Date.now(), id: '1', name: 'Bash', summary: 'git status', status: 'ok' },
    { kind: 'phase', at: Date.now(), from: 'planning', to: 'implementing' },
    { kind: 'result', at: Date.now(), summary: 'done', durationMs: 36800, costUsd: 0.42 },
  ],
})
const ct = chat.text()
ok(ct.includes('do the thing'), 'chat renders the prompt')
ok(ct.includes('Thought for a moment'), 'thinking is a collapsed disclosure, not inline noise')
ok(ct.includes('git status'), 'chat renders tool rows')
ok(ct.includes('Session Meta') && ct.includes('Planning') && ct.includes('Implementing'), 'chat renders the phase transition')
ok(ct.includes('37s'), 'chat renders the result duration')

// 5. The composer carries the controls that were missing entirely.
ok(ct.includes('Opus 5'), 'composer shows the model picker')
ok(ct.includes('High'), 'composer shows the effort picker')
ok(ct.includes('Extended: On'), 'composer shows the thinking toggle')
ok(ct.includes('82k/1M (8%)'), `composer shows context usage: ${/\d+k\/\d+\w? \(\d+%\)/.exec(ct)?.[0]}`)

// 5a. Context fill and spend, and they DO NOT depend on a live agent.
//
// Reported after a VS Code restart: "suddenly I don't see how much of the
// context I have used". Both numbers used to be set only from the running
// agent, so a session whose process was gone showed neither — and there is no
// state in which a session that has run has no context fill and no cost.
ok(ct.includes('$1.23'), 'composer shows what the session has spent')

const stored = run({
  ...base, mode: 'chat', selectedKey: 'abc-123',
  // No `agent` on the card: nothing is running, exactly as after a restart.
  cards: [{ ...CARD, agent: undefined }],
  transcript: [{ kind: 'text', at: Date.now(), text: 'from disk' }],
  composer: { ...COMPOSER, contextTokens: 223294, contextWindow: 1000000, meter: { kind: 'usd', spentUsd: 8.11, priced: true } },
})
const stx = stored.text()
ok(stx.includes('223k/1M (22%)'), `context survives with no live agent: ${/\d+k\/\d+\w? \(\d+%\)/.exec(stx)?.[0]}`)
ok(stx.includes('$8.11'), `and so does the spend: ${/\$[\d.]+/.exec(stx)?.[0]}`)

// A total that is knowingly incomplete says so rather than reading as exact.
const partial = run({
  ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
  composer: { ...COMPOSER, meter: { kind: 'usd', spentUsd: 0.5, priced: false } },
})
ok(partial.text().includes('≥ $0.50'), 'an incomplete total is shown as a floor, not as the answer')

// Fractions of a cent must not round away to $0.00 — that is the one thing the
// readout exists to disprove.
const cheap = run({
  ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
  composer: { ...COMPOSER, meter: { kind: 'usd', spentUsd: 0.004, priced: true } },
})
ok(cheap.text().includes('$0.004'), 'a fraction of a cent is shown, not rounded to zero')

// Tokens with no known window still show the count. It is the number the
// percentage would have come from, and beats an empty corner of the bar.
const noWindow = run({
  ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
  composer: { ...COMPOSER, contextTokens: 45000, contextWindow: undefined },
})
ok(noWindow.text().includes('45k'), 'context tokens show even when the window is unknown')

// A nonsense figure must never reach the bar. NaN and Infinity are both
// numbers, so a `typeof` check let "$NaN" through.
for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
  const t = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    composer: { ...COMPOSER, meter: { kind: 'usd', spentUsd: bad, priced: true } },
  }).text()
  ok(!/NaN|Infinity/.test(t), `a spend of ${bad} does not render as itself`)
}

// A session that has never run shows no spend claim at all, rather than $0.00.
const fresh = run({
  ...base, mode: 'chat', selectedKey: undefined, transcript: [],
  composer: { ...COMPOSER, contextTokens: 0, contextWindow: undefined, meter: undefined },
})
ok(!/\$[\d]/.test(fresh.text()), 'a session with nothing to report makes no claim')

// --- the split dial, on the composer bar ------------------------------------
{
  const LEVELS = [
    { key: 'minimal', label: 'Minimal', detail: 'Prefer one agent.' },
    { key: 'balanced', label: 'Balanced', detail: 'Split when independent.' },
    { key: 'maximum', label: 'Maximum', detail: 'Split readily.' },
  ]
  const withDial = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    composer: { ...COMPOSER, orchestration: 'maximum', orchestrationLevels: LEVELS },
  }).text()
  ok(withDial.includes('Maximum'), `the dial shows the level in force (${/Maximum|Balanced|Minimal/.exec(withDial)?.[0]})`)

  // HIDDEN, never greyed, where it cannot take effect. A workspace with no git
  // repository has no worktrees and therefore no `split_task` at all, so a dial
  // over it would be a control that cannot say no.
  const noDial = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    composer: { ...COMPOSER, orchestration: 'balanced' },
  }).text()
  // Asserted on the dial's own marker, not on the level names: a picker
  // rendered with no options would still pass a name check while being exactly
  // the inert control this hides.
  ok(withDial.includes('\u2442'), 'the dial is drawn with its own marker when it can take effect')
  ok(!noDial.includes('\u2442'),
     'and is absent entirely where splitting is impossible, rather than shown and inert')

  // A level this build does not serve must not silently read as the default.
  const unknown = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    composer: { ...COMPOSER, orchestration: 'aggressive', orchestrationLevels: LEVELS },
  }).text()
  ok(unknown.includes('aggressive') && !/⑂ Balanced/.test(unknown),
     'an unrecognised level shows itself rather than posing as Balanced')
}

// --- how the work was divided, or why it was not ----------------------------
//
// A refused split used to reach the model and nothing else, so a session that
// wanted four agents and was refused looked exactly like one that correctly
// decided it was a single job — the feature working and the feature broken
// rendering the same.
{
  const split = run({
    ...base,
    cards: [{ ...CARD, decomposition: { line: 'Split into 3 subtasks · Maximum', refused: false } }],
  }).text()
  ok(split.includes('Split into 3 subtasks'), 'a split says so on the card')

  const refused = run({
    ...base,
    cards: [{
      ...CARD,
      decomposition: {
        line: 'Kept as one agent — asked for 5, over the limit at Minimal',
        stated: 'These are two unrelated jobs.',
        refused: true,
      },
    }],
  })
  const rt = refused.text()
  ok(rt.includes('Kept as one agent'), 'and a REFUSAL is visible at all')
  ok(rt.includes('over the limit at Minimal'), 'saying which rule and which level')
  ok(rt.includes('These are two unrelated jobs.'), "and quoting the agent's own reason")
  ok(/[\u201C\u201D]/.test(rt), 'as a quotation, so it reads as a claim rather than a fact')

  // A card that never considered splitting says nothing at all — the ABSENCE of
  // a record is the answer, and inventing a line for it would be noise on every
  // card on the board.
  const silent = run({ ...base, cards: [{ ...CARD }] }).text()
  ok(!/Kept as one agent|Split into/.test(silent),
     'while a card that never split renders no line at all')
}

// A phase move carries the agent's reason, because `set_phase` asks for one.
//
// The `note` argument's own description promises "shown on the board", and the
// handler dropped it — so the model was invited to explain every move and spent
// tokens writing into nothing. A field accepted and never written is the mirror
// of one written and never read.
{
  const moved = run({
    ...base, mode: 'chat', selectedKey: 'abc-123',
    transcript: [{
      kind: 'phase', at: Date.now(), from: 'implementing', to: 'validating',
      note: 'Tests pass; the migration needs a look before it merges.',
    }],
  }).text()
  ok(moved.includes('Tests pass; the migration needs a look'),
     `the agent's reason for the move is on the board (${/Tests pass[^A-Z]*/.exec(moved)?.[0] ?? 'missing'})`)
  // And a move with no note must not render an empty line.
  const bare = run({
    ...base, mode: 'chat', selectedKey: 'abc-123',
    transcript: [{ kind: 'phase', at: Date.now(), from: 'implementing', to: 'validating' }],
  })
  ok(!walkAll(bare.root).some((n) => (n.className || '').includes('phase-note')),
     'and a move with nothing to say renders no note at all')
}

// The provider chip shows what the CLI SAID, not what we asked for.
//
// `resolvedProvider` and `providerLabel` are the backend the CLI reported the
// run is ACTUALLY on — a managed settings file, an `apiKeyHelper` or an env
// block in `~/.claude/settings.json` all outrank our request. The host has
// computed both onto every card since the feature was written and the view read
// neither, so the chip could only ever repeat our own configuration back, which
// is exactly the decorative readout the rule about this names.
{
  const composer = {
    ...COMPOSER, provider: 'my-gateway',
    providers: [{ id: 'my-gateway', label: 'My Gateway' }],
    runtimes: [{ id: 'claude', label: 'Claude Code', providerProfiles: true }],
    runtime: 'claude',
    agent: 'claude|my-gateway',
    agents: [{ key: 'claude|my-gateway', label: 'My Gateway', detail: 'Claude Code · llm.corp:4000', runtime: 'claude', provider: 'my-gateway' }],
  }
  const asked = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    cards: [{ ...CARD, agent: { kind: 'working', contextTokens: 0 } }],
    composer,
  }).text()
  ok(asked.includes('My Gateway'), 'with no answer yet, the chip names the profile that was requested')

  const answered = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    cards: [{
      ...CARD,
      agent: { kind: 'working', contextTokens: 0, resolvedProvider: 'bedrock', providerLabel: 'Amazon Bedrock' },
    }],
    composer,
  }).text()
  ok(answered.includes('Amazon Bedrock'),
     'once the CLI answers, the chip names what it is ACTUALLY on')
}

// An approval must name the agent that actually asked, and say what it wants.
//
// The header was the literal string "Claude wants to run", so a Codex approval
// — the commonest event on Codex's shipped default policy — named the wrong
// vendor. Worse, Codex computes its own sentence ("Codex wants to change 3
// files in your worktree") and it was dropped at the host/webview boundary, so
// the dialog authorising a write to the user's worktree withheld the file
// count, the names and the reason all at once.
{
  const withPrompt = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    cards: [{
      ...CARD,
      agent: {
        kind: 'needsInput', contextTokens: 0,
        pendingPermission: { id: 'p1', summary: 'Edit', prompt: 'Codex wants to change 3 files in your worktree' },
      },
    }],
  }).text()
  ok(withPrompt.includes('Codex wants to change 3 files'),
     `the runtime's own sentence is shown (${/\w+ wants to [^"]{0,40}/.exec(withPrompt)?.[0] ?? 'nothing'})`)
  ok(!withPrompt.includes('Claude wants to run'), 'and not attributed to the wrong agent')

  // A runtime that gives no sentence still gets the old rendering.
  const noPrompt = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    cards: [{
      ...CARD,
      agent: { kind: 'needsInput', contextTokens: 0, pendingPermission: { id: 'p1', summary: 'Bash npm test' } },
    }],
  }).text()
  ok(noPrompt.includes('Claude wants to run') && noPrompt.includes('npm test'),
     'a runtime with no sentence of its own falls back to the summary')

  // And a second request must be VISIBLE. One slot used to hold them all, so
  // answering the one on screen left the agent blocked on an invisible one
  // while the card went back to saying "working".
  const two = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    cards: [{
      ...CARD,
      agent: {
        kind: 'needsInput', contextTokens: 0,
        pendingPermission: { id: 'p1', summary: 'Bash npm test', waiting: 3 },
      },
    }],
  }).text()
  ok(/2 more waiting/.test(two), `the requests queued behind it are counted (${/\d+ more waiting[^.]*/.exec(two)?.[0] ?? 'not shown'})`)
}

// A SUBSCRIPTION session has no dollar figure it can defend, and this is the
// case the whole union exists for. `composer.spentUsd` was a number and only
// one runtime emits dollars, so every Codex session arrived as 0 and the bar
// read "$0.00" over a card that had just spent 13% of a five-hour window.
const plan = run({
  ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
  composer: {
    ...COMPOSER,
    meter: { kind: 'plan', usedPercent: 13, windowMinutes: 300, plan: 'plus' },
  },
}).text()
ok(plan.includes('13% of 5h'), `a plan meter shows the window it spent: ${plan.match(/\d+% of \S+/)?.[0]}`)
ok(plan.includes('plus'), 'and names the plan')
ok(!/\$/.test(plan), 'and makes NO dollar claim at all — not even $0.00')

// "Could not read it" is not "nothing was spent", and must never render green
// or as a zero.
const unknown = run({
  ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
  composer: { ...COMPOSER, meter: { kind: 'unknown' } },
}).text()
ok(unknown.includes('—'), 'an unknown meter renders an em dash')
ok(!/\$|0%/.test(unknown), 'and never as zero')

// A meter shape this build cannot read must not reach the bar as anything.
// Every one of these used to be a live crash path: `spentUsd` came off an
// untyped EventEmitter, and a `Meter` object in a number's slot made
// `.toFixed(2)` throw inside render() — a silently blank panel.
for (const bad of [{ kind: 'usd', spentUsd: 'lots' }, { kind: 'martian' }, { kind: 'plan' }, 42, 'x', null]) {
  const label = JSON.stringify(bad)
  let text = null
  let threw = null
  try {
    text = run({
      ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
      composer: { ...COMPOSER, meter: bad },
    }).text()
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e)
  }
  ok(threw === null, `a meter of ${label} does not throw in render()${threw ? `: ${threw}` : ''}`)
  ok(text !== null && !/NaN|undefined|Infinity|\[object/.test(text), `a meter of ${label} does not render as itself`)
}

// 6. Streaming text renders as a live block.
const st = run({ ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [], streaming: 'partial out' })
ok(st.text().includes('partial out'), 'streaming text renders live')

// 7. Archive and delete must be reachable from the chat header.
ok(ct.includes('Archive') && ct.includes('Delete'), 'archive and delete offered in the chat header')
const arch = run({ ...base, mode: 'chat', selectedKey: 'abc-123', cards: [{ ...CARD, archived: true }], transcript: [] })
ok(arch.text().includes('Unarchive'), 'an archived session offers Unarchive')

// 8. The review panel: the half that gets work back out of the worktree.
const WT_CARD = { ...CARD, worktree: '/tmp/proj_worktrees/s1', branch: 'task/S1-fix' }
const reviewBase = { ...base, mode: 'chat', selectedKey: 'abc-123', cards: [WT_CARD], transcript: [] }

// Before it is loaded the panel offers to load it, rather than showing nothing.
const unloaded = run(reviewBase)
ok(unloaded.text().includes('Show changes'), 'a worktree session offers to show its changes')

const reviewed = run({
  ...reviewBase,
  review: {
    base: 'main', ahead: 2, dirty: 1,
    files: [
      { path: 'src/auth.ts', status: 'M', committed: true },
      { path: 'src/new.ts', status: '?', committed: false },
    ],
    lastCommit: { sha: 'a1b2c3d', message: 'Add auth guard\n\nbody' },
  },
})
const rt = reviewed.text()
ok(rt.includes('src/auth.ts') && rt.includes('src/new.ts'), 'every changed file is listed')
ok(rt.includes('uncommitted'), 'uncommitted work is called out, not blended in')
ok(rt.includes('2 commits') && rt.includes('1 uncommitted'), `the summary counts both (${/\d+ commits? · \d+ uncommitted/.exec(rt)?.[0]})`)
ok(rt.includes('a1b2c3d') && rt.includes('Add auth guard'), 'the last commit is shown, first line only')
ok(!rt.includes('body'), 'the commit body is not spilled into the row')
ok(rt.includes('Merge into main'), 'merging back is offered, naming the target branch')
ok(rt.includes('Commit 1 file'), 'committing the uncommitted work is offered')

// Nothing committed yet is the state the agent brief actually produces: the
// merge button must be present but refuse to be the obvious next click.
const nothingYet = run({
  ...reviewBase,
  review: { base: 'main', ahead: 0, dirty: 3, files: [{ path: 'a.ts', status: 'M', committed: false }] },
})
const merge = findButton(nothingYet.root, 'Merge into main')
ok(merge && merge.disabled === true, 'with nothing committed, merge is disabled rather than silently merging nothing')

// A session with no worktree must not grow a review panel at all.
const noWt = run({ ...base, mode: 'chat', selectedKey: 'abc-123', cards: [CARD], transcript: [] })
ok(!noWt.text().includes('Show changes'), 'a session without a worktree shows no review panel')

// 9. The test plan: the agent's own instructions, made clickable.
const PLAN = {
  summary: 'Adds subtract() and multiply() to calc.js',
  steps: ['Run npm test', 'Import calc and call subtract(5, 3)'],
  links: [
    { label: 'calc.js', target: 'calc.js', kind: 'file' },
    { label: 'Run the tests', target: 'npm test', kind: 'command' },
    { label: 'Local server', target: 'http://localhost:3000', kind: 'url' },
  ],
  at: Date.now(),
}
const planned = run({
  ...base, mode: 'chat', selectedKey: 'abc-123',
  cards: [{ ...WT_CARD, testPlan: PLAN }], transcript: [],
})
const pt = planned.text()
ok(pt.includes('How to test this'), 'the card explains how to test the work')
ok(pt.includes('Adds subtract()'), 'the summary is shown')
ok(pt.includes('Run npm test') && pt.includes('subtract(5, 3)'), 'every step is listed')
ok(pt.includes('calc.js') && pt.includes('Local server'), 'links are rendered as their labels')

// Each link must be a real button, or "clickable" is a claim rather than a fact.
for (const label of ['calc.js', 'Run the tests', 'Local server']) {
  ok(!!findButton(planned.root, label), `"${label}" is a clickable button`)
}

// A session with no plan must not grow an empty panel.
const unplanned = run({ ...base, mode: 'chat', selectedKey: 'abc-123', cards: [WT_CARD], transcript: [] })
ok(!unplanned.text().includes('How to test this'), 'no plan, no panel')

// 10. The interaction surface: interrupt, the queue, notices, slash commands.

// Interrupt ends the TURN; Stop ends the run. Both must be reachable while busy,
// and interrupt was implemented and unreachable — nothing in the UI called it.
const busy = run({ ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [] })
ok(!!findButton(busy.root, 'Interrupt'), 'a working agent can be interrupted')
ok(!!findButton(busy.root, 'Stop'), 'and still stopped outright')
const idle = run({
  ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
  cards: [{ ...CARD, agent: { kind: 'done', contextTokens: 1, contextWindow: 10 } }],
})
ok(!findButton(idle.root, 'Interrupt'), 'a finished agent offers no interrupt')

// Messages typed mid-turn are held. Without this they vanish on Enter and
// reappear minutes later.
const queued = run({
  ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
  cards: [{ ...CARD, queued: ['also update the README', 'and add a test'] }],
})
const qt = queued.text()
ok(qt.includes('2 queued'), 'queued messages are counted')
ok(qt.includes('also update the README') && qt.includes('and add a test'), 'and shown in full')
ok(!!findButton(queued.root, 'Discard'), 'and can be discarded')

// notify_user: the agent asking for attention mid-run.
const noticed = run({
  ...base, mode: 'chat', selectedKey: 'abc-123',
  transcript: [
    { kind: 'notice', at: Date.now(), message: 'Which auth provider should I use?', urgency: 'blocked' },
    { kind: 'notice', at: Date.now(), message: 'Heads up: the schema changed.', urgency: 'info' },
  ],
})
ok(noticed.text().includes('Which auth provider'), 'a blocked notice is rendered')
ok(noticed.text().includes('Heads up'), 'and an informational one')

// Permission mode is a composer control, changeable mid-run.
ok(ct.includes('Auto-accept edits'), 'the composer shows the permission mode')

// Slash commands: typing "/" offers what the project actually has.
const CMDS = [
  { name: 'review', description: 'Review the diff', scope: 'project', path: 'x' },
  { name: 'ship', description: 'Ship the branch', scope: 'user', path: 'y' },
]
const noSlash = run({ ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [], commands: CMDS })
ok(!noSlash.text().includes('/review'), 'commands stay hidden until you type a slash')

// Driving the actual keystrokes, because both bugs here were invisible to a
// state-only test: the composer lost focus the moment you typed `/`, and the
// menu went stale when a different query matched the same NUMBER of commands.
const MANY = [
  { name: 'review', description: 'Review the diff', scope: 'project', path: 'a' },
  { name: 'release', description: 'Cut a release', scope: 'project', path: 'b' },
  { name: 'ship', description: 'Ship the branch', scope: 'user', path: 'c' },
]
const typed = run({ ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [], commands: MANY })
const type = (view, text) => {
  const ta = findByTag(view.root, 'textarea')
  ta.focus()
  ta.value = text
  ta.oninput({ target: ta })
  return findByTag(view.root, 'textarea')
}

const afterSlash = type(typed, '/')
ok(typed.text().includes('/review') && typed.text().includes('/ship'), 'typing "/" lists the commands')
ok(typed.document.activeElement === afterSlash,
   'and the composer KEEPS focus — render() rebuilds it, so it must be handed back')

// 're' and 'sh' both match... 're' matches 2, 'sh' matches 1: change of size.
// 'r' and 're' both match 2 — same count, different set is the trap.
type(typed, '/r')
ok(typed.text().includes('/review') && typed.text().includes('/release'), '"/r" narrows to two')
type(typed, '/rel')
ok(typed.text().includes('/release') && !typed.text().includes('/review'),
   'a query matching a different set repaints, even when the count is unchanged')

const gone = type(typed, 'not a command')
ok(!typed.text().includes('/release'), 'the menu closes once the text is no longer a slash command')
ok(typed.document.activeElement === gone, 'and focus is still in the composer')

// 11. Taking the window. The board is five columns and a rail; squeezed beside a
// file explorer there is not enough room to read a card, so this has to be one
// click away in both views rather than buried in the command palette.
const wide = run(base)
ok(!!findButton(wide.root, '⤢'), 'the kanban toolbar offers to take the window')
const widened = run({ ...base, focused: true })
ok(!!findButton(widened.root, '⤡'), 'and to give it back once taken')
// Never in the sidebar. There the button would close the panel the board is
// drawn in, so the board vanished behind the control meant to enlarge it.
const chatWide = run({ ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [] })
ok(!!findButton(chatWide.root, '⤢'), 'the chat header offers it too')

// 12. Chat with no session selected offers the composer, not a blank.
const nu = run({ ...base, mode: 'chat', cards: [] })
ok(nu.text().includes('Start a session'), 'chat with no selection shows the new-session hint')

// 13. A Task's subagent work is on screen, not swallowed.
//
// Both halves of this shipped broken at once: SessionStore.transcript() dropped
// every message with a parent_tool_use_id, and the stream handler had no idea
// subagents existed. A Task that ran for minutes rendered as one motionless
// row, and the board looked stopped while it was working hard.
const withSub = run({
  ...base, mode: 'chat', selectedKey: CARD.key,
  transcript: [
    { kind: 'prompt', at: 1, text: 'do the thing' },
    {
      kind: 'tool', at: 2, id: 't1', name: 'Task', summary: 'Task explore', status: 'running',
      children: [
        { kind: 'text', at: 3, text: 'Looking for the config loader' },
        { kind: 'tool', at: 4, id: 't2', name: 'Grep', summary: 'Grep loadConfig', status: 'ok' },
        { kind: 'tool', at: 5, id: 't3', name: 'Read', summary: 'Read src/config.ts', status: 'ok' },
      ],
    },
  ],
})
const subText = withSub.text()
ok(subText.includes('Subagent'), 'a Task with children announces the nested subagent')
ok(subText.includes('3 steps'), 'and says how much it did')
ok(subText.includes('2 tool calls'), 'counting its tool calls')
ok(subText.includes('Grep loadConfig'), "the subagent's own tool calls are rendered")
ok(subText.includes('Looking for the config loader'), 'and what it said')

// A Task with no children must still render exactly as before.
const noSub = run({
  ...base, mode: 'chat', selectedKey: CARD.key,
  transcript: [{ kind: 'tool', at: 2, id: 't1', name: 'Read', summary: 'Read a.ts', status: 'ok' }],
})
ok(noSub.text().includes('Read a.ts'), 'a plain tool row is untouched')
ok(!noSub.text().includes('Subagent'), 'and grows no empty subagent section')

// 14. The liveness readout is an AGE, not a claim.
//
// The pulsing dot runs off a CSS timer and keeps pulsing over a wedged process.
// The user could not tell "working" from "hung", and said so.
const live = run({
  ...base, mode: 'kanban',
  cards: [{
    key: 'a', sessionId: 'a', title: 'busy', phase: 'implementing', tags: [], updated: Date.now(),
    agent: { kind: 'working', tool: 'Task', subagent: 'Grep', contextTokens: 0, lastEventAt: Date.now() - 5000 },
  }],
})
const liveText = live.text()
ok(liveText.includes('Task → Grep'), 'the card names what the SUBAGENT is doing, not just "Task"')
// A seconds-resolution age. Not pinned to an exact number: it is computed at
// render time, so asserting "5s" makes the test fail whenever the render lands
// on the far side of a rounding boundary.
// Anchored to the row it belongs to: the stub DOM joins text with no
// separators, so a trailing \b lands against the next column's name.
ok(/Task → Grep…\d+s/.test(liveText),
   `and how long since the CLI last said anything (${JSON.stringify(liveText.slice(-40))})`)
ok(!/just now/.test(liveText.slice(liveText.indexOf('Task → Grep'))),
   'in seconds — "just now" is the resolution that cannot answer "has it stopped?"')

// Minutes once it has been a while, which is when the question gets asked.
const stalled = run({
  ...base, mode: 'kanban',
  cards: [{
    key: 'a', sessionId: 'a', title: 'busy', phase: 'implementing', tags: [], updated: Date.now(),
    agent: { kind: 'working', tool: 'Task', contextTokens: 0, lastEventAt: Date.now() - 10 * 60_000 },
  }],
})
ok(/\b10m\b/.test(stalled.text()),
   `ten minutes of silence reads as 10m, not as a reassuring pulse (${JSON.stringify(stalled.text().slice(-40))})`)

// 15. THE CHAT VIEW says whether it is running. This is where the user sits and
// watches, and it had no indicator of any kind — the spinner and the age lived
// only on the kanban cards, so a turn in progress looked identical to a turn
// that had stopped.
const chatBusy = run({
  ...base, mode: 'chat', selectedKey: CARD.key,
  cards: [{ ...CARD, agent: { kind: 'working', tool: 'Bash', contextTokens: 0, lastEventAt: Date.now() - 7000 } }],
  transcript: [{ kind: 'tool', at: 1, id: 't1', name: 'Bash', summary: 'Bash npm test', status: 'running' }],
})
const busyText = chatBusy.text()
ok(/Bash…?\s*·\s*\d+s/.test(busyText.replace(/\u00a0/g, ' ')) || /Bash·\d+s/.test(busyText),
   `the chat shows what it is doing and for how long (${JSON.stringify(busyText.slice(-30))})`)
ok(!!findByTag(chatBusy.root, 'span', (n) => (n.className || '').includes('spinner')),
   'and an actual spinner element, which is the "is it alive" signal at a glance')

// And it must NOT claim to be running when it is not.
const chatDone = run({
  ...base, mode: 'chat', selectedKey: CARD.key,
  cards: [{ ...CARD, agent: { kind: 'done', summary: 'finished', contextTokens: 0 } }],
  transcript: [{ kind: 'tool', at: 1, id: 't1', name: 'Bash', summary: 'Bash npm test', status: 'ok' }],
})
ok(!findByTag(chatDone.root, 'span', (n) => (n.className || '').includes('spinner')),
   'a finished turn has no spinner — an indicator that never stops is not an indicator')

// 16. WHERE THE TIME WENT. Reported as "it worked for four and a half minutes
// just pulling a Jira ticket" — which the board could not confirm or deny,
// because the only number it showed was the age of the last frame from the CLI.
// That answers "is it still moving"; it cannot answer "which call is spending
// the time", and with one slow MCP round trip per turn those are different
// questions with the same shape.
const timed = run({
  ...base, mode: 'chat', selectedKey: CARD.key,
  cards: [{ ...CARD, agent: { kind: 'working', tool: 'Atlassian · getJiraIssue', contextTokens: 0, lastEventAt: Date.now() } }],
  transcript: [
    { kind: 'tool', at: 1, id: 't1', name: 'mcp__claude_ai_Atlassian__getJiraIssue',
      summary: 'Atlassian · getJiraIssue  ACME-184', status: 'ok', durationMs: 272000 },
    { kind: 'tool', at: 2, id: 't2', name: 'Read', summary: 'Read a.ts', status: 'ok', durationMs: 120 },
    { kind: 'tool', at: 3, id: 't3', name: 'mcp__claude_ai_Atlassian__searchJira',
      summary: 'Atlassian · searchJira  project = ACME', status: 'running',
      runningSince: Date.now() - 95000 },
  ],
})
const timedText = timed.text()
ok(/4m\s*32s/.test(timedText), `a finished call says how long it took (${JSON.stringify(timedText.slice(0, 60))})`)
ok(/1m\s*35s/.test(timedText), 'and a call still outstanding says how long it has been going')
const readRow = findByTag(timed.root, 'div', (n) => (n.className || '').startsWith('tool ') && n.textContent.includes('Read a.ts'))
ok(!!readRow && !readRow.children.some((k) => (k.className || '').includes('tool-time')),
   'a call that returned instantly is not annotated — a column of "0s" is noise')

// The ticking half has to be wired to tickAges(), or the number freezes at
// whatever it was when the last frame happened to arrive — the exact failure
// the age readout was added to fix, reintroduced one level down.
const ticking = findByTag(timed.root, 'span', (n) => (n.className || '').includes('tool-time') && n.getAttribute?.('data-since'))
ok(!!ticking, 'a running call carries data-since, so its timer keeps climbing between frames')

// A row rehydrated from disk has neither field: the SDK's session API does not
// expose message timestamps, so there is no honest number to show. It must show
// none rather than one counting from when the view opened.
const fromDisk = run({
  ...base, mode: 'chat', selectedKey: CARD.key,
  transcript: [{ kind: 'tool', at: Date.now(), id: 't1', name: 'Read', summary: 'Read a.ts', status: 'running' }],
})
ok(!findByTag(fromDisk.root, 'span', (n) => (n.className || '').includes('tool-time')),
   'a row with no recorded start time is not given an invented one')

// 17. A SPLIT TASK, from both ends.
//
// When an agent decides its brief is two unrelated jobs and splits it, the board
// grows two cards. Without the thread between them that just looks like two
// agents appearing from nowhere — so the subtask names its parent, the parent
// lists its subtasks, and the count says how much of it is testable yet. That
// count is the whole "when do I test what" answer, so it has to be exact.
const PARENT = {
  key: 'p1', sessionId: 'p1', title: 'Add SSO and fix the flaky test',
  phase: 'implementing', tags: [], updated: Date.now(),
  subtasks: [
    { key: 'c1', title: 'Add SSO to the login page', phase: 'validating', ready: true },
    { key: 'c2', title: 'Fix the flaky snapshot test', phase: 'implementing', ready: false },
  ],
}
const CHILD = {
  key: 'c2', sessionId: 'c2', title: 'Fix the flaky snapshot test',
  phase: 'implementing', tags: [], updated: Date.now(),
  parent: 'p1', parentTitle: 'Add SSO and fix the flaky test',
}
const split = run({ ...base, mode: 'kanban', cards: [PARENT, CHILD] })
const splitText = split.text()
ok(splitText.includes('2 subtasks'), 'the parent card says it was split')
ok(splitText.includes('1/2 ready'), `and how much of it is ready to test (${JSON.stringify(splitText.match(/\d\/\d ready/)?.[0])})`)
ok(splitText.includes('Add SSO to the login page'), 'it names each subtask')
ok(splitText.includes('↳ Add SSO and fix the flaky test'), 'and the subtask names its parent')

// The count must be derived, not decorative: all-ready reads differently,
// because that is the moment the whole task becomes testable.
const allReady = run({
  ...base, mode: 'kanban',
  cards: [{ ...PARENT, subtasks: PARENT.subtasks.map((t) => ({ ...t, ready: true, phase: 'validating' })) }],
})
ok(allReady.text().includes('2/2 ready'), 'a fully-landed split says 2/2')
ok(!!findByTag(allReady.root, 'div', (n) => (n.className || '').includes('all-ready')),
   'and is marked as a whole, so it can be spotted without reading the fraction')

// Both halves are navigable, or the relationship is a label rather than a link.
const upButton = findByTag(split.root, 'button', (n) => (n.className || '').includes('subtask-of'))
ok(!!upButton, 'the parent reference is a button, not just text')
const downButton = findByTag(split.root, 'button', (n) => (n.className || '').includes('subtask') && !(n.className || '').includes('subtask-of'))
ok(!!downButton, 'and so is each subtask row')

// An ordinary card grows none of this.
const plain = run({ ...base, mode: 'kanban', cards: [{ ...CARD }] })
ok(!plain.text().includes('subtasks'), 'a card that was never split is untouched')
ok(!findByTag(plain.root, 'button', (n) => (n.className || '').includes('subtask-of')),
   'and carries no dangling parent reference')

// The parent's chat page leads with the subtasks: its own transcript is three
// lines of "I split this", and the subtasks are what there is to test.
const parentChat = run({ ...base, mode: 'chat', selectedKey: 'p1', cards: [PARENT, CHILD], transcript: [] })
ok(parentChat.text().includes('1/2 ready'), "the parent's chat page leads with its subtasks")

// --- a run the editor killed on its way out ----------------------------------
//
// Reinstalling the extension or reloading the window kills every agent process
// mid-turn. Nothing can re-attach to them. The failure this guards is the
// SILENT one: without a word on screen, a cut-off run looks exactly like a
// finished one, and the difference is whether the work was ever done.
{
  const CUT = {
    key: 'cut-1', sessionId: 'cut-1', title: 'Migrate the store', phase: 'implementing',
    tags: [], updated: Date.now() - 9 * 60_000, branch: 'task/S9-migrate',
    interrupted: Date.now() - 9 * 60_000,
  }
  const board = run({ ...base, cards: [CUT] })
  ok(board.text().includes('Interrupted'), 'the board says a cut-off run was interrupted')
  // The number, not just the word: "2m ago" and "3 days ago" are different
  // situations, and this board's rule is that an indicator shows what it is
  // derived from.
  ok(/Interrupted\s+9m ago/.test(board.text()), `and how long ago (${board.text().match(/Interrupted[^,<]{0,14}/)})`)

  const page = run({ ...base, mode: 'chat', selectedKey: 'cut-1', cards: [CUT], transcript: [] })
  const pt = page.text()
  ok(pt.includes('Resume'), 'the chat page offers to pick it back up')
  ok(pt.includes('Dismiss'), 'and to accept that it is not coming back')
  ok(/process is gone/.test(pt), 'and says plainly that the process cannot be re-attached')

  const resume = findButton(page.root, 'Resume')
  const dismiss = findButton(page.root, 'Dismiss')
  ok(!!resume && !!dismiss, 'both are real buttons, not decoration')
  resume.onclick({ stopPropagation() {} })
  ok(page.posted.some((m) => m.type === 'resume' && m.id === 'cut-1'), 'Resume asks the host to resume THIS session')
  dismiss.onclick({ stopPropagation() {} })
  ok(page.posted.some((m) => m.type === 'dismissInterrupted' && m.id === 'cut-1'), 'Dismiss clears it')

  // The one that would put an "interrupted" banner over a working agent: a live
  // run is the run the mark refers to, not a casualty of a restart.
  const live = run({ ...base, cards: [{ ...CUT, agent: CARD.agent }] })
  ok(!live.text().includes('Interrupted'), 'a card with a LIVE agent never shows the banner')
}

// --- the liveness age must actually CLIMB -----------------------------------
//
// The board's rule is that a spinner spins over a wedged process too, so the
// indicator shows the AGE of the last frame the CLI sent. `tickAges()` is what
// makes that number move between state messages — and it could not run in any
// gate: `document.querySelectorAll` was missing from the stub and `setInterval`
// is not a V8 intrinsic, so board.js's own `typeof setInterval === 'function'`
// guard meant the ticker was never even registered. The one signal that has to
// be able to say "nothing is happening" was untestable.
{
  const started = Date.now() - 5000
  const v = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    cards: [{ ...CARD, agent: { kind: 'working', tool: 'Bash', contextTokens: 0, lastEventAt: started } }],
  })
  ok(v.timers.length > 0, `the age ticker is registered (${v.timers.length} timer(s))`)
  const age = () => {
    const n = v.root.querySelectorAll('[data-since]')[0]
    return n ? n.textContent : null
  }
  ok(age() !== null, `the age is on screen (${age()})`)
  const first = age()
  // Move the clock and let the ticker run, as a second of real time would.
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 60_000
    v.tick()
    const later = age()
    ok(later !== first,
       `and it CLIMBS when nothing is happening — the whole point of showing it (${first} -> ${later})`)
    ok(/m|s/.test(String(later)), `still formatted as a duration (${later})`)
  } finally {
    Date.now = realNow
  }
}

// --- the model menu, which is where a picker stopped being usable ------------
//
// Two things happen when the model list comes from a custom endpoint instead of
// from a table of three: it carries facts worth showing (a window, a price),
// and it can be 431 entries long. A flat menu of 431 unlabelled ids is not a
// picker, and a menu that says only `deepseek/deepseek-chat-v3.1` is not a
// choice anybody can make.
{
  const CATALOGUE = [{
    id: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek: DeepSeek V3.1',
    context: '161K', price: '$0.55/$1.65 per Mtok', detail: 'A large hybrid reasoning model.',
  }]
  for (let i = 0; i < 60; i++) CATALOGUE.push({ id: `vendor/model-${i}`, label: `Model ${i}`, context: '128K' })

  const v = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    composer: {
      ...COMPOSER, model: 'deepseek/deepseek-chat-v3.1', models: CATALOGUE, modelSource: 'endpoint',
      provider: 'or', providers: [{ id: 'or', label: 'OpenRouter', detail: 'api.deepseek.com', support: 'gateway' }],
      runtime: 'claude', runtimes: [{ id: 'claude', label: 'Claude Code', detail: 'Anthropic', providerProfiles: true }],
      agent: 'claude|or',
      agents: [
        { key: 'claude|inherit', label: 'Claude Code', detail: 'Anthropic · default backend', runtime: 'claude', provider: 'inherit' },
        { key: 'claude|or', label: 'OpenRouter', detail: 'Claude Code · api.deepseek.com', runtime: 'claude', provider: 'or' },
      ],
    },
  })
  /* ONE list of things you can run on, which is what was actually asked for:
     "there should be two buttons, one saying Claude Code, the other saying
     OpenRouter and the URL — and OpenRouter should show the DeepSeek models."
     Two pickers made that a cross product the user had to do in their head,
     and the bar showed one half of it. */
  ok(v.text().includes('OpenRouter'), 'the chip names the combination that is selected')
  const agentChip = findButton(v.root, 'OpenRouter')
  agentChip.onclick({ stopPropagation() {}, preventDefault() {} })
  const agentMenu = v.text()
  ok(agentMenu.includes('Claude Code') && agentMenu.includes('Anthropic · default backend'),
     'and the menu offers the other backend on the same agent as its own entry')
  ok(agentMenu.includes('Claude Code · api.deepseek.com'),
     'each entry naming both halves — which agent program, and which endpoint')
  const picked = []
  for (const b of walkAll(v.root)) {
    if ((b.className || '').includes('menu-item') && String(b.textContent).includes('Anthropic · default')) picked.push(b)
  }
  picked[0].onclick({ stopPropagation() {}, preventDefault() {} })
  const sent = v.posted.filter((m) => m.type === 'composer' && m.agent)
  ok(sent.length === 1 && sent[0].agent === 'claude|inherit',
     'and picking one sends BOTH halves as a single switch, so the two model refreshes cannot race')
  // Left CLOSED: the model-menu assertions below open it themselves, and
  // `picker` toggles — opening it here would shut it there.
  ok(v.text().includes('DeepSeek: DeepSeek V3.1'), 'the chip names the selected model, whoever serves it')

  // Open it.
  const chip = findButton(v.root, 'DeepSeek: DeepSeek V3.1')
  ok(!!chip, 'the model picker is a control')
  chip.onclick({ stopPropagation() {}, preventDefault() {} })
  const menu = v.text()
  ok(menu.includes('$0.55/$1.65 per Mtok'), 'an open menu shows what each model costs')
  ok(menu.includes('161K context'), 'and how much context it has')
  ok(menu.includes('deepseek/deepseek-chat-v3.1'),
     'and the id, which is what actually gets sent and is not always in the name')
  ok(menu.includes('Served by api.deepseek.com'),
     'and where the list came from, in one line naming the host — which is the whole explanation for why a Claude Code session is offering DeepSeek models')

  // 61 models: not all of them, and it SAYS not all of them. A list silently
  // cut short is a model that is configured, served, and apparently missing.
  ok(/Showing 50 of 61/.test(menu), 'a long list is bounded and says what it is not showing')

  const box = v.root.querySelector('.menu-filter')
  ok(!!box, 'a long list gets a filter box')
  ok(!!box.getAttribute('data-focus'),
     'which announces itself for focus restore — the panel repaints on every agent frame, and the first keystroke would otherwise lose the rest of the word')
  box.oninput({ target: { value: 'deepseek' } })
  const filtered = v.text()
  ok(filtered.includes('DeepSeek: DeepSeek V3.1'), 'typing narrows the list to what matches')
  ok(!filtered.includes('Model 42'), 'and drops what does not')
  box.oninput({ target: { value: 'zzzz' } })
  ok(/Nothing matches/.test(v.text()),
     'a filter that matches nothing says so, rather than looking like an empty picker')
}

// --- a short list is left alone ---------------------------------------------
{
  const v = run({
    ...base, mode: 'chat', selectedKey: 'abc-123', transcript: [],
    composer: { ...COMPOSER, models: [{ id: 'claude-opus-5', label: 'Opus 5', context: '1M' }] },
  })
  findButton(v.root, 'Opus 5').onclick({ stopPropagation() {}, preventDefault() {} })
  ok(!v.root.querySelector('.menu-filter'),
     'three models get no filter box — below a certain length it is one more thing to look at')
  ok(!/Showing/.test(v.text()), 'and nothing is hidden, so nothing is announced')
}

console.log(fails === 0 ? 'PASS — the webview renders in every state' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
