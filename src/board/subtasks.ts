/** The thread between a split task and the pieces it became.
 *
 * A session can decide its brief is really two unrelated jobs and split itself
 * (`split_task`). Each piece becomes a real session with its own worktree, its
 * own branch and its own card — a subtask in the Validating column belongs in
 * the Validating column, which is the entire point of a board. What is missing
 * from that picture is the thread: without it a split just makes two cards
 * appear from nowhere.
 *
 * The relation is stored ONCE, on the child (`SessionMeta.parent`). A card's
 * key changes when Claude Code assigns it a session id, and one pointer can be
 * repointed (`MetaStore.rename`) where a list on the parent is a second copy of
 * the truth waiting to disagree with the first. So the parent's half is derived
 * here, on every render, and cannot drift.
 *
 * Plain Node, no `vscode` — the view model is testable without an editor.
 */
import { isSettledColumn, type BoardConfig } from './config.ts'

/** One subtask, as the parent's card shows it. */
export interface SubtaskRef {
  key: string
  title: string
  phase: string
  /** In a review or done column: this piece is off the agent's plate. */
  ready: boolean
}

/** The shape this needs from a card. `UiCard` satisfies it structurally. */
export interface SubtaskLinkable {
  key: string
  title: string
  phase: string
  parent?: string
  parentTitle?: string
  subtasks?: SubtaskRef[]
}

/**
 * Fill in `parentTitle` on every subtask and `subtasks` on every parent.
 *
 * A subtask whose parent is not in `cards` — archived, deleted, filtered out —
 * gets no `parentTitle` and renders as an ordinary card. That is the right
 * failure: a reference to something the user cannot see is worse than none.
 */
export function linkSubtasks(cards: SubtaskLinkable[], board: BoardConfig): void {
  const byKey = new Map(cards.map((c) => [c.key, c]))
  for (const c of cards) {
    if (!c.parent || c.parent === c.key) continue
    const parent = byKey.get(c.parent)
    if (!parent) continue
    c.parentTitle = parent.title
    ;(parent.subtasks ??= []).push({
      key: c.key,
      title: c.title,
      phase: c.phase,
      ready: isSettledColumn(board, c.phase),
    })
  }
}

/** How many of a card's subtasks are off the agent's plate, and how many there
 *  are. The parent is testable as a whole only when the two are equal. */
export function subtaskProgress(card: SubtaskLinkable): { ready: number; total: number } {
  const subtasks = card.subtasks ?? []
  return { ready: subtasks.filter((t) => t.ready).length, total: subtasks.length }
}

/** Why a parent is not yet ready to roll up, or that it is. */
export type RollUp =
  /** This card was never split. */
  | { kind: 'notSplit' }
  /** Fewer children exist than were approved — some have not started yet. */
  | { kind: 'pending'; onBoard: number; approved: number }
  /** Every child exists; not all of them are settled. */
  | { kind: 'working'; ready: number; total: number }
  /** All of them are off the agent's plate. `total` is what the notification
   *  says, and it must be the number the user approved. */
  | { kind: 'ready'; total: number }

/**
 * Is a split parent ready to be handed back to the user?
 *
 * Pure, and separate from the host, because the wrong answer here is a
 * NOTIFICATION — the least recoverable kind of wrong. It shipped as one: the
 * host counted children by asking the sidecar which sessions name this parent,
 * and a subtask held behind `maxConcurrentAgents` is not in the sidecar at all.
 * `start()` pushes it onto an in-memory queue and returns before `launch()`
 * writes anything. `MAX_SUBTASKS` is 4 and the concurrency default is 3, so the
 * last piece of a four-way split is ALWAYS queued — which made the roll-up see
 * 2 children of 4, find both settled, move the parent to review and announce
 * "All 2 subtasks are ready for you to test" over two agents that had not run.
 *
 * `approved` is `SessionMeta.fanout`. It is ABSENT for a split made by a build
 * that did not record it, and then the old count-what-exists behaviour stands —
 * which is the best that can be done for a card whose intent was never written
 * down, and is not made worse by guessing.
 */
export function rollUpState(
  phases: readonly string[],
  approved: number | undefined,
  board: BoardConfig,
): RollUp {
  if (!phases.length) return { kind: 'notSplit' }
  if (approved !== undefined && phases.length < approved) {
    return { kind: 'pending', onBoard: phases.length, approved }
  }
  const ready = phases.filter((p) => isSettledColumn(board, p)).length
  // `phases.length`, not `approved`: once every approved child has a card the
  // two agree, and a card whose `fanout` predates the field has only this.
  return ready === phases.length
    ? { kind: 'ready', total: phases.length }
    : { kind: 'working', ready, total: phases.length }
}
