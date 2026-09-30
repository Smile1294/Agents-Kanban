---
name: runtimes
description: Which agent program runs a session — the AgentRuntime contract and registry, Claude Code behind it (on this machine or on Anthropic's cloud), Codex over app-server JSON-RPC and its on-disk store, the meter union, finding the CLI, asking it questions without a turn, install and login status
paths:
  - src/agent/runtime.ts
  - src/agent/runtimes/*.ts
  - src/agent/jsonrpc.ts
  - src/agent/sdk.ts
  - src/agent/connect.ts
  - src/agent/cli-update.ts
  - src/agent/status.ts
  - src/agent/cloud.ts
  - src/sessions/codex-store.ts
tests:
  - src/agent/__tests__/cli-update.test.ts
  - src/agent/__tests__/cloud.test.ts
  - src/agent/__tests__/claude-cloud.test.ts
  - src/agent/__tests__/codex.test.ts
  - src/agent/__tests__/executable.test.ts
  - src/agent/__tests__/status.test.ts
  - src/agent/__tests__/route-launch.test.ts
  - src/sessions/__tests__/codex-store.test.ts
last_verified: 2026-09-30
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
`thinking`, `ultracode`, `fastMode`, and `cloud?: CloudTarget` — run it on
Anthropic's cloud, continuing `id` when set). `AgentRun` — the live-session
interface both sessions implement, with the event names meaning the same
things; `cloud?(update)` is the one event only a cloud run emits (where it is,
what was delivered). `capabilities.cloud` says a runtime can run a session on
its vendor's cloud at all, and a signed-in `LoginState` carries
`cloud?: CloudEligibility` — whether THIS login may. Where a session runs is
deliberately NOT a runtime: it is the same program, protocol, login and model
ids, so it is a capability and a `RunSpec` field.
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
behaviour: `detect` → `resolveClaudeExecutable` plus the VERSION (`claudeVersion`,
a `--version` fast path) — the model list is compiled into the CLI, so that
number is what answers "why is the new model missing?"; `login` → `accountInfo()`
under `withSilentQuery` (it once hung forever on a gateway that dropped
packets); `models` → the built-in list (discovery lives in `models.ts`);
`start` → `new AgentSession(spec)`, or `new CloudRun(spec)` when `spec.cloud`
is set; `capabilities.boardTools = 'inProcess'`, `cloud: true`. `login` reads
`via` off the CLI's own fields (`apiProvider`, then `apiKeySource`) — it used
to call a Console API key a "subscription" — and answers the cloud question
with `cloudEligibility(info)`.

**`src/agent/cloud.ts`**. Running a session on Anthropic's cloud (Claude Code
on the web) through the unmodified `claude` binary and NOTHING else — the
header carries the CLI's capability table (2.1.285, read out of its bundle) and
the terms sentence that rules out the shortcut: "developers may not collect,
store, or intermediate Claude.ai credentials or session tokens", so nothing
here reads `~/.claude/.credentials.json` or the keychain, and nothing calls
claude.ai. Pure, no process spawned. `CLOUD_ENV` (`CCR_FORCE_BUNDLE=1`: the CLI
uploads the worktree as a git bundle, so no GitHub is needed and the cloud
starts from the card's own unpushed commit), `cloudEligibility(accountInfo)`
(a reported plan — the CLI omits `tokenSource` for subscribers — with no API key, on first-party only; a setup token, an API key, a cloud
provider each refused with its own sentence), `connectedRefusal(message)` (the
three sentences that mean "use the fallback" — anything else is a failure to
show), `readCloudCreate(raw, exited)` over a PTY's output (`screenText` first:
Ink draws the gap between words with `ESC[nG`), `readCloudSend`,
`explainCloudError` (appends the fix), `cloudCreateArgs` (`--cloud=<task>` in
ONE argv element, so a task starting with `-` is not a flag; `--permission-mode`
only for a mode the cloud accepts; never `--model`, which the CLI drops there),
`cloudSendArgs`, `ptyInvocation(platform, argv)` (`script(1)`, GNU and BSD
forms, `stty cols 200` so nothing wraps; `undefined` on Windows), `shellQuote`,
and the sidecar's `CloudRecord` with `parseCloud` (a stored URL that is not
claude.ai's is replaced, never opened), `mergeCloud` (the FIRST id wins) and
`cloudTranscript` (what a detached card's chat shows: the prompts it was
handed, a notice saying where the replies are, a failed delivery as an error).
Test: `cloud.test.ts` — real PTY captures of the CLI's no-login error and trust
prompt, and a real `script` run proving a task full of quotes, `$(…)` and
backticks arrives verbatim and runs nothing.

**`src/agent/runtimes/claude-cloud.ts`**. `CloudRun`, a cloud session behind
the same `AgentRun` a local one is. CONNECTED first: an ordinary
`AgentSession` started with `--cloud` (`extraArgs`, no `resume`, no board
tools, no model — the composer offers none for a cloud session), whose frames
are the live chat when the account has the CLI's connected-sessions gate.
DETACHED only when the CLI refuses with one of the
three `connectedRefusal` sentences, and only before anything was heard:
`claude --cloud "<task>"` inside `script(1)`, then follow-ups through
`claude -p --cloud <id>`, one delivery per run. A message typed during the
connected attempt is HELD until the session answers (`goLive`), so a decline
does not lose it. `interrupt()` and `stop()` end a detached create with a
sentence that says the session may exist anyway; `stop()` never emits an error
(that re-entered the manager's `finish()`). Test: `claude-cloud.test.ts` — the
real SDK and the real PTY spawning a stand-in `claude` that answers the way
2.1.285 does, per mode (created, archived, trust prompt, no login, slow).

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

**`src/agent/cli-update.ts`**. Which Claude Code the board runs, and updating
it. `parseCliVersion` (`2.1.272 (Claude Code)` → `2.1.272`), `compareVersions`
(numeric, part by part — a string compare calls 2.1.100 older than 2.1.99),
`claudeVersion(exe)`, `replacedInPlace(exe)` (false only for a native install,
whose versions live in `…/claude/versions/` behind a symlink),
`updateEnv(base)`, `judgeUpdate` (pure) and `updateClaudeCode(exe)` →
`UpdateOutcome` (`updated` / `unchanged` / `failed`, each carrying the CLI's own
words). Exists because `agentEnv()` puts `DISABLE_UPDATES` on every run — right
for a run, and the reason a `claude` nothing else starts is never updated, so
its compiled-in model list froze (2.1.272 has no Opus 5.5 in it at all). Two
traps: `DISABLE_UPDATES` makes `claude update` print a refusal and EXIT 0, so the
update env is never built by `agentEnv()` and the outcome is judged by the
version before/after, never the exit code; and stdin is IGNORED, or an updater
that asks a question waits out the five-minute wall clock. Test:
`cli-update.test.ts` — a stand-in `claude` on disk that behaves like the real
one where it matters (the exit-0 refusal is verbatim from the 2.1.281 bundle).

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
- The board disables the CLI's updater on every run, so it owes the user the
  update: `claude update` runs only on a click, with an environment NOT built by
  `agentEnv()`, and is judged by the version, never the exit code.
- An unanswered permission request is a wedged agent: every branch answers.
- `RuntimeHistory.delete` is optional and a foreign delete is verified against
  that runtime's OWN listing.
- A cloud session goes through the `claude` binary only. The board never reads
  the claude.ai login or calls claude.ai itself — Anthropic's terms forbid
  intermediating that token, whatever the convenience.
- The detached fallback runs ONLY on the CLI's three refusal sentences and only
  before the session was heard from. A connected run that fails halfway is a
  failure to show, never a reason to start a second session.

## Open work

- No real Codex run has been made from the board yet; the adapter reads both
  spellings because nothing local can prove which the live CLI uses.
- Images do not reach a Codex session.
- One app-server per session (a shared one could host every thread).
- Cloud: the CONNECTED path has never run against a real account — the gate
  was off wherever this was built, so what the board has seen of it is the
  stand-in. The detached path cannot bring a cloud session's changes back to
  the card's worktree without GitHub; Windows has no `script(1)` for it; the
  BSD `script` form is untested on a real Mac.

## Recent changes

- 2026-09-30 · claude/admiring-lamport-vyma1q · `cloudEligibility` fixed: the CLI reports a claude.ai subscription as `subscriptionType` and OMITS `tokenSource`, so requiring `tokenSource === 'claude.ai'` refused every subscriber ("not signed in"). A reported plan with no API key in use is now the line.

- 2026-09-30 · claude/admiring-lamport-vyma1q · cloud sessions: `cloud.ts` (pure: eligibility, the CLI's refusals and output, the PTY command, the sidecar record) and `runtimes/claude-cloud.ts` (`CloudRun` — connected through `AgentSession --cloud`, detached through `claude --cloud` in `script(1)` plus `claude -p --cloud <id>`); `RunSpec.cloud`, `capabilities.cloud`, `LoginState.cloud`, `RunEvents.cloud`; Claude's `login()` stopped calling an API key a subscription.

- 2026-09-26 · claude/self-checkout-harness-overview-cvpkyy · `AgentRun.backgroundTasks?()` — background agents still running, by description; read when a usage limit ends the run, since they die with its process. Claude Code implements it from `liveTasks`; Codex has none.

- 2026-09-26 · claude/self-checkout-harness-overview-cvpkyy · `AgentRunEvents.limit?(raw, retry?)` — the account's usage limit, raw (Claude Code's `rate_limit_info`, or a 429 `api_retry`); optional to emit, since a plan-meter runtime reports through `meter` and every runtime's failed turns are read for limit text.
- 2026-09-25 · claude/self-checkout-harness-overview-cvpkyy · `RuntimeCapabilities.messageIds` (Claude Code: true) and an optional `messageId` on `AgentRun.run`/`send`.
- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
- 2026-09-07 · task/S116g8 · dead-code sweep: `_resetSdkCache` (sdk.ts) and `_clearRuntimes` (runtime.ts) test hooks deleted — no test imported either; `RpcEvents` in jsonrpc.ts de-exported — zero references outside the module.
- 2026-09-24 · main · `cli-update.ts` added (version, staleness, the update button's updater); Claude's `detect()` reports the CLI version.
