/**
 * What is waiting on YOU, across every card — one list, oldest first.
 *
 * The complaint every multi-agent tool gets, quoted in the research behind
 * this: "two of them are waiting on a question you never saw, one crashed
 * twenty minutes ago". The board drew each of those on its own card, in its
 * own column, and a question on a card scrolled out of view was a question
 * nobody answered while the agent sat blocked and billed nothing and did
 * nothing. So the host derives them ONCE per board pass, from the cards it has
 * already built, and every surface draws the same list: a strip on the board,
 * a count in the status bar.
 *
 * It is derived, never stored, and it is only what the cards already say — so
 * it cannot disagree with them. Plain and pure; `attention.test.ts`.
 */
import type { BoardConfig } from './config.ts'
import { isReviewColumn } from './config.ts'

export type AttentionKind = 'question' | 'failed' | 'interrupted' | 'stalled' | 'review'

export interface AttentionItem {
  key: string
  title: string
  kind: AttentionKind
  /** One line: what is waiting, in the card's own words where it has them. */
  why: string
  /** When it started waiting, when known — the strip shows its AGE. */
  since?: number
}

/** The slice of a card this reads. `CardState` satisfies it structurally. */
export interface AttentionCard {
  key: string
  title: string
  phase: string
  archived?: boolean
  interrupted?: number
  stalled?: number
  testPlan?: { at: number; autoCheck?: { ok: boolean; at: number } }
  reviewComments?: number
  agent?: { kind: string; message?: string; lastEventAt?: number; since?: number }
}

/** Blocking an agent first; then the ones where work was lost or stopped;
 *  then the ones that are simply ready. */
const RANK: Record<AttentionKind, number> = { question: 0, failed: 1, interrupted: 2, stalled: 3, review: 4 }

export function attentionFor(cards: readonly AttentionCard[], board: BoardConfig): AttentionItem[] {
  const out: AttentionItem[] = []
  for (const c of cards) {
    if (c.archived) continue
    const a = c.agent
    if (a?.kind === 'needsInput') {
      out.push({ key: c.key, title: c.title, kind: 'question', why: 'is waiting for your answer', ...(a.lastEventAt ? { since: a.lastEventAt } : {}) })
    } else if (a?.kind === 'error') {
      out.push({ key: c.key, title: c.title, kind: 'failed', why: `failed: ${(a.message ?? 'the run ended with an error').split('\n')[0]!.slice(0, 140)}`, ...(a.lastEventAt ? { since: a.lastEventAt } : {}) })
    } else if (!a && c.interrupted) {
      out.push({ key: c.key, title: c.title, kind: 'interrupted', why: 'was cut off mid-turn when the editor closed', since: c.interrupted })
    } else if (!a && c.stalled) {
      out.push({ key: c.key, title: c.title, kind: 'stalled', why: 'stopped without handing its work back', since: c.stalled })
    } else if (isReviewColumn(board, c.phase) && c.testPlan?.autoCheck && !c.testPlan.autoCheck.ok && (!a || a.kind === 'done' || a.kind === 'idle')) {
      // Ranked with the failures: the board's own check of it did not pass, so
      // "ready to test" would send the user to test something known broken.
      out.push({ key: c.key, title: c.title, kind: 'failed', why: 'failed the board\'s auto-check', since: c.testPlan.autoCheck.at })
    } else if (isReviewColumn(board, c.phase) && c.testPlan && !c.reviewComments && (!a || a.kind === 'done' || a.kind === 'idle')) {
      out.push({ key: c.key, title: c.title, kind: 'review', why: 'is ready for you to test', since: c.testPlan.at })
    }
  }
  return out.sort((x, y) => RANK[x.kind] - RANK[y.kind] || (x.since ?? Infinity) - (y.since ?? Infinity))
}

/** The status-bar sentence: the blocking count first, because that one costs time. */
export function attentionSummary(items: readonly AttentionItem[]): string | undefined {
  if (!items.length) return undefined
  const blocking = items.filter((i) => i.kind === 'question').length
  const rest = items.length - blocking
  if (blocking && rest) return `${blocking} waiting on you · ${rest} more need you`
  if (blocking) return `${blocking} waiting on you`
  return `${rest} need${rest === 1 ? 's' : ''} you`
}
