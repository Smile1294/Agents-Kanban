---
name: remote
description: The board away from the editor — the relay mirror (what may leave the machine, when it is pushed, prompts coming back), the deployable relay site for Netlify / Cloudflare / Node, and the headless board that runs the extension itself on a box
paths:
  - src/remote/*.ts
  - remote/**
  - server/**
tests:
  - src/remote/__tests__/relay.test.ts
  - src/remote/__tests__/cards.test.ts
  - src/remote/__tests__/feed.test.ts
  - src/remote/__tests__/pusher.test.ts
  - src/remote/__tests__/commands.test.ts
  - src/remote/__tests__/handler.test.mjs
  - src/remote/__tests__/server.test.mjs
  - src/remote/__tests__/worker.test.mjs
  - src/remote/__tests__/viewer.test.mjs
  - src/remote/__tests__/headless.test.mjs
  - src/remote/__tests__/headless-auth.test.mjs
last_verified: 2026-09-07
---
# Remote — the board away from the editor

## Owns

Two different animals sharing a pairing-code idea. The **relay** mirrors a board
that runs in VS Code to a small site, redacted, read-mostly, with an optional
write channel for prompts. The **headless board** IS the board: the built
extension activated on a box against a `vscode` stub, driven from a browser,
running agents in that repo. Narratives: [remote/README.md](../../remote/README.md),
[server/README.md](../../server/README.md).

## Files

**`src/remote/relay.ts`**. The shape of what may leave: `RemoteCardSource` →
`projectIndex` / `projectTail` → `RemoteIndex` (columns, cards with title,
phase, tags, runtime, `updated`, a one-line activity — the tool NAME only) and
`RemoteTail` (`TAIL_MAX = 120` redacted rows via `redactEntry`); `boardIdOf(code)`
— the first 24 hex of sha-256 of the pairing code, the board's address, so the
relay never sees the code; `indexBlob` / `tailBlob`; `relayBase`; `KEY_OK`.
**The input type IS the redaction boundary**: repo paths, branches, file names,
diffs, code, configuration, credentials, permission questions, queued prompts,
test plans and review data are not in it and cannot be transmitted. Test:
`relay.test.ts` — field-by-field and absent-field-by-absent-field.

**`src/remote/cards.ts`**. `toRemoteCard(c: UiCard)`, `remoteAgent(a)` — the two
filters, taking the WHOLE card so the filter is a real filter; type-only
imports so it runs under the plain-Node runner. Test: `cards.test.ts` stuffs a
card with the most sensitive fields in the codebase and asserts none survive.

**`src/remote/feed.ts`**. `RemoteFeed.build()` — what a push carries, decided
from what CHANGED: the index when its content differs, a tail only when its
session's transcript GREW (a count per session, which is also the `tv` version
the page refetches on); `setCount` for the one-time backfill. Test: `feed.test.ts`.

**`src/remote/pusher.ts`**. `RemotePusher` — WHEN a snapshot leaves: `nudge()`
from every repaint; at most one attempt per `MIN_INTERVAL` (2 s — the push rides
the event loop the CLI's stdout is drained on); idle = no push; a heartbeat
after `HEARTBEAT_MS` (90 s) rewriting `at`, because a number the board shows
must not depend on a process being alive; `BACKOFF_MS`, `FETCH_TIMEOUT_MS`;
`fetch` and `now` injected. Test: `pusher.test.ts`.

**`src/remote/commands.ts`**. The write half: `parseCommands` (an outsider's
JSON, parsed defensively, `CMD_TEXT_MAX`), `acceptCommands` — the gate:
`remote.writes` (default OFF; enabling FLUSHES the queue rather than running
what piled up), a nonce memory (at-least-once, re-acked and dropped), a
live-session check (a missing session is dropped and acked, never guessed into
a new one); `RemoteCommandClient` polls. Accepted commands route through the
same `host.sendMessage` / `host.newSession` the local webview uses. Test:
`commands.test.ts` — its rules agree character for character with the relay's.

**`remote/`** — the deployable relay, a lift-out with its own `package.json`,
excluded from the .vsix: `functions/board-core.mjs` (the ONE logic file: write
gate, storage names, replacement-not-merge, GC of orphaned tails),
`functions/board.mjs` + `netlify.toml` (Netlify Blobs), `worker.js` +
`wrangler.toml` (Cloudflare KV — `keys: [{name}]` must become `blobs: [{key}]`),
`server.js` (plain Node, `data/store.json` written atomically), `public/`
(`index.html`, `board.js`, `board.css` — the viewer, no build step). Tests:
`handler.test.mjs` (board-core with a fake store), `server.test.mjs` (a real
child on an ephemeral port), `worker.test.mjs` (a fake KV), `viewer.test.mjs`
(the page in the stub DOM — the root's text must never BE the string
"undefined").

**`server/`** — the headless board. `server.mjs`: loads `dist/extension.js`,
activates it against `stub.mjs`, serves `/` and `/settings` (`page.mjs`),
`/media/*`, `/bridge.js`, `/bridge.css`, `/healthz`; gated: `GET /api/events`
(SSE), `POST /api/msg`, `POST /api/dialog`, `GET /api/ping`, `POST /api/open`.
Two more routes are public on purpose: `POST /api/session` exchanges the
pairing code ONCE for a session token (32 random bytes kept as a sha-256
digest), and `POST /api/revoke` takes the code OR a live token and bumps the
in-memory revocation epoch, killing every token minted before it — a restart
bumps it too, and an expiry sweep (`setInterval`…`unref()`) drops dead tokens.
The CODE is accepted on those two routes and nowhere else; every gated route
reads `x-rc-token`, and the events route alone ALSO reads `?token=`
(`EventSource` cannot set headers); auth failures log the PATHNAME only, never
the query. Wrong codes are rate limited per client IP — the socket address,
or `X-Forwarded-For` only when `AGENTS_KANBAN_TRUST_PROXY` is set (behind a
proxy that overwrites the header; otherwise the header is forgeable): plain
401s up to `_AUTH_BACKOFF_AFTER` (5), then 429 + `Retry-After` with
exponential backoff, then a hard 403 block after `_AUTH_BLOCK_AFTER` (20) for
`_AUTH_BLOCK_MINUTES` (15) that refuses even the RIGHT code. Only wrong-CODE
attempts count — a restart makes every token fail, so counting tokens would
self-lock. The block's engagement is logged exactly once, blocks live in
memory (a restart lifts them), and a correct code clears the slate. A
non-loopback bind warns on stderr at startup — naming a supplied code under
10 chars guessable, a generated one generated — and a loopback bind stays
silent. Config by env or `--flag`: `AGENTS_KANBAN_PORT` (4310), `_HOST`
(127.0.0.1 — anyone with the code can run agents that spend money), `_REPO`,
`_STORAGE` (`~/.agents-kanban`, never in the repo), `_CODE` (the only
LONG-LIVED secret, compared as sha-256 digests with `timingSafeEqual`),
`_CONFIG`, plus `_TOKEN_TTL` (43200), `_AUTH_BACKOFF_AFTER`, `_AUTH_BLOCK_AFTER`,
`_AUTH_BLOCK_MINUTES`, `_TRUST_PROXY`. `stub.mjs`: a fake VS Code kept
deliberately SMALL so a missing API fails at activation as it would in the
editor; a webview's `postMessage` becomes an SSE frame to every watcher; dialogs
become browser overlays. `page.mjs`: pure — `theme.css` FIRST or the page paints
white; `bridge.js` before the app scripts. `bridge.js`: installs
`acquireVsCodeApi()` (`postMessage` → `POST /api/msg`, a 409 retries after
`/api/open`), re-dispatches SSE frames as `window` messages, intercepts its own
control frames, draws the gate, dialogs and toasts. The token lives in
`sessionStorage` and travels as `x-rc-token` (`?token=` on the stream); the
code sits there ONLY so a dead token — expiry, revoke, restart — can be
re-exchanged ONCE (a 401 retries the request, and the stream's blind onerror
is told apart from a network blip by a `/api/ping`); a failed recovery shows
the gate with an "expired session" note. Neither the code nor the token is
ever printed to the console or put in the URL bar. Tests: `headless.test.mjs`
— spawns the server against a throwaway repo, checks the 401 gate AND that
the code is refused on `/api/msg` and in the stream URL, exchanges for a token,
drives `/api/msg` + the `?token=` stream, then real Chromium: gate, board,
settings, zero console errors; `headless-auth.test.mjs` — the whole hardening
curve on one server: 401 → 429+Retry-After → 403, the block refusing the right
code and logging once, the block lifting, revoke by code and by token, expiry
naming itself "expired", and the non-loopback startup warnings (each guard was
shown RED when reverted).

## How it works

See [flows.md](flows.md) *Remote*. The relay never learns the pairing code;
the extension pushes to `boardIdOf(code)`; the viewer fetches the same. Writes
are a separate capability from watching. The headless board has no second code
path: every message the extension understands works from a browser because the
host half IS the extension.

## Change recipes

- **A new field that may leave for the relay.** Add it to `RemoteCardSource` AND
  `RemoteCard`, project it in `relay.ts`, and assert it (and its absence
  elsewhere) in `relay.test.ts` and `cards.test.ts`. If in doubt, it stays out.
- **A new relay host.** A thin adapter around `functions/board-core.mjs`; a test
  like `worker.test.mjs` that proves its store shape maps onto board-core's.
- **A new dialog or `vscode` API used by the host.** `server/stub.mjs` must
  implement it (and `test/harness.mjs`); `headless.test.mjs` fails at activation.
- **A new colour or stylesheet.** `theme.css` must define every variable it
  uses; `theme.test.mjs` checks the real `page.mjs` document order.

## Invariants

- The pairing code is the only long-lived secret; the relay never sees it; the
  headless server compares digests, never logs it, and accepts it on exactly
  two routes.
- The only credential that ever rides in a URL is the session token — which
  expires, is revocable, and dies on every restart. The code does not travel.
- Wrong codes are rate limited per socket address (per `X-Forwarded-For` only
  behind `AGENTS_KANBAN_TRUST_PROXY`); wrong tokens are not — every token
  fails after a restart, and counting those would self-lock a legitimate user.
- What leaves is decided by a type, asserted field by field.
- A tail travels only when its transcript grew; a quiet board pushes nothing
  but a heartbeat.
- `remote.writes` is off by default, and turning it on discards what queued
  while it was off.
- The headless server binds to `127.0.0.1` by default, and warns on stderr
  whenever it does not.

## Open work

- None recorded beyond the general "run a real agent before believing the suite".

## Recent changes

- 2026-09-07 · task/S106bw · hardened the headless board's auth: the code is
  exchanged once for a short-lived token (URLs and logs never see the code),
  wrong codes are rate limited per IP with backoff and a hard block, revoke
  kills every earlier token, and non-loopback binds say what they expose.
- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
