# The remote board's latency — where the time actually goes, and what to do

Research and a staged plan. Nothing in §4 and §5 is built yet; §3 is the
measurement everything here rests on. Written after the report *"it is still
very slow — why can't it just request the data and receive it as a string,
encrypted, instead of rendering the screen?"*, which is half a misreading and
half exactly right, and the half that is right is the important one.

## 1. Two things it is NOT

**It is not sending a screen.** Nothing is rendered on the pushing machine and
shipped as pixels. The extension posts the same JSON `UiState` it posts to its
own webview, and `media/board.js` — carried byte-for-byte — draws it in the
browser. There is no second render path and no image anywhere in the transport.

**It is no longer sending too much.** Contract v3 (see
[the relay's protocol](https://github.com/Smile1294/Agents-Kanban-Relay/blob/main/docs/protocol.md#frame-patches))
made a push carry a PATCH: the board minus its transcript, plus the rows that
changed. Measured over real HTTP, one row arriving on a 400-row board: **538
bytes against 146,018**. Six seconds of a streaming agent on a 200-row board:
the updates cost **16.6 KB instead of 526 KB**.

At 16 KB a tap, bandwidth cannot be what anyone is feeling. So it was measured.

## 2. What "slow" is, precisely

The complaint is **the lag between doing something and seeing it**, not the
frame rate once it arrives. Those have different causes and only the first is
still bad.

## 3. The measurement

`hops.ts` (the shape is in §7) drives the REAL pusher, the REAL relay and the
REAL page in Chromium, and timestamps every hop of one tap — selecting another
session from the phone. Six runs, all on localhost, so every network round trip
reads as ~0:

| run | tap → board moves |
|---|---|
| 1 | 380 ms |
| 2 | 2679 ms |
| 3 | 2394 ms |
| 4 | 2729 ms |
| 5 | 370 ms |
| 6 | 498 ms |

One run, broken out:

```
  +    0ms   1. tap on the phone
  +   11ms   2. relay HAS the click          <- HTTPS POST, immediate
  +   30ms   3. extension PICKED UP the click <- 0..2000ms: the message poll
  +   40ms   4. extension PUSHED the new board
  +   74ms   5. the phone SHOWS it            <- long-poll wakes, page patches
```

The spread is not noise. It is **two independent waits, each uniformly
0–2000 ms**, and the bimodal totals are whether both, one or neither happened
to be open:

1. **The extension polls the relay's message queue every 2 s.**
   `REMOTE_POLL_FAST_MS` in `extension.ts`. A tap sits in the queue until the
   next tick. Mean 1000 ms, worst 2000 ms.
2. **The push cadence gate is 2 s.** `MIN_INTERVAL` in `remote/pusher.ts`. Once
   the extension has acted, the resulting board waits for the gate to open.
   Mean 1000 ms, worst 2000 ms. (It no longer waits *30* seconds — that was a
   dropped nudge, fixed — but it still waits.)

Everything else is small: the POST, the push, the page's long-poll wake and the
DOM patch together are **~70 ms**.

**So: ~2 s of the delay is two polling intervals, and on a real deployment add
four internet round trips (~200 ms at 50 ms RTT). Nothing else is significant.**

### Why those two numbers are 2 s

Neither was chosen for a tap. `MIN_INTERVAL` protects the extension host's
event loop from a *streaming agent* — a push rides the same loop that drains
the CLI child's stdout, and this project has a postmortem about work per
streamed token. `REMOTE_POLL_FAST_MS` is a compromise between noticing a tap
and not hitting a relay every two seconds forever. **A discrete user action is
not a token**, and treating it like one is the whole bug.

## 4. Staged plan

Ordered by (win ÷ risk). **A and B together are ~10× for a day's work and add
no new attack surface.** C and D are architecture changes and should not be
started before A and B are measured in the field.

### A. The extension long-polls for messages — removes 0–2000 ms

The page already long-polls for frames; the machine does not long-poll for
taps. It should.

- `server.js` already has `longPoll()` and an emitter fired on every store
  mutation — and `writeQueue` goes through `store.set`, so a queued message
  ALREADY wakes it. The only thing in the way is one line:
  `isPlainPoll = !rreq.models && !rreq.msgs` deliberately excludes `msgs`.
  Hold a `msgs=1` request until the queue is non-empty or the timeout.
- `RemoteMessageClient.poll()` gains `&wait=<secs>`; `schedulePoll` in
  `extension.ts` becomes self-rescheduling on the answer rather than on a timer.
- **Netlify and Cloudflare cannot hold a request the way the Node host can**, so
  they keep the 2 s poll. The answer must SAY which it did — the same rule as
  `longPoll: true` on board GETs — rather than the extension assuming.
- Cost: one held connection from the machine to the relay. Bound it, back it
  off on failure, and never let a held poll block the push path.

### B. A user-caused change pushes on a lower floor — removes 0–2000 ms

`MIN_INTERVAL` exists for streaming. A tap produces exactly ONE state change,
so it can go almost immediately.

- Add `URGENT_INTERVAL` (~200 ms) and `nudge({ urgent: true })`. The urgent
  floor applies only to a nudge that followed a message the host actually ran
  (`handleRemoteMessages`), never to a repaint from a streaming frame.
- The existing trailing-tick machinery already does the deferring; this only
  changes which floor it defers to.
- Keep ONE gate, with two floors. Two gates that both know how to throttle is
  the "two functions that both know how to fall back" bug waiting to happen.
- **Expected after A+B: ~250 ms plus round trips**, i.e. 370–2729 ms becomes
  roughly 250–450 ms on a real deployment.

### C. Remove the relay from the data path (the "just talk to the computer" idea)

This is the right end state and the biggest remaining win — **~1 round trip,
50–100 ms** — because a relay is store-and-forward by construction: every
message is written by one side and read by the other, and no amount of tuning
makes that one hop.

Two forms, and they are not equally good:

- **C1 — the machine serves directly.** A WebSocket the phone connects to.
  Only reachable on the same network, or through Tailscale / a tunnel / a
  forwarded port. Note this already half exists: the **headless board**
  (`server/README.md`) runs the built extension on a box and serves the board
  itself. What does NOT exist is the VS Code panel serving one.
- **C2 — WebRTC data channel, relay used only for signalling.** The honest
  answer to "direct and encrypted": DTLS end to end, the relay carries the
  offer/answer and nothing else, NAT traversal via STUN. This is the version
  that works from a phone on mobile data.

  The cost is real and should not be waved away: **NAT traversal fails for some
  networks and the fallback is TURN, which is a relayed server someone pays
  for** — so C2 does not remove the relay, it demotes it to a fallback. It is
  also a second transport to maintain, and the board's two ends must keep
  working when it is not available. Budget it as a project, not a patch.

### D. End-to-end encryption

Asked for in the same breath as speed, but it is a different property and worth
separating.

- **Today**: HTTPS in transit. The relay itself sees the board in plaintext —
  a deliberate, documented v2 trade. Since you deploy the relay, "who can read
  it" is you and your host, not a stranger. The pairing code never leaves your
  machine; only its hash addresses the board.
- **What E2E would mean**: derive a content key from the pairing code with a
  DIFFERENT derivation from the board id (HKDF with distinct info strings, or
  the id leaks the key), encrypt the frame, let the relay store ciphertext.
- **The tension this creates, and it is load-bearing.** Contract v3 has the
  relay COMPOSE patches onto the frame it stores — that is what guarantees a
  page joining mid-stream is handed a whole board rather than fragments. A
  relay holding ciphertext cannot compose. E2E therefore means moving
  composition back to the page and the relay keeping opaque keyframe + patch
  blobs, which brings back the problem v3 solved: a page that falls behind
  needs a keyframe, so the machine must send whole states periodically. The
  bytes go partway back up. **This is a genuine trade, not an oversight.**
- **C2 makes D unnecessary.** A WebRTC data channel is already end-to-end
  encrypted and has no third party in the path. If both are wanted, build C2;
  do not build D and then C2.

## 5. What is deliberately NOT on this list

- **Sending less than the board.** The non-transcript state is 7.6 KB at any
  transcript length. At a 250 ms target, shaving it buys nothing measurable and
  costs a second view-model to keep in step with the first.
- **A second, "lighter" remote UI.** The page IS `board.js`, byte-for-byte, and
  that is the property that keeps every control working remotely. A cut-down
  view is a second render path that will drift.
- **Raising the repaint rate.** Once a frame arrives the page patches in
  ~34 ms and `board.js`'s own fast path is already engaged. It is not the
  bottleneck and was measured not to be.

## 6. Recommendation

Do **A and B**. They are small, they are testable against the harness in §7,
they remove ~2 s of a ~2.2 s problem, and they change no boundary. Re-measure
on the real deployment.

Then decide C2 versus nothing on evidence — if 250 ms is fine on a phone, the
relay stays and D becomes a privacy question you can answer on its own merits
rather than a performance one.

## 7. The harness

Every number above came from one script, and the plan should be re-checked with
it after each stage rather than believed. It spawns the real `server.js` on an
ephemeral port, drives the real `RemotePusher` against it, opens the real page
in Chromium, taps a session in the rail and timestamps: tap → relay has it →
extension picks it up → extension pushes → the DOM changes. A `MutationObserver`
in the page provides the last mark, so "the phone shows it" means the phone
actually showed it.

Run it several times. A single run is meaningless here — the answer depends on
where in two independent 2 s windows the tap happens to land, which is the
finding.
