# Decisions and postmortems

Why the code looks like this, and the traps already fallen into. Written so the
same ground isn't re-litigated or the same bug re-introduced.

---

## Decisions

### Read Claude Code's session store; write nothing to the repo

**Rejected:** our own `.kanban/*.md` files (v1), and a SQLite database
(Nimbalyst's approach).

v1 wrote task cards as markdown into the working tree. It diffed nicely in
theory, but every agent turn produced a git diff and the repo filled with board
state. The user's words: *"it floods my repo."*

Claude Code already stores every session as JSONL and the SDK exposes it, so
duplicating that was pure cost. Sessions, transcripts and titles now come from
`listSessions()` / `getSessionMessages()` / `renameSession()`.

The unlooked-for benefit: the board became a view over real work. A session
started in the terminal appears on it; one started here resumes with
`claude --resume`.

**Trade-off accepted:** the board is per-machine. Phase and tags live in
extension storage, so they don't follow the repo to another machine. Judged
correct — board state is not source code.

### A sidecar for phase, tags and worktree mapping

Claude Code has no concept of these. `tagSession()` stores exactly one string,
which the phase would consume, leaving no room for tags.

**Rejected:** encoding several values into the single tag. Fragile, and it
fights the CLI's own use of that field.

`MetaStore` mirrors Nimbalyst's `ai_sessions.metadata` JSON column, including the
bounded activity log — but in extension global storage, not the repo.

### One entity, two views

**Rejected:** Nimbalyst's split between a tracker board and a session board,
which are separate components meeting only through link fields.

A card and a session are the same thing at two zoom levels. This removes a whole
class of "which one is the truth" bugs, and answers directly what was asked for:
starting a session from chat puts it on the board, because it *is* the board's
card.

### Phase is the column; no reorder

Taken verbatim from Nimbalyst. Writing `phase` is the move. One field, one
source of truth, no desync between "what column is this in" and "what state is
this in".

**Consequence accepted:** no manual ordering within a column. Sessions sort by
recency. `fractional-indexing` was removed along with the task model.

### Archive is a soft flag; delete is explicit and confirmed

Nimbalyst's `is_archived`. Archiving hides the card and is reversible; the
transcript is untouched because Claude Code owns it. Deleting calls
`deleteSession()` and is irreversible, so it goes through a modal confirmation
that states the git worktree and branch are left alone.

### In-process MCP, not an HTTP server

Nimbalyst runs a localhost HTTP+SSE server with a bearer token, port-scanning
from 3456, because Electron is multi-process. An extension host is one Node
process, so `createSdkMcpServer()` gives the same tools with no port, no token
and no transport. An entire subsystem deleted.

### Board tools use `alwaysLoad: true`

Nimbalyst defers tool schemas behind ToolSearch. We don't, for the board tools:
an agent that must go looking for the tool before it can move its own card will
often just not bother, and the headline feature silently stops happening.

### No worktree seeding

Matching Nimbalyst. No `.env` copy, no `node_modules` link, no install hook.
Copying secrets into a sibling directory should be a decision, not a default.
`onCreate` exists to opt in.

### Don't ship the SDK's native binary

It is ~190MB and made the `.vsix` 87MB. `resolveClaudeExecutable()` finds the
installed CLI instead: 5.4MB, and the CLI updates on its own schedule.

**Trade-off:** Claude Code must be installed. Reasonable for this extension's
audience, and the error message says exactly what to do.

---

### Worktrees live inside the repository, ignored — not in a sibling directory

Worktrees used to go in `<repo>_worktrees`, a sibling of the project. It kept
the repository byte-for-byte pristine, which is the rule the rest of this
extension is built on, and it was still the wrong place:

- The checkouts landed in the user's `Projects/` folder, next to their actual
  projects, named after this tool. Nothing relates them back, nothing cleans
  them up, and a `Projects` listing gains a directory per repo you ever ran an
  agent in.
- A sibling directory is outside the workspace, so nothing in VS Code —
  including this extension's own file and diff links — has a natural root for
  them.
- It assumed the parent directory is writable. A repository checked out at the
  root of a share, or in a container mount, does not guarantee that.

They are now `<repo>/.agentskanban/worktrees/<name>`, and `/.agentskanban/` goes
into the repository's `.gitignore`.

**The ignore rule is load-bearing, not tidiness.** `merge()` refuses to merge
into a dirty main worktree, deliberately — it is where work gets lost. An
unignored `.agentskanban/` is an untracked directory in that worktree, so
without the rule, creating one session would block every merge from then on and
blame a directory the user never made. `ensureIgnored()` therefore runs inside
`create()`, before the first `git worktree add`, so the directory is never once
visible as untracked. It asks `git check-ignore` rather than reading the file,
so a rule already in `.git/info/exclude` or a global excludes file counts and no
second copy is written; and it does nothing at all when `worktreeRoot` points
outside the repository, because there would be nothing to ignore and editing
someone's `.gitignore` anyway is a surprise.

**The one unavoidable consequence:** the `.gitignore` edit is itself an
uncommitted change, so the first merge after the first session is blocked by a
file the user did not touch. That cannot be designed away — the rule has to be
in the repository to be shared with the team, which is the reason for
`.gitignore` over `.git/info/exclude` — so the refusal is made to say so. When
the only uncommitted change is `.gitignore`, and its only added lines are our
rule and its comment (compared against `HEAD`, so someone else's edit is never
attributed to us), the message names it and says to commit that line. Otherwise
the dirty files are listed, because a merge refused without saying what is in
the way is a dead end either way. `agentsKanban.init` writes the rule too, which
is how to get it committed before any agent runs.

**Existing worktrees are untouched.** `list()` reads from git and sessions carry
their worktree path in the sidecar, so anything already in `<repo>_worktrees`
keeps working, reviewing and merging exactly as before. Only new ones move.

**Also:** `.agentskanban/**` is in `.vscodeignore`. A worktree is a whole
checkout of the repository, and `vsce` packages everything not listed — one live
session would otherwise put the entire repo inside the `.vsix`.

---

### A started session's backend is a choice; its runtime is a fact

The composer used to lock BOTH halves the moment a session had metadata, so the
report went: *"once it ran I can't change from OpenRouter to Anthropic and use
their models"*. The two halves are different constraints and were being treated
as one:

- The **runtime** is genuinely fixed: the transcript lives in that runtime's own
  store, its model ids are that runtime's, and its login is that runtime's.
  There is no honest move across.
- The **backend** is environment on the CLI process, and a session launches a
  process again on every turn. Switching it is a real thing with a real cost:
  the next launch re-reads the whole conversation at the new backend's input
  price.

So a started session's composer shows a readout chip for the agent and a
same-runtime-only backend picker. The load-bearing piece is on the host:
`send()` carries `providerFor` — the profile resolved from the session's own
`meta.provider` — and `launch()` uses it instead of the active profile. One
global `providerEnv` for every launch would make the picker a lie the moment a
second session starts on a different backend.

`meta.switchedFrom` records the provider the conversation RAN on, so the bar can
warn that the next turn re-reads it all at the new backend's price (with a
caveat while the agent is live: it applies when it stops and the conversation
resumes). The launch that performs the switch clears it — `null` in a patch, the
same sentinel convention as `CLEAR_TEST_PLAN` — so the warning is tied to one
switch, not permanent.

### One settings door, and a page that says where things are

Five complaints at once — can't find the orchestration models, can't switch a
started session's backend, can't pick spawn models, can't reach the remote
board, can't even open the settings page — and four of them were the same bug in
different places: the settings surface was only reachable from the command
palette, or from an entry inside the agent picker, which a started session
hides. The moment a run started, backends, schedules, the spawn-model policy and
the remote pairing code all became unreachable at once.

Fixes, and the rules they encode:

- **A standing gear on the composer bar.** `post('openSettings')` → the
  existing `SettingsPanel.show()`, which is idempotent by design (one panel,
  revealed). Never hidden by session state.
- **Controls say what they are.** The orchestration dial was the glyph `⑂` and
  nothing else; it now reads `Split: <level>`. The model table's spawn tick was
  an unlabeled box at each row's end; a legend above the list says what both
  ticks mean.
- **The settings page grew a table of contents.** Five panels is a page nobody
  holds in their head; a sticky nav anchors the sections that exist, never ones
  the host did not send — an anchor to nothing is a control that cannot take
  effect.
- **The remote section shows where the remote IS.** The relay's viewer URL is
  `<relay>/board`, derived host-side (`relayBase`) and rendered with Open and
  Copy — Open goes through the host (`openExternal`), and `parseMessage`
  restricts `openUrl` to http(s) rather than letting the webview navigate.

---

## Postmortems

### The board was blank and every command was "not found"

**Cause:** `activate()` returned early when no workspace folder was open —
*before* registering commands or the webview provider.

```ts
if (!folder) { log.info('…idle.'); return }   // ← nothing registered past here
```

The view's title bar still rendered, because that comes from the manifest, so it
looked like a broken view rather than an extension that never started.

**Diagnosis:** guessing from the screenshot wasted two attempts. The extension
host log said it plainly:
`2026-09-03 15:07:50 [info] No workspace folder open; Agents Kanban is idle.`

**Fix:** registration never depends on workspace state; folder-dependent setup
moved into a `rebuild()` step that also runs on `onDidChangeWorkspaceFolders`.

**Guard:** `smoke.mjs` activates the built bundle **with no workspace folder** and
asserts every command still registers.

**Lesson:** read `~/Library/Application Support/Code/logs/*/exthost/` before
theorising.

### The webview painted nothing until a state message arrived

**Cause:** `render()` only ran on receiving `state`. If the host's first message
never landed, the panel sat blank forever with no error — `refresh()` also bailed
early on `!view.visible`, and its rejection was swallowed by a bare `void`.

**Fix:** `render()` runs on load; `refresh()` no longer skips on visibility;
failures are logged.

**Guard:** `board/webview.test.mjs` runs `media/board.js` in a `vm` against a stub
DOM and asserts it renders before any message.

**Lesson:** never swallow a promise rejection with `void`. Every non-ready state
should say what is wrong and offer the fix.

### A hand-rolled fractional index was quietly broken

Keys degenerated to 29–40 characters and violated the module's own validity rule
after a couple of hundred operations. Replaced with `fractional-indexing`
(`generateKeyBetween`) — the same algorithm Nimbalyst uses. 200 appends → `b2D`.

Now removed entirely along with the task model, but the lesson stands: don't
hand-roll ordering math.

### The repo-lock queue was not FIFO

Mutual exclusion held, but callers ran in arbitrary order: `withRepoLock`
awaited `realpath()` *before* claiming a queue slot, so they enqueued in
whatever order that resolved.

**Fix:** queueing is fully synchronous; the caller passes an already-canonical
root (`git rev-parse --show-toplevel` returns one).

### Test assertions that were wrong twice in the same way

A path-containment check rejected `.._..etc_passwd.jsonl` as an escape. It isn't
— `/` is stripped, so it's an ordinary filename that merely *starts with* dots.
Written wrong twice (`rel.startsWith('..')`) before checking for an actual `..`
path *segment*. The sanitiser was right throughout.

**Lesson:** when a test fails twice on the same assertion, suspect the assertion.

### Node's type-stripping rejects parameter properties

`constructor(private readonly x: string) {}` fails under
`node --experimental-strip-types` — parameter properties emit code, not just
types. Use an explicit field. This is why tests can run with no build step.

---

### `git()` trimmed its own output, and ate a filename

`git status --porcelain` puts the status in the first two **columns**, so a
modified file's line begins with a space:

```
 M new.txt        ← the leading space IS the "not staged" column
?? draft.txt
```

The shared `git()` helper ran `stdout.trim()`. That stripped the leading space
off the *first* line only, so every subsequent `slice(3)` cut one character off
the filename — `new.txt` became `ew.txt`.

Only the first file, only when it was modified rather than untracked, and never
in a way that threw. `changedFiles()` had carried it since it was written; its
test only ever asserted on *committed* files, which come from `diff --name-status`
and take a different path.

**Found by** adding a test that read an uncommitted, previously-committed file —
the exact shape the agent brief produces.

**Fix:** `gitRaw()` strips only the trailing newline, and the porcelain parsers
use it.

**Lesson:** a convenience `.trim()` in a shared helper is a data-format decision
in disguise. Column-oriented output does not survive it.

### Notify on the move into review, not on "done"

An agent moving its card into a review column is the moment it is asking to be
tested — it is the agent's own statement, made through the same `set_phase` tool
that moves the card, so the signal and the board state cannot disagree.

**Rejected:** notifying when the *run* finishes. A run ends for many reasons —
an interrupt, an error, a turn that merely paused — and most of them are not a
request for attention. Notifying on those trains the user to dismiss.

The rule is `category === 'review'`, not `id === 'validating'`, so a renamed or
custom board still works. Both it and the `humanOnly` gate are pure functions in
`board/config.ts` with tests, for the same reason the approval boundary is:
**policy that decides what an agent can do, or when a human is interrupted,
belongs in code.**

### The first real agent run found four bugs in an hour

Everything was green — 7 suites, real session data, real git repos, the built
bundle activating and rendering. Then an agent was actually run, and:

**1. Agents could not move their own cards.** `AUTO_ALLOW` in `session.ts` still
listed v1's `task_update`, `task_list`, `task_get`, `task_create`. The tools had
long since been renamed to `set_phase` / `set_tags` / `list_board`, so every
attempt to move a card fell through to the permission prompt and the run
**stalled waiting for a click**. The headline feature — an agent driving its own
card — silently required a human. Nothing threw; it just never happened.

The list is now derived from the tool definitions (`boardToolNames()`), and
`agent/__tests__/tools.test.ts` asserts every registered tool is reachable. A
hand-maintained copy of a name that lives somewhere else will drift; the only
fix that holds is not having a copy.

**2. A transcript was invisible for exactly the sessions that matter.**
`transcript()` passed `dir: workspaceRoot` to `getSessionMessages`. But an agent
runs with `cwd` set to its **worktree**, so its session is filed under the
worktree's project directory. Scoping the lookup to the workspace found nothing,
and the chat view showed a session that had apparently never said a word.

A session id is globally unique, and the SDK searches every project when `dir`
is omitted. It is now omitted for all three by-id calls — `getSessionMessages`,
`renameSession`, `deleteSession`. The same trap as `includeWorktrees: true`, in
the opposite direction: there the scope must be widened, here dropped entirely.
Measured: 0 entries scoped, 274 unscoped.

**3. A failed run leaked its worktree.** A run that died at startup — a bad
`claude` path, a permissions refusal — had already created a worktree and a
branch, and nothing removed them. They accumulated in the worktree directory with
every failed start. Now reclaimed, but only when provably untouched (clean, and
no commits ahead of base): a leaked directory is a nuisance, deleting someone's
work is not.

**4. A follow-up after a run finished produced two cards.** `send()` starts a
resumed run while the finished one stays in the agent map, both carrying the
same session id — so the board rendered two entries under the same key, one
stale. The finished agent is now dropped as the resumed one starts.

**Lesson:** none of these were reachable from a unit test, and none were subtle
in operation — the first real run surfaced all four in minutes. A subsystem that
has never been run end-to-end has not been tested, however green it is.

### Board state is keyed by `sessionId ?? runId`, never the session id alone

The sidecar was keyed by Claude Code's session id, and every board tool started
with:

```ts
const id = ctx.sessionId()
if (!id) return err('This session is not on the board yet.')
```

Which is wrong for a window this design *documents*: Claude Code assigns the id
at `system/init`, so a run has none for its first moment. An agent that tried to
move its card in that window was told it had no card, and — being a model — it
generally did not try again. The failure was invisible: no error, just a card
that never moved.

The duplicate-id guard made it permanent rather than momentary. A run whose id
was refused never got one at all, so it could never move itself or record a test
plan for the rest of its life. That was a hole opened by the guard, not by the
environment that revealed it.

Now the key is `sessionId ?? runId`, which always exists, and three things
follow:

- `SessionStore.card(key)` answers for either kind of key, falling back to the
  sidecar when Claude Code has no session by that name.
- When the real id arrives, `MetaStore.rename()` carries the entry across.
  Anything already under the real id is newer and wins; the activity logs
  concatenate, so neither half of the run loses its trail.
- `getState()` reads the sidecar for live agents as well as stored sessions, or
  the card renders as a default and everything the agent recorded is invisible.

Measured before and after on two parallel agents: the refused one went from
`[no plan]` to a full test plan on its card.

**Lesson:** an identifier that is absent for a known window is not an
identifier you can key on. The fallback has to exist from the start, not be
added when something makes the window permanent.

### The agent has to say how to test its work

A card that reaches a review column means "I am done, your turn". Before this,
that is all it meant — and the user was left to work out which files changed,
what to run, and where to look, from a transcript.

So `set_phase` **refuses** a review column without a `howToTest` plan. Not a
line in the prompt: a check in the handler, the same shape as the `humanOnly`
gate. The tool description says what to include and the code makes it so, which
is the rule this codebase keeps returning to.

**Rejected:** a separate `ready_for_test` tool. It would duplicate `set_phase`
and let an agent move without one, which is the exact state being designed out.

**Rejected:** free text. A paragraph is not clickable. `links` carries a closed
set of kinds — `file`, `command`, `url` — precisely so the board knows what to
do when one is pressed, and each resolves against the **worktree**: the point is
to try the agent's version, not the user's checkout.

Two details that matter:

- **A command is typed into the terminal, not run.** It is a model's suggestion
  arriving in the user's shell; they get to read it first.
- **File targets are resolved and contained.** The target is written by a model,
  and `../../.ssh/id_rsa` is a path like any other. `resolveInWorktree()` checks
  the *resolved* path against a trailing separator, so a sibling directory
  sharing a name prefix is outside — while a filename that merely begins with
  dots is an ordinary file. That second half is the assertion this repo has now
  got wrong twice; the tests state both directions.

Confirmed live: told to move to `validating`, an agent produced a summary, three
concrete steps, a file link and a runnable `node -e ...` command, unprompted
beyond the tool description.

### Enlarging the board hid the board

The first attempt at focus mode closed the **primary side bar** along with the
panel and the secondary side bar. Two things went wrong, and both were obvious
the moment someone used it:

- **The board lives in the side bar.** Pressing the enlarge button while looking
  at the sidebar board closed the sidebar — so the board disappeared behind the
  control meant to make it bigger. The button is now absent from the compact
  layout entirely.
- **The restore was asymmetric.** Entering closed three things; leaving reopened
  one. The terminal and the chat panel were swallowed with no obvious way back —
  "I can't just quickly reopen them". Restore now undoes exactly what entering
  did, and smoke.mjs asserts the counts match.

The deeper mistake was choosing the wrong trigger. Focus was driven by the
**editor panel's** visibility, so it fired when the board tab came forward — by
which point the user had already lost the sidebar they would have used to get
back.

The signal that actually means "I want the board" is the **activity bar**:
`WebviewView.onDidChangeVisibility` on the sidebar view fires when you switch to
Agents Kanban and again when you switch to Explorer. That is the whole
interaction — click the icon, get the board; click Explorer, get your setup —
and it works precisely because the side bar is left alone.

### Then it opened two boards at once

Leaving the side bar open — the fix for the board hiding itself — meant clicking
the activity-bar icon produced a squeezed board in the side bar *and* the real
one in the editor, side by side, showing the same five columns.

So the side bar does close after all. What makes that safe now is that the
activity-bar path knows to ignore the visibility event its own close provokes:
closing the side bar hides our view, which is the same event that opened the
board, and unguarded it reads as "the user left" and undoes everything
immediately. `selfInflicted` marks the window in which our own layout commands
are expected.

Restoring shows the **Explorer explicitly** rather than reopening the side bar,
for the mirror-image reason: reopening it shows the *last* view, which is this
one, which takes the window again. A loop in the other direction.

And the restore trigger moved back to the board panel. With the side bar closed
there is no "click Explorer" to detect, so the signal is the board tab losing
focus — switching to a file, or closing the board. Both mean the same thing, and
both put the side bar, the panel and the secondary side bar back.

Two more things were wrong even then:

- **The second click on the icon reopened the side bar and left it there.** The
  enter path was guarded by `if (on === focusApplied) return`, so with focus
  already applied the close never re-ran — and the icon that had just opened the
  side bar could not put it away again. The `close*` commands are idempotent, so
  entering now always re-runs them. Only the toggle-based *restore* has to happen
  exactly once.
- **The suppression window was 60 times too long.** Our own layout commands are
  marked so their visibility events are ignored, and the mark lasted 750ms —
  long enough to swallow the user's next click. Clicking the icon again straight
  after leaving the board is an ordinary thing to do, and it did nothing at all.
  VS Code fires these events *while the command is still running*, so the mark
  only has to outlive the await by a tick; 60ms is plenty.

And the board now **closes** when you leave it. It is a mode, not a document:
parked in the editor area it occupies the space your code belongs in, and every
later click on the icon has to reason about a tab that may or may not still be
there. Closing it makes the icon mean exactly one thing.

And then it would not close. Clicking the Explorer icon left the board sitting
in the editor with the terminal and the chat still gone — because **there was no
event to hear**. Closing the side bar had already hidden our view, so switching
to the Explorer is hidden→hidden: VS Code has nothing to report.

So the activity-bar icon is a **toggle**. Click it for the board, click it again
to put everything back. That is the only signal that survives closing the side
bar, and it is one the user already understands. Opening a file still restores
too, via the panel's own visibility.

One more self-inflicted wound on the way: the board closed itself immediately
after opening. Closing the panels reshuffles focus, the webview reports
`visible: false` while that settles, and `onLeave` had no guard — so it read as
"the user left" and undid the open. Two guards now: our own layout changes are
marked, and an event claiming the board is gone is ignored while the board is
demonstrably still on screen.

Finally, the side bar is left **completely alone** — not closed, not switched to
the Explorer, not restored to anything. Whatever is there, Explorer or Search or
Source Control, stays.

That is what the user asked for, and it is also what makes the whole interaction
work. Closing the side bar hid the extension's own view, and a hidden view is
never reported as switched-away-from — so every design built on top of that had
to invent a substitute signal, and each substitute broke differently. Leave the
side bar open and VS Code's own activity-bar behaviour supplies `visible` and
`hidden` for free, including the collapse you get from clicking the active icon
a second time.

The duplication that originally justified closing it is gone for a better
reason: **the sidebar view is a session rail now, not a second board.** Five
columns at 300px cannot be read, so drawing them there was never right —
independently of what the layout did.

One thing this near-miss is worth recording: a block replacement removed the
`BoardPanel.onLeave = …` assignment entirely, leaving `BoardPanel.onLeave?.()`
in the panel as a silent no-op. The suite still passed, because the sidebar path
covers the same behaviour and the smoke test drove that one. It surfaced only by
instrumenting the two paths separately and noticing that one produced no calls
at all. **Optional chaining on a hook makes its absence indistinguishable from
its presence.**

**Six attempts, six different loops, duplications, dead clicks or
self-closings.** The lesson is that VS Code gives no way to *read* the layout,
only to change it and to observe the consequences — your own changes are
indistinguishable from the user's unless you mark them, and some user actions
produce no event at all. When there is no signal, stop looking for one and use
a control the user operates directly.

### The board has the window; nothing sits beside it

Nine attempts. The settled behaviour:

> **Press the icon** — the board opens in the editor, and the terminal and the
> right-hand chat step aside. **The left side bar does not move.** Press the
> icon again, click away, or close the tab, and the terminal and the chat come
> back.

Three rules make it work, and all three were learned the hard way.

**The left side bar is not ours, and the ninth attempt is the first that means
it.** The eighth said "collapse it, never switch it" and issued
`closeSidebar` on the way in and `toggleSidebarVisibility` on the way out. That
pair looks symmetric written down and is not one, because *the icon click that
triggers the restore reopens the side bar first*. So:

- **Second press of the icon.** VS Code opens the side bar to show our
  container, we close the board, and our restoring toggle finds the side bar
  open and closes it. Board gone, left panel gone.
- **Clicking Explorer while the board was open.** The side bar opens, the board
  loses the editor, `onLeft` closes it, and the restore collapses the Explorer
  the user had just asked for. The left panel disappeared on essentially every
  path, which is exactly how it was reported.

So `applyBoardFocus` now touches **two** areas, not three: the panel and the
secondary side bar. Both are ones nothing else in the window reopens behind our
back, which is the property the whole close/toggle asymmetry depends on and the
one the side bar never had.

Squatting on the left is then solved the other way round, by **handing the bar
straight back**. Clicking an activity-bar icon makes VS Code show that
extension's view and there is no API to decline, so the eviction is unavoidable
— but it can be made to last a frame instead of a session. `agentsKanban.sideBarHome`
(default `workbench.view.explorer`) says where to hand it back to. It is a
setting rather than a hardcoded Explorer because that was the objection that
killed this idea last time: someone living in Source Control got the Explorer
back instead. Empty means "leave it where the click put it".

That also makes the toggle work with one event instead of two. We are never the
container already on screen, so every press of the icon is a hidden→visible
transition, and both directions hang off it.

**Asserting on command names cannot catch a layout bug.** The suite was fully
green throughout the above, because it checked that `closeSidebar` and
`toggleSidebarVisibility` were both issued and counted them as a symmetric pair.
`test/harness.mjs` now models the four workbench areas as **state** — is the side
bar open, which container is it showing, is the panel up, the auxiliary bar —
`executeCommand` applies each command to that model, and a webview view's
`visible` is *derived* from it rather than set by the test, exactly as VS Code
derives it. `ctl.clickActivityIcon()` does what a real click does, side-bar
eviction included. The gates then assert where the window ended up. Rerunning
them against the old code turns four of them red, including "and Source Control
is exactly where it was left" — the reported bug, reproduced.

**Every layout change is marked, because our own commands provoke the events we
listen to.** Collapsing the side bar hides our view, which is the *same* event
that opened the board; unguarded it reads as a second click and undoes
everything. `selfInflicted` marks the window, and it is 200ms — long enough to
cover a reshuffle that settles a frame later, short enough not to swallow the
user's next click, which 750ms did.

**Lesson:** seven designs asked "which VS Code event means the user is
finished?" and each answer was wrong in a different way, because most of the
events were ones we had caused ourselves. The eighth stopped inferring: three
explicit actions close the board, the layout follows the board's existence, and
the only inference left is one clearly-marked 200ms window.

The ninth added the part that made the previous eight fail in the first place:
**do not take an area you cannot be the only one changing.** The panel and the
auxiliary bar are safe to close-and-toggle because nothing else reopens them
mid-gesture. The side bar is not, because the user's own click on the icon
reopens it as part of the very gesture we are responding to. And the test that
was supposed to catch this asserted on the commands issued rather than on the
window they produced, which is the difference between checking that both halves
of a pair were called and checking that they cancelled.

### `tsc: not found`, and F5 made it worse

The first thing anyone does with a fresh clone is press F5. It failed with:

```
> tsc --noEmit
sh: 1: tsc: not found
The terminal process failed to launch (exit code: 127).
```

Nothing there names the cause (`node_modules` does not exist) or the fix
(`npm install`). And the message is not even stable: with a global TypeScript
installed you get a hundred `Cannot find name 'process'` errors instead, which
reads like broken code rather than a missing install.

Worse, this was a regression I introduced. F5 used to run `build`; I changed it
to `verify` so a broken manifest could not launch — which was right, but it put
`tsc` first in the chain and turned a clear-ish failure into a cryptic one.

**Fix:** `scripts/preflight.mjs` runs before everything. It checks the Node
version, and for the one unambiguous case — `node_modules` absent entirely — it
just runs `npm install`, loudly. A *partial* install is not guessed at: it names
each missing package, what needs it, and that `--omit=dev` is the usual cause.

Three other things fell out of the same look:

- **The test script was a bash loop with `**` globbing.** npm runs scripts
  through `sh` — dash on most Linux — where `**` is simply `*`, so it covered
  exactly two directory levels by accident and would have silently stopped
  matching the moment a test moved. It is now `scripts/test.mjs`, which walks
  the tree, works on Windows, and refuses to report success on zero files.
- **`install-local` hardcoded `/Applications/Visual Studio Code.app/…`**, so it
  worked on one operating system. It now finds the `code` launcher on any
  platform and, failing that, prints the exact command to run by hand.
- **Node 22.6 was a hard requirement nobody had written down.** That is where
  `--experimental-strip-types` landed, and every test needs it. Now in
  `engines.node`, checked by the preflight, and `smoke.mjs` asserts the two
  agree so they cannot drift.

**Then the same error came back, and the diagnosis was wrong.** The preflight
reported `node_modules/.bin is missing tsc, vsce` and said to reinstall — which
would have produced exactly the same result, because nothing was broken.

npm fills `.bin` with **symlinks**. They are simply absent on a filesystem that
has none — a Windows drive mounted into WSL, a network share, some Docker
volumes — and skipped outright by `npm install --no-bin-links`. The packages are
installed correctly; only the links are missing. `tsc: not found` is what that
looks like from the outside, and reinstalling cannot fix it.

So the dependency on `.bin` is gone entirely. `scripts/run-bin.mjs` resolves a
package's declared `bin` entry through Node's own resolver — which does not care
about symlinks — and runs it with the Node already executing:

```
"typecheck": "node scripts/run-bin.mjs typescript tsc --noEmit"
"package":   "node scripts/run-bin.mjs @vscode/vsce vsce package"
```

`npx` is gone for the same reason, and the preflight now checks executables by
*resolution* rather than by looking for symlinks.

Reproduced before and after with `npm install --no-bin-links`: `.bin` empty,
bare `tsc` not found, and `npm run verify`, `verify:package` and `screenshots`
all passing.

**Guard:** smoke.mjs checks every npm script for shell globbing, shell loops and
platform-specific paths; that every invoked command is `node` or `npm` and never
a `.bin` symlink; that the preflight itself does not look for `.bin`; that the
Node floors in the preflight and `engines.node` agree; and that the scripts
needing dependencies run the preflight first.

**Lesson:** twice now, the diagnosis was confidently wrong in the same way —
"your install is broken" when the install was fine and the *assumption* was
broken. A tool that reports a healthy system as corrupt is worse than one that
says nothing, because it sends people to do work that cannot help.

### A max-effort review found fifteen things; two more only ran up under load

A full review of the accumulated diff. The four that mattered most, and none
were caught by ten green suites:

**A sticky `interrupted` flag swallowed completed turns and deadlocked the
queue.** `interrupt()` set the flag unconditionally, but the button is offered
while an agent is `starting` — before the CLI has spawned and before `this.q`
exists — so `q?.interrupt()` was a no-op and the flag stayed set for the rest of
the run. The eventual `result` was then discarded as an interruption: no `done`,
no cost, no `finish()`, and `finish()` was the only caller of `drain()`. Fixed
twice over: `interrupt()` with no query falls back to `stop()`, and a result is
only treated as an interruption when it *also* carries `is_error` — a turn that
finished in the moment between the click and the call is still a completion.

**Then the deadlock survived the fix**, which the live test caught and the review
did not: `drain()` ran only from `finish()`, which listens for `done`/`error`. An
aborted run settles to `idle` and emits neither, and `AgentManager.stop()` never
drained at all — so *stopping any agent* stranded everything queued behind it.
Draining now happens on any terminal state, which is where the slot is actually
released.

**Unscoping `dir` made the chat view render every conversation twice.** The
transcript merge did `[...past.slice(0, -1), ...live]`, which was harmless only
while `past` was empty — the very bug fixed one commit earlier. `historyCount`
now records how many entries were on disk when a run began, and the slice cuts
there.

**A safety control that silently did nothing.** The permission-mode picker only
reached `AgentManager` when a session was selected, but the manager captures the
mode at construction and `setDefaults()` does not carry it. Tightening the mode
from the new-session screen showed "Plan only" while the next agent ran on
`acceptEdits`.

Two boundaries were prose rather than code:

- **`kind: 'url'` went straight to `openExternal`** with no scheme check, while
  `kind: 'file'` from the same model-authored payload was carefully contained.
  `file://` to read a key, `vscode://` to drive another extension — behind a
  friendly label the user cannot see through. Now http/https only.
- **`resolveInWorktree()` was lexical only.** The agent has write access to its
  own worktree, so `ln -s ~/.ssh keys` then a link to `keys/id_rsa` resolves
  textually inside the root. `realResolveInWorktree()` follows symlinks, and
  realpaths the root too — otherwise every path under a symlinked `/tmp` reads
  as an escape.

And the smaller ones: a non-conflict merge failure reported as a conflict with
an empty file list *after* aborting, throwing away git's own explanation; the
diff's left side taken from the base branch tip while the file list was computed
from the merge-base, so a moved base showed a teammate's commits as the agent's
deletions; `core.quotePath` turning `café.ts` into an unopenable escaped string;
two `.then()` chains under a bare `void`, which this project has a postmortem
for; `ManagerOptions.permissionMode` still declaring four of six modes and
compiling only because every value was cast; and `SessionStore.card()` doing a
full `listSessions()` scan on the hot path for three fields the sidecar owns
outright.

**Lesson, again:** the two most serious findings were about states no test
exercised — a run interrupted before it started, and a queue behind a slot that
never freed. Both needed an agent, a clock and a second agent waiting.

### The conversation surface was a whole tier behind the board

Asked whether the *interaction* had been copied from Nimbalyst as faithfully as
the board, the answer was no, and an audit found five things:

- **`interrupt()` was implemented and unreachable.** Nothing in the UI called
  it. "Stop" mapped to `stop()`, which aborts the process — so the common case,
  *end this turn but keep talking*, did not exist. It is now the primary button
  while an agent is busy, with Stop beside it.
- **Follow-ups sent mid-turn vanished.** They are handed to the CLI, which holds
  them until the turn ends, so from the user's side nothing happens for minutes.
  Now shown as pending until the turn completes.
- **Slash commands could be run but not found.** `/name args` always worked —
  the SDK executes the matching `.claude/commands/*.md` — but nothing listed
  them. Typing `/` now autocompletes, project scope shadowing user scope, with
  subdirectories namespaced `parent:child`, exactly as the CLI does.
- **No `notify_user`.** An agent that got stuck could only stop. It can now
  raise a notification, with `blocked` distinguished from `info`.
- **Permission mode was fixed for the life of a session.** The SDK will change
  it on a live one, which is the point: you tighten or loosen mid-run.

And `DISABLE_AUTOUPDATER=1` / `DISABLE_UPDATES=1`, which Nimbalyst shipped as a
fix after the CLI self-updated mid-session and corrupted its own binary. We
resolve the CLI from `PATH` rather than bundling one, so the blast radius is the
user's own install — worse, not better.

**Two of these only surfaced by running an agent**, again:

`queued` was always empty. The SDK drains our `MessageQueue` the instant we push
to it, so nothing ever sits there; the message waits *inside the CLI*. Watching
our own queue was watching the wrong thing. It now tracks messages from `send()`
until the turn's `result`.

And interrupting put a **red error card** on the board. An interrupted turn comes
back as a `result` with `is_error` set — the CLI reporting that it stopped, not
that anything went wrong. Reporting a button the user deliberately pressed as a
failure. Now recognised, and the session provably survives: interrupt, then send
"reply with STILL HERE", and it does.

### The view is screenshotted, and that is a test

`board.js` and `board.css` have no type checking, and the unit test asserts on
rendered *text* — which cannot tell you the last column is off-screen.
`npm run screenshots` renders them in headless Chromium with VS Code's own theme
variables and fails on a page error or a near-empty render.

It immediately earned itself: the five columns were pinned at `flex: 0 0 264px`,
so on a 1440px laptop **Complete — the approval column — sat off-screen** behind
a horizontal scroll. Nothing was broken; it just could not be seen. Columns now
share the width with a minimum and a maximum.

### Two live runs must never become one card

Running two agents in parallel showed perfect isolation — distinct worktrees,
distinct branches, each agent touching only its own files, the user's checkout
untouched — but both runs reported the *same* session id, and the board merged
them: one card, agent A's worktree under agent B's title, A's sidecar entry
overwritten. Nothing threw.

The duplicate id itself was an artefact of the sandbox (a nested Claude Code
container pins `CLAUDE_CODE_SESSION_ID`; two bare `claude -p` calls returned the
same id too). But the *response* to it was a real defect: the code assumed
uniqueness and had no answer when the assumption broke.

`AgentManager` now refuses an id already held by a **running** agent, keeps the
newer run on its `runId`, and emits a `warning` the host surfaces. "Running"
matters: a *finished* agent legitimately shares its id with the run that resumes
it, and treating that as a collision fired a warning on every follow-up.

**Lesson:** an invariant you depend on and do not check is a silent corruption
waiting for the day it does not hold.

### The smoke test caught an API name before the editor did

Adding the diff view meant calling
`vscode.workspace.registerTextDocumentContentProvider` at activation. The test
harness's fake `vscode` did not have it, so activation threw — loudly, in the
suite, in a second.

In the real editor that same throw happens *during activation*, which is the
"nothing works and there is no error" failure this project keeps hitting. The
stub being incomplete is the mechanism, not a nuisance: **every new `vscode` API
has to be added to `test/harness.mjs`, and that is when you find out whether you
named it correctly.**

### F5 worked or did not depending on how VS Code had been started

Reported as "it won't even launch". `npm run verify` passed in the terminal,
exit 0, in six seconds; F5 did nothing.

VS Code runs tasks through a **non-interactive** shell. Every version manager —
nvm, fnm, asdf — installs itself in `~/.bashrc`, which opens with:

```sh
case $- in
    *i*) ;;
      *) return;;
esac
```

So `node` and `npm` exist in the user's terminal and do not exist in the task
that F5 waits for. Whether that mattered depended entirely on **how VS Code
itself was launched**: from a terminal it inherits that terminal's `PATH` and
everything works, from the desktop or the dock it inherits the session's `PATH`
and `preLaunchTask` dies with `npm: command not found` before the extension host
is ever asked to start. Confirmed by reading `/proc/<pid>/environ` and the
process's parent — `cinnamon`, not a shell — with no `node` anywhere on the
inherited `PATH` and no `/usr/bin/node` to fall back to.

Same checkout, same code, same green suite, different launcher. Nothing in the
failure names any of that.

`scripts/with-node.sh` finds a Node 22.6+ the way the extension already finds the
`claude` executable — `PATH`, then nvm's `default` alias, then the version
directories, then fnm/volta/asdf, then the usual system locations — checks it by
**running** it rather than by parsing a version out of a directory name, puts its
`bin` on `PATH` and execs the rest. Every task in `tasks.json` goes through it.
When there genuinely is no Node it says so, and says which of three fixes to
apply.

**Also:** `activationEvents` was `[]`, so the extension activated only when the
icon was clicked or a command ran. That makes the status-bar item — advertised in
its own setting as a way in — absent for exactly the person who has not found
another way in yet, and leaves the extension's log channel non-existent when you
go looking for why nothing happened. Now `onStartupFinished`.

**Lesson:** "works on my machine" had a sharper form here — it worked in the
same machine's terminal and failed in the same machine's editor, and no gate
could see the difference, because every gate ran in the shell that worked. The
launch path deserves the same treatment as the code: find the tool, or say
plainly that you could not.

### The extension ran a different Claude Code than the machine had

Every agent run died instantly with:

```
panic(main thread): Bus error at address 0xD097FD5
oh no: Bun has crashed.
Args: ".../node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude" ...
```

`resolveClaudeExecutable` preferred **the SDK's bundled per-platform binary**
over the `claude` on PATH — the exact opposite of the design it sat under, which
excludes that ~190MB binary from the .vsix specifically so the user's own CLI is
what runs. The bundled copy is a Bun executable, and this one SIGBUSes on stock
Linux 6.8 / glibc 2.39. The `claude` on PATH — same product, installed normally
— is fine.

Worse, whether the platform package existed at all depended on how `npm install`
had gone, so identical source crashed on one checkout and ran on another.

It is now **removed, not demoted**. A fallback that only ever fires in a dev
checkout, and crashes when it does, is pure liability — no user can reach it,
because it is not in the package. With no `claude` anywhere, `session.ts`
already says so and names the fix.

**What hid it, and this is the transferable part.** The lookup ran through
`createRequire(__filename)`. `__filename` does not exist in ESM, so under the
test runner it threw, was caught by the surrounding `try`, and the branch was
silently skipped. esbuild emits the extension as **CJS**, where `__filename` is
real and the branch fired. A unit test calling `resolveClaudeExecutable()` could
not observe this code path at all — it behaved differently in the only place
that ships.

So `src/agent/__tests__/executable.test.ts` asserts against the **built bundle**,
not the source. Note that three of its assertions pass either way; that is left
in deliberately, as a standing demonstration of why the bundle check is the one
that matters.

### The model picker was lying about context windows

It said 200K for all three models. Opus 5 and Sonnet 5 are **1M**; only Haiku 4.5
is 200K. Nothing failed — the live meter reads the window the SDK reports per
run — so the wrong number just sat under the picker as a plain lie about which
model to pick for a big job.

The ids were also dated snapshots (`claude-haiku-4-5-20251001`). Both forms work,
but the canonical undated id is what the docs publish and what does not drift as
snapshots move.

The gate in `meta.test.ts` restates the documented windows, so this file is the
second place that has to be edited. That is the point: the value is not derivable
from anything local, so a second, deliberate edit is the only guard available.

### A pasted URL escaped its own card

A card title is often a pasted URL — one token with no spaces. `.card .title` was
`display: flex`, and **a bare text node in a flex container is an anonymous flex
item that no CSS rule can reach**. So it overflowed the card and spilled its tail
onto the line below. board.js emitted exactly the right characters; board.css put
them in the wrong place.

Now inline content with `overflow-wrap: anywhere` and a 3-line clamp, so one
pathological title cannot make a card three times its neighbours' height.

Nothing in the suite could see this: every view test asserts on text, and text is
not layout. `src/board/__tests__/layout.test.mjs` renders the real `media/board.css`
and `media/board.js` in real Chromium and **measures** — `scrollWidth - clientWidth`,
and the title's bounding box against the card's. It reproduces the original bug at
94px of overflow (1152px for a 200-character title).

It uses whatever Chromium is already in the playwright cache rather than pinning
one, because playwright refuses to use a *newer* cached build than its own version
wants, and making `npm run verify` download ~170MB to check a stylesheet is not a
trade worth making.

### "Delete permanently" could not tell you it had failed

`SessionStore.delete()` was `catch {}` returning `void`. The dialog promised the
transcript was removed from Claude Code with no way of knowing whether it had
been.

It genuinely fails: delete a session that another Claude Code window has **open**,
and that window writes its own state back out afterwards. Verified on disk — the
file came back containing only two lines, `last-prompt` and `atis-latch`, with the
transcript itself genuinely gone. That stub is enough for the session to keep
appearing in Claude Code's history, so from the outside it looks like the delete
did nothing.

`delete()` now returns `{ deleted, reason }` and verifies with `getSessionInfo`;
the board warns when Claude Code kept its copy, and the dialog says to close the
Claude Code tab first. The sidecar entry is dropped either way — a card you cannot
delete is worse than a stale transcript.

It cannot catch a resurrection that happens *after* the check. Only the live
client can stop doing that, which is why the dialog tells you about it.

### Starting a session warned, then closed the chat you were watching

Two independent bugs, both triggered by the same moment: Claude Code assigning a
session id, a few seconds into the first turn.

**The warning.** The id arrives on the `init` message; the session **file** it
names is written a moment later. `store.rename()` fired immediately and lost that
race, producing `Session <id> not found in any project directory` as a popup on
every new session. The card still appeared, because the sidecar writes had
succeeded and only the rename failed. `rename` now retries — but only on
"not found", and only for ~3.5s; every other error is reported at once, because
waiting several seconds to re-report a permission error helps nobody.

**The chat detaching.** A card is keyed by its **run id** until the session id
exists and by the **session id** from then on. `getState()` did:

```ts
if (selectedKey && !cards.some((c) => c.key === selectedKey)) selectedKey = undefined
```

So the chat you had open stopped matching any card mid-sentence, the selection was
cleared, and the view fell back to the new-session screen — which reads exactly
like "it closed my chat and opened a new one". `followKey()` now follows the
selection across the swap. It is a pure function in `manager.ts` precisely so the
swap can be tested without starting an agent.

### A tool row that could not say what the tool was doing

Reported as "I literally can't tell from the UI what the agent is doing", with a
screenshot of four rows. Three separate causes, all in `summariseTool`:

- `mcp__claude_ai_Atlassian__getJiraIssue` rendered verbatim. The prefix strip was
  `^mcp__[^_]+__`, which requires a server name containing **no underscore** — so
  every real MCP server name defeated it.
- No arguments were shown for it, because the key it puts them under is not one of
  `command`/`file_path`/`path`/`pattern`/`url`. "Fetching ACME-184" showed as a bare
  function name.
- `Read` printed an absolute path whose first ~70 characters are the worktree root
  and therefore identical on every row, pushing the filename off the end.

| Before | After |
|---|---|
| `mcp__claude_ai_Atlassian__getJiraIssue` | `Atlassian · getJiraIssue  ACME-184` |
| `ToolSearch` | `ToolSearch  jira atlassian` |
| `Read /home/…/.agentskanban/worktrees/S1abc…/.claude/knowledge/_domain-map.md` | `Read  …/.claude/knowledge/_domain-map.md` |

An unlisted argument key now falls back to the first short string in the input, so
a newly-added MCP tool still says something. The server name keeps a capitalised
segment when there is one (`claude_ai_Atlassian` → `Atlassian`) and otherwise stays
whole — taking the last segment unconditionally would turn `some_server` into
`server`.

### The board looked stopped while it was working hard

Reported as "it looks like nothing is happening", with a screenshot of a
transcript ending on a `Task` row, and: "I am also not 100% sure that is
reflecting the truth."

Both halves of that were fair, and they had different causes.

**The subagent was invisible by construction.** `SessionStore.transcript()`
opened with `if (m.parent_tool_use_id) continue` — every message a Task's
subagent produced, dropped, on the grounds that it "would swamp the main
thread". It does not need to: nested under its own Task and collapsed, it is
invisible until asked for. Dropped, a Task that ran for four minutes rendered as
one motionless row.

The live stream had the same hole from the other side. The Agent SDK forwards
**only tool_use/tool_result blocks from subagents by default** — `enough for a
heartbeat counter`, as its own type says — and the option that changes that,
`forwardSubagentText`, was never set. So a subagent that spent minutes reading
and thinking emitted nothing at all. Setting it required teaching `handle()`
about `parent_tool_use_id` in the same commit: without that check, a subagent's
working notes would be appended to `this.text` and end up in the main thread's
summary as if the agent had written them.

Now: subagent frames drive the status line (`Task → Grep…`) and the session file
already holds the whole nested conversation, which the transcript hangs off the
Task that started it.

**And the liveness indicator could not be checked.** The dot pulses on a CSS
`animation` — it pulses identically over a wedged process, a network stall, and
a healthy four-minute tool call. There is no state in which it stops. That is
why the user did not trust it, and they were right not to: it was decoration
being read as telemetry.

So the board now shows the **age of the last frame the CLI sent**, in seconds,
next to the dot. That is a claim the user can check: it climbs when nothing is
happening, and it resets when something does. Past a minute it turns amber. The
number is ticked in place by a 1s interval rather than by a re-render — a
re-render would fight the composer for focus, and, worse, without a ticker a
wedged run would sit on whatever number it last rendered and read as *freshly
updated*, which is the same lie as the pulsing dot with more precision.

**Lesson:** an indicator that cannot enter the "bad" state is not an indicator.
Both of these had the same shape — a UI that was confident and uninformative —
and the fix in both cases was to show the underlying number instead of an
interpretation of it.

### The board repainted once per token, and the agent slowed down with it

Reported as: "it worked for four and a half minutes just pulling a Jira ticket
through MCP, and it was not clear what it was doing". The second half is the
half that had an answer here.

`refreshAll()` is called on every event an agent produces — including every
streamed token, which is what makes the transcript type out live. It did the
whole job each time, **twice**: the side bar and the panel each called
`getState()` for their own copy. One `getState()` is a `listSessions()` scan of
Claude Code's session index, a full parse of the selected transcript, and a
serialisation of the result to the webview.

Measured, on a synthetic store shaped like real use — sessions whose transcripts
carry Jira issues fetched over MCP:

| Sessions on the board | `listSessions()` | Transcript parse | Per repaint (x2 surfaces) |
|---|---|---|---|
| 5 | 12ms | 6ms | 36ms |
| 20 | 33ms | 10ms | 86ms |
| 60 | 103ms | 10ms | 226ms |

At 20 sessions and a perfectly ordinary streaming rate that is **105 seconds of
extension-host work for every 60 seconds of streaming**. The host is
oversubscribed, so the backlog grows for as long as the turn runs and never
drains.

**And that is not only a laggy board.** The CLI is a child process whose stdout
is drained on this same event loop, and `canUseTool` answers travel back over
it. A saturated extension host is a slower agent — the board lagging and the run
taking four and a half minutes were one bug wearing two faces. The liveness
readout was wrong for the same reason: `lastEventAt` is stamped when a frame is
*handled*, so a backlogged host reports an age it invented.

Three changes, in order of how much they were worth:

- **`board/coalesce.ts`** rate-limits repaints to 10Hz. It keeps the leading edge
  (the first repaint after a quiet moment is immediate — anything else is just
  lag), guarantees the trailing one (the last state always paints), and never
  lets two overlap, which is the part a naive throttle gets wrong when the work
  it is limiting is async.
- **One state, two views.** `getState()` is called once per repaint and posted to
  both surfaces, instead of each surface computing its own.
- **Nothing is re-read that cannot have changed.** A run's on-disk history is a
  prefix of a file that only grows, so `RunningAgent` captures it once at launch
  (`history`) instead of re-parsing the transcript per token; and the session
  index — along with any transcript still parsed on demand — is cached for a
  second, while the board metadata it merges with is still read fresh every
  time — phase and tags are exactly what an agent changes
  mid-turn, and a card that takes a second to move looks like a card that did
  not move.

180 host events now produce 2 repaints; the same 600 repaints that a minute can
produce cost 0.04s instead of 105s.

**Lesson:** a UI that repaints from a firehose has to say what its maximum rate
is. "Repaint when something changes" is a correct-sounding rule that quietly
becomes "repaint 2,000 times a minute", and the cost lands on the same event
loop as the work being watched.

### One `Date.now()` killed the streaming fast path, and the board froze

Reported as: "when the commands and bashes and the LLM are running I can't
switch to other chats or scroll up or even change to the kanban board."

Three symptoms, one cause, and every unit test was green.

The webview repaints by replacing the whole tree. That is fine when it is rare
and fatal when it is continuous: **a node that is destroyed mid-gesture takes
the gesture with it.** A card replaced between mousedown and mouseup never fires
its click — that is "I can't switch to other chats" and "I can't change to the
kanban board". A scroll container replaced mid-wheel drops the scroll — that is
"I can't scroll up". Harvest-and-restore cannot help: restoring the OFFSET after
the node is gone does not bring the gesture back.

So the view already had a fast path. `chromeSig()` is a signature of everything
structural, and a frame whose signature matches the last full render patches the
transcript in place instead of rebuilding. It was written for exactly this
report and it **had never once run in real use.**

`getState()` builds a card for every live agent, and one line of it said:

```ts
updated: Date.now(),
```

`getState()` runs on every repaint. `updated` is in the signature. So the
signature was different on every single frame, `sig === lastChrome` was never
true, and the tree was rebuilt ten times a second — the exact behaviour the fast
path exists to prevent, for as long as any agent was running anywhere on the
board.

**Why no test caught it.** `webview.test.mjs` has a `CARD` fixture with
`updated: Date.now()` evaluated ONCE, at module load, and every frame it
delivers reuses it. Held still, the fast path works perfectly and nine
assertions say so. The host did not hold it still. The fixture was not wrong —
it was a state the host never produces, which is the same failure mode as
`agent/executable.test.ts` asserting against source instead of the bundle.

Three fixes, and they are three different bugs that happened to line up:

1. **The host does not stamp the clock.** `updated: s?.updated ?? a.startedAt` —
   the session file's own mtime, or when the run started. `Date.now()` was also
   a signal that cannot say bad, the rule this board already has a postmortem
   about: a wedged run read "just now" for as long as it stayed wedged.
2. **The signature carries `updated` at the resolution it is DRAWN at.**
   `Math.floor(updated / 60000)` — `ago()` steps in minutes. A live session's
   transcript file is being written continuously, so its mtime moves regardless;
   rebuilding the tree to change no text on screen is the same bug with a
   slower clock. Sort order can flip inside one minute without a rebuild. That
   is the trade, and it is invisible.
3. **The fast path covered CHAT only.** `syncApply()` began
   `if (s.mode !== 'chat') return false`, so kanban — the default screen —
   rebuilt everything on every frame even when the signature matched, and so did
   the side bar and the search screen. Now `syncFrame()` has a branch per
   screen: chat patches the transcript, kanban patches the one volatile thing a
   card draws (`agentRow`: the tool, the age, the context fill), and the side
   bar and search screen are no-ops because everything they draw is in the
   signature. The permission prompt under a card is deliberately NOT patched —
   it is in the signature, and it holds a text box the user may be typing an
   answer into.

A fourth thing fell out of fixing the third. `lastChrome` was recorded by the
message handler, but `render()` has other callers: every click that changes
something the view owns repaints without a state message. Once matched
signatures actually started being acted on, the recorded signature could
describe a tree that had been replaced since — opening the search screen and
clicking a hit left the search screen up, because the frame that should have
drawn the chat matched a signature from before search was ever opened. `render()`
now records its own signature, on every path out, including the early returns.

And one more per-frame cost, found on the way: the side bar was posted the
selected session's **entire transcript** on every frame, to draw a title, two
counts and a list of names. Posting to a webview serialises what it is given, on
the same event loop that drains the CLI's stdout. `forControl()` drops
`transcript`, `streaming` and `review` — the three fields that are O(session)
and redrawn per frame — and nothing else, because `commands` and `disclosures`
are small and static and `composer.models` is already omitted by the host when
unchanged. The harness gives the side bar its own mailbox so a test can tell the
two surfaces apart; they are handed different payloads now.

**Lesson:** a fast path gated on a signature is only as good as the worst field
in it, and the field that kills it will be the one nobody thinks of as data — a
timestamp, a counter, a formatted string. Any fixture that holds such a field
still is testing a state the host cannot produce. Test the fast path against
frames shaped like what the host actually sends, moving the things the host
actually moves.

### Four and a half minutes, and no row said which call spent them

The other half of the same report, and the one the board genuinely could not
answer. It showed the age of the last frame from the CLI, which says *something
is still moving*. It could not say **which call is spending the time** — and
when a turn opens with one slow MCP round trip to a tracker, those are different
questions with the same shape.

Tool rows now carry their own timing: a call still outstanding ticks up, a
finished one keeps its duration. So a transcript reads

```
⚒ Atlassian · getJiraIssue  ACME-184          4m 32s ✓
```

and where the time went stops being a guess.

Two deliberate limits:

- Under two seconds, nothing is shown. A column of "0s" down a page of instant
  `Read`s is noise, and noise is what made the previous indicator ignorable.
- A row rehydrated from disk gets **no timer at all**, not a plausible-looking
  one. The SDK's session API does not expose message timestamps
  (`SessionMessage` has no time field), so there is no honest number for a past
  run — and a counter starting from when you opened the view would be exactly
  the confident-and-wrong indicator this whole section is about. `runningSince`
  and `durationMs` are set only by the live run.

**What this does not fix.** The MCP round trips themselves belong to the CLI and
to the tracker on the other end. What changed is that the transcript now says
how long each one took, so the next question — is it one slow call, six of them,
or a permission prompt nobody answered — is answerable from the screen instead
of guessed at.

### The transcript could be squeezed to nothing, and every text assertion agreed

Found by the layout gate while adding the timings above, and both instances are
the same CSS trap: **a flex item defaults to `min-width: auto`, so it refuses to
shrink below its content, and `text-overflow: ellipsis` never fires.**

- `.tool-text` — a long MCP summary pushed its row wider than the transcript and
  carried the status tick (and the new timing) off the right-hand edge.
- `.rail` — worse. `flex: 0 0 258px` reads like a width and is only a request:
  one session titled with an unbroken 200-character token stretched the rail to
  1350px inside a 900px window and left the transcript beside it **0px wide**.
  The chat did not look wrong, it looked empty.

Both are `min-width: 0`. The gate that found them measures a chat-mode render in
real Chromium, which is the only place either was visible — the text was all
present and correct, in a box nobody could read. This is the third instance of
the same rule: **layout bugs are invisible to assertions about text.**

### A task that is really two tasks: how splitting works, and why the branches look like this

Asked for directly: *"if the task is too complex it would actually start
composing agents to do it — so if I give it a task regarding two or more
unrelated things it would make 2 agents, and they'd be subtickets to the main
ticket, but then I'd understand when to test what."*

The board already runs several agents at once, each in its own worktree. What it
could not do was **decide** that one request was two jobs, and it had no way to
show that two cards belonged to one ask.

**The decision belongs to the agent, not to a heuristic here.** "Is this one job
or two" is a judgement about the request and the codebase, which is what the
model is for; a regex over the prompt would be worse and would fail silently.
So it is a tool — `split_task` — with the policy in the description and every
boundary in code, the same shape as `set_phase` and `isHumanOnly()`.

#### The branch model, which is the part that had to be got right

Each subtask forks from **what the parent forked from** — normally the repo's
current branch — and never from the parent's own branch. The parent's branch
holds nothing, which is not a hope but a precondition: `split()` refuses once the
parent's worktree is dirty or has commits.

The payoff is that **a subtask is an ordinary task branch**. It diffs against
base, merges back through the same path, and is cleaned up by the same code.
Nothing in the review, merge or worktree layers had to learn what a subtask is —
the entire feature is a pointer in the sidecar and a view over it.

The alternative was children forked from an integration branch held by the
parent, merging into it, with the parent merging to base. It was rejected for a
concrete reason rather than a stylistic one:

> `merge()` runs `git merge` in the **main** worktree and requires it to be on
> the target branch — and git will not let the main worktree check out a branch
> another worktree already holds. Merging into a parent branch would have meant
> merging *inside the parent's checkout*: a second merge path with its own
> dirty-tree, conflict and abort semantics.

And the payoff of an integration branch only exists when the pieces are related
— which is the opposite of the condition that triggers a split. Verified against
real git in `git/worktree.test.ts`: two subtasks fork from the same base commit,
cannot see each other's work, and **merge back one at a time without dragging
each other in**. That last one is the user's "I understand when to test what",
stated as a git property.

The cost, stated plainly: work that must be integrated before it can be tested
as a whole is *not* what this is for. The tool description says so, and the
dirty-worktree refusal means a session that has started building cannot escape
into a split halfway through.

#### The boundaries, and why each is code

Every subtask is a real Claude Code process with a real bill that nobody typed a
prompt for. So none of these is left to prose:

| Rule | Why it is not advice |
|---|---|
| At most 4 subtasks | The number an agent can conjure has to be a number in code |
| One level deep — a subtask cannot split | Otherwise: a fork bomb with a credit card |
| Once per session | A second split is an agent that has lost track of the first |
| Refused once the worktree is dirty or ahead | The check the whole branch model rests on |
| At least 2, each with a title and a prompt | Splitting into one is not a split |

`split_task` is also the **one board tool that is not auto-allowed**. Starting
other agents is worth a click, and the existing permission prompt already renders
it, so it needed no new surface. The exclusion is by name — the same shape as the
auto-allow drift bug this project already has a postmortem for — so
`tools.test.ts` checks the exclusion set against the real tool definitions and
asserts every tool is either auto-allowed or asks first.

#### Why the parent stores nothing about its children

The relation is one field on the **child** (`SessionMeta.parent`), and the
parent's view of it is derived on every render (`board/subtasks.ts`).

A `children: string[]` on the parent would have been wrong for a specific
reason: **a card's key is its run id until Claude Code assigns a session id**,
seconds into the first turn — which is exactly when a split happens. One pointer
per child is a fact `MetaStore.rename()` can repoint; a list on the parent is a
second copy of the truth that goes stale at the worst possible moment. The
repointing has its own gate, including the case where the parent has no sidecar
entry of its own.

#### When to test what

Subtasks stay real cards in their own columns — a subtask in Validating belongs
in the Validating column, which is the whole point of a board. What is added is
the thread: the child names its parent, the parent lists its subtasks and how
many are ready, and each row carries its own phase so `1/2 ready` can be checked
rather than believed.

The roll-up is the answer to the question as asked. Test each subtask on its own
card as it lands. When the **last** one reaches a review column the parent is
moved there too and one notification says *"All 2 subtasks of X are ready for you
to test"* — instead of a second toast about a single card, which is not the news.
"Ready" means review **or** done, so a parent whose pieces the user has already
approved one by one still reaches full.

### Every agent reported its host's session id

Found by running a real agent against the new split — which is the only way it
could have been found, and the reason that rule is at the top of CLAUDE.md.

The first live split produced this:

```
Two agents reported the same Claude session id (2c8c49b6-…).
"Add HELLO.md file" keeps its own card so the board does not merge it with
"Two completely unrelated jobs in one request".
```

That id was **the terminal's**. `options.env` spread `process.env`, and the
extension was being driven from a shell that was itself inside Claude Code, so
`CLAUDE_CODE_SESSION_ID` was in the environment and every agent the extension
started inherited it and claimed it as its own.

This is not an exotic setup — it is *the* setup for anyone who wants a Claude
kanban board: open VS Code from a terminal you are already working in. Every
agent after the first then keeps a run-id card with no persisted transcript,
which reads as "the board lost my session". Splitting makes it worse by starting
several at once, all colliding on the same id.

`agentEnv()` now drops the variables that name the **host's** session and
process before handing the environment over. Deliberately a named list rather
than a `CLAUDE_*` sweep: almost everything else under that prefix is
configuration the user means to inherit, and silently dropping credentials or a
proxy would break the run outright while looking like a network fault. The gate
asserts both halves — identity out, configuration through.

**Two lessons, both already rules here, both re-earned.**

The first: *run a real agent before believing the suite*. Thirteen test files
were green. Nothing that runs in-process can see what a spawned CLI inherits.

The second is about the guard that caught it. "Two live runs must never become
one card" was written for a different failure, and it did not prevent this one —
it made it **visible**, by name, with the id in the message. A guard that
refuses quietly would have left three agents fighting over one card and no clue
why. That is the argument for warnings that say exactly what they saw.

### Scrolling a column threw you back to the top on every frame

`render()` rebuilds the whole tree with `replaceChildren()` on every state
message, and `refreshAll()` sends one for every coalesced agent frame — several
a second while something is running. Every scroll container went with it: the
column bodies (`.cards`), the session rail and the transcript were recreated at
`scrollTop = 0`. Scroll down a column of twenty cards and the next frame put you
back at the top. The transcript alone had a rule — stick to the bottom while you
are at the bottom — which meant that scrolling *up* to read something a minute
old also snapped you to the top the moment the agent produced a token.

Every scroll container now announces itself with `data-scroll="<key>"`, keyed by
something that survives the rebuild (`col:<id>`, `rail`, `transcript`), and
`render()` records each offset before the rebuild and puts it back after. The
transcript's stick rule runs last, so following the tail still wins when you were
at the end.

Two gates, because the stub cannot see pixels. `scroll.test.mjs` gives the stub
DOM real `scrollTop` state and asserts the offset survives a second state
message; `layout.test.mjs` does the same in Chromium with forty cards in a 600px
window, where `scrollTop` only means something once the box has a height. Both
read 0px before the fix. The stub also gained a working `querySelector` — it used
to answer "nothing" to every selector, which made the restore path unreachable
from any test.

### The answer was shown as raw markdown

The agent writes markdown and the transcript showed it verbatim: `##` and `**`
as characters, tables as walls of pipes, code fences as three backticks with the
code in proportional type. Nimbalyst renders through `@lexical/markdown` and
`@lexical/code-shiki` — a React rich-text editor framework — which is not
something to copy into a webview that has no framework by design, and would have
meant a build step for `board.js`, which every view test runs raw.

So `board.js` has a renderer of about 250 lines that **builds DOM nodes**. The
rule that matters is *no `innerHTML`*: the text is another program's output, and
the webview can post `move`, `send` and `remove` to the host, so a rendered
`<img onerror>` would be an agent — or a tool result it quoted — driving the
board. Covered: headings, paragraphs (a single newline is a line break, as on
every chat surface), fenced code with a language label and a Copy button, inline
code, bold, italic, strikethrough, links, bare URLs, nested lists, pipe tables,
block quotes and rules. Links are `http(s)`/`mailto` only — a `javascript:` URL
renders as its text — and VS Code's webview opens them externally on its own. A
fence that has not closed renders as a code block, because that is what
streaming looks like most of the time. Prompts and thinking stay plain.

Two things only a gate could say: a long code line or a wide table scrolls
inside its own box rather than widening the transcript (`layout.test.mjs`, in
Chromium — the same `min-width` trap as the tool rows, one level up), and no
element is ever created from HTML in the text (`markdown.test.mjs`). Not done:
syntax highlighting. A language label and monospace was most of the distance;
Shiki is what Nimbalyst uses and is the obvious next step if wanted.

### A button on the board closed the board

Test-plan file links and the rows in Changes opened their editor into the
active group — which, when you are pressing a button on the board, is the
board's own. VS Code hands the group to the new editor, the webview reports
`visible: false`, and `onLeft` reads that as clicking away: the board closes and
the terminal and chat come back. From the user's side: press "Default data model
at creation", the board disappears, and a file is sitting where it was. Reported
as "I get nothing, it just closes the board". The file *had* opened.

Now both open with `ViewColumn.Beside`, wrapped in `ownLayoutChange` so the
moment the group splits — when the webview transiently reports `visible: false`
— is not read as a click away either. The board stays; the file lands next to
it.

The gate needed two things the suite did not have. The harness now models what
an editor open does to the active group: `showTextDocument` and `vscode.diff`
hide the board's webview unless told `Beside`, because asserting "the call
happened" cannot see the difference, and the difference is whether the board
survives. And smoke seeds a session whose worktree is the test repo itself —
the board never lists it, but the sidecar knows its worktree, branch and base —
so a test-plan link and a changed-file row can be pressed for real instead of
only against sessions that return early with "no worktree". Before the fix the
gate read: file opened, panel disposed, terminal back.

To reach that path, `worktreeOf` now reads worktree, branch and base from the
sidecar (`store.worktreeMeta`) rather than `store.get()`. The sidecar is the
only writer of those three, so it can never know less — and it answers for a
session Claude Code has not indexed yet, which is the gap `card()` already
closed for phase and tags.

### The context meter and the spend figure died with the process

Reported as: "I restarted my VS Code and suddenly I don't see how much of the
context I have used." Followed by a second ask — show what the session has cost,
progressively, next to it — and a fair question about the cost figure that was
already on screen: "I have no idea how you did that calculation."

The honest answer to the third part was: we did not calculate it. `$0.42` on a
finished card was `total_cost_usd`, handed to us by the CLI on its result
message. That is authoritative, and it has three properties that made it useless
for a readout that stays:

1. It arrives only when a TURN ENDS. Nothing to show for the ten minutes in
   between.
2. It covers only turns this extension watched. A session continued in a
   terminal contributes nothing.
3. It is written nowhere. When the extension host goes, so does it.

The context meter had the same shape of problem and it is what the user actually
hit. `composer.contextTokens` and `composer.contextWindow` were assigned inside
`if (a)` — where `a` is the LIVE agent — and the `else` branch, the one a
restart lands on, set neither. So the meter was not a property of a session; it
was a property of a session having a running process. Restarting VS Code, or
just opening a session that finished yesterday, showed an empty corner of the
composer bar, which reads as "nobody is counting".

**Both numbers now come from the transcript.** Claude Code writes `message.usage`
on every assistant record and keeps it forever: fresh input, output, cache reads,
cache writes split by TTL. Context fill is the last main-thread response's input
side; spend is every response priced at the published per-model rates
(`sessions/usage.ts`). Both survive a restart, both cover turns nobody here
watched, and the live path computes them the same way so the figure does not
change when a run ends.

Four things had to be right, and three of them were wrong first:

- **Deduplicate by `message.id`.** A streaming response is written as one
  assistant record per completed content block, and **every record repeats the
  whole response's cumulative usage**. Summing per record bills a three-block
  answer three times. On a real session: 57 assistant frames, 21 responses — a
  2.7x overcharge that would have looked entirely plausible.
- **Price subagent frames, but never let them near the context meter.** This
  codebase already routes on `parent_tool_use_id` to keep a subagent's text out
  of the main thread, and `handle()` returns early for those frames. Pricing
  inside the assistant case therefore left every Task out of the total: the live
  figure came to two thirds of what the same frames priced to when read back
  from disk. Money is now taken before the routing; only text is separated. A
  subagent's context, meanwhile, is its own — the meter is about the main
  thread, and a Task reading 900K tokens must not pin it.
- **The SDK's `limit` takes the FIRST n messages, not the last.** `transcript()`
  passed `{ limit: 400 }`, so a 425-message session rendered its first 400 and
  silently dropped the 25 most recent — the ones anyone opening a transcript came
  for. The read is now unbounded and the window is applied to the tail. Nobody
  had reported it, which is the interesting part: the chat looked full.
- **A repaint must not re-parse the file.** The usage total needs every message,
  and `refreshAll()` runs per streamed token. The parse is cached on the session
  file's IDENTITY — `lastModified` and `fileSize`, both already in the index scan
  — rather than on a timer, because a file that has not changed cannot parse
  differently. A finished session parses once and then never again, however long
  another agent streams beside it. Measured: 14ms for a 4MB, 425-message session.

The spend figure is our own arithmetic, so it says so, and it checks itself. Each
turn's estimate is compared against the CLI's `total_cost_usd` when the result
message lands, and a gap over 20% is logged naming `MODEL_RATES` — the rate table
going stale is the failure mode, and it is silent otherwise. A model with no
published rate is not guessed at: `priced` goes false, the tokens are still
counted, and the board shows `≥ $1.23` rather than a total it knows is short.

Two smaller things fell out of it:

- **The picker's context label and the meter's denominator were two tables.**
  `MODELS[].context` was a hand-written string that had once said 200K for all
  three models when two of them are 1M. It is now derived from `MODEL_WINDOWS`,
  so a label that disagrees with the meter beside it is no longer expressible.
  The window a run actually got is still preferred over both — a compaction
  policy can pin a 1M model to 200K — and is now persisted to the sidecar when
  the SDK reports it, so a restart measures against the real denominator instead
  of the model's maximum.
- **`smoke.mjs` no longer depends on what is on the machine.** The restart path
  needs a session Claude Code knows about, and the smoke test runs against a
  throwaway repo that has none, so the gate would have been permanently skipped.
  It now seeds a real transcript with KNOWN token counts into an isolated
  `CLAUDE_CONFIG_DIR`, which makes the whole run hermetic as a side effect. The
  project directory's name is the session's cwd with every non-alphanumeric
  character replaced by `-`, `_` included, and it is the REALPATH that is
  encoded: on macOS the temp directory is a symlink and its per-user path has an
  underscore in it, so the obvious `/` and `.` substitution produced a directory
  the SDK never looks in.

Both new gates were shown to fail before being kept: reintroducing the `else`
branch turns the smoke assertions red on the exact numbers, and summing frames
instead of deduplicating them turns six usage assertions red. The composer-bar
layout gate needed a 560px viewport to be a gate at all — at 900px there is
enough room that nothing is squeezed — and it caught a real regression on the
way in: the bar is `flex-wrap: wrap`, so the spend figure appended as a sibling
landed at the far LEFT of a second row, 576px from the number it was supposed to
sit beside. The two readouts are one group now, and the test measures that they
share a row and touch.

### A panel you closed reopened itself a moment later

Reported as: "when it's running it keeps reopening the Changes and how to test.
I want it to be toggled by me only — if I press to hide them it makes no sense
they reappear."

`renderTestPlan` and `renderReview` each built a `<details>` and set
`box.open = true`. A `<details>` keeps its open state in the DOM, and `render()`
replaces the whole tree on every state message — which, while an agent streams,
is several times a second. So the collapse worked, and was undone before the
finger left the mouse.

Exactly the same shape as the scroll-position bug this file already has an entry
for, and the same fix: a key that survives the rebuild. `disclosure(box, key,
defaultOpen)` sets the state from a module-level map, stamps `data-open`, and
render() harvests every `[data-open]` from the live DOM before replacing it —
harvested rather than listened for, because a `<details>` is toggled by the
browser and there is no event we asked for.

Two details worth keeping:

- **The map is not keyed by session.** "I don't want to see the diff panel" is a
  statement about the panel, not about one card; re-expanding it on every
  session switch is the same annoyance in a smaller form.
- **It is told to the host, one way.** A webview is rebuilt from scratch when
  the board is closed and reopened, so an in-memory map alone forgets — the same
  complaint, one lifetime up. The host persists it in workspace state and seeds
  a new window with it. Seeding happens ONCE, on the first state message: a host
  copy applied on every frame would race the click that produced it, which is
  the original bug in a new place. `scroll.test.mjs` asserts that race
  explicitly.

### "I didn't know how to launch the worktree stuff"

Two problems in one report. An agent had finished, parked its card in a review
column, and left a test plan; the user then could not get the app running to
look at it. What they hit, in order: `wt serve` in the main checkout answered
"not provisioned yet — run: wt provision", which reads as a broken tool rather
than a missing step; and `localhost:8000` showed the old code, because :8000 is
the main checkout and the change was in a worktree.

Neither is a bug in anything. Both are things you have to know: that a worktree
is a separate checkout, that the app has to be started inside it, that the main
checkout is already holding the conventional port, and that the tool which sorts
that out refuses to run in the main checkout. Four facts standing between a
finished change and looking at it.

So there is a button. `run/recipe.ts` decides what to start, in a fixed order:

1. `agentsKanban.runCommand`, if the user set one. No detection, no
   second-guessing, and reported as theirs so a failure is not blamed on us.
2. **The project's own launcher.** If `wt` is on the machine and this is not the
   main checkout, use it — it owns the port, the database and the session
   cookie, and none of that is inferable from a file tree. Guessing
   `php artisan serve` at a project that has `wt` would start a second server on
   the main checkout's database with the main checkout's session cookie. If the
   worktree is not provisioned yet, the command is `wt provision && wt serve`:
   chained, so a failed provision cannot leave a server running on the wrong
   database, and it is the step the user hit the wall on.
3. **Laravel with no launcher.** Here the port must be CHOSEN, not left to the
   framework: the main checkout is normally already on 8000, and a second server
   that silently lands elsewhere is a page showing the wrong code.
4. **A `package.json` script.** The port is whatever the tool picks, so none is
   claimed.
5. Nothing. Which is an answer — it says so and offers the setting, rather than
   running something invented at somebody's project.

The port is the part that earns the button. It is read from the launcher's
registry (`~/.wt/<slug>`) when it is there, re-read after a provision because
that is when the launcher assigns it, and otherwise discovered by watching the
conventional ports. Then the browser opens **only once something answers** —
`wt provision` can spend minutes cloning a 7GB database, and opening the browser
before the server is up gives a connection error and no clue whether the button
worked. The wait is cancellable, and a wait that ends without an answer says so
and leaves the terminals running, because their output is the only explanation.

One subtlety in the slug: it must match `slug_of()` in that script exactly —
lowercase, every non-alphanumeric character to `_`, **truncated to 40** — or a
provisioned worktree reads as unprovisioned and the button offers to provision
it a second time. The board's own branch names are long enough to hit the
truncation routinely.

### Pasting a screenshot into the chat

Asked for as "a setup where I can put images into the chat to send", with a
question about copying Nimbalyst's approach, including its drawing.

**What Nimbalyst does.** Its composer takes `image/*` items off
`clipboardData`, renames each to `pasted-image-<timestamp>.<ext>`, and **stages
it as a file on disk** — with a setting for where (temp, the workspace, or a
custom path) and an offer to add the staging directory to `.gitignore` when it
is inside the workspace. The agent then gets paths.

**What this board does instead, and why.** A user message in the Agent SDK is an
Anthropic `MessageParam`, whose content may be an array of blocks — including
image blocks. So the image rides inside the message. Nothing is written
anywhere: no staging directory, no `.gitignore` entry (this project has a rule
against putting anything in the user's repository, which is the same problem
Nimbalyst's gitignore offer exists to work around), nothing to clean up, and no
tool call spent reading the file back. The model sees the picture on the turn it
was sent.

Verified against a real agent rather than assumed: a 64x64 magenta PNG through
`AgentSession` with the question "name the dominant colour", answered correctly.
The block shape was the one thing no unit test could confirm — a wrong shape
fails every attached message at runtime, and only in the real editor.

Three things that are load-bearing:

- **The webview downscales to 1568px on the long edge.** An image costs roughly
  `width * height / 750` tokens, and past that edge the service downscales
  anyway — so an unscaled retina screen grab spends ~5k tokens of context on
  detail the model never receives. It happens in the webview, where the bitmap
  already is, which keeps the host out of image decoding entirely.
- **The transcript entry keeps the COUNT, not the bytes.** That array is
  serialised to the webview on every repaint, and a few megabytes of base64 per
  frame is precisely the per-token cost this file already has an entry about. An
  images-only message would otherwise render as an empty bubble.
- **The attachment cap must not depend on decode timing.** The first version
  bounded it with `attachments.length + queued >= MAX`, which double-counts as
  soon as a decode finishes before the loop moves on — twelve pasted images
  became four under the synchronous stub, eight in a browser. The room is now
  worked out once, before anything is read. Found by the test, not by use.

**On drawing.** There is nothing to copy: Nimbalyst's `CanvasEditor` is a
collaborative node-and-edge diagram surface (YDoc, nodes, edges, comments,
revisions), not an image annotator, and its image attachments have no drawing
step. The instinct in the question — that a drawing alone does not give the
agent better context — is right as far as it goes. Marking a screenshot does
help a vision model localise, but only when the mark is paired with words: a red
box with no sentence is as ambiguous as the sentence would have been alone. If
it is ever built, the version that earns its keep is a crop plus one
rectangle/arrow, whose output is both the marked-up image AND an auto-inserted
note naming the mark ("the red box"). It is deliberately not built yet.

### Every card came back in Planning after a reinstall

Reported as: "if I tried to reinstall now it basically didn't work at all, all
the tasks were moved to planning".

Exactly that, and the evidence was two directories:

```
globalStorage/david.claude-kanban/sessions/…-pim.json      5 entries, 14:57
globalStorage/smile1294.agents-kanban/sessions/…-pim.json  1 entry,  15:20
```

VS Code derives `context.globalStorageUri` from `<publisher>.<name>`. This
extension shipped as `david.claude-kanban` and became `smile1294.agents-kanban`,
so the reinstall got an **empty storage directory**. Claude Code still had every
session — it always does, that is the point of keeping them there — so every
card came back with no sidecar entry and `list()` fell through to
`this.defaultPhase`. Nothing threw. Nothing was actually lost. The board just
forgot which column everything was in, which is the whole board.

The failure is not the rename. It is that the board's state was keyed to a name
that was always free to change, with no way back. So the sidecar now looks for
previous incarnations of itself: sibling directories under `globalStorage/` are
probed for `<id>/sessions/<this workspace>.json`, and anything they remember
that we do not is folded in and written through.

**Additive, not a swap** — which is the whole difference between fixing this and
almost fixing it. The obvious version recovers only when our own file is
MISSING, and that version would not have helped here at all: by the time it was
noticed, the new install had already written a file with one entry in it, and a
missing-file rule skips a file that exists. Meanwhile the other four sessions
were sitting in the old directory. So an entry we already have always wins, and
only ids we have never heard of are taken. A session id is globally unique, so
an entry missing from our file cannot be about something else, and the
alternative is rendering that card in the default column — the bug itself.

Four things make it safe rather than clever:

- **Ours always wins.** An entry we already have is never replaced, whatever the
  date on the file it came from.
- **Once per source**, recorded in `.recovered.json` beside the sidecar. Merging
  on every load would resurrect a session the user deleted, every single time
  they deleted it.
- **Only this workspace's file.** The filename is the encoded workspace root, so
  another folder's board is never adopted.
- **Only a directory that could be an extension.** The candidate's name must
  contain a dot, because VS Code names every extension's storage
  `<publisher>.<name>`. That is not decoration: pointed at a temp directory
  during testing, the scan cheerfully adopted a sibling left by an unrelated
  run, and two existing tests started reading each other's state.

Siblings are scanned rather than a list of old ids being hardcoded, so the next
rename costs nothing. Verified against the real thing: the four stranded `pim`
sessions come back with their phases and tags, and deleting one afterwards
sticks.

**Found while fixing it:** `contextWindow` was written by every run and never
read back — it was missing from the parse in `all()`, so the figure the context
meter measures against was lost on every launch. That field exists *specifically*
so the meter survives a restart (see the postmortem above), and it had never
worked. The `running` mark below would have gone the same way. Anything
persisted is now read back at least once by a test.

---

### A run the editor killed looked exactly like one that finished

The other half of the same report. Reloading the window, reinstalling the
extension or crashing kills every agent process mid-turn, and nothing can
re-attach to them: the CLI is a child of the extension host and dies with it.
That part is not fixable and never will be.

What was fixable is that the board said nothing. A card whose run was cut off
three seconds into a twenty-minute task rendered identically to one that had
finished and moved itself to Validating — same phase, same transcript, no agent
strip. "It stopped and said nothing" and "it finished" are the same picture, and
the difference is whether the work was ever done.

So a run now leaves a mark. `SessionMeta.running` is written when a run
registers and cleared when it reaches a terminal state, and a mark still on disk
at startup with no live agent to account for it means the host went away
mid-turn. The card says **"Interrupted 9m ago"** — the time, not a badge,
because "2m ago" and "3 days ago" call for different reactions — and the chat
page offers **Resume** or **Dismiss**.

Load-bearing details, in the order they will break if touched:

- **`stop()` clears the mark; `stopAll()` does not.** This one distinction is
  the entire feature. `stopAll()` runs when the host is going away — which IS
  the event the mark records — so clearing it there means every restart erases
  its own evidence on the way out and the banner never appears once. It
  typechecks perfectly either way; `manager.test.ts` is what catches it.
- **Zero clears it, not `undefined`.** `stripUndefined()` drops undefined from a
  patch, so `undefined` cannot clear anything and the mark would outlive every
  run that set it. Same reason `worktree` uses an empty string.
- **A live agent is never interrupted**, however old its mark — that agent *is*
  the run the mark refers to. Backwards, this puts an "interrupted" banner over
  an agent working in front of you.
- **The mark is written when the SESSION ID arrives**, not at launch. A run that
  dies before that has no transcript and nothing to resume, and
  `discardIfUntouched()` takes its worktree back.
- **Resume is a click, never automatic.** It starts a real process with a real
  bill. Doing that to every interrupted session the moment VS Code opens is not
  a decision this extension gets to make. The prompt tells the agent the truth —
  that it was cut off part-way and must check its worktree rather than assume
  its last action completed.

---

### "Test connection" said Connected to a port with nothing on it

Provider profiles compile to environment variables on the CLI, and writing an
environment variable is a request, not a result. So the feature shipped with a
probe: press **Test connection**, and it asks the CLI — through
`Query.accountInfo()` — which backend it actually resolved.

That is a genuinely good check, and it is nearly free. `query()` completes its
`initialize` control request *before* reading any prompt, and the response
already carries the account and the model list, so the probe hands `query()` a
prompt iterable that never yields, asks its two questions and aborts. Against a
real CLI: 460ms, no tokens.

Every unit test passed. Then it was run for real, against a gateway profile
pointed at `http://127.0.0.1:1`:

```
--- 2. a gateway pointed at a port nothing is on ---
{ "ok": true, "message": "Connected on Anthropic API, 6 models available." }
```

**`ok: true`.** Nothing was listening on that port, and the probe said
Connected.

The reason is obvious in hindsight and invisible from inside the module: at
`initialize` time the CLI has not made a single API request. It has read the
environment, decided which backend it *would* use, and reported that. It cannot
know the endpoint is dead, because it has not spoken to it. `accountInfo()`
describes configuration, not connectivity — and the probe had quietly treated
one as the other.

This is the ["never show a signal that cannot say bad"](#) rule, in a check
whose entire purpose was to be able to say bad. The board would have shown a
green result and then failed every agent run afterwards, which is worse than
having no button at all: a user who pressed Test connection and saw Connected
now has a *reason* to look somewhere else for the problem.

The fix has two halves, and the second half is why it is four cases rather than
one. A gateway is the only kind whose endpoint belongs to us, so it is checked
directly:

| Result | Fix it implies | Cost |
|---|---|---|
| nothing listening | start the proxy, or correct the port | free (TCP connect) |
| `404` | wrong path, or not an Anthropic-format endpoint | free |
| `401` / `403` | wrong credential — or a right one in the header this gateway does not read | free |
| `5xx` | the gateway answered; its upstream failed | free |
| `400` | it speaks this API but objected, usually an unserved model id. A pass | free |
| `200` | it answered and took the credential | one token |

Those are separate cases because they have **different fixes**. A single "could
not connect" covering all four is unactionable, and the `401` row in particular
has to name the other credential style: `ANTHROPIC_AUTH_TOKEN` sends
`Authorization: Bearer` and `ANTHROPIC_API_KEY` sends `x-api-key`, so the most
common cause of a `401` is a correct key in the wrong header — and a message
that does not say so sends the user off to regenerate a key that was always
fine.

For the cloud kinds the endpoint and the credentials are the provider's, reached
through their own SDK chain, so there is nothing of ours to test. Those now say
what they actually know — *"Claude Code is configured for Amazon Bedrock. The
first request will confirm the credentials."* — rather than "Connected".

Two things worth keeping from this:

- **The overclaim was in the wording, and the wording was the feature.** The
  code did exactly what it said; "Connected" was a claim nobody had checked the
  probe was entitled to make. Every message in `probe.ts` is now scoped to what
  that particular path verified.
- **No unit test could have found it.** The failure was in an assumption about
  someone else's process, and the only way to it was to run the thing. This is
  the same lesson as "run a real agent before believing the suite", arriving
  from a new direction: the suite was green, and had been mutation-tested, and
  was checking the wrong claim. `probe.test.ts` now covers the matrix with
  `fetch` and the TCP connect injected, because those states cannot be
  reproduced on demand.

### The model picker offered six Claude models to a DeepSeek endpoint

A user set up DeepSeek through the custom-endpoint kind, and reported:

> I literally dont have access to it in my options I only still have OpenAI or
> Claude

Their `settings.json`:

```json
{
  "id": "openrouter", "kind": "gateway", "label": "OpenRouter",
  "baseUrl": "https://api.deepseek.com/anthropic",
  "hasCredential": true,
  "models": ["default", "opus[1m]", "claude-fable-5-1[1m]", "sonnet", "sonnet[1m]", "haiku"]
}
```

Six Anthropic aliases declared against DeepSeek. Nobody typed them. They were
written by this extension, and the path is three defensible steps that compose
into nonsense:

1. `probeProvider()` read the model list from `Query.supportedModels()`.
2. `testProvider()` offered *"Use these 6 models in the picker?"* and saved the
   answer onto the profile.
3. `mergeModels()` gives a profile's declared list top priority — correctly,
   because someone who wrote a list has said something more specific than any
   discovery could.

The bad step is the first, and it is bad for a reason that is invisible from
inside the module. **`supportedModels()` answers for Claude Code, not for the
endpoint Claude Code is pointed at.** It comes out of the CLI's `initialize`
response, which is assembled before a single API request is made — the same
property that makes the provider probe nearly free is what makes its model list
worthless off first-party. Ask it while `ANTHROPIC_BASE_URL` points at DeepSeek
and it says `sonnet`, `haiku`, `opus[1m]`, because that is what *it* can run.

So the picker offered six models that endpoint has never served, every one of
which fails at the first request with a message from somebody else's system, and
there was no way to select `deepseek-chat` at all. The profile's own list is the
highest-priority source in the system, and this extension had filled it with
the wrong thing.

**The fix is to ask the only program that knows.** Every Anthropic-compatible
endpoint people actually point this at also serves a model list —
`GET <baseUrl>/v1/models`, in one of two shapes — and the richer ones carry
exactly what the board otherwise has to render as `?`:

| | ids | names | context window | price |
|---|---|---|---|---|
| OpenRouter | ✓ | ✓ | ✓ | ✓ per model, per token |
| Anthropic | ✓ | ✓ | | |
| DeepSeek, vLLM, Ollama | ✓ | | | |
| LiteLLM | ✓ | | ✓ | ✓ |

`agent/endpoint.ts` reads it, `catalogueFor()` ranks it **above** the CLI's
answer, and the source is reported as `endpoint` rather than `cli` — because
"Claude Code's list" and "this endpoint's list" are different claims and
collapsing them is what caused this.

Four things are worth keeping:

- **A declared list that matches NOTHING the endpoint serves is not honoured.**
  Normally the profile wins; that rule stands. But a filter that selects nothing
  is not a filter, and honouring this one would be honouring a list this
  extension wrote by mistake. So the endpoint's own catalogue takes over — and
  the picker *says so*, naming the ignored ids, because a setting overruled in
  silence is the next surprise. A partly-served list is still honoured, with the
  dead entries named: pinning two models out of OpenRouter's 431 is a real thing
  to want.
- **Zero is a price and `-1` is not.** OpenRouter serves 22 free models at
  `"0"`, and its auto-router publishes `"-1"` for "depends where this routes".
  Read naively, the first renders as "unknown" and the second as
  `$-1000000/Mtok` that *subtracts* from the session total. Both are now
  explicit cases, and `priceLabel()` renders a real zero as `Free`, an absent
  price as nothing at all, and a price too small to write as `<$0.0001` rather
  than rounding it to `$0` — which would make it indistinguishable from free.
- **The prices go to the meters, not just the menu.** `MODEL_RATES` is keyed by
  Anthropic's ids and knows nobody else's, so every session on a custom endpoint
  read `≥ $0.00` against a context meter with no denominator. A `ModelBook`
  carries the endpoint's own figures into `costOfUsage()` and into
  `summariseUsage()`, and both meters — the live one in `AgentSession` and the
  one totalled from the transcript in `SessionStore` — get the same book, so the
  number does not change when a run ends.
- **431 models is a different UI problem from 3.** The composer's menu grew a
  filter box and a bound, and it says how many it is not showing; the settings
  page grew the catalogue with a tick per model, which is what writes
  `profile.models`. Two lists, kept distinct on purpose: what the endpoint
  *serves* (cached, hundreds) and what the composer *offers* (on the profile, as
  few as you like).

One more thing came out of it, unprompted by the report and worse than what was
reported: Claude Code runs its own background errands — naming a session, and
others it never shows you — on a haiku-class model it names by **Anthropic's**
id. Against DeepSeek those requests 404 for the life of every session, silently,
while the conversation itself works perfectly. `smallModel` on a gateway profile
sets `ANTHROPIC_DEFAULT_HAIKU_MODEL` and `ANTHROPIC_SMALL_FAST_MODEL` (both
spellings — which one a given CLI reads is not something this extension can
know, and writing one is a fix that silently does nothing on half of them), and
the DeepSeek preset sets it.

The general lesson is the same one as ["Test connection" said
Connected](#test-connection-said-connected-to-a-port-with-nothing-on-it), from a
new direction. `accountInfo()` and `supportedModels()` come back from the same
cheap `initialize` round trip, and both describe **the CLI's configuration**
rather than anything that has been asked of a server. The first was overclaimed
as connectivity; the second was overclaimed as a catalogue. When a question is
about somebody else's service, the answer has to come from that service.

### The settings page showed a subscription that paid for nothing

Follow-up to the DeepSeek picker, and the sharper version of the same mistake.
With the fix above in place the page read:

```
Claude Code · Anthropic
● Signed in as david@prduct.com (subscription) · firstParty
```

and, a section below, an active backend pointed at `api.deepseek.com` with a key
in the keychain. Both statements were true. Together they were a lie: nothing
that session did would ever touch that subscription.

The cause is one line. `claudeRuntime.login()` called `query()` with **no
provider environment**, so `accountInfo()` reported what `claude` resolves *on
its own* — never what a session this board starts resolves. It is
`accountInfo()` overclaimed for the third time in this file: as connectivity,
then as a catalogue, now as the account that pays.

Three fixes, and the third is the one worth remembering:

- `login()` takes the active `ProviderEnv`, so it answers about the sessions the
  board will actually start.
- The card names the backend on its own row — `Backend: OpenRouter ·
  api.deepseek.com · key in keychain` — above the login. The reported symptom
  was *"why is Claude Code offering me DeepSeek models?"*, and the honest answer
  is one line the page was not saying.
- **`usesRuntimeLogin()` reconciles the two.** Where the backend does not spend
  the login, the login row goes grey and says `· not used by this backend`. A
  green tick over a credential nothing spends is the same failure as a spinner
  over a wedged process, and it is worse here, because the thing it reassures
  you about is money.

`firstParty` was on screen for the same underlying reason: `apiProvider` was
being reported in `LoginState.plan`. It is not a plan, it is somebody else's
word for a backend.

**And an agent you do not have is not a peer of one you do.** Codex had a full
card — blurb, login row, model list, and a *Use for new sessions* button that
would have made every session fail at its first step — on a machine where it was
never installed, directly above the backend that was running everything. It is
now one line at the end of the list with the install command on it. Still
listed, because dropping it would make the board's second agent undiscoverable;
not presented as something you can pick.

### "There should be two buttons"

The last of the DeepSeek thread, and the one that made the other two look like
bugs. The composer had an AGENT picker; the settings page owned the BACKEND.
Choosing what a session runs on was a cross product the user had to compute, and
the bar showed one half of it — `Claude Code` next to a model list from DeepSeek.

> there should be two fucking buttons, one of them saying Claude code Antropic,
> and the other one should be saying deepseek, the URL, and open router […] the
> open router should be showing the deepseek model, and the Claude code should
> be showing the Claude code models

That is the right design and it was never argued against — it just fell out of
the two axes being modelled honestly (a runtime is not a provider) and then
rendered as two controls. The model is still right; the UI was a leak of it.

`composer.agents` is now one flat list of runnable combinations, keyed
`<runtime>|<profile>`:

```
Claude Code        Anthropic · default backend
OpenRouter         Claude Code · api.deepseek.com
⚙ Agents, backends and logins…
```

Three things are load-bearing:

- **Both halves switch in ONE branch.** `provider` and `runtime` each kicked off
  their own model refresh, and a refresh started against the old runtime while
  the new provider is applied files one backend's models under the other's name
  — `catalogueKey` already has the postmortem for what that costs.
- **A runtime that is not installed is ABSENT, not disabled.** Codex sat on the
  bar as a peer of the agent doing all the work, on a machine that never had it,
  and picking it would have failed at the first step. `detect()` runs in the
  background at activation — the executable lookup only, never `login()`, which
  starts the CLI.
- **Not checked yet still shows.** Hiding something we have not looked for is
  the same mistake as asserting a state we did not read, which is the rule this
  whole thread kept breaking.

### Opening a session showed the workspace default, not the session

> if I switch chats the models that are working on it should stay selected […]
> I go to that chat and it shows as if Claude was working on it not deepseek

The composer was built entirely from the workspace defaults — `model`, `effort`,
`thinking`, `runtime`, the active provider — and never looked at the session in
front of it. So a card that had been running `deepseek-v4-pro` on a gateway all
morning opened with "Claude Code · Opus 5" on the bar, and the model picker
listed Anthropic's models under it.

The strange part is that the fix was already half-written. `SessionMeta` has
`model`, `effort`, `thinking` — documented as *"per-session overrides; unset
means fall through to the workspace default"* — and `runtime`, and `parseMeta`
reads all four back. **Nothing ever wrote them, and nothing ever read them.** A
whole feature that existed only as types, invisible because both halves were
missing: a written field with no reader is the failure this project has a rule
about, and this was its mirror.

Three parts:

- **`durablePatch` records what a run is on** — the backend profile (a new
  `provider` field), the model, the effort and the thinking mode, beside the
  `runtime` it already recorded.
- **`getState()` reads them back** when a session is selected, including the
  model LIST, which comes from that session's backend rather than the active
  one. Otherwise a DeepSeek card opened while first-party is selected offers
  Anthropic's models under a DeepSeek session. That list is memoised per
  profile, because `getState()` is the render path.
- **A started session's agent and backend stop being a control.** Its transcript
  lives in that runtime's own store and its backend is environment on a process
  that is already running, so neither can move — and a picker there would change
  what the NEXT session does while appearing to change this one. The chip still
  names them; it just is not a menu any more.

And the resolution had to go both ways, or the readout would be a new lie:
`launch()` now resolves model/effort/thinking from the session first and the
workspace default second, and hands the SAME resolved values to the runtime and
to the sidecar. Resuming a DeepSeek card on a day when the default is Opus would
otherwise have moved it to a model its backend has never served.

### 326KB per frame, ten times a second

> when I try to open these chats […] mainly the deepseek one sometimes the whole
> extension crashes and it lags

Measured against the real session rather than guessed at — activate the built
bundle over the user's own workspace, select the card, and weigh what goes over
the wire:

```
one posted state          326.5 KB
  composer.models         161.6 KB   (431 entries)
  transcript              158.4 KB   (141 entries)
    of which thinking     121.2 KB
  cards                     1.5 KB
at 10 repaints/sec                    3.2 MB/s
webview render                        5.8 ms/frame  (58% of the thread, on a STUB DOM)
```

Three separate faults, and two of them were new:

- **The model catalogue was on every frame.** When the picker held three Claude
  models this was invisible; asking the endpoint what it serves made it 431
  entries with a description each. It changes when you switch backend and at no
  other time. It is now omitted when unchanged — the view keeps the last one it
  saw — and `onReady` forces a resend, because a webview that has just reloaded
  holds nothing. Omitted, never `[]`: an empty list is a real state ("this
  backend serves nothing we can read") and has to stay distinguishable from
  "unchanged". It was also being formatted TWICE per state, once for the active
  backend and once for the selected session's.
- **Thinking blocks were built while collapsed.** A reasoning model's thinking
  is the biggest thing in a transcript by a wide margin, it is closed by
  default, and every byte was written into a fresh DOM node on every frame for
  text nobody was looking at. A closed `<details>` now builds no body, and
  `disclosure()` re-renders on toggle so opening one materialises it.
- **The repaint interval was a budget, not a measurement.** 100ms assumes a
  repaint is cheap; a repaint is O(transcript). `coalesce()` now scales the gap
  to what the last repaint actually cost (smoothed, so one slow frame does not
  pin it), with the floor at `intervalMs` and a 500ms cap — a board that updates
  twice a second still reads as live, one that updates every four seconds reads
  as broken.

Result: 326KB → 172KB on a steady frame, the 431-entry map gone from the hot
path, and the rate self-tuning instead of assuming.

The lesson is the one this project already has a rule about, arriving through a
door nobody was watching: the per-token rule was written about WORK, and this
was payload. Making a list authoritative made it large, and nothing in the type
system or the tests notices when a field that used to hold three things starts
holding four hundred.

### Remote Control: the board leaves as a redacted mirror

> this would be such great thing to have figure out how could we privately
> stream this board to online somewhere where only the board moves and the
> chats no code I guess or something like that, can be in separate repo like
> some hosting and you'd personally put it to netlify for free and just loging
> and all that yk

One direction, six decisions that follow from it:

**What leaves is decided by types, in one module.** `src/remote/relay.ts`
declares `RemoteCardSource` and `RemoteEntry` — the only shapes that cross —
and the host maps its own cards onto them. A `tool` row is the subtle one: its
`summary` is derived from the tool's INPUT (a Bash row summarises as its
command, an Edit row as its path), so `RemoteEntry` carries the tool's name and
status but never its summary, and the redaction drops fields, never rows,
because the viewer's per-session `tv` is a row count. The transcript tail is
capped at 120 rows.

**The relay stores nothing secret, so it cannot be robbed for a code.** A
board's address is the first 24 hex chars of the sha-256 of the pairing code
(~96 bits). The code exists in exactly two places — the pushing machine's
keychain and the watcher's browser, which keeps only the derived id. The
relay's POST gate is knowing the id (`x-rc-key`); possession of the id grants
read and write of the MIRROR only — the real board is never touched by any of
it. That is the honest price of a server with no secrets, and it is the reason
the relay page's "login" is a code field and can never be a session. (The
write channel below splits that single capability into two: the code still
grants the mirror, and a separate toggle gates anything reaching the real
board.)

**The lift-out folder is part of the repo.** `remote/` carries its own
`package.json`, `netlify.toml` and README, is excluded from the .vsix, and its
function logic (`board-core.mjs`) takes the store injected so the repo's test
suite runs the real relay code against a Map. A gate the deployable could not
run would be no gate.

**Cadence is a separate module from content.** `pusher.ts` decides when (2s
minimum between attempts, nothing sent while unchanged, a 90s heartbeat so the
viewer's "live Ns ago" keeps climbing — the number must not depend on a process
being alive, and here the process is the machine pushing). `feed.ts` decides
what: a tail travels exactly when its transcript GREW, so a quiet board does
not resend the same 120 rows forever. The viewer polls adaptively (12s while
the board is moving, 60s once quiet) because every poll is a Netlify function
invocation.

**The settings page treats the code as a credential.** It is a change-only
field (blank means keep the stored one; wiping is its own button), never
rendered from state — the host sends `hasCode`, never the code — and it goes to
`SecretStorage` like every other secret. The status line shows the relay's
actual answers: paused, connected-but-not-yet-answered, last push went out,
last push failed with its reason. "Not asked yet" is not a green tick, the
page's oldest rule.

**The viewer is a static page with the same hygiene as the webviews.** No
framework, no build, no innerHTML — the chat rows it renders are another
program's output. Node and text only.

### Remote Control: prompts back into the board

> I want to be able to, from the remote control, control as well the inputs
> into the AI model. So if I just have it connected through that remote
> control, I could basically control the Kanban board and the chats and all
> that from anywhere.

The mirror is one-way by design, and this request asks for the way back. The
shape it took, and the decisions that follow from it:

**The pairing code and the write channel are TWO capabilities, and the second
is opt-in.** The code is a capability for the mirror — anyone holding it can
read the board and junk the mirror by pushing to it, and that is fine because
the mirror is disposable. Running prompts on the real machine is different:
it starts sessions and spends money. So `remote.writes` is a separate toggle
in the settings page's Remote section, default OFF, persisted, and the
description on the page names the risk outright (anyone with the code and the
site can send one). The toggle is drawn only when a relay URL and a pairing
code are configured — a control that cannot take effect is not drawn. The
page's composer appears exactly while the index's `writes` flag is true, and
that flag is the HOST's toggle carried in every push, never something the
relay asserts.

**The relay queues, the extension gates — boundaries in code, not prose.** The
relay's job ends at holding commands (bounded: 20, 20 000 chars each, so a
holder of the id cannot bloat the store). Whether one runs is decided in
`src/remote/commands.ts`, `acceptCommands()`, host-side, in one place: the
toggle, the nonce dedup, and a re-check that the named session still exists on
the live board (the relay validates against its stored index, which is a
snapshot; the host re-checks against the board itself — a session that is gone
is dropped, never re-targeted). An accepted command runs through the SAME host
paths the local webview uses (`sendMessage` / `newSession`) — permission mode,
model flags, worktree creation, money. Nothing reaches around them, and the
tool description of none of the board tools matters to any of it.

**Act-then-ack, at-least-once.** The extension runs a command and only then
acks it; the relay forgets a command only when acked. So a prompt survives the
relay's queue and runs at least once — a host that dies between running and
acking may run it once more on the next delivery, and that window is the
host's own crash (the nonce memory is in-process). The alternative — ack
first, then act — loses commands silently, which is worse. Re-delivery while
the host is alive is a nonce no-op.

**Commands sent while the channel is OFF are discarded when it turns ON,
never run late.** The relay keeps them (capped) because the extension cannot
ack while off; enabling flushes the queue by acking everything without acting.
"Only commands sent while the switch is on ever run" is the honest contract —
a queue that runs at some later moment is a time bomb, not a feature.

**A command is a PROMPT, never a board edit.** There is no remote tool for
moving a card or touching board state: the write channel composes into an
existing session's chat or starts a new session with the text. The user's ask
was to "control the inputs into the AI model", and the inputs are prompts —
the board's moves follow from what the agent then does, which is the normal,
watched, permission-gated flow rather than an unobserved remote edit.

**Delivery rides the push loop and one gate.** Commands arrive piggybacked on
push answers (a busy board picks them up without extra traffic) and on a poll
every 30s that runs only while the toggle is on — an idle board is exactly
when a remote prompt arrives, so the poll must not depend on pushes. The
watcher's draft and focus survive the page's rebuilds the same way the
settings page's do (module-level drafts, `data-focus` hand-back), and a failed
send keeps the draft — a page that eats your prompt is a page that makes you
type it twice.

### Remote Control: any host, not just Netlify

> now it's on Netlify, for example, but I want it to be generic. It doesn't
> have to be just Netlify. It can be any other repository that can handle the
> board.

**One API path, one core, adapters only.** Every host serves the relay at
`<site>/board`: Netlify rewrites it to its function (`netlify.toml`), the
Cloudflare worker and the plain-Node server route it directly, and the host
side (`relayBase()`) normalises away `/.netlify/functions/` and a trailing
`/board`, so a URL pasted from any of them works. All behaviour lives in
`functions/board-core.mjs` with the store injected; the host files are thin
wrappers (Netlify Blobs, Workers KV, one JSON file written atomically), and
the repo's test suite runs the core against a fake Map store — so a gate the
deployables could not run would be no gate.

**The Node server is the zero-account host, and that matters.** `remote/server.js`
is dependency-free and runs the whole relay locally — which is what makes the
whole feature testable end-to-end without deploying anywhere, and what the
howToTest rides on. The other two hosts are for the public-internet case; the
local one is for today.

**The KV adapter's only job is the list shape.** Cloudflare's KV `list()`
returns `keys: [{ name }]`; `board-core` expects `blobs: [{ key }]`. That
mapping is the entire adapter, and it is pinned by a test because a store
whose list returns the wrong shape silently breaks the orphan-tail GC, not
the reads.

### The remote page WAS the text "undefined"

> when I try to access the remote board or in general setup the remote access
> I just get "undefined". is it not done or is it just broken or was it never
> done?

The whole remote feature was done, deployed-side and extension-side, and the
relay worked — the page rendered the literal text node **`undefined`** the
moment a board id existed, which is every real use: entering the pairing code,
or opening a link with the hash. Everything behind the page was tested; the
page itself had no rendering gate, which is the exact seam this bug lived in.

**`boardScreen()` drew into the root itself and returned nothing.** The page
builds screens as functions and `render()` draws whatever they return —
`pairScreen()` returned its box, `boardScreen()` called
`root.replaceChildren(head, wrap)` in two places and then fell off the end. So
`render()` ran `root.replaceChildren(undefined)`, which stringifies, and the
whole board — a perfectly good push, sitting on the relay — was replaced by
the one-word page. Reported as a feature that was "never done", which is the
usual cost of a blank-or-garbage screen: it cannot show what is broken, so it
reads as absent.

Three more things were found behind it, all in the same never-rendered page:

- **A typed pairing code never polled.** `ensurePolling()` ran the poll chain
  exactly once, at boot — before a typed code exists — and the no-id poll
  returned without re-arming. A paired page (the user's flow) would have sat
  on "waiting" forever; only the hash-link flow worked. The chain now re-arms
  without an id, and pairing fires the pending poll immediately instead of
  making a freshly paired page wait out the 15s error interval.
- **The page said "The relay did not answer" before it had asked.** The
  no-board screen chose its text by a `waiting` flag that started false, so a
  fresh pairing briefly claimed the relay was unreachable before the first
  poll had run — a lie of exactly the "signal that cannot say bad" family.
  A fresh id now starts in the waiting state, which is the true one.
- **`PORT=0` never meant an ephemeral port.** `remote/server.js` computed
  `Number(process.env.PORT) || 8787`, and `0` is falsy, so the documented
  test path silently bound the default port — which failed the whole suite
  the day a real relay was already running there. `0` is a real port request.

**The viewer page now has the same DOM gate the extension webviews have.**
`src/remote/__tests__/viewer.test.mjs` runs `remote/public/board.js` in the
shared stub DOM against a stubbed `fetch`, driving the real boot and poll
sequence — and every assertion starts with the rule the fix encodes: the
page's text must never *be* the string "undefined". Shown to fail against
the unfixed page, as a new gate must be.

## Still open

- **`verify` tests before it builds, and one test reads the build.**
  `executable.test.ts` greps `dist/extension.js`, so after a pull that changes
  bundled code it inspects yesterday's bundle and fails until someone runs
  `npm run build` by hand — F5 included, since its pre-launch task is `verify`.
  Moving `build` ahead of `test` in the script would fix it. Preflight likewise
  checks a fixed list of five packages, so a newly added devDependency
  (playwright, this week) passes preflight and fails in the test that imports it.
- **No syntax highlighting in code blocks.** Language label and monospace only.

- **A live process still cannot be re-attached after a restart**, and never will
  be: it dies with the extension host. What exists now is the most that is
  possible — the run is detected as interrupted and offered a resume. See the
  postmortem above.
- **A resumed session returning a *different* id is still not detected.** The
  reverse case — two runs sharing an id — now warns; this one does not.
  Nimbalyst fails loudly on the mismatch.
- **Permission prompts do not survive a window reload.** A pending request is
  held in memory on the `AgentSession` and is denied when the session ends.
- **The review panel refreshes on events, not on every render.** It loads on
  select, after a commit or merge, and when the selected agent finishes. It is
  four git calls, and `getState()` still runs up to ten times a second while an
  agent streams, so it deliberately does not recompute inside `getState()`. An
  agent finishing while a *different* card is selected leaves stale data behind
  Refresh.
- **A subtask queued behind `maxConcurrentAgents` is invisible until it starts.**
  A queued run has no card at all (it lives in the manager's queue, not its
  agent list), so a 4-way split on the default limit of 3 briefly shows "2
  subtasks" before the rest appear. It corrects itself within seconds, when the
  parent's turn ends and frees its slot, but the count is momentarily short in
  exactly the place the count is the point.
- **Nothing re-runs a parent once its subtasks land.** The roll-up moves the
  parent card into review and says so; integrating the pieces, if they need it,
  is a follow-up message the user sends. Auto-resuming the parent would start a
  turn nobody asked for, and the split condition — unrelated work — is the case
  where there is nothing to integrate.
- **How much of a slow turn is the MCP server's own latency is still unmeasured
  from here.** The transcript now times every call, which makes the question
  answerable by looking; nothing yet aggregates it, and nothing distinguishes a
  slow round trip from a permission prompt that went unanswered — a read-only
  MCP tool is not in the auto-allow set, so `/jira-task` can spend its time
  waiting for a human rather than for a network.
- **A session's spend is priced by this extension, not billed by the service.**
  `MODEL_RATES` in `sessions/usage.ts` is a hand-maintained table of published
  rates, and it cannot know about a discount, a subscription, a batch tier, or a
  price that moved this morning. The live drift check against the CLI's own
  `total_cost_usd` is what makes a stale table noisy rather than silent, but it
  only runs while a turn is being watched — a session read back from disk is
  priced with no such cross-check. A rate that changes between releases will
  quietly reprice every historical session on the board.
- **The window a session ran with is only known once it has run here.** The
  sidecar records `contextWindow` when the SDK reports it, so a session this
  extension has never run — one started in a terminal — falls back to the
  model's maximum from `MODEL_WINDOWS`. If that session was actually running
  under a smaller compaction window, its meter reads emptier than it is.
- **Rehydrated transcript entries are stamped with the time they were PARSED.**
  `readTranscript` sets `at: Date.now()`, so every message in a session read
  back from disk shows today's clock. `SessionMessage.timestamp` now exists in
  the SDK and would fix it; nothing uses it yet. It is why the transcript-window
  test compares entries on content rather than by deep equality.
- **Annotating an attached image is not implemented.** Paste, drop and pick are;
  drawing on the image is not, for the reasons in the entry above.
- **The Run button never stops what it started.** The terminals it opens are
  ordinary terminals, and closing them is how you stop the app. Nothing tracks
  which worktrees are serving, so `wt list` remains the way to see that.
- **An attachment is not kept after it is sent.** The bytes go to the model and
  the transcript records only how many there were, so the board cannot show you
  the screenshot you sent an hour ago. Claude Code's own transcript has it.
