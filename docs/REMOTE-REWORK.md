# Reworking the remote board into a data server

Research. **Nothing here is built.** It answers three questions that were asked
together: what would actually have to change, how long it would take, and how
hard the security is.

The request, in the words it was asked in: *"it would be built on the front end
based on the response that you receive from the computer, meaning you could
have opened different chat on the browser and on the computer simultaneously…
it just needs to fetch the data from the computer on load and then update as it
happens so live, maybe even through sockets."*

## 1. The half that is already true, and the half that is the real problem

**Already true: nothing is rendered on the machine and shipped.** The extension
posts JSON; `media/board.js` draws it in the browser. There is no image, no
pixel, no second render path anywhere in the transport, and after contract v3 a
push is a few kilobytes.

**The real problem is that there is exactly ONE view.** `mode` and `selectedKey`
are two variables in `extension.ts` (lines 184–185), owned by the host, carried
in every `UiState`, and shared by the side bar, the editor panel and every
remote page at once. The relay's own README states it as a known limit:

> Known and accepted: the remote page is a second mirror of the SAME panel
> surface, so selecting a session or switching kanban/chat remotely also
> changes the local VS Code panel.

Two consequences, and the second is the one that has been mistaken for
"the transport is slow":

1. You cannot read one session on the phone and another in the editor. It is
   not a missing feature, it is the architecture: there is one selection.
2. **Opening a chat requires a round trip.** Tapping a card cannot draw
   anything until a message reaches the machine, the machine changes its one
   `selectedKey`, and a frame comes back. Every millisecond spent on the
   cadence gate and the message poll was spent making that round trip faster.
   It is the round trip itself that should not exist.

That is exactly the observation Linear's sync engine is built on: moving the
data to the client takes network latency out of the interaction path entirely,
because a view change becomes a local read.

## 2. What already exists (so this is not a green field)

Three things are further along than they look, and they change the estimate:

**The data layer is already resource-shaped.** `SessionStore` exposes
`list()`, `transcript(id, limit)` and `usage(id)` — per session, addressable by
id, already cached on file identity. What is *not* resource-shaped is the layer
above it: one `getState()` folds everything into one frame about one selected
session.

**The extension can already listen.** `agent/board-bridge.ts` runs
`net.createServer()` with a token, because Codex needs the board tools over a
socket. Serving a protocol from inside the extension host is established ground,
not a new capability.

**A push transport and an auth model already exist.** `server/server.mjs` (the
headless board) serves `GET /api/events` as SSE, `POST /api/msg`, and has the
pairing-code-for-token exchange with a 5-minute TTL, per-IP backoff, hard block
and revoke — designed and reviewed once already. It is the wrong *shape* (it
runs the whole extension on a box, and still mirrors one panel) but the auth
work is reusable almost as-is.

**`delta.ts` already exists.** Transcript patches — the board minus its
transcript plus the rows that changed — are built and tested. A per-session
subscription would reuse it unchanged.

## 3. The target shape

The server stops publishing *a screen* and starts publishing *resources*; each
client keeps its own view.

```
  MACHINE (extension)                     BROWSER / PANEL / PHONE
  ───────────────────                     ───────────────────────
  board            cards, columns,        view state: which session is
                   counts, defaults       open, kanban or chat, scroll
  session/<id>     transcript, review,    — held HERE, never sent, never
                   meters, agents           shared, instant to change
  subscribe(id)  ──────────────────────▶  a client asks for what it is
  patch/append   ◀──────────────────────  looking at, and only that
```

- **On load**: fetch `board`, render the columns. That is the whole first paint.
- **On opening a chat**: the view changes *immediately* — it is local state —
  and subscribes to `session/<id>`. The transcript arrives and fills in. Nothing
  waits on a round trip to decide *what to show*, only to fill it.
- **Live**: the machine pushes appends and patches for the sessions each client
  is actually subscribed to. A phone watching one chat receives one chat.
- **Two clients, two views**: falls out for free. There is no shared selection
  left to collide over.

**Actions stay exactly as they are.** Send, merge, approve, move — those are
already messages through one funnel (`dispatchBoardMessage`), they already carry
the permission and money boundaries, and none of that should be touched. What
changes is *reading*, not *writing*.

## 4. How other people do this

- **Linear** — the canonical version of this idea. IndexedDB on the client is
  the real database; mutations apply locally first; a WebSocket carries delta
  packets from the server; a bootstrap fetch seeds it. The point they make, and
  the one that applies here, is that latency leaves the interaction path when
  the data is already local.
- **VS Code Tunnels** — the answer to "the machine is behind a NAT". Both ends
  dial **out** to a relay over WebSocket and the relay *splices* the two
  connections; it is a byte pipe, not a mailbox. This is a better answer than
  WebRTC for our case: no STUN, no TURN, no NAT traversal that fails on some
  networks, and it keeps the relay we already deploy.
- **claudecodeui / CloudCLI** (`siteboon/claudecodeui`, GPL-3) — the closest
  existing thing to what is being asked for: a Node server on port 3001 that
  discovers sessions from `~/.claude/projects/`, a React front end, WebSocket
  for live streaming. Worth reading before building; worth *not* copying the
  parts where it is loose (its own docs lead with "all tools are disabled by
  default" because the risk is real).
- **Claude Code's own Remote Control** (Anthropic, research preview, Feb 2026) —
  bridges a local Claude Code session to claude.ai/code and the mobile apps,
  with the filesystem and MCP servers staying local. **This is prior art for the
  transport problem and it already exists.** It does not do what this board
  does — a kanban of many concurrent sessions with worktrees, phases and merges
  — so it is not a replacement, but it is worth knowing that the plain
  "drive one session from my phone" case is solved without building anything.

## 5. Security — the part that is genuinely hard

This is where the honest answer is "harder than the feature". The thing being
exposed is not a document. It is a process that **starts agents that write to
your source tree and spend money**.

### The precedent, from four months ago

**ClawJacked / CVE-2026-25253** (Oasis Security, disclosed 26 Feb 2026, CVSS
8.8) was a cross-origin WebSocket hijack of a *local AI agent gateway* — the
exact thing this rework would build. Three chained weaknesses:

1. **No `Origin` validation on the WebSocket handshake.** This is the trap, and
   it is a browser behaviour rather than a bug: **the same-origin policy does
   not apply to WebSockets.** `fetch` to `localhost` from evil.com is blocked;
   `new WebSocket('ws://localhost:3001')` is not. Any page open in your browser
   can connect to a listening local port.
2. **Local connections exempted from rate limiting** — failed auth neither
   counted, throttled, nor logged.
3. **Token exfiltration via a crafted URL**, giving one-click RCE.

`localhost` is not a trust boundary. That has to be the first line of the design
document, not a hardening pass afterwards.

### What that means concretely here

| Threat | Mitigation, non-negotiable |
|---|---|
| Cross-site WebSocket hijack (CSWSH) | Validate `Origin` on **every** handshake against an allowlist; reject unknown outright. Never rely on SOP. |
| DNS rebinding | Validate the `Host` header too — reject anything that is not the exact host you expect. Origin alone is not enough. |
| Token in a URL | The current SSE stream puts the token in the query because `EventSource` cannot set headers. A **WebSocket can** send it in the first frame after the handshake — so moving to WebSocket removes an existing weakness rather than adding one. |
| Brute force | Rate limit **including** local connections. This is the exact exemption that made ClawJacked one-click. |
| LAN exposure | Bind `127.0.0.1` by default. A non-loopback bind must be an explicit, loud opt-in — `server/server.mjs` already does this and the behaviour should be carried over verbatim. |
| A watching tab that should not still be watching | Short-lived tokens, revoke that ends open streams. Already built in `server/`. |
| The relay seeing everything | A spliced relay carries a stream it does not store. It still *sees* it unless the payload is encrypted end to end — a separate decision, see `REMOTE-LATENCY.md` §D. |

**One more, specific to this project:** the write channel is already gated by
`remote.writes`, and `isHumanOnly()` is enforced host-side. Neither should move.
The rework must not become an excuse to let a socket reach around them.

Security work is not a phase. Budget it as a **~30% tax on every phase**, and
assume a real review pass at the end.

## 6. What it would take

Honest estimates, in focused engineering days, assuming the existing test
discipline is kept (every gate shown to fail, `verify` green).

| # | Piece | Days | Risk |
|---|---|---|---|
| 1 | **Split view state from board state.** Host stops owning `selectedKey`/`mode`; `getState()` splits into `board` + `session(id)`; `board.js` owns its own selection and asks for what it needs. | **5–8** | **High** |
| 2 | **Data API + subscriptions** in the extension: a WebSocket server, resources, subscribe/unsubscribe, reusing `delta.ts` for transcript patches. | 3–5 | Medium |
| 3 | **Local and tunnel transport** — bind, pair, Tailscale/ngrok instructions. | 1–2 | Low |
| 4 | **Relay becomes a splice** (VS Code Tunnels model): both ends hold a socket, the relay forwards frames and stores nothing. Rewrites most of the relay repo. | 4–6 | Medium |
| 5 | **Security**: Origin + Host validation, token off the URL, rate limiting with no local exemption, bind defaults, consent gate, review pass. | 3–5 | **High** |
| | **Total** | **16–26 days** | |

Call it **four to six weeks** of real calendar time. Piece 1 is the one that
will overrun: `board.js` is 3,800 lines with no type checking, and its
`chromeSig()`/`syncFrame()` fast path — the thing that stops the board
rebuilding on every streamed token — is keyed to the current state shape.
`smoke.mjs` and `layout.test.mjs` assert against it. That is not a reason not to
do it; it is a reason not to believe a one-week estimate.

## 7. The cheaper thing that is most of what was asked for

**Piece 1 alone delivers both of the stated wants**, and needs no new transport,
no new listening port and no new attack surface:

- different chats open on the phone and in the editor — that IS piece 1;
- **instant** chat switching, because the view change stops being a round trip;
- the current relay, cadence and security model all stay exactly as they are.

**1–2 weeks, and the security tax is near zero** because nothing new is exposed.

Pieces 2–4 buy the remaining ~200 ms — the four internet round trips a
store-and-forward relay costs — and they are what turn "fast" into "local". They
are worth doing, after piece 1 is in and measured, and only if the number still
bothers you on a real phone on real mobile data.

## 8. Recommendation

1. **Build piece 1 first, alone, and measure.** It is the actual answer to what
   was asked, it is the smallest change that delivers it, and it makes pieces
   2–4 easier rather than harder (a client that owns its view is exactly the
   client a subscription API wants).
2. **Then decide on 2 + 4 with a number in hand**, not a feeling.
3. **Do not start piece 2 without the security list in §5 written into the
   design.** A listening socket that can start agents is a different class of
   thing from a board that polls a relay, and February's CVE is what it looks
   like when that is got wrong.

## 9. The build order for piece 1

What follows is the actual plan, in the order it would be done, with the
checkpoint where the difference becomes visible. Read §8 first: this is only
piece 1. Nothing here opens a port or changes the security posture.

### What reconnaissance changed

Three things found in the code make this smaller than §6 assumed, and one makes
it fiddlier:

- **Actions are already addressed by id.** `dispatchBoardMessage` reads
  `String(msg.id ?? '')` — 26 call sites — so *send, merge, approve, move,
  delete* never consult the host's selection. **The write path does not change
  at all.** Only reading does.
- **The view's coupling is 17 lines.** `board.js` reads `s.selectedKey` 11 times
  and `s.mode` 6 times, and posts them back from about ten click handlers,
  almost always as the pair `post('select') + post('setMode','chat')` — "open
  this card in chat". That pair is the seam.
- **`followKey` is already pure.** `(selected, cardKeys, sessionIdFor)` in
  `manager.ts`, no host state — so a client can apply it itself.
- **The fiddly one:** the host currently *redirects* the selection on your
  behalf — a run getting its session id, a fork, an archive, a delete. Each of
  those has to become something the host TELLS clients rather than does to them.

### Step 0 — branch, and measure the local panel too · ½ day

Baseline what switching chats costs **in the editor**, not just on the phone.
Every number so far has been about the remote page; the round trip is the same
one locally and nobody has measured it. Without this there is no before/after
for the thing being changed.

### Step 1 — the view owns `mode` and `selectedKey` · 1½ days

The whole of the perceived win, and it touches one file.

- Add module-level `view = { mode, selectedKey }` in `board.js` — the same
  pattern `draft`, `disclosed` and `catalogue` already use, and for the same
  reason: state the user put there must survive a repaint.
- Seed it from the first state message, then own it. The host keeps sending its
  own `mode`/`selectedKey` for now and the view ignores them after the seed.
- Each of the ~10 click handlers sets `view` and calls `render()` **first**,
  then posts. That inversion is the entire point.
- `chromeSig()` reads `view.mode` / `view.selectedKey` instead of `s.mode` /
  `s.selectedKey`. This makes the signature *less* volatile, not more — a
  frame from another card's agent no longer perturbs it.
- **New gate:** clicking a rail item changes what is drawn with **no state
  message at all**. That test fails today by construction.

**Checkpoint.** Stop here and look. Switching to a session whose transcript the
host is already sending is now instant, in the editor and on the phone. Sessions
the host is *not* sending still wait — that is step 2, and seeing exactly which
ones lag is the best possible input to it.

### Step 2 — the host serves a slice per WATCHER · 2½–3 days

The structural piece.

- A `watch { id }` message: a client says what it is looking at. The host keeps
  `Map<surface, key>` — side bar, panel, and one per remote page.
- Split `getState()` in two, keeping one code path each:
  - `boardState()` — cards, columns, counts, composer defaults. Shared, cheap,
    identical for everyone.
  - `sessionSlice(key)` — `transcript`, `streaming`, `review`,
    `backgroundAgents`, and the three `composer` meters. Per watcher.
- `paint` stops sending one object to two surfaces and composes per surface.
  **This is where the "expensive per streamed token" rule has to be honoured
  again**: `boardState()` is built ONCE per repaint, and a slice is built only
  for keys somebody is actually watching — never one per card.
- The host's own `selectedKey` survives only as *what a brand-new client is
  told to open first*. It stops being the truth.

### Step 3 — the view keeps the last few transcripts · ½ day

Bounded to about three sessions, because a transcript is the big object and the
webview holds it in memory. Switching *back* to a session then costs nothing at
all. This is the step that makes flicking between two chats feel native.

### Step 4 — the redirects the host used to do for you · 1 day

Each becomes an announcement rather than an action, and each needs a test:

| Event | Now | After |
|---|---|---|
| A run gets its session id | host rewrites `selectedKey` | host sends the mapping; each client applies `followKey` itself |
| Fork | host selects the fork | host names the new key; the client that asked follows it, others do not |
| Archive / delete | host clears the selection | host says the key is gone; every client watching it falls back |

The failure mode to write tests against is a client left watching a key that no
longer exists — it must land somewhere sensible rather than on a blank panel.

### Step 5 — the relay carries per-page slices · 1–1½ days

The relay stores ONE frame per board, so two phones on different chats need
more than that. Cheapest correct shape: `boardState` stays the shared frame, and
each page's `watch` rides the existing message queue so the host pushes the
slices anyone is actually watching, keyed by session id; each page takes its
own. Frame patches (`delta.ts`) apply to a slice unchanged.

Contract v4, and both repos move together as before.

### Step 6 — gates, docs, re-measure · 1 day

Every new gate shown to fail. `codemap/` areas updated (`webview`,
`extension-host`, `remote`). A `DECISIONS.md` entry for why view state moved
client-side. Then re-run the §7 harness and put real numbers back into §6 —
including the local panel baseline from step 0.

**Total: 7–8 days**, against the 5–8 estimated in §6 for piece 1 plus the relay
work that estimate did not include.

### What I expect to go wrong

- **`smoke.mjs` and `layout.test.mjs` assert on the current state shape.** They
  will break in step 2 and that is correct; the work is updating them honestly
  rather than loosening them.
- **The side bar and the panel can now show different sessions.** That is the
  feature working, but it IS a behaviour change for anyone who relied on them
  moving together. Both seed from the same default, so it only diverges once
  you deliberately move one.
- **Step 2 is where a per-token cost could sneak back in.** One `boardState()`
  per repaint, slices only for watched keys. If a profile shows otherwise, that
  is the bug.
- **The estimate assumes nothing else lands in `board.js` meanwhile.** It is
  3,800 untyped lines and step 1 touches its spine.

## Sources

- [Reverse-engineering Linear's sync engine](https://github.com/wzhudev/reverse-linear-sync-engine)
- [How's Linear so fast? A technical breakdown](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown)
- [VS Code remote tunnels: relay architecture](https://blog.xpnsec.com/accidental-c2/)
- [siteboon/claudecodeui (CloudCLI)](https://github.com/siteboon/claudecodeui)
- [ClawJacked — CSA research note](https://labs.cloudsecurityalliance.org/research/csa-research-note-clawjacked-websocket-local-agent-hijack-20/)
- [Localhost is not a trust boundary: what ClawJacked proves about agent gateways](https://rafter.so/blog/incidents/clawjacked-localhost-trust-boundary)
- [Cross-site WebSocket hijacking (CSWSH)](https://pentest-tools.com/blog/cross-site-websocket-hijacking-cswsh)
- [DNS rebinding and localhost MCP](https://rafter.so/blog/mcp-dns-rebinding-localhost)
- [WebSocket security: auth, TLS, CSWSH, rate limiting](https://websocket.org/guides/security/)
