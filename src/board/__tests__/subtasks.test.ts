/* The parent/child thread, which is derived and therefore cannot drift.

   The temptation was to store a `children: string[]` on the parent. It would
   have been wrong for a specific reason: a card's key is its run id until
   Claude Code assigns a session id, seconds into the first turn — so the list
   would have gone stale at exactly the moment a split is most visible. One
   pointer per child is a fact that MetaStore.rename() repoints; this file
   guards the other half, the derivation. */
import { linkSubtasks, subtaskProgress, type SubtaskLinkable } from '../subtasks.ts'
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

console.log(fails === 0 ? 'PASS — the subtask thread is derived and holds' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
