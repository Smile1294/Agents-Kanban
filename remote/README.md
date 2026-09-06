# Agents Kanban — remote board relay

The other half of the extension's **Remote Control**: a small Netlify site that
receives a board — cards, phases and the chats — pushed from an Agents Kanban
install, and shows it in any browser. No code, no file paths and no
credentials ever leave the machine pushing; the page is read-only and
addressable only with the pairing code.

This folder is self-contained: copy it into its own repository (or deploy it
as is) and you are done. It is not part of the extension — nothing here runs
on your machine.

## Deploy (Netlify free tier is enough)

1. Push this folder to its own repository, or keep it as is.
2. On Netlify: **Add new site → Import an existing project**, or from a
   terminal in this folder:

   ```bash
   npm install
   npx netlify-cli deploy --prod
   ```

   The build installs `@netlify/blobs` and the function
   (`functions/board.mjs`) is discovered automatically; `public/` is the site.
3. Note your site URL, e.g. `https://your-board.netlify.app`.

## Pair it with the extension

1. In Agents Kanban: open the **settings page → Remote Control**.
2. Paste the relay URL into *Relay site*.
3. Choose a **pairing code** — any string, like a password — and type it into
   the *Pairing code* field. The same code opens the board on any device that
   watches it; the code itself is stored only in your keychain, never here.
4. Press **Save and connect**. The board starts pushing within seconds.

To watch from a phone or another computer, open the site and enter the same
pairing code. It is remembered in that browser until you press *Forget this
board*.

## How the privacy works

- The relay stores **nothing secret**. A board's address is the first 24 hex
  chars of the sha-256 of your pairing code (~96 bits) — the relay never sees
  the code, so it cannot be robbed for it.
- The page shows nothing until a code is entered, and only the board that code
  derives is reachable. There is no list of boards and no login to expire or
  be phished.
- What leaves the extension is pinned by types and tests: cards (title, phase,
  tags, what the agent is doing — a tool *name*, never a command), and chat
  rows. Tool rows are stripped of their summaries because a summary is derived
  from the tool's input — a Bash row summarises as its command. Sessions are
  capped at their last 120 rows.
- The mirror is one-way. Even the holder of the code can only junk the *mirror*
  by pushing to it; the real board on your machine is never touched.

## What the free tier covers

A quiet board pushes only its heartbeat (at most every 90 seconds) and the
page polls slowly when nothing is moving, so ordinary use is a few thousand
function invocations a month — comfortably inside Netlify's free tier. A
board with agents running pushes on every change (never more often than every
2 seconds, only while content actually changed), and a page left open while
that is happening polls fast; when the board goes quiet it slows back down.

## Layout

| Path | What it is |
|---|---|
| `functions/board.mjs` | The Netlify function (thin wrapper over `board-core.mjs`) |
| `functions/board-core.mjs` | The relay's logic with the store injected — this is what the extension repo's tests exercise |
| `public/` | The static viewer page (no build step, no framework) |
| `netlify.toml` | Function and publish directories |
