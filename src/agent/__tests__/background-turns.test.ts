/* A run must outlive a TURN while background agents are still working.
 *
 * Reported as: "it says completed but nothing came back, and the second one
 * never launched". The parent spawned a background agent, said "waiting", and
 * its turn ended. The CLI had already queued the agent's `<task-notification>`
 * as the next user message and would have run a follow-up turn on it — probed
 * against the real CLI in SDK streaming mode: after the first `result` it
 * emits a fresh `init`, answers the notification, and emits a second `result`,
 * with no input from us. But `finish()` stopped the process on the FIRST
 * `result`, so the follow-up turn died with it.
 *
 * The SDK tells us everything needed, as `system` frames: `task_started`
 * (`is_backgrounded`), `background_tasks_changed` (REPLACE semantics),
 * `task_updated` and `task_notification`. The frames below are the ones the
 * probe recorded, in the order it recorded them. Nothing here starts a process:
 * `AgentSession.handle()` is the whole of the stream handling.
 */
import { AgentSession } from '../session.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const make = () => {
  const session = new AgentSession({
    taskId: 'run-1',
    cwd: '/tmp/nowhere',
    permissionMode: 'acceptEdits',
    boardServer: { type: 'sdk', name: 'board', instance: {} } as never,
    // Short, so the "no follow-up turn came" path can be tested in real time.
    followUpGraceMs: 40,
  })
  const dones: string[] = []
  const waits: string[][] = []
  const ids: string[] = []
  session.on('done', (summary: string) => dones.push(summary))
  session.on('waiting', (on: string[]) => waits.push(on))
  session.on('sessionId', (id: string) => ids.push(id))
  session.on('error', () => {})
  const feed = (msg: unknown) => (session as unknown as { handle: (m: unknown) => void }).handle(msg)
  return { session, dones, waits, ids, feed, state: () => session.state.kind }
}

// --- the frames, as the CLI writes them --------------------------------------
const init = () => ({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: [] })
const started = (id: string, description: string) =>
  ({ type: 'system', subtype: 'task_started', task_id: id, description, is_backgrounded: true, task_type: 'local_agent' })
const changed = (tasks: Array<Record<string, unknown>>) => ({ type: 'system', subtype: 'background_tasks_changed', tasks })
const updated = (id: string, status: string) => ({ type: 'system', subtype: 'task_updated', task_id: id, patch: { status } })
const notified = (id: string, status = 'completed') =>
  ({ type: 'system', subtype: 'task_notification', task_id: id, status, summary: 'pong', output_file: '/x' })
const text = (t: string) => ({ type: 'assistant', message: { role: 'assistant', model: 'claude-haiku-4-5-20251001', content: [{ type: 'text', text: t }] } })
// A block body, not `=> ({ … })`: tsc re-parses a parenthesised body that is
// followed by a bare `{` block as an arrow function missing its `=>`, and
// reports the object literal as a broken parameter list.
const result = (r: string) => {
  return { type: 'result', subtype: 'success', result: r, is_error: false, total_cost_usd: 0.01 }
}

// 1. The reported case: the agent finished DURING the parent's turn, so its
//    notification is already queued when the turn ends. The run must wait for
//    the follow-up turn rather than finishing.
{
  const { dones, waits, ids, feed, state } = make()
  feed(init())
  feed(changed([{ task_id: 'a', task_type: 'local_agent', description: 'Count knowledge domain files' }]))
  feed(started('a', 'Count knowledge domain files'))
  feed(text('Agent #1 spawned.'))
  feed(changed([]))
  feed(updated('a', 'completed'))
  feed(notified('a'))
  feed(text('Now waiting on the notification.'))
  feed(result('Now waiting on the notification.'))
  ok(state() === 'waiting', `the turn ended but the run did not: state is ${state()}`)
  ok(dones.length === 0, 'and "done" was NOT emitted — that is what killed the follow-up turn')
  ok(waits.length === 1 && waits[0]!.length === 0,
     'the manager is told the run is waiting, with no task still live (the notification is what is due)')
  // The follow-up turn, exactly as the probe saw it: a fresh init, then text.
  feed(init())
  ok(ids.length === 1, `a repeated init with the same session id is not re-announced (${ids.length})`)
  ok(state() === 'working', `the follow-up turn puts the run back to work (${state()})`)
  feed(text('Agent returned: 23 files.'))
  feed(result('Agent returned: 23 files.'))
  ok(state() === 'done', `and with nothing left live, the second result finishes the run (${state()})`)
  ok(dones.length === 1 && dones[0] === 'Agent returned: 23 files.',
     `done is emitted ONCE, with the last turn's summary (${JSON.stringify(dones)})`)
}

// 2. The agent is STILL RUNNING when the turn ends. The run waits, names the
//    agent, and finishes only after the notification and its follow-up turn.
{
  const { dones, waits, feed, state, session } = make()
  feed(init())
  feed(started('b', 'Long research task'))
  feed(text('Spawned, waiting.'))
  feed(result('Spawned, waiting.'))
  ok(state() === 'waiting', `a live background agent keeps the run open (${state()})`)
  const s = session.state as { kind: string; tasks?: number; on?: string }
  ok(s.tasks === 1 && s.on === 'Long research task', `and the state says what it is waiting on (${JSON.stringify(s)})`)
  ok(waits[0]?.[0] === 'Long research task', 'the manager hears the same description')
  await sleep(90)
  ok(state() === 'waiting' && dones.length === 0, 'the grace timer does NOT apply while a task is live — it may run for minutes')
  feed(changed([]))
  feed(notified('b'))
  ok(state() === 'waiting', 'the notification alone does not finish it — the follow-up turn is what comes next')
  feed(init())
  feed(text('Findings: …'))
  feed(result('Findings: …'))
  ok(dones.length === 1 && dones[0] === 'Findings: …', `finished after the follow-up turn (${JSON.stringify(dones)})`)
}

// 3. A notification was seen, but no follow-up turn ever came (the CLI batched
//    two into one turn, say). The run must not wait forever: a short grace, then done.
{
  const { dones, feed, state } = make()
  feed(init())
  feed(started('c', 'quick'))
  feed(notified('c'))
  feed(text('spawned and done'))
  feed(result('spawned and done'))
  ok(state() === 'waiting', 'a due follow-up holds the run open…')
  await sleep(120)
  ok(state() === 'done' && dones.length === 1, `…but only for the grace period when nothing is live (${state()}, ${dones.length} done)`)
}

// 4. No background tasks at all: unchanged behaviour, done on the first result.
{
  const { dones, feed, state } = make()
  feed(init())
  feed(text('hello'))
  feed(result('hello'))
  ok(state() === 'done' && dones.length === 1, `an ordinary turn still finishes immediately (${state()})`)
}

// 5. Housekeeping tasks the CLI flags `ambient` do not hold a run open, and a
//    task the user killed (task_updated, no notification) releases it.
{
  const { dones, feed, state } = make()
  feed(init())
  feed(changed([{ task_id: 'w', task_type: 'local_bash', description: 'watcher', ambient: true }]))
  feed(started('d', 'doomed'))
  feed(updated('d', 'killed'))
  feed(text('x'))
  feed(result('x'))
  ok(state() === 'done' && dones.length === 1, `ambient tasks and killed tasks do not hold the run (${state()})`)
}

// 6. stop() while waiting: no done arrives later out of the grace timer.
{
  const { dones, feed, state, session } = make()
  feed(init())
  feed(started('e', 'e'))
  feed(notified('e'))
  feed(text('x'))
  feed(result('x'))
  ok(state() === 'waiting', 'waiting on a due follow-up')
  session.stop()
  await sleep(120)
  ok(dones.length === 0, 'stop() disarms the grace timer — a stopped run does not report done afterwards')
}

console.log(fails ? `\n${fails} FAILED` : '\nall ok — a run outlives its turn while background agents are live')
process.exit(fails ? 1 : 0)
