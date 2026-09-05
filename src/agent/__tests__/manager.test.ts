/* AgentManager's bookkeeping, without launching a real agent.

   The interesting behaviour here is identity: a run starts keyed by a local
   runId and adopts Claude Code's session id moments later, and the board has to
   show it correctly throughout. Both halves of that have failure modes that are
   completely silent. */
import { AgentManager, durablePatch, MAX_SUBTASKS, titleFrom, buildBrief, type RunningAgent } from '../manager.ts'
import { agentEnv, HOST_SESSION_VARS } from '../session.ts'
import { DEFAULT_BOARD } from '../../board/config.ts'
import { parseMeter } from '../runtime.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// --- titles ------------------------------------------------------------------
//
// This name is not cosmetic. It is what the card says for the rest of the
// session AND, through slug(), what the worktree directory and branch are
// called — and those can never be renamed, because the agent is running inside
// the directory. The two fixtures below are real prompts from this repository's
// own board, which produced a card called "Okay." in a worktree called
// `S2mtnf1lpa-okay`, and one cut off mid-word at `...-repository-figur`.
ok(titleFrom('Fix the login flow') === 'Fix the login flow', 'a short prompt is the title')
ok(titleFrom('Fix login. Then do more.') === 'Fix login', 'the first sentence is taken, without its full stop')
ok(titleFrom('First line\nsecond line') === 'First line', 'the first line wins, even though the second is longer')
ok(titleFrom('   ') === 'Untitled session', 'an empty prompt still gets a name')
ok(titleFrom('') === 'Untitled session', 'so does a blank one')
const long = titleFrom('x'.repeat(200))
ok(long.length <= 72 && long.endsWith('…'), `a long prompt is truncated with an ellipsis (${long.length} chars)`)
ok(titleFrom('a\t b   c') === 'a b c', 'whitespace is collapsed')

// The bug, as it was reported: "this session is basically just called Okay".
const spoken = titleFrom(
  'Okay. I want you to create a list of features based on how common are they ' +
  'and how useful are they for harness like this one.',
)
ok(!/^okay/i.test(spoken), `a sentence that is only filler is skipped, not used as the name (got "${spoken}")`)
ok(spoken.startsWith('create a list of features'),
   `the request itself becomes the name (got "${spoken}")`)
ok(titleFrom('okay start the implementation') === 'start the implementation',
   'a leading discourse marker is dropped')
ok(titleFrom('Okay. So can you please add SSO to the admin app?') === 'add SSO to the admin app?',
   `stacked filler and a request wrapper are both dropped (got "${titleFrom('Okay. So can you please add SSO to the admin app?')}")`)
ok(titleFrom('I want you to fix the flaky snapshot test') === 'fix the flaky snapshot test',
   'so is "I want you to"')
ok(titleFrom('Please add SSO') === 'add SSO',
   'a two-word remainder is still better than the filler in front of it')
// Casing is left alone on purpose: capitalising turns `npm run verify` into
// `Npm run verify`, and a mangled title is worse than a lowercase one.
ok(titleFrom('npm run verify is failing on main') === 'npm run verify is failing on main',
   'a command keeps its own casing')
// The degenerate case has nothing else to offer, and must still not throw.
ok(titleFrom('Okay.') === 'Okay', 'a prompt that is nothing but filler falls back to it')
ok(titleFrom('the just-in-time cache is cold') === 'the just-in-time cache is cold',
   'a filler word inside a sentence is not touched')

// --- the brief the agent is given -------------------------------------------
// It must name the tool and both destinations, or the agent has no idea it owns
// a card. This is the prompt half of "policy in the description, boundary in code".
const brief = buildBrief(DEFAULT_BOARD, 'Fix login', 'task/S1-fix')
ok(brief.includes('set_phase'), 'the brief names the tool that moves the card')
ok(brief.includes('implementing') && brief.includes('validating'), 'and both phases it should move through')
ok(brief.includes('task/S1-fix'), 'it tells the agent which branch it is on')
ok(brief.includes('Fix login'), 'and which card is its own')
ok(!brief.includes('complete'), 'it does NOT invite the agent to complete its own work')
ok(brief.includes('set_title'), 'and it tells the agent the card name is a guess it can fix')

// --- identity collision ------------------------------------------------------
// Two live runs reporting the same session id must not become one card. Before
// this guard the second registration overwrote the first's worktree mapping and
// title in the sidecar, so the board showed one agent's worktree under the
// other's name — and nothing threw.
type Agent = { runId: string; sessionId?: string; title: string }
const agents = new Map<string, Agent>()
agents.set('run-1', { runId: 'run-1', sessionId: 'sess-A', title: 'First' })
const incoming: Agent = { runId: 'run-2', title: 'Second' }
agents.set('run-2', incoming)

// This mirrors the guard in launch()'s sessionId handler.
const clashesWith = (self: Agent, id: string) =>
  [...agents.values()].find((a) => a !== self && a.sessionId === id)

ok(!!clashesWith(incoming, 'sess-A'), 'an id already held by another live agent is detected as a clash')
ok(!clashesWith(incoming, 'sess-B'), 'a fresh id is not a clash')
ok(!clashesWith(agents.get('run-1')!, 'sess-A'), 'an agent does not clash with itself')

// --- the concurrency slot ----------------------------------------------------
// `drain()` starts whatever is queued behind maxConcurrentAgents, and it used to
// run ONLY from finish(), which fires on the 'done'/'error' events. A run that
// settles to `idle` — aborted, or interrupted before the CLI even started —
// emits neither, so its slot was never released and every queued agent waited
// forever. activeCount is what decides, so these are the states that must free
// a slot.
//
// The gate that used to be here could not fail: it built two local arrays and
// asserted that each contained its own members (`ACTIVE.includes(kind)` for
// every `kind` of `ACTIVE`). It never touched the manager, so both halves of
// the bug below were completely unguarded.
{
  // A worktree service that takes a REAL await to create a worktree, which is
  // what the bug needs: `git worktree add` behind the repo lock is tens to
  // hundreds of milliseconds, and for that whole window the launching run was
  // invisible to the limit.
  let created = 0
  const slow = {
    create: async (a: { taskId: string }) => {
      created++
      await new Promise((r) => setTimeout(r, 30))
      return { path: '/tmp/wt/' + a.taskId, branch: 'task/' + a.taskId, base: 'main' }
    },
    isClean: async () => true,
    aheadOf: async () => 0,
    discard: async () => {},
  }
  const started: string[] = []
  const mgr = new AgentManager({
    store: {
      get: async () => undefined,
      card: async () => ({ phase: 'planning', tags: [] }),
      childrenOf: async () => [],
      patch: async () => {},
      transcript: async () => [],
      usage: async () => ({ costUsd: 0 }),
      adoptKey: async () => {},
      rename: async () => ({ renamed: true }),
      setTags: async () => {},
    } as never,
    worktrees: slow as never,
    board: DEFAULT_BOARD,
    defaults: {},
    permissionMode: 'acceptEdits',
    maxConcurrent: 1,
  })
  const inner = mgr as unknown as {
    startRun: (...a: never[]) => Promise<unknown>
    agents: Map<string, RunningAgent>
    queue: unknown[]
  }
  // A run that registers and then sits in `working`, holding its slot.
  inner.startRun = (async (_rt: unknown, runId: string) => {
    started.push(runId as string)
    const a = inner.agents.get(runId as string)
    if (a) a.state = { kind: 'working' }
    const { EventEmitter } = await import('node:events')
    const e = new EventEmitter() as unknown as Record<string, unknown>
    // Enough of an `AgentRun` for the manager to wire up and drive.
    e.run = async () => {}
    e.send = () => {}
    e.stop = () => {}
    e.interrupt = async () => {}
    e.clearQueue = () => 0
    e.answerPermission = () => false
    e.setPermissionMode = async () => false
    return e as never
  }) as never

  // Three sessions, a limit of ONE.
  const firstKey = await mgr.start('first')
  const secondKey = await mgr.start('second')
  await mgr.start('third')
  await new Promise((r) => setTimeout(r, 120))
  ok(started.length === 1, `a limit of 1 starts exactly one run (${started.length})`)
  ok(created === 1, `and creates exactly one worktree (${created})`)

  // A QUEUED run must have a card. It used to have none at all: `start()`
  // returned a run id without registering anything, so `list()` omitted it and
  // `byKey()` missed it — `followKey()` then failed both of its tests and
  // `getState()` cleared the selection, so a user who pressed send on a full
  // board was returned to the new-session screen with their prompt gone and no
  // card anywhere. It is the same absence that makes a subtask invisible until
  // it starts.
  ok(!!mgr.byKey(secondKey), 'a queued run is findable by its key')
  ok(mgr.list().some((a) => a.runId === secondKey), 'and appears in the list the board renders')
  const queued = mgr.byKey(secondKey)!
  ok(queued.state.kind === 'queued', `and says it is queued (${queued.state.kind})`)
  ok(queued.title === 'second', `carrying the title it was given (${queued.title})`)
  ok(queued.live.some((e) => e.kind === 'prompt' && e.text === 'second'),
     'and the prompt the user typed, so it is not lost')
  ok(!queued.worktreePath && !queued.branch,
     'with no worktree or branch, because it has neither yet')
  ok(mgr.activeCount === 1,
     `while still not consuming a concurrency slot (activeCount ${mgr.activeCount})`)
  void firstKey

  // Now the completion that fires TWO drains. Both runtimes call setState
  // before they emit `done`, so the `state` listener drains and then `finish()`
  // drains again — and the first drain is still suspended inside
  // `worktrees.create()` when the second one reads the count.
  const live = [...inner.agents.values()][0]!
  live.state = { kind: 'done', summary: 'x' }
  const drain = (mgr as unknown as { drain: () => Promise<void> }).drain.bind(mgr)
  await Promise.all([drain(), drain(), drain()])
  await new Promise((r) => setTimeout(r, 120))
  ok(started.length === 2,
     `three simultaneous drains past a finished run start ONE more, not several (${started.length})`)
  ok(created === 2, `and create one more worktree, not several (${created})`)

  // And teardown must not start anything. `halt()` drains because stopping one
  // agent has to release what was queued behind it — but `stopAll()` shares
  // `halt()`, and `halt()` only splices the queue by the halted run's own id.
  const beforeTeardown = started.length
  mgr.stopAll()
  await new Promise((r) => setTimeout(r, 120))
  ok(started.length === beforeTeardown,
     `tearing the host down starts NOTHING (${started.length - beforeTeardown} extra runs)`)
  ok(inner.agents.size === 0, 'and leaves no agent behind')
  ok(inner.queue.length === 0, 'and no queue for a late drain to find')

  // And a drain that arrives AFTER teardown must refuse. This is the case
  // clearing the queue does not cover: an agent that was mid-turn when the host
  // went away still emits `done` afterwards, and `finish()` drains. The latch
  // is what makes that a no-op instead of a fresh billed process against a
  // workspace that is being disposed.
  const afterTeardown = started.length
  inner.queue.push({ runId: 'run-late', prompt: 'late', opts: {} } as never)
  await drain()
  await new Promise((r) => setTimeout(r, 60))
  ok(started.length === afterTeardown,
     `a drain that arrives after teardown starts nothing (${started.length - afterTeardown} extra)`)
}

// `setDefaults` is a PATCH, and the second runtime depended on it.
//
// It was `this.opts.defaults = d` — a wholesale replacement of an object whose
// every member is optional, so a caller that did not mention a field erased it
// with no type error. Two of the five callers omitted `runtime`, and one of
// them is `ensureManager()`, which runs immediately before `start()` in
// `newSession` — so it erased whatever the composer chip had just set and every
// new session ran on Claude Code, while the chip, the settings page and
// `agentsKanban.runtime` all reported a choice that could never take effect.
{
  const mgr = new AgentManager({
    store: {} as never,
    worktrees: {} as never,
    board: DEFAULT_BOARD,
    defaults: { runtime: 'codex', model: 'gpt-5.5', effort: 'high' },
    permissionMode: 'acceptEdits',
    maxConcurrent: 3,
  })
  const defaults = () => (mgr as unknown as { opts: { defaults: Record<string, unknown> } }).opts.defaults
  // The exact call `ensureManager()` makes: everything EXCEPT runtime.
  mgr.setDefaults({ model: 'gpt-5.5', effort: 'high', thinking: undefined, ultracode: false, fastMode: false })
  ok(defaults().runtime === 'codex',
     `a patch that does not mention the runtime LEAVES it (${String(defaults().runtime)})`)
  // And clearing still works, but has to be said.
  mgr.setDefaults({ runtime: undefined })
  ok(defaults().runtime === undefined, 'and passing it explicitly as undefined still clears it')
  mgr.setDefaults({ runtime: 'claude' })
  ok(defaults().runtime === 'claude', 'and setting it works')
  ok(defaults().model === 'gpt-5.5', 'while the fields nobody mentioned are untouched')
}

// A finished turn must END its run, not just forget it.
//
// `finish()` deleted the entry from `this.sessions` and stopped there, on the
// stated grounds that the session was "still alive and still able to take a
// follow-up". That was unreachable — `send()` looks the session up in that same
// map, so once the entry is gone every follow-up takes the resume branch and
// spawns a fresh child, which DECISIONS.md documents as intended. Nothing was
// being kept; the child was abandoned. And `stop()` is the ONLY thing that ends
// the process, reached only from `halt()`, which looks it up in the map
// `finish()` had already cleared — so it was a no-op on every finished run.
// Ten messages to one card left nine idle CLI processes that neither Stop nor a
// window reload could reach.
{
  let stops = 0
  let bridgeDisposals = 0
  const mgr = new AgentManager({
    store: {
      get: async () => undefined,
      card: async () => ({ phase: 'planning', tags: [] }),
      patch: async () => {},
      transcript: async () => [],
      usage: async () => ({ costUsd: 0 }),
      adoptKey: async () => {},
      rename: async () => ({ renamed: true }),
    } as never,
    worktrees: {
      create: async (a: { taskId: string }) => ({ path: '/tmp/wt/' + a.taskId, branch: 'task/x', base: 'main' }),
      isClean: async () => true,
      aheadOf: async () => 0,
    } as never,
    board: DEFAULT_BOARD,
    defaults: {},
    permissionMode: 'acceptEdits',
    maxConcurrent: 3,
  })
  const inner = mgr as unknown as {
    startRun: (...a: never[]) => Promise<unknown>
    sessions: Map<string, unknown>
    bridges: Map<string, { dispose: () => void }>
  }
  let run: { emit: (e: string, ...a: unknown[]) => boolean } | undefined
  inner.startRun = (async (_rt: unknown, runId: string) => {
    const { EventEmitter } = await import('node:events')
    const e = new EventEmitter() as unknown as Record<string, unknown>
    e.run = async () => {}
    e.send = () => {}
    e.stop = () => { stops++ }
    e.interrupt = async () => {}
    e.clearQueue = () => 0
    e.answerPermission = () => false
    e.setPermissionMode = async () => false
    run = e as never
    // A bridge, as a stdio runtime would have.
    inner.bridges.set(runId, { dispose: () => { bridgeDisposals++ } })
    return e as never
  }) as never

  const runId = await mgr.start('do a thing')
  await new Promise((r) => setTimeout(r, 40))
  ok(stops === 0, 'a running turn is not stopped')
  run!.emit('done', 'All finished.', { kind: 'usd', spentUsd: 0.01, priced: true }, 0.01)
  await new Promise((r) => setTimeout(r, 40))
  ok(stops === 1, `a turn that ENDS stops its run, so the child process exits (${stops})`)
  ok(bridgeDisposals === 1, `and disposes its board-tool socket (${bridgeDisposals})`)
  ok(!inner.sessions.has(runId), 'and drops it from the live map')
  // Stopping the card afterwards must not double-stop or throw.
  mgr.stop(runId)
  ok(stops === 1, `stopping an already-finished card is a no-op, not a second stop (${stops})`)
}

// A queued run whose launch throws must SAY so. It used to be
// `catch { /* surfaced through state */ }` — and that comment was false for the
// only exception it can catch: `launch()`'s own try/catch is INSIDE `launch`,
// after the agent is registered, so anything thrown by `store.get()` or
// `worktrees.create()` escaped to a place with no card to put it on. The queue
// entry was already shifted off, so the run vanished with no error anywhere.
{
  const warnings: string[] = []
  const mgr = new AgentManager({
    store: { get: async () => undefined, patch: async () => {} } as never,
    worktrees: { create: async () => { throw new Error('fatal: a branch named task/x already exists') } } as never,
    board: DEFAULT_BOARD,
    defaults: {},
    permissionMode: 'acceptEdits',
    maxConcurrent: 3,
  })
  mgr.on('warning', (m: string) => warnings.push(m))
  await mgr.start('Add SSO to the admin app')
  await new Promise((r) => setTimeout(r, 60))
  ok(warnings.length === 1, `a run that cannot create its worktree reports it (${warnings.length})`)
  ok(/Add SSO/.test(warnings[0] ?? ''), `naming the session (${warnings[0]})`)
  ok(/already exists/.test(warnings[0] ?? ''), 'and the git error that caused it')
}

// --- splitting a task into subtasks ------------------------------------------
//
// Every one of these is a boundary in code, not a line in a tool description.
// The description tells the agent when splitting is a good idea; these decide
// whether it happens, because each subtask is a real Claude Code process with a
// real bill that nobody typed a prompt for.
{
  const card = { phase: 'planning', tags: [] as string[], parent: undefined as string | undefined }
  let children: string[] = []
  let clean = true
  let ahead = 0
  const startedWith: { prompt: string; opts: Record<string, unknown> }[] = []
  const patches: { key: string; patch: Record<string, unknown> }[] = []
  // The host-side approval gate. Settable, so the boundary can be tested in
  // both directions — an approval AND a refusal.
  let confirm: { asked: number; allow: boolean; saw?: { reason: string; n: number } } =
    { asked: 0, allow: true }

  const mgr = new AgentManager({
    store: {
      card: async () => card,
      childrenOf: async () => children,
      setTags: async () => {},
      patch: async (key: string, patch: Record<string, unknown>) => { patches.push({ key, patch }) },
    } as never,
    confirmSplit: async (_parent, subtasks, reason) => {
      confirm.asked++
      confirm.saw = { reason, n: subtasks.length }
      return confirm.allow
    },
    worktrees: {
      isClean: async () => clean,
      aheadOf: async () => ahead,
    } as never,
    board: DEFAULT_BOARD,
    defaults: {},
    permissionMode: 'acceptEdits',
    maxConcurrent: 3,
  })

  // A live parent, without launching a real agent. `split()` reads it through
  // byKey(); everything else it touches is faked above.
  const parent: RunningAgent = {
    runId: 'run-1', runtime: 'claude', sessionId: 'sess-parent', title: 'Do two things',
    state: { kind: 'working' }, worktreePath: '/tmp/wt/parent', branch: 'task/parent',
    base: 'main', live: [], history: [], contextTokens: 0, priorUsd: 0, startedAt: Date.now(),
  }
  const internals = mgr as unknown as {
    agents: Map<string, RunningAgent>
    start: (prompt: string, opts: Record<string, unknown>) => Promise<string>
  }
  internals.agents.set('run-1', parent)
  internals.start = async (prompt, opts) => {
    startedWith.push({ prompt, opts })
    const runId = `run-child-${startedWith.length}`
    internals.agents.set(runId, { ...parent, runId, branch: `task/${runId}` })
    return runId
  }

  const two = [
    { title: 'Add SSO', prompt: 'Add SSO to the login page.' },
    { title: 'Fix the flaky test', prompt: 'Fix the flaky snapshot test.' },
  ]

  // The happy path, and the branch decision it encodes.
  const done = await mgr.split('sess-parent', two)
  ok(done.ok === true, 'two unrelated subtasks are started')
  ok(startedWith.length === 2, `one agent per subtask (${startedWith.length})`)
  ok(startedWith.every((s) => s.opts.parent === 'sess-parent'),
     'each one records the session it was split out of')
  ok(startedWith.every((s) => s.opts.base === 'main'),
     'and forks from what the PARENT forked from, not from the parent branch — ' +
     'which is what keeps a subtask an ordinary task branch')
  ok(startedWith[0]!.prompt === two[0]!.prompt,
     'the subtask prompt is passed through whole: a fresh agent has no other context')

  // A child inherits the PARENT's agent program. `split()` passed no runtime at
  // all, so `launch()` fell through to the workspace default — and a Codex
  // objective's children ran on Claude whenever that was the default,
  // PERMANENTLY, because a session keeps the runtime it started on.
  ok(startedWith.every((s) => s.opts.runtime === 'claude'),
     `each subtask runs on the agent program its parent is on (${String(startedWith[0]!.opts.runtime)})`)

  // How many were APPROVED, written BEFORE the first child starts. Without it
  // the roll-up counts only the children that already have a card, and a
  // subtask queued behind maxConcurrentAgents has no sidecar entry at all.
  ok(patches.some((p) => p.key === 'sess-parent' && p.patch.fanout === 2),
     `the approved fan-out is recorded on the parent (${JSON.stringify(patches.map((p) => p.patch))})`)

  // The APPROVAL GATE, which has to be here and not in the permission list.
  // `ASKS_FIRST` excludes split_task by name, and that exclusion is not a
  // boundary: on Claude it routes through canUseTool, which session.ts skips
  // under `dontAsk` and `bypassPermissions`; on Codex the auto-allow list is
  // never read at all. So a card could fan out four billed agents with no click.
  ok(confirm.asked === 1, `the user is asked before any agent starts (${confirm.asked}x)`)
  ok(confirm.saw?.n === 2, 'and is told how many, so the number on the dialog is the number that runs')

  // The reason reaches the gate. Its own schema promises the user will see it,
  // and the tool handler used to call onSplit(subtasks) — dropping it entirely.
  const withReason = await mgr.split('sess-parent', two, 'These are two unrelated jobs.')
  ok(withReason.ok === true, 'a split with a reason still runs')
  ok(confirm.saw?.reason === 'These are two unrelated jobs.',
     `the agent's own sentence reaches the approval, rather than being dropped (${confirm.saw?.reason})`)

  // A refusal must STOP it, and say something the agent can act on.
  confirm = { asked: 0, allow: false }
  const before = startedWith.length
  const declined = await mgr.split('sess-parent', two, 'because')
  ok(declined.ok === false, 'declining the dialog refuses the split')
  ok(startedWith.length === before, `and starts NOTHING (${startedWith.length - before} extra agents)`)
  ok(declined.ok === false && /declined/.test(declined.message),
     `and tells the agent why, so it does the work itself (${declined.ok === false ? declined.message : ''})`)
  confirm = { asked: 0, allow: true }

  // Re-checked AFTER the await. The dialog is modal and the user can sit on it;
  // in that window the parent's turn can end or another trigger can fan the
  // same card out, and either makes the approved proposal unsound.
  {
    const raced = new AgentManager({
      store: {
        card: async () => card,
        childrenOf: async () => children,
        setTags: async () => {},
        patch: async () => {},
      } as never,
      worktrees: { isClean: async () => true, aheadOf: async () => 0 } as never,
      board: DEFAULT_BOARD,
      defaults: {},
      permissionMode: 'acceptEdits',
      maxConcurrent: 3,
      // The children appear WHILE the dialog is open, exactly as a concurrent
      // trigger would make them.
      confirmSplit: async () => { children = ['run-child-9']; return true },
    })
    const inner = raced as unknown as {
      agents: Map<string, RunningAgent>
      start: (p: string, o: Record<string, unknown>) => Promise<string>
    }
    let startedDuringRace = 0
    inner.agents.set('run-1', parent)
    inner.start = async () => { startedDuringRace++; return 'run-x' }
    const lost = await raced.split('sess-parent', two, 'r')
    ok(lost.ok === false && /already split/.test(lost.message),
       `a split that happened while the dialog was open is not repeated (${lost.ok === false ? lost.message : 'it ran'})`)
    ok(startedDuringRace === 0, `and no second set of agents is started (${startedDuringRace})`)
    children = []
  }

  // Split once. A second split while the first is running is an agent that has
  // lost track of what it already did.
  children = ['run-child-1', 'run-child-2']
  const again = await mgr.split('sess-parent', two)
  ok(again.ok === false && /already been split/.test(again.message),
     'a session that already has subtasks cannot split again')
  children = []

  // One level deep. A subtask that can split is a fork bomb with a credit card.
  card.parent = 'sess-grandparent'
  const nested = await mgr.split('sess-parent', two)
  ok(nested.ok === false && /itself a subtask/.test(nested.message),
     'a subtask cannot split again — the depth limit is code, not advice')
  card.parent = undefined

  // The check the whole branch model rests on.
  clean = false
  const dirty = await mgr.split('sess-parent', two)
  ok(dirty.ok === false && /uncommitted/.test(dirty.message),
     'a session that has already changed something cannot split, or that work is stranded')
  clean = true

  ahead = 2
  const committed = await mgr.split('sess-parent', two)
  ok(committed.ok === false && /commits/.test(committed.message),
     'and neither can one that has already committed')
  ahead = 0

  // Counting.
  const one = await mgr.split('sess-parent', [two[0]!])
  ok(one.ok === false && /at least two/.test(one.message), 'splitting into one is not a split')
  const blank = await mgr.split('sess-parent', [
    { title: '  ', prompt: 'x' }, { title: 'ok', prompt: '   ' }, two[0]!,
  ])
  ok(blank.ok === false, 'a subtask with no title or no prompt does not count towards the two')
  const many = await mgr.split('sess-parent', Array.from({ length: MAX_SUBTASKS + 1 },
    (_, i) => ({ title: `t${i}`, prompt: `p${i}` })))
  ok(many.ok === false && new RegExp(String(MAX_SUBTASKS)).test(many.message),
     `more than ${MAX_SUBTASKS} subtasks is refused, and the limit is named`)

  const unknown = await mgr.split('not-a-session', two)
  ok(unknown.ok === false, 'a session that is not running cannot start subtasks')
}

// The brief has to mention splitting, or the agent never considers it — and has
// to say when NOT to, or it splits work that has to be done in one place.
{
  const b = buildBrief(DEFAULT_BOARD, 'Do two things', 'task/x')
  ok(b.includes('split_task'), 'the brief names the split tool')
  ok(/unrelated/i.test(b), 'and the condition that justifies it')
  ok(/before you change anything/i.test(b), 'and that it has to happen before any edits')
}

// --- the tools' side of a run is actually wired up ---------------------------
//
// The seam a mutation test found open: `set_title` existed, was auto-allowed and
// was unit-tested, and NOTHING failed when the manager did not pass `onRename`
// into the board server. Every optional callback on BoardToolContext degrades
// silently — the tool answers "this session cannot be renamed from here" and the
// agent carries on — which is the same failure as the auto-allow list that
// drifted and left agents unable to move their own cards. So the wiring is
// asserted here, and the assertion is about the CONTEXT the manager builds, not
// about a tool in isolation.
{
  const renamed: { id: string; title: string }[] = []
  const mgr = new AgentManager({
    store: {
      rename: async (id: string, title: string) => { renamed.push({ id, title }) },
    } as never,
    worktrees: {} as never,
    board: DEFAULT_BOARD,
    defaults: {},
    permissionMode: 'acceptEdits',
    maxConcurrent: 3,
  })
  const internals = mgr as unknown as {
    boardContext: (a: RunningAgent) => Record<string, unknown>
  }
  const agent: RunningAgent = {
    runId: 'run-7-abc', runtime: 'claude', title: 'Okay.',
    state: { kind: 'working' }, worktreePath: '/tmp/wt', branch: 'task/run-7-abc',
    live: [], history: [], contextTokens: 0, priorUsd: 0, startedAt: Date.now(),
  }
  const ctx = internals.boardContext(agent)
  for (const cb of ['onChanged', 'onNotice', 'onRename', 'onSplit']) {
    ok(typeof ctx[cb] === 'function', `the run's board context wires ${cb}`)
  }

  // Renaming before Claude Code has assigned a session id: the card must follow
  // immediately, and nothing may be written under the run id — there is no
  // session file with that name to rename.
  await (ctx.onRename as (t: string) => Promise<void>)('Name the cards properly')
  ok(agent.title === 'Name the cards properly', 'a rename lands on the live card at once')
  ok(renamed.length === 0, 'and writes nothing while the session id is still a run id')

  agent.sessionId = 'sess-9'
  await (ctx.onRename as (t: string) => Promise<void>)('Name the cards properly, again')
  ok(renamed.length === 1 && renamed[0]!.id === 'sess-9', 'once there is a session id, the rename is persisted')
  ok(renamed[0]!.title === 'Name the cards properly, again', 'with the title the agent chose')
}

// --- the environment a spawned CLI is given ----------------------------------
//
// Found by running a real agent, and only because the collision guard above
// fired. Launch VS Code from a terminal that is already inside Claude Code —
// which is how someone who wants a Claude kanban board works — and
// CLAUDE_CODE_SESSION_ID is in the environment. It was being spread into every
// agent, so every agent reported its HOST's session id. Observed: all three
// runs from one split claiming the id of the terminal that launched them, and
// two of the three left with no persisted transcript.
{
  const env = agentEnv({
    PATH: '/usr/bin',
    HOME: '/home/dev',
    ANTHROPIC_API_KEY: 'sk-secret',
    HTTPS_PROXY: 'http://proxy:8080',
    CLAUDE_CODE_SESSION_ID: 'the-hosts-own-session',
    CLAUDE_PID: '1234',
    CLAUDECODE: '1',
    UNSET: undefined,
  })
  ok(env.CLAUDE_CODE_SESSION_ID === undefined,
     "the host's session id is not handed to the session it starts")
  ok(env.CLAUDE_PID === undefined, 'nor its process id')
  for (const v of HOST_SESSION_VARS) ok(env[v] === undefined, `${v} is dropped`)

  // The other half, and the reason this is a named list rather than a CLAUDE_*
  // sweep: almost everything else under that prefix is configuration the user
  // means to inherit, and dropping credentials or a proxy would break the run
  // outright while looking like a network problem.
  ok(env.ANTHROPIC_API_KEY === 'sk-secret', 'credentials still reach the CLI')
  ok(env.HTTPS_PROXY === 'http://proxy:8080', 'and so does the proxy configuration')
  ok(env.PATH === '/usr/bin' && env.HOME === '/home/dev', 'and the ordinary environment')
  ok(!('UNSET' in env), 'an unset variable is not passed through as the string "undefined"')

  // The self-update guard predates this and must survive the rewrite: the CLI
  // updating itself mid-run corrupts the binary underneath the session.
  ok(env.DISABLE_AUTOUPDATER === '1' && env.DISABLE_UPDATES === '1',
     'the CLI is still stopped from updating itself mid-run')

  // Per-session overrides win, because that is what they are for.
  ok(agentEnv({ FOO: 'a' }, { FOO: 'b' }).FOO === 'b', 'an explicit override beats the inherited value')
}

// --- what a killed run leaves behind ----------------------------------------
//
// A run is marked running on disk while it works and unmarked when it ends, so
// a mark still there at the next launch means the extension host went away
// mid-turn. The whole feature hangs on ONE distinction that nothing in the type
// system can protect:
//
//   stop(key)  the user decided. Clear the mark, or the next launch accuses the
//              editor of cutting off a run they stopped on purpose.
//   stopAll()  the host is going away. Do NOT clear it. This IS the event.
//
// Get it backwards and the feature silently does nothing at all: every restart
// erases its own evidence on the way out.
{
  const patched: { key: string; running?: number }[] = []
  const mgr = new AgentManager({
    store: {
      patch: async (key: string, p: { running?: number }) => { patched.push({ key, ...p }) },
    } as never,
    worktrees: {} as never,
    board: DEFAULT_BOARD,
    defaults: {},
    permissionMode: 'acceptEdits',
    maxConcurrent: 3,
  })
  const internals = mgr as unknown as { agents: Map<string, RunningAgent> }
  const running = (runId: string, sessionId: string): RunningAgent => ({
    runId, runtime: 'claude', sessionId, title: runId,
    state: { kind: 'working' }, worktreePath: '/tmp/wt/' + runId, branch: 'task/' + runId,
    live: [], history: [], contextTokens: 0, priorUsd: 0, startedAt: Date.now(),
  })

  internals.agents.set('r1', running('r1', 'sess-1'))
  mgr.stop('sess-1')
  await new Promise((r) => setImmediate(r))
  ok(patched.some((p) => p.key === 'sess-1' && p.running === 0),
     'a deliberate stop clears the running mark')
  ok(patched.every((p) => p.running !== undefined),
     'and clears it with 0, because a patch drops undefined and the mark would survive')

  patched.length = 0
  internals.agents.set('r2', running('r2', 'sess-2'))
  internals.agents.set('r3', running('r3', 'sess-3'))
  mgr.stopAll()
  await new Promise((r) => setImmediate(r))
  ok(patched.length === 0,
     `the host going away leaves every mark in place — that is the whole signal (${JSON.stringify(patched)})`)
  ok(internals.agents.size === 0, 'while still tearing every run down')
}

// --- what a session persists when it becomes durable ------------------------
//
// This object was built inline inside `launch()`, where no test could see it,
// and that is how `runtime` came to be PARSED from the day it was added and
// written by nothing at all. The consequence was not cosmetic:
// `store.runtimeOf()` reads it to choose which runtime's history reader to use,
// so every finished Codex session's transcript, usage and meter went to the
// Claude parser — a different store, in a different format, returning nothing.
{
  const patch = durablePatch({
    startedPhase: 'implementing',
    runtime: 'codex',
    worktree: { path: '/tmp/wt/x', branch: 'task/x', base: 'main' },
    startedAt: 1_700_000_000_000,
    parent: 'sess-parent',
  })
  ok(patch.runtime === 'codex',
     `the agent program is persisted, so a restart routes to the right transcript store (${patch.runtime})`)
  ok(patch.worktree === '/tmp/wt/x' && patch.branch === 'task/x' && patch.base === 'main',
     'with the worktree, its branch, and the base every diff and merge is against')
  ok(patch.running === 1_700_000_000_000,
     'and the running mark as a TIMESTAMP, so a mark still there at startup dates the interruption')
  ok(patch.parent === 'sess-parent', 'a subtask records the session it was split out of')

  // Every field that the reader parses must be produced here. That symmetry is
  // the actual guard: it is what neither half of the `runtime` bug had.
  const noParent = durablePatch({
    runtime: 'claude',
    worktree: { path: '/w', branch: 'b' },
    startedAt: 1,
  })
  ok(noParent.parent === undefined, 'a top-level session names no parent')
  ok(noParent.base === undefined, 'and a worktree with no recorded base does not invent one')
  ok(noParent.phase === 'implementing', 'a board with no started column still lands somewhere real')
}

// --- the Meter, off an untyped boundary --------------------------------------
//
// `parseMeter` exists because `EventEmitter.on()` is untyped and two runtimes
// disagreed about the `done` payload for the whole life of the declared
// contract: one emitted a `Meter`, the other a bare `number`, the listener said
// `costUsd?: number`, and `media/board.js` called `.toFixed(2)` on the result —
// a throw inside `render()`, which is a silently blank panel.
ok(parseMeter({ kind: 'usd', spentUsd: 1.5, priced: true })?.kind === 'usd', 'a usd meter parses')
ok(parseMeter({ kind: 'usd', spentUsd: 0 })?.kind === 'usd', 'zero dollars is a real reading')
// The bug's actual payload shape, in both directions.
ok(parseMeter(4.2) === undefined, 'a BARE NUMBER is not a meter — this is the shape that shipped')
ok(parseMeter({ kind: 'usd' }) === undefined, 'a usd meter with no figure is refused')
ok(parseMeter({ kind: 'usd', spentUsd: '1.5' }) === undefined, 'and so is a stringified one')
for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
  ok(parseMeter({ kind: 'usd', spentUsd: bad }) === undefined, `a spend of ${bad} is refused, not rendered`)
}
// `priced` defaults to true on absence but an explicit false must SURVIVE: it
// is what turns the readout into a floor rather than a total.
const floor = parseMeter({ kind: 'usd', spentUsd: 1, priced: false })
ok(floor?.kind === 'usd' && floor.priced === false,
   'an explicit priced:false survives — it is what makes the readout a floor')
const whole = parseMeter({ kind: 'usd', spentUsd: 1 })
ok(whole?.kind === 'usd' && whole.priced === true, 'and absence means priced')

const plan = parseMeter({ kind: 'plan', usedPercent: 13, windowMinutes: 300, plan: 'plus', resetsAt: 1778984752 })
ok(plan?.kind === 'plan' && plan.usedPercent === 13 && plan.windowMinutes === 300,
   'a plan meter parses with its window')
ok(plan?.kind === 'plan' && plan.resetsAt === 1778984752, 'and keeps the reset time, which is the actionable half')
ok(parseMeter({ kind: 'plan', usedPercent: 13 }) === undefined,
   'a plan meter with no window is refused — a percentage of nothing cannot be shown')
const secondary = parseMeter({
  kind: 'plan', usedPercent: 13, windowMinutes: 300,
  secondary: { usedPercent: 2, windowMinutes: 10080 },
})
ok(secondary?.kind === 'plan' && secondary.secondary?.windowMinutes === 10080, 'a secondary window comes through')
ok(parseMeter({
  kind: 'plan', usedPercent: 13, windowMinutes: 300, secondary: { usedPercent: 2 },
})?.kind === 'plan', 'and a malformed secondary drops the secondary rather than the whole reading')

ok(parseMeter({ kind: 'unknown' })?.kind === 'unknown', '"unknown" is a first-class reading')
// The one thing it must NOT do. `unknown` is a reading that says the runtime
// does not know; minting one from a protocol fault would turn a shape we could
// not read into a number the board displays as measured.
for (const bad of [undefined, null, 'x', {}, { kind: 'martian' }, []]) {
  ok(parseMeter(bad) === undefined, `${JSON.stringify(bad) ?? 'undefined'} is no reading at all, not "unknown"`)
}

console.log(fails === 0 ? 'PASS — run identity, subtask boundaries, the meter contract and the agent brief hold' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
