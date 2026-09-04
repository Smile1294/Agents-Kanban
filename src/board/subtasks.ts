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
