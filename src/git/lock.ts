/** Serialises destructive git operations per repository.
 *
 * Several agents run at once and `git worktree add/remove` mutates shared repo
 * state (.git/worktrees, the ref store, index.lock). Two concurrent calls
 * produce "fatal: Unable to create '.git/index.lock'" or a half-registered
 * worktree. Nimbalyst hit this and added the same mutex; in VS Code it matters
 * more, because the built-in Git extension issues commands against the same
 * repo concurrently.
 *
 * Queueing is deliberately SYNCHRONOUS: a caller claims its slot before any
 * await, so callers are served in call order. An earlier version resolved the
 * path with `realpath` first, and the await let callers enqueue in whatever
 * order that settled — still mutually exclusive, but arbitrary order.
 * Canonicalise the path at the call site instead (`git rev-parse --show-toplevel`
 * already returns one).
 */

/** repo path -> tail of the queue (always resolves, never rejects). */
const chains = new Map<string, Promise<void>>()

/** Run `fn` with exclusive access to `repoRoot`. Callers are served FIFO.
 *  `repoRoot` must already be canonical — see the note above. */
export function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const prior = chains.get(repoRoot) ?? Promise.resolve()

  // Run once the predecessor settles, resolved or rejected — one caller's
  // failure must not deadlock everyone queued behind it.
  const result = prior.then(fn, fn)

  const tail = result.then(() => {}, () => {})
  chains.set(repoRoot, tail)
  void tail.then(() => {
    // Only the current tail may clear the entry, or we would drop a live queue.
    if (chains.get(repoRoot) === tail) chains.delete(repoRoot)
  })

  return result
}

/** Test hook: how many repos currently have a queue. */
export function _pendingRepos(): number { return chains.size }
