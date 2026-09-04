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

/** A column meaning "this one is off the agent's plate" — handed back for
 *  review, or approved. What a subtask has to reach before its parent can say
 *  the whole task is ready. */
export function isSettledColumn(board: BoardConfig, id: StatusId): boolean {
  const c = columnById(board, id)?.category
  return c === 'review' || c === 'done'
}
