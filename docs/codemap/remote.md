---
name: remote
description: The board away from the editor — the relay mirror (what may leave the machine, when it is pushed, prompts coming back) and its shared contract, and the headless board that runs the extension itself on a box
paths:
  - src/remote/*.ts
  - remote-contract.json
  - server/**
tests:
  - src/remote/__tests__/relay.test.ts
  - src/remote/__tests__/cards.test.ts
  - src/remote/__tests__/feed.test.ts
  - src/remote/__tests__/pusher.test.ts
  - src/remote/__tests__/commands.test.ts
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
running agents in that repo. Narratives: the relay lives in its own sibling
repository (see below), [server/README.md](../../server/README.md).

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
`commands.test.ts` — the rules agree with the contract file below, checked by
`scripts/check-contract.mjs` in `verify`.

**The relay site — NOT in this repository.** The deployable relay (what the
pusher above talks to) lives in its own sibling repository,
`agents-kanban-relay` — `functions/board-core.mjs` (the ONE logic file: write
gate, storage names, replacement-not-merge, GC of orphaned tails) with thin
hosts for Netlify Blobs, Cloudflare KV and plain Node, and a `public/` viewer
page with no build step. Its tests run there (`npm test`). The two repos'
shared rules — what an id, a key and a nonce look like, how long a command may
be, that every host serves `/board` — are pinned by **`remote-contract.json`**
at THIS repo's root, carried VERBATIM in both: `scripts/check-contract.mjs`
(see [build-and-test.md](build-and-test.md)) compares this copy against the
duplicated constants here (KEY_OK, NONCE_OK, CMD_TEXT_MAX, FN_PATH) and against
the sibling repo's copy, in `verify`. Change a shared rule in BOTH ends or the
gate reads red. A relay host added or changed is tested in the relay repo, not
here.

**`server/`** — the headless board. `server.mjs`: loads `dist/extension.js`,
activates it against `stub.mjs`, serves `/` and `/settings` (`page.mjs`),
`/media/*`, `/bridge.js`, `/bridge.css`, `/healthz`; gated: `GET /api/events`
(SSE), `POST /api/msg`, `POST /api/dialog`, `GET /api/ping`, `POST /api/open`.
Two more routes are public on purpose: `POST /api/session` exchanges the
pairing code ONCE for a session token (32 random bytes kept as a sha-256
digest), and `POST /api/revoke` takes the code OR a live token and bumps the
in-memory revocation epoch, killing every token minted before it — a restart
bumps it too (nothing token- or epoch-related is persisted), and an expiry
sweep (`setInterval`…`unref()`) drops dead tokens. The revoke also ENDS every
open SSE response (`revokeStreams()` — the clients registry maps surface →
`Map<response, heartbeat>`, so the end clears the heartbeat too), because a
stream opened on a revoked token must not keep reading board state no matter
how many further epochs pass: the browser sees the stream close, its EventSource
errors, and the bridge re-exchanges.
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
`_CONFIG`, plus `_TOKEN_TTL` (300 — five minutes: the token is the one
credential that rides in a URL, so it must die on a clock), `_AUTH_BACKOFF_AFTER`, `_AUTH_BLOCK_AFTER`,
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
re-exchanged ONCE per page life (a 401 retries the request, and the stream's
blind onerror is told apart from a network blip by a `/api/ping`); a failed
recovery shows the gate with an "expired session" note. A SECOND death in one
page life is the dead end: the one share of the code was spent, so
`recoverAuth()` closes the EventSource (ending its retry loop, not just the
response), draws the gate with a note, and further requests keep retrying
serialised through a `recovering`/`reexchanged` guard — the EventSource's own
reconnect firing mid-exchange shares the in-flight recovery instead of
answering "dead end" to an attempt that was still going to succeed. Neither
the code nor the token is ever printed to the console or put in the URL bar.
Tests: `headless.test.mjs`
— spawns the server against a throwaway repo, checks the 401 gate AND that
the code is refused on `/api/msg` and in the stream URL, exchanges for a token,
drives `/api/msg` + the `?token=` stream, then real Chromium: gate, board,
settings, then the token lifecycle — a first revoke recovered silently (a new
token in the stream URL), a second dead-ending at the gate with the honest
note and NO further stream requests (no retry loop), and re-entering the code
working again — zero console errors (dead-token 401s are expected and filtered);
`headless-auth.test.mjs` — the whole hardening
curve on one server: 401 → 429+Retry-After → 403, the block refusing the right
code and logging once, the block lifting, revoke by code and by token, a
revoke ENDING open event streams (no frame delivered after it), a restart
resetting the epoch, the code never appearing in the log during
exchange/wrong-code/revoke flows, expiry
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
- **A shared rule changes** (what a key/nonce may look like, a size bound, the
  route). Bump the field in `remote-contract.json` HERE and in the relay repo's
  copy, change the constants in both ends, and watch `scripts/check-contract.mjs`
  go red in between — it names the field that drifted.
- **A relay host or the viewer page changes.** That code lives in the sibling
  repository now; its tests run there. This repo's gate can only say the shared
  rules still agree.
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

- 2026-09-07 · task/S106bw-fix · closed the hardening's loose ends: revoke now
  ends every open event stream (a revoked tab receives nothing further), a
  second token death in one page life dead-ends at the gate instead of an
  EventSource retry loop, `AGENTS_KANBAN_TOKEN_TTL` defaults to 5 minutes, the
  pairing code never appears in server output, and a restart-resets-the-epoch
  test guards the ephemeral design.
- 2026-09-07 · task/S968q-split-the-relay-repo-out · the relay site moved out to
  its own sibling repository (agents-kanban-relay); this repo now carries only
  remote-contract.json, the verbatim shared-rules file checked against both ends
  by scripts/check-contract.mjs in `verify`.
- 2026-09-07 · task/S106bw · hardened the headless board's auth: the code is
  exchanged once for a short-lived token (URLs and logs never see the code),
  wrong codes are rate limited per IP with backoff and a hard block, revoke
  kills every earlier token, and non-loopback binds say what they expose.
- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
