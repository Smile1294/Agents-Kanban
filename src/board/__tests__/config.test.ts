/* The board's policy rules. These decide what an agent may do and when the user
   is interrupted, so they are code with tests rather than prose in a prompt. */
import { DEFAULT_BOARD, columnById, isHumanOnly, isReviewColumn, type BoardConfig } from '../config.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// --- the approval boundary ---------------------------------------------------
// This is the one rule that must never be relaxed by accident: the agent cannot
// declare its own work complete.
ok(isHumanOnly(DEFAULT_BOARD, 'complete'), 'the done column is human-only')
for (const c of DEFAULT_BOARD.columns.filter((x) => x.category !== 'done')) {
  ok(!isHumanOnly(DEFAULT_BOARD, c.id), `an agent may reach "${c.id}"`)
}
ok(!isHumanOnly(DEFAULT_BOARD, 'no-such-column'), 'an unknown column is not silently human-only')

// Exactly one approval gate: two would mean an agent could be blocked somewhere
// it was never told about.
ok(DEFAULT_BOARD.columns.filter((c) => c.humanOnly).length === 1, 'there is exactly one approval column')

// --- the ready-to-test signal ------------------------------------------------
ok(isReviewColumn(DEFAULT_BOARD, 'validating'), 'the review column is what "ready to test" means')
ok(!isReviewColumn(DEFAULT_BOARD, 'implementing'), 'still implementing is not ready to test')
ok(!isReviewColumn(DEFAULT_BOARD, 'complete'), 'already complete does not ask to be tested again')
ok(!isReviewColumn(DEFAULT_BOARD, 'nope'), 'an unknown column does not notify')

// The rule is by category, not by id, so a renamed board still works.
const custom: BoardConfig = {
  statusField: 'status',
  columns: [
    { id: 'todo', name: 'To do', category: 'backlog' },
    { id: 'doing', name: 'Doing', category: 'started' },
    { id: 'needs-qa', name: 'Needs QA', category: 'review' },
    { id: 'shipped', name: 'Shipped', category: 'done', humanOnly: true },
  ],
}
ok(isReviewColumn(custom, 'needs-qa'), 'a renamed review column still signals ready-to-test')
ok(isHumanOnly(custom, 'shipped'), 'a renamed done column is still the approval gate')
ok(!isReviewColumn(custom, 'validating'), 'the default column id has no special power on a custom board')

// --- lookup ------------------------------------------------------------------
ok(columnById(DEFAULT_BOARD, 'planning')?.name === 'Planning', 'columnById finds a column')
ok(columnById(DEFAULT_BOARD, 'missing') === undefined, 'columnById returns undefined for a stranger')

// Every column an agent is told about must carry guidance, or the tool
// description lists a destination with no explanation of when to use it.
for (const c of DEFAULT_BOARD.columns.filter((x) => x.category !== 'backlog')) {
  ok(!!c.agentHint, `"${c.id}" tells the agent what it means`)
}

console.log(fails === 0 ? 'PASS — board policy holds, including on a renamed board' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
