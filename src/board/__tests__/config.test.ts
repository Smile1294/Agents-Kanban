/* The board's policy rules. These decide what an agent may do and when the user
   is interrupted, so they are code with tests rather than prose in a prompt. */
import { DEFAULT_BOARD, columnById, isHumanOnly, isReviewColumn, isStartedColumn, stalledSince, type BoardConfig } from '../config.ts'

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

// --- where the agent is asked to name its own card ---------------------------
// The ask for a real title rides on the move into the started column: the first
// moment the agent knows what the work is. A rule, not a hardcoded 'implementing',
// so a renamed board still has a moment to ask at.
ok(isStartedColumn(DEFAULT_BOARD, 'implementing'), 'the implementing column is where work starts')
for (const c of DEFAULT_BOARD.columns.filter((x) => x.category !== 'started')) {
  ok(!isStartedColumn(DEFAULT_BOARD, c.id), `"${c.id}" is not that moment`)
}
ok(!isStartedColumn(DEFAULT_BOARD, 'no-such-column'), 'and an unknown column is not either')
ok(DEFAULT_BOARD.columns.filter((c) => c.category === 'started').length === 1,
   'there is exactly one such moment, so the ask cannot fire twice')

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

// --- a run that ended without handing the work back --------------------------
//
// Found on a real board: two cards sat in Implementing with the work finished —
// PR open, tests green — because both agents ended their turn mid-thought
// ("I'll post the checklist once both verdicts are in") and never called
// `set_phase`. Their runs were over. Nothing on the board said so, and a card in
// a started column with no agent running looks exactly like one being worked on.
// That is a signal that cannot say "bad".
const ENDED = 1_700_000_000_000
ok(stalledSince(DEFAULT_BOARD, { phase: 'implementing', updated: ENDED, worktree: '/w' }) === ENDED,
   'a finished run left in a started column reports WHEN it stopped')
ok(stalledSince(DEFAULT_BOARD, { phase: 'implementing', updated: ENDED, worktree: '/w', running: true }) === undefined,
   'a card with a live agent is not stalled — it is working')
ok(stalledSince(DEFAULT_BOARD, { phase: 'validating', updated: ENDED, worktree: '/w' }) === undefined,
   'a card that reached review handed its work back, so it is not stalled')
ok(stalledSince(DEFAULT_BOARD, { phase: 'planning', updated: ENDED, worktree: '/w' }) === undefined,
   'a card that never started is not stalled either')
// Interrupted is a LOUDER and different state — the host went away mid-turn and
// the process is gone. Showing both would say two things about one card.
ok(stalledSince(DEFAULT_BOARD, { phase: 'implementing', updated: ENDED, worktree: '/w', interrupted: ENDED }) === undefined,
   'an interrupted run is not also reported as stalled')
ok(stalledSince(DEFAULT_BOARD, { phase: 'implementing', updated: ENDED }) === undefined,
   'a session with no worktree never ran, so there is nothing it failed to hand back')
ok(stalledSince(DEFAULT_BOARD, { phase: 'implementing', updated: ENDED, worktree: '/w', archived: true }) === undefined,
   'an archived card is not nagging anybody')
// A renamed board must work the same: the rule is the CATEGORY, never the id.
const renamed: BoardConfig = {
  ...DEFAULT_BOARD,
  columns: DEFAULT_BOARD.columns.map((c) => (c.category === 'started' ? { ...c, id: 'doing', name: 'Doing' } : c)),
}
ok(stalledSince(renamed, { phase: 'doing', updated: ENDED, worktree: '/w' }) === ENDED,
   'a renamed started column still reports a stalled run')
ok(stalledSince(renamed, { phase: 'implementing', updated: ENDED, worktree: '/w' }) === undefined,
   'and the old id is no longer a started column on that board')

console.log(fails === 0 ? 'PASS — board policy holds, including on a renamed board' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
