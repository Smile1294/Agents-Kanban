# Agents Kanban

**A kanban board in VS Code that your AI agents run themselves.** Every task
gets its own git worktree, so several agents work in parallel without ever
touching each other's files — or yours.

You write the task. The agent picks it up, moves its own card across the board
as it works, and parks it in **Validating** with instructions for how to test
what it did. You review, merge, and mark it complete. Only you can do that last
part.

![The board](https://raw.githubusercontent.com/Smile1294/Agents-Kanban/main/docs/screenshots/01-kanban-board.png)

## Features

- **Agents move their own cards.** Writing the phase *is* the move — the agent
  uses three small tools that only ever act on its own session.
- **One git worktree per agent.** Parallel agents cannot collide, and nothing
  touches your working copy until you merge.
- **They tell you how to test.** An agent cannot say work is ready without a
  test plan; the files, commands and URLs become buttons on the card.
- **Review and merge in place.** See every changed file, open a real diff,
  merge back — or throw the worktree away.
- **Ask you questions.** A real question with options, not a yes/no prompt.
- **Nothing is written to your repo.** Sessions live where Claude Code already
  keeps them, so a session you start in the terminal shows up here and vice
  versa.
- **Live cost and context**, surviving the agent ending and a VS Code restart.
- **Claude Code and Codex, side by side.** Pick which agent runs each session;
  Codex is driven natively through its own server — no proxy, nothing to
  configure. See [docs/RUNTIMES.md](docs/RUNTIMES.md).
- **Run on your own backend.** Anthropic, Bedrock, Vertex, Foundry, an LLM
  gateway, or a local model. Credentials go to VS Code's secret storage, never
  to `settings.json`. See [docs/PROVIDERS.md](docs/PROVIDERS.md).
- **Interrupt, queue follow-ups, change permissions mid-run.**
- **Subagents, attached screenshots, ultracode, fast mode.**
- **One task becomes several.** An agent that finds its brief is really two
  jobs splits it into up to four subtasks — each its own session, worktree and
  card, on its own agent and model if you say so — and the parent tells you
  when the last one is ready to test.
- **Scheduled runs.** A brief that starts a fresh session at a set time on set
  days, from the settings page or from an agent.
- **Search every transcript**, rewind a session to an earlier message with its
  files restored, and dictate a prompt locally with whisper.cpp.
- **The headless board.** Run the extension itself on a box and drive the whole
  board from a browser.

## How it works

```
Backlog → Planning → Implementing → Validating → Complete
└──────────── the agent moves itself ──────────┘   └ yours ┘
```

1. **You create a session** and describe the task.
2. **The extension makes a git worktree** on a fresh `task/…` branch, under
   `.agentskanban/worktrees/` in the repository. That worktree is the agent's
   entire world — its `cwd`, its files, its branch. The first session adds
   `/.agentskanban/` to your `.gitignore`.
3. **The agent works**, moving its own card by calling `set_phase`, `set_tags`
   and `list_board`.
4. **It stops at Validating** and writes a test plan. It *cannot* reach
   Complete — the refusal lives in code, not in a prompt.

![A finished session, with its test plan](https://raw.githubusercontent.com/Smile1294/Agents-Kanban/main/docs/screenshots/02-chat-with-test-plan.png)

5. **You review the diff, then merge.** Merging is the only action that writes
   to your checkout, so it always asks first.

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
Cloudflare Workers, or a plain Node process — the free tiers cover ordinary
use), so you can watch it from a phone without the extension's machine being
reachable at all. The relay is not part of this repository — it lives in its
own, [agents-kanban-relay](https://github.com/Smile1294/agents-kanban-relay):
deploy that repo, paste its URL and a pairing code into **settings page →
Remote Control**, then open the site on any device and enter the same code.
Prompts can be sent back too, behind a switch that is off by default. The two
repos stay in step through [`remote-contract.json`](remote-contract.json),
carried verbatim in both and checked by this repo's `verify`.

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
- **[Claude Code](https://claude.com/claude-code)** on your `PATH`. The
  extension uses the CLI you already have rather than shipping its own copy.
- **A git repository open.** The board renders without one, but agents need a
  worktree to run in.
- **[Codex](https://developers.openai.com/codex) — optional**, for sessions on
  it: `npm install -g @openai/codex`, then `codex login`. See
  [docs/RUNTIMES.md](docs/RUNTIMES.md).
- **Node 22.6+** — only if you are building from source.

## Getting started

Install from the Marketplace, open a git repository, and press the **Agents
Kanban** icon in the activity bar. Press **+ New session**, describe a task,
and let it go.

## Settings

| Setting | What it does |
|---|---|
| `agentsKanban.runtime` | Which agent program new sessions run on: `claude` or `codex` |
| `agentsKanban.model` | Model for agent sessions |
| `agentsKanban.provider` / `providers` | Which backend agents run on. Default `inherit` changes nothing — see [docs/PROVIDERS.md](docs/PROVIDERS.md) |
| `agentsKanban.maxConcurrentAgents` | How many agents may run at once (default 3) |
| `agentsKanban.permissionMode` | How much the agent may do unattended |
| `agentsKanban.worktreeRoot` | Where worktrees go. Default: `.agentskanban/worktrees` inside the repo |
| `agentsKanban.focusMode` | `wide` (default), `zen`, or `off` |
| `agentsKanban.runCommand` / `runUrl` | How to start your app from a worktree |
| `agentsKanban.orchestration` | How readily a new session splits itself: `minimal`, `balanced` (default), `maximum` |
| `agentsKanban.hideSessionsOlderThanDays` | Hide sessions the board never touched once older than this (default 30); the hidden count stays visible |
| `agentsKanban.discoverModels` | Ask the backend for its model list instead of using the built-in one (default on) |
| `agentsKanban.notifyOnReview` / `statusBar` | The notification when a card reaches review; the status-bar item |
| `agentsKanban.sideBarHome` / `closeOnClickAway` | Which view the left side bar returns to; whether clicking away closes the board |
| `agentsKanban.claudeExecutable` / `codexExecutable` | Paths to the CLIs when they are not on `PATH` |
| `agentsKanban.whisperPath` / `whisperModel` / `ffmpegPath` / `recordDevice` | Local dictation |

Everything else — agents, backends, logins, scheduled runs, remote control,
dictation — lives on the **Agents Kanban: Settings** page.

## Building from source

```bash
npm run verify        # installs, typechecks, builds, tests, launch gates
npm run install-local # package and install into VS Code
```

Press <kbd>F5</kbd> for an Extension Development Host.

For the architecture and what is planned next, see **[PLAN.md](PLAN.md)**. For
where everything is in the code, see **[docs/codemap/](docs/codemap/README.md)**. For
why things are built the way they are, see **[docs/DECISIONS.md](docs/DECISIONS.md)**.

## Credits and licence

MIT — see [LICENSE](LICENSE). Built after studying
[Nimbalyst](https://github.com/nimbalyst/nimbalyst) (also MIT); this project
shares no code with it. Not affiliated with Anthropic or Nimbalyst.
