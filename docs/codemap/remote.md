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
Config by env or `--flag`: `AGENTS_KANBAN_PORT` (4310), `_HOST` (127.0.0.1 —
anyone with the code can run agents that spend money), `_REPO`, `_STORAGE`
(`~/.agents-kanban`, never in the repo), `_CODE` (the only secret, compared as
sha-256 digests with `timingSafeEqual`), `_CONFIG`. `stub.mjs`: a fake VS Code
kept deliberately SMALL so a missing API fails at activation as it would in the
editor; a webview's `postMessage` becomes an SSE frame to every watcher; dialogs
become browser overlays. `page.mjs`: pure — `theme.css` FIRST or the page paints
white; `bridge.js` before the app scripts. `bridge.js`: installs
`acquireVsCodeApi()` (`postMessage` → `POST /api/msg`, a 409 retries after
`/api/open`), re-dispatches SSE frames as `window` messages, intercepts its own
control frames, draws the gate, dialogs and toasts; the code lives in
`sessionStorage`, travels as `x-rc-code` and as `?code=` on the stream. Test:
`headless.test.mjs` — spawns the server against a throwaway repo, checks the 401
gate, then real Chromium: gate, board, settings, zero console errors.

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

- The pairing code is the only secret; the relay never sees it; the headless
  server compares digests and never logs it.
- What leaves is decided by a type, asserted field by field.
- A tail travels only when its transcript grew; a quiet board pushes nothing
  but a heartbeat.
- `remote.writes` is off by default, and turning it on discards what queued
  while it was off.
- The headless server binds to `127.0.0.1` by default.

## Open work

- None recorded beyond the general "run a real agent before believing the suite".

## Recent changes

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
