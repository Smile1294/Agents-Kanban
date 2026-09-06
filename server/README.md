# Agents Kanban — the headless board

The whole board on a box, driven from a browser. This is the primary form of
Remote Control: run it on a VPS, a Mac mini or a small Linux machine that can
reach your repository, open the URL from anywhere, and use the board exactly as
you do in VS Code — send prompts, start sessions, approve permissions, move
cards, review and merge. Agents run on that box, in that repo.

## What the browser actually talks to

There is no reimplementation of the board here. The server loads the **built
extension itself** (`dist/extension.js`) and activates it against a small
`vscode` stub (`server/stub.mjs`) — the same technique `test/harness.mjs` uses
to smoke-test the real message flow. The page the browser receives is the
extension's own webview document, with two additions:

- `server/bridge.js` supplies the one API the view scripts call —
  `acquireVsCodeApi()`. Its `postMessage` becomes a `POST /api/msg`; the
  board's host answers not with a reply but by pushing a new state frame, which
  arrives over a long-lived event stream (`GET /api/events`, SSE) and is
  re-dispatched as the `window` message event the view scripts listen for.
  Dialogs a real webview never draws — quick picks, input boxes, modal
  confirmations — are drawn by the bridge as overlays, and their answer is
  `POST /api/dialog`.
- The **pairing code** is the only secret. The server prints one at startup
  (or takes yours via `AGENTS_KANBAN_CODE`). The gate page holds it in
  `sessionStorage` — never in the URL — and sends it as an `x-rc-code` header
  on every request, plus as a `?code=` query parameter on the event stream
  (an `EventSource` cannot set headers). The server compares sha-256 digests
  with `timingSafeEqual`, so the code never sits on disk or in a log.

Because the host half is the real extension, every message the extension
understands works — there is no second code path to drift.

## Set it up on a remote box

The box needs what the extension needs: **Node 22.6+**, **git**, and the agent
CLI of whichever runtime you run, **signed in on that box** (`claude login`,
or `codex login`).

```bash
git clone <your-repo-url> && cd <your-repo>
npm install
npm run remote          # builds, then serves the board on http://127.0.0.1:4310
```

The server prints the URL and the pairing code. Open the URL from any device
that can reach the box, enter the code, and the board is there — every session,
every phase, the composer, the settings page. Agents start in worktrees under
`<repo>/.agentskanban/worktrees/`, exactly as in the editor.

### Reaching it

It binds to `127.0.0.1` on purpose: anyone who holds the code can run agents
that spend money, so the default is to make the port reachable the deliberate
way:

- an **SSH tunnel** — `ssh -L 4310:127.0.0.1:4310 <box>` and open
  `http://127.0.0.1:4310` locally; or
- a **VPN** (WireGuard/Tailscale), same idea; or
- `AGENTS_KANBAN_HOST=0.0.0.0` to bind beyond localhost — put it behind TLS
  (any reverse proxy, e.g. caddy: `caddy reverse-proxy --from board.example.com --to 127.0.0.1:4310`),
  and know what you are exposing.

### Keep it running

A `systemd` unit (or tmux) is the whole of it — the server has no database and
no ports besides the one it prints:

```ini
[Service]
WorkingDirectory=/srv/board
ExecStart=/usr/bin/npm run remote
Environment=AGENTS_KANBAN_HOST=127.0.0.1
Environment=AGENTS_KANBAN_CODE=<your code>
Restart=on-failure
```

## Configuration

| Variable | Default | What it is |
|---|---|---|
| `AGENTS_KANBAN_PORT` | `4310` | the port |
| `AGENTS_KANBAN_HOST` | `127.0.0.1` | bind address — see *Reaching it* |
| `AGENTS_KANBAN_REPO` | the cwd | the repository the board works on |
| `AGENTS_KANBAN_STORAGE` | `~/.agents-kanban` | extension state, sidecar, secrets — never inside the repo |
| `AGENTS_KANBAN_CODE` | generated and printed | the pairing code. The only secret. |
| `AGENTS_KANBAN_CONFIG` | `{"focusMode":"off"}` | JSON merged into `agentsKanban` settings, e.g. `{"discoverModels":false}` |

Each is also a `--name=value` argument (`node server/server.mjs --port 9000`).

## Where things live

- The sidecar (phases, tags, worktree mapping) and extension state go to
  `AGENTS_KANBAN_STORAGE`, never into the repository. API keys saved on the
  settings page go to a `0600` file in the same directory.
- A `Ctrl+C` stops agents and shuts down cleanly. An agent the process cannot
  stop (a power cut) is reported as *Interrupted* by the same mechanism the
  extension uses, and offered a resume.

## The relay: the other, smaller mode

`remote/` also ships a **relay**: a tiny deployable site (Netlify functions,
Cloudflare Workers, or a zero-dependency Node file) that a running VS Code
extension *pushes a read-only mirror of the board to*, so a phone or another
computer can watch it without the extension's machine being reachable at all.
Its optional write channel queues prompts back, gated by the extension's own
`remote.writes` switch. See [remote/README.md](../remote/README.md).

The two modes share the pairing-code idea and the same board page, but they
are different animals: the relay *mirrors a board that runs elsewhere*; this
server *is* the board's machine.
