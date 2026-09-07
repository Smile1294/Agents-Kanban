---
name: runtimes
description: Which agent program runs a session — the AgentRuntime contract and registry, Claude Code behind it, Codex over app-server JSON-RPC and its on-disk store, the meter union, finding the CLI, asking it questions without a turn, install and login status
paths:
  - src/agent/runtime.ts
  - src/agent/runtimes/*.ts
  - src/agent/jsonrpc.ts
  - src/agent/sdk.ts
  - src/agent/connect.ts
  - src/agent/status.ts
  - src/sessions/codex-store.ts
tests:
  - src/agent/__tests__/codex.test.ts
  - src/agent/__tests__/executable.test.ts
  - src/agent/__tests__/status.test.ts
  - src/agent/__tests__/route-launch.test.ts
  - src/sessions/__tests__/codex-store.test.ts
last_verified: 2026-09-07
---
# Runtimes — which agent program

## Owns

The axis that is NOT the provider: the agent program itself. A runtime is a
different process speaking a different protocol, with its own login, its own
model ids and its own transcript store. Claude Code and Codex are the two; a
third is one module plus one line. Full narrative in [RUNTIMES.md](../RUNTIMES.md).

## Files

**`src/agent/runtime.ts`**. The contract. `AgentRuntime` — `id`, `label`,
`capabilities` (`boardTools: 'inProcess' | 'stdio'`, `providerProfiles`,
`thinkingToggle`, `images`, …; an ABSENT capability makes the board HIDE the
control, never grey it out), `detect(configured?)` → `RuntimeLocation` or a
described problem, `login(loc)` → `LoginState` (four cases: signed in, signed
out, not installed, unknown — "could not tell" is never rendered as "signed
out"), `models(loc)`, `builtinModels()`, `start(spec: RunSpec)` → `AgentRun`,
`history: RuntimeHistory`. `RunSpec` — everything a launch hands over (`taskId`,
`cwd`, `permissionMode`, `executable`, `appendSystemPrompt`, `resume`,
`boardTools`, provider env + `envClear`, `modelBook`, `model`, `effort`,
`thinking`, `ultracode`, `fastMode`). `AgentRun` — the live-session interface
both sessions implement, with the event names meaning the same things.
`Meter` — `{kind:'usd', spentUsd, priced} | {kind:'plan', usedPercent,
windowMinutes, resetsAt?, plan?} | {kind:'unknown'}`, `parseMeter` (defensive),
`NO_SPEND`. `RuntimeHistory` (`list`, `transcript`, `usage`, `meter`, optional
`delete`, no `rename`) and `HistoricSession`. The registry: `registerRuntime`,
`getRuntime`, `allRuntimes`; `RuntimeId` is a string union and `parseRuntimeId`
exists so a persisted id nothing serves is a named parse failure.

**`src/agent/runtimes/index.ts`**. The ONE file that names every runtime;
registration is an import side effect, on purpose. Import it for effect from
`extension.ts` and from any test needing a populated registry.

**`src/agent/runtimes/claude.ts`**. Claude Code behind the contract, adding no
behaviour: `detect` → `resolveClaudeExecutable`; `login` → `accountInfo()`
under `withSilentQuery` (it once hung forever on a gateway that dropped
packets); `models` → the built-in list (discovery lives in `models.ts`);
`start` → `new AgentSession(spec)`; `capabilities.boardTools = 'inProcess'`.

**`src/agent/runtimes/codex.ts`** (~1210 lines). Codex driven natively over
`codex app-server` JSON-RPC — no proxy, because a ChatGPT subscription cannot be
spent through one. `CodexSession`: handshake, `thread/start` with the cwd,
`turn/steer` for follow-ups, `turn/interrupt`, approvals arriving as
server→client requests (`execCommandApproval`, `applyPatchApproval`) where
EVERY branch ends in an answer, tool rows from item events, usage via
`contextFill` (Codex's `cached_input_tokens` is a SUBSET of `input_tokens` —
the fill is the turn total), the rate-limit meter. `codexRuntime`:
`detect` (configured → PATH → well-known, never `node_modules`), `login`
(`~/.codex/auth.json` through the server), `models`/`parseModels`,
`codexPermissions(mode)` → `{approvalPolicy, sandbox}`, `capabilities.boardTools
= 'stdio'`, `images: false` (the composer says so rather than dropping them),
`history: codexHistory`. Schema drift is designed for: `pick()`/`itemKind()`
read both `agent_message` and `agentMessage`, unknown methods accumulate and
surface ONCE per turn as a warning. Test: `codex.test.ts` — a stand-in
app-server child speaking real newline JSON-RPC over real pipes; no Codex needed.

**`src/agent/jsonrpc.ts`**. `JsonRpcPeer` over a child's stdio: bidirectional,
routes on `method` vs `result`/`error` (never on id ranges — both sides allocate
from 1), tolerates the missing `"jsonrpc"` member (Codex documents this),
`IncomingRequest`, `RpcError`. An implementation handling only responses hangs
the agent at its first approval, looking exactly like a wedged process.

**`src/agent/sdk.ts`**. `loadSdk()` — a cached dynamic `import()` of the
ESM-only Agent SDK (kept out of the CJS bundle; esbuild preserves `import()` for
externals); `resolveClaudeExecutable(configured?)` — setting → PATH → the usual
install locations, and NEVER `node_modules` (the SDK's bundled Bun binary
SIGBUSes on some Linux boxes; a dev checkout would run a different Claude Code
from the one the user maintains). Test: `executable.test.ts` — asserts on the
BUILT bundle, because the bug used `__filename`, which exists in CJS and not in
the ESM the test runner uses.

**`src/agent/connect.ts`**. `withSilentQuery(env, opts, ask)` — ask the CLI a
control question (`accountInfo`, `supportedModels`) without a turn: a prompt
iterable that never yields, a wall clock (`timeoutMs` — a dead host does not
fail, it hangs), a guaranteed abort (a leaked CLI per button press is invisible
until the machine is out of memory). ~460 ms, no tokens billed. `ConnectError`.

**`src/agent/status.ts`**. `collectRuntimeStatus(configured, providerEnv?,
runtimes?, timeoutMs)` — every registered runtime's install and login state, in
parallel, each with its own wall clock, each failing independently into a
renderable `unknown`. Never on the render path or at activation: it spawns
processes. Test: `status.test.ts` (the hang, not just the throw).

**`src/sessions/codex-store.ts`**. Codex's rollouts read back so a Codex card
survives a restart: `codexHistory` (`list`, `transcript`, `usage`/`meter`),
`parseRollout(raw)`, `codexHome(env)` (honours `CODEX_HOME`; lives HERE to break
the runtime ↔ store import cycle). The index has no `cwd`: rollouts are keyed by
date and the cwd is in each file's FIRST record, so `list()` reads first lines
newest-day-first up to `SCAN_LIMIT`. Rollouts are append-only, so the transcript
cache is keyed by size + mtime. Test: `codex-store.test.ts` (a real rollout
format, byte for byte, in a throwaway `CODEX_HOME`).

## How it works

`AgentManager.startRun()` asks `getRuntime(agent.runtime)` and calls
`rt.start(spec)`; which board-tool transport to build comes from
`capabilities.boardTools`, never from the runtime's name. `SessionStore` asks
each runtime's `history` for its sessions and merges them; `runtimeOf()`
resolves a card's runtime from the sidecar or the foreign scan, so a Codex card
adopted off disk routes to Codex's store and not to Claude's parser (51 cards
once came back with empty transcripts that way). The settings page asks
`collectRuntimeStatus` and draws four login states as four different rows.

## Change recipes

- **A third runtime.** `src/agent/runtimes/<name>.ts` implementing
  `AgentRuntime`; the id into `RuntimeId` and `RUNTIME_IDS`; one line in
  `runtimes/index.ts`; the `enum` on `agentsKanban.runtime` and an
  executable-path setting in `package.json`; a `RuntimeHistory` if it has a
  store. `startRun()` must need no edit. Honour its home-directory variable so
  smoke stays hermetic. Read both spellings of anything its protocol publishes
  twice, and report what you could not read once per turn, never zero times.
- **A new capability.** Declare it on `capabilities`; the board hides the
  control when absent; `route-launch.test.ts` records the `RunSpec` a fake
  runtime receives.
- **A new control question to the CLI.** Through `withSilentQuery`, never a
  bare `query()`; never on the render path.

## Invariants

- A session keeps the runtime it started on; `SessionMeta.runtime` is parsed on
  the way back, never cast.
- A provider is environment on Claude Code's child; a runtime with
  `providerProfiles: false` makes the backend controls disappear.
- Dollars are not a universal unit: `Meter` is a union and `unknown` is `—`.
- Cached-token accounting is per vendor: Anthropic sums disjoint figures, Codex's
  cached count is already inside `input_tokens`.
- Run the CLI on the machine, never the SDK's bundled binary.
- An unanswered permission request is a wedged agent: every branch answers.
- `RuntimeHistory.delete` is optional and a foreign delete is verified against
  that runtime's OWN listing.

## Open work

- No real Codex run has been made from the board yet; the adapter reads both
  spellings because nothing local can prove which the live CLI uses.
- Images do not reach a Codex session.
- One app-server per session (a shared one could host every thread).

## Recent changes

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
