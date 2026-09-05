/* The parent/child thread, which is derived and therefore cannot drift.

   The temptation was to store a `children: string[]` on the parent. It would
   have been wrong for a specific reason: a card's key is its run id until
   Claude Code assigns a session id, seconds into the first turn — so the list
   would have gone stale at exactly the moment a split is most visible. One
   pointer per child is a fact that MetaStore.rename() repoints; this file
   guards the other half, the derivation. */
import { linkSubtasks, rollUpState, subtaskProgress, type SubtaskLinkable } from '../subtasks.ts'
import { DEFAULT_BOARD, type BoardConfig } from '../config.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const card = (key: string, phase: string, over: Partial<SubtaskLinkable> = {}): SubtaskLinkable =>
  ({ key, title: key.toUpperCase(), phase, ...over })

// --- the ordinary case -------------------------------------------------------
{
  const cards = [
    card('p', 'implementing'),
    card('a', 'validating', { parent: 'p' }),
    card('b', 'implementing', { parent: 'p' }),
  ]
  linkSubtasks(cards, DEFAULT_BOARD)
  ok(cards[0]!.subtasks?.length === 2, 'the parent learns about both subtasks')
  ok(cards[1]!.parentTitle === 'P' && cards[2]!.parentTitle === 'P', 'and each subtask learns its parent')
  const p = subtaskProgress(cards[0]!)
  ok(p.ready === 1 && p.total === 2, `one of two is ready (${p.ready}/${p.total})`)
  ok(cards[0]!.subtasks![0]!.ready === true, 'a subtask in a review column counts as ready')
  ok(cards[0]!.subtasks![1]!.ready === false, 'one still being written does not')
}

// --- "ready" means off the agent's plate, not one specific column ------------
// A subtask the user has already approved must still count, or a parent whose
// pieces the user merged one by one never reaches full and never reads as
// testable — the exact case where they most want to be told.
{
  const cards = [card('p', 'implementing'), card('a', 'complete', { parent: 'p' }), card('b', 'validating', { parent: 'p' })]
  linkSubtasks(cards, DEFAULT_BOARD)
  const p = subtaskProgress(cards[0]!)
  ok(p.ready === 2, 'an approved subtask counts as ready, the same as one awaiting review')
}
{
  const cards = [card('p', 'implementing'), card('a', 'backlog', { parent: 'p' }), card('b', 'planning', { parent: 'p' })]
  linkSubtasks(cards, DEFAULT_BOARD)
  ok(subtaskProgress(cards[0]!).ready === 0, 'and nothing before the work starts does')
}

// --- a custom board ----------------------------------------------------------
// Categories, never hardcoded column ids: a renamed board must still be able to
// say where "ready" is.
{
  const custom: BoardConfig = {
    statusField: 'status',
    columns: [
      { id: 'todo', name: 'To do', category: 'unstarted' },
      { id: 'wip', name: 'WIP', category: 'started' },
      { id: 'check-it', name: 'Check it', category: 'review' },
      { id: 'shipped', name: 'Shipped', category: 'done', humanOnly: true },
    ],
  }
  const cards = [card('p', 'wip'), card('a', 'check-it', { parent: 'p' })]
  linkSubtasks(cards, custom)
  ok(subtaskProgress(cards[0]!).ready === 1, 'a renamed review column still means ready')
}

// --- the failure modes -------------------------------------------------------
{
  // Parent archived, deleted, or filtered out of this render.
  const cards = [card('a', 'validating', { parent: 'gone' })]
  linkSubtasks(cards, DEFAULT_BOARD)
  ok(cards[0]!.parentTitle === undefined,
     'a subtask whose parent is not on screen shows no reference — better than one that goes nowhere')
}
{
  // A hand-edited sidecar. Nothing here recurses, so this only has to not link.
  const cards = [card('a', 'validating', { parent: 'a' })]
  linkSubtasks(cards, DEFAULT_BOARD)
  ok(!cards[0]!.subtasks && !cards[0]!.parentTitle, 'a card cannot be its own subtask')
}
{
  const cards = [card('p', 'implementing'), card('a', 'validating')]
  linkSubtasks(cards, DEFAULT_BOARD)
  ok(cards[0]!.subtasks === undefined, 'a card with no subtasks is left without the field entirely')
  ok(subtaskProgress(cards[0]!).total === 0, 'and reports no progress rather than throwing')
}

// --- order ------------------------------------------------------------------
// The subtask list is the order they were created in, which is the order the
// agent proposed them. Anything else would shuffle under the user as phases
// change, and a list that reorders itself cannot be scanned.
{
  const cards = [
    card('p', 'implementing'),
    card('first', 'implementing', { parent: 'p' }),
    card('second', 'validating', { parent: 'p' }),
  ]
  linkSubtasks(cards, DEFAULT_BOARD)
  ok(cards[0]!.subtasks!.map((t) => t.key).join(',') === 'first,second',
     'subtasks keep the order they appear in, not their phase order')
}

// --- the roll-up, which is a NOTIFICATION and shipped wrong ------------------
//
// The host counted a parent's children by asking the sidecar which sessions
// name it — and a subtask held behind `maxConcurrentAgents` is not in the
// sidecar at all, because `start()` queues it in memory and returns before
// `launch()` writes anything. `MAX_SUBTASKS` is 4 and the concurrency default
// is 3, so the last piece of a four-way split is ALWAYS queued. The result was
// "All 2 subtasks are ready for you to test" over a four-way split in which two
// agents had never run.
{
  const B = DEFAULT_BOARD
  ok(rollUpState([], undefined, B).kind === 'notSplit', 'a card with no children was never split')

  // THE BUG, exactly: two settled children of a four-way split.
  const half = rollUpState(['validating', 'validating'], 4, B)
  ok(half.kind === 'pending',
     `two settled children of a FOUR-way split is not ready (got ${half.kind})`)
  ok(half.kind === 'pending' && half.onBoard === 2 && half.approved === 4,
     'and it can say which numbers it is comparing')

  ok(rollUpState(['validating', 'implementing', 'validating', 'validating'], 4, B).kind === 'working',
     'all four present but one still working is not ready either')
  const done = rollUpState(['validating', 'complete', 'validating', 'validating'], 4, B)
  ok(done.kind === 'ready', `all four settled IS ready (got ${done.kind})`)
  ok(done.kind === 'ready' && done.total === 4,
     `and the number it reports is the number that was approved (${done.kind === 'ready' ? done.total : '—'})`)

  // "Settled" is review OR done, so a parent whose pieces the user already
  // approved one by one still reaches full.
  ok(rollUpState(['complete', 'complete'], 2, B).kind === 'ready',
     'children the user has already approved still count as settled')

  // More children than approved cannot happen, but must not deadlock if it
  // does — a parent that can never roll up is a card nobody will ever move.
  ok(rollUpState(['validating', 'validating', 'validating'], 2, B).kind === 'ready',
     'more children than approved still rolls up rather than waiting forever')

  // A split made before `fanout` existed has no approved count, and the old
  // count-what-exists behaviour is the best available for it.
  ok(rollUpState(['validating', 'validating'], undefined, B).kind === 'ready',
     'a split with no recorded intent falls back to counting what exists')
}

console.log(fails === 0 ? 'PASS — the subtask thread is derived, and the roll-up counts what was approved' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
