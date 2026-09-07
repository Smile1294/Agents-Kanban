---
name: git-worktrees
description: One worktree per task — creation on a task branch, the load-bearing ignore rule, diffs and review data, commit, the merge that stops before the commit, MERGE_HEAD as the only truth, the per-repo lock, and what the Run button starts
paths:
  - src/git/*.ts
  - src/run/recipe.ts
tests:
  - src/git/__tests__/worktree.test.ts
  - src/git/__tests__/lock.test.ts
  - src/run/__tests__/recipe.test.ts
last_verified: 2026-09-07
---
# Git worktrees, review and merge

## Owns

The whole return path for an agent's work: an isolated checkout per session,
what changed in it, committing it, merging it back into the user's branch
without committing on their behalf, refusing when the repository is not in a
state to take it — plus the per-repository lock everything destructive runs
under, and the detection of how to start the app inside a worktree.

## Files

**`src/git/worktree.ts`** (~960 lines). `WorktreeService`: `create(repo, id,
title, base, onCreate?)` — `git worktree add -b task/<id>-<slug>
.agentskanban/worktrees/<name> <base>`, idempotent per branch, `ensureIgnored()`
(asks `check-ignore` BEFORE laying the belt, or the team's `.gitignore` copy is
never written) and `ensureExcluded()` (`.git/info/exclude` — cannot be
discarded, cannot move with a branch, cannot dirty the tree) first, prune +
remove on failure; `list`, `remove`, `prune`, `status`, `isClean`,
`currentBranch`, `aheadOf`, `mergeBase`, `lastCommit`; `changedFiles(path,
base)` (committed vs merge-base PLUS the working tree, untracked included — with
`status --porcelain -uall`, so a new directory is reported as its FILES and not
as one `dir/` entry no owner glob matches; the knowledge-file gate reads this);
`fileStatuses` / `review(path, base)` → `WorktreeReview` (committed vs
uncommitted, so Merge is disabled until there is something to merge; `-uall`
here too, so every new file gets its own diff row);
`commitAll(path, message)`; `merge(repo, branch, into)` — `--no-ff --no-commit`,
refusing with a DESCRIBED reason on: a merge already pending (checked BEFORE the
clean check, or the generic "commit your own changes" sends the user hunting for
an edit this extension made), a dirty main tree (`dirtyMessage()` tells our mess
from theirs), nothing to merge, the wrong branch; conflicts are left in
progress; `pendingMerge(repo)` reads `MERGE_HEAD` (never a flag of ours — a flag
dies with the window and is blind to a merge started in a terminal) and answers
`conflicted` too; `commitMerge`, `abortMerge`; `show(ref, file)` (bytes
untouched, for the diff's left side); `parsePorcelainLine` / `unquotePath`
(`status --porcelain` C-quotes paths with spaces; `diff --name-status` does not);
`resolveInWorktree` / `realResolveInWorktree` (containment for model-written link
targets — the agent can `ln -s ~/.ssh` in its own worktree); `slug`;
`KANBAN_DIR = '.agentskanban'`, `DEFAULT_WORKTREE_ROOT`. Test: `worktree.test.ts`
against real repositories — it found the porcelain-trimming bug that ate a
filename.

**`src/git/lock.ts`**. `withRepoLock(repoRoot, fn)` — a per-repo FIFO mutex.
The slot is claimed SYNCHRONOUSLY before any `await`; `repoRoot` must already be
canonical (canonicalise at the call site); the chain advances on reject as well
as resolve. VS Code's own Git extension issues commands against the same repo,
and a merge is the least forgiving moment for two of them to overlap. Test:
`lock.test.ts`.

**`src/run/recipe.ts`**. `detect(env)` → `RunRecipe | undefined` — what starts
the app in a worktree, in order: `agentsKanban.runCommand`; the project's own
per-worktree launcher `wt` (it owns the port, the database and the session
cookie — none inferable from a file tree; `wtSlug` must match `wt`'s own
`slug_of`, lowercase, non-`[a-z0-9]` → `_`, truncated to 40); Laravel with a port
chosen here; a `package.json` `dev`/`start`/`serve` script. `waitForPort`,
`isListening`, `freeTcpPort`, `readWtRegistry`, `findWt` (`~/.local/bin` too —
a GUI-launched VS Code has no login-shell PATH), `COMMON_DEV_PORTS`. Never
returns a URL it cannot justify: a plausible `localhost:8000` belonging to the
main checkout shows the OLD code and reads as "the change did nothing". Test:
`recipe.test.ts`.

## How it works

See [flows.md](flows.md) *Handing work back, and the merge*. The state machine
the review panel draws: uncommitted changes → *Commit* → commits ahead of base →
*Merge into main…* (modal: "lands UNCOMMITTED") → `MERGE_HEAD` exists, staged
files listed, every card's Merge disabled → *Commit merge* / *Abort merge*; a
conflict is the same banner in red. `s.pendingMerge` is in the webview's
`chromeSig()` because a merge started mid-turn arrives between two streaming
frames. Worktree cleanup is offered at `complete`, never automatic.

## Change recipes

- **A new refusal reason for `merge()`.** A `MergeResult` variant with a
  described message; check it in the right ORDER (ours before theirs); the
  webview shows a refusal on a clicked path as a MODAL, never a toast.
- **A new git query.** Through `git()` (trims) or `gitRaw()` (strips one
  trailing newline) — never add a `.trim()` in a shared helper; `show()` returns
  bytes untouched.
- **Anything that writes into the user's repository.** Don't. The one exception
  is the ignore rule, and it exists in two places for a reason.
- **A new launcher for the Run button.** A tier in `detect()`, after the
  project's own launcher and before the guesses; it must know its port or
  return none.

## Invariants

- A merge lands UNCOMMITTED; `ok: true` does not mean it is on the branch.
- `pendingMerge()` reads git, not a flag.
- The ignore rule lives in two places, and the untracked one is the one that
  works; `.gitignore` can never be re-asserted during a merge (an uncommitted
  edit to it is precisely what blocks the merge).
- Destructive operations run under the per-repo lock, serialised FIFO.
- Subtasks fork from the parent's BASE, so they are ordinary task branches the
  existing diff/merge/cleanup paths handle one at a time.
- No seeding: no `.env` copy, no `node_modules` link; `onCreate` opts in.

## Open work

- A conflict-fixing agent (we surface conflicts and offer Abort).
- Nothing sequences four merges after a fan-out.
- The Run button never stops what it started; nothing tracks which worktrees
  are serving.

## Recent changes

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
- 2026-09-07 · task/S5kc3 · `changedFiles()` and `fileStatuses()` pass `-uall`, so untracked files in a new directory are listed one by one; found because the knowledge-file gate could not see the new `docs/codemap/` files and refused its own branch.
