/**
 * What a LIVE run reports it has spent, driven through the real message handler.
 *
 * The disk path has its own test (`sessions/usage.test.ts`) and its own gate in
 * smoke. This one exists because the live path is the half that can silently
 * disagree with it: it sees the CLI's frames one at a time, in an order it does
 * not control, and it has to arrive at the same number the transcript will
 * report a moment later when the same session is read back. If these two ever
 * diverge, the figure on the board changes when a run ends — for no reason the
 * user can see.
 *
 * Nothing here starts a process. `AgentSession.handle()` is the whole of the
 * stream handling, and it can be fed the frames Claude Code actually writes.
 */
import { AgentSession } from '../session.ts'
import { summariseUsage, type UsageMessage } from '../../sessions/usage.ts'
import { parseMeter } from '../runtime.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

const logged: string[] = []
const make = () => {
  logged.length = 0
  const session = new AgentSession({
    taskId: 'run-1',
    cwd: '/tmp/nowhere',
    permissionMode: 'acceptEdits',
    boardServer: { type: 'sdk', name: 'board', instance: {} } as never,
    log: (m: string) => logged.push(m),
  })
  const spends: { usd: number; priced: boolean }[] = []
  session.on('spend', (usd: number, priced: boolean) => spends.push({ usd, priced }))
  // Nothing under test needs the state machine, and an unhandled 'error' event
  // on an EventEmitter takes the process down with it.
  session.on('error', () => {})
  const feed = (msg: unknown) => (session as unknown as { handle: (m: unknown) => void }).handle(msg)
  return { session, spends, feed }
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 1000,
  cache_read_input_tokens: 200_000,
  cache_creation_input_tokens: 4_000,
  cache_creation: { ephemeral_1h_input_tokens: 4_000, ephemeral_5m_input_tokens: 0 },
}
// Opus 5 at $5/$25 per MTok: 100·5 + 1000·25 + 200000·0.5 + 4000·10 millionths.
const ONE_RESPONSE = 0.1655

const assistant = (id: string, usage: unknown, parent: string | null = null) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: {
    id, model: 'claude-opus-5', role: 'assistant', type: 'message',
    content: [{ type: 'text', text: 'hello' }], usage,
  },
})
const result = (costUsd: number | undefined) => ({
  type: 'result',
  ...(costUsd !== undefined ? { total_cost_usd: costUsd } : {}),
  modelUsage: { 'claude-opus-5': { contextWindow: 1_000_000 } },
  result: 'done',
})

// ---------------------------------------------------------------------------
// 1. It climbs DURING the turn. The CLI's own figure only arrives at the end,
// so a readout that waited for it sat still through a ten-minute turn and then
// jumped — which reads as broken, not as thrifty.
{
  const { spends, feed } = make()
  feed(assistant('msg_a', USAGE))
  ok(spends.length === 1, 'the first response publishes a total straight away')
  ok(near(spends[0]!.usd, ONE_RESPONSE), `priced from its tokens: $${spends[0]?.usd}`)
  feed(assistant('msg_b', USAGE))
  ok(spends.length === 2 && near(spends[1]!.usd, ONE_RESPONSE * 2),
     `and climbs with the next one: $${spends[1]?.usd}`)
}

// ---------------------------------------------------------------------------
// 2. The frames of one streamed response are ONE response.
//
// The CLI writes an assistant record per completed content block, each
// repeating the whole response's usage. This is the same bug as in the disk
// path, and it has to be fixed in both places or the number changes when the
// run ends.
{
  const { spends, feed } = make()
  feed(assistant('msg_same', USAGE))
  feed(assistant('msg_same', USAGE))
  feed(assistant('msg_same', USAGE))
  const total = spends[spends.length - 1]!.usd
  ok(near(total, ONE_RESPONSE),
     `three frames of one response are billed once: $${total} (not $${(ONE_RESPONSE * 3).toFixed(4)})`)
}

// ---------------------------------------------------------------------------
// 3. The live total agrees with what the transcript will say afterwards.
//
// The two paths are what the user sees before and after a restart. A run that
// reported $2 and then read back as $6 would make both numbers worthless.
{
  const { spends, feed } = make()
  const frames = [
    assistant('msg_1', USAGE),
    assistant('msg_1', USAGE),
    assistant('msg_2', USAGE),
    assistant('msg_sub', USAGE, 'toolu_1'),
  ]
  for (const f of frames) feed(f)
  const live = spends[spends.length - 1]!.usd
  const fromDisk = summariseUsage(frames as unknown as UsageMessage[]).costUsd
  ok(near(live, fromDisk),
     `live $${live.toFixed(4)} equals the same frames read back from disk $${fromDisk.toFixed(4)}`)
  ok(near(live, ONE_RESPONSE * 3), 'and both count the subagent response — a Task costs real money')
}

// ---------------------------------------------------------------------------
// 4. A subagent's frames are spend, never context.
//
// The routing rule this project already has (`parent_tool_use_id` must not be
// merged into the main thread) applies to the transcript. Money is the
// exception: it is billed wherever it was spent.
{
  const { session, feed } = make()
  const usages: number[] = []
  session.on('usage', (tokens: number) => usages.push(tokens))
  feed(assistant('msg_main', { input_tokens: 1, cache_read_input_tokens: 10_000, output_tokens: 5 }))
  feed(assistant('msg_sub', { input_tokens: 1, cache_read_input_tokens: 900_000, output_tokens: 5 }, 'toolu_1'))
  ok(usages.length === 1 && usages[0] === 10_001,
     `context fill ignores the subagent's own window (${usages.join(', ')})`)
  ok((session as unknown as { spentUsd: number }).spentUsd > 0, 'but its tokens are still paid for')
}

// ---------------------------------------------------------------------------
// 5. It checks itself against the bill, and says so when they disagree.
//
// `total_cost_usd` is what was actually charged. The board keeps showing the
// computed figure — it is the only one that exists mid-turn or after a restart
// — but a large gap means the rate table has gone stale, and that is worth
// saying out loud rather than absorbing.
{
  const { feed } = make()
  feed(assistant('msg_x', USAGE))
  feed(result(ONE_RESPONSE))
  ok(logged.length === 0, `a figure that matches the bill says nothing (${logged.join('; ')})`)
}
{
  const { feed } = make()
  feed(assistant('msg_x', USAGE))
  feed(result(ONE_RESPONSE * 4))
  ok(logged.length === 1, 'a figure well off the bill is reported')
  ok(/usage\.ts/.test(logged[0] ?? ''), `and names where to fix it: ${logged[0]}`)
}
{
  // A turn the CLI never priced — an interrupt, an older CLI — must not be
  // reported as a disagreement with a figure that was never given.
  const { feed } = make()
  feed(assistant('msg_x', USAGE))
  feed(result(undefined))
  ok(logged.length === 0, 'an unpriced turn is not reported as drift')
}

// ---------------------------------------------------------------------------
// 6. Turns accumulate. The second turn adds to the first rather than replacing
// it — the readout is the SESSION's spend, not the last turn's.
{
  const { spends, feed } = make()
  feed(assistant('msg_t1', USAGE))
  feed(result(ONE_RESPONSE))
  const afterFirst = spends[spends.length - 1]!.usd
  feed(assistant('msg_t2', USAGE))
  const afterSecond = spends[spends.length - 1]!.usd
  ok(near(afterFirst, ONE_RESPONSE), `after one turn: $${afterFirst.toFixed(4)}`)
  ok(near(afterSecond, ONE_RESPONSE * 2), `after two: $${afterSecond.toFixed(4)} — turns add up`)
}

// ---------------------------------------------------------------------------
// 7. Compaction resets the context fill but never the bill. Those tokens were
// bought and paid for; only the window they occupied was reclaimed.
{
  const { session, spends, feed } = make()
  const usages: number[] = []
  session.on('usage', (tokens: number) => usages.push(tokens))
  feed(assistant('msg_c', USAGE))
  const before = spends[spends.length - 1]!.usd
  feed({ type: 'system', subtype: 'compact_boundary' })
  ok(usages[usages.length - 1] === 0, 'a compaction empties the context meter')
  ok(near(spends[spends.length - 1]!.usd, before), 'and refunds nothing — the spend stands')
}

// ---------------------------------------------------------------------------
// 8. An unpriced model marks the total as a floor rather than skewing it.
{
  const { spends, feed } = make()
  feed({
    type: 'assistant', parent_tool_use_id: null,
    message: {
      id: 'msg_u', model: 'claude-from-the-future', role: 'assistant', type: 'message',
      content: [{ type: 'text', text: 'x' }], usage: USAGE,
    },
  })
  ok(spends[0]!.priced === false, 'a model with no rate marks the total incomplete')
  feed(assistant('msg_k', USAGE))
  ok(spends[spends.length - 1]!.priced === false, 'and it stays incomplete for the rest of the run')
  ok(near(spends[spends.length - 1]!.usd, ONE_RESPONSE), 'while the priced half still counts')
}

// ---------------------------------------------------------------------------
// 9. THE `done` CONTRACT — the other half of the gate in `codex.test.ts`.
//
// `RunEvents.done` is `(summary, meter?: Meter, turnUsd?: number)`. It was
// declared and unenforced, and the two runtimes drifted apart inside it: this
// one put `r.total_cost_usd` — a bare number — in the meter slot while
// `codex.ts` put a `Meter` object there. `manager.ts` typed the listener
// `costUsd?: number` and assigned it straight onto the card, and
// `media/board.js` called `.toFixed(2)` on it. `EventEmitter.on()` is untyped,
// so tsc saw none of it; the symptom was a throw inside `render()` — a silently
// blank panel — on the first real Codex run.
//
// Both slots are asserted, because the failure was a SWAP and a gate that
// checked only one of them would have passed on the broken code.
{
  const { session, feed } = make()
  const payloads: { summary: unknown; meter: unknown; turnUsd: unknown }[] = []
  session.on('done', (summary: unknown, meter: unknown, turnUsd: unknown) =>
    payloads.push({ summary, meter, turnUsd }))

  feed(assistant('msg_done', USAGE))
  feed({ type: 'result', subtype: 'success', result: 'All done.', total_cost_usd: 0.42 })

  const p = payloads[0]
  ok(payloads.length === 1, `the turn reports done exactly once (${payloads.length})`)
  ok(typeof p?.summary === 'string', 'the first argument is the summary')

  // Slot two is the SESSION meter, in the shape every runtime reports.
  const parsed = parseMeter(p?.meter)
  ok(parsed?.kind === 'usd',
     `slot two is a parseable Meter, not a bare number (got ${JSON.stringify(p?.meter)})`)
  ok(parsed?.kind === 'usd' && near(parsed.spentUsd, ONE_RESPONSE),
     `and it carries this session's own arithmetic, not the CLI's turn figure ` +
     `(${parsed?.kind === 'usd' ? parsed.spentUsd : '—'} vs ${ONE_RESPONSE})`)

  // Slot three is THIS TURN's dollars, which is a different scope. The board
  // shows it on the result row and the agent row; conflating the two is what
  // put a `Meter` where a number was expected.
  ok(p?.turnUsd === 0.42, `slot three is the turn's billed figure (${String(p?.turnUsd)})`)
}

console.log(fails ? `\n${fails} FAILED` : '\nPASS — a live run prices itself, agrees with its own transcript, and honours the done contract')
process.exit(fails ? 1 : 0)
