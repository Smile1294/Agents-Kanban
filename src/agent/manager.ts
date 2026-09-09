/** Owns the running agents: at most N at once, one worktree each.
 *
 * A subtlety the whole design turns on: Claude Code assigns the session id, and
 * we do not learn it until the `system/init` message arrives. So a run starts
 * life keyed by a local `runId` and adopts its real `sessionId` moments later.
 * The board shows it throughout — a starting agent with no card would look like
 * nothing happened.
 */
import { EventEmitter } from 'node:events'
import { loadSdk, type Options } from './sdk.ts'
import { prepareComposerWorktree, type WorktreeService } from '../git/worktree.ts'
import { normaliseTitle, resolveEffort, resolveThinking, type EffortLevel, type SessionMeta, type ThinkingMode } from '../sessions/meta.ts'
import { summariseTool, type Entry, type SessionStore } from '../sessions/store.ts'
import type { AgentState, BoardConfig } from '../board/config.ts'
import { type PermissionRequest } from './session.ts'
import type { AttachedImage } from './images.ts'
import {
  boardToolNames, createBoardServer, type BoardChange, type BoardNotice, type BoardToolContext,
  type ScheduleActOutcome, type ScheduleCreateOutcome,
} from './tools.ts'
import type { ProviderEnv, ProviderProfile } from './providers.ts'
import type { ModelBook } from '../sessions/usage.ts'
import {
  DEFAULT_RUNTIME, getRuntime, parseMeter, type AgentRun, type Meter, type RuntimeId,
} from './runtime.ts'
import { startBoardBridge, type BoardBridge } from './board-bridge.ts'
import type { Schedule, ScheduleDraft } from '../board/schedules.ts'
import {
  aimSentence, checkProposal, DEFAULT_ORCHESTRATION, policyFor,
  type DecompositionRecord, type OrchestrationLevel, type OrchestrationPolicy,
  type ProposalNote, MAX_STATED,
} from '../board/decomposition.ts'
import { knowledgeCheck, loadCodemap } from '../board/codemap.ts'
import {
  agentKeyOf, describeSpawnAgents, resolveRoute,
  type PieceRoute, type SpawnAgent, type SpawnCatalogue,
} from './routing.ts'

/** What a session runs on, per turn. The workspace default for a new session,
 *  and — through `LaunchOptions.chosen` — the per-run choice that outranks it. */
export interface RunSettings {
  model?: string
  effort?: EffortLevel
  thinking?: ThinkingMode
  /** Session flags. Offered only when the CLI says the model supports them —
   *  see `ultracodeFor` — because the request path validates nothing. */
  ultracode?: boolean
  fastMode?: boolean
}

export interface AgentDefaults extends RunSettings {
  /** How eagerly new sessions should split. Per session in the end; this is
   *  the workspace default behind the composer bar's per-card choice. */
  orchestration?: OrchestrationLevel
  /** Which agent program new sessions run on. Per session in the end — the
   *  whole point is that a Claude card and a Codex card sit on the same board
   *  and run at the same time — this is only the default for a session that
   *  does not say. */
  runtime?: RuntimeId
}

/**
 * Everything about a run that is decided when it is ASKED FOR, never when a
 * slot frees.
 *
 * `startRun()` read `this.opts.defaults` and `this.opts.provider` after two
 * awaits, `setDefaults()` and `setProvider()` replace that state wholesale, and
 * `drain()` launches a queued run minutes later. `MAX_SUBTASKS` (4) exceeds the
 * default concurrency (3), so **the fourth piece of a fan-out always drains
 * late** — which means routing by mutating manager state hands one task another
 * task's model, and a provider switch mid-fan-out runs half of it on a
 * different backend with a different bill.
 *
 * This is "a value captured before an `await` must be re-checked after it"
 * turned inside out: rather than re-reading, the answer is frozen once, in
 * `start()`, into the queue entry that already exists.
 *
 * Pure, so the resolution order is testable without launching anything. Note
 * `??` on the flags is only correct because their absent value is `undefined`
 * and never `false`: a run that switched ultracode OFF must stay off under a
 * workspace default that is on.
 */
export function launchSettings(opts: Pick<LaunchOptions, 'chosen'>, defaults: RunSettings): RunSettings {
  const chosen = opts.chosen ?? {}
  return {
    ...(chosen.model ?? defaults.model ? { model: chosen.model ?? defaults.model } : {}),
    ...(chosen.effort ?? defaults.effort ? { effort: chosen.effort ?? defaults.effort } : {}),
    ...(chosen.thinking ?? defaults.thinking ? { thinking: chosen.thinking ?? defaults.thinking } : {}),
    ...(chosen.ultracode ?? defaults.ultracode) !== undefined
      ? { ultracode: chosen.ultracode ?? defaults.ultracode } : {},
    ...(chosen.fastMode ?? defaults.fastMode) !== undefined
      ? { fastMode: chosen.fastMode ?? defaults.fastMode } : {},
  }
}

export interface ManagerOptions {
  store: SessionStore
  worktrees: WorktreeService
  board: BoardConfig
  defaults: AgentDefaults
  /** All six the SDK accepts. It used to list four, and only compiled because
   *  extension.ts cast every value to 'acceptEdits' — a type that was a lie
   *  about values that were real at runtime. */
  permissionMode: NonNullable<Options['permissionMode']>
  maxConcurrent: number
  claudeExecutable?: string
  /** Explicit path to the `codex` binary; detected when omitted. */
  codexExecutable?: string
  /**
   * Where a runtime that cannot take an in-process MCP server gets the board's
   * tools from: a directory to put its socket in, and the bundled server script
   * to spawn. Absent means such a runtime runs WITHOUT board tools, which the
   * launch says out loud rather than leaving the agent to discover that it
   * cannot move its own card.
   */
  boardBridge?: { dir: string; script: string }
  /** Which backend sessions run against. Mutable through `setProvider()`,
   *  because the picker changes it between runs and the manager outlives them.
   *  Undefined means "inherit the environment", which is the default. */
  provider?: ProviderProfile
  /** The environment patch that profile amounts to, already resolved against
   *  SecretStorage. Kept beside the profile rather than derived here, so this
   *  file never touches a credential and `providers.ts` stays the only place
   *  that knows a variable name. */
  providerEnv?: ProviderEnv
  /** Prices and windows for models the built-in tables cannot know — what a
   *  custom endpoint published about itself. Handed to every session so the
   *  live spend figure uses the same arithmetic as the one totalled from the
   *  transcript after the run ends. */
  modelBook?: ModelBook
  /**
   * Ask the user before fanning a card out into N billed agents.
   *
   * The boundary in CODE for `split_task`, which had only a boundary in a
   * permission list — and that list is not consulted under `dontAsk` or
   * `bypassPermissions`, and is not read by the Codex adapter at all. Awaited
   * inside `split()` after the structural refusals and before the first
   * `start()`; a `false` refuses the split with a message the agent can act on.
   *
   * Optional so the manager stays unit-testable without an editor. Absent means
   * no host-side gate, which is the pre-existing behaviour and is why
   * `smoke.mjs` asserts the real host supplies one.
   */
  confirmSplit?: (
    parent: RunningAgent,
    /** RESOLVED, not as proposed: the dialog names the agent, backend and model
     *  each piece will actually run on. A modal that showed the raw ask would
     *  be asking the user to approve a plan and describing a different one. */
    subtasks: readonly RoutedSubtask[],
    reason: string,
    /** Declared scopes two pieces share. Shown, never refused on: a prediction
     *  is not a contract, and refusing here would teach the model to
     *  under-declare — which destroys the only signal that can later say the
     *  split was wrong. */
    notes: readonly ProposalNote[],
  ) => Promise<boolean>
  /**
   * WHAT A SPAWNED SESSION MAY RUN ON: every agent program × backend
   * combination on offer, each with the models the user has left ticked.
   *
   * Read FRESH at split time, because the policy can change between sessions
   * while a tool description baked at launch is only ever policy. `split()` is
   * the ONE place it is enforced — the description names the allowed set, this
   * is the fence.
   *
   * It replaced a flat `() => string[]` of the ACTIVE backend's models, and the
   * flatness was the bug: a piece routed to another backend had its model id
   * checked against the wrong catalogue, so `deepseek-reasoner` passed a gate
   * built from Anthropic's list and the child 404'd on its first request with
   * somebody else's error message.
   *
   * Absent (unit tests, a host too old to supply it) means no gate, which is
   * the pre-existing behaviour and is why `smoke.mjs` asserts the real host
   * supplies one.
   */
  spawnCatalogue?: () => SpawnCatalogue
  /**
   * Turn a backend profile id into the environment patch it amounts to.
   *
   * Host-side because it reads `SecretStorage`, and this file never touches a
   * credential — the same division `providerEnv` already has. Called once per
   * routed child, before it launches, so a subtask on another backend gets
   * that backend's environment rather than the workspace's active one.
   *
   * Absent means children inherit the active profile exactly as they used to,
   * which is the behaviour every unit test here expects.
   */
  resolveProvider?: (profileId: string) => Promise<LaunchOptions['providerFor']>
  /**
   * The board's scheduled runs, behind callbacks into the host.
   *
   * The schedule store is host state, and firing one is starting the CLI —
   * both only the host can do. The manager is the crossing point because the
   * tools are built per session and the host's callbacks are bound once:
   * `boardContext()` supplies the four callbacks, and stamps `createdBy` with
   * the card title of the session that asked, so the settings page can mark a
   * schedule as an agent's. Absent (unit tests, a host too old) means the
   * schedule tools answer "not available", never invent a store.
   */
  schedules?: {
    list: () => Promise<Schedule[]> | Schedule[]
    create: (draft: ScheduleDraft, createdBy: string) => Promise<ScheduleCreateOutcome>
    remove: (id: string) => Promise<ScheduleActOutcome>
    run: (id: string) => Promise<ScheduleActOutcome>
  }
  /** Passed to every session, for diagnostics the user cannot act on. */
  log?: (message: string) => void
}

/**
 * Follow a card whose key changed underneath the selection.
 *
 * A card is keyed by its run id until Claude Code assigns a session id, and by
 * the session id from then on. That swap happens seconds into the first turn —
 * so the chat you are looking at, opened on the run id, stops matching any card
 * mid-sentence. The board then cleared the selection and fell back to the
 * new-session screen, which reads exactly like "it closed my chat and started a
 * new one", and is what the user reported.
 *
 * Pure, and separate from the manager, so the swap can be tested without
 * starting an agent.
 */
export function followKey(
  selected: string | undefined,
  cardKeys: readonly string[],
  sessionIdFor: (key: string) => string | undefined,
): string | undefined {
  if (!selected) return undefined
  if (cardKeys.includes(selected)) return selected
  const moved = sessionIdFor(selected)
  return moved && cardKeys.includes(moved) ? moved : undefined
}

/**
 * The sidecar entry written the moment a session becomes durable.
 *
 * Pure, and separate from `launch()`, because the fields in here are the ones
 * that have to SURVIVE — and this project has shipped a bug at both ends of
 * that. `contextWindow` was written by every run and missing from the reader.
 * `runtime` was the mirror image and worse: parsed from the day it was added,
 * written by nothing, so `store.runtimeOf()` answered `undefined` for every
 * session and every finished Codex transcript, usage figure and meter was
 * routed to the CLAUDE parser — a different store, a different format, an empty
 * result. Neither was visible from inside a unit test, because nothing built
 * this object anywhere a test could see it.
 *
 * `running` is `startedAt` and not a boolean for the reason in `SessionMeta`:
 * this is the moment a run becomes resumable, so a mark still here at startup
 * means the host went away mid-turn.
 */
export function durablePatch(a: {
  startedPhase?: string
  runtime: RuntimeId
  worktree: { path: string; branch: string; base?: string }
  startedAt: number
  parent?: string
  /**
   * WHAT THIS RUN IS ACTUALLY ON: the backend profile, the model, and the two
   * per-turn dials.
   *
   * `runtime` was recorded here from the start and the rest were not, so the
   * composer had nothing to read and fell back to the workspace default — open
   * a session that has been running on `deepseek-v4-pro` all morning and the
   * bar said Claude Code, Opus. The fields existed on `SessionMeta` and were
   * parsed on the way back; nothing had ever written them. A field with no
   * writer is the mirror of the one this project has a postmortem about, and it
   * fails the same way: silently, on the render path.
   */
  provider?: string
  model?: string
  effort?: EffortLevel
  thinking?: ThinkingMode
}): Partial<SessionMeta> {
  return {
    phase: a.startedPhase ?? 'implementing',
    runtime: a.runtime,
    worktree: a.worktree.path,
    branch: a.worktree.branch,
    running: a.startedAt,
    ...(a.worktree.base ? { base: a.worktree.base } : {}),
    ...(a.parent ? { parent: a.parent } : {}),
    ...(a.provider ? { provider: a.provider } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.effort ? { effort: a.effort } : {}),
    ...(a.thinking ? { thinking: a.thinking } : {}),
    // The launch IS the moment a pending backend switch happens: the session is
    // now on the new backend, so the "it will re-read everything" warning has
    // nothing left to warn about. `null` is the clear sentinel — see `normalise()`.
    switchedFrom: null,
  }
}

/**
 * How many subtasks one session may split itself into.
 *
 * A boundary, not a preference. Every subtask is a real Claude Code process
 * with a real bill, started without anyone typing anything — so the number an
 * agent can conjure has to be a number in code. Two is the case this exists
 * for ("these are two unrelated things"); four is generous for the rest.
 */
export const MAX_SUBTASKS = 4

/** What an agent proposes when it splits a task up. */
export interface SubtaskSpec {
  title: string
  prompt: string
  /** The files this piece said it would touch. Carried to the child so the
   *  board can compare it against what actually changed. */
  scope?: string[]
  tags?: string[]
  /**
   * The model this subtask asks to run on — the per-piece half of the routing
   * reserved for routing. Gated in `split()` before anyone is asked to approve
   * anything; absent means the child runs on the default for new sessions.
   */
  model?: string
  /**
   * WHICH AGENT PROGRAM AND BACKEND this piece asks for: a `<runtime>|<profile>`
   * slug from the tool description. Absent means the parent's whole agent —
   * runtime AND backend, which is the half that used to be dropped.
   */
  agent?: string
  /** The effort level this piece asks for. Raw, because the model wrote it, and
   *  refused rather than dropped when the target model cannot take it. */
  effort?: string
}

/** A piece whose routing has been resolved and checked. What the approval
 *  dialog is shown, so the modal names the agent, backend and model that will
 *  actually be started rather than repeating the workspace default back. */
export interface RoutedSubtask extends SubtaskSpec {
  route: PieceRoute
}

export type SplitResult =
  | { ok: true; started: { key: string; title: string; branch: string }[] }
  | { ok: false; message: string }

export interface LaunchOptions {
  /**
   * WHAT THIS RUN IS ON, resolved once — by `start()`, at the moment it was
   * asked for, not by `launch()` when a slot frees. See `launchSettings()`.
   *
   * A resumed session keeps ITS model, effort and thinking, not the workspace
   * default — otherwise picking a model on a card is a control that reverts the
   * moment the card is reopened, and resuming a DeepSeek session on a day when
   * the default is Opus would move it to a backend's model it has never used.
   * A SPLIT child keeps the route its parent proposed for it, for the stronger
   * version of the same reason: the fourth piece of a fan-out always drains
   * late, so a route read at launch is a route another piece may have replaced.
   *
   * Resolved in one place so the values recorded on the card and the values
   * handed to the runtime cannot disagree.
   */
  chosen?: RunSettings
  /** Resume a Claude Code session (and reuse its worktree). */
  resume?: string
  title?: string
  /** The session this run was split out of. */
  parent?: string
  /** Per-run override of how eagerly to split. Captured at ENQUEUE, like every
   *  other per-run choice, so a queued run keeps the level it was started
   *  with rather than whatever the picker says when its slot frees. */
  orchestration?: OrchestrationLevel
  /** Fork the worktree from this branch instead of the repo's current one. */
  base?: string
  /** Images attached to the FIRST message. Held only until the run starts —
   *  they ride inside the message to the model and are stored nowhere. */
  images?: AttachedImage[]
  /** Which agent program to run this session on. Falls back to the workspace
   *  default. A resumed session keeps whatever it was started on, because its
   *  transcript belongs to that runtime and nothing else can read it. */
  runtime?: RuntimeId
  /**
   * The backend a RESUMED session launches on, resolved by the HOST from the
   * session's own recorded profile.
   *
   * A new session starts on the active profile (`this.opts.providerEnv`). A
   * resumed one starts on ITS OWN — a session switched from OpenRouter to
   * Anthropic must come back on Anthropic, not on whatever profile is active
   * the day it resumes. Absent means "use the active one", which is also the
   * right answer for a session that never recorded a provider.
   */
  providerFor?: { profile: ProviderProfile; env: ProviderEnv }
}

export interface RunningAgent {
  runId: string
  /** Which agent program is running this. Fixed for the life of the session:
   *  the transcript, the model ids and the login all belong to it. */
  runtime: RuntimeId
  /**
   * WHICH BACKEND it is on: the provider profile id, `''` for a runtime that
   * signs in as itself.
   *
   * Beside `runtime` because the two together are what a session runs on, and
   * carrying only one of them is what let `split()` hand every child the
   * parent's agent PROGRAM and the workspace's active BACKEND. `providerLabel`
   * below is a different thing — what the CLI said it resolved to, which can
   * disagree with this and is drawn as an amber note when it does.
   */
  provider?: string
  /** Set once the runtime assigns one. Until then the card is keyed by runId. */
  sessionId?: string
  title: string
  state: AgentState
  worktreePath: string
  branch: string
  /** The branch the worktree forked from, for the review panel's diff and merge. */
  base?: string
  /** Whether the worktree carries a `docs/codemap/`. The knowledge-file rule is
   *  stated in the brief and the tool description only where it applies. */
  knowledgeFiles?: boolean
  /** The level this run LAUNCHED under. What the brief said, and therefore what
   *  the split gate must read — not whatever the picker says a turn later. */
  /** The model this run was started on. Carried onto every live text block so
   *  the transcript names who is speaking — it said "Claude Agent" over answers
   *  written by `deepseek-v4-pro`. */
  model?: string
  orchestration?: OrchestrationLevel
  /** The session this one was split out of, if it is a subtask. */
  parent?: string
  /** Entries produced by THIS run, appended live. Past runs come from disk. */
  live: Entry[]
  /**
   * The on-disk transcript as it stood when this run began — the history the
   * chat view shows above the live entries.
   *
   * Held rather than re-read. Claude Code writes this run into the SAME
   * transcript as it goes, so the prefix that counts as history is fixed the
   * moment the run starts and can never change again; re-reading it produced
   * an identical answer every time. It was being re-read on every streamed
   * token, at 10ms a time on a session with a few big MCP results in it.
   */
  history: Entry[]
  /** The text block currently streaming, if any. */
  streaming?: string
  /** Follow-ups typed while this turn is still running. */
  queued?: string[]
  contextTokens: number
  contextWindow?: number
  costUsd?: number
  /** What the session had spent before this run started — read from its
   *  transcript at launch, since the turns it covers were billed to a process
   *  that no longer exists. Zero for a session starting fresh. */
  priorUsd: number
  /** What this session has spent in total: `priorUsd` plus this run. Climbs
   *  during a turn; `costUsd` above is the CLI's figure for the LAST turn. */
  spentUsd?: number
  /** False when a model with no published rate contributed, so `spentUsd` is a
   *  floor. The board says "at least" rather than showing a total it knows is
   *  short. */
  spendPriced?: boolean
  /**
   * What this session has consumed, in the unit its runtime can justify.
   *
   * Beside `spentUsd` rather than replacing it, because they are not the same
   * claim. `spentUsd` is dollars and only a runtime that prices per request has
   * any. A Codex session on a ChatGPT subscription has no per-request price at
   * all, so its meter is a percentage of a rolling rate-limit window — and
   * rendering that as `$0.00` would be a number that cannot say "bad". See
   * `Meter` in runtime.ts.
   */
  meter?: Meter
  /** The request on screen. The head of `pendingPermissions`. */
  pendingPermission?: PermissionRequest
  /**
   * Every request waiting on the user, oldest first.
   *
   * A single slot lost all but the last one: a turn can issue several tool
   * calls at once, and both runtimes hold a Map of outstanding requests. When a
   * second arrived it overwrote the first, which then had no surface able to
   * answer it — `answerPermission` needs an id, and the webview's state no
   * longer carried it — so the CLI stayed blocked and the card said "working".
   */
  pendingPermissions?: PermissionRequest[]
  startedAt: number
  /** When the CLI last emitted anything. The board renders its age, which is
   *  the difference between telling the user it is working and letting them
   *  see that it is. */
  lastEventAt?: number
  /** The backend the CLI reported it is ACTUALLY on, once it has said.
   *
   *  Never the profile we asked for. The board shows this, so a profile that was
   *  outranked by a managed settings file reads as the provider actually billing
   *  the tokens rather than the one we requested. Undefined until the control
   *  round trip lands, and on a CLI too old to answer it. */
  resolvedProvider?: string
  /** Human label for `resolvedProvider`. */
  providerLabel?: string
  /** True once the AGENT named this card, rather than `titleFrom()` guessing
   *  from the prompt. It is what stops `set_phase` asking for a name a second
   *  time, and what keeps the ask off a title somebody chose on purpose. */
  titleChosen?: boolean
}

export class AgentManager extends EventEmitter {
  private opts: ManagerOptions
  /** Keyed by run id. `AgentRun`, not `AgentSession`: the manager drives every
   *  runtime through the one contract, which is the line a new agent program is
   *  added at. */
  private readonly sessions = new Map<string, AgentRun>()
  /** Board-tool bridges, one per Codex-like session, torn down with the run. */
  private readonly bridges = new Map<string, BoardBridge>()
  private readonly agents = new Map<string, RunningAgent>()
  private readonly queue: Array<{ runId: string; prompt: string; opts: LaunchOptions }> = []
  private counter = 0

  constructor(opts: ManagerOptions) {
    super()
    this.opts = opts
  }

  list(): RunningAgent[] { return [...this.agents.values()] }

  /** Picker changes apply to the next run; a running session keeps its settings. */
  /**
   * Change some of the defaults new sessions start with.
   *
   * A PATCH, and it has to be. This was `this.opts.defaults = d` — a wholesale
   * replacement of an object whose every member is optional, so a caller that
   * did not mention a field silently erased it, with no type error to say so.
   *
   * Two of the five callers omitted `runtime`, and one of them is
   * `ensureManager()`, which runs immediately before `mgr.start()` in
   * `newSession`. So it erased whatever the composer chip and the settings page
   * had just set, `launch()` fell through to `DEFAULT_RUNTIME`, and **every new
   * session ran on Claude Code** however the board was configured — while the
   * composer chip, the settings page and `agentsKanban.runtime` all reported a
   * choice that could never take effect. The second runtime was unreachable
   * for new sessions.
   *
   * Omission now means "leave it alone", which is what all five callers
   * actually meant. Clearing a field is still possible and now has to be said
   * out loud, by passing it explicitly as `undefined`.
   */
  setDefaults(d: Partial<ManagerOptions['defaults']>): void {
    this.opts.defaults = { ...this.opts.defaults, ...d }
  }

  /** Switch which backend the NEXT session runs against.
   *
   *  Deliberately not applied to running agents. A provider is chosen when the
   *  CLI process starts — it is environment on that process — so there is no
   *  honest way to move a live run to a different backend, and pretending
   *  otherwise would show a card claiming a provider it is not on. `setDefaults`
   *  can be loose about this because a model change genuinely does take effect
   *  next turn; this cannot. */
  setProvider(provider: ProviderProfile | undefined, env: ProviderEnv | undefined): void {
    if (provider) this.opts.provider = provider
    else delete this.opts.provider
    if (env) this.opts.providerEnv = env
    else delete this.opts.providerEnv
  }

  /**
   * What a custom endpoint's models cost, for runs started from now on.
   *
   * Next run only, like the provider, and for a related reason: the book is
   * read at session construction and a live run is already pricing its turns
   * with the one it was given. In practice there is no gap — the book is built
   * from cached catalogues at activation, before any run can start — and the
   * one case that remains, refreshing a catalogue while an agent is mid-turn,
   * settles itself: the card's figure is re-totalled from the transcript when
   * the run ends, through `SessionStore`, which holds the SAME book. Until then
   * it reads `≥`, which is what "we cannot price this" is supposed to say.
   */
  setModelBook(book: ModelBook): void {
    this.opts.modelBook = book
  }

  /** Find a live run by either key — the UI may hold whichever it saw first. */
  byKey(key: string): RunningAgent | undefined {
    return this.agents.get(key) ?? [...this.agents.values()].find((a) => a.sessionId === key)
  }

  /**
   * How many runs are occupying a concurrency slot.
   *
   * `launching` is counted alongside the registered agents, and that is the
   * whole fix for a limit the code did not hold. `launch()` does not put its
   * agent into `this.agents` until AFTER `worktrees.create()` — a real
   * `git worktree add` behind the repo lock, tens to hundreds of milliseconds —
   * so for that whole window the launching run was invisible here.
   *
   * And a completion fires TWO drains: the `state` listener drains on `done`,
   * then `finish()` drains again, because both runtimes call `setState` before
   * they emit `done`. The first drain suspended inside `launch()`, the second
   * saw an unchanged count and shifted another entry off the queue. Measured
   * with `maxConcurrent: 1`: three agents, two active, three worktrees created.
   * The excess scales with simultaneous completions, so it could empty the
   * queue rather than overshoot by one.
   */
  get activeCount(): number {
    return this.launching.size + [...this.agents.values()].filter(
      (a) => ['working', 'starting', 'needsInput', 'waiting'].includes(a.state.kind),
    ).length
  }

  private touch(): void { this.emit('change') }

  /** Runs that have been shifted off the queue and are inside `launch()`, but
   *  have not registered an agent yet. They hold a concurrency slot — see
   *  `activeCount`. */
  private readonly launching = new Set<string>()

  /** This manager is being torn down. Latched, never cleared. */
  private stopped = false

  /**
   * Start a new session from a prompt. Returns the local run id immediately.
   *
   * Everything about WHAT IT RUNS ON is frozen here, before the concurrency
   * check, so a run that waits in the queue launches on what was chosen when it
   * was asked for. See `launchSettings()` for the failure that fixes.
   */
  async start(prompt: string, opts: LaunchOptions = {}): Promise<string> {
    const runId = `run-${++this.counter}-${Date.now().toString(36)}`
    opts = {
      ...opts,
      chosen: launchSettings(opts, this.opts.defaults),
      orchestration: opts.orchestration ?? this.opts.defaults.orchestration ?? DEFAULT_ORCHESTRATION,
      runtime: opts.runtime ?? this.opts.defaults.runtime ?? DEFAULT_RUNTIME,
      // The BACKEND, frozen with the rest. A resumed session already brings its
      // own and a routed subtask brings the one its route named; anything else
      // takes the profile that was active at this moment, rather than whichever
      // one is active when a slot frees.
      ...(opts.providerFor || !this.opts.provider
        || !getRuntime(opts.runtime ?? this.opts.defaults.runtime ?? DEFAULT_RUNTIME)
             ?.capabilities.providerProfiles
        ? {}
        : { providerFor: { profile: this.opts.provider, env: this.opts.providerEnv ?? { set: {}, clear: [] } } }),
    }
    if (this.activeCount >= this.opts.maxConcurrent) {
      this.queue.push({ runId, prompt, opts })
      /* A queued run gets a CARD, and that is the whole fix for two separate
         reported failures.
         `start()` used to return the run id without registering anything, so
         `list()` omitted it and `byKey()` missed it — `followKey()` then failed
         both of its tests, `getState()` cleared the selection, and a user who
         pressed send on a full board was returned to the new-session screen
         with their prompt gone and no card anywhere to say it had been
         accepted. It is the same absence that makes a subtask "invisible until
         it starts", which DECISIONS.md lists as open.
         No worktree and no branch: it has neither yet, and inventing one would
         be a path the review panel could try to open. `launch()` fills them in. */
      this.agents.set(runId, {
        runId,
        runtime: opts.runtime ?? DEFAULT_RUNTIME,
        title: opts.title ?? titleFrom(prompt),
        state: { kind: 'queued', since: Date.now() },
        worktreePath: '', branch: '',
        live: [{ kind: 'prompt', at: Date.now(), text: prompt }],
        history: [], contextTokens: 0, priorUsd: 0, startedAt: Date.now(),
        ...(opts.parent ? { parent: opts.parent } : {}),
        // A queued card already knows its backend, so the composer describes
        // the session rather than the workspace while it waits — and `split()`
        // can read a queued parent's whole agent.
        ...(opts.providerFor ? { provider: opts.providerFor.profile.id } : {}),
      })
      this.touch()
      return runId
    }
    await this.launch(runId, prompt, opts)
    return runId
  }


  /**
   * Split this session's work into subtasks, each its own agent.
   *
   * ## Why the branches look like this
   *
   * A subtask forks from what the PARENT forked from — normally the repo's
   * current branch — and never from the parent's own branch. That is only
   * sound because of the check below: a session may not split once it has
   * changed anything, so its branch is provably identical to its base and there
   * is nothing to inherit. The payoff is that a subtask is an ORDINARY task
   * branch: it diffs against base, merges back through the same path, and is
   * cleaned up by the same code. Nothing in the review, merge or worktree
   * layers has to learn what a subtask is.
   *
   * The alternative — children forked from an integration branch held by the
   * parent — was rejected for a concrete reason, not a stylistic one:
   * `merge()` runs `git merge` in the MAIN worktree and requires it to be on
   * the target branch, and git will not let the main worktree check out a
   * branch another worktree already holds. Merging into the parent's branch
   * would have meant merging inside the parent's checkout, a second merge path
   * with its own dirty-tree and conflict semantics, for a payoff that only
   * exists when the pieces are related — and "unrelated" is the condition that
   * triggers a split in the first place.
   *
   * ## The boundaries, all in code
   *
   * The tool description tells the agent when to split. These decide whether it
   * can: at most MAX_SUBTASKS, one level deep, once per session, and never
   * after the parent has touched the tree.
   */
  async split(parentKey: string, subtasks: SubtaskSpec[], reason = ''): Promise<SplitResult> {
    const parent = this.byKey(parentKey)
    if (!parent) return { ok: false, message: 'This session is not running, so it cannot start subtasks.' }

    // One level. A subtask that can split again is a fork bomb with a credit
    // card, and nothing on the board could render the third level anyway.
    const card = await this.opts.store.card(parentKey)
    if (card.parent) {
      return {
        ok: false,
        message: 'This session is itself a subtask, and subtasks do not split again. ' +
          'Do the work, or say what is blocking with notify_user.',
      }
    }
    const already = await this.opts.store.childrenOf(parentKey)
    if (already.length) {
      return {
        ok: false,
        message: `This session has already been split into ${already.length} subtasks. ` +
          'They are running; wait for them rather than starting more.',
      }
    }

    // The check the branch model rests on. A parent that has already written
    // something would strand it: its subtasks fork from base, so its work would
    // sit on a branch nothing merges and nobody looks at again.
    if (!(await this.opts.worktrees.isClean(parent.worktreePath))) {
      return {
        ok: false,
        message: 'There are uncommitted changes in this worktree, and subtasks fork from the ' +
          'branch this session started from — so that work would be left behind on a branch ' +
          'nothing merges. Split BEFORE you start changing code, or finish this yourself.',
      }
    }
    if (parent.base && (await this.opts.worktrees.aheadOf(parent.worktreePath, parent.base)) > 0) {
      return {
        ok: false,
        message: 'This branch already has commits on it, and subtasks fork from the branch this ' +
          'session started from — so those commits would be left behind. Finish this work ' +
          'yourself rather than splitting it now.',
      }
    }


    /* Now the PROPOSAL itself, against the level this session's brief was
       written with. The structural refusals above ran first and unconditionally
       — a dirty parent cannot split however good the proposal is — and none of
       them reads the level.
       `checkProposal` does not read `level` either: it gets a ceiling. That is
       what makes "a huge task still splits at Minimal" an invariant rather than
       a preference, and `decomposition.test.ts` asserts it by running the same
       proposal through two policies that differ only in their level. */
    const level = parent.orchestration ?? this.opts.defaults.orchestration ?? DEFAULT_ORCHESTRATION
    const policy = policyFor(level)
    const verdict = checkProposal(subtasks, policy, MAX_SUBTASKS)
    if (!verdict.ok) {
      // RECORDED, not just returned. A refusal used to reach the model and
      // nothing else, so a session that tried to split, was refused, and did
      // the work alone was byte-identical on the board to the correct adaptive
      // outcome — the feature working and the feature broken rendering the
      // same, on a feature whose whole principle is adaptivity.
      await this.recordDecomposition(parentKey, {
        at: Date.now(), level, outcome: 'refused',
        requested: subtasks.length, rule: verdict.rule,
        ...(reason.trim() ? { stated: reason.trim().slice(0, MAX_STATED) } : {}),
      })
      return { ok: false, message: verdict.message }
    }
    /* WHERE EACH PIECE RUNS, resolved and checked HERE: after the proposal is
       known to be structurally sound, and before the user is asked to approve
       it — a modal should never ask about a plan the host already knows it will
       refuse. The tool description names the allowed agents and models, but a
       description is policy; this is the fence, and the only one.

       The parent's WHOLE agent is the default for a piece that names none —
       runtime AND backend. Passing only the runtime is what made a DeepSeek
       objective fan out into children on whatever profile happened to be
       active: a different backend, different model ids, a different bill, and
       nothing on the board saying so. See `routing.ts`.

       Read FRESH, because the policy can change between sessions while a tool
       description baked at launch is only ever policy. */
    const parentRoute = { runtime: parent.runtime, provider: parent.provider ?? '' }
    const catalogue = this.opts.spawnCatalogue?.()
    const specs: RoutedSubtask[] = []
    for (const p of verdict.pieces) {
      const routed = resolveRoute(
        {
          ...(p.agent ? { agent: p.agent } : {}),
          ...(p.model ? { model: p.model } : {}),
          ...(p.effort ? { effort: p.effort } : {}),
        },
        parentRoute,
        catalogue,
        this.opts.defaults.model,
      )
      if (!routed.ok) {
        // RECORDED like every other refusal: a session that tried to route, was
        // refused, and did the work alone must not be byte-identical on the
        // board to the correct adaptive outcome. Each rule is separate because
        // each has a different fix.
        await this.recordDecomposition(parentKey, {
          at: Date.now(), level, outcome: 'refused',
          requested: subtasks.length, rule: routed.rule,
          ...(reason.trim() ? { stated: reason.trim().slice(0, MAX_STATED) } : {}),
        })
        return { ok: false, message: `"${p.title}" cannot be routed. ${routed.message}` }
      }
      specs.push({
        title: p.title,
        prompt: p.prompt,
        ...(p.scope?.length ? { scope: p.scope } : {}),
        ...(p.tags?.length ? { tags: p.tags } : {}),
        ...(p.model ? { model: p.model } : {}),
        ...(p.agent ? { agent: p.agent } : {}),
        ...(p.effort ? { effort: p.effort } : {}),
        route: routed.route,
      })
    }

    // The real approval gate, and it has to be here.
    //
    // `ASKS_FIRST` is not a boundary. It is enforced two ways and BOTH have a
    // hole: on Claude it routes through `canUseTool`, which `session.ts` skips
    // under `dontAsk` and `bypassPermissions`; and on Codex it is filtered out
    // of `autoAllow` — a list `codex.ts` never reads, because Codex surfaces
    // approvals only for `execCommandApproval` and `applyPatchApproval` while an
    // MCP call arrives as a notification. So a card could fan out four billed
    // agents with no click at all, in three of the configurations a user who
    // wants a self-driving board would actually choose.
    //
    // This runs in the HOST, after the structural refusals (a dirty parent
    // cannot split however good the proposal) and before the first `start()`.
    // `ASKS_FIRST` stays as the soft layer — the rule is "both, always".
    if (this.opts.confirmSplit && !(await this.opts.confirmSplit(parent, specs, reason, verdict.notes))) {
      return { ok: false, message: 'The user declined the split. Do the work yourself, in this session.' }
    }

    // Re-check after the await. The confirmation is a modal and the user can
    // sit on it: in that window the parent's own turn can end, the worktree can
    // be committed to, or another trigger can fan the same card out. Every one
    // of those makes the proposal we just had approved unsound — subtasks fork
    // from the parent's base, so a parent that has since written something
    // would have it stranded on a branch nothing merges.
    if (!this.byKey(parentKey)) {
      return { ok: false, message: 'This session ended while the split was waiting to be approved.' }
    }
    if ((await this.opts.store.childrenOf(parentKey)).length) {
      return { ok: false, message: 'This session was already split while that was waiting to be approved.' }
    }

    // How many were APPROVED, written before the first child exists. Without
    // it the roll-up counts only the children that got a card, and the ones
    // still queued behind `maxConcurrentAgents` are invisible — see
    // `SessionMeta.fanout`.
    await this.opts.store.patch(parentKey, { fanout: specs.length }).catch(() => {})
    await this.recordDecomposition(parentKey, {
      at: Date.now(), level, outcome: 'split', requested: subtasks.length,
      ...(reason.trim() ? { stated: reason.trim().slice(0, MAX_STATED) } : {}),
    })
    const started: { key: string; title: string; branch: string }[] = []
    /* One resolution per backend, not per piece: `resolveProvider` reads
       SecretStorage, and a four-way fan-out onto one backend would read the
       same credential four times. */
    const envFor = new Map<string, LaunchOptions['providerFor']>()
    for (const spec of specs) {
      // The BACKEND, resolved by the host — the manager never touches a
      // credential. Handed in explicitly rather than left to `start()`, which
      // would freeze whichever profile happens to be active: that is the whole
      // bug this route exists to fix. A runtime with no backend concept gets
      // nothing, because pairing it with a profile would configure something
      // that cannot take effect.
      if (spec.route.provider && !envFor.has(spec.route.provider)) {
        envFor.set(spec.route.provider, await this.opts.resolveProvider?.(spec.route.provider))
      }
      const providerFor = spec.route.provider ? envFor.get(spec.route.provider) : undefined
      const runId = await this.start(spec.prompt, {
        title: spec.title,
        parent: parentKey,
        /* WHAT THIS CHILD RUNS ON, all of it, captured in the launch options —
           never by mutating manager state, because `MAX_SUBTASKS` (4) exceeds
           the default concurrency (3) and the fourth piece always drains late.
           Routing through `setDefaults()` would hand that piece another
           piece's model. `chosen` rather than `defaults`, exactly like a
           resumed session: what the card shows and what the runtime is handed
           must be the same value, resolved once. */
        ...(spec.route.model || spec.route.effort
          ? {
              chosen: {
                ...(spec.route.model ? { model: spec.route.model } : {}),
                ...(spec.route.effort ? { effort: spec.route.effort } : {}),
              },
            }
          : {}),
        ...(providerFor ? { providerFor } : {}),
        ...(parent.base ? { base: parent.base } : {}),
        // A child inherits the PARENT's agent program, not the workspace
        // default. `split()` passed no runtime, so `launch()` fell through to
        // `defaults.runtime` — and a Codex objective's children ran on Claude
        // whenever that was the workspace default, permanently, because a
        // session keeps the runtime it started on.
        runtime: spec.route.runtime,
      })
      if (spec.tags?.length) {
        await this.opts.store.setTags(runId, spec.tags).catch(() => {})
      }
      // The declaration travels with the child, so the board can compare it
      // against what the child actually changed.
      if (spec.scope?.length) {
        await this.opts.store.patch(runId, { scope: spec.scope }).catch(() => {})
      }
      const child = this.agents.get(runId)
      started.push({
        key: runId,
        title: spec.title,
        // A subtask held behind maxConcurrentAgents has no worktree yet, and
        // saying so is better than inventing a branch name it may not get.
        branch: child?.branch ?? '(queued)',
      })
    }
    this.emit('split', parent, started)
    this.touch()
    return { ok: true, started }
  }

  /**
   * Rename a live run's card.
   *
   * Through the manager rather than straight to the store, because a live run's
   * title lives in TWO places: `agent.title`, which is what the board shows for
   * a run whose session id has not arrived, and the runtime's own session
   * record. Writing only the second one silently did nothing for the first few
   * seconds of every session.
   */
  async renameAgent(key: string, title: string): Promise<{ renamed: boolean; reason?: string }> {
    const agent = this.byKey(key)
    if (!agent) return { renamed: false, reason: 'this session is not running' }
    agent.title = title
    agent.titleChosen = true
    this.touch()
    if (!agent.sessionId) return { renamed: true }
    return this.opts.store.rename(agent.sessionId, title)
  }

  /** Write the decision onto the parent's card. Never fatal: a record that
   *  cannot be stored must not stop a split that was approved. */
  private async recordDecomposition(key: string, record: DecompositionRecord): Promise<void> {
    await this.opts.store.patch(key, { decomposition: record }).catch(() => {})
    this.touch()
  }

  /** Continue an existing session: same worktree, resumed Claude session.
   *  `providerFor` is the session's OWN backend, resolved by the host — see
   *  `LaunchOptions.providerFor`. It only matters when the session is being
   *  resumed; a live run's environment is already fixed on its process. */
  async send(
    key: string,
    text: string,
    images: readonly AttachedImage[] = [],
    providerFor?: LaunchOptions['providerFor'],
    chosen?: RunSettings,
  ): Promise<void> {
    const live = this.byKey(key)
    if (live) {
      const s = this.sessions.get(live.runId)
      if (s) {
        // The transcript row records HOW MANY images went with the message, not
        // the images themselves: this array is serialised to the webview on
        // every repaint, and a few megabytes of base64 per frame is exactly the
        // per-token cost this board has a postmortem about.
        live.live.push({
          kind: 'prompt', at: Date.now(), text,
          ...(images.length ? { images: images.length } : {}),
        })
        s.send(text, images)
        this.touch()
        return
      }
    }
    // The previous run for this session has finished. Drop its card before
    // starting the resumed one, or the board renders two entries under the same
    // key — one stale, one live, indistinguishable.
    for (const a of [...this.agents.values()]) {
      if (a.sessionId === key && !this.sessions.has(a.runId)) this.agents.delete(a.runId)
    }
    const existing = await this.opts.store.get(key)
    await this.start(text, {
      resume: key,
      ...(existing?.title ? { title: existing.title } : {}),
      ...(providerFor ? { providerFor } : {}),
      ...(chosen ? { chosen } : {}),
    })
  }

  /**
   * The board tools' side of one run.
   *
   * Extracted from `launch()` so it can be tested without starting an agent.
   * Every optional callback here degrades SILENTLY when it is missing — a tool
   * whose callback is absent answers "this session cannot be renamed from here"
   * and the agent moves on — which is the same shape as the auto-allow list
   * that drifted and left agents unable to move their own cards. So the wiring
   * is asserted, not assumed. See `manager.test.ts`.
   */
  private boardContext(agent: RunningAgent): BoardToolContext {
    return {
      store: this.opts.store,
      key: () => agent.sessionId ?? agent.runId,
      // Baked into the tool descriptions at launch. A policy change mid-turn
      // cannot update text the model has already read — which is fine, because
      // a description is policy and `split()` re-reads the allowlist at gate
      // time. This is the same division the orchestration level already has.
      spawnAgents: this.opts.spawnCatalogue?.().agents,
      onChanged: (change?: BoardChange) => {
        if (change?.phase) {
          agent.live.push({
            kind: 'phase', at: Date.now(), from: change.phase.from, to: change.phase.to,
            ...(change.note ? { note: change.note } : {}),
          })
          // The moment the board exists for: an agent announcing where it got
          // to. The host turns a move into a review column into a notification.
          this.emit('phase', agent, change.phase.from, change.phase.to)
        }
        this.touch()
      },
      onNotice: (notice: BoardNotice) => {
        agent.live.push({ kind: 'notice', at: Date.now(), message: notice.message, urgency: notice.urgency })
        this.emit('notice', agent, notice)
        this.touch()
      },
      derivedTitle: () => (agent.titleChosen ? undefined : agent.title),
      sessionTitle: () => agent.title,
      onRename: async (title: string) => {
        agent.title = title
        agent.titleChosen = true
        this.touch()
        // Before Claude Code has assigned a session id there is no session file
        // to rename. Nothing is lost: the id handler below writes `agent.title`
        // when the id arrives, so a rename inside that window is picked up
        // rather than dropped.
        //
        // The RESULT is returned, not swallowed. A runtime that owns its own
        // session names refuses this, and the agent has to be told: it used to
        // be answered "Card renamed" while the name reverted the moment the run
        // ended, which is a tool reporting a write it did not make.
        if (!agent.sessionId) return { renamed: true }
        return this.opts.store.rename(agent.sessionId, title)
      },
      onSplit: async (subtasks, reason) => {
        const result = await this.split(agent.sessionId ?? agent.runId, subtasks, reason)
        if (result.ok) {
          agent.live.push({
            kind: 'notice', at: Date.now(), urgency: 'info',
            message:
              `Split into ${result.started.length} subtasks, each with its own worktree and card: ` +
              result.started.map((t) => t.title).join(', ') + '.',
          })
          this.touch()
        }
        return result
      },
      commitWorktree: async (message: string) => {
        const path = agent.worktreePath
        if (!path) {
          return { ok: false, reason: 'no-worktree', message: 'This session has no worktree to commit.' }
        }
        if (await this.opts.worktrees.isClean(path)) {
          return { ok: false, reason: 'clean', message: 'The worktree is already clean — nothing to commit.' }
        }
        try {
          const sha = await this.opts.worktrees.commitAll(path, message)
          return { ok: true, sha, message }
        } catch (e) {
          return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e) }
        }
      },
      // The knowledge-file gate, over the agent's OWN worktree: its diff against
      // the base it forked from, and the codemap as the agent left it — so an
      // area file the agent added counts. No worktree or no codemap means
      // nothing is required, and the verdict says so rather than refusing.
      knowledgeFiles: agent.knowledgeFiles === true,
      knowledgeCheck: async () => {
        const path = agent.worktreePath
        if (!path) return { ok: true, areas: [] }
        const areas = await loadCodemap(path)
        if (!areas.length) return { ok: true, areas: [] }
        const changed = await this.opts.worktrees.changedFiles(path, agent.base ?? 'HEAD')
        return knowledgeCheck(changed, areas)
      },
      // Mechanical 1:1 wires — the tool handlers own every decision, including
      // the creator stamp (`onScheduleCreate` gets `createdBy` from
      // `sessionTitle`, which the tools test pins). This file supplies only the
      // host callbacks.
      onScheduleList: this.opts.schedules ? async () => this.opts.schedules!.list() : undefined,
      onScheduleCreate: this.opts.schedules
        ? async (draft, createdBy) => this.opts.schedules!.create(draft, createdBy)
        : undefined,
      onScheduleDelete: this.opts.schedules ? async (id) => this.opts.schedules!.remove(id) : undefined,
      onScheduleRun: this.opts.schedules ? async (id) => this.opts.schedules!.run(id) : undefined,
    }
  }

  private async launch(runId: string, prompt: string, opts: LaunchOptions): Promise<void> {
    const title = opts.title ?? titleFrom(prompt)
    // Hold the slot for the whole of this method, including the awaits before
    // the agent is registered. Cleared in a `finally`, so a throw releases it —
    // otherwise one failed `git worktree add` would shrink the limit for the
    // rest of the session.
    this.launching.add(runId)
    try {
      await this.launchInner(runId, title, prompt, opts)
    } catch (e) {
      // `launch()` NEVER throws, and that is deliberate: it has two callers
      // reached by different routes and both were unsafe in a different way.
      //
      // `drain()` had `catch { /* surfaced through state */ }`, and the comment
      // was false — `launchInner`'s own catch is after the agent is registered,
      // so anything thrown by `store.get()` or `worktrees.create()` (a branch
      // collision, a stale index.lock, a full disk) escaped to a place with no
      // card to put it on, and the queue entry had already been shifted off:
      // the run vanished with nothing in the log and no dialog.
      //
      // `start()` calls this directly when a slot is free, and had NO catch at
      // all — so the same failure on a FRESH session threw out of `start()`,
      // which in `split()` aborts the fan-out partway and leaves the agent
      // holding a `fanout` it will never reach.
      //
      // One place that knows how to report it, per the two-functions rule.
      const why = e instanceof Error ? e.message : String(e)
      this.opts.log?.(`Session "${title}" could not start: ${why}`)
      this.emit('warning', `"${title}" could not start: ${why}`)
      this.touch()
    } finally {
      this.launching.delete(runId)
    }
  }

  private async launchInner(
    runId: string,
    title: string,
    prompt: string,
    opts: LaunchOptions,
  ): Promise<void> {

    // Reuse the worktree of the session being resumed, so a follow-up does not
    // strand the agent in a fresh checkout without its earlier work.
    const prior = opts.resume ? await this.opts.store.get(opts.resume) : undefined
    // The launch is the moment a pending backend switch actually happens, so
    // the bar's "the next turn re-reads it all on the new backend" warning has
    // nothing left to warn about. Cleared HERE and not only in `durablePatch`
    // (which rides the `sessionId` event): a resume keeps the id it already
    // has, so that event may never fire again.
    if (opts.resume && prior?.switchedFrom) {
      void this.opts.store.patch(opts.resume, { switchedFrom: null }).catch(() => {})
    }
    const wt = prior?.worktree && prior.branch
      ? { path: prior.worktree, branch: prior.branch, base: prior.base }
      // A subtask forks from what its PARENT forked from, not from the parent's
      // branch. The parent is a planner — split() refuses to run once it has
      // touched anything — so its branch holds nothing to inherit, and forking
      // from base leaves every subtask an ordinary task branch that the existing
      // diff, merge and cleanup paths already understand. See DECISIONS.md.
      : await this.opts.worktrees.create({
          taskId: shortId(runId), title,
          ...(opts.base ? { baseBranch: opts.base } : {}),
        })
    await prepareComposerWorktree(wt.path)

    // What was already on disk before this run started. Claude Code writes this
    // run to the same transcript as it goes, so without a boundary the chat view
    // renders the live entries AND their on-disk copies. Read ONCE, here: it is
    // a prefix of a file that only ever grows, so it cannot go out of date.
    const history = opts.resume
      ? await this.opts.store.transcript(opts.resume).catch(() => [] as Entry[])
      : []

    // What the session had already spent before this run, captured on the same
    // boundary and for the same reason: a resumed session's earlier turns were
    // billed to a process that is gone, and only its transcript still knows
    // about them. Off the same cached parse as `history`, so it is free.
    const priorUsd = opts.resume
      ? await this.opts.store.usage(opts.resume).then((u) => u.costUsd).catch(() => 0)
      : 0

    // Fixed for the life of the session. A resumed one keeps what it was
    // started on: its transcript lives in that runtime's own store and no other
    // runtime can read it, so "resume on a different agent" is not a thing that
    // can be honestly offered.
    const runtime: RuntimeId =
      (opts.resume ? prior?.runtime : undefined) ?? opts.runtime ?? this.opts.defaults.runtime ?? DEFAULT_RUNTIME

    const agent: RunningAgent = {
      runId, runtime, title, history, priorUsd,
      state: { kind: 'starting' },
      worktreePath: wt.path, branch: wt.branch,
      ...(wt.base ? { base: wt.base } : {}),
      live: [{
        kind: 'prompt', at: Date.now(), text: prompt,
        ...(opts.images?.length ? { images: opts.images.length } : {}),
      }],
      contextTokens: 0,
      startedAt: Date.now(),
      ...(opts.resume ? { sessionId: opts.resume } : {}),
      ...(opts.parent ? { parent: opts.parent } : {}),
    }
    this.agents.set(runId, agent)
    // Written under the RUN id, before Claude Code has assigned a session id.
    // A subtask that is only joined to its parent once the id arrives spends
    // its first seconds on the board as an unexplained extra card, which is the
    // opposite of what splitting is for. adoptKey() carries it across.
    if (opts.parent) {
      await this.opts.store.patch(runId, { parent: opts.parent }).catch(() => {})
    }
    this.touch()

    /* Resolved ONCE, here, because two places need the same answer: the runtime
       that is about to be started, and the sidecar entry that records what this
       card is on. Computing it twice is how they come to disagree.
       `opts.chosen` is the answer `start()` already froze — the per-run choice
       resolved against the workspace default at the moment the run was asked
       for. This used to read `this.opts.defaults` DIRECTLY and so overwrote it,
       which meant a subtask routed to a particular model launched on the
       workspace default instead and the card recorded that default as fact. */
    const chosen = launchSettings({
      chosen: opts.resume
        // A resumed session keeps what IT was on. The frozen launch settings
        // are the floor under a field its sidecar never recorded.
        ? {
            ...opts.chosen,
            ...(prior?.model ? { model: prior.model } : {}),
            ...(resolveEffort(prior?.effort, opts.chosen?.effort)
              ? { effort: resolveEffort(prior?.effort, opts.chosen?.effort) } : {}),
            thinking: resolveThinking(prior?.thinking, opts.chosen?.thinking),
          }
        : opts.chosen,
    }, this.opts.defaults)

    if (chosen.model) agent.model = chosen.model

    let session: AgentRun
    try {
      session = await this.startRun(runtime, runId, agent, wt, title, { ...opts, chosen })
    } catch (e) {
      // A runtime that cannot start must SAY why on the card, naming the fix —
      // "Codex is not installed" is actionable, a card stuck in `starting`
      // forever is not. The worktree is reclaimed if nothing was written to it.
      const message = e instanceof Error ? e.message : String(e)
      agent.live.push({ kind: 'error', at: Date.now(), message })
      agent.state = { kind: 'error', message }
      void this.discardIfUntouched(agent)
      this.touch()
      return
    }
    this.sessions.set(runId, session)

    session.on('sessionId', (id: string) => {
      // Two live runs cannot be the same card. If an id arrives that another
      // running agent already holds, adopting it would merge them: one card for
      // two agents, and whichever registered second would overwrite the other's
      // worktree mapping and title in the sidecar. Nothing would throw — the
      // board would just quietly show one agent's worktree under the other's
      // name. So refuse the id, keep this run on its runId, and say so.
      // Only a RUNNING agent can clash. A finished one legitimately shares the
      // id with the run that resumes it — treating that as a collision fired a
      // warning on every follow-up message and refused the resumed run its own
      // identity.
      const clash = [...this.agents.values()].find(
        (a) => a !== agent && a.sessionId === id && this.sessions.has(a.runId),
      )
      if (clash) {
        this.emit(
          'warning',
          `Two agents reported the same Claude session id (${id}). "${agent.title}" keeps its own card ` +
          `so the board does not merge it with "${clash.title}". It can still move itself and record a ` +
          `test plan; only its transcript will not persist, because that is Claude Code's to key.`,
        )
        this.touch()
        return
      }

      // Carry across whatever the agent already wrote under its run id — it can
      // move its card and record a test plan before this point, and that work
      // would otherwise be orphaned under a key nothing looks up again.
      const previousKey = agent.runId
      agent.sessionId = id
      // Register the card now that Claude Code has given us an identity for it.
      void this.opts.store.adoptKey(previousKey, id).then(() => this.opts.store.patch(id, durablePatch({
        startedPhase: prior?.phase ?? this.opts.board.columns.find((c) => c.category === 'started')?.id,
        runtime,
        worktree: wt,
        startedAt: agent.startedAt,
        ...(opts.parent ? { parent: opts.parent } : {}),
        // What this run is on, so opening the card later says so rather than
        // repeating the workspace default back. A resumed session records ITS
        // backend (`opts.providerFor`), not the workspace's active one.
        ...(opts.providerFor?.profile ?? this.opts.provider
          ? { provider: (opts.providerFor?.profile ?? this.opts.provider)!.id }
          : {}),
        ...(chosen.model ? { model: chosen.model } : {}),
        ...(chosen.effort ? { effort: chosen.effort } : {}),
        ...(chosen.thinking ? { thinking: chosen.thinking } : {}),
      })))
        // `agent.title`, not the launch-time `title`: `set_title` may have already
        // renamed the card during the window before this id existed.
        .then(() => this.opts.store.rename(id, agent.title))
        .catch((e) => {
          // Never silent: a failed rename leaves the card under Claude Code's
          // own summary, and a failed patch leaves it with no worktree link at
          // all — both look like the board losing track of a session.
          this.emit('warning', `Could not register "${agent.title}" on the board: ${e instanceof Error ? e.message : String(e)}`)
        })
        .then(() => this.touch())
    })

    session.on('state', (s: AgentState) => {
      agent.lastEventAt = session.lastEvent
      agent.state = s
      if (s.kind !== 'needsInput') { delete agent.pendingPermission; delete agent.pendingPermissions }
      this.touch()
      // A slot frees up on ANY terminal state, not only on the `done`/`error`
      // events that finish() listens for. An aborted or interrupted run settles
      // to `idle` without either, so draining only from finish() left every
      // agent queued behind maxConcurrentAgents waiting forever.
      if (s.kind === 'idle' || s.kind === 'done' || s.kind === 'error') void this.drain()
    })
    session.on('interrupted', () => {
      // Deliberately NOT finish(): the session stays open and can take another
      // message, which is the entire difference between interrupt and stop.
      delete agent.streaming
      delete agent.queued
      agent.live.push({
        kind: 'notice', at: Date.now(), urgency: 'info',
        message: 'Interrupted. The session is still open — send another message to carry on.',
      })
      this.touch()
    })
    session.on('waiting', (on: string[]) => {
      // Said in the transcript, because from the outside this looks exactly
      // like the agent stopping: its text ended, the spinner would have gone,
      // and the next thing to appear is a turn nobody typed a prompt for.
      delete agent.streaming
      agent.live.push({
        kind: 'notice', at: Date.now(), urgency: 'info',
        message: on.length
          ? `Turn ended, but ${on.length} background agent${on.length === 1 ? '' : 's'} ${on.length === 1 ? 'is' : 'are'} still working (${on.join(', ')}). ` +
            'The session stays open and will continue when they report back.'
          : 'Turn ended. A background agent has reported back — the session is picking its findings up now.',
      })
      this.touch()
    })
    session.on('queued', (texts: string[]) => {
      agent.queued = texts
      this.touch()
    })
    session.on('partial', (chunk: string) => {
      agent.streaming = (agent.streaming ?? '') + chunk
      this.touch()
    })
    session.on('text', (chunk: string) => {
      // The settled block supersedes whatever was streaming.
      delete agent.streaming
      const last = agent.live[agent.live.length - 1]
      if (last?.kind === 'text') last.text += chunk
      else {
        agent.live.push({
          kind: 'text', at: Date.now(), text: chunk,
          ...(agent.model ? { model: agent.model } : {}),
        })
      }
      this.touch()
    })
    // A flag the CLI could not honour. Surfaced like any other warning, because
    // the alternative is a toggle sitting there looking on while doing nothing.
    session.on('flagWarning', (message: string) => { this.emit('warning', message) })

    session.on('provider', (resolved: string | undefined, label: string | undefined) => {
      const a = this.agents.get(runId)
      if (!a) return
      if (resolved) a.resolvedProvider = resolved
      if (label) a.providerLabel = label
      // Emitted as its own event, not left to the repaint, because the host
      // reconciles it against the requested profile and that check must run
      // ONCE per run rather than on every frame the agent produces.
      this.emit('provider', a, resolved)
      this.touch()
    })

    session.on('thinking', (chunk: string) => {
      const last = agent.live[agent.live.length - 1]
      if (last?.kind === 'thinking') last.text += chunk
      else agent.live.push({ kind: 'thinking', at: Date.now(), text: chunk })
      this.touch()
    })
    session.on('tool', (name: string, input: unknown) => {
      delete agent.streaming
      agent.live.push({
        kind: 'tool', at: Date.now(), id: `${agent.live.length}`,
        name, summary: summariseTool(name, input), status: 'running',
        // Stamped only on a LIVE row, and that is the point: it is what the
        // view ticks up while the call is outstanding. A row rehydrated from
        // disk has no honest start time — the SDK's session API does not
        // expose message timestamps — so it gets no timer rather than a
        // plausible-looking one counting from when you opened the view.
        runningSince: Date.now(),
      })
      this.touch()
    })
    session.on('toolResult', (_id: string, okResult: boolean) => {
      for (let i = agent.live.length - 1; i >= 0; i--) {
        const e = agent.live[i]!
        if (e.kind === 'tool' && e.status === 'running') {
          e.status = okResult ? 'ok' : 'error'
          // How long the call actually took, kept on the row. Four minutes of
          // "working" is only answerable if the transcript says WHICH call
          // spent them; the age of the last frame says that something is still
          // moving, not where the time went.
          if (e.runningSince) e.durationMs = Date.now() - e.runningSince
          delete e.runningSince
          break
        }
      }
      this.touch()
    })
    session.on('usage', (tokens: number, window: number | undefined) => {
      agent.contextTokens = tokens
      // Persist the window the RUN reported, once. It is the only authoritative
      // one — a compaction policy can pin a 1M model to 200K — and after a
      // restart there is no run left to ask, so without this the meter falls
      // back to the model's maximum and reads a session as emptier than it is.
      if (window && agent.contextWindow !== window) {
        agent.contextWindow = window
        const key = agent.sessionId ?? agent.runId
        void this.opts.store.patch(key, { contextWindow: window }).catch(() => {})
      }
      this.touch()
    })
    session.on('spend', (spentUsd: number, priced: boolean) => {
      agent.spentUsd = agent.priorUsd + spentUsd
      agent.spendPriced = priced
      this.touch()
    })
    // The runtime-neutral view of the same thing, and the ONE the board reads.
    // Every runtime emits this; only the ones that price per request also emit
    // `spend`, so a Codex card gets a rate-limit meter and no dollar figure
    // rather than a made-up zero.
    session.on('meter', (raw: unknown) => {
      if (this.settleMeter(agent, raw, 'meter')) this.touch()
    })
    /* The agent committed. Declared in both event interfaces, emitted by both
       runtimes, and listened for by NOTHING — so the Changes panel kept showing
       the work as uncommitted and the Merge button stayed disabled for the rest
       of the turn, on a branch that now had something to merge. Both emit sites
       carry a comment saying the host reads the new HEAD off this. */
    session.on('committed', () => { this.emit('committed', agent) })
    session.on('permission', (req: PermissionRequest) => {
      // Queued, not overwritten. The head is what the card shows; the rest are
      // counted, so "1 of 3" is visible rather than two of them vanishing.
      const waiting = (agent.pendingPermissions ??= [])
      if (!waiting.some((r) => r.id === req.id)) waiting.push(req)
      agent.pendingPermission = waiting[0]
      this.touch()
    })

    const finish = () => {
      delete agent.streaming
      /* END the run, do not just forget it.
         This used to `delete` the entry and stop there, on the stated grounds
         that "the session is still alive and still able to take a follow-up".
         That justification was unreachable: `send()` looks the session up in
         THIS map, so once the entry is gone every follow-up takes the resume
         branch and spawns a fresh child — which is what DECISIONS.md documents
         as the intended behaviour. So nothing was being kept for a follow-up;
         the child was simply abandoned.
         And abandoned is literal. `stop()` is the only thing that ends the
         process, and it is reached only from `halt()`, which looks the session
         up in the map this line had already cleared — so `?.stop()` was a no-op
         on every finished run. The prompt is an AsyncIterable, so the SDK never
         calls `endInput()`; the CLI's stdin stays open and it never exits.
         Ten messages to one card left nine idle `claude` processes (or nine
         `codex app-server` plus nine `board-mcp.js`), which neither Stop nor a
         window reload could reach, because both go through `halt()`. Only
         quitting VS Code reclaimed them.
         Steering a RUNNING turn is unaffected: `send()` finds the session while
         the turn is in flight, and this runs only when it ends. */
      const ending = this.sessions.get(runId)
      this.sessions.delete(runId)
      ending?.stop()
      // The board-tool socket goes with it, for the same reason: it was kept
      // open for a follow-up that cannot arrive on this run, so it was a
      // leaked node process and an open descriptor per ended session.
      this.bridges.get(runId)?.dispose()
      this.bridges.delete(runId)
      // This run reached the end under its own power, so it was not cut off.
      // Zero, not undefined: a patch drops undefined and the mark would stay.
      if (agent.sessionId) void this.opts.store.patch(agent.sessionId, { running: 0 }).catch(() => {})
      this.touch()
      // A finished agent has left changes in its worktree; the host reloads the
      // review panel rather than making the user press Refresh to find out.
      this.emit('finished', agent)
      void this.drain()
    }
    session.on('done', (summary: string, meter?: unknown, turnUsd?: unknown) => {
      // The final settle of the session meter, then this TURN's dollars — two
      // different scopes that used to share one argument slot. `costUsd` is the
      // turn, which is what the transcript row and the agent row show; it is
      // ABSENT for a runtime with no per-request price, so a Codex result row
      // carries no dollar figure rather than a fabricated zero.
      this.settleMeter(agent, meter, 'done')
      const turn = typeof turnUsd === 'number' && Number.isFinite(turnUsd) ? turnUsd : undefined
      agent.costUsd = turn
      agent.live.push({
        kind: 'result', at: Date.now(), summary,
        durationMs: Date.now() - agent.startedAt,
        ...(turn !== undefined ? { costUsd: turn } : {}),
      })
      finish()
    })
    session.on('error', (message: string) => {
      agent.live.push({ kind: 'error', at: Date.now(), message })
      // A run that failed before Claude Code ever gave it a session id never got
      // as far as working. Its worktree is a dead checkout and a dead branch
      // that nothing references, and they accumulate in the worktree directory with
      // every failed start. Reclaim it — but only once it is provably empty.
      if (!agent.sessionId) void this.discardIfUntouched(agent)
      finish()
    })

    void session.run(prompt, opts.images ?? []).catch(() => finish())
  }

  /**
   * Start one run, on whichever agent program the card is set to.
   *
   * There is no branch on the runtime's identity here, deliberately. Everything
   * that differs between Claude Code and Codex — how to find the binary, how to
   * take the board's tools, what a model id means — is behind the descriptor in
   * `agent/runtimes/`. What is left is what is true of all of them, and that is
   * the test of whether the abstraction is real: a third runtime should need no
   * edit to this method.
   */
  private async startRun(
    id: RuntimeId,
    runId: string,
    agent: RunningAgent,
    wt: { path: string; branch: string },
    title: string,
    opts: LaunchOptions,
  ): Promise<AgentRun> {
    const rt = getRuntime(id)
    if (!rt) {
      throw new Error(
        `This build of Agents Kanban does not know how to run "${id}". ` +
        'Pick a different agent on the composer bar.',
      )
    }

    const configured = id === 'claude' ? this.opts.claudeExecutable
      : id === 'codex' ? this.opts.codexExecutable
      : undefined
    const location = await rt.detect(configured)
    if (!location) {
      throw new Error(
        `${rt.label} was not found on this machine. Install it with \`${rt.installHint}\`, then ` +
        'sign in — the board uses the login you already have and never asks for a key.',
      )
    }

    // Does this worktree carry a knowledge base? Decided once per launch and
    // remembered on the card: the brief and the `set_phase` description state
    // the rule only where it applies, while the gate itself re-reads the folder
    // at check time so an area file added mid-run counts.
    agent.knowledgeFiles = (await loadCodemap(wt.path)).length > 0

    const boardTools = await this.boardToolsFor(rt.capabilities.boardTools, runId, agent, title, rt.label)

    // Provider profiles steer the backend of a runtime whose backend IS
    // environment on the child process. Handing them to one that authenticates
    // as itself would be configuring something that cannot take effect, and the
    // board would then name a provider that is not billing anything.
    // A RESUMED session brings its OWN backend (`opts.providerFor`, resolved by
    // the host from the session's recorded profile); a new one starts on the
    // active profile. Resolving this twice — once at enqueue, once here — is
    // how a queued run could start on a profile nobody picked.
    const launchProfile = opts.providerFor?.profile ?? this.opts.provider
    const launchEnv = opts.providerFor?.env ?? this.opts.providerEnv
    const provider = rt.capabilities.providerProfiles
      ? {
          ...(launchProfile ? { provider: launchProfile } : {}),
          ...(launchEnv?.set && Object.keys(launchEnv.set).length
            ? { env: launchEnv.set } : {}),
          ...(launchEnv?.clear?.length ? { envClear: launchEnv.clear } : {}),
        }
      : {}
    // Recorded on the live card, not only in the sidecar: `split()` reads the
    // parent's WHOLE agent off `RunningAgent`, and the sidecar entry does not
    // exist until the runtime hands over a session id — which is after the
    // first turn, and a parent can be split from before then.
    agent.provider = rt.capabilities.providerProfiles ? (launchProfile?.id ?? '') : ''

    /* WHAT THIS RUN IS ON, resolved once. `start()` froze it into `opts` at the
       moment the run was asked for; this call is the floor under a caller that
       reached `launch()` directly. Reading `this.opts.defaults` here as the
       primary source is what let a queued run — and always the fourth piece of
       a fan-out — launch on a model nobody picked for it. */
    const settings = launchSettings(opts, this.opts.defaults)
    const effort = settings.effort ?? resolveEffort(undefined, undefined)
    /* The level, captured HERE and remembered on the card.
       `buildBrief()` bakes the matching sentence into the system prompt once,
       and the split arrives a turn later — so the gate must read what the brief
       SAID, not what the setting says by then. A level changed mid-session
       applies to the next one, which is the same honest answer `setProvider()`
       gives for a provider. */
    const level = opts.orchestration ?? this.opts.defaults.orchestration ?? DEFAULT_ORCHESTRATION
    agent.orchestration = level
    // A subtask may not split again, so it is not told how eagerly to.
    const canSplit = !opts.parent && !agent.parent
    const spawnAgents = canSplit ? this.opts.spawnCatalogue?.().agents : undefined
    return rt.start({
      taskId: runId,
      cwd: wt.path,
      permissionMode: this.opts.permissionMode,
      executable: location.command,
      appendSystemPrompt: buildBrief(
        this.opts.board, title, wt.branch, policyFor(level), canSplit, spawnAgents,
        agent.knowledgeFiles === true,
      ),
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(boardTools ? { boardTools } : {}),
      ...(this.opts.log ? { log: this.opts.log } : {}),
      ...provider,
      // Not inside `provider`: a price is arithmetic, not backend selection,
      // and it is declared on `RunSpec` so the compiler can see it. A field
      // spread into a typed argument gets no excess-property check, so an
      // undeclared one compiles and is dropped in silence.
      ...(this.opts.modelBook ? { modelBook: this.opts.modelBook } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      ...(effort ? { effort } : {}),
      // Only sent when the runtime has the concept. `thinking` is Claude's
      // adaptive-thinking switch; Codex expresses the same thing through effort
      // and would be receiving an option it has no meaning for.
      ...(rt.capabilities.thinkingToggle
        && resolveThinking(undefined, settings.thinking) === 'disabled'
        ? { thinking: 'disabled' as const } : {}),
      ...(settings.ultracode ? { ultracode: true } : {}),
      ...(settings.fastMode ? { fastMode: true } : {}),
    })
  }

  /**
   * The board's tools, in whichever form this runtime can take them.
   *
   * One set of definitions, two transports — see `board-bridge.ts`. The failure
   * this guards is not subtle: an agent that cannot call `set_phase` cannot move
   * its own card, which is the entire product, and it fails SILENTLY because a
   * missing tool looks to the model exactly like a tool it was never given.
   */
  private async boardToolsFor(
    transport: 'inProcess' | 'stdio',
    runId: string,
    agent: RunningAgent,
    title: string,
    label: string,
  ): Promise<{ autoAllow: string[]; inProcess?: unknown; stdio?: { command: string; args: string[]; env?: Record<string, string> } } | undefined> {
    if (transport === 'inProcess') {
      const inProcess = await createBoardServer(this.opts.board, this.boardContext(agent))
      // Derived from the tool definitions, so a rename can never leave the agent
      // unable to move its own card.
      const { tool } = await loadSdk()
      return { autoAllow: boardToolNames(this.opts.board, tool), inProcess }
    }

    if (!this.opts.boardBridge) {
      this.emit(
        'warning',
        `"${title}" is running on ${label} without the board tools, so it cannot move its own card ` +
        'or write a test plan. You will need to move it yourself.',
      )
      return undefined
    }
    const bridge = await startBoardBridge(this.opts.board, this.boardContext(agent), this.opts.boardBridge)
    this.bridges.set(runId, bridge)
    return { autoAllow: bridge.autoAllow, stdio: bridge.descriptor }
  }

  /**
   * Take a `Meter` off an untyped event, and put it on the card.
   *
   * Two things happen here that both have to, and neither is visible to the
   * type system.
   *
   * It PARSES. `EventEmitter.on()` is untyped, so a runtime that emits the
   * wrong shape reaches `media/board.js` — which has no type checking — and a
   * throw inside `render()` is a silently blank panel. A shape we cannot read
   * leaves the previous reading alone and SAYS SO in the output channel, rather
   * than being coerced into a number the board then displays as measured.
   *
   * And it adds `priorUsd`. The session's own arithmetic covers the turns THIS
   * run has seen; a resumed session's earlier turns were billed to a process
   * that no longer exists and are known only from its transcript. The `spend`
   * event was already adjusted here and the `meter` event was not, so the two
   * readouts for one claim disagreed by exactly the resumed history — and the
   * board is about to read the meter rather than `spend`, which would have made
   * a silent gap into a visible wrong number.
   */
  private settleMeter(agent: RunningAgent, raw: unknown, event: string): boolean {
    const m = parseMeter(raw)
    if (!m) {
      // Only complain about a value that was actually sent. An absent meter on
      // `done` is legitimate — a runtime with nothing to report.
      if (raw !== undefined) {
        this.opts.log?.(
          `${agent.runtime} sent a meter on '${event}' that this build cannot read ` +
          `(${JSON.stringify(raw)?.slice(0, 200)}). The card keeps its previous figure.`,
        )
      }
      return false
    }
    agent.meter = m.kind === 'usd' && agent.priorUsd
      ? { ...m, spentUsd: m.spentUsd + agent.priorUsd }
      : m
    return true
  }

  /** Remove a worktree only if nothing was ever done in it. Anything else —
   *  a stray file, a commit, or an error while checking — is left alone: a
   *  leaked directory is a nuisance, deleting someone's work is not. */
  private async discardIfUntouched(agent: RunningAgent): Promise<void> {
    try {
      if (!(await this.opts.worktrees.isClean(agent.worktreePath))) return
      if (agent.base && (await this.opts.worktrees.aheadOf(agent.worktreePath, agent.base)) > 0) return
      await this.opts.worktrees.remove(agent.worktreePath, { force: true })
    } catch {
      // Keeping a stale worktree is the safe way to fail here.
    }
    /* And the sidecar entry, which nothing else could ever clear.
       `parent` is written under the RUN id so a subtask joins its parent
       immediately, and `adoptKey()` moves it when the session id arrives. When
       the id NEVER arrives — `startRun()` threw, or the run errored before
       adoption — the entry was left behind forever: `MetaStore.remove` is
       reachable only through `store.delete()`, and the host's own delete
       handler skips it for exactly these keys, so not even deleting the card
       could get rid of it.
       `childrenOf()` is a plain sidecar scan, so it counted that phantom
       forever, and its phase is the default column, which is never settled — so
       the parent's roll-up could never fire again. It survives the `fanout`
       guard too: the phantom makes the count bigger, not smaller, so the
       count check passes and the every-settled check then fails on a child
       that does not exist. This is the only place that knows the run never
       became a session. */
    if (!agent.sessionId) {
      await this.opts.store.forget(agent.runId).catch(() => {})
      this.touch()
    }
  }

  private async drain(): Promise<void> {
    // Not while the host is going away. `halt()` drains because stopping one
    // agent has to release whatever was queued behind it — but `stopAll()`
    // shares `halt()`, and `halt()` only splices the queue by the HALTED run's
    // own id, so on teardown every halt freed a slot and started something.
    // Measured: `stopAll()` took the spawned-run count from 1 to 2 and left an
    // agent behind, with a real worktree, a real branch and a real CLI, against
    // a workspace that was being disposed — and no card anywhere to stop it.
    if (this.stopped) return
    while (this.queue.length && this.activeCount < this.opts.maxConcurrent) {
      const next = this.queue.shift()!
      // `launch()` never throws; it reports. See the catch there — there is one
      // place that knows how to describe a failed launch, not two.
      await this.launch(next.runId, next.prompt, next.opts)
    }
  }

  /** `selections` is only ever set for AskUserQuestion; see board/questions.ts. */
  answerPermission(
    key: string,
    requestId: string,
    allow: boolean,
    selections?: Record<string, string[]>,
  ): boolean {
    const a = this.byKey(key)
    if (!a) return false
    const answered = this.sessions.get(a.runId)?.answerPermission(requestId, allow, undefined, selections) ?? false
    if (answered && a.pendingPermissions) {
      // Drop the one just answered and promote the next, so a turn that asked
      // twice does not lose the second request behind the first.
      a.pendingPermissions = a.pendingPermissions.filter((r) => r.id !== requestId)
      if (a.pendingPermissions.length) a.pendingPermission = a.pendingPermissions[0]
      else { delete a.pendingPermission; delete a.pendingPermissions }
      this.touch()
    }
    return answered
  }

  /** Stop this turn, keep the session. The common case, and it was unreachable. */
  async interrupt(key: string): Promise<void> {
    const a = this.byKey(key)
    if (!a) return
    await this.sessions.get(a.runId)?.interrupt()
    delete a.queued
    this.touch()
  }

  /** Discard follow-ups queued behind the current turn. */
  clearQueue(key: string): number {
    const a = this.byKey(key)
    if (!a) return 0
    const n = this.sessions.get(a.runId)?.clearQueue() ?? 0
    delete a.queued
    this.touch()
    return n
  }

  /**
   * Change the permission mode for future runs, and for one live session when
   * `key` names it. The stored value matters most: it is what every subsequent
   * `launch()` reads, and nothing else writes it.
   */
  async setPermissionMode(mode: ManagerOptions['permissionMode'], key?: string): Promise<void> {
    this.opts.permissionMode = mode
    if (key) {
      const a = this.byKey(key)
      if (a) await this.sessions.get(a.runId)?.setPermissionMode(mode)
    }
    this.touch()
  }

  stop(key: string): void {
    const a = this.byKey(key)
    if (!a) return
    // A deliberate stop is not an interruption. Clear the mark, or the next
    // launch greets the user with "the editor cut this off" about a run they
    // stopped on purpose — a signal that lies is worse than no signal.
    if (a.sessionId) void this.opts.store.patch(a.sessionId, { running: 0 }).catch(() => {})
    this.halt(a)
  }

  /** Tear a run down without judging why. See stop() and stopAll(). */
  private halt(a: RunningAgent): void {
    this.sessions.get(a.runId)?.stop()
    this.sessions.delete(a.runId)
    // Same reason as in `finish()`. `stopAll()` runs on host teardown, so this
    // is also what stops a window reload leaving a socket per agent behind.
    this.bridges.get(a.runId)?.dispose()
    this.bridges.delete(a.runId)
    this.agents.delete(a.runId)
    const i = this.queue.findIndex((q) => q.runId === a.runId)
    if (i >= 0) this.queue.splice(i, 1)
    this.touch()
    // Stopping frees a slot too, and nothing else was going to notice. Guarded
    // by `this.stopped` inside `drain()`, because `stopAll()` shares this
    // method and must not start anything.
    void this.drain()
  }

  /** Forget a finished run so the board falls back to the on-disk transcript. */
  release(key: string): void {
    const a = this.byKey(key)
    if (a && !this.sessions.has(a.runId)) {
      this.agents.delete(a.runId)
      // The run is gone from the board, so its board-tool socket has nothing
      // left to serve. One per session, so not closing it leaks a descriptor
      // and a socket file per agent the user has ever run.
      this.bridges.get(a.runId)?.dispose()
      this.bridges.delete(a.runId)
      this.touch()
    }
  }

  /**
   * Stop every run because the host is going away — a window reload, a
   * reinstall, a folder change.
   *
   * Deliberately does NOT clear the running mark, which is the whole difference
   * between this and `stop()`. This IS the event the mark exists to record: the
   * runs are being killed mid-turn through no decision of the user's, and the
   * next launch has to be able to say so. A crash never reaches this line at
   * all, and leaves the mark for the same reason.
   */
  stopAll(): void {
    // Set FIRST, and never cleared: this manager is being thrown away. Without
    // it each `halt()` freed a slot and `drain()` started the next queued run —
    // a billed CLI, a real worktree and a real branch, created as the extension
    // host disposed, with no card and nothing left able to stop it.
    this.stopped = true
    // The queue goes too. It is in memory, so a run still in it was never going
    // to survive the host anyway; leaving entries there only gave a late drain
    // something to find.
    this.queue.length = 0
    for (const a of [...this.agents.values()]) this.halt(a)
  }
}

/** Appended to the Claude Code system prompt. Tells the agent it owns a card. */
/**
 * @param policy how eagerly this session should split. Its `aim` sentence
 *   REPLACES the disposition half of the split paragraph below — see
 *   `aimSentence`. Two paragraphs that both set the disposition is two things
 *   that know the policy, and the longer one would win.
 * @param canSplit false for a session that may not split at all — a subtask, or
 *   a resumed session whose parent already fanned out. `split()` refuses those
 *   immediately, so telling the agent how eagerly to split would be inviting it
 *   to call a tool that can only answer no.
 */
export function buildBrief(
  board: BoardConfig,
  title: string,
  branch: string,
  policy: OrchestrationPolicy = policyFor(DEFAULT_ORCHESTRATION),
  canSplit = true,
  /** What a subtask may be routed to: the agent programs and backends on
   *  offer, each with the models it serves. Omitted (the usual test case, or a
   *  host without the policy) leaves the paragraph as it always was. */
  spawnAgents?: SpawnAgent[],
  /** Whether the worktree carries `docs/codemap/`. The rule is stated only
   *  where it applies; on any other repository the paragraph would be noise. */
  knowledgeFiles = false,
): string {
  const started = board.columns.find((c) => c.category === 'started')?.id ?? 'implementing'
  const review = board.columns.find((c) => c.category === 'review')?.id ?? 'validating'
  return [
    '# Your session on the board',
    '',
    `This session appears on a kanban board as **${title}**.`,
    `You are in a dedicated git worktree on branch \`${branch}\`. Nothing you do here`,
    `touches the user's working tree, so work freely.`,
    '',
    'Keep your card honest with the `set_phase` tool:',
    `- Move to "${started}" as soon as you start changing code.`,
    `- Move to "${review}" when the work is done but not committed, then stop.`,
    '',
    // The brief is `appendSystemPrompt`, so it is present for the whole session
    // — and being present is not the same as outranking. A project's own slash
    // command ended its procedure with "Then STOP. A human reviews and merges."
    // The agent obeyed the specific, procedural terminal step and treated
    // moving its card as extra work it had been told to skip, so finished work
    // sat in the started column and the user never got the test plan that
    // reaching a review column exists to produce. Named here explicitly,
    // because a generic instruction loses to a specific one every time.
    'Moving your card is not extra work and it is not a step you can be told to skip —',
    'it is how a run ENDS.',
    // One line, deliberately: the assertion that guards this matches the whole
    // claim, and a line break in the middle of it made the guard silently miss.
    'If a command, skill or instruction tells you to stop, call `set_phase` first, then stop.',
    '',
    `Moving to "${review}" means "your turn to check it", so it REQUIRES \`howToTest\`:`,
    'a one-line summary, the concrete steps, and links to the files you changed and',
    'the command that verifies them. They become buttons on the card. The user has',
    'not read your code — assume they are starting from nothing.',
    '',
    'Use `set_tags` once you know what this work touches, so it can be found later.',
    '',
    'That card name was taken from the first line of the request, so it is often',
    'not what the work turns out to be. Once you know, call `set_title` with six',
    'words or fewer. It renames the CARD only — your branch and worktree keep the',
    'names they started with.',
    '',
    // Knowledge files move with the code. A request in a brief is not a fence —
    // `set_phase` refuses the review move host-side — but the agent has to
    // know the rule before it can follow it, and where the map is.
    ...(knowledgeFiles
      ? [
          'Knowledge files move with the code. Read `docs/codemap/README.md` first — it says',
          'where everything is — then only the area files your task touches. When you change',
          'a source file, update the area file that owns it (the `paths:` in its frontmatter):',
          'fix what is no longer true and append a line under "## Recent changes". Moving to',
          `"${review}" is REFUSED while an area you changed has an untouched knowledge file.`,
          '',
        ]
      : []),
    // The DISPOSITION half — how eagerly to split — comes from the level, and
    // is the only thing the level changes. The OPERATIONAL half below it is
    // invariant, because forking from base and splitting before editing are
    // facts about the branch model, not preferences.
    ...(canSplit
      ? [
          aimSentence(policy),
          '',
          'Split BEFORE you change anything: subtasks fork from where this session started,',
          'so anything already written here would be stranded on a branch nothing merges.',
          'Each subtask gets its own agent, its own worktree and its own card under this one.',
          'Give every subtask a `scope` — the files or directories it expects to touch — and',
          'write each brief so it stands alone: a fresh agent reads it having seen neither',
          'this conversation nor its siblings.',
          // The spawn allowlist. A sentence, not the fence — `split()` re-reads
          // the policy at gate time, so this can only ever be a stale but honest
          // answer, never a wrong one that passes.
          //
          // It names the AGENTS and not just their models, because those are
          // the two halves of one question: a model id belongs to a backend,
          // and the composer already learned that offering them as two pickers
          // makes the user do a cross product in their head and shows half the
          // answer on screen. A subtask picks a row, not a pair.
          ...(spawnAgents
            ? ['',
               ...(spawnAgents.length
                 ? ['Spawned agents may only run on these — pick one per subtask by its short name,',
                    'and name a `model` it serves. A subtask that names neither runs on this',
                    "session's own agent and backend:",
                    describeSpawnAgents(spawnAgents),
                    'A subtask stays on the agent it starts on for life, so route it to the one',
                    'whose strengths the work needs.']
                 : ['No model is currently allowed for spawned agents, so `split_task` will be refused.']),
              ]
            : []),
        ]
      : []),
  ].join('\n')
}

/**
 * Discourse markers that open a message without describing the work. Stripped
 * from the FRONT of a sentence only.
 *
 * `just` is here for "just fix the login flow"; it is only ever dropped while
 * it is the leading word, so "the just-in-time cache" keeps it.
 */
const OPENERS = new Set([
  'okay', 'ok', 'k', 'alright', 'allright', 'right', 'so', 'well', 'hey', 'hi',
  'hello', 'now', 'then', 'also', 'and', 'but', 'anyway', 'anyways', 'oh',
  'hmm', 'um', 'uh', 'erm', 'yeah', 'yep', 'yes', 'no', 'nope', 'sure', 'cool',
  'great', 'nice', 'perfect', 'thanks', 'please', 'actually', 'basically',
  'just',
])

/** Ways of asking that say nothing about what is being asked for. */
const WRAPPERS: RegExp[] = [
  /^i(?:'d|'m| would| am)? ?(?:really )?(?:want|like|need|going) (?:you )?to /i,
  /^i(?:'d| would)? (?:really )?(?:want|like|need) you (?:to )?/i,
  /^(?:can|could|would|will) you (?:please |also )?/i,
  /^(?:let'?s|lets|let us) /i,
  /^we (?:should|need to|want to|could|have to) /i,
  /^you (?:should|need to|must|can|could) /i,
  /^(?:make sure to|be sure to|go ahead and|help me|try to|try and|start by) /i,
  /^(?:your task is|the task is|task|todo|goal)[: ]+(?:to )?/i,
  /^please /i,
]

/** How many words a cleaned sentence needs before it is preferred as a title. */
const ENOUGH_WORDS = 3

/** Strip leading filler until something substantial is in front. */
function stripFiller(sentence: string): string {
  let s = sentence.trim()
  for (let pass = 0; pass < 6; pass++) {
    const before = s
    const words = s.split(' ')
    const head = (words[0] ?? '').toLowerCase().replace(/[^a-z']/g, '')
    if (head && OPENERS.has(head)) s = words.slice(1).join(' ').trim()
    for (const w of WRAPPERS) s = s.replace(w, '').trim()
    if (s === before) break
  }
  return s.replace(/^[,;:.\-–—\s]+/, '').trim()
}

/**
 * A card title from a free-form prompt.
 *
 * It used to be the first sentence, full stop — so a session opening with
 * "Okay." was called **Okay.** for the rest of its life, and its worktree was
 * `S2mtnf1lpa-okay`, which cannot be renamed at all. Spoken and dictated
 * prompts open with a discourse marker most of the time, and the name is minted
 * at t=0, before anything has read a line of code. So: skip the filler, skip a
 * sentence that is nothing but filler, and take the first one that actually
 * says something.
 *
 * Deliberately dumb — no model call. This runs before the session exists, on
 * the path that creates the worktree, and a title is not worth a round trip.
 * `set_title` is how a name gets genuinely good, once the agent knows the work.
 */
export function titleFrom(prompt: string): string {
  // Sentences, from the first 600 characters. Bounded because a prompt may open
  // with a pasted stack trace, and there is nothing in one worth titling.
  const sentences = prompt
    .slice(0, 600)
    .split(/\n+|(?<=[.?!])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  const cleaned = sentences.slice(0, 6).map(stripFiller).filter(Boolean)
  const words = (s: string) => s.split(' ').length
  // Earliest usable sentence, never the longest: a two-word opening line must
  // not lose the title to a two-word second line. "Please add SSO" is two words
  // and still the best name available, so the bar drops rather than being
  // abandoned — and a prompt of "Okay." has only its own filler to offer.
  const picked =
    cleaned.find((s) => words(s) >= ENOUGH_WORDS) ??
    cleaned.find((s) => words(s) >= 2) ??
    cleaned[0] ??
    sentences[0] ??
    ''
  return normaliseTitle(picked) || 'Untitled session'
}

/**
 * The prefix a worktree directory and branch carry, to keep two sessions with
 * the same title apart.
 *
 * Short on purpose: it sits in front of the readable part of every directory
 * name, and ten characters of base-36 clock (`S2mtnf1lpa-okay`) push the part a
 * human reads off the end of the column. `WorktreeService.create()` already
 * appends `-2` on a collision, so this only has to make them mostly unique.
 */
function shortId(runId: string): string {
  const [n = '', ts = ''] = runId.replace(/^run-/, '').split('-')
  return `S${n}${ts.slice(-3)}`
}
