---
name: build-and-test
description: How the project is built, packaged and gated — preflight, the test runner, the two esbuild bundles, the .vsix contents, F5, the fake VS Code, the stub DOM, the launch gate smoke.mjs, screenshots
paths:
  - scripts/**
  - test/**
  - smoke.mjs
  - esbuild.mjs
  - tsconfig.json
  - .vscodeignore
  - .vscode/**
tests:
  - smoke.mjs
  - test/package.test.mjs
last_verified: 2026-09-07
---
# Build and test

## Owns

Everything between the source and a running extension: dependency checks,
type-checking, bundling, packaging, the fake editor and the fake DOM the tests
run against, the launch gate, and the editor tasks behind F5.

## Files

**`scripts/preflight.mjs`** — "is this checkout able to run anything?" Pure
Node, no dependencies. Node ≥ 22.6 (`MIN_NODE`, where `--experimental-strip-types`
landed); `node_modules` present or `npm install` is run; a fixed `REQUIRED`
list of five packages exists; `ENTRIES` resolve through `createRequire`.
`--verbose` prints a summary. Every npm script starts with it.

**`scripts/test.mjs`** — walks `src/` (skipping `node_modules` and dot
directories) for `*.test.ts` / `*.test.mjs`, runs each in its own process
(`.ts` with `--experimental-strip-types --no-warnings`), runs EVERY file even
after one goes red, names all the failures in its summary, and treats ZERO
files as a failure. Replaced a `for f in src/**/__tests__/*.test.ts` npm script
that ran under `sh`, where `**` is `*`. It used to `break` at the first failure
"as the shell loop did", which made one red file a silent hole — see Recent
changes.

**`scripts/run-bin.mjs`** — `node scripts/run-bin.mjs <package> <bin> …`
resolves a dependency's declared `bin` through Node's resolver instead of
`node_modules/.bin` (symlinks absent on WSL drives, network shares,
`--no-bin-links`). Used by `typecheck` and `package`.

**`scripts/with-node.sh`** — POSIX sh; finds a Node ≥ 22.6 by RUNNING candidates
and puts it on PATH. VS Code runs tasks in a non-interactive shell where
`~/.bashrc` returns early, so nvm's Node is not on PATH. Keep `MIN_MAJOR`/`MIN_MINOR`
in step with `MIN_NODE`.

**`scripts/install-local.mjs`** — package and install into VS Code (`$VSCODE_CLI`,
then `code`/`code-insiders`, then per-platform paths). **`scripts/make-icon.mjs`**
— renders `media/icon.png` with Chromium (the activity-bar glyph `board.svg`
stays monochrome `currentColor`).

**`scripts/check-contract.mjs`** — the relay contract gate, run by `verify`. The
relay lives in its own sibling repository; the shared rules between the two
ends are pinned by `remote-contract.json` (at the repo ROOT, carried verbatim
in both repos). The gate (a) reads the constants this repo duplicates from the
file — NONCE_OK, TYPE_OK and MSG_MAX_BYTES in `src/remote/messages.ts`,
FRAME_MAX_BYTES and FN_PATH in `src/remote/pusher.ts` — by regex over the
single-line literals, naming the field on drift; (b) compares this copy of the
JSON against the relay repo's — the sibling `../agents-kanban-relay` on a dev
machine, else `AGENTS_KANBAN_RELAY_URL` or the package.json `relayRepo` field,
fetched; (c) when the relay copy is unreachable prints
`contract UNCHECKED — could not reach the relay repo` and exits 0 — a loud
skip, never a silent pass. Shown red twice when new (a local `MSG_MAX_BYTES`
bump; an edit of the relay's copy) and restored.

**`esbuild.mjs`** — two CJS bundles, node20, sourcemaps, minified unless
`--watch`: `src/extension.ts` → `dist/extension.js` with externals `vscode`,
`@anthropic-ai/claude-agent-sdk` (ESM-only, resolves a native binary), `zod` (a
peer of the SDK — two instances disagree in schema conversion); and
`src/board-mcp.ts` → `dist/board-mcp.js` with NO externals, so an accidental
`vscode` import there is a build error rather than a crash inside a process
Codex spawned.

**`tsconfig.json`** — ESNext / Bundler / ES2022, `noEmit` (esbuild emits),
`strict`, `noUncheckedIndexedAccess`, `allowImportingTsExtensions` (imports use
`.ts` suffixes). No parameter properties in constructors — the type stripper
rejects them.

**`.vscodeignore`** — out of the .vsix: `src/`, `test/`, `docs/`,
`.agentskanban/` (a live worktree is a whole checkout), `CLAUDE.md`, `PLAN.md`,
`remote-contract.json` (a dev-time gate, never runtime state), `*.map`,
`*.ts`, the SDK's per-platform native binary, dev dependencies. The relay's
`remote/**` block is gone — the relay lives in its own repo, and the guard in
`test/package.test.mjs` still refuses a `remote/` prefix in the package in case
a pre-split branch ever merges back.

**`.vscode/tasks.json`, `launch.json`** — `verify` (what F5 waits for),
`preflight`, `build`, `watch`, every one through `./scripts/with-node.sh`; "Run
Extension" pre-launches `verify` (building alone launches an extension whose
manifest and code disagree); "Run Extension (skip checks)" pre-launches `build`.

**`test/harness.mjs`** — a fake VS Code good enough to activate the BUILT bundle
and talk to it: `makeVscodeStub(ctl)` (captures the webview's message handler
and what the host posts; models the workbench layout — side bar, panel, aux bar
— as STATE so tests assert on what the window looks like, not on command
names), `loadBundle(vscode)` (patches `Module._resolveFilename` so `'vscode'`
resolves to the stub), `makeContext(storage)` (real Maps for `globalState`,
`workspaceState`, `secrets` — a stub that swallowed writes let "the key went
into settings.json" pass), `makeRepo(prefix)`, `repoRoot`. Deliberately
incomplete: a missing API fails smoke exactly as it fails activation.

**`test/dom.mjs`** — a DOM just big enough to run `board.js` and `settings.js`
in a `vm`: `renderBoard(state, opts)`, `renderBoardWith`, `renderSettings`,
`findByTag`, `walk`, `fakeImageFile`. Nodes carry real `selectionStart`/`End`
and a real `attributes` map (`tickAges()` finds counters by `data-since`).

**`test/package.test.mjs`** — runs `vsce package` for real (`npm run
verify:package`): the two bundles and the webview assets ship; the SDK's
`sdk.mjs` and `zod/` ship (externals!); the native binary, `docs/`,
`.agentskanban/` and a `remote/` prefix do not (the relay lives in its own
repo — the guard refuses the old directory in case a pre-split branch merges
back); size between 1 and 20 MB.

**`test/screenshots.mjs`** — renders the real view in Chromium to
`docs/screenshots/` (`npm run screenshots`), `theme.css` first; fails on a blank
render, so the README's pictures are a check too.

**`smoke.mjs`** (~1650 lines) — the launch gate, and the one to read first.
Sets `CLAUDE_CONFIG_DIR` to a temp dir BEFORE the bundle loads (hermetic: a seeded
transcript with known token counts, asserted to the cent). Sections: activation
(registers what it promises); manifest (`package.json` ↔ code); the project can
be run from a clean checkout (the npm scripts start with `node`/`npm`, no
bashisms, no `.bin`); no folder open (registration never depends on workspace
state); live wiring (`ready` returns a real `UiState`; every inbound message is
handled; the icon toggles the board and never takes the left side bar); view
contract (the REAL state through the REAL `board.js`; an interrupted run; what
the side bar is sent; a burst of events is one repaint); providers (a profile
goes to settings, its credential to SecretStorage — both stores, both
directions; the composer fields the view reads); a live card does not restamp
itself on every repaint; schedules round-trip; teardown that retries and never
overturns the verdict. `latestState()` folds `composer.models` forward as the
view does, because the host omits the list when unchanged.

## How it works

`npm run verify` = preflight → `tsc --noEmit` → `esbuild` → `scripts/test.mjs`
→ `scripts/check-contract.mjs` → `smoke.mjs`. Tests are plain scripts printing
`ok:` / `FAIL:`. Four gates read the built bundle (`executable.test.ts`,
`board-bridge.test.ts`, `smoke.mjs`, `harness.mjs`), so `verify` builds before
it tests. Two need Chromium (`layout.test.mjs`, `headless.test.mjs`) and FAIL
without one.

## Change recipes

- **A new test.** `src/<area>/__tests__/<name>.test.ts` (or `.mjs` for view
  tests that need no types); `ok()`/`FAIL:` lines, non-zero exit; the runner
  finds it. Break the thing it guards once and watch it go red before trusting
  it.
- **A new devDependency the tests import.** Add it to `REQUIRED` in
  `preflight.mjs`, or a fresh clone passes preflight and fails in the test.
- **A new npm script.** Starts with `node scripts/preflight.mjs &&`; logic in a
  `scripts/*.mjs`, never in shell; `smoke.mjs`'s clean-checkout section asserts
  all of this.
- **A new `vscode` API.** `test/harness.mjs` and `server/stub.mjs`.
- **A path derived from `import.meta.url`.** `fileURLToPath`, never
  `.pathname` — a space in the repo path became `%20` and the suite was red with
  a message blaming the build.
- **Anything the .vsix must or must not carry.** `.vscodeignore` and an
  assertion in `test/package.test.mjs`.
- **A shared rule with the relay changes.** Edit `remote-contract.json` in BOTH
  repos and the constants in both ends; `scripts/check-contract.mjs` names the
  field that drifted. See [remote.md](remote.md).

## Invariants

- Every npm script starts with `node` or `npm`; npm runs scripts through `sh`.
- Never invoke a dependency's binary by name or through `npx`.
- The externals ship in the .vsix; the native binary does not.
- `smoke.mjs` is hermetic and spawns no CLI.
- A gate's exit code is its verdict; cleanup is not part of the verdict.
- A new gate must be shown to fail.

## Open work

- Preflight's `REQUIRED` list does not include `playwright`, so a fresh clone
  passes preflight and fails in the first Chromium test.

## Recent changes

- 2026-09-09 · claude/frontend-sync-chat-freeze-wb6a2s · `test/switch-latency.mjs`
  — a BENCHMARK, not a gate: it prints numbers and exits 0, and the runner only
  collects `src/**/*.test.*` so it never runs in `verify`. It drives the BUILT
  bundle through the smoke gate's stub and times what a click on a session
  costs: post `select`, wait until the state for that session has reached the
  webview. Written for step 0 of docs/REMOTE-REWORK.md §9, and it immediately
  corrected the plan — locally that round trip is 3–20 ms, so piece 1 has no
  local speed win to sell. It needs `process.exit(0)`: the host's timers (the
  remote poll, the push ticker, the background-agent tick) keep the loop alive
  forever, and a benchmark that never exits reads as a hang.

- 2026-09-08 · claude/pr-review-test-fixes · `scripts/test.mjs` no longer stops
  at the first failing file. The `break` turned one red suite into a silent
  hole: `relay.test.ts` sorts 42nd of 51, so a single failure there meant nine
  suites never ran — and because `verify` chains with `&&`, the contract gate
  and the smoke gate did not run either. "Not run" reads exactly like "passed"
  in the scrollback above it. Every file now runs and the summary names each
  failure (`N of 51 test file(s) failed`).
- 2026-09-07 · task/S968q-split-the-relay-repo-out · `remote-contract.json` gate
  added: `scripts/check-contract.mjs` runs inside `verify`, comparing this
  repo's constants and JSON copy against the relay repo's sibling copy
  (loud-skip when unreachable); `.vscodeignore` and `test/package.test.mjs`
  now reflect the relay living outside this repo.
- 2026-09-07 · task/S5kc3 · area file created from the codebase audit; three test-only bugs fixed (undecoded `import.meta.url`, smoke reading the last frame raw, smoke's teardown crash).
