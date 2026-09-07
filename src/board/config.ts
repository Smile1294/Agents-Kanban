/** Board configuration and agent run state.
 *
 * Design note: a session's COLUMN is its `phase`. There is no separate column
 * field and no "move" operation — writing `phase` is the move. Lane order is
 * the order of `columns` here. This is the one idea taken verbatim from
 * Nimbalyst, because it removes a whole class of desync bugs between "what
 * column is this in" and "what state is this in".
 *
 * Sessions and transcripts belong to Claude Code; this file only describes the
 * board laid over them.
 */

export type StatusId = string

/** Lifecycle bucket, so "is it finished?" works without hardcoding column ids. */
export type StatusCategory = 'backlog' | 'unstarted' | 'started' | 'review' | 'done' | 'cancelled'

export interface ColumnDef {
  /** Written verbatim into a task's `status` frontmatter field. */
  id: StatusId
  name: string
  category: StatusCategory
  /** When true, an agent may NOT move a task here. Enforced in code at the
   *  tool boundary, never by prompting. This is the approval gate. */
  humanOnly?: boolean
  /** Optional guidance surfaced to the agent in the tool description. */
  agentHint?: string
}

export interface BoardConfig {
  columns: ColumnDef[]
  /** Frontmatter key holding the workflow status. */
  statusField: string
}

export const DEFAULT_BOARD: BoardConfig = {
  statusField: 'status',
  columns: [
    { id: 'backlog', name: 'Backlog', category: 'backlog' },
    {
      id: 'planning',
      name: 'Planning',
      category: 'unstarted',
      agentHint: 'You are still working out what to do. Move on once you have a plan.',
    },
    {
      id: 'implementing',
      name: 'Implementing',
      category: 'started',
      agentHint: 'Move here when you start changing code.',
    },
    {
      id: 'validating',
      name: 'Validating',
      category: 'review',
      agentHint: 'Move here when the change is written and you are checking it works.',
    },
    {
      id: 'complete',
      name: 'Complete',
      category: 'done',
      humanOnly: true,
      agentHint:
        'You may not set this. The user marks work complete, or a commit message closes it.',
    },
  ],
}

/** What the agent is doing right now. Deliberately NOT persisted: it is
 *  volatile runtime state that flips many times per turn. Nimbalyst makes the
 *  same split — the durable workflow `phase` is tracked, the operational status
 *  is not, or it would saturate the activity log with noise. */
export type AgentState =
  | { kind: 'idle' }
  /** Accepted, and waiting for a concurrency slot. It has a card and a key but
   *  no process, no worktree and no branch yet.
   *
   *  It exists because a queued run used to have NO card at all: `start()`
   *  returned a run id without registering an agent, so `manager.list()` never
   *  mentioned it, `followKey()` could not find it, and `getState()` cleared
   *  the selection — the user pressed send on a full board and got the
   *  new-session screen back with their prompt gone and no card anywhere. It is
   *  also what made a subtask "invisible until it starts". */
  | { kind: 'queued'; since: number }
  | { kind: 'starting' }
  /** `subagent` is the tool a Task's subagent is running right now. Without it
   *  a Task shows as one motionless "Task…" for however many minutes it takes,
   *  which is the single most common reason the board looks frozen when it is
   *  in fact busy. */
  | { kind: 'working'; tool?: string; subagent?: string }
  | { kind: 'needsInput'; question: string; requestId: string }
  | { kind: 'done'; summary: string; costUsd?: number }
  | { kind: 'error'; message: string }

export function columnById(board: BoardConfig, id: StatusId): ColumnDef | undefined {
  return board.columns.find((c) => c.id === id)
}

export function isHumanOnly(board: BoardConfig, id: StatusId): boolean {
  return columnById(board, id)?.humanOnly === true
}

/** A column meaning "the agent is done and wants you to look". Moving into one
 *  is what the ready-to-test notification fires on, so it is a rule rather than
 *  a hardcoded column id — a custom board must still be able to say "here". */
export function isReviewColumn(board: BoardConfig, id: StatusId): boolean {
  return columnById(board, id)?.category === 'review'
}

/** A column meaning "the agent has started changing things". Moving into one is
 *  the moment it has explored enough to know what the work is, which is why the
 *  ask for a real card title rides on that move — so it is a rule, like the
 *  others here, and a custom board can say where that moment is. */
export function isStartedColumn(board: BoardConfig, id: StatusId): boolean {
  return columnById(board, id)?.category === 'started'
}

/**
 * When a run ENDED and left its card in a started column, or undefined.
 *
 * A card in "Implementing" means an agent is changing code. With no agent
 * running it means something else entirely — an agent stopped there and did not
 * say why — and the board drew the two identically. Found on a real board: two
 * cards sat in Implementing with the work actually finished (PR open, tests
 * green) because both agents ended their turn mid-thought, waiting on subagents
 * that had already reported. Neither ever called `set_phase`.
 *
 * The TIME is returned, not a flag, for the same reason `interrupted` carries
 * one: "stopped 2 minutes ago" and "stopped last Tuesday" call for different
 * reactions, and a bare badge cannot tell them apart.
 *
 * Deliberately NOT reported for `interrupted` sessions — that is a louder and
 * different fact (the host went away, the process is gone) and a card must not
 * claim two things at once. Nor for a session with no worktree: it never ran,
 * so there is nothing it failed to hand back.
 */
export function stalledSince(
  board: BoardConfig,
  s: {
    phase: StatusId
    updated: number
    worktree?: string
    running?: boolean
    interrupted?: number
    archived?: boolean
  },
): number | undefined {
  if (s.running || s.interrupted || s.archived || !s.worktree) return undefined
  if (!isStartedColumn(board, s.phase)) return undefined
  return s.updated
}

/** A column meaning "this one is off the agent's plate" — handed back for
 *  review, or approved. What a subtask has to reach before its parent can say
 *  the whole task is ready. */
export function isSettledColumn(board: BoardConfig, id: StatusId): boolean {
  const c = columnById(board, id)?.category
  return c === 'review' || c === 'done'
}
