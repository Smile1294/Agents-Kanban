# The codemap — this repository's knowledge base, one file per area

This folder is what a freshly spawned agent reads instead of exploring the repo
from scratch. It works the way a skills library works: **this index is always
worth reading; each area file is read only when your task touches that area.**
Every area file carries YAML frontmatter that says which source files it OWNS,
and that ownership is what the board enforces (below).

Checked against the code on 2026-09-07. Line numbers are deliberately absent —
they drift; grep the function names instead.

## How to use it

1. Read this file, top to bottom. It is short on purpose.
2. Find the rows in [the areas table](#the-areas) that match your brief, and
   read those files — usually one or two. Do not read all of them.
3. Then read the **header comment** of every source file you are about to
   change. In this codebase the header IS the documentation: what the file owns,
   the trap it exists to avoid, often the postmortem behind it. Then its test in
   the sibling `__tests__/`.
4. [CLAUDE.md](../../CLAUDE.md) holds the rules. [DECISIONS.md](../DECISIONS.md)
   *"Still open"* lists what is unfixed on purpose — read it before "fixing"
   anything listed there. [PLAN.md §9](../../PLAN.md) is the honest to-do list.

## The rule: knowledge files move with the code

Every source file is owned by exactly one area file, through the `paths:` list
in that file's frontmatter. When you change a source file, you update its area
file in the same branch:

- **Fix what your change made false.** A statement that used to be true and is
  now wrong is worse than no statement.
- **Append one line under `## Recent changes`** of that area file:
  `- YYYY-MM-DD · <branch or card> · what changed, one sentence.`
- **A new source file is claimed** by adding it to an area's `paths:` (or by
  adding a new area file, in the same format). The integrity test fails on an
  unclaimed file, so `npm run verify` tells you.
- **Touch only the areas you changed.** Editing a knowledge file for an area
  you did not work in is how two branches conflict in a file neither needed.
  There is deliberately no shared changelog for the same reason.

**This is enforced, not requested.** `set_phase` into a review column
(`validating`) is REFUSED while any area whose source you changed has an
untouched knowledge file — the refusal names the file(s). The check runs
host-side in `src/board/codemap.ts` over `git diff` against your base, and it
is the same check for Claude Code and Codex sessions. Test files
(`**/__tests__/**`, `*.test.*`) and documentation are exempt; a change to them
alone requires nothing.

## Before you touch anything

You are in a **git worktree** at `<repo>/.agentskanban/worktrees/<name>` on a
branch `task/<id>-<slug>`, forked from `main`. Run everything from there. Never
`cd` to the main checkout; never use bare `git stash` (the stash stack is shared
with every other agent).

| Fact | Consequence |
|---|---|
| `node_modules` is **absent** in a fresh worktree | The first `npm run …` runs `scripts/preflight.mjs`, which installs. Needs Node 22.6+. |
| `npm run verify` = preflight → typecheck → build → tests → `smoke.mjs` | ~13 s once installed. Run it before you move your card to review. |
| One test: `node --experimental-strip-types --no-warnings src/<dir>/__tests__/<x>.test.ts` | `.mjs` tests run with plain `node`. No framework: `ok:` / `FAIL:` lines, non-zero exit. `scripts/test.mjs` stops at the first failing file. |
| Some tests read `dist/` | `executable.test.ts`, `board-bridge.test.ts`, `smoke.mjs`, `test/harness.mjs` load the **built bundle**. `verify` builds first; running tests alone, `npm run build` first. |
| Some tests need **Chromium** | `src/board/__tests__/layout.test.mjs`, `src/remote/__tests__/headless.test.mjs` (and `test/screenshots.mjs`). They FAIL without one, never skip. Install once: `node scripts/run-bin.mjs playwright playwright install chromium`. |
| `smoke.mjs` is hermetic | It seeds a throwaway `CLAUDE_CONFIG_DIR` and spawns no CLI (`discoverModels: false`). Keep it that way. |
| Nothing TRACKED goes into the user's repository | Board state lives in extension storage. The only thing the extension writes into a repo is the ignore rule for `/.agentskanban/`. |
| Every npm script starts with `node` or `npm` | No `npx`, no bare binary names, no bashisms — npm runs scripts through `sh`. Use `node scripts/run-bin.mjs <package> <bin> …`. |
| `vscode` is imported only by `src/extension.ts`, `src/board/panel.ts`, `src/board/settings.ts` | Everything else is plain Node and unit-tested without an editor. A new `vscode` API also goes into `test/harness.mjs` and `server/stub.mjs`. |

**Your card is your session.** `set_phase("implementing")` at your first edit;
`set_phase("validating", …)` with a `howToTest` when you are done — that move is
how a run ends, whatever else told you to stop. `complete` is refused in code.
`split_task` works only while your worktree is clean and has no commits, once,
one level deep, at most four pieces.

## The shape of the system

```
                         ┌────────────────────────────────────────────────────────┐
  you, or a browser ───► │  webview: media/board.js · media/settings.js           │
                         │  (vanilla JS, no innerHTML, state held at module level) │
                         └───────────────▲──────────────────────┬─────────────────┘
                     UiState frames, coalesced   postMessage {type, …}
                                         │                      ▼
                         ┌───────────────┴────────────────────────────────────────┐
                         │  host: src/extension.ts (one activate()) +              │
                         │        src/board/panel.ts (BoardHost, wire(), UiState)  │
                         │  getState() ← SessionStore + AgentManager + Worktrees   │
                         └───┬──────────────────┬───────────────────┬─────────────┘
                             │                  │                   │
              ┌──────────────▼───┐   ┌──────────▼──────────┐   ┌────▼─────────────────┐
              │ src/sessions/    │   │ src/agent/           │   │ src/git/             │
              │ what is on DISK  │   │ what is RUNNING      │   │ one worktree per task │
              │ ~/.claude/…      │   │ AgentManager → a     │   │ create · diff · commit│
              │ ~/.codex/…       │   │ runtime.start(spec)  │   │ merge --no-ff --no-   │
              │ + sidecar (meta) │   │   claude: SDK query()│   │ commit · MERGE_HEAD   │
              └──────────────────┘   │   codex: app-server  │   └──────────────────────┘
                                     │ board tools (MCP) ←──┼── the agent moves its own card
                                     └──────────────────────┘   in-process, or over a socket
```

Two ideas everything rests on: **a card and a session are the same thing**, and
**a session's column is its `phase`** — writing `phase` is the move. Two axes
that are not the same thing: a **runtime** is the agent program (Claude Code,
Codex — a different process); a **provider** is the backend behind Claude Code
(environment variables on the child).

## The areas

| File | Owns | Open it when your task is about… |
|---|---|---|
| [extension-host.md](extension-host.md) | `src/extension.ts`, `src/board/panel.ts`, `src/board/settings.ts`, `src/board/coalesce.ts`, `package.json` | a webview message, a command, a setting, `getState()`, repaint cost, the settings tab, the manifest |
| [webview.md](webview.md) | `media/*.js`, `media/*.css` | anything drawn: cards, the transcript, the composer, the fast path, scroll/caret survival, markdown, the settings page, the theme |
| [board-model.md](board-model.md) | `src/board/config.ts`, `src/board/questions.ts` | columns, phases, the human-only gate, agent states, stalled cards, the age bound, `AskUserQuestion` |
| [sessions.md](sessions.md) | `src/sessions/*` except the Codex store | transcripts on disk, the sidecar (`MetaStore`), context and spend arithmetic, background agents, search, rewind, slash commands |
| [agent-runs.md](agent-runs.md) | `src/agent/manager.ts`, `session.ts`, `tools.ts`, `board-bridge.ts`, `images.ts`, `dictation.ts`, `src/board-mcp.ts` | a run's lifecycle, the queue, the brief, board tools, permissions, live spend, background tasks, images, dictation |
| [runtimes.md](runtimes.md) | `src/agent/runtime.ts`, `runtimes/*`, `jsonrpc.ts`, `sdk.ts`, `connect.ts`, `status.ts`, `src/sessions/codex-store.ts` | Claude Code vs Codex, adding a runtime, the meter union, JSON-RPC, finding the CLI, login state |
| [providers-models.md](providers-models.md) | `src/agent/providers.ts`, `models.ts`, `endpoint.ts`, `probe.ts` | Bedrock/Vertex/gateways, environment variables, the model picker, endpoint catalogues, the connection test |
| [orchestration.md](orchestration.md) | `src/agent/routing.ts`, `spawn-policy.ts`, `src/board/decomposition.ts`, `src/board/subtasks.ts` | splitting, subtasks, the dial, routing a piece to another agent, the roll-up |
| [scheduling.md](scheduling.md) | `src/board/schedules.ts` | scheduled runs, catch-up, the `schedule_*` tools |
| [git-worktrees.md](git-worktrees.md) | `src/git/*`, `src/run/recipe.ts` | worktrees, diffs, commit, merge, conflicts, the ignore rule, the Run button |
| [remote.md](remote.md) | `src/remote/*`, `remote/**`, `server/**` | the relay mirror, prompts from a phone, the headless board |
| [build-and-test.md](build-and-test.md) | `scripts/**`, `test/**`, `smoke.mjs`, `esbuild.mjs`, `tsconfig.json`, `.vscodeignore`, `.vscode/**` | the gates, the harness, the bundle, packaging, F5 |

Cross-cutting, no ownership: [flows.md](flows.md) (a run, a repaint, a split, a
merge, a schedule, a Codex run, remote) and [glossary.md](glossary.md).

## The format of an area file

```markdown
---
name: board-model
description: one line, used to decide whether to open the file
paths:            # the source files this area OWNS — the gate reads this
  - src/board/config.ts
tests:            # the gates that cover it
  - src/board/__tests__/config.test.ts
last_verified: 2026-09-07
---
# Title
## Owns            what this area is responsible for, in prose
## Files           per file: purpose · exports to reach for · its test · the trap
## How it works    the mechanism, deep enough to change it safely
## Change recipes  "to add X: touch A, B, C; the gate that catches a mistake is D"
## Invariants      what must stay true, and the postmortem behind each
## Open work       the PLAN.md §9 items that land in this area
## Recent changes  one line per change, appended — never rewritten
```

The frontmatter is parsed by `src/board/codemap.ts`; the integrity test
(`src/board/__tests__/codemap.test.ts`) checks that every source file is owned
by exactly one area, that every `paths:` entry matches a real file, and that
every `src/…`, `media/…`, `server/…`, `scripts/…`, `test/…` path named in these
files exists — so the map cannot rot silently.
