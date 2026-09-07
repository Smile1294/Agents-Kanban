# Remote Control — split, harden, clean up

A brief for five pieces of work on Remote Control. They are independent and
ordered by value; take them one at a time and run `npm run verify` between
each. Nothing here changes what the board *does* — it changes where the relay
lives, how hard the headless board is to break into, and how much unused
surface the code carries.

Read [server/README.md](../server/README.md) and [remote/README.md](../remote/README.md)
first; the two modes they describe are the subject.

---

## 1. Move the relay into its own repository

**Why.** `remote/` is a deployable site that has nothing to do with a VS Code
extension. To deploy it on Netlify today you either hand Netlify the whole
extension repo and set a base directory, or you copy the folder out by hand
and lose the connection to upstream. Neither is the "clone and deploy" path it
should be. The relay also changes almost never while the extension changes
constantly, so every extension commit currently invites a pointless redeploy.

**What moves.** All of `remote/`, unchanged, becomes the root of the new repo
(suggested name `agents-kanban-relay`):

```
agents-kanban-relay/
  netlify.toml  package.json  server.js  worker.js  wrangler.toml
  functions/board.mjs  functions/board-core.mjs
  public/index.html  public/board.js  public/board.css
```

**What stays.** Everything under `src/remote/` — `relay.ts`, `pusher.ts`,
`feed.ts`, `cards.ts`, `commands.ts`. That is the extension's own half and it
imports nothing from `remote/` at runtime. Confirm that before deleting
anything.

### The coupling that has to be solved first

Three test files in this repo reach across the boundary and will break on the
move:

| File | Imports |
|---|---|
| `src/remote/__tests__/handler.test.mjs` | `remote/functions/board-core.mjs` |
| `src/remote/__tests__/worker.test.mjs` | `remote/worker.js` |
| `src/remote/__tests__/server.test.mjs` | spawns `remote/server.js` |

Plus `src/remote/__tests__/commands.test.ts`, which cross-checks the host's
acceptance rules against the relay's constants.

**Do this:** move those first three test files into the relay repo. Tests for
`board-core.mjs` belong where `board-core.mjs` lives, and the relay repo needs
a real suite anyway — right now its `npm test` is four `node --check` calls,
which is a syntax check, not a test.

**Then pin the contract.** The two sides share five constants and a payload
shape, and they are already written down twice — `KEY_OK` exists in both
`board-core.mjs` and `src/remote/relay.ts`, with a comment in the former
pointing at the latter. Extract them into one file that both repos carry
verbatim:

```
remote-contract.json     # ID_OK, KEY_OK, NONCE_OK, CMD_MAX, CMD_TEXT_MAX, FN_PATH, payload v
```

Each repo reads it and asserts its own code agrees. Add
`scripts/check-contract.mjs` here that fetches the relay repo's copy from its
main branch and fails on drift — skipping with a clear "could not reach the
relay repo, contract unchecked" line when offline, never a silent pass.

House rule applies: **a new gate must be shown to fail.** Change one constant
in one repo, watch the check go red, put it back.

If you would rather not hand-sync at all, a git submodule at `remote/` also
works and keeps the existing test import paths intact — but it puts submodule
friction on every clone, and `scripts/preflight.mjs` would have to learn about
it. Prefer the contract file.

### The READMEs

Both repos must be independently sufficient. Someone landing on either one
should be able to finish without opening the other.

- **Relay repo README** — the three hosts (Netlify, Cloudflare, plain Node),
  deploy steps, how pairing works, the privacy model, the write channel. Most
  of `remote/README.md` already; add a short "you also need the extension or
  the headless board — here it is" link at the top.
- **This repo's README + `server/README.md`** — keep the relay described as a
  mode, drop the setup steps, and link out to the relay repo.
- Add a line to `CLAUDE.md`'s documentation table pointing at the relay repo,
  so the next agent does not go looking for `remote/` and conclude it was lost.

Delete `remote/` from this repo in the same commit that adds the links, so
there is never a state where both exist and can disagree.

---

## 2. Harden the headless board

`server/server.mjs` is correct about *what* it gates — every route that moves
board state sits behind `authed()`, and the public routes serve a static shell
with no state in it (`server/page.mjs` is a pure string function). The gap is
that the gate has no cost to attack and leaks its own secret into logs.

Implement, in this order:

**2a. Rate limit `authFail()`.** Today a wrong code logs a line and returns
401, forever, at whatever rate the attacker likes. Add a per-IP failure
counter: exponential backoff after ~5 failures, hard block after ~20 for some
minutes, in memory (a restart clearing it is fine and honest). Log the block
once, not per attempt — a log line per request is its own denial of service.

**2b. Stop putting the pairing code in a URL.** `bridge.js` opens the event
stream as `/api/events?surface=…&code=…` because `EventSource` cannot set
headers, and `authFail()` logs `req.url` on failure. TLS protects the wire, but
any reverse proxy in front logs full URLs — so the code ends up in cleartext in
the operator's own access log, and a wrong code ends up in ours.

Fix properly: exchange the code once for a short-lived **session token** at a
`POST /api/session` route, keep the token in `sessionStorage`, and let the
event stream carry the token rather than the code. A leaked token expires; a
leaked code does not. As an interim, redact the query string in `authFail()`'s
log line and document the proxy log filter.

**2c. Give the code a lifecycle.** There is one code, it never expires, and
revoking it means restarting the server and kicking every device. With 2b's
tokens in place, add: token expiry, and a way to invalidate all outstanding
tokens without changing the pairing code.

**2d. Say what is exposed at startup.** When `AGENTS_KANBAN_HOST` is not
loopback and no `AGENTS_KANBAN_CODE` was supplied, print a clear warning that
the board is reachable from the network with a generated code, and that
whoever holds it can run agents on this box. If the code was supplied and is
short or low-entropy, say so. This is the house rule about signals that can
say "bad", applied to the operator rather than the user.

**2e. Document the TLS story properly** in `server/README.md`: a Caddyfile
with the access-log filter for `/api/events`, and the firewall lines. Right
now the reverse-proxy advice is one parenthetical.

**Out of scope unless you want it:** a read-only mode. There is currently no
way to hand someone a link that shows the board without also handing them
agent execution. Worth an issue; not worth blocking this on.

---

## 3. Security review

Once 1 and 2 land, review the whole Remote Control surface — both repos — for
what the two of them together now permit. Specific things to check, not a
generic pass:

- **Every route in `server/server.mjs`** — confirm nothing was added below the
  `authed()` line that should be above it, and nothing above it that reveals
  state. `/media/` uses `path.basename`, so re-check that traversal is still
  impossible after any change.
- **The relay's write path.** `board-core.mjs` accepts a POST keyed only by
  `x-rc-key`, so possession of a board id grants *write* of that mirror, not
  just read. The docstring says this is the accepted trade. Confirm it is still
  bounded (`CMD_MAX`, `CMD_TEXT_MAX`) and that a junked mirror cannot become
  anything worse than a junked mirror — in particular that the page cannot be
  driven to render attacker-controlled markup.
- **`public/board.js` rendering.** The extension's webview has a hard "no
  `innerHTML`" rule and a test that enforces it. Check whether the relay's
  viewer page holds the same line; it renders the same untrusted transcript
  text, from a store anyone with the id can write to.
- **The redaction boundary.** `RemoteCardSource` in `src/remote/relay.ts` is
  the filter — anything not in that type cannot be transmitted. Verify the
  tests still assert the output contains *exactly* those fields, and that
  nothing new on a card (a path, a branch name, a tool summary) has leaked into
  the shape since.
- **`remote.writes` end to end.** Confirm a command sent while the toggle was
  off is still discarded rather than run late when it is turned on.
- **Secrets at rest.** The headless server keeps secrets in a `0600` file
  (`server/server.mjs:348`). Check the directory's permissions too, not just
  the file's.

Report findings as a list with severity; fix the clear ones in the same branch,
raise the arguable ones for a decision.

---

## 4. Dead code sweep

Wanted: remove what is genuinely unreachable so the remaining surface means
something. **Be careful — the obvious method gives mostly false positives.**

A naive "exported symbol not referenced outside its own file" scan over `src/`
returns about forty hits, and I checked a sample of them: `readImages`,
`parseRate`, `transcribeWav`, `Coalescer`, `WHISPER_BIN`, `BOARD_SERVER` are
all live, used inside their own module. What that scan actually finds is
**over-exports** — symbols that could drop the `export` keyword. That is a
worthwhile tidy-up, because narrowing the public surface is what makes real
dead code visible next time, but it is a different job and should be a separate
commit from deletions.

So run three passes and keep them separate:

1. **Genuinely unreferenced** — zero references anywhere including the
   defining file. My scan found only two, both underscore-prefixed test hooks:
   `_resetSdkCache` (`src/agent/sdk.ts`) and `_clearRuntimes`
   (`src/agent/runtime.ts`). Check whether any test imports them dynamically
   before deleting; if nothing does, they go.
2. **Over-exports** — used only internally. Drop the `export`, do not delete
   the code. Skip anything a test imports, and skip types that exist to
   document a shape.
3. **Orphan files and assets** — modules nothing imports, `media/` files no
   stylesheet or script references, npm dependencies nothing requires.

Do not delete anything a test touches without understanding why the test
touches it, and re-read the `CLAUDE.md` rules before removing something that
looks redundant — several things in this codebase are load-bearing in ways the
type system cannot show, and most of them have a postmortem explaining why.
`stopAll()` deliberately not clearing a flag is the canonical example.

`npm run verify` green is necessary but not sufficient here; for anything on
the agent path, drive a real run as well.

---

## 5. Wake-on-LAN (optional, do last)

**The goal.** In relay mode the board runs on a PC at home. If that PC is
asleep the mirror is stale and there is nothing to send a prompt to. It would
be good to wake it from the phone.

**Why it is awkward.** A WoL magic packet is a layer-2 broadcast. It has to be
sent from *inside* the LAN. You cannot send one from Hetzner to a home network
across the internet — a few routers can forward a directed broadcast, most
consumer and ISP routers cannot. And the rotating public IP makes the usual
workaround (port-forward + dynamic DNS) fragile on top of that.

**The approach that avoids both problems.** Do not try to reach the home
network at all. Put a small always-on device on the LAN — a Raspberry Pi, a
NAS, a router that can run scripts — and have it **poll outward**. No inbound
connection, no port forward, no known IP, so IP rotation stops mattering
entirely.

And the relay already has the mechanism: **a wake is just another queued
command.** `board-core.mjs` holds a bounded command queue that something on the
other side polls and acts on. A wake command is the same shape with a different
verb.

```
phone → relay: queue { kind: 'wake' }
  Pi (polls the relay every ~30s) → sees it → sends the magic packet to the PC's MAC
    → PC boots → extension starts → pushes → phone sees the board come alive
```

**What to build:**
- A `kind: 'wake'` command in the relay's queue, gated by its own toggle,
  separate from `remote.writes` — waking a machine and running prompts on it
  are different capabilities.
- A tiny waker script for the always-on device (~50 lines: poll, verify, send
  the packet, ack). Ship it in the relay repo with its own README; it is not
  extension code.
- The phone page shows a **Wake** button only while the board's heartbeat is
  stale — the `at` field in the index already tells you that.

**Prerequisites to state plainly in the docs**, because each one silently
breaks it: WoL must be enabled in the PC's BIOS *and* its NIC driver; it is
reliable over Ethernet and flaky over Wi-Fi (WoWLAN); and waking the machine
achieves nothing unless the board actually starts on boot, so a systemd user
service or a VS Code autostart is part of the feature, not an afterthought.

**Note.** If you go the Hetzner route from `server/README.md`, this whole item
is moot — the box never sleeps. Build it only if the home-PC relay mode is one
you actually intend to use.

---

## Order and definition of done

1. Split the repo (1) — biggest quality-of-life win, and it makes 3 and 4
   smaller by removing a whole folder from this tree.
2. Harden (2) — do this before pointing anything at a public IP.
3. Security review (3) — reviews the result of 1 and 2 together.
4. Dead code (4) — safe to do any time, easiest once 1 has shrunk the tree.
5. Wake-on-LAN (5) — only if relay mode is the one you use.

Each item is done when `npm run verify` is green, the new gates have each been
shown to fail and recover, and both READMEs describe what is actually true.
