---
name: git-worktrees
description: One worktree per task — creation on a task branch, the load-bearing ignore rule, diffs and review data, commit, the merge that stops before the commit, MERGE_HEAD as the only truth, the per-repo lock, and what the Run button starts
paths:
  - src/git/*.ts
  - src/run/recipe.ts
  - src/run/app.ts
  - src/run/autocheck.ts
tests:
  - src/git/__tests__/worktree.test.ts
  - src/git/__tests__/lock.test.ts
  - src/run/__tests__/recipe.test.ts
  - src/run/__tests__/app.test.ts
  - src/run/__tests__/autocheck.test.ts
last_verified: 2026-09-07
---
# Git worktrees, review and merge

## Owns

The whole return path for an agent's work: an isolated checkout per session,
what changed in it, committing it, merging it back into the user's branch
without committing on their behalf, refusing when the repository is not in a
state to take it — plus the per-repository lock everything destructive runs
under, and whole-worktree checkpoints on private refs (`src/git/checkpoints.ts`, taken
before every message the board sends, restored by "Try again from here"), and
the detection of how to start the app inside a worktree — and `src/run/app.ts`,
which starts that same recipe for an AGENT (`AppProcesses`: child processes in
their own process group, output in a ring buffer, the port taken only from the
recipe, a `PORT` we chose, or a URL printed on the child's OWN output — never a
scan, because another worktree's server on 3000 shows old code and looks fine;
`announcedUrl`; `killTree` waits for the whole GROUP, since `sh -c` dies at
once while its server still holds the port).

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

- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · a fresh worktree is SET UP before it runs: `PrepareStep` / `prepareFor` (the main checkout's `.env`, else `.env.example` + `key:generate`; `composer install` without `vendor/`; the lockfile's install without `node_modules/` — `npm install --no-package-lock` when none is committed, or the review move would commit one; the worktree's OWN SQLite created and migrated, a shared database never); Laravel also starts `php artisan queue:listen --tries=1` unless `QUEUE_CONNECTION` is sync/null, and `APP_URL` is the chosen port; `runPrepare` in `app.ts` runs it into the app's log. `runAutoCheck` takes `paths` (the pages the agent visited, the plan's local links) and records `pages`. Verified on a real Laravel 13 worktree: setup, Vite, the queue worker processing a dispatched job in the worktree, artisan serve.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · `src/run/autocheck.ts` — the board's OWN check at review time: `uiFilesIn` (what a browser shows), `e2eScript` (`test:e2e`, `e2e`, `test:browser`, `playwright`…), `runAutoCheck` (start/reuse the app, open it in a context of its own, record load errors and a screenshot, run the suite with `BASE_URL`/`PLAYWRIGHT_BASE_URL`, never throw), `autoCheckPrompt`. `autocheck.test.ts` against real processes and Chromium.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · `src/git/checkpoints.ts` — whole-worktree checkpoints: a temporary index seeded from the real one, `write-tree`, a commit whose parent is HEAD, on `refs/agentskanban/checkpoints/<branch>/<messageId>`; `restoreCheckpoint` resets the branch to that HEAD when it moved (`--mixed`), `git restore --worktree` from the checkpoint, and removes files created since (ignored files never touched); `dropCheckpoints` with the worktree. `checkpoints.test.ts` against real repositories.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · `src/run/app.ts` — `AppProcesses`, the Run recipe started as child processes for an agent (`app_start`), with its output kept, the port never scanned for, and the whole process group killed on stop; `app.test.ts` against real servers.
- 2026-09-10 · claude/frontend-sync-chat-freeze-wb6a2s · `realContains(root, abs)`
  — the containment check for an ABSOLUTE path, which `realResolveInWorktree`
  refuses by policy. It is what decides whether a `Read` is auto-allowed or
  asks. Symlinks are followed on both sides for the reason its sibling follows
  them: the agent can write inside its worktree, so `ln -s ~/.ssh keys` would
  otherwise make the home directory look local. A path that does not exist
  answers false — it asks, which is the safe direction. Gate in
  `worktree.test.ts` against real files and a real symlink.

- 2026-09-09 · task · Composer dependencies are prepared before every session launch when a worktree lacks `vendor/autoload.php`, so Composer-backed MCP servers can start.
- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
- 2026-09-07 · task/S5kc3 · `changedFiles()` and `fileStatuses()` pass `-uall`, so untracked files in a new directory are listed one by one; found because the knowledge-file gate could not see the new `docs/codemap/` files and refused its own branch.
- 2026-09-07 · task/S116g8 · dead-code sweep: `pendingMergeMessage` de-exported — module-private, called only in private method bodies.
