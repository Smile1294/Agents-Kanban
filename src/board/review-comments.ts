/**
 * Review comments: line comments on an agent's diff, sent back to it as ONE
 * message.
 *
 * The loop every parallel-agent tool is built around (Vibe Kanban, Conductor,
 * Copilot's "fix batch"): read the diff, leave comments where the lines are,
 * hand all of them back at once. The board had the diff and a composer and
 * nothing between them — the only way to say "line 40 is wrong" was to type
 * the path and line into the chat by hand.
 *
 * This file holds the DRAFTS and writes the prompt; `extension.ts` wires it to
 * VS Code's comment controller (the "+" in the gutter of any file inside an
 * agent's worktree, so the right side of every diff qualifies). Plain Node, no
 * `vscode`, so the part that decides what the agent is told is testable.
 *
 * Two rules:
 *
 *  - **Drafts are keyed by the CARD and survive nothing they should not.** They
 *    live in memory until sent or discarded; a card that changes key (a fork, a
 *    run adopting its session id) takes its drafts along (`rekey`).
 *  - **The prompt quotes the line as it was commented on.** An agent reading
 *    "line 40" after it has already edited the file is looking at a different
 *    line; the quote is what lets it find the one you meant.
 */

export interface ReviewDraft {
  /** Stable within the card, for delete. */
  id: string
  /** Worktree-relative path, forward slashes. */
  file: string
  /** 1-based, inclusive. */
  line: number
  endLine?: number
  text: string
  /** The commented lines' text when the comment was written. */
  quote?: string
  at: number
}

export const MAX_DRAFTS = 50
const MAX_QUOTE = 400

export class ReviewDrafts {
  private readonly byCard = new Map<string, ReviewDraft[]>()
  private seq = 0

  add(card: string, d: Omit<ReviewDraft, 'id' | 'at'>): ReviewDraft | undefined {
    const text = d.text.trim()
    if (!text) return undefined
    const list = this.byCard.get(card) ?? []
    if (list.length >= MAX_DRAFTS) return undefined
    const draft: ReviewDraft = {
      id: `rc-${++this.seq}`,
      file: d.file.replace(/\\/g, '/'),
      line: Math.max(1, Math.floor(d.line)),
      ...(d.endLine && d.endLine > d.line ? { endLine: Math.floor(d.endLine) } : {}),
      text: text.slice(0, 4000),
      ...(d.quote?.trim() ? { quote: d.quote.replace(/\s+$/g, '').slice(0, MAX_QUOTE) } : {}),
      at: Date.now(),
    }
    list.push(draft)
    this.byCard.set(card, list)
    return draft
  }

  remove(card: string, id: string): boolean {
    const list = this.byCard.get(card)
    if (!list) return false
    const next = list.filter((d) => d.id !== id)
    if (next.length === list.length) return false
    if (next.length) this.byCard.set(card, next)
    else this.byCard.delete(card)
    return true
  }

  list(card: string): ReviewDraft[] {
    return [...(this.byCard.get(card) ?? [])]
  }

  count(card: string): number {
    return this.byCard.get(card)?.length ?? 0
  }

  /** Remove and return a card's drafts — what "send" does. */
  take(card: string): ReviewDraft[] {
    const list = this.byCard.get(card) ?? []
    this.byCard.delete(card)
    return list
  }

  rekey(from: string, to: string): void {
    const list = this.byCard.get(from)
    if (!list || from === to) return
    this.byCard.delete(from)
    this.byCard.set(to, [...(this.byCard.get(to) ?? []), ...list])
  }

  cards(): string[] {
    return [...this.byCard.keys()]
  }
}

/**
 * The one message a review becomes. Ordered by file then line, so it reads
 * like the diff; numbered, so the agent can answer "1: done, 2: kept because…"
 * and the test plan it writes next can say what happened to each.
 */
export function reviewPrompt(drafts: readonly ReviewDraft[], reviewColumn = 'validating'): string {
  const sorted = [...drafts].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const lines = [
    `Review comments on your changes — ${sorted.length} of them. Address each one: change the code, or say why not.`,
    `When you are done, move back to "${reviewColumn}" with a howToTest whose summary says what you did for each comment, by number.`,
    '',
  ]
  sorted.forEach((d, i) => {
    const where = `${d.file}:${d.line}${d.endLine ? `-${d.endLine}` : ''}`
    lines.push(`${i + 1}. \`${where}\``)
    if (d.quote) {
      for (const q of d.quote.split('\n').slice(0, 6)) lines.push(`   > ${q}`)
    }
    for (const t of d.text.split('\n')) lines.push(`   ${t}`)
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}
