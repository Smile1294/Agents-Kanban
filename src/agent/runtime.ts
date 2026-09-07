/** What an agent runtime is, and what the board needs from one.
 *
 * Until now this extension had exactly one way to run an agent: spawn the
 * Claude Code CLI through the Agent SDK. "Provider" meant *which backend stands
 * behind Claude Code*, selected by environment variables on that child process
 * — see `providers.ts`, and it is still exactly that.
 *
 * This file is the other axis. A **runtime** is the agent program itself: the
 * thing you sign into, that owns a transcript store, a permission model and a
 * tool loop. Claude Code is one. Codex is another. They are siblings, not
 * alternatives within one profile, and the distinction is not academic:
 *
 *   - A provider is *environment on a process we spawn*. Adding one is a row in
 *     a reducer.
 *   - A runtime is *a different process speaking a different protocol*, with
 *     its own login, its own model ids, its own on-disk history. Adding one is
 *     a file that implements this interface.
 *
 * ## Why an interface and not an `if`
 *
 * The second runtime is the one that proves the shape; the third is the one
 * that pays for it. Everything the board asks of a runtime is declared here, so
 * a new one is a self-contained module that either satisfies this contract or
 * fails to compile — rather than a search for every place `claude` was assumed.
 *
 * The rules from CLAUDE.md that this contract exists to keep honest, restated
 * because they are what the method signatures are actually for:
 *
 *  - **Never show a signal that cannot say "bad".** `detect()` returns a
 *    described failure, never a silent fallback: a runtime that is not
 *    installed, or not logged in, must be able to SAY so. Hence
 *    `RuntimeStatus.problem` and the four-case `LoginState`, not a boolean.
 *  - **A number the board shows must not depend on a process being alive.**
 *    Hence `history`: every runtime that persists transcripts exposes them, so
 *    context fill and spend survive a restart the same way Claude's do.
 *  - **The model list comes from the CLI, not from a table here.** Hence
 *    `models()` on the runtime rather than a constant per vendor, with the
 *    built-in list as a named fallback that the UI is required to disclose.
 *  - **Run the CLI on the machine, never a bundled binary.** Hence `detect()`
 *    taking a configured path and searching PATH, and never reaching into
 *    `node_modules`.
 */
import type { EventEmitter } from 'node:events'
import type { AgentState } from '../board/config.ts'
import type { AttachedImage } from './images.ts'
import type { ModelBook } from '../sessions/usage.ts'
import type { EffortLevel, ThinkingMode } from '../sessions/meta.ts'
import type { ProviderEnv, ProviderProfile } from './providers.ts'

/** Runtimes the board knows how to drive.
 *
 * A string union rather than a bare `string` so that a persisted session
 * carrying an id nothing serves any more is a parse failure we can name, not an
 * `undefined` dereference on the render path. See `parseRuntimeId`.
 */
export type RuntimeId = 'claude' | 'codex'

export const RUNTIME_IDS: readonly RuntimeId[] = ['claude', 'codex'] as const

/** The default for a session that does not say. Never inferred from what is
 *  installed: a board whose sessions silently changed agent because a CLI
 *  appeared on PATH would be unexplainable. */
export const DEFAULT_RUNTIME: RuntimeId = 'claude'

/**
 * Read a runtime id back out of storage or a webview message.
 *
 * Parsed, never cast — the same rule as `parseCachedChoices` and `parseProfiles`.
 * Session metadata outlives the extension version that wrote it, and this value
 * is read on the render path, where a bad one is a blank panel rather than an
 * error.
 */
export function parseRuntimeId(raw: unknown): RuntimeId | undefined {
  return typeof raw === 'string' && (RUNTIME_IDS as readonly string[]).includes(raw)
    ? (raw as RuntimeId)
    : undefined
}

// ---------------------------------------------------------------------------
// What a runtime can do
// ---------------------------------------------------------------------------

/**
 * Which of the board's controls this runtime can honour.
 *
 * Absent means "this runtime has no such concept", and the UI must then hide
 * the control rather than grey it out — the same rule the model picker already
 * follows for effort and thinking. A toggle that is visible and does nothing is
 * a control that cannot say no.
 */
export interface RuntimeCapabilities {
  /** Provider profiles apply. True for Claude Code, whose backend IS
   *  environment on the child process. False for Codex, which authenticates as
   *  itself against one service — pointing a `ProviderProfile` at it would be
   *  offering a setting that cannot take effect. */
  providerProfiles: boolean
  /** The runtime can be told to stop mid-turn and stay resumable. */
  interrupt: boolean
  /** Follow-up messages can be added to an in-flight turn. */
  steer: boolean
  /** Tool calls can be approved or denied interactively, so the board's
   *  permission prompts mean something. */
  approvals: boolean
  /** Images can ride inside a user message. */
  images: boolean
  /** Extended-thinking is a per-session switch (Claude). Codex reasoning is
   *  chosen through effort instead, so the toggle does not appear. */
  thinkingToggle: boolean
  /** The runtime persists transcripts we can read back when nothing is
   *  running. Gates whether `history` is expected to be present. */
  durableHistory: boolean
  /**
   * How this runtime can be handed the board's own tools.
   *
   * `inProcess` means it accepts a server OBJECT — the Agent SDK does, and we
   * are already in the process that owns the `SessionStore`, so there is no
   * transport at all. `stdio` means it accepts a COMMAND to spawn, and the same
   * tool definitions are served over a socket instead (`board-bridge.ts`).
   *
   * Declared here rather than inferred from the runtime's id so the manager
   * never has to know which is which by name — the property a third runtime
   * needs in order to be one file.
   */
  boardTools: 'inProcess' | 'stdio'
}

/** Where a runtime's executable was found, and what it says it is. */
export interface RuntimeLocation {
  /** Absolute path to the binary we will spawn. */
  command: string
  /** How it was found, for the settings page to explain itself. */
  source: 'setting' | 'path' | 'wellKnown'
  /** Version string as reported by the CLI, when it would tell us. */
  version?: string
}

/**
 * Whether the user is signed in, as the runtime itself reports it.
 *
 * Four cases because they have four different fixes — the same reasoning as
 * `checkEndpoint()`'s four gateway outcomes. A boolean would collapse "not
 * installed" and "installed but signed out" into one unactionable "no".
 */
export type LoginState =
  /** Signed in. `account` is whatever the runtime is willing to name — an email,
   *  a plan, an organisation. `via` distinguishes a subscription login from an
   *  API key, which is the difference between two BILLING METERS and therefore
   *  decides which meter the board may show. */
  | { kind: 'signedIn'; account?: string; plan?: string; via: 'subscription' | 'apiKey' | 'cloud' }
  /** Installed, reachable, and nobody is logged in. Name the command that fixes
   *  it — this string is shown as the action on the settings page. */
  | { kind: 'signedOut'; fix: string }
  /** We could not ask. The runtime is there but did not answer, so this is
   *  explicitly NOT "signed out": claiming a state we failed to read is the
   *  signal-that-cannot-say-bad failure in its purest form. */
  | { kind: 'unknown'; reason: string }
  /** The executable is not on this machine. */
  | { kind: 'notInstalled'; fix: string }

/** Everything the settings page shows for one runtime, gathered in one call. */
export interface RuntimeStatus {
  id: RuntimeId
  label: string
  location?: RuntimeLocation
  login: LoginState
  /** A sentence naming what is wrong, when something is. Never invented from
   *  silence: absent means "nothing to report", not "all well". */
  problem?: string
  /** When this snapshot was taken, so a stale readout can be shown as stale
   *  rather than as current. */
  at: number
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/**
 * One entry in the model picker, from whichever runtime serves it.
 *
 * This mirrors `ModelChoice` in `models.ts` — deliberately, because the picker
 * renders both and a second shape would mean a second set of capability gates
 * to forget. `supportsEffort` is ABSENT rather than false when a model has no
 * effort levels at all, and every consumer gates on `=== true`; Haiku 4.5 is
 * the case that made that necessary and Codex's `gpt-5.4-mini` is the next one.
 */
export interface RuntimeModel {
  /** Passed to the runtime verbatim. Never normalised here: `default` and
   *  `sonnet` are real things to hand Claude Code, and `gpt-5.5` is a real
   *  thing to hand Codex. Resolving them would second-guess the runtime's own
   *  resolution, which is per provider and can change without us. */
  id: string
  label: string
  /** Context window in tokens, when the runtime declares one. Drives the meter's
   *  denominator, so it is the same number the label is derived from. */
  contextWindow?: number
  /** Effort levels this model actually accepts, in the runtime's own order.
   *  Absent means the model has no effort concept and the picker hides it. */
  supportedEffort?: EffortLevel[]
  supportsFastMode?: boolean
  description?: string
}

/** Where a model list came from, so the picker can disclose a fallback.
 *
 * "Why is the model I use missing here?" must be answerable from the UI. When
 * the built-in list is in force the picker SAYS so — that rule is already load
 * bearing for Claude and applies identically to every runtime added later. */
export interface ModelCatalogue {
  models: RuntimeModel[]
  source: 'runtime' | 'cache' | 'builtin' | 'profile'
  /** Why we fell back, when we did. Shown verbatim. */
  note?: string
}

// ---------------------------------------------------------------------------
// The meter
// ---------------------------------------------------------------------------

/**
 * What a session has consumed, expressed the way its runtime can actually
 * justify.
 *
 * This is a union rather than a number because **dollars are not a universal
 * unit of agent spend**, and pretending otherwise is the exact failure this
 * project keeps legislating against. A Claude Code session priced against
 * published rates has a dollar figure it can defend. A Codex session on a
 * ChatGPT subscription does not — no request is billed, and the only real
 * quantity the service reports is how much of a rolling rate-limit window has
 * been used. Showing `$0.00` there would be a number that cannot say "bad";
 * showing `13% of 5h` is the number the indicator is derived from.
 *
 * `unknown` is a first-class case and must render as "—", never as zero.
 */
export type Meter =
  | {
      kind: 'usd'
      spentUsd: number
      /** False when a model with no published rate contributed, which makes the
       *  total a FLOOR. The board renders `≥ $1.23`. */
      priced: boolean
    }
  | {
      kind: 'plan'
      /** Plan name as the service states it — `plus`, `pro`, `team`. */
      plan?: string
      /** The tightest window in force, and how full it is. */
      usedPercent: number
      windowMinutes: number
      /** Unix seconds. The board shows "resets in 2h", which is the actionable
       *  half — a percentage with no reset time cannot be planned around. */
      resetsAt?: number
      /** A longer window running alongside the primary one, when reported. */
      secondary?: { usedPercent: number; windowMinutes: number; resetsAt?: number }
    }
  | { kind: 'unknown' }

/** The dollar meter for a session that has spent nothing yet, so callers do not
 *  have to spell the shape out. */
export const NO_SPEND: Meter = { kind: 'usd', spentUsd: 0, priced: true }

/**
 * Read a `Meter` back from an untyped boundary.
 *
 * Parsed, never cast — the same rule as `parseRuntimeId` and
 * `parseCachedChoices`, and for the same reason, except that here the untyped
 * boundary is an `EventEmitter` rather than storage. `EventEmitter.on()` is
 * untyped, so an emitter and its listener can disagree about a payload and tsc
 * sees nothing; that is not hypothetical, it is the bug this function exists
 * because of. `session.ts` emitted `done` with a bare `number` while
 * `codex.ts` emitted a `Meter`, the manager's listener declared
 * `costUsd?: number`, and `media/board.js` called `.toFixed(2)` on the
 * result — a throw inside `render()`, which is a silently blank panel, on the
 * first real Codex run.
 *
 * Returns `undefined` for anything it cannot read, which the caller must treat
 * as "no reading" and SAY SO. It deliberately does not fall back to
 * `{ kind: 'unknown' }`: that is a reading which reports that the runtime does
 * not know, and minting one here would turn a protocol fault into a number the
 * board displays as if it had been measured.
 */
export function parseMeter(raw: unknown): Meter | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const m = raw as Record<string, unknown>
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  if (m.kind === 'usd') {
    const spentUsd = num(m.spentUsd)
    // `priced` defaults to TRUE on absence, matching every producer here — but
    // an explicit `false` must survive, because it is what turns the readout
    // into a floor (`≥ $1.23`) instead of a total.
    return spentUsd === undefined ? undefined : { kind: 'usd', spentUsd, priced: m.priced !== false }
  }
  if (m.kind === 'plan') {
    const usedPercent = num(m.usedPercent)
    const windowMinutes = num(m.windowMinutes)
    if (usedPercent === undefined || windowMinutes === undefined) return undefined
    const secondary = m.secondary as Record<string, unknown> | undefined
    const sUsed = secondary ? num(secondary.usedPercent) : undefined
    const sWindow = secondary ? num(secondary.windowMinutes) : undefined
    return {
      kind: 'plan', usedPercent, windowMinutes,
      ...(typeof m.plan === 'string' ? { plan: m.plan } : {}),
      ...(num(m.resetsAt) !== undefined ? { resetsAt: num(m.resetsAt)! } : {}),
      ...(sUsed !== undefined && sWindow !== undefined
        ? {
            secondary: {
              usedPercent: sUsed, windowMinutes: sWindow,
              ...(num(secondary!.resetsAt) !== undefined ? { resetsAt: num(secondary!.resetsAt)! } : {}),
            },
          }
        : {}),
    }
  }
  if (m.kind === 'unknown') return { kind: 'unknown' }
  return undefined
}

// ---------------------------------------------------------------------------
// A run
// ---------------------------------------------------------------------------

/** A tool call waiting on the user. Runtime-agnostic: Claude's `canUseTool`
 *  round trip and Codex's `execCommandApproval` server→client request are the
 *  same event as far as the board is concerned. */
export interface RunPermissionRequest {
  id: string
  toolName: string
  input: Record<string, unknown>
  /** The runtime's own rendered sentence, when it provides one. */
  prompt?: string
}

/**
 * The events every runtime emits, whatever protocol it speaks underneath.
 *
 * This is `SessionEvents` from `session.ts` with two changes, and both are
 * about honesty rather than tidiness:
 *
 *  - `spend` becomes `meter`, carrying a `Meter`, because a subscription
 *    session has no dollars to report (see above).
 *  - `provider` may be absent for a runtime with no provider concept, rather
 *    than reporting a made-up one.
 */
export interface RunEvents {
  state: (s: AgentState) => void
  text: (chunk: string) => void
  partial: (text: string) => void
  thinking: (text: string) => void
  tool: (name: string, input: unknown) => void
  toolResult: (id: string, ok: boolean) => void
  queued: (texts: string[]) => void
  interrupted: () => void
  usage: (contextTokens: number, contextWindow: number | undefined) => void
  meter: (m: Meter) => void
  committed: () => void
  /**
   * A tool call is waiting on the user.
   *
   * NO `resolve` on the payload, and that is a correction. It was declared here
   * as `resolve(allow, reason)` while `AgentSession` shipped
   * `resolve(PermissionResult)` — two runtimes, two incompatible signatures on
   * one declared event, and `EventEmitter` cannot see the difference. Nothing
   * calls either one: both consumers answer through
   * `AgentRun.answerPermission(id, …)`, which is the single typed route and
   * the only one the webview can reach anyway, since a closure cannot cross a
   * `postMessage`. A contract that describes two different things is worse than
   * one that describes less.
   */
  permission: (req: RunPermissionRequest) => void
  sessionId: (id: string) => void
  provider: (resolved: string | undefined, label: string | undefined) => void
  flagWarning: (message: string) => void
  /**
   * The turn ended.
   *
   * Three arguments, and the split between the last two is the whole point.
   * `meter` is what the SESSION has consumed, in the unit its runtime can
   * justify — the final settle of the same figure the `meter` event publishes
   * as it goes. `turnUsd` is what THIS TURN cost in dollars, which is a
   * different claim at a different scope, and is **absent** for a runtime that
   * has no per-request price at all. Absent means "no such concept", as it does
   * for `RuntimeModel.supportedEffort` and every `RuntimeCapabilities` member.
   *
   * They were one argument, and that is exactly how they drifted: `session.ts`
   * put a bare `number` in the slot, `codex.ts` put a `Meter` in it, the
   * manager's listener declared `costUsd?: number`, and the webview called
   * `.toFixed(2)` on whatever arrived. `EventEmitter.on()` is untyped, so
   * nothing in the type system could see it. Both consumers now go through
   * `parseMeter()`, and `codex.test.ts` asserts the payload satisfies this
   * signature — a contract that is declared and unenforced is a contract that
   * will drift again.
   */
  done: (summary: string, meter?: Meter, turnUsd?: number) => void
  error: (message: string) => void
  /**
   * A turn ended with background agents still live, or a notification from one
   * still to be answered, so the run stays open. `on` names the live agents —
   * EMPTY when nothing is live and only a follow-up turn is due. Emitted once
   * per turn that waits; a runtime with no background-task concept never emits it.
   */
  waiting: (on: string[]) => void
}

/**
 * One live agent session, whatever runs it.
 *
 * `AgentManager` holds these and nothing else, so a runtime is swappable at
 * exactly this line. Every member here already exists on `AgentSession`, with
 * the meter change noted above — the interface was read off the working class
 * rather than designed ahead of it, so the Claude path keeps its behaviour and
 * the Codex path has a target that is known to be sufficient.
 */
export interface AgentRun extends EventEmitter {
  readonly taskId: string
  readonly runtime: RuntimeId
  readonly state: AgentState
  /** When the child last said anything at all. The board shows the AGE of this,
   *  because a spinner spins over a wedged process too. */
  readonly lastEvent: number
  /** The runtime's own id for this session, once it has assigned one. Claude
   *  calls it a session, Codex calls it a thread; both arrive moments after the
   *  run starts and both are the only handle for resume. */
  readonly sessionId: string | undefined
  readonly resolvedProvider: string | undefined
  readonly meter: Meter

  run(firstPrompt: string, images?: readonly AttachedImage[]): Promise<void>
  send(text: string, images?: readonly AttachedImage[]): void
  clearQueue(): number
  interrupt(): Promise<void>
  answerPermission(
    id: string,
    allow: boolean,
    reason?: string,
    selections?: Record<string, string[]>,
  ): boolean
  setPermissionMode(mode: PermissionMode): Promise<boolean>
  stop(): void
}

/**
 * The board's permission stances, named once so a runtime adapter maps its own
 * vocabulary to ours rather than the other way round. Codex says
 * `never`/`on-request` plus a sandbox policy; Claude says `bypassPermissions`
 * and friends. Neither vocabulary leaks into the board.
 *
 * These are exactly the Agent SDK's six, deliberately: the setting is already
 * `agentsKanban.permissionMode`, users already have it set, and narrowing the
 * union here would silently drop `dontAsk` and `auto` from working
 * installations. A runtime that has no equivalent for one of them maps it to
 * the nearest stance it does have, in ONE documented place — see
 * `codexPermissions()` — rather than every caller guessing.
 */
export type PermissionMode =
  | 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'

/** Everything needed to start one run, independent of who runs it. */
export interface RunSpec {
  taskId: string
  /** The WORKTREE. Never the workspace root — that is what makes parallel
   *  agents safe. */
  cwd: string
  permissionMode: PermissionMode
  /** Guidance appended to the runtime's own system prompt. */
  appendSystemPrompt?: string
  /** Resume a session this runtime previously created. */
  resume?: string
  /** Explicit executable path; detected when omitted. */
  executable?: string
  model?: string
  effort?: EffortLevel
  /** 'enabled' means OMIT the option and keep the model's adaptive default. */
  thinking?: ThinkingMode
  ultracode?: boolean
  fastMode?: boolean
  /** Extra environment for the child; merged over the update guards. */
  env?: Record<string, string>
  /** Variables to DROP from the inherited environment. See `agentEnv`. */
  envClear?: readonly string[]
  /** The provider profile this run was started under, for the reconciliation
   *  readout. Only meaningful when `capabilities.providerProfiles`. */
  provider?: ProviderProfile
  /**
   * What a custom endpoint's models cost and how big their windows are.
   *
   * Runtime-neutral because the QUESTION is — "what did this model cost?" — even
   * though only the runtimes that report token usage in dollars can answer it.
   * A runtime that meters differently (Codex reports how full a plan window is,
   * not a bill) ignores it, which is the same thing it does with `thinking`.
   *
   * It is on this interface rather than tucked inside the provider block for a
   * reason worth remembering: an object SPREAD into a typed argument does not
   * get excess-property checking, so a field that is not declared here is
   * dropped silently and compiles. That is how a price book can be threaded all
   * the way from settings to a session and price nothing.
   */
  modelBook?: ModelBook
  /** The board tools, as a runtime-neutral description. Claude gets them as an
   *  in-process SDK MCP server; Codex gets the same definitions over stdio.
   *  See `board-mcp.ts`. */
  boardTools?: BoardToolBridge
  log?: (message: string) => void
}

/**
 * How a runtime is given the board's own tools.
 *
 * The in-process MCP server the Agent SDK accepts is an Anthropic API. Codex
 * takes MCP servers as *commands to spawn*, so the same tool definitions have
 * to be reachable over stdio as well. Rather than writing the tools twice, this
 * carries the one set of definitions plus whichever transport the runtime can
 * use, and `board-mcp.ts` owns the bridge.
 */
export interface BoardToolBridge {
  /** Fully-qualified tool names to auto-allow. Derived from the definitions,
   *  never hand-written — a hand-copied list drifted once and left agents
   *  unable to move their own cards. */
  autoAllow: string[]
  /** The SDK's in-process server, for a runtime that can take one. */
  inProcess?: unknown
  /** A command that serves the same tools over stdio MCP, for one that cannot. */
  stdio?: { command: string; args: string[]; env?: Record<string, string> }
}

// ---------------------------------------------------------------------------
// The runtime itself
// ---------------------------------------------------------------------------

/**
 * One agent program the board can drive.
 *
 * Implementations live in `agent/runtimes/`. Everything here is allowed to be
 * slow and none of it may run on the render path: `getState()` runs ten times a
 * second while an agent streams, and `detect()` spawns a process.
 */
export interface AgentRuntime {
  readonly id: RuntimeId
  readonly label: string
  /** Whose program it is. Shown on the settings page so "Codex" is not mistaken
   *  for a model. */
  readonly vendor: string
  /** One line on the settings page: what signing into this gets you. */
  readonly blurb: string
  readonly capabilities: RuntimeCapabilities
  /** The install command to offer when it is not found. */
  readonly installHint: string

  /** Find the executable. Configured path → PATH → well-known locations, and
   *  never `node_modules`. Undefined means not installed. */
  detect(configured?: string): Promise<RuntimeLocation | undefined>

  /**
   * Ask the runtime who it thinks it is, IN THE ENVIRONMENT A SESSION WOULD GET.
   *
   * `env` is the active provider's patch, and passing it is the difference
   * between a true answer and a misleading one. Asked without it, Claude Code
   * reports the login it would use on its own — which the settings page showed
   * as *"Signed in as david@… (subscription)"* while every session the board
   * started was going to `api.deepseek.com` with a key from the keychain. The
   * subscription was real and entirely unused.
   *
   * A runtime with no provider concept ignores it. Must be able to say "signed
   * out" and must be able to say "I could not tell".
   */
  login(loc: RuntimeLocation, env?: ProviderEnv): Promise<LoginState>

  /** What this runtime can run right now. Cached by the caller, never called on
   *  the render or activation path. */
  models(loc: RuntimeLocation, env?: Record<string, string>): Promise<ModelCatalogue>

  /** The built-in list, used when discovery fails. Must never be empty: an
   *  empty picker reads as a broken extension when the real cause is being
   *  offline. */
  builtinModels(): RuntimeModel[]

  /** Start a session. */
  start(spec: RunSpec): AgentRun

  /** Read a finished session's transcript back off disk, so context fill and
   *  spend do not depend on a process being alive. Absent when the runtime
   *  keeps no durable history. */
  history?: RuntimeHistory
}

/** Reading a runtime's own on-disk session store. */
export interface RuntimeHistory {
  /** Sessions this runtime has for a directory, newest first. */
  list(dir: string): Promise<HistoricSession[]>
  /** One session's transcript, in the board's entry shape. */
  transcript(id: string): Promise<unknown[]>
  /** Context fill and spend for a session nothing is running. */
  usage(id: string): Promise<{ contextTokens: number; contextWindow?: number; meter: Meter }>
  /**
   * Remove a session from this runtime's own store. `false` means there was
   * nothing there; a real failure throws.
   *
   * OPTIONAL, and the optionality is the point — the same reasoning as the
   * deliberately absent `rename`. A runtime whose history we can read but not
   * write is a real thing, and `SessionStore.delete()` must be able to say
   * "this agent owns its own history" rather than report a success it did not
   * achieve. That false success is exactly what shipped: Claude Code's
   * `deleteSession` was called on Codex uuids, Claude Code's `getSessionInfo`
   * confirmed the id was absent from ITS store, and the board reported the card
   * deleted while the rollout sat untouched on disk.
   */
  delete?(id: string): Promise<boolean>
}

export interface HistoricSession {
  id: string
  title?: string
  cwd: string
  updatedAt: number
  model?: string
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const registry = new Map<RuntimeId, AgentRuntime>()

/** Register a runtime. Called once per implementation at module load. */
export function registerRuntime(rt: AgentRuntime): void {
  registry.set(rt.id, rt)
}

/**
 * Look one up.
 *
 * Returns undefined for an id nothing serves rather than falling back to the
 * default, because a session silently changing agent is worse than a session
 * that says it cannot start: the transcript, the model ids and the login all
 * belong to the runtime that was asked for. The caller decides what to say.
 */
export function getRuntime(id: RuntimeId): AgentRuntime | undefined {
  return registry.get(id)
}

/** Every registered runtime, in a stable order for the UI. */
export function allRuntimes(): AgentRuntime[] {
  return RUNTIME_IDS.map((id) => registry.get(id)).filter((r): r is AgentRuntime => !!r)
}

/** Test hook: drop registrations so a test can install a fake. */
export function _clearRuntimes(): void { registry.clear() }
