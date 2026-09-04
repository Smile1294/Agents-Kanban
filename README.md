# Agents Kanban

**A kanban board in VS Code that your AI agents run themselves.** Every task
gets its own git worktree, so several agents work in parallel without ever
touching each other's files — or yours.

You write the task. The agent picks it up, moves its own card across the board
as it works, and parks it in **Validating** with instructions for how to test
what it did. You review, merge, and mark it complete. Only you can do that last
part.

![The board](https://raw.githubusercontent.com/Smile1294/Agents-Kanban/main/docs/screenshots/01-kanban-board.png)

---

## Features

- **Agents move their own cards.** No "update the board" step — writing the
  phase *is* the move.
- **One git worktree per agent.** Parallel agents cannot collide, and none of
  them touch your working copy until you merge.
- **They tell you how to test.** An agent cannot mark work ready for review
  without a test plan; the files, commands and URLs become buttons.
- **Review and merge in place.** See every changed file, open a real diff,
  commit and merge back — or throw the worktree away.
- **Ask you questions.** When an agent needs a decision, you get the actual
  question and its options, not a yes/no prompt.
- **Nothing is written to your repo.** Sessions live where Claude Code already
  keeps them, so a session you start in the terminal shows up here and vice
  versa.
- **Live cost and context.** Both survive the agent process ending — and a
  VS Code restart.
- **Interrupt, queue follow-ups, change permissions mid-run.**
- **Subagents are visible**, nested under the `Task` that spawned them.
- **Attach screenshots** — paste an image straight into the composer.

---

## How it works

```
Backlog → Planning → Implementing → Validating → Complete
└──────────── the agent moves itself ──────────┘   └ yours ┘
```

1. **You create a session** and describe the task.
2. **The extension makes a git worktree** on a fresh `task/…` branch. That
   worktree is the agent's entire world — its `cwd`, its files, its branch.
3. **The agent works**, moving its own card by calling three small tools
   (`set_phase`, `set_tags`, `list_board`) that only ever act on its own
   session.
4. **It stops at Validating** and writes a test plan. It *cannot* reach
   Complete — that column is marked `humanOnly` and the refusal lives in code,
   not in a prompt.
5. **You review the diff, then merge.** Merging is the only action that writes
   to your own checkout, so it always asks first.

The two ideas everything rests on:

**A card and a session are the same thing at two zoom levels.** The board shows
every session by phase; the chat view shows one transcript. Switching never
changes what exists.

**A session's column *is* its phase.** There is no move operation.

---

## Screenshots

**An agent asking you something.** Real questions with real options — pick one,
tick several, or type your own answer.

![Asking a question](https://raw.githubusercontent.com/Smile1294/Agents-Kanban/main/docs/screenshots/10-asking-a-question.png)

**A finished session, with its test plan.** Every link is a button: files open
from the agent's worktree, commands open a terminal already `cd`'d into it.

![How to test this](https://raw.githubusercontent.com/Smile1294/Agents-Kanban/main/docs/screenshots/02-chat-with-test-plan.png)

**Asking permission.** Tool calls that write anything stop and wait.

![Permission prompt](https://raw.githubusercontent.com/Smile1294/Agents-Kanban/main/docs/screenshots/03-permission-prompt.png)

**Notices and queued follow-ups.** Type while it works — messages are held
until the turn ends rather than vanishing. The agent can interrupt *you* when
it is stuck.

![Notices and queued follow-ups](https://raw.githubusercontent.com/Smile1294/Agents-Kanban/main/docs/screenshots/07-notice-and-queue.png)

**The board with the window to itself.** The terminal and right-hand chat step
aside; your left side bar never moves, because it is how you get back.

![Full window](https://raw.githubusercontent.com/Smile1294/Agents-Kanban/main/docs/screenshots/08-full-window.png)

**It works narrow, too.**

![Narrow board](https://raw.githubusercontent.com/Smile1294/Agents-Kanban/main/docs/screenshots/04-narrow-board.png)

---

## Requirements

- **VS Code 1.90+**
- **[Claude Code](https://claude.com/claude-code)** installed and on your `PATH`.
  The extension uses the CLI you already have rather than shipping its own
  ~190MB copy. Set `agentsKanban.claudeExecutable` if it lives somewhere unusual.
- **A git repository open.** The board renders without one, but agents need a
  worktree to run in.
- **Node 22.6+** — only if you are building from source.

## Getting started

Install from the Marketplace, open a git repository, and press the **Agents
Kanban** icon in the activity bar (or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>K</kbd>).
Press **+ New session**, describe a task, and let it go.

## Settings

| Setting | What it does |
|---|---|
| `agentsKanban.model` | Model for agent sessions |
| `agentsKanban.maxConcurrentAgents` | How many agents may run at once (default 3) |
| `agentsKanban.permissionMode` | How much the agent may do unattended |
| `agentsKanban.worktreeRoot` | Where worktrees go. Default: a sibling `<repo>_worktrees` |
| `agentsKanban.focusMode` | `wide` (default), `zen`, or `off` — how much of the window the board takes |
| `agentsKanban.closeOnClickAway` | Whether opening a file closes the board |
| `agentsKanban.sideBarHome` | Which view your left side bar returns to |
| `agentsKanban.notifyOnReview` | Notify when an agent says work is ready |
| `agentsKanban.statusBar` | Show a status-bar item, with a count of running agents |
| `agentsKanban.claudeExecutable` | Path to `claude`, if it is not on `PATH` |
| `agentsKanban.runCommand` / `runUrl` | How to start your app from a worktree |

---

## Building from source

```bash
npm run verify        # installs, typechecks, builds, tests, launch gates
npm run install-local # package and install into VS Code
```

Press <kbd>F5</kbd> for an Extension Development Host. It runs the checks first,
so it will not hand you an extension that cannot start.

For the architecture, the message-stream reference and what is planned next, see
**[PLAN.md](PLAN.md)**. For why things are built the way they are — including
the bugs that shaped them — see **[docs/DECISIONS.md](docs/DECISIONS.md)**.

## Status

Working, and verified with real agents rather than only under test: agents run
in parallel in their own worktrees, move their own cards, write test plans, take
follow-up messages, and their work commits and merges back.

Not yet built: rehydrating a live agent after an extension host restart, and
support for agents other than Claude Code. See [PLAN.md](PLAN.md) §9.

## Credits and licence

MIT — see [LICENSE](LICENSE).

Built after studying [Nimbalyst](https://github.com/nimbalyst/nimbalyst) (also
MIT), keeping the ideas that are load-bearing — agents moving their own items,
policy living in tool descriptions — and dropping the ones that only exist
because Nimbalyst is an Electron app. This project shares no code with it.

Not affiliated with, or endorsed by, Anthropic or Nimbalyst.
