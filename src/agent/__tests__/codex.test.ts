/* Driving a Codex session against a fake app-server.
 *
 * The Codex CLI is not installed on every machine that runs this suite, and
 * this project's rule is that a gate which skips is not a gate. So the protocol
 * side is tested against a **stand-in app-server**: a real child process,
 * speaking the real newline-delimited JSON-RPC, over real pipes. Everything
 * between `spawn` and the board's events is the code under test; only the model
 * on the far end is fake.
 *
 * What that does and does not prove is worth being clear about, because the
 * temptation with an adapter like this is to test the mock.
 *
 *   PROVED HERE: the handshake order, that a thread id reaches the board, that
 *   streamed deltas become `partial`, that a settled message becomes `text`
 *   exactly once, that tool rows open and resolve, that an approval REQUEST is
 *   answered (the server blocks on it — an unanswered one is a wedged agent
 *   that looks like a thinking one), that interrupt is sent, that usage becomes
 *   a rate-limit meter and never a dollar figure, and that a message shape we
 *   do not know is REPORTED rather than dropped.
 *
 *   NOT PROVED HERE: that the real Codex spells these methods the way this file
 *   spells them. Nothing local can prove that, which is exactly why the adapter
 *   reads both known spellings and says out loud what it could not read.
 *
 * The last two cases are the ones worth keeping. `both spellings` is the drift
 * this whole adapter is shaped around; `reports what it could not read` is the
 * difference between a transcript that is wrong and a transcript that is wrong
 * and says so.
 */
import { CodexSession, codexPermissions, contextFill, parseModels } from '../runtimes/codex.ts'
import { parseMeter } from '../runtime.ts'
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

/** A stand-in `codex` whose `app-server` subcommand replays a script.
 *
 *  Written to disk as a Node program and spawned for real, rather than stubbed
 *  in-process, because the transport — pipes, line framing, a child that can
 *  die — is half of what is being tested. */
async function fakeCodex(dir: string, script: string): Promise<string> {
  const bin = path.join(dir, 'codex')
  await writeFile(bin, `#!/usr/bin/env node\n${script}\n`, 'utf8')
  await chmod(bin, 0o755)
  return bin
}

/** The body of a fake app-server: reads requests, answers them, emits notifications. */
const SERVER = `
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  for (;;) {
    const at = buf.indexOf('\\n')
    if (at < 0) break
    const line = buf.slice(0, at); buf = buf.slice(at + 1)
    if (!line.trim()) continue
    const m = JSON.parse(line)
    if (m.method === 'initialize') { send({ id: m.id, result: { agent: 'codex', version: '9.9.9' } }); continue }
    if (m.method === 'initialized') continue
    if (m.method === 'thread/start') { send({ id: m.id, result: { threadId: 'th-42' } }); continue }
    if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); process.stderr.write('INTERRUPTED\\n'); continue }
    if (m.method === 'turn/start') { run(m.id); continue }
    // Echo the client's RESPONSES to stderr so the test can assert on the wire
    // value. A decision the server cannot deserialise is invisible to a test
    // that only checks the board's own state — which is how \`reject\` shipped.
    if (m.method === undefined && m.id !== undefined) { process.stderr.write('ANSWER ' + line + '\\n'); continue }
    if (m.id !== undefined) send({ id: m.id, result: {} })
  }
})
${'' /* the turn itself is injected per test */}
`

/** Run one turn against a scripted server and collect what the board saw. */
async function drive(dir: string, turnBody: string, opts: { interrupt?: boolean; deny?: boolean } = {}) {
  const bin = await fakeCodex(dir, SERVER.replace('${\'\'}', '') + `\nfunction run(id) {\n${turnBody}\n}\n`)
  const answers: Record<string, unknown>[] = []
  let interruptSent = false
  const session = new CodexSession({
    taskId: 't1',
    cwd: dir,
    permissionMode: 'default',
    location: { command: bin, source: 'setting', version: '9.9.9' },
    // The adapter forwards the child's stderr here, and the fake server echoes
    // every response the board sent back — so the WIRE VALUE is assertable, not
    // just the board's own state.
    log: (m: string) => {
      if (m.includes('INTERRUPTED')) interruptSent = true
      const at = m.indexOf('ANSWER ')
      if (at < 0) return
      try { answers.push(JSON.parse(m.slice(at + 7))) } catch { /* not ours */ }
    },
  } as never)

  const seen = {
    text: [] as string[],
    partial: [] as string[],
    thinking: [] as string[],
    tools: [] as string[],
    toolResults: [] as boolean[],
    sessionId: undefined as string | undefined,
    meters: [] as unknown[],
    usage: [] as { tokens: number; window?: number }[],
    warnings: [] as string[],
    permissions: [] as { prompt?: string; toolName?: string; resolve: (allow: boolean, reason?: string) => void }[],
    done: false,
    interrupted: false,
    /** The server received `turn/interrupt`. Without this the interrupt case
     *  asserted something equally true of an interrupt never sent. */
    interruptSent: false,
    /** The `done` payload, kept rather than discarded — see the contract gate. */
    donePayload: undefined as { meter?: unknown; turnUsd?: unknown } | undefined,
    /** Every JSON-RPC response the board sent back, as the server saw it. */
    answers: [] as Record<string, unknown>[],
    errors: [] as string[],
  }
  session.on('text', (t: string) => seen.text.push(t))
  session.on('partial', (t: string) => seen.partial.push(t))
  session.on('thinking', (t: string) => seen.thinking.push(t))
  session.on('tool', (n: string) => seen.tools.push(n))
  session.on('toolResult', (_id: string, good: boolean) => seen.toolResults.push(good))
  session.on('sessionId', (id: string) => { seen.sessionId = id })
  session.on('meter', (m: unknown) => seen.meters.push(m))
  session.on('usage', (tokens: number, window?: number) => seen.usage.push({ tokens, window }))
  session.on('flagWarning', (m: string) => seen.warnings.push(m))
  session.on('permission', (r: { prompt?: string; toolName?: string; resolve: (a: boolean, reason?: string) => void }) => {
    seen.permissions.push(r)
    // Answer on the next tick, as the user would: the server is BLOCKED until
    // we do, so a test that never answers would hang exactly like the bug this
    // asserts against.
    setTimeout(() => r.resolve(!opts.deny, opts.deny ? 'not on my machine' : undefined), 5)
  })
  session.on('done', (_summary: string, meter?: unknown, turnUsd?: unknown) => {
    seen.done = true
    seen.donePayload = { meter, turnUsd }
  })
  session.on('interrupted', () => { seen.interrupted = true })
  session.on('error', (m: string) => seen.errors.push(m))

  const finished = new Promise<void>((resolve) => {
    session.on('done', () => resolve())
    session.on('error', () => resolve())
    setTimeout(resolve, 4000)
  })
  void session.run('do the thing')
  if (opts.interrupt) {
    await new Promise((r) => setTimeout(r, 150))
    await session.interrupt()
  }
  await finished
  // The echo travels through the child's stderr, so give it a tick to land.
  await new Promise((r) => setTimeout(r, 60))
  session.stop()
  seen.answers = answers
  seen.interruptSent = interruptSent
  return seen
}

/** The same driver, with the user pressing Deny. The deny arm is the one that
 *  shipped a value the protocol does not accept, and it is invisible to any
 *  test that only ever allows. */
const driveDenying = (dir: string, turnBody: string) => drive(dir, turnBody, { deny: true })

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'ak-codex-'))

  // --- a whole turn, in the app-server's camelCase spelling ----------------
  {
    const seen = await drive(dir, `
      send({ method: 'turn/started', params: { threadId: 'th-42' } })
      send({ method: 'item/agentMessage/delta', params: { delta: 'Hel' } })
      send({ method: 'item/agentMessage/delta', params: { delta: 'lo' } })
      send({ method: 'item/started', params: { item: { id: 'c1', type: 'commandExecution', command: 'npm test' } } })
      send({ method: 'item/completed', params: { item: { id: 'c1', type: 'commandExecution', command: 'npm test', exitCode: 0, status: 'completed' } } })
      send({ method: 'item/completed', params: { item: { id: 'm1', type: 'agentMessage', text: 'Hello' } } })
      send({ method: 'tokenCount', params: {
        info: { last_token_usage: { input_tokens: 14041, cached_input_tokens: 12160, output_tokens: 229, total_tokens: 14270 }, model_context_window: 258400 },
        rate_limits: { plan_type: 'plus', primary: { used_percent: 13, window_minutes: 300, resets_at: 1778984752 }, secondary: { used_percent: 2, window_minutes: 10080 } },
      } })
      send({ method: 'turn/completed', params: {} })
      send({ id, result: { turnId: 'tn-1' } })
    `)

    ok(seen.sessionId === 'th-42', `the thread id reaches the board (${seen.sessionId})`)
    ok(seen.partial.join('') === 'Hello', `streamed deltas arrive as partial text (${seen.partial.join('')})`)
    // Exactly once: the deltas already showed it, and emitting the settled item
    // as text as well would print the whole answer twice.
    ok(seen.text.length === 1 && seen.text[0] === 'Hello', `the settled answer lands once (${seen.text.length}x)`)
    ok(seen.tools.includes('Bash'), `a command becomes a Bash tool row (${seen.tools.join(', ')})`)
    ok(seen.toolResults.length === 1 && seen.toolResults[0] === true, 'and resolves to a tick when it exits 0')

    // The meter is the load-bearing one. A subscription session has NO dollar
    // figure it can defend, so it must not produce a `usd` meter at all.
    const meter = seen.meters[seen.meters.length - 1] as { kind: string; usedPercent?: number; plan?: string }
    ok(meter?.kind === 'plan', `usage becomes a PLAN meter, never dollars (got ${meter?.kind})`)
    ok(meter?.usedPercent === 13 && meter?.plan === 'plus', `and carries the real numbers (${meter?.usedPercent}% on ${meter?.plan})`)

    const fill = seen.usage[seen.usage.length - 1]
    ok(fill?.tokens === 14270, `context fill is the turn's total, not input+cached (${fill?.tokens})`)
    ok(fill?.window === 258400, `and the window comes from the runtime (${fill?.window})`)
    ok(seen.done, 'the turn completes')
    ok(!seen.errors.length, `and nothing errored (${seen.errors.join('; ')})`)

    // THE CONTRACT GATE. `RunEvents.done` is `(summary, meter?, turnUsd?)`, and
    // it was declared and unenforced for its whole life — so this runtime put a
    // `Meter` in the second slot while the Claude runtime put a bare `number`
    // there, the manager's listener declared `costUsd?: number`, and
    // `media/board.js` called `.toFixed(2)` on whatever arrived. That is a throw
    // inside `render()`, which is a silently blank panel, and `EventEmitter.on()`
    // is untyped so nothing in the type system could see it.
    //
    // Asserting the payload PARSES is what makes the contract real. Break it by
    // emitting `this._meter.usedPercent` instead of `this._meter` and this goes
    // red; the old code would have passed.
    ok(parseMeter(seen.donePayload?.meter)?.kind === 'plan',
       `done carries a parseable Meter in the meter slot (got ${JSON.stringify(seen.donePayload?.meter)?.slice(0, 60)})`)
    ok(seen.donePayload?.turnUsd === undefined,
       'and NO turn dollars — a subscription session has no per-request price to report')
  }

  // --- the OTHER spelling, which is what schema drift looks like -----------
  // The exec surface says `agent_message` and `command_execution`; the
  // app-server says `agentMessage` and `commandExecution`. Reading one spelling
  // gives a working transcript on one Codex version and a silently empty one on
  // the next.
  {
    const seen = await drive(dir, `
      send({ method: 'turn.started', params: {} })
      send({ method: 'item.completed', params: { item: { id: 'm1', type: 'agent_message', text: 'snake case' } } })
      send({ method: 'item.completed', params: { item: { id: 'c1', type: 'command_execution', command: 'ls', exit_code: 1, status: 'failed' } } })
      send({ method: 'turn.completed', params: {} })
      send({ id, result: {} })
    `)
    ok(seen.text[0] === 'snake case', `snake_case items are read too (${seen.text[0] ?? 'nothing'})`)
    ok(seen.toolResults[0] === false, 'and a non-zero exit still resolves the row to a cross')
  }

  // --- an approval round trip ---------------------------------------------
  // The server BLOCKS on this request. An adapter that only handled responses
  // would hang here forever, looking exactly like an agent thinking hard.
  {
    const seen = await drive(dir, `
      send({ id: 900, method: 'execCommandApproval', params: { command: 'rm -rf build', cwd: '/tmp' } })
      // The turn only finishes once the client has answered, so reaching this
      // line at all is the assertion.
      setTimeout(() => { send({ method: 'turn/completed', params: {} }); send({ id, result: {} }) }, 400)
    `)
    ok(seen.permissions.length === 1, `an approval request reaches the board (${seen.permissions.length})`)
    ok(/rm -rf build/.test(seen.permissions[0]?.prompt ?? ''), `and says what it wants to run (${seen.permissions[0]?.prompt ?? ''})`)
    ok(seen.done, 'and answering it lets the turn finish')
  }

  // --- the app-server's OWN usage notification -----------------------------
  //
  // `thread/tokenUsage/updated` is the name the app-server actually publishes
  // (codex-rs/app-server/README.md). The two spellings that were here —
  // `token_count` / `thread/tokenCount` — are the exec-era ones, so on a real
  // app-server run `onUsage()` never ran once: the context bar showed nothing
  // for the whole turn and a session burning a rate-limit window read as `—`.
  // Both numbers the board shows travel on this one notification.
  {
    const seen = await drive(dir, `
      send({ method: 'thread/tokenUsage/updated', params: {
        info: { last_token_usage: { input_tokens: 14041, cached_input_tokens: 12160, output_tokens: 229, total_tokens: 14270 }, model_context_window: 258400 },
        rate_limits: { plan_type: 'pro', primary: { used_percent: 41, window_minutes: 300 } },
      } })
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
      send({ id, result: {} })
    `)
    const fill = seen.usage[seen.usage.length - 1]
    ok(fill?.tokens === 14270, `the app-server's own usage notification is read (${fill?.tokens ?? 'nothing'})`)
    ok(fill?.window === 258400, 'with its window')
    const m = seen.meters[seen.meters.length - 1] as { kind?: string; usedPercent?: number } | undefined
    ok(m?.kind === 'plan' && m.usedPercent === 41,
       `and the rate-limit meter with it (${m?.kind} ${m?.usedPercent}%)`)
    ok(!seen.warnings.length, `and it is not reported as an unknown message (${seen.warnings.join(' | ')})`)
  }

  // --- the most ordinary item in the protocol -------------------------------
  //
  // `userMessage` is a documented ThreadItem and `item/*` fires for it at the
  // start of every turn. It was unhandled, so EVERY healthy turn ended with a
  // warning toast claiming rows were missing from the transcript — and the
  // claim was false, because the board renders the prompt from its own
  // composer. A drift alarm that cries wolf on every good turn is one the user
  // has learned to dismiss by the time it matters.
  {
    const seen = await drive(dir, `
      send({ method: 'item/started', params: { item: { id: 'u1', type: 'userMessage', text: 'do the thing' } } })
      send({ method: 'item/completed', params: { item: { id: 'u1', type: 'userMessage', text: 'do the thing' } } })
      send({ method: 'item/completed', params: { item: { id: 'm1', type: 'agentMessage', text: 'Done.' } } })
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
      send({ id, result: {} })
    `)
    ok(!seen.warnings.length,
       `a turn carrying a userMessage item warns about NOTHING (${seen.warnings.join(' | ') || 'silent'})`)
    ok(seen.text.join('') === 'Done.',
       `and the prompt is not echoed back into the transcript (${JSON.stringify(seen.text.join(''))})`)
  }

  // --- compaction must reset the meter --------------------------------------
  // Same trap as the Claude path's `compact_boundary`: no usage frame follows,
  // so a meter left alone stays pinned at the pre-compaction figure and reads
  // as a session about to run out of context when it has just been given most
  // of it back.
  {
    const seen = await drive(dir, `
      send({ method: 'thread/tokenUsage/updated', params: { info: { last_token_usage: { input_tokens: 200000, output_tokens: 100, total_tokens: 200100 }, model_context_window: 258400 } } })
      send({ method: 'item/completed', params: { item: { id: 'c1', type: 'contextCompaction' } } })
      send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
      send({ id, result: {} })
    `)
    const fill = seen.usage[seen.usage.length - 1]
    ok(fill?.tokens === 0, `a compaction empties the context meter (${fill?.tokens})`)
    ok(!seen.warnings.length, 'and is not reported as an unknown item')
  }

  // --- the app-server's approval names, which were RENAMED not respelled ----
  //
  // `normKind()` bridges case and separators; it cannot bridge a rename. Only
  // the exec-era `execCommandApproval` was recognised, so on a current server
  // every approval was answered with a JSON-RPC error before any human saw it
  // — while `capabilities.approvals` told the board the prompts mean something.
  {
    const seen = await drive(dir, `
      send({ id: 901, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf build', cwd: '/tmp', itemId: 'i1' } })
      setTimeout(() => { send({ method: 'turn/completed', params: { turn: { status: 'completed' } } }); send({ id, result: {} }) }, 400)
    `)
    ok(seen.permissions.length === 1,
       `the app-server spelling of a command approval reaches the board (${seen.permissions.length})`)
    ok(/rm -rf build/.test(seen.permissions[0]?.prompt ?? ''),
       `and still says what it wants to run (${seen.permissions[0]?.prompt ?? ''})`)
  }
  {
    const seen = await drive(dir, `
      send({ id: 902, method: 'item/fileChange/requestApproval', params: { changes: { 'src/a.ts': {} }, itemId: 'i2' } })
      setTimeout(() => { send({ method: 'turn/completed', params: { turn: { status: 'completed' } } }); send({ id, result: {} }) }, 400)
    `)
    ok(seen.permissions.length === 1,
       `and so does a file-change approval (${seen.permissions.length})`)
    ok(seen.permissions[0]?.toolName === 'Edit',
       `named as an edit rather than a command (${seen.permissions[0]?.toolName})`)
  }

  // --- Deny has to be a word the protocol knows -----------------------------
  //
  // The decisions are accept / acceptForSession / decline / cancel. `reject` —
  // what this sent — is in no version of the vocabulary, so Deny posted a value
  // the server cannot deserialise: the turn errored or blocked instead of the
  // command being refused, and the board had already dropped the request and
  // gone back to `working`, so there was nothing left to answer. This asserts
  // on the WIRE VALUE, because the board's own state looked fine either way.
  {
    const seen = await driveDenying(dir, `
      send({ id: 903, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf /', cwd: '/tmp' } })
      setTimeout(() => { send({ method: 'turn/completed', params: { turn: { status: 'completed' } } }); send({ id, result: {} }) }, 400)
    `)
    const answer = seen.answers.find((a) => a.id === 903)
    const decision = (answer?.result as Record<string, unknown> | undefined)?.decision
    ok(answer !== undefined, `the denial is answered on the wire (${JSON.stringify(seen.answers)})`)
    ok(decision !== 'reject', `and NOT with "reject", which is in no version of the vocabulary (got ${JSON.stringify(decision)})`)
    ok(decision === 'decline', `it is the documented partner of "accept" (got ${JSON.stringify(decision)})`)
  }

  // --- a turn that did NOT succeed --------------------------------------------
  //
  // `turn/completed` carries the terminal status. It was ignored, so a turn the
  // model failed on — a rate limit, a sandbox denial, a model error, which are
  // the everyday Codex failures — was emitted as `done`. If the agent had
  // already moved its card to a review column the user then got "ready for you
  // to test" over work that never finished.
  {
    const seen = await drive(dir, `
      send({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'rate limit exceeded' } } } })
      send({ id, result: {} })
    `)
    ok(!seen.done, 'a FAILED turn is not reported as done')
    ok(seen.errors.some((e) => /rate limit/.test(e)),
       `and says what went wrong (${seen.errors.join(' | ') || 'nothing'})`)
  }
  {
    const seen = await drive(dir, `
      send({ method: 'turn/completed', params: { turn: { status: 'interrupted' } } })
      send({ id, result: {} })
    `)
    ok(!seen.done, 'an INTERRUPTED turn is not reported as done either')
    ok(seen.interrupted, 'it is reported as interrupted')
    ok(!seen.errors.length, `and not as a crash (${seen.errors.join(' | ')})`)
  }

  // --- a shape this build does not know ------------------------------------
  // Dropped silently, this is how a transcript quietly loses half its rows.
  {
    const seen = await drive(dir, `
      send({ method: 'item/hologram/rendered', params: {} })
      send({ method: 'turn/completed', params: {} })
      send({ id, result: {} })
    `)
    ok(seen.warnings.some((w) => w.includes('hologram')),
      `an unknown message is REPORTED, not dropped (${seen.warnings.join(' | ') || 'nothing said'})`)
  }

  // --- interrupt ------------------------------------------------------------
  //
  // The file's header claims interrupt is proved here, and the only assertion
  // was that nothing errored — which is also true of an interrupt that was
  // never sent. So this asserts the REQUEST reached the server (the fake writes
  // INTERRUPTED to stderr when `turn/interrupt` arrives) and that the board's
  // own state ends up idle rather than stuck at `working`.
  {
    const seen = await drive(dir, `
      // A turn that never ends on its own, so only an interrupt can stop it.
      send({ method: 'turn/started', params: {} })
    `, { interrupt: true })
    ok(!seen.errors.length, `interrupting is not reported as a crash (${seen.errors.join('; ')})`)
    ok(seen.interruptSent, 'the interrupt actually reached the server, rather than being a no-op')
    ok(!seen.done, 'and an interrupted turn is NOT reported as a completed one')
  }

  await rm(dir, { recursive: true, force: true })

  // --- pure functions -------------------------------------------------------
  {
    // Codex counts cached tokens INSIDE the input figure; Claude counts them
    // alongside. Adding them the Claude way would double a real turn.
    ok(contextFill({ input_tokens: 14041, cached_input_tokens: 12160, output_tokens: 229, total_tokens: 14270 }) === 14270,
      'context fill uses the total, so cached tokens are not counted twice')
    ok(contextFill({ input_tokens: 100, output_tokens: 20 }) === 120,
      'and falls back to input+output when no total is given')
    ok(contextFill(undefined) === 0, 'and a missing record is zero rather than NaN')

    // A hidden model in the picker is an id that fails at the first request
    // with somebody else's error message.
    const models = parseModels([
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 258400, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'xhigh' }, { effort: 'ultra' }] },
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
      { nonsense: true },
    ])
    ok(models.length === 1 && models[0]!.id === 'gpt-5.5', `hidden and malformed models are dropped (${models.length} kept)`)
    ok(models[0]!.contextWindow === 258400, 'the window comes through for the meter')
    // `ultra` is a real Codex level with no board equivalent. Surfacing it would
    // make the effort picker mean two different things on two runtimes.
    ok(JSON.stringify(models[0]!.supportedEffort) === JSON.stringify(['low', 'xhigh']),
      `only efforts the board has a name for survive (${JSON.stringify(models[0]!.supportedEffort)})`)

    // The sandbox is the isolation boundary. Getting this row wrong means an
    // agent that silently cannot write to its own worktree.
    ok(codexPermissions('default').sandbox === 'workspace-write', 'the default stance can write to its own worktree')
    ok(codexPermissions('plan').sandbox === 'read-only', 'plan mode is read-only')
    ok(codexPermissions('bypassPermissions').approvalPolicy === 'never', 'bypassing permissions stops asking')
    ok(codexPermissions('dontAsk').approvalPolicy === 'never',
      "the SDK's newer spelling of the same intent maps to the same place")
  }

  console.log(fails ? `\n${fails} failed` : '\nall passed')
  process.exit(fails ? 1 : 0)
}

void main()
