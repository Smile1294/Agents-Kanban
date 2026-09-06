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

Watch the board from anywhere — a phone, another computer — and optionally send
prompts back to it.

1. Deploy the small relay in [`remote/`](remote/README.md) — the same folder
   runs on **Netlify, Cloudflare Workers, or any Node server**, and the free
   tiers cover ordinary use.
2. In the extension: **settings page → Remote Control**, paste the relay's URL
   and choose a pairing code.
3. Open the relay site on any device and enter the same code.

Only cards and chat rows leave your machine — no file paths, no commands, no
credentials — and the relay stores nothing secret: the board's address is a
hash of your pairing code, which never leaves your machine. By default the
relay is a read-only mirror. Turning on **Allow prompts from the remote page**
adds a composer on the watching device, and the extension runs those prompts
exactly like one typed locally, through the same permissions. Treat the pairing
code like a password — anyone with it can watch the board, and send prompts
while the write channel is on. Full details: [remote/README.md](remote/README.md).

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

Everything else — agents, backends, logins, remote control, dictation — lives
on the **Agents Kanban: Settings** page.

## Building from source

```bash
npm run verify        # installs, typechecks, builds, tests, launch gates
npm run install-local # package and install into VS Code
```

Press <kbd>F5</kbd> for an Extension Development Host.

For the architecture and what is planned next, see **[PLAN.md](PLAN.md)**. For
why things are built the way they are, see **[docs/DECISIONS.md](docs/DECISIONS.md)**.

## Credits and licence

MIT — see [LICENSE](LICENSE). Built after studying
[Nimbalyst](https://github.com/nimbalyst/nimbalyst) (also MIT); this project
shares no code with it. Not affiliated with Anthropic or Nimbalyst.
