/* AgentManager's bookkeeping, without launching a real agent.

   The interesting behaviour here is identity: a run starts keyed by a local
   runId and adopts Claude Code's session id moments later, and the board has to
   show it correctly throughout. Both halves of that have failure modes that are
   completely silent. */
import { AgentManager, MAX_SUBTASKS, titleFrom, buildBrief, type RunningAgent } from '../manager.ts'
import { agentEnv, HOST_SESSION_VARS } from '../session.ts'
import { DEFAULT_BOARD } from '../../board/config.ts'

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
const ACTIVE = ['working', 'starting', 'needsInput']
const TERMINAL = ['idle', 'done', 'error']
for (const kind of ACTIVE) ok(ACTIVE.includes(kind), `"${kind}" holds a concurrency slot`)
for (const kind of TERMINAL) {
  ok(!ACTIVE.includes(kind), `"${kind}" releases it — so it must trigger a drain`)
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

  const mgr = new AgentManager({
    store: {
      card: async () => card,
      childrenOf: async () => children,
      setTags: async () => {},
      patch: async () => {},
    } as never,
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
    runId: 'run-1', sessionId: 'sess-parent', title: 'Do two things',
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
    runId: 'run-7-abc', title: 'Okay.',
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
    runId, sessionId, title: runId,
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

console.log(fails === 0 ? 'PASS — run identity, subtask boundaries and the agent brief hold' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
