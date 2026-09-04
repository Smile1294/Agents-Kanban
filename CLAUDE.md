# Agents Kanban

A VS Code extension: a kanban board that Claude agents run themselves, each
session in its own git worktree. Modelled on
[Nimbalyst](https://github.com/nimbalyst/nimbalyst).

**Read [PLAN.md](PLAN.md) first.** It carries the architecture, the message
stream reference, current state, and what to build next.

## Where things are documented

| Question | File |
|---|---|
| How does this work, what's next? | [PLAN.md](PLAN.md) |
| How does Nimbalyst do X? | [docs/NIMBALYST.md](docs/NIMBALYST.md) — don't re-clone the repo, it's already been analysed |
| What's the real Agent SDK API? | [docs/SDK-NOTES.md](docs/SDK-NOTES.md) — **the public docs are wrong in places** |
| Why is it built this way? | [docs/DECISIONS.md](docs/DECISIONS.md) — decisions and bug postmortems |
| How do I run agents on Bedrock, Vertex, a gateway or a local model? | [docs/PROVIDERS.md](docs/PROVIDERS.md) |
| How do I run it? | [README.md](README.md) |

## Commands

**Node 22.6+** — the tests run through `node --experimental-strip-types`. Every
script starts with `scripts/preflight.mjs`, which checks that, installs
dependencies when `node_modules` is missing, and names the fix when it is only
partial. Never add a script that skips it.

```bash
npm run verify         # preflight → typecheck → build → tests → launch gates. Run before committing.
npm run verify:package # package a .vsix and check what is inside it. Run before installing.
npm run watch          # rebuild on change
npm run install-local  # package and install into VS Code (reload the window after)
npm run screenshots    # render the real view in headless Chromium -> docs/screenshots
```

Press <kbd>F5</kbd> for an Extension Development Host. It runs `verify` first —
including the install, so F5 works on a fresh clone —
(about thirteen seconds) rather than only building, because building alone will
happily launch an extension whose manifest and code disagree — which is exactly
the "I pressed F5 and nothing worked" failure. Use **Run Extension (skip
checks)** when the gates are what you are changing.

Every task goes through `scripts/with-node.sh`, which finds a Node 22.6+ and puts
it on PATH. VS Code runs tasks in a non-interactive shell and nvm/fnm/asdf live
in `~/.bashrc`, which returns early for exactly that kind of shell — so without
it, F5 works or fails depending on whether VS Code was started from a terminal or
from the desktop. Add a task, route it through the script.

**Open a git repository** — the board renders without one, but agents cannot
run, since each session needs a worktree.

## The two ideas everything rests on

1. **A card and a session are the same thing at two zoom levels.** Kanban shows
   every session by phase; chat shows one transcript. Switching never changes
   what exists.
2. **A session's column *is* its `phase`.** No move operation, no reorder tool.
   Writing `phase` is the move.

## Rules for changing this codebase

- **Nothing TRACKED goes in the user's repository.** Sessions and transcripts
  belong to Claude Code (`~/.claude/projects/`); phase, tags and worktree
  mapping go to a sidecar in extension storage. v1 wrote `.kanban/*.md` into the
  working tree and every agent turn produced a git diff. Do not reintroduce
  this. There is exactly one deliberate exception, and it is one line: worktrees
  live in `<repo>/.agentskanban/worktrees/`, and `ensureIgnored()` puts
  `/.agentskanban/` into `.gitignore` before the first one is created. That
  ignore rule is load-bearing — `merge()` refuses on a dirty main worktree, so
  an unignored scratch directory blocks every merge from the first session
  onwards. Anything else you are tempted to write into the working tree belongs
  in extension storage.
- **The left side bar is not ours.** No command in this extension may open,
  close, collapse or resize it. `applyBoardFocus` takes the bottom panel and the
  secondary side bar, and those only, because they are the two areas nothing
  else in the window reopens behind our back mid-gesture — the property the
  whole close-then-toggle scheme depends on. The side bar does not have it: the
  icon click that closes the board reopens the side bar first, so a restoring
  `toggleSidebarVisibility` closed it instead. Nine attempts; see
  [docs/DECISIONS.md](docs/DECISIONS.md).
- **Nothing expensive may run per streamed token.** `refreshAll()` fires on every
  frame an agent produces. It used to do a full `getState()` — a session-index
  scan and a transcript parse — twice over, which cost more per minute than the
  minute contained and slowed the agent down, because the CLI's stdout is
  drained on the same event loop. Repaints go through `board/coalesce.ts`, one
  state serves both surfaces, and anything that cannot have changed since the
  run started is captured once rather than re-read.
- **Never show a signal that cannot say "bad".** A pulsing dot pulses over a
  wedged process too. Show the number the indicator is derived from — the board
  shows the age of the last CLI frame, which climbs when nothing is happening.
- **The board's own state must outlive the extension's identity.** Phase, tags
  and the worktree mapping live in `globalStorageUri`, whose path VS Code
  derives from `<publisher>.<name>` — so renaming either hands the next install
  an empty directory while Claude Code still has every session, and every card
  falls to the default column. That happened: `david.claude-kanban` became
  `smile1294.agents-kanban` and the whole board came back in Planning.
  `MetaStore` folds in what sibling storage directories remember. The merge is
  ADDITIVE and that is load-bearing: recovering only when our own file is
  MISSING looks equivalent and fixes nothing, because the new install writes a
  file the moment it is used. Ours always wins, only unknown session ids are
  taken, once per source (`.recovered.json`, or a deleted session comes back
  every time), only this workspace's file, and only from a directory named like
  an extension.
- **Anything persisted must be READ BACK by a test, not just written.**
  `contextWindow` was written by every run and missing from the parse in
  `all()`, so the number the context meter measures against was lost on every
  launch — the exact failure that field was added to prevent, silently, for its
  whole life. A write with no round trip is not persistence.
- **A run that was killed must SAY so.** The CLI is a child of the extension
  host and dies with it; nothing can re-attach. `SessionMeta.running` is written
  when a run registers and cleared when it ends, so a mark still there at
  startup means the host went away mid-turn, and the card says "Interrupted 9m
  ago" instead of looking identical to a run that finished. Two things are
  load-bearing and neither is visible to the type system: `stop()` clears the
  mark because the user chose it, and `stopAll()` deliberately does NOT, because
  that is the event being recorded — reverse them and every restart erases its
  own evidence. And `0` clears it, never `undefined`, which `stripUndefined()`
  drops.
- **A number the board shows must not depend on a process being alive.** Context
  fill and spend both came off the live agent and nowhere else, so every session
  went blank when its process ended — which a VS Code restart does to all of them
  at once. Both are derived from Claude Code's transcript
  (`sessions/usage.ts`), and the live path uses the same arithmetic so the figure
  does not change when a run ends. Two traps, both load-bearing: a streaming
  response is written as one assistant record per content block and **each
  repeats the whole response's usage**, so costs deduplicate by `message.id` or
  come out ~2.7x high; and the SDK's `getSessionMessages` `limit` takes the
  FIRST n messages, so the window is applied to the tail instead. Spend is our
  arithmetic over published rates, so it is checked against the CLI's
  `total_cost_usd` every turn and says `≥` when a model has no rate.
- **Subagent frames carry `parent_tool_use_id`.** They must never be merged into
  the main thread (their text is not the agent's answer) and must never be
  dropped (a Task then looks frozen for minutes). Route on it, nest under the
  Task, collapse by default.
- **Run the CLI on the machine, never the SDK's bundled binary.** It is excluded
  from the .vsix, it is a Bun executable that SIGBUSes on some Linux boxes, and
  reaching for it means a dev checkout runs a different Claude Code from the one
  the user maintains.
- **Assert on the layout, not on the commands.** A pair of workbench commands
  can look symmetric and not cancel. `test/harness.mjs` models the four
  workbench areas as state and derives webview visibility from it; test what the
  window looks like afterwards.
- **Keep `vscode` imports confined** to `extension.ts` and `board/panel.ts`.
  Everything else is plain Node and unit-tested without VS Code.
- **Never swallow a promise rejection with a bare `void`.** A broken `getState()`
  once became a silently blank panel with no error anywhere.
- **Registration must not depend on workspace state.** Commands and the webview
  provider register unconditionally; an early return in `activate()` made every
  command report "command not found".
- **No parameter properties in constructors.** Tests run through
  `node --experimental-strip-types`, which rejects them — they emit code, not
  just types.
- **An attachment goes to the model, never to a file.** A user message is an
  Anthropic `MessageParam`, so a pasted image rides inside it as an image
  content block (`agent/images.ts`). Nimbalyst stages attachments as files and
  hands over paths, which needs a staging directory, a `.gitignore` entry when
  it is inside the workspace, and a tool call to read each one back — all three
  of which this project's "nothing goes in the user's repository" rule forbids
  or makes pointless. Two things are load-bearing: the webview downscales to
  1568px on the long edge before sending, because an image costs ~`w*h/750`
  tokens and beyond that the service downscales anyway; and the transcript
  entry keeps the COUNT, never the bytes, because that array is serialised to
  the webview on every repaint.
- **Starting the app is one button, and it waits for the port.** `run/recipe.ts`
  prefers the project's own per-worktree launcher (`wt`) over anything guessed,
  because it owns the port, the database and the session cookie — none of which
  is inferable from a file tree — and it never returns a URL it cannot justify:
  a plausible `localhost:8000` belonging to the main checkout shows the OLD code
  and reads as "the change did nothing". The browser opens only once something
  actually answers on the port.
- **A provider is environment on the CLI, and an explicit one CLEARS what it
  does not set.** This extension never talks to a model API — it spawns the
  Claude Code CLI, and every backend the CLI can reach is selected by
  environment variables on that child process. So `providers.ts` is a pure
  reducer from a profile to an environment patch, and the only place that knows
  a variable name. Two halves are load-bearing. The default profile is
  `inherit`, which writes NOTHING: `agentEnv()` spreads `process.env`, so a
  shell that already exports `CLAUDE_CODE_USE_BEDROCK=1` was already on Bedrock
  before this feature existed, and forcing first-party would have broken every
  enterprise setup silently. And provider selection is a SET OF INDEPENDENT
  FLAGS, not one field — so an explicit profile returns `clear` alongside `set`
  and `agentEnv()` drops those keys entirely, or a gateway's `ANTHROPIC_BASE_URL`
  layered over an ambient Bedrock flag yields a session still on Bedrock with
  the board naming the wrong provider. Dropped, never set empty: a future CLI
  reading `''` as "set" would turn the guard into the bug. What is deliberately
  NOT cleared is the user's cloud credential chain (`AWS_PROFILE`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `HTTPS_PROXY`) — that is how Bedrock and
  Vertex are documented to authenticate.
- **A provider readout must come from the CLI, not from our own config.**
  Writing environment variables is a request; a managed settings file, an
  `apiKeyHelper` or `~/.claude/settings.json` all outrank it. So every run asks
  `Query.accountInfo()` ONCE — fire-and-forget, never in the message loop — and
  reconciles `apiProvider` against the profile, and a disagreement becomes an
  amber note naming both sides. This is "never show a signal that cannot say
  bad" applied to provider selection: a readout that could only repeat our own
  configuration back would be decorative.
- **A credential goes to `SecretStorage`, never to settings.** A
  `ProviderProfile` is written to `agentsKanban.providers`, which syncs between
  machines and gets committed in `.vscode/` directories, so the profile records
  only `hasCredential: true` and `envForProfile()` takes the secret as an
  argument. `smoke.mjs` checks BOTH stores in BOTH directions, because a
  harness that swallowed writes would let "the key went into settings.json"
  pass. And `authStyle` is not cosmetic: `ANTHROPIC_AUTH_TOKEN` sends
  `Authorization: Bearer` and `ANTHROPIC_API_KEY` sends `x-api-key`, so the
  wrong one is a correct key that 401s.
- **Off first-party, a model id is not one of ours.** `MODEL_RATES` and
  `MODEL_WINDOWS` are keyed by Anthropic's ids and no other provider uses them:
  Bedrock says `us.anthropic.claude-haiku-4-5-20251001-v1:0`, Vertex says
  `claude-sonnet-4-6@20260115`. `normaliseModel()` strips the prefixes and
  suffixes rather than the price table being copied per provider — without it a
  whole Bedrock deployment reports `≥ $0.00` and a `?` window, which is honest
  (`priced: false` IS "unknown model") and useless. An inference-profile ARN
  stays unpriced on purpose: it names a profile, not a model.
- **Switching provider applies to the NEXT session only.** A provider is chosen
  when the CLI process starts, because it *is* environment on that process, so
  there is no honest way to move a live run — unlike model and effort, which
  genuinely take effect next turn. The switch also re-checks the model
  selection, because the model list is per-provider and would otherwise strand
  it on an id the new backend does not serve.
- **A provider check must be able to say "bad", and `accountInfo()` cannot.**
  `Query.accountInfo()` reports the backend the CLI *would* use — at
  `initialize` time it has made no API request, so a gateway pointed at a dead
  port comes back `firstParty` and looks fine. The first probe said "Connected"
  to `http://127.0.0.1:1`. So `checkEndpoint()` tests a gateway's URL directly:
  a TCP connect, then the `max_tokens: 1` request the gateway docs prescribe,
  and the answers are FOUR cases because they have four different fixes — start
  the proxy, correct the path, fix the credential, or move it to the other
  header. The `401` message names `Bearer` vs `x-api-key` explicitly, because a
  right key in the wrong header is the most common cause and "401" alone sends
  people off to regenerate a working key. Cloud kinds say "configured for X, the
  first request will confirm the credentials", never "connected" — they have not
  asked. See [docs/DECISIONS.md](docs/DECISIONS.md).
- **The model list comes from the CLI, not from a table here.** `MODELS` in
  `sessions/meta.ts` is the FALLBACK; `Query.supportedModels()` is the answer.
  The hardcoded table was wrong three ways at once and none were visible from
  inside the extension: Fable 5 shipped and the picker did not have it;
  `claude-opus-5[1m]` and `claude-opus-5` are different windows and it knew one;
  and every model got five effort levels and a thinking toggle when Haiku 4.5
  accepts NEITHER — `supportsEffort` is ABSENT on it, not false, so gate on
  `=== true`. Effort and thinking are per model and DISAPPEAR when unsupported,
  never greyed out. Discovery is cached per provider in `globalState`, is never
  on the render path or the activation path (it spawns a CLI, and `smoke.mjs`
  must stay hermetic — it sets `discoverModels: false`), and its fallback is
  never an empty picker: empty reads as a broken extension and the cause would
  be something as ordinary as being offline. When the built-in list is in force
  the picker SAYS so, because "why is Fable missing?" is otherwise unanswerable.
- **A session flag is a request the CLI never refuses.** `ultracode` and
  `fastMode` go through `Options.settings` / `applyFlagSettings()`, which
  validates NOTHING — measured against a real CLI it resolves for
  `ultracode: true` on a model with no xhigh, for `ultracode: 'banana'`, and for
  a key that does not exist. So a toggle needs both halves. Before the run, the
  model's own capability from `supportedModels()` is the gate, and it is
  enforced HOST-side in one place, after the assignment, so a model switch that
  revokes a flag and a stale webview posting one are the same check — a second
  copy on the assignment was unreachable and failed no test when broken. After
  the run starts, `ultracodeWarning()` looks for the `Workflow` tool on
  `system/init`. That check is deliberately ONE-SIDED: `Workflow` is present on
  ordinary sessions too, so its presence proves nothing and is never reported as
  success. A signal must be able to say bad; it need not be able to say good.
- **Safety boundaries go in code, not prompts.** The tool description tells the
  agent what to do; `isHumanOnly()` makes it impossible. Both, always.
- **A question is not a permission request.** `AskUserQuestion` arrives through
  `canUseTool` like `Bash` does, but allowing it does not answer it — the tool
  reads its answer out of `updatedInput.answers`, keyed by question text. Every
  `canUseTool` call was rendered as one Allow/Deny pair, so a question appeared
  as `Claude wants to run AskUserQuestion` with the question itself nowhere on
  screen, the user pressed Allow, and the input went back untouched. The tool
  then reported that nobody had answered and the agent invented the decision it
  had deliberately stopped to ask about — silently, every time. Parsing lives in
  `board/questions.ts` and is defensive, because the input is model-written; a
  shape it cannot render falls back to Allow/Deny rather than showing an empty
  picker. The choices are module-level in `board.js` for the usual reason: a
  half-finished answer held in the DOM is destroyed by the next repaint.
- **A session may split into subtasks, but only downwards and only once.** An
  agent that decides its brief is two unrelated jobs calls `split_task`; each
  subtask is a real session with its own worktree. Every limit is in
  `AgentManager.split()`, never in the description: at most four, one level deep
  (a subtask cannot split), once per session, and refused outright once the
  parent's worktree is dirty or has commits — that last one is what makes it
  safe for subtasks to fork from the parent's BASE rather than its branch, which
  in turn is what keeps a subtask an ordinary task branch that the existing
  diff, merge and cleanup paths already handle. It is also the one board tool
  that is not auto-allowed: starting processes that cost money is worth a click.
- **Verify SDK APIs against the `.d.ts`**, at
  `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`. See
  [docs/SDK-NOTES.md](docs/SDK-NOTES.md) for cases where the published docs
  disagree with reality.
- **Every new `vscode` API goes into `test/harness.mjs` too.** The stub is
  deliberately incomplete: calling an API it does not have fails the smoke test
  the same way a wrong API name fails activation in the real editor. That is the
  point, not an obstacle.
- **npm scripts run through `sh`, not bash.** No `**` globbing, no `for` loops,
  no platform-specific paths — put the logic in a `scripts/*.mjs` file instead.
  `smoke.mjs` asserts this, because a bashism silently ran zero tests on Linux.
- **Never invoke a dependency's binary by name, or use `npx`.** Both go through
  `node_modules/.bin`, which npm fills with symlinks that do not exist on a
  filesystem without them (WSL on a Windows drive, network shares) or after
  `--no-bin-links`. Use `node scripts/run-bin.mjs <package> <bin> …`, which
  resolves through Node. Every script must start with `node` or `npm`.
- **A new test gate must be shown to fail.** Break the thing it guards, watch it
  go red, put it back. A gate that has never failed has not been tested.
- **Run a real agent before believing the suite.** Every unit test was green
  while agents could not move their own cards and transcripts came back empty.
  The scripts under `docs/DECISIONS.md` "the first real agent run" are the
  shape to copy: drive `AgentManager` against a temp git repo and read what
  actually happened.
- **Anything the USER put into a state, and `render()` rebuilds, carries a key.**
  The webview replaces the whole tree several times a second while an agent
  works, so any state living only in the DOM is destroyed on the next frame.
  Scroll containers carry `data-scroll`; a `<details>` carries `data-open` and
  goes through `disclosure()`; the composer's draft and its pasted attachments
  are module-level, not DOM-held. "Changes" and "How to test this" were rebuilt
  with `open = true` every frame, so collapsing them lasted a few hundred
  milliseconds — reported as "it keeps reopening, I want it toggled by me only".
  A closed panel is also told to the host, so it outlives the panel itself.
- **Anything that scrolls and is rebuilt by `render()` carries `data-scroll`.**
  The webview repaints by replacing the whole tree, and an agent at work does
  that several times a second. A scroll container without the attribute is
  recreated at the top on every frame — which is how scrolling down a busy
  column kept snapping back. `render()` restores every `[data-scroll]` by its
  key; `scroll.test.mjs` and the Chromium gate in `layout.test.mjs` check it.
- **An editor opened from the board opens BESIDE it, inside `ownLayoutChange`.**
  The board is a webview in an editor group. A file or diff opened into that
  group takes the group, the webview reports `visible: false`, and that is the
  very event the click-away rule closes on — so a button on the board made the
  board vanish, and the file appearing in its place read as "nothing happened".
  `smoke.mjs` presses a test-plan link and a changed-file row against a session
  whose worktree is the repo itself and asserts the board is still there.
- **No `innerHTML` in `board.js`, ever.** The transcript is another program's
  output, rendered as markdown, and the webview can post `move`, `send` and
  `remove` to the host. `renderMarkdown` builds nodes and sets text; anything in
  an answer that looks like HTML is shown as characters. `markdown.test.mjs`
  asserts a `<script>` or `<img onerror>` in an answer creates no element. Links
  are `http(s)` and `mailto` only; everything else renders as its text.

## Testing conventions

Tests are plain Node scripts that print `ok:` / `FAIL:` lines and exit non-zero.
No framework. Run one directly:

```bash
node --experimental-strip-types --no-warnings src/sessions/__tests__/store.test.ts
```

Six of them are load-bearing and worth understanding before you change things:

- `sessions/store.test.ts` runs against **real Claude Code session data**, not a
  mock. If the SDK's session API changes, this fails first.
- `git/worktree.test.ts` runs against **real git repositories**. It is what found
  the porcelain-trimming bug that had been silently truncating a filename.
- `board/webview.test.mjs` runs `media/board.js` in a `vm` against a stub DOM.
  The view layer has no type checking, so a runtime throw there shows up as a
  silently blank panel and nothing else.
- `board/layout.test.mjs` renders the real `board.css` and `board.js` in real
  Chromium and **measures**. It is the only gate that can fail on a stylesheet:
  every other view test asserts on text, and text is not layout. It found a card
  title overflowing its box by 94px while every text assertion was green — and
  later a chat transcript squeezed to **0px wide** by one long session title,
  with all of its text present and correct in a box nobody could read. Both were
  a flex item's default `min-width: auto` defeating `text-overflow: ellipsis`.
- `agent/executable.test.ts` asserts against the **built bundle**, not the
  source, because the bug it guards used `__filename` — which exists in the CJS
  esbuild emits and does not exist in the ESM the test runner uses. The code path
  was invisible to any unit test and crashed every agent run in the real editor.
- `smoke.mjs` is the launch gate, and the one to read first. It activates the
  **built bundle**, cross-checks the manifest against the code, drives the real
  message flow, and renders the host's **real** state through the **real**
  `board.js`. Every "it didn't even launch" bug so far lived in one of those
  seams, and no unit test crossed any of them. It is **hermetic**: it seeds a
  real Claude Code transcript with known token counts into a throwaway
  `CLAUDE_CONFIG_DIR`, so it neither reads nor depends on the sessions on your
  machine. Assert against those known numbers rather than adding a
  `if (sessions.length)` guard — a gate that skips is not a gate.
