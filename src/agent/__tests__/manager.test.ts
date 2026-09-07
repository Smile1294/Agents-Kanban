/* AgentManager's bookkeeping, without launching a real agent.

   The interesting behaviour here is identity: a run starts keyed by a local
   runId and adopts Claude Code's session id moments later, and the board has to
   show it correctly throughout. Both halves of that have failure modes that are
   completely silent. */
import {
  AgentManager, durablePatch, MAX_SUBTASKS, titleFrom, buildBrief, launchSettings,
  type RunningAgent,
} from '../manager.ts'
import { agentKeyOf, type SpawnCatalogue } from '../routing.ts'
import { agentEnv, HOST_SESSION_VARS } from '../session.ts'
import { DEFAULT_BOARD } from '../../board/config.ts'
import { ORCHESTRATION_LEVELS, policyFor } from '../../board/decomposition.ts'
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
// Knowledge files move with the code — but only where there is a codemap. On
// any other repository the paragraph would describe a refusal that cannot happen.
ok(!brief.includes('docs/codemap'), 'a repository without a codemap is told nothing about knowledge files')
{
  const mapped = buildBrief(DEFAULT_BOARD, 'Fix login', 'task/S1-fix', undefined, true, undefined, true)
  ok(mapped.includes('docs/codemap/README.md') && mapped.includes('REFUSED'),
     'with a codemap, the brief names the map and says the review move is refused without the update')
}

// The brief LOSES to a slash command unless it says so.
//
// Real case: a project's own `/jira-task` command runs a long procedure whose
// last step is "Then STOP. A human reviews and merges." The agent obeyed the
// specific, procedural terminal step and treated moving its card as extra work
// it had been told not to do — so the card sat in Implementing with the work
// finished, and the user never got the test plan that reaching a review column
// is supposed to produce. The brief is `appendSystemPrompt` and was present the
// whole time; being present is not the same as outranking.
// Matched on the whole claim, not on words that already appear elsewhere in the
// brief ("then stop", "split BEFORE you change anything") — a loose regex here
// passed against the unfixed brief and proved nothing.
ok(/tells you to stop, call `set_phase` first/i.test(brief),
   'the brief says to move the card BEFORE stopping, whatever told it to stop')
ok(brief.includes('how a run ENDS'),
   'and frames the move as part of ending, not as more work that can be skipped')

// --- the level reaches the agent, and only through the brief ----------------
//
// The dial's ENTIRE mechanism is which disposition sentence the brief carries.
// If two paragraphs both told the agent how eagerly to split, the longer and
// more specific one would win, the dial would move nothing, and every unit test
// here would stay green — so the aim sentence must REPLACE the old paragraph,
// not sit beside it.
{
  const briefs = ORCHESTRATION_LEVELS.map((l) => buildBrief(DEFAULT_BOARD, 'T', 'task/x', policyFor(l)))
  ok(new Set(briefs).size === briefs.length, 'each level produces a different brief')
  for (const [i, b] of briefs.entries()) {
    // ONE paragraph sets the disposition. Counting the phrases that could:
    const dispositions = [
      /STRONGLY PREFER doing this yourself/.test(b),
      /Splitting readily is/.test(b),
      /If what you have been asked for is really two or more UNRELATED/.test(b),
    ].filter(Boolean).length
    ok(dispositions === 1,
       `${ORCHESTRATION_LEVELS[i]}: exactly one paragraph tells the agent how eagerly to split (${dispositions})`)
    // …while the OPERATIONAL half is invariant, because forking from base is a
    // fact about the branch model rather than a preference.
    ok(b.includes('Split BEFORE you change anything'), `${ORCHESTRATION_LEVELS[i]}: still says to split before editing`)
    ok(b.includes('scope'), `${ORCHESTRATION_LEVELS[i]}: still asks for a declared scope`)
  }
}
// A subtask may not split again — `split()` refuses it on `card.parent` — so
// telling it how eagerly to split would be inviting it to call a tool that can
// only ever answer no.
{
  const child = buildBrief(DEFAULT_BOARD, 'T', 'task/x', policyFor('maximum'), false)
  ok(!child.includes('split_task'), 'a session that cannot split is not told how eagerly to')
  ok(child.includes('set_phase'), 'while still being told everything else it owns')
}

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

  // `scope` is required now: a subtask with no files of its own is not a
  // separate subtask, and the declaration is what lets the board say afterwards
  // whether the split was right.
  const two = [
    { title: 'Add SSO', prompt: 'Add SSO to the login page.', scope: ['src/auth/'] },
    { title: 'Fix the flaky test', prompt: 'Fix the flaky snapshot test.', scope: ['tests/snapshot.test.ts'] },
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
    { title: '  ', prompt: 'x', scope: ['a'] }, { title: 'ok', prompt: '   ', scope: ['b'] }, two[0]!,
  ])
  ok(blank.ok === false, 'a subtask with no title or no prompt does not count towards the two')
  // The effective limit is `min(level's cap, MAX_SUBTASKS)`, and the refusal
  // names the number that actually applied — not the constant. At the default
  // level that is 3; a message saying 4 would send the agent back to propose
  // four and be refused again.
  const many = await mgr.split('sess-parent', Array.from({ length: MAX_SUBTASKS + 1 },
    (_, i) => ({ title: `t${i}`, prompt: `p${i}`, scope: [`src/${i}/`] })))
  ok(many.ok === false && /limit here is 3/.test(many.message),
     `over the cap is refused, naming the limit that applied (${many.ok === false ? many.message : 'it ran'})`)
  ok(many.ok === false && /5/.test(many.message),
     'and how many were asked for, so the gap is visible')

  // At Maximum the same proposal is still refused — MAX_SUBTASKS is the one
  // real cap and the level can only ever ask for LESS than it.
  parent.orchestration = 'maximum'
  const manyAtMax = await mgr.split('sess-parent', Array.from({ length: MAX_SUBTASKS + 1 },
    (_, i) => ({ title: `t${i}`, prompt: `p${i}`, scope: [`src/${i}/`] })))
  ok(manyAtMax.ok === false && new RegExp(String(MAX_SUBTASKS)).test(manyAtMax.message),
     `and at Maximum the cap is still ${MAX_SUBTASKS}, which no level can raise`)
  // …while four, which Balanced refuses, is allowed at Maximum. That is the
  // dial doing the one thing it is allowed to do: ask for more.
  const fourAtMax = await mgr.split('sess-parent', Array.from({ length: MAX_SUBTASKS },
    (_, i) => ({ title: `t${i}`, prompt: `p${i}`, scope: [`src/${i}/`] })))
  ok(fourAtMax.ok === true, `four subtasks run at Maximum (${fourAtMax.ok ? 'yes' : fourAtMax.message})`)
  children = []
  parent.orchestration = undefined

  const unknown = await mgr.split('not-a-session', two)
  ok(unknown.ok === false, 'a session that is not running cannot start subtasks')
}

// --- the spawn-model allowlist ----------------------------------------------
//
// A subtask spec may name a `model`, and that id starts a process with a real
// bill — so it is gated here, in code, before the user is asked to approve
// anything. The tool description can only name the allowed set; this is the
// fence, and the only one.
//
// Expressed through the spawn CATALOGUE now, which is the same policy with the
// backend attached: a flat list of ids could only ever be checked against one
// catalogue, so a piece routed elsewhere had its model validated against the
// wrong backend's list. Every assertion below is the one it always was.
{
  const flatCatalogue = (models: () => string[]) => (): SpawnCatalogue => {
    const ids = models()
    return {
      // The parent in these fixtures records no backend, so its key is
      // `claude|` — and an agent with no allowed model is OMITTED, which is
      // what makes an empty allowlist an empty catalogue.
      agents: ids.length
        ? [{
            slug: 'claude', key: agentKeyOf('claude', ''), label: 'Claude Code',
            runtime: 'claude', provider: '', known: true,
            models: ids.map((id) => ({ id, efforts: [] })),
          }]
        : [],
    }
  }
  const makeGated = (spawnModels: () => string[], defaults: Record<string, unknown> = {}) => {
    const startedWith: { opts: Record<string, unknown> }[] = []
    const patches: { patch: Record<string, unknown> }[] = []
    let asked = 0
    const g = new AgentManager({
      store: {
        card: async () => ({ phase: 'planning', tags: [], parent: undefined }),
        childrenOf: async () => [],
        setTags: async () => {},
        patch: async (_key: string, patch: Record<string, unknown>) => { patches.push({ patch }) },
      } as never,
      confirmSplit: async () => { asked++; return true },
      worktrees: { isClean: async () => true, aheadOf: async () => 0 } as never,
      board: DEFAULT_BOARD,
      defaults,
      permissionMode: 'acceptEdits',
      maxConcurrent: 3,
      ...(spawnModels ? { spawnCatalogue: flatCatalogue(spawnModels) } : {}),
    })
    const inner = g as unknown as {
      agents: Map<string, RunningAgent>
      start: (prompt: string, opts: Record<string, unknown>) => Promise<string>
    }
    inner.agents.set('run-1', {
      runId: 'run-1', runtime: 'claude', sessionId: 'sess-parent', title: 'Split me',
      state: { kind: 'working' }, worktreePath: '/tmp/wt/p', branch: 'task/p', base: 'main',
      live: [], history: [], contextTokens: 0, priorUsd: 0, startedAt: Date.now(),
    })
    inner.start = async (_p, opts) => {
      startedWith.push({ opts })
      return `run-child-${startedWith.length}`
    }
    return { g, startedWith, patches, asked: () => asked }
  }
  const specs = (over: Record<string, unknown>[] = [{}, {}]) => [
    { title: 'One', prompt: 'Do one.', scope: ['src/a/'], ...over[0] },
    { title: 'Two', prompt: 'Do two.', scope: ['src/b/'], ...over[1] },
  ]

  // An allowed model is accepted, and it travels as `chosen` — the same path a
  // resumed session uses, so the card and the runtime are handed one value.
  {
    const { g, startedWith } = makeGated(() => ['deepseek-chat', 'opus-5'])
    const r = await g.split('sess-parent', specs([{ model: 'deepseek-chat' }, { model: 'opus-5' }]))
    ok(r.ok === true, `naming allowed models runs the split (${r.ok ? 'yes' : r.message})`)
    const chosen0 = startedWith[0]?.opts.chosen as { model?: string } | undefined
    const chosen1 = startedWith[1]?.opts.chosen as { model?: string } | undefined
    ok(chosen0?.model === 'deepseek-chat',
       'the chosen model reaches start() as chosen.model')
    ok(chosen1?.model === 'opus-5',
       'for every subtask, not just the first')
  }

  // A disallowed model is refused BEFORE the approval modal — the user is never
  // asked to approve a plan the host already knows it will refuse — and the
  // refusal names the allowed set, because that is the only way the agent can
  // re-propose something the gate will accept.
  {
    const { g, startedWith, patches, asked } = makeGated(() => ['deepseek-chat'])
    const r = await g.split('sess-parent', specs([{ model: 'opus-5' }]))
    ok(r.ok === false, 'a model outside the allowlist is refused')
    ok(r.ok === false && /deepseek-chat/.test(r.message),
       `and the refusal names what IS allowed (${r.ok === false ? r.message : 'it ran'})`)
    ok(r.ok === false && /opus-5/.test(r.message),
       'and the model that was asked for, so the gap is visible')
    ok(startedWith.length === 0, `and starts NOTHING (${startedWith.length})`)
    ok(asked() === 0, 'without ever opening the approval dialog')
    ok(patches.some((p) => p.patch.decomposition && (p.patch.decomposition as { rule?: string }).rule === 'spawn-model'),
       'and records the refusal, so a session that then did the work alone does not look adaptive')
  }

  // The EFFECTIVE model is gated, not just the named one: a spec that names
  // nothing inherits the default for new sessions, and unticking that default
  // is the user saying "not even on my default".
  {
    const { g, startedWith } = makeGated(() => ['deepseek-chat'], { model: 'opus-5' })
    const r = await g.split('sess-parent', specs())
    ok(r.ok === false, 'a split that would run on the disallowed DEFAULT is refused')
    ok(r.ok === false && /default for new sessions/.test(r.message),
       `and says the default is what it would have run on (${r.ok === false ? r.message : 'it ran'})`)
    ok(startedWith.length === 0, `and starts NOTHING (${startedWith.length})`)
  }

  // No name and no explicit default is the pre-policy behaviour, untouched: the
  // gate can only compare what it knows, and inventing a refusal for a model
  // the runtime has not chosen yet would break every ordinary split.
  {
    const { g, startedWith } = makeGated(() => ['deepseek-chat'])
    const r = await g.split('sess-parent', specs())
    ok(r.ok === true && startedWith.length === 2,
       `a split naming nothing, with no default set, still runs (${r.ok ? 'yes' : r.message})`)
  }

  // An EMPTY allowed set is the user having unticked every model: no spawned
  // agent is sanctioned, so every split is refused — even one that names
  // nothing at all.
  {
    const { g, startedWith } = makeGated(() => [])
    const r = await g.split('sess-parent', specs([{ model: 'opus-5' }]))
    ok(r.ok === false && /no model is allowed/i.test(r.message),
       `an empty allowlist refuses the split outright (${r.ok === false ? r.message : 'it ran'})`)
    ok(startedWith.length === 0, `and starts NOTHING (${startedWith.length})`)
    const r2 = await g.split('sess-parent', specs())
    ok(r2.ok === false, 'even one that names no model at all')
  }

  // No policy supplied — a host too old, or the unit tests above — is no gate,
  // which is the behaviour every existing split test depends on.
  {
    const { g, startedWith } = makeGated(undefined as never)
    const r = await g.split('sess-parent', specs([{ model: 'claude-from-the-future' }]))
    ok(r.ok === true, 'with no allowlist supplied, a named model is not gated')
    ok(startedWith.length === 2, 'and the split runs as it always did')
  }
}
{
  const b = buildBrief(DEFAULT_BOARD, 'Do two things', 'task/x')
  ok(b.includes('split_task'), 'the brief names the split tool')
  ok(/unrelated/i.test(b), 'and the condition that justifies it')
  ok(/before you change anything/i.test(b), 'and that it has to happen before any edits')
  // The spawn allowlist, named in the same paragraph. The brief is baked at
  // launch; the gate re-reads the policy at split time, so this sentence can
  // only ever be a stale but honest answer, never a wrong one that passes.
  const oneAgent = [{
    slug: 'deepseek', key: 'claude|dsk', label: 'DeepSeek',
    runtime: 'claude' as const, provider: 'dsk', known: true,
    models: [{ id: 'deepseek-reasoner', efforts: [] }],
  }]
  const routed = buildBrief(DEFAULT_BOARD, 'T', 'task/x', undefined, true, oneAgent)
  ok(routed.includes('Spawned agents may only run on'),
     'with a catalogue, the brief names what a spawned agent may run on')
  ok(routed.includes('deepseek') && routed.includes('deepseek-reasoner'),
     'by short name AND by the models it serves — the two halves of one question')
  ok(/names neither runs on this/.test(routed),
     'and says what naming nothing means, since that is the default every piece takes')
  ok(buildBrief(DEFAULT_BOARD, 'T', 'task/x', undefined, true, [])
    .includes('will be refused'),
  'and an empty allowlist says splitting will be refused rather than inviting a doomed call')
  ok(!buildBrief(DEFAULT_BOARD, 'T', 'task/x').includes('Spawned agents'),
     'without an allowlist the brief says nothing about models')
  ok(!buildBrief(DEFAULT_BOARD, 'T', 'task/x', undefined, false, oneAgent).includes('Spawned agents'),
     'and a session that cannot split is not told about spawn models either')
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
  for (const cb of ['onChanged', 'onNotice', 'onRename', 'onSplit', 'knowledgeCheck']) {
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



// --- routing a split across agents, backends and models ----------------------
//
// The feature: one objective session fanning out into subtasks that run on
// DIFFERENT agent programs and DIFFERENT backends. And the bug underneath it:
// `split()` passed the parent's RUNTIME to every child and said nothing about
// its BACKEND, so `launch()` fell through to the workspace's ACTIVE profile —
// a session that had been on DeepSeek all morning produced children on
// Anthropic, with a different bill, silently.
{
  const card = { phase: 'planning', tags: [] as string[], parent: undefined as string | undefined }
  const startedWith: { prompt: string; opts: Record<string, unknown> }[] = []
  const patches: { key: string; patch: Record<string, unknown> }[] = []
  const resolved: string[] = []

  const catalogue: SpawnCatalogue = {
    agents: [
      {
        slug: 'claude', key: 'claude|inherit', label: 'Claude Code',
        runtime: 'claude', provider: 'inherit', known: true,
        models: [{ id: 'claude-fable-5-1', efforts: ['low', 'high', 'max'] },
                 { id: 'claude-opus-5', efforts: ['low', 'high', 'max'] }],
      },
      {
        slug: 'deepseek', key: 'claude|dsk', label: 'DeepSeek',
        runtime: 'claude', provider: 'dsk', known: true,
        models: [{ id: 'deepseek-reasoner', efforts: [] }],
      },
      {
        slug: 'codex', key: 'codex|', label: 'Codex',
        runtime: 'codex', provider: '', known: true,
        models: [{ id: 'gpt-5.5-codex', efforts: ['low', 'medium', 'high'] }],
      },
    ],
  }

  const mgr = new AgentManager({
    store: {
      card: async () => card,
      childrenOf: async () => [],
      setTags: async () => {},
      patch: async (key: string, patch: Record<string, unknown>) => { patches.push({ key, patch }) },
    } as never,
    confirmSplit: async () => true,
    worktrees: { isClean: async () => true, aheadOf: async () => 0 } as never,
    board: DEFAULT_BOARD,
    defaults: { model: 'deepseek-reasoner' },
    permissionMode: 'acceptEdits',
    maxConcurrent: 3,
    spawnCatalogue: () => catalogue,
    // The host's half: a profile id becomes an actual environment patch, which
    // needs SecretStorage and therefore cannot live in the manager.
    resolveProvider: async (id: string) => {
      resolved.push(id)
      return { profile: { id, label: id, kind: 'gateway' }, env: { set: { X: id }, clear: [] } } as never
    },
  })

  // The parent is on DeepSeek — NOT on the workspace's active profile.
  const parent: RunningAgent = {
    runId: 'run-1', runtime: 'claude', sessionId: 'sess-parent', title: 'Two backends',
    provider: 'dsk',
    state: { kind: 'working' }, worktreePath: '/tmp/wt/p', branch: 'task/p',
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
  const reset = () => { startedWith.length = 0; patches.length = 0; resolved.length = 0 }
  const piece = (extra: Record<string, unknown>) =>
    ({ title: `T${Math.random()}`, prompt: 'Do the thing.', scope: ['src/a/'], ...extra })

  // THE BUG. Neither piece names an agent, so both inherit the parent's whole
  // agent: runtime AND backend.
  {
    const v = await mgr.split('sess-parent', [piece({}), piece({ scope: ['src/b/'] })])
    ok(v.ok === true, 'a split with no routing at all still runs')
    ok(startedWith.every((s) => s.opts.runtime === 'claude'), 'each child keeps the parent runtime')
    ok(startedWith.every((s) => {
      const pf = s.opts.providerFor as { profile?: { id?: string } } | undefined
      return pf?.profile?.id === 'dsk'
    }), `and the parent BACKEND, resolved by the host (${JSON.stringify(startedWith[0]?.opts.providerFor)})`)
    ok(resolved.includes('dsk'), 'which means the host was asked for that profile, not the active one')
    reset()
  }

  // Routing to another RUNTIME. A ChatGPT-subscription session is Codex, and
  // Codex has no backend of its own, so no profile is resolved for it.
  {
    const v = await mgr.split('sess-parent', [
      piece({ agent: 'codex', model: 'gpt-5.5-codex', effort: 'high' }),
      piece({ scope: ['src/b/'] }),
    ])
    ok(v.ok === true, 'a piece may be routed to a different agent program')
    const child = startedWith.find((s) => s.opts.runtime === 'codex')
    ok(!!child, `one child runs on Codex (${startedWith.map((s) => s.opts.runtime).join(', ')})`)
    ok((child?.opts.chosen as { model?: string })?.model === 'gpt-5.5-codex',
       'with the model it named')
    ok((child?.opts.chosen as { effort?: string })?.effort === 'high',
       'and the effort it named')
    ok(child?.opts.providerFor === undefined,
       'and no backend profile, because that runtime signs in as itself')
    // Its sibling named nothing and must still be on the parent's agent: a
    // route is per piece, and one piece's choice cannot move another's.
    const sibling = startedWith.find((s) => s.opts.runtime === 'claude')
    ok((sibling?.opts.providerFor as { profile?: { id?: string } } | undefined)?.profile?.id === 'dsk',
       'while its sibling stays on the parent backend')
    reset()
  }

  // Routing to another BACKEND on the same runtime.
  {
    const v = await mgr.split('sess-parent', [
      piece({ agent: 'claude', model: 'claude-fable-5-1' }),
      piece({ scope: ['src/b/'] }),
    ])
    ok(v.ok === true, 'a piece may be routed to a different backend on the same runtime')
    const on = startedWith.find((s) =>
      (s.opts.providerFor as { profile?: { id?: string } } | undefined)?.profile?.id === 'inherit')
    ok(!!on, `and the host resolves THAT profile (${resolved.join(', ')})`)
    ok((on?.opts.chosen as { model?: string })?.model === 'claude-fable-5-1', 'with its own model')
    reset()
  }

  // The gates. Each one refuses BEFORE any agent starts and is RECORDED on the
  // parent — a session that tried to route, was refused, and did the work alone
  // must not be byte-identical on the board to the correct adaptive outcome.
  for (const [label, bad, rule] of [
    ['an agent that is not configured', { agent: 'gemini' }, 'spawn-agent'],
    ['a model that backend does not serve', { agent: 'codex', model: 'claude-opus-5' }, 'spawn-model'],
    ['an effort the model does not take', { agent: 'codex', model: 'gpt-5.5-codex', effort: 'xhigh' }, 'spawn-effort'],
    ['an effort that is not a level', { agent: 'codex', model: 'gpt-5.5-codex', effort: 'banana' }, 'spawn-effort'],
  ] as const) {
    const v = await mgr.split('sess-parent', [piece(bad), piece({ scope: ['src/b/'] })])
    ok(v.ok === false, `${label} is refused`)
    ok(startedWith.length === 0, `${label} starts NOTHING (${startedWith.length} agents)`)
    ok(patches.some((x) => x.patch.decomposition
      && (x.patch.decomposition as { rule?: string }).rule === rule),
       `${label} is recorded on the parent as ${rule} ` +
       `(${JSON.stringify(patches.map((x) => (x.patch.decomposition as { rule?: string })?.rule))})`)
    ok(!patches.some((x) => x.patch.fanout !== undefined),
       `${label} does not claim a fan-out that never happened`)
    reset()
  }

  // A refused route must not be able to spend money. The order is the same one
  // the spawn-model gate already has and for the same reason: a modal should
  // never ask about a plan the host already knows it will refuse.
  {
    let asked = 0
    const gated = new AgentManager({
      store: {
        card: async () => card, childrenOf: async () => [], setTags: async () => {},
        patch: async () => {},
      } as never,
      confirmSplit: async () => { asked++; return true },
      worktrees: { isClean: async () => true, aheadOf: async () => 0 } as never,
      board: DEFAULT_BOARD, defaults: {}, permissionMode: 'acceptEdits', maxConcurrent: 3,
      spawnCatalogue: () => catalogue,
    })
    ;(gated as unknown as { agents: Map<string, RunningAgent> }).agents.set('run-1', parent)
    const v = await gated.split('sess-parent', [piece({ agent: 'gemini' }), piece({ scope: ['src/b/'] })])
    ok(v.ok === false && asked === 0,
       `a route the host will refuse never reaches the approval dialog (asked ${asked}x)`)
  }
}

// --- what a run is decided ON, and WHEN ---------------------------------------
//
// `startRun()` read `this.opts.defaults` and `this.opts.provider` after two
// awaits, and `drain()` launches a queued run minutes later — while
// `setDefaults()` and `setProvider()` replace that state wholesale. MAX_SUBTASKS
// (4) exceeds the default concurrency (3), so the FOURTH piece of a fan-out
// always drains late: routing by mutating manager state hands one task another
// task's model. Everything per-run is therefore resolved ONCE, here.
{
  const defaults = {
    model: 'claude-opus-5', effort: 'high' as const, thinking: 'enabled' as const,
    ultracode: true, fastMode: false,
  }
  const inherited = launchSettings({}, defaults)
  ok(inherited.model === 'claude-opus-5', 'a run with no choice of its own takes the workspace default')
  ok(inherited.effort === 'high' && inherited.thinking === 'enabled', 'for every dial, not just the model')
  ok(inherited.ultracode === true && inherited.fastMode === false, 'session flags included')

  const own = launchSettings({ chosen: { model: 'deepseek-reasoner', effort: 'low' } }, defaults)
  ok(own.model === 'deepseek-reasoner', "a run's own model wins")
  ok(own.effort === 'low', 'and its own effort')
  ok(own.thinking === 'enabled', 'while the dials it did not choose still fall back')

  // The flags are per run, and `false` is a CHOICE — not an absence to be
  // overwritten by a default that says true. This is the `stripUndefined` trap
  // in a new place: `?? ` on a boolean is only correct if the absent value is
  // undefined and never false.
  const off = launchSettings({ chosen: { ultracode: false } }, defaults)
  ok(off.ultracode === false, 'a run that switched ultracode OFF stays off under a default that is on')
}

console.log(fails === 0 ? 'PASS — run identity, subtask boundaries, the meter contract and the agent brief hold' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
