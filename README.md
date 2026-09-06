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
- **The model picker shows what your CLI actually has.** It is read from Claude
  Code rather than hardcoded, so a newly released model is simply there — and
  the effort levels, thinking toggle, **Ultracode** and **fast mode** are the
  selected model's, so they disappear for a model that does not support them
  instead of doing nothing.
- **Interrupt, queue follow-ups, change permissions mid-run.**
- **Subagents are visible**, nested under the `Task` that spawned them.
- **Attach screenshots** — paste an image straight into the composer.
- **Claude Code *and* Codex, side by side.** Pick which agent runs each session;
  they run at the same time, in their own worktrees, on their own models. Codex
  is driven natively through its own `app-server` — **no proxy, nothing to
  configure**. If you have run `codex login`, it works, ChatGPT subscription
  included. A subscription session shows the rate-limit window it is actually
  spending rather than a made-up `$0.00`. See [docs/RUNTIMES.md](https://github.com/Smile1294/Agents-Kanban/blob/main/docs/RUNTIMES.md).
- **Run on your own backend.** Anthropic, Amazon Bedrock, Google Cloud's Agent
  Platform, Microsoft Foundry, Claude Platform on AWS, an LLM gateway, or a
  local model behind a translation proxy. Credentials go to VS Code's secret
  storage, never to `settings.json` — and the bar shows the provider the CLI
  *actually resolved*, so a config that was silently overridden says so instead
  of being believed. See [docs/PROVIDERS.md](https://github.com/Smile1294/Agents-Kanban/blob/main/docs/PROVIDERS.md).

---

## How it works

```
Backlog → Planning → Implementing → Validating → Complete
└──────────── the agent moves itself ──────────┘   └ yours ┘
```

1. **You create a session** and describe the task.
2. **The extension makes a git worktree** on a fresh `task/…` branch, under
   `.agentskanban/worktrees/` in the repository. That worktree is the agent's
   entire world — its `cwd`, its files, its branch. The first session adds
   `/.agentskanban/` to your `.gitignore`; commit that one line and git never
   mentions the directory again.
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

## Remote control

Two ways to reach the board from somewhere else, one pairing code each.

**The headless board** is the full thing: run it on a VPS, a Mac mini or a
small Linux box that holds the repo, and drive the board from any browser —
send prompts, start sessions, approve permissions, move cards, review and
merge. Agents run on that box.

```bash
git clone <repo> && cd <repo>
npm install
npm run remote   # prints a URL and a pairing code — open, enter, done
```

The page the browser gets is the extension's own webview; the pairing code
travels as a header on every request and in the event-stream URL, and nothing
else is secret. See [server/README.md](server/README.md).

**The relay** mirrors a board running in VS Code to a small site (Netlify,
Cloudflare Workers, or a plain Node process), so you can watch it from a phone
without the extension's machine being reachable at all. See
[remote/README.md](remote/README.md).

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
- **[Codex](https://developers.openai.com/codex) — optional.** Only if you want
  to run sessions on it. `npm install -g @openai/codex`, then `codex login`;
  the board uses that login and never asks for a key. Set
  `agentsKanban.codexExecutable` if it lives somewhere unusual.
- **Nothing extra for a different provider.** If your Claude Code is already
  pointed at Bedrock, Vertex or a gateway, that keeps working untouched: the
  default provider profile inherits whatever the CLI resolves. Everything —
  agents, backends and logins — is on one page: **Agents Kanban: Settings**.
- **Node 22.6+** — only if you are building from source.

## Getting started

Install from the Marketplace, open a git repository, and press the **Agents
Kanban** icon in the activity bar (or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>K</kbd>).
Press **+ New session**, describe a task, and let it go.

## Settings

| Setting | What it does |
|---|---|
| `agentsKanban.runtime` | Which agent program new sessions run on: `claude` or `codex`. Per session on the composer bar — see [docs/RUNTIMES.md](https://github.com/Smile1294/Agents-Kanban/blob/main/docs/RUNTIMES.md) |
| `agentsKanban.codexExecutable` | Path to `codex`, if it is not on your `PATH` |
| `agentsKanban.model` | Model for agent sessions |
| `agentsKanban.discoverModels` | Ask the CLI which models it can run, so new ones appear without an extension update (default on) |
| `agentsKanban.provider` / `providers` | Which backend agents run on. Default `inherit` changes nothing — see [docs/PROVIDERS.md](https://github.com/Smile1294/Agents-Kanban/blob/main/docs/PROVIDERS.md) |
| `agentsKanban.maxConcurrentAgents` | How many agents may run at once (default 3) |
| `agentsKanban.permissionMode` | How much the agent may do unattended |
| `agentsKanban.worktreeRoot` | Where worktrees go. Default: `.agentskanban/worktrees` inside the repo |
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
follow-up messages, and their work commits and merges back. The board survives a
restart — including a reinstall that renames the extension — and a run the editor
cut off says so and offers to pick itself back up.

Not yet built: re-attaching to a *live* process after a restart (it dies with the
extension host, so resuming the session is the most that is possible), permission
prompts that survive a window reload, and support for agents other than Claude
Code. See [PLAN.md](PLAN.md) §9.

## Credits and licence

MIT — see [LICENSE](LICENSE).

Built after studying [Nimbalyst](https://github.com/nimbalyst/nimbalyst) (also
MIT), keeping the ideas that are load-bearing — agents moving their own items,
policy living in tool descriptions — and dropping the ones that only exist
because Nimbalyst is an Electron app. This project shares no code with it.

Not affiliated with, or endorsed by, Anthropic or Nimbalyst.
