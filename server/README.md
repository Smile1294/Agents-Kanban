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
- The **pairing code** is the only long-lived secret. The server prints one at
  startup (or takes yours via `AGENTS_KANBAN_CODE`). The gate page exchanges it
  **once** for a session token (`POST /api/session`) — 32 random bytes that
  the server keeps in memory as a sha-256 digest, live for 12 hours by default
  (`AGENTS_KANBAN_TOKEN_TTL`). From then on the **token** rides as an
  `x-rc-token` header on every request, and in the query of the event stream
  alone (`?token=` — an `EventSource` cannot set headers). The code itself is
  accepted on exactly two routes — the exchange and `POST /api/revoke` — and
  never appears in a URL, so it cannot land in a request log, a proxy's access
  log, or a history. The one credential that ever rides in a URL is the token,
  which is exactly why tokens expire and can be revoked. The gate page keeps
  the code in `sessionStorage` only so a dead token (expiry, revoke, restart)
  can be re-exchanged once without asking — when even that fails, the gate
  returns with an "expired session" note instead of a bare error.
- Wrong pairing codes are **rate limited per client IP**: exponential backoff
  (`429` + `Retry-After`) after `AGENTS_KANBAN_AUTH_BACKOFF_AFTER` failures, a
  hard block (`403`, which refuses even the right code) after
  `AGENTS_KANBAN_AUTH_BLOCK_AFTER` failures for
  `AGENTS_KANBAN_AUTH_BLOCK_MINUTES` minutes. The counters live in memory: a
  restart forgets every block, which is honest — the code did not change. A
  restart also expires every token, and every open tab re-exchanges its stored
  code on its own within a request or two. Tokens are deliberately not rate
  limited: a token is 256 bits of randomness, so a failing one is almost always
  your own, expired by the clock or the restart.
- `media/theme.css` supplies the **theme**. The board's stylesheets take every
  colour from `--vscode-*` variables, which VS Code sets and a browser does not;
  this sheet is the editor's Dark Modern palette on `:root`, loaded before them,
  so the page is the editor's dark board rather than a white document. Dark only,
  by design — the editor is where a theme is chosen.

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
- `AGENTS_KANBAN_HOST=0.0.0.0` to bind beyond localhost — then read *TLS,
  access logs, and the firewall* below. Whoever holds the code can run agents
  that spend money; bind this way only behind a proxy you control.

### TLS, access logs, and the firewall

A box that binds beyond loopback must answer on `https`, must not log the
credential that rides in URLs, and must not expose the board's own port to the
world at all. The config below is the whole story; the *why* of each piece is
under it.

**Caddy** — TLS from Caddy's store, access log with the query masked, proxy
only:

```caddyfile
board.example.com {
	reverse_proxy 127.0.0.1:4310 {
		# Trusted only because the firewall below makes this proxy the only
		# way in — which is what makes AGENTS_KANBAN_TRUST_PROXY=1 sound.
		header_up X-Forwarded-For {remote_host}
	}

	log {
		output file /var/log/caddy/board-access.log {
			roll_size 100MiB
			roll_keep 10
		}
		format filter {
			# The ONLY credential that ever rides in a URL is the session token,
			# in the event stream's query (?token=…, /api/events). Mask it — and
			# `code` too, in case a log predates the token scheme. The path
			# itself stays visible; nothing secret lives there.
			request>uri query {
				replace token [REDACTED]
				replace code [REDACTED]
			}
			wrap json
		}
	}
}
```

Use `wrap json`, never `wrap common_log`: `common_log` is rendered as one
string before the filter runs, so per-field filters do not reach inside it and
the token lands in the log unmasked (caddyserver/caddy#3837).

**nginx** — the format never sees the query at all, because `$uri` excludes
it. The default `combined` format logs `$request_uri` (query included), so the
board must point `access_log` at its own format:

```nginx
log_format board '$remote_addr [$time_local] "$request_method $uri $server_protocol" $status $body_bytes_sent';

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    # ssl_certificate / ssl_certificate_key: your certs

    location / {
        proxy_pass http://127.0.0.1:4310;
        proxy_set_header Host $host;
        # Trusted because the firewall below makes this proxy the only way in.
        proxy_set_header X-Forwarded-For $remote_addr;
    }

    access_log /var/log/nginx/board-access.log board;
}
```

**The firewall** — the TLS terminator and SSH are the only ports the network
may touch. The proxy is on the box itself, so loopback traffic still reaches
the board after the rule that blocks its port:

```bash
# ufw
sudo ufw allow 22/tcp            # ssh — or you lock yourself out
sudo ufw allow 80,443/tcp        # the TLS terminator
sudo ufw deny 4310/tcp           # the board's own port: proxy only
sudo ufw enable

# firewalld
sudo firewall-cmd --permanent --add-service={ssh,http,https}
sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=127.0.0.1 port port=4310 protocol=tcp accept'
sudo firewall-cmd --reload

# nftables (a minimal host policy; put the 4310 drop before any broad accept)
# table inet filter {
#   chain input {
#     type filter hook input priority filter; policy drop;
#     ct state established,related accept
#     iif "lo" accept                  # the proxy's local connections
#     iifname != "lo" tcp dport 4310 drop   # the board: proxy only
#     tcp dport { 22, 80, 443 } accept      # ssh + the TLS terminator
#   }
# }
```

And on the server set the two env knobs that only make sense behind this
setup: `AGENTS_KANBAN_HOST=0.0.0.0` and `AGENTS_KANBAN_TRUST_PROXY=1`.

**Why the only URL credential is the one that dies.** The event stream has no
header channel — an `EventSource` cannot set one — so the one request that
must carry a credential in its URL is `GET /api/events?token=…`. The design
keeps that fact survivable: what rides in the URL is a 256-bit random token
that expires after `AGENTS_KANBAN_TOKEN_TTL`, dies on `POST /api/revoke`, and
dies on every server restart — while the pairing code, which could mint tokens
forever, is accepted on exactly two routes, never in a URL, and cannot leak
into an access log in the first place. The log filter above is belt-and-braces
on top of that: it masks a credential whose leak would cost little, rather
than the one whose leak would cost everything.

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
| `AGENTS_KANBAN_CODE` | generated and printed | the pairing code — the only long-lived secret |
| `AGENTS_KANBAN_TOKEN_TTL` | `43200` (12 h) | seconds a session token lives after the code exchange |
| `AGENTS_KANBAN_AUTH_BACKOFF_AFTER` | `5` | wrong codes before the server answers `429` + `Retry-After` (exponential backoff) |
| `AGENTS_KANBAN_AUTH_BLOCK_AFTER` | `20` | wrong codes before a hard `403` block — even the right code is refused |
| `AGENTS_KANBAN_AUTH_BLOCK_MINUTES` | `15` | how long the hard block lasts (a restart clears it sooner) |
| `AGENTS_KANBAN_TRUST_PROXY` | off | rate-limit by `X-Forwarded-For` instead of the socket address — ONLY behind a proxy that overwrites the header (see the TLS section), or anyone can forge it |
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
