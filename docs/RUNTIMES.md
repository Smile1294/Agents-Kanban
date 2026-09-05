# Runtimes — which agent program runs a session

A **runtime** is the agent program itself: the thing you sign into, that owns a
transcript store, a permission model and a tool loop. Claude Code is one. Codex
is another. They are siblings, not alternatives inside one configuration.

This is a different axis from [providers](PROVIDERS.md), and conflating them is
the mistake this whole subsystem exists to correct:

|  | Provider | Runtime |
|---|---|---|
| What it is | the backend *behind* Claude Code | the agent program itself |
| How it is selected | environment variables on the child process | a different process, a different protocol |
| Adding one costs | a row in a reducer (`providers.ts`) | a file that implements `AgentRuntime` |
| Owns the transcript | no | **yes** |
| Owns the login | no | **yes** |

For a year the answer to "I have a ChatGPT subscription" was *run a translation
proxy in front of Claude Code*. That answer was wrong, and not by a little:

> **A ChatGPT subscription cannot be spent through a proxy at all.** LiteLLM and
> claude-code-router need an OpenAI **API key** — a different credential on a
> different billing meter. The subscription's tokens live in
> `~/.codex/auth.json`, and only the Codex runtime can spend them.

So the board drives Codex directly. Nothing is proxied and nothing is
configured: if `codex login` has been run on this machine, Codex sessions work.

---

## What you get

- **Two agents on one board, at once.** A Claude Code card and a Codex card
  running side by side, each in its own worktree, each on its own model. Pick
  per session from the 🤖 control on the composer bar.
- **Each session keeps the agent it started on.** Its transcript lives in that
  runtime's own store and nothing else can read it, so there is no honest way to
  move a live session across — and no attempt to offer one.
- **The login you already have.** Nothing asks for a key. Whether you are signed
  in, and as whom, is read from the runtime and shown on the settings page,
  including when we *could not tell*.

| | Claude Code | Codex |
|---|---|---|
| Protocol | Agent SDK `query()` | `codex app-server`, JSON-RPC over stdio |
| Sign-in | subscription, Console key, or a cloud credential chain | `codex login` — ChatGPT subscription or OpenAI key |
| Provider profiles | **yes** — its backend is environment | no; it authenticates as itself |
| Board tools | in-process MCP server | the same tools over stdio ([the bridge](#board-tools-over-two-transports)) |
| Transcripts | `~/.claude/projects/<encoded-cwd>/*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| Meter | dollars, priced per response | **percentage of a rate-limit window** |
| Images in the composer | yes, inline | no — Codex takes files by path, and this board writes nothing to your repo |
| Extended-thinking toggle | yes | no — reasoning depth is the effort picker |

---

## The meter is a union, and that is the point

A Claude Code session priced against published rates has a dollar figure it can
defend. **A Codex session on a ChatGPT subscription does not** — no request is
billed, and the only real quantity the service reports is how much of a rolling
rate-limit window has been used.

So `Meter` in [`src/agent/runtime.ts`](../src/agent/runtime.ts) is a union:

```ts
| { kind: 'usd';  spentUsd: number; priced: boolean }
| { kind: 'plan'; usedPercent: number; windowMinutes: number; resetsAt?: number; plan?: string }
| { kind: 'unknown' }
```

Showing `$0.00` on a Codex card would be [a signal that cannot say
"bad"](DECISIONS.md) — it is not zero spend, it is *not a dollar quantity*.
`13% of 5h · Plus` is the number the indicator is actually derived from.

`unknown` is a first-class case and renders as `—`, never as zero.

---

## Board tools over two transports

The board's premise is that **agents move their own cards**. That works for
Claude Code because the Agent SDK takes an in-process MCP server: `tools.ts`
runs inside the extension host with the `SessionStore` already in scope, and
there is no transport at all.

Codex takes MCP servers as **commands to spawn**. So the same definitions are
served a second way:

```
  extension host                                   codex
  ┌──────────────────────────┐                    ┌──────────────┐
  │ buildBoardTools(...)     │                    │  app-server  │
  │        ▲                 │                    └──────┬───────┘
  │   BoardBridge (net)      │                           │ stdio MCP
  │        ▲                 │                    ┌──────┴───────┐
  └────────┼─────────────────┘   unix socket /    │ board-mcp.js │
           └───────────────────  named pipe ──────┤  (this repo) │
                                                  └──────────────┘
```

Three things about it are load-bearing:

- **One set of definitions.** `buildBoardTools` is called with a collector
  instead of the SDK's `tool` helper. Writing the tools twice is the exact shape
  of a bug this project has already had: a hand-maintained copy of the tool
  names drifted and left agents unable to move their own cards, silently.
- **The guard stays on our side of the socket.** `board-mcp.js` holds no board
  logic — it forwards. `isHumanOnly()` runs in the host, because a boundary
  enforced inside a process the agent's runtime spawned is not a boundary.
  `board-bridge.test.ts` asserts `set_phase('complete')` is refused across the
  socket, and that assertion has been shown to fail when the guard is removed.
- **A socket, not a port.** These tools write to the board and can start other
  agents. A unix socket in the extension's own storage carries filesystem
  permissions; a named pipe is the Windows equivalent. There is a token as well,
  because a socket path is guessable from a process listing.

---

## Adding a third runtime

Everything the board asks of a runtime is declared in one interface. A new agent
program is **one module and one line**, and it either satisfies the contract or
does not compile.

1. **Write `src/agent/runtimes/<name>.ts`.** Implement `AgentRuntime`:

   | Member | What it must do |
   |---|---|
   | `capabilities` | Declare what it *cannot* do. Absent capabilities make the board **hide** the control, never grey it out. |
   | `detect(configured?)` | Configured path → PATH → well-known locations. **Never `node_modules`.** |
   | `login(loc)` | Ask the runtime. Must be able to say `signedOut` *and* `unknown` — they have different fixes. |
   | `models(loc)` | The runtime's own answer. `builtinModels()` is the floor, and the UI discloses when it is in force. |
   | `start(spec)` | Return an `AgentRun` — the same events, meaning the same things. |
   | `history` | Read its transcript store, so nothing the board shows depends on a process being alive. |

2. **Add the id to `RuntimeId` and `RUNTIME_IDS`** in `runtime.ts`. It is a
   string union rather than a bare string so that a persisted session carrying
   an id nothing serves is a parse failure we can name — not an `undefined`
   dereference on the render path.

3. **Register it** in `src/agent/runtimes/index.ts`. One line, and it is the
   only file that names them all.

4. **Add it to the manifest**: the `enum` on `agentsKanban.runtime`, and an
   executable-path setting if it needs one.

`AgentManager.startRun()` has **no branch on runtime identity**, deliberately.
That is the test of whether the abstraction is real: a third runtime should
require no edit to it.

### The traps a new adapter will hit

Every one of these was found writing the Codex one.

- **Schema drift is not hypothetical.** Codex's own docs tell integrators to
  regenerate types after every CLI upgrade, and its two published surfaces
  already disagree with each other: the exec stream says `agent_message` and
  `command_execution`, the app-server says `agentMessage` and
  `commandExecution`. The adapter normalises separators and case, reads both,
  and — this is the important half — **reports what it could not read** once per
  turn. A transcript that quietly loses half its rows is the worst failure this
  board has.
- **Cached-token accounting differs per vendor.** Anthropic's `input_tokens` and
  `cache_read_input_tokens` are *disjoint* and must be summed. Codex's
  `cached_input_tokens` is a *subset* of `input_tokens`, already counted. Adding
  them the Claude way reports ~26K on a real 14K turn — a meter at double the
  truth, on the readout whose whole purpose is knowing when to compact.
- **Cumulative usage is not context fill.** Read the *last* turn's usage, never
  the session total, or a 258K window reports millions. Same trap as the Claude
  path's `result.usage`, in a new dialect.
- **An unanswered permission request is a wedged agent.** The server blocks on
  it, and the card looks exactly like one thinking hard. Every branch that
  receives a request must end in an answer — including the branch for a request
  we do not recognise, which is refused *with a reason* rather than left hanging.
- **A module cycle between the runtime and its store is a crash with no
  author.** The runtime needs the store for `history`; the store needs to know
  where the store lives. Put the path resolver in the store — see the note on
  `codexHome()`.
- **Honour the home-directory environment variable** (`CODEX_HOME`,
  `CLAUDE_CONFIG_DIR`). `smoke.mjs` must stay hermetic, and a hardcoded `~` makes
  every assertion depend on whoever ran it.

---

## Where things are

| | |
|---|---|
| The contract | [`src/agent/runtime.ts`](../src/agent/runtime.ts) |
| The registry | [`src/agent/runtimes/index.ts`](../src/agent/runtimes/index.ts) |
| Claude Code | [`src/agent/runtimes/claude.ts`](../src/agent/runtimes/claude.ts) |
| Codex | [`src/agent/runtimes/codex.ts`](../src/agent/runtimes/codex.ts) |
| The JSON-RPC transport | [`src/agent/jsonrpc.ts`](../src/agent/jsonrpc.ts) |
| Codex's transcripts | [`src/sessions/codex-store.ts`](../src/sessions/codex-store.ts) |
| Board tools over stdio | [`src/agent/board-bridge.ts`](../src/agent/board-bridge.ts), [`src/board-mcp.ts`](../src/board-mcp.ts) |
| The settings page | [`src/board/settings.ts`](../src/board/settings.ts), `media/settings.{js,css}` |

## Sources

- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Codex app-server, OpenAI docs](https://developers.openai.com/codex/app-server)
- [`codex exec` and its JSON event stream](https://github.com/openai/codex/tree/main/sdk/typescript/src)
- [Codex CLI authentication](https://developers.openai.com/codex/auth/ci-cd-auth)
- [Model Context Protocol](https://modelcontextprotocol.io)
