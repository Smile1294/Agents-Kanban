---
name: remote
description: The board away from the editor — the relay mirror (what may leave the machine, when it is pushed, prompts coming back) and its shared contract, and the headless board that runs the extension itself on a box
paths:
  - src/remote/*.ts
  - remote-contract.json
  - server/**
tests:
  - src/remote/__tests__/relay.test.ts
  - src/remote/__tests__/pusher.test.ts
  - src/remote/__tests__/messages.test.ts
  - src/remote/__tests__/headless.test.mjs
  - src/remote/__tests__/headless-auth.test.mjs
last_verified: 2026-09-08
---
# Remote — the board away from the editor

## Owns

Two different animals sharing a pairing-code idea. The **relay** mirrors a board
that runs in VS Code to a small site — in v2 the FULL board, the very frames the
extension posts to its own webview, with an optional write channel that runs the
webview's own messages. The **headless board** IS the board: the built
extension activated on a box against a `vscode` stub, driven from a browser,
running agents in that repo. Narratives: the relay lives in its own sibling
repository (see below), [server/README.md](../../server/README.md).

## Files

**`src/remote/relay.ts`**. The shape of what may leave — now the FULL board, so
there is no redaction boundary to enumerate field by field the way v1's index
was. `boardIdOf(code)` — the first 24 hex of sha-256 of the pairing code, the
board's address, so the relay never sees the code; `relayBase`; `forRemote(state,
voice)` — the one transform that legitimately differs: the composer's mic
becomes the whisper path, because a phone has no built-in VS Code dictation;
`remoteFrame(state, models, mv, voice)` — builds the frame one push carries,
with `composer.models` split OUT of the state into a `models` field keyed by
`mv` (the catalogue changes rarely, the state per token). Two things still never
leave, and both are asserted in tests rather than trusted to prose: the pairing
code (only its hash addresses the board) and provider credentials (`UiState`
carries only `hasCredential` flags, never a credential). The credential half is
a guarantee about the state's SHAPE and is asserted that way — a provider choice
carries `id`/`label`/`detail`/`support` and nothing else, and anything
credential-shaped on one must be a boolean flag, never a string. Scanning the
payload for token-shaped words cannot work under v2: the frame is the full
board, so a card titled "Rotate the AUTH_TOKEN" is USER CONTENT and must travel
verbatim. Test: `relay.test.ts` — the split, the mic, the provider key-set, and
a serialised frame with no pairing code.

**`src/remote/pusher.ts`**. `RemotePusher` — WHEN a frame leaves: `nudge()` from
every repaint; at most one attempt per `MIN_INTERVAL` (2 s — the push rides the
event loop the CLI's stdout is drained on); idle = no push; a heartbeat after
`HEARTBEAT_MS` (90 s) rewriting `at`, because a number the board shows must not
depend on a process being alive; `BACKOFF_MS`, `FETCH_TIMEOUT_MS`; a frame over
`FRAME_MAX_BYTES` is cut to its last 100 transcript rows and marked
`transcriptMore`, never dropped. The body is `{ kind:'frame', at, writes, mv,
state?, models? }` — `state` absent means heartbeat, `models` present clears the
models-due flag on success. A blocked tick — inside `MIN_INTERVAL`, mid-flight,
or inside the backoff — ARMS a trailing tick rather than returning: the cadence
decides what leaves, never whether it leaves at all, and a nudge that lands
100ms after a push (which is exactly when a remote message is delivered, since
it rides the push ANSWER) used to wait for the host's 30 s ticker. One trailing
tick at a time, so a streaming firehose still costs one push; `dispose()`
cancels it, because `syncRemoteEngine` replaces the engine and an old one closes
over the old relay URL. `fetch`, `now` and the timers injected. Test:
`pusher.test.ts`.

**`src/remote/messages.ts`**. The write half: `parseMessages` (an outsider's
JSON, parsed defensively — `NONCE_OK`, `TYPE_OK`, `MSG_MAX_BYTES`),
`acceptMessages` — the gate: `remote.writes` (default OFF; enabling FLUSHES the
queue rather than running what piled up), a nonce memory (at-least-once,
re-acked and dropped), and `remote.dialog` answers routed to the waiting dialog
rather than dispatched; `RemoteMessageClient` polls (and `ack`s, and posts
events). Accepted messages route through the same `dispatchBoardMessage` the
local webview uses — the write channel does not invent a vocabulary. Test:
`messages.test.ts` — the rules agree with the contract file below, checked by
`scripts/check-contract.mjs` in `verify`.

**The relay site — NOT in this repository.** The deployable relay (what the
pusher above talks to) lives in its own sibling repository,
`agents-kanban-relay` — `functions/board-core.mjs` (the ONE logic file: write
gate, storage names, replacement-not-merge, GC of orphaned frames) with thin
hosts for Netlify Blobs, Cloudflare KV and plain Node, and a `public/` viewer
page with no build step — the page runs `media/board.js` verbatim behind a
bridge. Its tests run there (`npm test`). The two repos'
shared rules — what an id, a nonce and a message type look like, the frame and
message size bounds, that every host serves `/board` — are pinned by
**`remote-contract.json`** at THIS repo's root, carried VERBATIM in both:
`scripts/check-contract.mjs`
(see [build-and-test.md](build-and-test.md)) compares this copy against the
duplicated constants here (NONCE_OK, TYPE_OK, MSG_MAX_BYTES, FRAME_MAX_BYTES,
FN_PATH) and against the sibling repo's copy, in `verify`. Change a shared rule
in BOTH ends or the gate reads red. A relay host added or changed is tested in
the relay repo, not here.

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
the extension pushes the full frame to `boardIdOf(code)`; the viewer fetches the
same. Writes are a separate capability from watching, and the write channel runs
the webview's own messages through `dispatchBoardMessage` — so the remote page
can do whatever the board can, gated only by `remote.writes`. The headless board
has no second code path: every message the extension understands works from a
browser because the host half IS the extension.

## Change recipes

- **A new field in `UiState`.** It travels with the full frame automatically —
  there is no redaction to update. If it is a credential (or anything that must
  NOT leave), it does not belong in `UiState` at all: assert its absence in
  `relay.test.ts` the way credentials already are. If it is large and rarely
  changes, split it out of the frame the way `composer.models` is.
- **A shared rule changes** (what a nonce/type may look like, a size bound, the
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
- Provider credentials never leave: `UiState` carries only `hasCredential`
  flags, and a test serialises a frame to assert none is in it.
- A frame is the full board; a quiet board pushes nothing but a heartbeat (and
  an over-long frame is cut, never dropped).
- `remote.writes` is off by default, and turning it on discards what queued
  while it was off.
- The headless server binds to `127.0.0.1` by default, and warns on stderr
  whenever it does not.

## Open work

- None recorded beyond the general "run a real agent before believing the suite".

## Recent changes

- 2026-09-08 · claude/frontend-sync-chat-freeze-wb6a2s · the mirror was up to
  45 s behind, and the cause was the cadence gate DROPPING work rather than
  deferring it. Measured on the real engine: a remote click ran on this machine
  at t=100ms and reached the relay at t=30s. A remote message is delivered by a
  push answer, so the repaint it causes nudges while `lastAttempt` is at its
  freshest — the one moment the gate is guaranteed to be shut. `tick()` now arms
  a trailing tick (`arm`/`dispose`, injected timers) for the moment the gate
  opens. Two more in the same push path: `buildRemoteSnapshot` did a SECOND full
  `getState()` per push, so every push re-ran the session-index scan the repaint
  had just done, on the event loop that drains the CLI — it now reuses the state
  `paint` built when that state is fresher than `MIN_INTERVAL`; and that call
  consumed the WEBVIEW's model-catalogue memo, so a push landing between a
  catalogue change and the next repaint left the local composer holding the old
  backend's models for good. `getState(audience)` keys the memo per audience and
  `'remote'` never consumes it — a remote frame splits the catalogue out onto
  `mv` and never wanted it in the state.

- 2026-09-08 · claude/pr-review-test-fixes · the v1 secret scan in
  `relay.test.ts` was self-contradictory under v2 and was the one red suite: it
  put `AUTH_TOKEN` in a CARD TITLE and then asserted both that the card text
  travels and that the word is absent. One of the two had to be false, and
  redacting user text to satisfy it would mangle the board to hide a word that
  is not a secret. Replaced with the structural assertion (the provider
  key-set), which was shown to go red on a planted `sk-ant-…` value.
- 2026-09-08 · task/relay-v2-extension · relay v2: the push became the FULL
  webview frame (`remoteFrame`/`forRemote`, `composer.models` split out), the
  command vocabulary became the webview's own messages (`messages.ts` →
  `dispatchBoardMessage`), dialogs/toasts for remote messages route through
  `board/dialogs.ts`, and the contract gate now checks NONCE_OK/TYPE_OK/
  MSG_MAX_BYTES/FRAME_MAX_BYTES instead of the v1 redaction constants.
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
