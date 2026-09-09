/**
 * WHO IS LOOKING AT WHAT.
 *
 * The board — cards, columns, counts, composer defaults — is the same for every
 * surface. The SESSION each surface is looking at is not, and that used to be a
 * single pair of host globals (`mode`, `selectedKey`) shared by all of them. So
 * a second surface could only ever be a mirror: opening a chat on a phone
 * retargeted the editor, and opening one in the editor retargeted the phone.
 *
 * This is the registry that replaces the pair. It is deliberately vscode-free
 * and pure, because the rules in it are the ones that must not be got wrong and
 * they are not visible to the type system:
 *
 * - A sink with NO entry falls back to the host's defaults. That is what "a
 *   brand-new client is told to open first" means, and it is why nothing has to
 *   seed this map — a side bar that has never been clicked shows what the
 *   editor's selection says, exactly as before.
 * - A LOCAL surface moves the host's defaults; a REMOTE one never does. In the
 *   editor "the selected card" and "the card I am looking at" are the same
 *   sentence, and a menu item, the status bar and every deletion mean the
 *   former. On a phone they are not: a person opening a chat on their way home
 *   must not retarget the menu item somebody is about to click at the desk.
 * - A watch FOLLOWS the run-id -> session-id swap on its own. The redirect is
 *   per watcher: the surface watching that run is carried across and the others
 *   are left alone. A watch whose card has gone is cleared, which is what makes
 *   a deleted session release the review data it was holding.
 *
 * The map is bounded by the number of surfaces, never by the store: `keys()` is
 * what review data is cached for, and it is the reason that cache cannot grow
 * with the number of sessions.
 */

/** Which screen a surface is on. */
export type Mode = 'kanban' | 'chat'

/**
 * WHO a state is for — one surface, not one machine.
 *
 * Also the key of the model-catalogue memo, which is per sink and never global:
 * two surfaces can be watching two sessions on two backends, so one memo would
 * hand whichever painted second nothing at all.
 */
export type StateSink = 'sidebar' | 'panel' | 'remote'

/** What one surface is looking at. */
export type Watch = { key: string | undefined; mode: Mode }

/**
 * Is this surface's choice the EDITOR's choice?
 *
 * Its own function because it is the whole security-of-attention rule in one
 * line, and because "everything except remote" is the answer that stays right
 * when a fourth sink is added: a new LOCAL surface should move the selection,
 * and anything reached over a wire should not.
 */
export const isLocalSink = (sink: StateSink | undefined): boolean => sink !== 'remote'

/**
 * Does this surface DRAW a conversation?
 *
 * The side bar draws a title, two counts, two buttons and a list of session
 * names. `forControl()` has always stripped the transcript on the way out to
 * it — which saved the BYTES and not the WORK: the state was built once for
 * everybody, so somebody had to build it. Now every surface gets its own
 * state, and building one per repaint that is thrown away is exactly the
 * "nothing expensive per streamed token" rule broken in a new place. So a
 * surface that draws no conversation is not given one to throw away.
 */
export const drawsTranscript = (sink: StateSink): boolean => sink !== 'sidebar'

export class Watches {
  private readonly bySink = new Map<StateSink, Watch>()
  private readonly defaults: () => Watch

  /** `defaults` is read every time rather than copied: the host's own selection
   *  moves for reasons that have nothing to do with a surface — a new run, a
   *  fork, an archive — and a snapshot taken here would go stale silently. */
  constructor(defaults: () => Watch) {
    this.defaults = defaults
  }

  /** What this surface is looking at, or the host's defaults when it has never
   *  said. Never undefined: every surface is looking at something. */
  of(sink: StateSink | undefined): Watch {
    const own = sink ? this.bySink.get(sink) : undefined
    return own ?? this.defaults()
  }

  /** Record part of what a surface is looking at, over whatever it already had
   *  (or over the defaults, the first time it says anything). */
  set(sink: StateSink | undefined, patch: Partial<Watch>): void {
    if (!sink) return
    this.bySink.set(sink, { ...this.of(sink), ...patch })
  }

  /** Every session somebody is watching, the host's own default included.
   *  What review data is loaded for, and the bound on how much is kept. */
  keys(): Set<string> {
    const keys = new Set<string>()
    const fallback = this.defaults().key
    if (fallback) keys.add(fallback)
    for (const w of this.bySink.values()) if (w.key) keys.add(w.key)
    return keys
  }

  /**
   * Move every watch across the run-id -> session-id swap.
   *
   * `follow` is the caller's own resolver — `followKey` in the manager, the one
   * place that knows how a run becomes a session — so this holds the policy of
   * WHOSE key moves and none of the policy of what it moves to.
   *
   * A key that resolves to NOTHING is kept, not dropped. Its card is gone, and
   * a surface pointed at a card that no longer exists has to be TOLD: a watch
   * quietly reset to nothing draws the new-session screen, which is "my chat
   * disappeared" with no explanation available anywhere on the board. The slice
   * announces it instead (`vanished`), and the watch stays until the surface
   * chooses something else.
   */
  followAll(follow: (key: string | undefined) => string | undefined): void {
    for (const [sink, w] of this.bySink) {
      if (!w.key) continue
      const key = follow(w.key)
      if (key && key !== w.key) this.bySink.set(sink, { ...w, key })
    }
  }

  /**
   * A card was RE-KEYED: a fork adopts the old card's phase, tags and worktree
   * under a new id, and the old key stops existing.
   *
   * Every surface watching the old one follows, wherever the fork was asked
   * for, because it is the same work under a new name — not a redirect a client
   * could derive, and not a reason to drag surfaces that were looking at
   * something else.
   */
  retarget(from: string, to: string): void {
    for (const [sink, w] of this.bySink) {
      if (w.key === from) this.bySink.set(sink, { ...w, key: to })
    }
  }

  /**
   * THE HOST ITSELF opened something — a command, the side bar's session list,
   * a search hit, a new run, a fork, a deletion.
   *
   * Answers what the host's OWN selection should become, and moves the
   * surfaces that follow it. Written as one function rather than a `resetLocal`
   * beside an `if` at each of the ten call sites, because the two halves are
   * one rule and a call site that remembered only half of it is exactly how a
   * remote page ends up retargeting the editor.
   *
   * `remote` is whether the dispatch came from the page (the host reads it off
   * the ambient dispatch context). When it did, the host's selection does NOT
   * move — the page's own watch does, and `current` comes back untouched.
   */
  hostSelect(key: string | undefined, remote: boolean, current: string | undefined): string | undefined {
    if (remote) {
      this.set('remote', { key })
      return current
    }
    this.resetLocal()
    return key
  }

  /**
   * Drop every LOCAL surface back to the host's defaults.
   *
   * In the editor "the selected card" and "the card I am looking at" are one
   * sentence: clicking a session in the side bar list opens it in the panel,
   * and a panel still showing its own choice would read as the click doing
   * nothing. A REMOTE page keeps what it had, for the same reason its own click
   * does not move this: it is somewhere else, with somebody else's attention.
   */
  resetLocal(): void {
    for (const sink of [...this.bySink.keys()]) if (isLocalSink(sink)) this.bySink.delete(sink)
  }

  /** For tests and diagnostics: the sinks that have actually said something. */
  sinks(): StateSink[] { return [...this.bySink.keys()] }
}
