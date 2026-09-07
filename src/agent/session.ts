/** One Claude session working one task, in one worktree.
 *
 * Uses `query()` from the Agent SDK. Two details matter and are easy to get
 * wrong:
 *
 *  1. `prompt` is an AsyncIterable, never a bare string. A string makes the SDK
 *     treat the turn as a one-shot and close the child's stdin after the result,
 *     which kills interrupt(), permission round-trips and follow-up messages.
 *     Nimbalyst does the same thing for the same reason.
 *
 *  2. `cwd` is the WORKTREE, not the workspace root. That is what makes
 *     parallel agents safe.
 */
import { loadSdk, resolveClaudeExecutable, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from './sdk.ts'
import {
  contextOfUsage, costOfUsage, mainWindowOf, sameUsage, windowFor, SYNTHETIC_MODEL,
  type ModelBook, type TokenUsage,
} from '../sessions/usage.ts'
import { describeImages, userContent, type AttachedImage } from './images.ts'
import { EventEmitter } from 'node:events'
import type { EffortLevel, ThinkingMode } from '../sessions/meta.ts'
import type { AgentState } from '../board/config.ts'
import { buildAskAnswers, parseAskQuestions } from '../board/questions.ts'
import { reconcileProvider, resolvedLabel, type ProviderProfile } from './providers.ts'
import type { AgentRun, Meter } from './runtime.ts'

export interface PermissionRequest {
  id: string
  toolName: string
  input: Record<string, unknown>
  /** Rendered sentence from the SDK when present, e.g. "Claude wants to read foo.txt". */
  prompt?: string
  resolve: (r: PermissionResult) => void
}

export interface SessionEvents {
  state: (s: AgentState) => void
  text: (chunk: string) => void
  tool: (name: string, input: unknown) => void
  toolResult: (id: string, ok: boolean) => void
  /** Live token deltas, for typing-speed output. */
  partial: (text: string) => void
  /** Follow-ups sent but not yet acted on, because a turn is still running. */
  queued: (texts: string[]) => void
  /** The user stopped the turn. The session is still open. */
  interrupted: () => void
  thinking: (text: string) => void
  /** Context fill for the meter: per-step, never cumulative. */
  usage: (contextTokens: number, contextWindow: number | undefined) => void
  /** What the session has spent so far, priced from its token counts. Fires as
   *  the turn runs, so the readout climbs instead of jumping at the end.
   *  `priced` is false when a model with no published rate contributed. */
  spend: (spentUsd: number, priced: boolean) => void
  /** The same figure as `spend`, in the shape every runtime reports. */
  meter: (m: Meter) => void
  /** A `git commit` ran in the worktree — the host should read the new HEAD. */
  committed: () => void
  permission: (req: PermissionRequest) => void
  sessionId: (id: string) => void
  /** Which backend the CLI says it is ACTUALLY on, once per run.
   *
   *  Not the profile we configured — that is only a request, and a managed
   *  settings file or an `apiKeyHelper` can outrank it. The board shows this one,
   *  because a provider readout that cannot disagree with reality is the
   *  "never show a signal that cannot say bad" rule broken in a new place. */
  provider: (resolved: string | undefined, label: string | undefined) => void
  /** A session flag we asked for that the CLI could not honour. See
   *  `checkFlagSettings`: the request path itself never refuses anything. */
  flagWarning: (message: string) => void
  done: (summary: string, costUsd?: number) => void
  error: (message: string) => void
}

/** An async queue that stays open until closed — the streaming-input prompt. */
class MessageQueue {
  private readonly pending: SDKUserMessage[] = []
  private wake?: () => void
  private closed = false

  /** `content` is a plain string for a text-only message, or an array of
   *  content blocks when the message carries attachments. Both are valid
   *  `MessageParam` content; see agent/images.ts. */
  push(content: string | unknown[]): void {
    this.pending.push({
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: '',
    } as SDKUserMessage)
    this.wake?.()
  }

  /** Drop everything not yet consumed. Used when the user changes their mind. */
  clear(): number {
    const n = this.pending.length
    this.pending.length = 0
    return n
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.pending.length) yield this.pending.shift()!
      if (this.closed) return
      await new Promise<void>((r) => { this.wake = r })
      this.wake = undefined
    }
  }
}

/**
 * Environment variables that name the Claude Code session the EXTENSION HOST is
 * running inside, and which must never be handed to a session it starts.
 *
 * Found by running a real agent, and it is not exotic: launch VS Code from a
 * terminal that is already inside Claude Code — which is exactly how someone
 * who wants a Claude kanban board works — and `CLAUDE_CODE_SESSION_ID` is in
 * the environment. `options.env` spreads `process.env`, so every agent the
 * extension started inherited it and **reported the same session id as its
 * host**. In the observed run all three agents from one split claimed the id of
 * the terminal that launched them.
 *
 * The collision guard caught it (`Two agents reported the same Claude session
 * id`) and did the right thing, which is how it was noticed at all — but the
 * consequence is that every agent after the first keeps a run-id card with no
 * persisted transcript. Splitting makes it worse by starting several at once.
 *
 * Deliberately a NAMED LIST, not a `CLAUDE_*` sweep: nearly everything else
 * under that prefix is configuration the user means to inherit — proxy
 * settings, model overrides, credentials. Only per-session and per-process
 * identity is dropped.
 */
export const HOST_SESSION_VARS = [
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_SESSION_INGRESS_TOKEN_FILE',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'CLAUDE_PID',
] as const

/**
 * The environment for a spawned CLI: everything we have, minus the identity of
 * the session we are running inside. Pure, so it can be tested without one.
 *
 * `clear` is how a provider profile says "this variable is not mine". It has to
 * exist because provider selection is a set of independent flags rather than one
 * field: with `CLAUDE_CODE_USE_BEDROCK=1` in the ambient environment, setting
 * `ANTHROPIC_BASE_URL` for a gateway profile produces a session that is STILL on
 * Bedrock, and the board would then name a provider that is not billing the
 * tokens. A cleared key is dropped from the child's environment entirely rather
 * than set empty, because a future CLI reading `''` as "present" would turn this
 * guard into the bug it prevents. See `envForProfile()` in `providers.ts`.
 *
 * `extra` is applied last and wins, so a profile can re-set something it also
 * asked to clear without the order mattering to the caller.
 */
export function agentEnv(
  base: Record<string, string | undefined>,
  extra: Record<string, string> = {},
  clear: readonly string[] = [],
): Record<string, string> {
  const dropped = new Set([...HOST_SESSION_VARS, ...clear])
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue
    if (dropped.has(k)) continue
    out[k] = v
  }
  // Nimbalyst shipped this as a bug fix (NIM-1573): the CLI's in-place
  // self-update ran mid-session and corrupted the binary underneath it. We
  // resolve the CLI from PATH rather than bundling one, so the blast radius is
  // the user's own install — which is worse, not better. An agent run is not
  // the moment to swap the executable out.
  out.DISABLE_AUTOUPDATER = '1'
  out.DISABLE_UPDATES = '1'
  return { ...out, ...extra }
}

/**
 * Built-in tools the agent may always use without asking. Read-only, and the
 * agent is confined to its own worktree anyway.
 *
 * The BOARD tools are auto-allowed too, but they are not listed here — they are
 * passed in from their own definitions (see `autoAllow`). Writing them out by
 * hand is exactly what broke: this list kept v1's names after the tools were
 * renamed, so `set_phase` prompted for permission every time and an agent could
 * not move its own card without a click.
 */
const AUTO_ALLOW_BUILTIN = new Set([
  'Read', 'Glob', 'Grep', 'TodoWrite', 'Task', 'WebFetch', 'WebSearch',
])

/** Test hook: is this tool name in the built-in auto-allow set? The board tools
 *  are checked per-session, via `boardTools`. */
export function AUTO_ALLOWED_FOR_TEST(name: string): boolean {
  return AUTO_ALLOW_BUILTIN.has(name)
}

/**
 * Did the ultracode flag we asked for actually get what it needs?
 *
 * Pulled out as a pure function because the interesting cases cannot be
 * reproduced on demand — they need an account with workflows disabled — and
 * because it is the whole safety argument for the toggle, so it must be
 * checkable.
 *
 * Returns a sentence to show, or undefined when there is nothing to say. Note
 * what it does NOT do: it never reports success. `Workflow` is present on
 * ordinary sessions too (verified against a real CLI), so its presence proves
 * nothing about ultracode. Only its ABSENCE is evidence, because ultracode is
 * xhigh effort plus standing WORKFLOW orchestration and without the tool the
 * second half cannot happen whatever the setting says.
 *
 * A one-sided indicator is still worth having. This project's rule is that a
 * signal must be able to say "bad"; it does not require that it also be able to
 * say "good".
 */
export function ultracodeWarning(requested: boolean, tools: unknown): string | undefined {
  if (!requested) return undefined
  // A CLI that reported no tool list tells us nothing either way, and inventing
  // a warning from silence is its own kind of lying.
  if (!Array.isArray(tools)) return undefined
  if (tools.includes('Workflow')) return undefined
  return 'Ultracode was requested, but this session has no Workflow tool — so its ' +
    'workflow orchestration cannot run. Workflows are off for this account, plan, ' +
    'or settings file. The xhigh effort part still applies.'
}

export interface AgentSessionOptions {
  taskId: string
  /** The worktree directory. Everything the agent does happens here. */
  cwd: string
  permissionMode: Options['permissionMode']
  /** The in-process board MCP server from createBoardServer(). */
  boardServer: NonNullable<Options['mcpServers']>[string]
  /** Fully-qualified board tool names to auto-allow, from boardToolNames().
   *  Never hand-written: see AUTO_ALLOW_BUILTIN. */
  boardTools?: string[]
  /** Extra guidance appended to the Claude Code system prompt. */
  appendSystemPrompt?: string
  /** Resume a previous Claude session. */
  resume?: string
  /** Explicit path to the `claude` binary; auto-detected when omitted. */
  /**
   * How long a run stays open after a turn when a background agent has reported
   * back but the CLI has not yet started the follow-up turn it owes on that
   * notification. Probed at ~6ms; 10s by default. It exists for the case the
   * probe could not rule out — two notifications answered in ONE turn — where
   * the count of turns owed would otherwise hold the run open forever.
   */
  followUpGraceMs?: number
  claudeExecutable?: string
  /** Extra environment for the CLI process; merged over the update guards. */
  env?: Record<string, string>
  /** Variables to DROP from the inherited environment — how a provider profile
   *  says "not mine". Without it an ambient provider flag survives a switch and
   *  the session runs somewhere the board is not naming. See `agentEnv`. */
  envClear?: readonly string[]
  /** The provider profile this run was started under, so the run can check what
   *  the CLI actually resolved against what we asked for. Not used to configure
   *  anything — `env`/`envClear` already carry that. */
  provider?: ProviderProfile
  /**
   * What a custom endpoint's models cost and how big their windows are.
   *
   * The live path has to use the SAME arithmetic as the transcript path or the
   * figure changes when a run ends — the rule this project already has a
   * postmortem about. `SessionStore` gets the identical book; both go through
   * `costOfUsage`.
   */
  modelBook?: ModelBook
  model?: string
  effort?: EffortLevel
  /** 'enabled' means OMIT the option and keep the model's adaptive default. */
  thinking?: ThinkingMode
  /**
   * Ultracode: xhigh effort plus standing dynamic-workflow orchestration.
   *
   * Passed through `Options.settings`, which is a LAYER over the user's
   * settings files rather than a replacement — it sits above user/project/local
   * and below managed policy, so an organisation that disables workflows still
   * wins. Only offered on a model whose effort levels include `xhigh`; see
   * `ultracodeFor` and `checkFlagSettings` for why that gate and the read-back
   * are both needed.
   */
  ultracode?: boolean
  /** Claude Code's fast mode. Only offered when the model reports it. */
  fastMode?: boolean
  /** Where to report something the user cannot act on but a maintainer can —
   *  currently a spend estimate that disagrees with the bill. */
  log?: (message: string) => void
}

export class AgentSession extends EventEmitter implements AgentRun {
  readonly taskId: string
  /** Which agent program this session runs on. Fixed here; `AgentManager`
   *  reads it rather than assuming, so a card can say what it is running. */
  readonly runtime = 'claude' as const
  private readonly opts: AgentSessionOptions
  private readonly queue = new MessageQueue()
  private readonly abort = new AbortController()
  private readonly permissions = new Map<string, PermissionRequest>()
  private q?: Query
  private _state: AgentState = { kind: 'idle' }
  /**
   * Background tasks the CLI says are live, task id → description, kept from
   * the SDK's `task_started`, `task_updated`, `background_tasks_changed` and
   * `task_notification` system frames. Non-ambient only: the CLI's own
   * housekeeping tasks are flagged and must not hold a run open.
   *
   * These frames were dropped on the floor (`default: break`), so the run had
   * no idea a subagent was still working when the turn's `result` arrived, and
   * `finish()` stopped the process — with the agent's notification already
   * queued as the next user message. Probed against the real CLI: kept alive, it
   * runs that follow-up turn on its own (a fresh `init`, the answer, a second
   * `result`). Killed, the answer is lost and "nothing came back".
   */
  private liveTasks = new Map<string, string>()
  /** Notifications seen since this turn began. Each is a user message the CLI
   *  has QUEUED and will run a turn on when the current one ends, so a result
   *  with one of these outstanding is not the end of the run. */
  private followUpsDue = 0
  private graceTimer: ReturnType<typeof setTimeout> | undefined
  /** The last turn's summary and billed figure — what `done` reports when the
   *  run finally finishes, which may be several turns after the first result. */
  private lastTurn: { summary: string; costUsd?: number } | undefined
  private _sessionId?: string
  /** `AccountInfo.apiProvider` — where the tokens are actually going. Asked once
   *  per run, never per frame. */
  private _resolvedProvider?: string
  private text = ''
  private readonly toolNames = new Map<string, string>()
  private sawCommit = false
  /** Set by interrupt(), so the run loop unwinding is not reported as a crash. */
  private interrupted = false
  /** Follow-ups sent into a running turn, not yet acted on. */
  private readonly pending: string[] = []
  /** Per-step context fill. NEVER overwritten from the result chunk, which is
   *  cumulative across the whole session and would read wildly high. */
  private lastContextTokens = 0
  private contextWindow: number | undefined
  /** The model the MAIN thread last ran on, from its assistant frames — the key
   *  the result chunk's `modelUsage` is matched against. Never a subagent's:
   *  their windows are their own, and one of them is exactly the 200K
   *  background model this exists to not match. */
  private lastMainModel: string | undefined
  /**
   * What this run has spent, by API response, for the turn in progress.
   *
   * Keyed by `message.id` rather than accumulated, because a streaming response
   * is written as one assistant frame per content block and **every frame
   * repeats the same cumulative usage for the whole response**. Adding them up
   * charges a three-block answer three times: on a real session, 57 frames
   * carried 21 responses. Keying by id makes a repeat frame an overwrite.
   */
  private readonly turnCosts = new Map<string, number>()
  /** The last frame that carried no `message.id`, so consecutive identical
   *  ones can be merged exactly like the disk path does (`summariseUsage`).
   *  The two must agree, or the number on the board changes when a run ends. */
  private lastNoIdSpend: { key: string; model: string; usage: TokenUsage } | undefined
  /** Turns that have ended, so their cost can no longer change. */
  private billedUsd = 0
  /** Models seen with no published rate. Their tokens are real spend that this
   *  total is missing, so the board says "at least" instead of pretending. */
  private readonly unpricedModels = new Set<string>()
  /** When the CLI last said anything at all — any frame, main thread or
   *  subagent. The board shows the AGE of this, so "working" can be checked
   *  rather than believed: a pulsing dot cannot tell you whether it last moved
   *  three seconds ago or three minutes ago. */
  private lastEventAt = 0
  /** What the subagent is doing right now, for the status line. */
  private subagentTool: string | undefined

  constructor(opts: AgentSessionOptions) {
    super()
    this.opts = opts
    this.taskId = opts.taskId
  }

  get state(): AgentState { return this._state }

  /** When the CLI last emitted anything, or 0 before it has. The board turns
   *  this into "· 12s", which is the only claim about liveness it can make that
   *  the user is able to check. */
  get lastEvent(): number { return this.lastEventAt }
  get sessionId(): string | undefined { return this._sessionId }

  private setState(s: AgentState): void {
    this._state = s
    this.emit('state', s)
  }

  /** Start the session. Resolves when the run finishes. */
  async run(firstPrompt: string, images: readonly AttachedImage[] = []): Promise<void> {
    this.setState({ kind: 'starting' })
    this.queue.push(userContent(firstPrompt, images))

    const options: Options = {
      cwd: this.opts.cwd,
      model: this.opts.model,
      permissionMode: this.opts.permissionMode,
      abortController: this.abort,
      // Without this the transcript arrives one lump per turn instead of
      // streaming, which is what made the UI feel dead between tool calls.
      includePartialMessages: true,
      // And without THIS a Task subagent forwards only its tool_use blocks, so
      // a subagent that spends four minutes reading and thinking emits nothing
      // the board can show. Every frame it produces carries `parent_tool_use_id`
      // and handle() routes on that, so none of it lands in the main thread.
      forwardSubagentText: true,
      // File checkpoints are what make "try again from here" possible: the CLI
      // snapshots the tracked files before each user turn, into its own
      // file-history store, so the board can put the worktree back to the
      // state any past message was sent into. Local bookkeeping on the CLI's
      // side of the fence — nothing is written to the user's repository. A
      // session run before this flag existed simply has no checkpoints, and
      // the rewind affordance says so instead of pretending.
      enableFileCheckpointing: true,
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.effort ? { effort: this.opts.effort } : {}),
      // 'enabled' deliberately sends nothing: omitting the option is what keeps
      // the model on adaptive thinking. Only an explicit opt-out is sent.
      ...(this.opts.thinking === 'disabled' ? { thinking: { type: 'disabled' as const } } : {}),
      mcpServers: { board: this.opts.boardServer },
      canUseTool: (toolName, input) => this.decide(toolName, input),
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        ...(this.opts.appendSystemPrompt ? { append: this.opts.appendSystemPrompt } : {}),
      },
      ...(this.opts.resume ? { resume: this.opts.resume } : {}),
    }

    // A LAYER, not a replacement: `Options.settings` sits above the user's
    // settings files and below managed policy, so this cannot override an
    // organisation that has turned workflows off — which is the correct
    // precedence and the reason it is safe to send at all.
    const flags: Record<string, boolean> = {}
    if (this.opts.ultracode) flags.ultracode = true
    if (this.opts.fastMode) flags.fastMode = true
    if (Object.keys(flags).length) options.settings = flags

    options.env = agentEnv(process.env, this.opts.env ?? {}, this.opts.envClear ?? [])

    const exe = await resolveClaudeExecutable(this.opts.claudeExecutable)
    if (!exe) {
      const message =
        'Could not find the `claude` executable. Install Claude Code (https://claude.com/claude-code) ' +
        'or set "agentsKanban.claudeExecutable" to its path.'
      this.setState({ kind: 'error', message })
      this.emit('error', message)
      return
    }
    options.pathToClaudeCodeExecutable = exe

    try {
      const { query } = await loadSdk()
      this.q = query({ prompt: this.queue, options })
      this.checkProvider(this.q)
      for await (const msg of this.q) this.handle(msg)
    } catch (e) {
      if (this.abort.signal.aborted || this.interrupted) {
        this.setState({ kind: 'idle' })
      } else {
        const message = e instanceof Error ? e.message : String(e)

        this.setState({ kind: 'error', message })
        this.emit('error', message)
      }
    } finally {
      this.queue.close()
      for (const p of this.permissions.values()) {
        p.resolve({ behavior: 'deny', message: 'Session ended.' })
      }
      this.permissions.clear()
    }
  }

  /**
   * Ask the CLI which backend it actually ended up on.
   *
   * Everything in `envForProfile()` writes environment variables and hopes.
   * This is the half that closes the loop: `accountInfo()` reports the resolved
   * `apiProvider`, so a profile that was silently outranked — by a managed
   * settings file, an `apiKeyHelper`, or an `env` block in
   * `~/.claude/settings.json` — shows up as a disagreement instead of a board
   * that confidently names the wrong provider.
   *
   * Deliberately fire-and-forget, and deliberately once:
   *
   *  - Not awaited before the message loop, because it is a control round trip
   *    to the child and blocking the loop on it would delay the first token of
   *    every turn for a number that is only ever displayed.
   *  - Never in `handle()`. That runs per streamed frame, and this is exactly
   *    the kind of per-token work the repaint budget exists to keep out.
   *  - Failure is silent by design. An older CLI has no `accountInfo` control
   *    request at all, and "we could not determine the provider" must not turn
   *    into a failed agent run. The board simply shows nothing rather than a
   *    guess.
   */
  private checkProvider(q: Query): void {
    Promise.resolve(q.accountInfo?.())
      .then((info) => {
        const actual = (info as { apiProvider?: string } | undefined)?.apiProvider
        if (!actual) return
        this._resolvedProvider = actual
        this.emit('provider', actual, resolvedLabel(actual))
        const profile = this.opts.provider
        if (!profile) return
        const { ok, message } = reconcileProvider(profile, actual)
        if (!ok && message) this.opts.log?.(message)
      })
      .catch(() => { /* older CLI, or the run ended first. Not worth a word. */ })
  }

  /** Where this run's tokens are actually going, or undefined before the CLI
   *  has said. Never inferred from the profile — see `checkProvider`. */
  get resolvedProvider(): string | undefined { return this._resolvedProvider }

  /**
   * Did the flag settings we asked for actually take?
   *
   * They are a REQUEST, and nothing about the request path can refuse: measured
   * against a real CLI, `applyFlagSettings()` resolves for `ultracode: true` on
   * a model with no xhigh, for `ultracode: 'banana'`, and for a key that does
   * not exist. So a toggle wired straight to it would be a control that cannot
   * say no — which is what this project forbids everywhere else.
   *
   * The one observable is the tool list on `system/init`. Ultracode is xhigh
   * effort plus standing WORKFLOW orchestration, and it requires workflows to
   * be enabled — so if the `Workflow` tool is absent from the session the CLI
   * just built, ultracode cannot do the half it is named for, whatever the
   * setting says. That is reported rather than assumed.
   *
   * Deliberately narrow. It does NOT claim ultracode is active when `Workflow`
   * IS present — the tool is there on ordinary sessions too (verified), so its
   * presence proves nothing. Only its absence is evidence, and only absence is
   * reported. An indicator that can say "bad" and nothing else is still worth
   * more than one that can only say "fine".
   */
  private checkFlagSettings(init: { tools?: unknown }): void {
    const message = ultracodeWarning(this.opts.ultracode === true, init.tools)
    if (!message) return
    this.opts.log?.(message)
    this.emit('flagWarning', message)
  }

  /**
   * A frame from inside a Task.
   *
   * Deliberately narrow: it moves the status line and nothing else. The nested
   * conversation is rendered from the session file by SessionStore.transcript(),
   * which has the whole thing and does not have to reconstruct it from a
   * stream — so all this has to do is answer "is it still moving, and on what".
   */
  private handleSubagent(msg: SDKMessage): void {
    if (msg.type !== 'assistant') return
    const content = (msg.message as { content?: unknown }).content
    if (!Array.isArray(content)) return
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        this.subagentTool = prettyTool(block.name)
      } else if (block.type === 'text' || block.type === 'thinking') {
        // Text with no tool call still proves it is alive; say so without
        // claiming a tool is running that is not.
        this.subagentTool ??= 'thinking'
      }
    }
    if (this._state.kind === 'working') {
      this.setState({ ...this._state, ...(this.subagentTool ? { subagent: this.subagentTool } : {}) })
    }
  }

  private handle(msg: SDKMessage): void {
    this.lastEventAt = Date.now()
    // Money BEFORE routing, and this ordering is the whole point: a subagent's
    // tokens are billed exactly like the main thread's, and the routing below
    // returns early for them. Pricing inside the assistant case instead left
    // every Task out of the total — the live figure came to two thirds of what
    // the same frames priced to when the session was read back from disk, so
    // the number on the board CHANGED when the run ended.
    if (msg.type === 'assistant') {
      const priced = msg.message as unknown as { id?: string; model?: string; usage?: TokenUsage }
      if (priced.usage) this.recordSpend(priced.id, priced.model, priced.usage)
    }
    // Anything a Task's subagent produces is stamped with the id of the
    // tool_use that started it. It must not be folded into the main thread: its
    // text is not the agent's answer, and appending it to `this.text` would put
    // a subagent's working notes into the session summary.
    const parent = (msg as { parent_tool_use_id?: string | null }).parent_tool_use_id
    if (parent) { this.handleSubagent(msg); return }
    // Back on the main thread, so no subagent is running any more.
    this.subagentTool = undefined
    // A main-thread frame while WAITING is the follow-up turn beginning: the
    // CLI dequeued a notification and is answering it. The probe saw a fresh
    // `init` first, but any frame of the turn is proof enough.
    if (this._state.kind === 'waiting' && (msg.type === 'system' || msg.type === 'assistant' || msg.type === 'stream_event')) {
      const sub = (msg as { subtype?: string }).subtype
      if (msg.type !== 'system' || sub === 'init') this.turnStarted()
    }
    // And this frame's model is the MAIN thread's — the only model whose
    // context window is this session's meter. Captured here, after the
    // subagent early-return, precisely so a Task's frames can never set it;
    // one of theirs is the 200K background model the window match exists to
    // exclude. Synthetic frames (`<synthetic>`) never went to the API and name
    // no model.
    if (msg.type === 'assistant') {
      const m = (msg.message as { model?: unknown }).model
      if (typeof m === 'string' && m && m !== SYNTHETIC_MODEL) this.lastMainModel = m
    }
    switch (msg.type) {
      case 'system': {
        if ('subtype' in msg && msg.subtype === 'init' && 'session_id' in msg) {
          // Announced ONCE. Every follow-up turn the CLI runs on a background
          // agent's notification opens with another `init` carrying the same
          // id, and re-announcing it would re-run the manager's adoption and
          // rename for a card that already has them.
          if (this._sessionId !== msg.session_id) {
            this._sessionId = msg.session_id as string
            this.emit('sessionId', this._sessionId)
          }
          this.checkFlagSettings(msg as unknown as { tools?: unknown })
        }
        this.trackTask(msg as unknown as Record<string, unknown>)
        // After a compaction there is no assistant message, so the meter would
        // stay pinned at the pre-compaction figure. Reset it explicitly.
        if ('subtype' in msg && msg.subtype === 'compact_boundary') {
          this.lastContextTokens = 0
          this.emit('usage', 0, this.contextWindow)
        }
        break
      }
      case 'stream_event': {
        const ev = (msg as { event?: { type?: string; delta?: Record<string, unknown> } }).event
        const delta = ev?.delta
        if (ev?.type === 'content_block_delta' && delta) {
          if (typeof delta.text === 'string') this.emit('partial', delta.text)
          else if (typeof delta.thinking === 'string') this.emit('thinking', delta.thinking)
        }
        break
      }
      case 'assistant': {
        // Context fill comes from the PER-STEP usage on assistant chunks.
        // result.usage is cumulative across every step and is not context fill.
        const body = msg.message as unknown as { id?: string; model?: string; usage?: TokenUsage }
        const usage = body.usage
        // Context fill only. The cost was recorded before the routing above,
        // for main-thread and subagent frames alike.
        if (usage) {
          this.lastContextTokens = contextOfUsage(usage)
          this.emit('usage', this.lastContextTokens, this.contextWindow)
        }
        const content = (msg.message as { content?: unknown }).content
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type === 'thinking' && typeof block.thinking === 'string') {
              this.emit('thinking', block.thinking)
            } else if (block.type === 'text' && typeof block.text === 'string') {
              this.text += block.text
              this.emit('text', block.text)
              this.setState({ kind: 'working' })
            } else if (block.type === 'tool_use' && typeof block.name === 'string') {
              if (typeof block.id === 'string') this.toolNames.set(block.id, block.name)
              const input = (block.input ?? {}) as Record<string, unknown>
              // A commit is how work leaves the agent's hands, so surface it.
              if (typeof input.command === 'string' && /\bgit\s+commit\b/.test(input.command)) {
                this.sawCommit = true
              }
              this.emit('tool', block.name, block.input)
              this.setState({ kind: 'working', tool: prettyTool(block.name) })
            }
          }
        }
        break
      }
      case 'user': {
        // Tool results come back as user-role messages carrying tool_result blocks.
        const content = (msg.message as { content?: unknown }).content
        if (Array.isArray(content)) {
          for (const block of content as Array<Record<string, unknown>>) {
            if (block.type !== 'tool_result') continue
            this.emit('toolResult', String(block.tool_use_id), block.is_error !== true)
          }
        }
        break
      }
      case 'result': {
        // An interrupted turn comes back as a RESULT with is_error set — the CLI
        // reporting that it stopped, not that anything went wrong. Reporting it
        // as a failure put a red card on the board for a button the user pressed
        // on purpose.
        const r = msg as {
          subtype?: string; result?: string; total_cost_usd?: number; is_error?: boolean
          modelUsage?: Record<string, { contextWindow?: number }>
        }
        // The result chunk is the only place the model's context window
        // appears — but `modelUsage` has one entry PER MODEL, and the CLI's
        // haiku-class background model (title generation) is in there too,
        // FIRST. Taking the first entry measured every 1M session against
        // Haiku's 200K. The window is the MAIN model's or nothing; on nothing,
        // the previous value stands and downstream falls back to the sidecar
        // and the table, which are at least about the right model.
        const main = this.lastMainModel ?? this.opts.model
        /* The run's own report first, then what the model's endpoint published.
           Off first-party there was no second source at all: `MODEL_WINDOWS` is
           keyed by Anthropic's ids, so a session on a custom endpoint whose CLI
           did not report a window drew no meter — a fill with no denominator,
           which the view correctly renders as nothing. */
        const window = mainWindowOf(r.modelUsage, main)
          ?? (main ? windowFor(main, this.opts.modelBook) : undefined)
        if (window) this.contextWindow = window
        this.emit('usage', this.lastContextTokens, this.contextWindow)
        // The turn is over: its cost can no longer change, whether it ended by
        // finishing, failing or being interrupted. All three are billed.
        this.settleTurn(r.total_cost_usd)
        // The turn is over, so nothing is still waiting behind it.
        this.clearPending()

        // An interrupted turn comes back as a result with is_error set — the CLI
        // reporting that it stopped, not that anything went wrong. Both halves
        // are required: a turn that finished successfully in the moment between
        // the click and q.interrupt() must still be reported as done, or its
        // result is thrown away and the run never finishes.
        const wasInterrupted = this.interrupted
        this.interrupted = false
        if (wasInterrupted && r.is_error) {
          this.setState({ kind: 'idle' })
          this.emit('interrupted')
          break
        }

        if (r.is_error) {
          const message = r.result || 'The agent run failed.'
          this.setState({ kind: 'error', message })
          this.emit('error', message)
        } else {
          if (this.sawCommit) { this.sawCommit = false; this.emit('committed') }
          const summary = r.result || this.text.slice(-2000) || 'Finished.'
          this.lastTurn = { summary, ...(r.total_cost_usd !== undefined ? { costUsd: r.total_cost_usd } : {}) }
          /* The TURN is over. Whether the RUN is depends on what the CLI told
             us about background tasks: an agent still working, or a notification
             it has queued and owes a turn on, means the process must stay alive
             for that turn — the one that carries the agent's findings back. */
          if (this.turnStillOpen()) { this.enterWaiting(); break }
          this.finishRun()
        }
        break
      }
      default:
        break
    }
  }

  /**
   * Price one API response and republish the running total.
   *
   * Called from the top of `handle`, ahead of the `parent_tool_use_id` routing,
   * so a Task's responses are billed as well as the main thread's. Only their
   * TEXT is kept apart; their tokens are not.
   */
  private recordSpend(id: string | undefined, model: string | undefined, usage: TokenUsage): void {
    const cost = costOfUsage(model ?? '', usage, this.opts.modelBook)
    if (cost === undefined) this.unpricedModels.add(model || 'unknown')
    // Same merge as the disk path: frames of one streamed response are
    // deduplicated by `message.id`, and every frame repeats the same
    // cumulative usage. With no id, consecutive frames whose usage is
    // IDENTICAL are one response's blocks — merging them is charge-neutral
    // (`sameUsage`), it can only undo an overcount — while different usage is
    // a different response and counts separately.
    const modelName = model ?? ''
    let key: string
    if (id) {
      this.lastNoIdSpend = undefined
      key = id
    } else {
      const prev = this.lastNoIdSpend
      if (prev && prev.model === modelName && sameUsage(prev.usage, usage)) {
        key = prev.key
      } else {
        key = `@${this.turnCosts.size}`
        this.lastNoIdSpend = { key, model: modelName, usage }
      }
    }
    this.turnCosts.set(key, cost ?? 0)
    this.emitSpend()
  }

  /**
   * Both spend readouts, from one place.
   *
   * `spend` is the original event and is unchanged. `meter` is the same figure
   * in the runtime-neutral shape every agent runtime reports — see `Meter` in
   * `runtime.ts`, which is a union because a subscription session has no dollar
   * figure it can defend and must not be shown a fabricated one. Claude Code
   * sessions are always the `usd` case; emitting both keeps the board's two
   * paths reading the same number rather than two arithmetics that can drift.
   */
  private emitSpend(): void {
    const priced = this.unpricedModels.size === 0
    this.emit('spend', this.spentUsd, priced)
    this.emit('meter', { kind: 'usd', spentUsd: this.spentUsd, priced } satisfies Meter)
  }

  /** The runtime-neutral view of this session's spend. */
  get meter(): Meter {
    return { kind: 'usd', spentUsd: this.spentUsd, priced: this.unpricedModels.size === 0 }
  }

  /** What this session has spent, ended turns plus the one in progress. */
  get spentUsd(): number {
    let sum = this.billedUsd
    for (const c of this.turnCosts.values()) sum += c
    return sum
  }

  /**
   * Close the books on a turn, and check our arithmetic against the bill.
   *
   * `total_cost_usd` is what the service actually charged, so a large
   * disagreement means the price table here is wrong — a model repriced, a new
   * cache tier, a rate that moved. The board keeps showing the computed figure,
   * because it is the only one that exists between turn ends and after a
   * restart, and the same arithmetic totals a session read back from disk; but
   * a mismatch is worth saying out loud rather than absorbing silently.
   */
  private settleTurn(billedUsd: number | undefined): void {
    let turn = 0
    for (const c of this.turnCosts.values()) turn += c
    this.turnCosts.clear()
    this.billedUsd += turn
    if (billedUsd !== undefined && this.unpricedModels.size === 0 && billedUsd > 0.01) {
      const drift = Math.abs(this.billedUsd - billedUsd) / billedUsd
      if (drift > 0.2) {
        this.opts.log?.(
          `Spend estimate is ${(drift * 100).toFixed(0)}% off the billed figure ` +
          `(computed $${this.billedUsd.toFixed(4)}, billed $${billedUsd.toFixed(4)}). ` +
          `The rate table is out of date: MODEL_RATES in sessions/usage.ts, or the ` +
          `prices this model's endpoint published (agentsKanban.providers).`,
        )
      }
    }
    this.emitSpend()
  }

  /** Is this a tool the agent may use without stopping to ask? */
  private autoAllowed(toolName: string): boolean {
    return AUTO_ALLOW_BUILTIN.has(toolName) || (this.opts.boardTools ?? []).includes(toolName)
  }

  /** The permission gate. Auto-allow the safe set; surface everything else. */
  private decide(toolName: string, input: Record<string, unknown>): Promise<PermissionResult> {
    if (this.autoAllowed(toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    return new Promise<PermissionResult>((resolve) => {
      const id = `${this.taskId}:${this.permissions.size}:${Date.now()}`
      const req: PermissionRequest = {
        id,
        toolName,
        input,
        resolve: (r) => { this.permissions.delete(id); resolve(r) },
      }
      this.permissions.set(id, req)
      this.setState({ kind: 'needsInput', question: describe(toolName, input), requestId: id })
      this.emit('permission', req)
    })
  }

  /** Answer a pending permission request from the UI.
   *
   * `selections` exists for AskUserQuestion, where allowing the tool is NOT the
   * same as answering it. Passing the input straight back — which is all this
   * did — left the tool with no `answers` key, so it reported that the user had
   * not answered and the agent carried on without the decision it stopped to
   * ask for. See board/questions.ts. */
  answerPermission(
    id: string,
    allow: boolean,
    reason?: string,
    selections?: Record<string, string[]>,
  ): boolean {
    const req = this.permissions.get(id)
    if (!req) return false
    req.resolve(
      allow
        ? { behavior: 'allow', updatedInput: this.inputWith(req, selections) }
        : {
            behavior: 'deny',
            message: reason ?? (parseAskQuestions(req.toolName, req.input)
              ? 'The user skipped this question.'
              : 'The user declined this action.'),
          },
    )
    /* Only back to `working` if nothing else is waiting.
       `this.permissions` is a Map and both runtimes can hold several at once —
       `interrupt()` loops over its values denying every one, which is code that
       only makes sense if two can be outstanding. Setting `working`
       unconditionally meant that answering one request told the board the agent
       was thinking again while the CLI was still blocked inside `canUseTool`
       for another, and the manager's state listener then dropped the pending
       slot, so the survivor lost the only surface that could answer it. The
       board's only remaining truth was the frame age climbing. */
    const next = this.permissions.values().next().value
    if (next) {
      this.setState({ kind: 'needsInput', question: describe(next.toolName, next.input), requestId: next.id })
      // Re-announce it, so a board that lost track of it while another request
      // was on screen gets it back.
      this.emit('permission', next)
    } else {
      this.setState({ kind: 'working' })
    }
    return true
  }

  /** Merge the user's picker selections into the tool input.
   *
   * Guarded on the tool itself, not merely on a payload having turned up:
   * `answers` means something only to AskUserQuestion, and writing it into any
   * other tool's input would corrupt arguments the agent is about to act on.
   * The webview cannot reach another tool today, but this is a boundary and
   * boundaries go in code, not in the caller's good intentions.
   *
   * The answer strings are also rebuilt HERE, from the questions as the tool
   * actually stated them, rather than trusted as sent. The webview posts what
   * the user picked; what the model is told they picked is decided host-side. */
  private inputWith(
    req: PermissionRequest,
    selections?: Record<string, string[]>,
  ): Record<string, unknown> {
    if (!selections) return req.input
    const questions = parseAskQuestions(req.toolName, req.input)
    if (!questions) return req.input
    const answers = buildAskAnswers(questions, selections)
    return Object.keys(answers).length ? { ...req.input, answers } : req.input
  }

  /**
   * Send a follow-up message into a running session.
   *
   * It is handed straight to the CLI, which holds it until the current turn
   * ends — so from the user's side it has been sent and nothing happens for a
   * while. `pending` is what the UI shows in that gap; the SDK drains our own
   * queue the instant we push, so watching that queue showed nothing, ever.
   */
  send(text: string, images: readonly AttachedImage[] = []): void {
    this.queue.push(userContent(text, images))
    // The queue readout is about what the agent still has to answer, so an
    // images-only follow-up is described rather than shown as a blank line.
    this.pending.push(text.trim() || `(${describeImages(images.length)})`)
    this.setState({ kind: 'working' })
    this.emit('queued', [...this.pending])
  }

  private clearPending(): void {
    if (!this.pending.length) return
    this.pending.length = 0
    this.emit('queued', [])
  }

  /** Forget follow-ups the user no longer wants. Only those we still hold can
   *  actually be recalled; the rest is an honest best effort. */
  clearQueue(): number {
    const held = this.queue.clear()
    const shown = this.pending.length
    this.clearPending()
    return Math.max(held, shown)
  }

  /**
   * Stop the current turn, keeping the session alive and resumable.
   *
   * Distinct from stop(), and the distinction is the point: interrupt ends what
   * the agent is doing now and leaves you able to say something else, which is
   * what you want nine times out of ten. stop() aborts the process.
   */
  async interrupt(): Promise<void> {
    // Nothing to interrupt yet: the CLI has not started, so there is no turn to
    // end and nothing worth preserving. Claiming an interrupt here left the flag
    // set for the whole run, and the eventual result was then discarded as if
    // the user had stopped it — no `done`, no cost, and `drain()` never ran, so
    // anything queued behind maxConcurrentAgents never started at all.
    if (!this.q) { this.stop(); return }

    this.interrupted = true
    // Anything queued was meant for the turn being abandoned.
    this.queue.clear()
    for (const p of this.permissions.values()) {
      p.resolve({ behavior: 'deny', message: 'The user interrupted.' })
    }
    this.permissions.clear()
    this.clearPending()
    try { await this.q?.interrupt() } catch { /* not in streaming mode yet */ }
    this.setState({ kind: 'idle' })
  }

  /**
   * Change the permission mode of a RUNNING session.
   *
   * Only works in streaming-input mode, which is the other reason the prompt is
   * an AsyncIterable rather than a string.
   */
  async setPermissionMode(mode: NonNullable<Options['permissionMode']>): Promise<boolean> {
    try {
      await this.q?.setPermissionMode(mode)
      return true
    } catch {
      return false
    }
  }

  /** Tear the session down for good. */
  stop(): void {
    this.clearGrace()
    this.abort.abort()
    this.queue.close()
  }

  // --- background tasks: what keeps a run open past its turn ------------------

  /** Keep `liveTasks` in step with the CLI's task frames. Ambient tasks — the
   *  CLI's own watchers — are excluded everywhere: they are not the user's work
   *  and would otherwise hold every run open. */
  private trackTask(m: Record<string, unknown>): void {
    const sub = m.subtype
    const id = typeof m.task_id === 'string' ? m.task_id : undefined
    const name = () => (typeof m.description === 'string' && m.description) || id || 'background task'
    if (sub === 'task_started' && id && m.is_backgrounded === true && m.ambient !== true) {
      this.liveTasks.set(id, name())
    } else if (sub === 'background_tasks_changed' && Array.isArray(m.tasks)) {
      // REPLACE semantics, as the SDK declares: this is every live task.
      this.liveTasks = new Map(
        (m.tasks as Array<Record<string, unknown>>)
          .filter((t) => t.ambient !== true && typeof t.task_id === 'string')
          .map((t) => [t.task_id as string, (typeof t.description === 'string' && t.description) || (t.task_id as string)]),
      )
    } else if (sub === 'task_updated' && id) {
      const st = (m.patch as { status?: unknown } | undefined)?.status
      if (st === 'completed' || st === 'failed' || st === 'killed') this.liveTasks.delete(id)
    } else if (sub === 'task_notification' && id && m.ambient !== true) {
      // The agent reported back. The CLI has queued this as the next user
      // message and OWES a turn on it — that turn is where the answer reaches
      // the parent, and it is exactly the turn that used to be killed.
      this.liveTasks.delete(id)
      this.followUpsDue++
    } else {
      return
    }
    this.reconsiderWaiting()
  }

  /** Is this turn's `result` the end of the run, or only of the turn? */
  private turnStillOpen(): boolean {
    return this.liveTasks.size > 0 || this.followUpsDue > 0
  }

  private enterWaiting(): void {
    const on = [...this.liveTasks.values()]
    this.setState({ kind: 'waiting', tasks: on.length, ...(on[0] ? { on: on[0] } : {}) })
    this.emit('waiting', on)
    // Nothing live, only a turn owed: the CLI starts it within milliseconds. If
    // it does not — two notifications answered in one turn, say — the grace
    // timer finishes the run rather than leaving it "waiting" for ever.
    if (!on.length) this.armGrace()
  }

  /** While waiting, every task frame re-asks the question. */
  private reconsiderWaiting(): void {
    if (this._state.kind !== 'waiting') return
    if (this.liveTasks.size) {
      this.clearGrace()
      const on = [...this.liveTasks.values()]
      this.setState({ kind: 'waiting', tasks: on.length, on: on[0]! })
    } else {
      // Nothing live. NOT the end yet: the probe recorded the CLI emptying its
      // list (`background_tasks_changed []`) a few milliseconds BEFORE the
      // agent's notification and the follow-up turn — finishing here killed
      // that turn in the test for exactly this case. The grace timer decides:
      // a turn arrives and cancels it, or nothing does and the run is over.
      this.armGrace()
    }
  }

  /** The follow-up turn began: one notification has been consumed. */
  private turnStarted(): void {
    this.clearGrace()
    if (this.followUpsDue > 0) this.followUpsDue--
    this.setState({ kind: 'working' })
  }

  private armGrace(): void {
    this.clearGrace()
    const t = setTimeout(() => {
      this.graceTimer = undefined
      if (this._state.kind !== 'waiting' || this.liveTasks.size) return
      this.followUpsDue = 0
      this.finishRun()
    }, this.opts.followUpGraceMs ?? 10_000)
    ;(t as { unref?: () => void }).unref?.()
    this.graceTimer = t
  }

  private clearGrace(): void {
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = undefined }
  }

  /** The run is over. Reports the LAST turn — see `lastTurn`. */
  private finishRun(): void {
    this.clearGrace()
    const last = this.lastTurn ?? { summary: this.text.slice(-2000) || 'Finished.' }
    this.setState({ kind: 'done', summary: last.summary, ...(last.costUsd !== undefined ? { costUsd: last.costUsd } : {}) })
    // Three arguments, in the shape `RunEvents.done` declares: the session's
    // meter, then this TURN's dollars. This used to pass `r.total_cost_usd` in
    // the meter's slot — a bare number where the other runtime put a `Meter` —
    // and the webview called `.toFixed(2)` on whichever arrived. See `parseMeter`.
    this.emit('done', last.summary, this.meter, last.costUsd)
  }
}

function prettyTool(name: string): string {
  return name.startsWith('mcp__board__') ? name.slice('mcp__board__'.length) : name
}

function describe(toolName: string, input: Record<string, unknown>): string {
  const target =
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.command === 'string' && input.command) ||
    (typeof input.path === 'string' && input.path) ||
    ''
  return target ? `${prettyTool(toolName)}: ${String(target).slice(0, 160)}` : prettyTool(toolName)
}
