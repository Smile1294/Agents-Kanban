/** Codex as a second agent runtime.
 *
 * Codex is not a provider and never was: it is a sibling of Claude Code — an
 * agent program you sign into, with its own protocol, its own transcript store
 * and its own login. `docs/PROVIDERS.md` has said so for a while; this file is
 * the consequence.
 *
 * ## No proxy, and that is the point
 *
 * The previous answer for "I have a ChatGPT subscription" was a translation
 * proxy (LiteLLM, claude-code-router) in front of Claude Code. That answer was
 * always poor and for a specific reason: **a ChatGPT subscription cannot be
 * spent through a proxy at all.** LiteLLM needs an OpenAI *API key*, which is a
 * different credential on a different bill. The subscription's tokens live in
 * `~/.codex/auth.json` and only the Codex runtime can spend them.
 *
 * So we drive Codex directly. Nothing is configured, nothing is proxied: if
 * `codex login` has been run on this machine, sessions work. That is also why
 * `capabilities.providerProfiles` is false — a `ProviderProfile` steers Claude
 * Code's backend through environment variables, and offering that control here
 * would be a setting that cannot take effect.
 *
 * ## Why `app-server` and not `codex exec --json`
 *
 * `codex exec --json` is the simpler surface and it is the wrong one. It is a
 * one-shot: no interactive approvals, no interrupt, no adding a message to a
 * running turn. The board needs all three — permission prompts on the card are
 * a core feature, and "Stop" that cannot stop is a control that cannot say no.
 *
 * `codex app-server` is the long-lived, bidirectional JSON-RPC interface that
 * the Codex VS Code extension and desktop app themselves run on. It gives us
 * approvals as server→client requests, `turn/interrupt`, `turn/steer`,
 * `model/list` and `account/read`. See `jsonrpc.ts` for the transport.
 *
 * ## Schema drift is designed for, not assumed away
 *
 * The app-server's own docs tell integrators to regenerate types after every
 * CLI upgrade, and the two published surfaces already disagree with each other:
 * the exec event stream spells items `agent_message` and `command_execution`,
 * the app-server spells them `agentMessage` and `commandExecution`. Reading only
 * one spelling means a working transcript on one Codex version and a silently
 * empty one on the next — the failure this project has already had twice, in
 * different clothes.
 *
 * So every shape here is read through `pick()`/`itemKind()`, which accept both
 * spellings, and **anything unrecognised is reported rather than dropped**:
 * `unknownMethods` accumulates and surfaces once per run as a flag warning. A
 * transcript that quietly loses half its rows is exactly the signal that cannot
 * say bad.
 */
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { JsonRpcPeer, RpcError, type IncomingRequest } from '../jsonrpc.ts'
import { agentEnv } from '../session.ts'
import type { AgentState } from '../../board/config.ts'
import type { AttachedImage } from '../images.ts'
import { describeImages } from '../images.ts'
import type { EffortLevel } from '../../sessions/meta.ts'
import {
  type AgentRun,
  type AgentRuntime,
  type LoginState,
  type Meter,
  type ModelCatalogue,
  type PermissionMode,
  type RunSpec,
  type RuntimeLocation,
  type RuntimeModel,
} from '../runtime.ts'
import { codexHistory, codexHome } from '../../sessions/codex-store.ts'

/**
 * The built-in model list.
 *
 * Same rule as Claude's `MODELS`: this is the FALLBACK, never the answer. It
 * exists so that being offline produces a working picker rather than an empty
 * one, which reads as a broken extension. When it is in force the UI says so.
 *
 * Windows are the ones Codex itself reports on a live session
 * (`model_context_window` in the rollout's `token_count` events), not guesses.
 */
const BUILTIN_MODELS: RuntimeModel[] = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    contextWindow: 258_400,
    supportedEffort: ['low', 'medium', 'high', 'xhigh'],
    description: 'Codex default.',
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4-Mini',
    contextWindow: 258_400,
    supportedEffort: ['low', 'medium', 'high', 'xhigh'],
    description: 'Faster and cheaper against the same rate limit.',
  },
]

/** Codex's effort vocabulary, and ours.
 *
 * Codex accepts `minimal | low | medium | high | xhigh | max | ultra |
 * persistent`; the board's `EffortLevel` is `low | medium | high | xhigh | max`.
 * The overlap is exact for all five, so the mapping is identity and the extra
 * Codex levels are simply not offered — rather than being invented as board
 * concepts that Claude could never honour. Which of the five a given model
 * actually takes comes from `model/list`, never from this table. */
function effortFor(e: EffortLevel | undefined): string | undefined {
  return e
}

/**
 * The board's permission stance, in Codex's two-axis vocabulary.
 *
 * Codex splits what Claude expresses in one field into an approval policy and a
 * filesystem sandbox, so the mapping is stated once, here, and commented with
 * what each row is FOR — a table of magic strings is how the wrong sandbox ends
 * up shipped and an agent silently cannot write to its own worktree.
 *
 * `workspace-write` is right for the default case because the agent's cwd IS
 * its worktree: the sandbox boundary and the isolation boundary are the same
 * line, which is the whole reason each session gets its own checkout.
 */
export function codexPermissions(mode: PermissionMode): { approvalPolicy: string; sandbox: string } {
  switch (mode) {
    // Read-only and ask before anything else: the planning stance.
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' }
    /* Edits go through without a click, and so — on Codex — do commands.
       This row used to say "still ask for commands", and `on-failure` does not:
       it runs everything inside the sandbox WITHOUT asking and escalates only
       when something it tried has already FAILED. The adapter says as much two
       rows down, for `auto`. Codex has no policy that auto-accepts patches
       while prompting for commands, so the honest options were a true label or
       a true mapping — and the mapping is the one the sandbox makes safe: every
       command runs inside the session's own worktree, which is the boundary the
       one-worktree-per-session design draws. So the COMMENT is corrected rather
       than the policy, and `extension.ts`'s user-facing detail with it. */
    case 'acceptEdits':
      return { approvalPolicy: 'on-failure', sandbox: 'workspace-write' }
    // The user has explicitly escalated: bypass the checks. `danger-full-access`
    // is the honest Codex equivalent, and the SDK gates the Claude side behind
    // `allowDangerouslySkipPermissions` for the same reason.
    case 'bypassPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    /* `dontAsk` is NOT the same intent, and treating it as one inverted it.
       The SDK's own `.d.ts` defines it as "Don't prompt for permissions, DENY
       if not pre-approved" — deny-by-default, the opposite of
       `bypassPermissions`' "Bypass all permission checks". It shared that row,
       so a user who picked "stop prompting me, and refuse anything I have not
       allowed" silently handed Codex `danger-full-access`: no prompts AND the
       filesystem sandbox removed, so the agent could leave its own worktree —
       which is the one boundary the whole one-worktree-per-session design
       exists to draw, and which `agentsKanban.permissionMode`'s own manifest
       description tells the user is in force.
       There is no exact Codex analogue of "deny unless pre-approved", so this
       takes the half that is expressible and keeps it: never prompt, and stay
       inside the worktree. Strictly safer than the previous row, and it does
       not claim to be the same thing. */
    case 'dontAsk':
      return { approvalPolicy: 'never', sandbox: 'workspace-write' }
    // `auto` lets the runtime decide. Codex's own judgement lives in
    // `on-failure`: it acts, and asks when something it tried was refused.
    case 'auto':
      return { approvalPolicy: 'on-failure', sandbox: 'workspace-write' }
    case 'default':
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  }
}

/** Read a key that may be spelled either way the two Codex surfaces spell it. */
function pick<T = unknown>(o: Record<string, unknown> | undefined, ...keys: string[]): T | undefined {
  if (!o) return undefined
  for (const k of keys) {
    const v = o[k]
    if (v !== undefined && v !== null) return v as T
  }
  return undefined
}

/** Normalise an item type to one word, whichever spelling arrived.
 *
 *  `commandExecution` and `command_execution` are the same thing on two Codex
 *  surfaces; `thread/started` and `thread.started` likewise. Lowercasing and
 *  dropping separators makes the switch below immune to which one we get. */
function normKind(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[._/-]/g, '').toLowerCase() : ''
}

interface CodexOptionsInternal extends RunSpec {
  location: RuntimeLocation
}

/**
 * One Codex thread, driven over the app-server protocol.
 *
 * Implements `AgentRun`, so `AgentManager` cannot tell it apart from a Claude
 * session. Every event it emits means the same thing as the Claude one.
 */
export class CodexSession extends EventEmitter implements AgentRun {
  readonly taskId: string
  readonly runtime = 'codex' as const

  private readonly opts: CodexOptionsInternal
  private child?: ChildProcessWithoutNullStreams
  private rpc?: JsonRpcPeer
  private _state: AgentState = { kind: 'idle' }
  private _sessionId?: string
  private _meter: Meter = { kind: 'unknown' }
  private lastEventAt = 0
  private interrupted = false
  private stopped = false
  /** Follow-ups handed to `turn/steer`, shown until the turn moves on. */
  private readonly pending: string[] = []
  /** Approvals waiting on the user, by our own id. */
  private readonly permissions = new Map<string, { req: IncomingRequest; toolName: string }>()
  private permissionSeq = 0
  /** Text the agent has settled on this turn, for the `done` summary. */
  private finalText = ''
  /** Item ids we have already opened a tool row for, so `item/completed` can
   *  resolve the row instead of adding a second one. */
  private readonly openTools = new Map<string, string>()
  /** Notification methods this build does not know. Reported ONCE, at the end
   *  of the turn — a per-frame warning would be noise on the render path, and
   *  silence would be the drift bug. */
  private readonly unknownMethods = new Set<string>()
  private turnRunning = false
  private sawCommit = false
  private contextWindow?: number

  constructor(opts: CodexOptionsInternal) {
    super()
    this.taskId = opts.taskId
    this.opts = opts
  }

  get state(): AgentState { return this._state }
  get lastEvent(): number { return this.lastEventAt }
  get sessionId(): string | undefined { return this._sessionId }
  get meter(): Meter { return this._meter }
  /** Codex authenticates as itself; there is no backend for a profile to
   *  select, so there is nothing to reconcile and nothing to claim. */
  get resolvedProvider(): string | undefined { return undefined }

  private setState(s: AgentState): void {
    this._state = s
    this.emit('state', s)
  }

  private touch(): void { this.lastEventAt = Date.now() }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async run(firstPrompt: string, images: readonly AttachedImage[] = []): Promise<void> {
    this.setState({ kind: 'starting' })
    try {
      await this.connect()
      await this.openThread()
      await this.turn(firstPrompt, images)
    } catch (e) {
      if (this.stopped || this.interrupted) return
      this.fail(e)
    }
  }

  private async connect(): Promise<void> {
    const env = agentEnv(process.env, this.opts.env ?? {}, this.opts.envClear ?? [])
    this.child = spawn(this.opts.location.command, ['app-server'], {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams

    const rpc = new JsonRpcPeer(this.child)
    this.rpc = rpc
    rpc.on('notification', (m: string, p: Record<string, unknown>) => this.onNotification(m, p))
    rpc.on('request', (r: IncomingRequest) => this.onRequest(r))
    rpc.on('stderr', (line: string) => this.opts.log?.(`[codex] ${line}`))
    rpc.on('protocolError', (message: string, raw: string) => {
      // Not fatal: a newer server may add members we do not know. Logged in
      // full, because when a transcript does go wrong this is the only record
      // of what actually came down the wire.
      this.opts.log?.(`[codex] could not read a message (${message}): ${raw.slice(0, 400)}`)
    })
    rpc.on('exit', (code: number | null) => {
      if (this.stopped || this.interrupted) return
      if (this.turnRunning) {
        this.fail(new Error(
          `Codex exited (status ${code ?? 'unknown'}) in the middle of a turn. ` +
          'Its transcript up to this point is on disk and the session can be resumed.',
        ))
      }
    })

    // The handshake. Everything else is rejected until it completes, so this is
    // also the earliest honest "is Codex actually usable" check.
    await rpc.request('initialize', {
      clientInfo: { name: 'agents-kanban', title: 'Agents Kanban', version: '1' },
      capabilities: { experimentalApi: false },
    })
    rpc.notify('initialized', {})
    this.touch()
  }

  private async openThread(): Promise<void> {
    const rpc = this.rpc
    if (!rpc) throw new Error('Codex is not connected.')
    const perms = codexPermissions(this.opts.permissionMode)

    // A resumed session reopens its own thread rather than starting a new one,
    // or the board would show one card whose transcript restarts from nothing
    // every time it is followed up.
    if (this.opts.resume) {
      try {
        const r = await rpc.request('thread/resume', {
          threadId: this.opts.resume,
          cwd: this.opts.cwd,
          ...perms,
        }, 60_000) as Record<string, unknown>
        this._sessionId = String(pick(r, 'threadId', 'thread_id', 'id') ?? this.opts.resume)
        this.emit('sessionId', this._sessionId)
        return
      } catch (e) {
        // A thread that cannot be resumed is worth SAYING rather than silently
        // starting a fresh one under the same card: the card's history would
        // then belong to a thread nothing writes to again.
        this.opts.log?.(`[codex] could not resume thread ${this.opts.resume}: ${msg(e)} — starting a new one`)
        this.emit('flagWarning',
          `Codex could not resume the earlier thread (${msg(e)}). This turn starts a new thread, so ` +
          'the transcript above belongs to the previous one.')
      }
    }

    const started = await rpc.request('thread/start', {
      cwd: this.opts.cwd,
      ...perms,
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(effortFor(this.opts.effort) ? { reasoningEffort: effortFor(this.opts.effort) } : {}),
      ...(this.opts.appendSystemPrompt ? { instructions: this.opts.appendSystemPrompt } : {}),
      ...(this.mcpServers() ?? {}),
    }, 60_000) as Record<string, unknown>

    const id = pick<string>(started, 'threadId', 'thread_id', 'id')
      ?? pick<string>(pick<Record<string, unknown>>(started, 'thread'), 'id', 'threadId')
    if (id) {
      this._sessionId = String(id)
      this.emit('sessionId', this._sessionId)
    }
    this.touch()
  }

  /** The board's own tools, offered to Codex as an MCP server it spawns.
   *
   *  Claude Code takes an in-process server object from the Agent SDK; Codex
   *  takes a command. Same tool definitions either way — see `board-mcp.ts`,
   *  which exists so they are not written twice and cannot drift apart. */
  private mcpServers(): Record<string, unknown> | undefined {
    const stdio = this.opts.boardTools?.stdio
    if (!stdio) return undefined
    return {
      mcpServers: {
        board: {
          command: stdio.command,
          args: stdio.args,
          ...(stdio.env ? { env: stdio.env } : {}),
        },
      },
    }
  }

  private async turn(prompt: string, images: readonly AttachedImage[]): Promise<void> {
    const rpc = this.rpc
    if (!rpc) throw new Error('Codex is not connected.')
    this.turnRunning = true
    this.setState({ kind: 'working' })
    try {
      // No timeout: a turn legitimately runs for minutes, and the board already
      // shows the age of the last frame for the case where it should not be.
      await rpc.request('turn/start', {
        threadId: this._sessionId,
        input: this.inputFor(prompt, images),
      }, 0)
    } finally {
      this.turnRunning = false
    }
  }

  /**
   * A user message in Codex's input shape.
   *
   * Images are the one place this runtime cannot honour the board's rule that
   * an attachment goes to the model and never to a file: Codex takes
   * `local_image` by PATH. Rather than staging files into the user's repository
   * — which the project's own rules forbid — pasted images are described and
   * the user is told, once, that this runtime cannot take them inline. Saying
   * so beats dropping them silently, and beats writing to the working tree.
   */
  private inputFor(text: string, images: readonly AttachedImage[]): unknown[] {
    const parts: unknown[] = []
    if (text.trim()) parts.push({ type: 'text', text })
    if (images.length) {
      this.emit('flagWarning',
        `Codex takes images as files on disk, and this board never writes to your repository — ` +
        `so ${describeImages(images.length)} could not be attached. Claude Code sessions take ` +
        'pasted images inline; for Codex, save the file and mention its path.')
      if (!text.trim()) parts.push({ type: 'text', text: `(${describeImages(images.length)} could not be attached)` })
    }
    return parts
  }

  // -------------------------------------------------------------------------
  // The stream
  // -------------------------------------------------------------------------

  private onNotification(method: string, params: Record<string, unknown>): void {
    this.touch()
    const kind = normKind(method)
    switch (kind) {
      case 'threadstarted': {
        const id = pick<string>(params, 'threadId', 'thread_id', 'id')
        if (id && id !== this._sessionId) {
          this._sessionId = String(id)
          this.emit('sessionId', this._sessionId)
        }
        return
      }
      case 'turnstarted':
        this.setState({ kind: 'working' })
        return
      case 'turncompleted':
        this.onTurnCompleted(params)
        return
      case 'turnfailed': {
        const e = pick<Record<string, unknown>>(params, 'error')
        this.fail(new Error(String(pick(e, 'message') ?? 'Codex reported a failed turn.')))
        return
      }
      // Streamed text. Two spellings, plus the exec-side `agentMessageDelta`.
      case 'itemagentmessagedelta':
      case 'itemagentmessagetextdelta': {
        const d = pick<string>(params, 'delta', 'text', 'chunk')
        if (d) this.emit('partial', d)
        return
      }
      case 'itemreasoningtextdelta':
      case 'itemreasoningsummarytextdelta': {
        const d = pick<string>(params, 'delta', 'text', 'chunk')
        if (d) this.emit('thinking', d)
        return
      }
      case 'itemstarted':
      case 'itemupdated':
      case 'itemcompleted':
        this.onItem(kind, pick<Record<string, unknown>>(params, 'item') ?? params)
        return
      // Usage. Codex sends this as its own notification on some versions and
      // inside turn/completed on others; both land here.
      //
      // `threadtokenusageupdated` is `thread/tokenUsage/updated`, which is the
      // name the app-server actually publishes — confirmed against
      // codex-rs/app-server/README.md. It was missing, and the two spellings
      // that were here are the exec-era ones, so on a real app-server run
      // `onUsage()` never ran ONCE: no `usage` event, so the context bar showed
      // nothing all turn, and no `meter` event, so a session burning a
      // rate-limit window read as `—`. This adapter is built around the premise
      // that another runtime's protocol WILL drift; it drifted on the one
      // notification carrying both numbers the board shows.
      case 'tokencount':
      case 'threadtokencount':
      case 'threadtokenusageupdated':
        this.onUsage(params)
        return
      case 'error': {
        const m = pick<string>(params, 'message')
        if (m) this.fail(new Error(m))
        return
      }
      // Deliberately ignored: lifecycle chatter with no board meaning.
      case 'threadclosed':
      case 'threadstatuschanged':
      case 'threadnameupdated':
      case 'threadsettingsupdated':
      case 'itemreasoningsummarypartadded':
        return
      default:
        this.unknownMethods.add(method)
    }
  }

  private onItem(phase: string, item: Record<string, unknown> | undefined): void {
    if (!item) return
    const type = normKind(pick(item, 'type', 'kind'))
    const id = String(pick(item, 'id') ?? `${type}-${this.openTools.size}`)
    const done = phase === 'itemcompleted'

    switch (type) {
      case 'agentmessage': {
        const text = pick<string>(item, 'text', 'message')
        // Only the completed item is authoritative — the deltas already went
        // out as `partial`, and emitting the in-progress item as settled text
        // would print the answer twice.
        if (done && text) {
          this.finalText = text
          this.emit('text', text)
        }
        return
      }
      case 'reasoning': {
        const text = pick<string>(item, 'text', 'summary')
        if (done && text) this.emit('thinking', text)
        return
      }
      case 'commandexecution': {
        const command = String(pick(item, 'command') ?? '')
        if (!done) {
          this.openTools.set(id, 'Bash')
          this.setState({ kind: 'working', tool: `Bash: ${command.slice(0, 120)}` })
          this.emit('tool', 'Bash', { command })
          // The board offers "read the new HEAD" off this, exactly as the
          // Claude path does — a commit is the one shell command whose effect
          // the board itself renders.
          if (/\bgit\s+commit\b/.test(command)) this.sawCommit = true
        } else {
          const code = pick<number>(item, 'exit_code', 'exitCode')
          this.emit('toolResult', id, pick<string>(item, 'status') === 'failed' ? false : (code ?? 0) === 0)
          this.openTools.delete(id)
          if (this.sawCommit) { this.sawCommit = false; this.emit('committed') }
        }
        return
      }
      case 'filechange': {
        const changes = pick<{ path?: string; kind?: string }[]>(item, 'changes') ?? []
        if (!done) {
          this.openTools.set(id, 'Edit')
          const first = changes[0]?.path ?? ''
          this.setState({ kind: 'working', tool: `Edit: ${short(first, this.opts.cwd)}` })
          this.emit('tool', 'Edit', { files: changes.map((c) => c.path).filter(Boolean) })
        } else {
          this.emit('toolResult', id, pick<string>(item, 'status') !== 'failed')
          this.openTools.delete(id)
        }
        return
      }
      case 'mcptoolcall': {
        const server = String(pick(item, 'server') ?? '')
        const tool = String(pick(item, 'tool') ?? '')
        const name = server ? `${server}__${tool}` : tool
        if (!done) {
          this.openTools.set(id, name)
          this.setState({ kind: 'working', tool: name })
          this.emit('tool', name, pick(item, 'arguments') ?? {})
        } else {
          this.emit('toolResult', id, pick<string>(item, 'status') !== 'failed' && !pick(item, 'error'))
          this.openTools.delete(id)
        }
        return
      }
      case 'websearch': {
        if (!done) {
          this.setState({ kind: 'working', tool: `WebSearch: ${String(pick(item, 'query') ?? '')}` })
          this.emit('tool', 'WebSearch', { query: pick(item, 'query') })
        } else {
          this.emit('toolResult', id, true)
        }
        return
      }
      case 'todolist': {
        if (done) this.emit('tool', 'TodoWrite', { todos: pick(item, 'items') ?? [] })
        return
      }
      case 'error': {
        const m = pick<string>(item, 'message')
        // A non-fatal item error: shown in the transcript, not the end of the run.
        if (m) this.emit('text', `\n⚠️ ${m}\n`)
        return
      }
      /* The compaction boundary, and it has to reset the meter.
         Same trap as the Claude path's `compact_boundary`: after a compaction
         there is no further usage frame until the next response, so a meter
         left alone stays pinned at the PRE-compaction figure — which reads as a
         session about to run out of context when it has just been given most of
         it back. The store's own parse already draws a divider for
         `context_compacted` for this reason; the live path drew nothing and
         reset nothing. */
      case 'contextcompaction': {
        if (done) {
          this.emit('usage', 0, this.contextWindow)
          this.emit('text', '\n— context compacted —\n')
        }
        return
      }
      /* Deliberately ignored, and each for a stated reason — NOT a blanket
         ignore list, because the unknown-kind alarm is this adapter's only
         defence against real schema drift and widening it would delete that.

         `userMessage` is the most ordinary item in the protocol: the docs list
         it as a `ThreadItem` and `item/*` fires for it at the start of every
         turn. It was unhandled, so EVERY healthy Codex turn ended with a
         warning toast saying rows were missing from the transcript — and the
         claim was false, because the board renders the user's prompt from its
         own composer. A drift alarm that fires on every good turn is one the
         user has learned to dismiss by the time it matters. */
      case 'usermessage':
      case 'enteredreviewmode':
      case 'exitedreviewmode':
        return
      default:
        if (type) this.unknownMethods.add(`item:${String(pick(item, 'type', 'kind'))}`)
    }
  }

  /**
   * Context fill and the rate-limit meter.
   *
   * Two different numbers arrive together and mean different things:
   *
   *  - `info.last_token_usage` is THIS response's context fill. Using
   *    `total_token_usage` here would be the cumulative-usage trap the Claude
   *    path already documents — a 258K window reporting millions of tokens.
   *  - `rate_limits` is what a ChatGPT subscription actually spends. There is no
   *    per-request price, so the meter is a percentage of a rolling window, not
   *    a dollar figure. See `Meter` in runtime.ts for why that is a union.
   */
  private onUsage(params: Record<string, unknown>): void {
    const info = pick<Record<string, unknown>>(params, 'info', 'usage')
    if (info) {
      const last = pick<Record<string, number>>(info, 'last_token_usage', 'lastTokenUsage') ?? info as Record<string, number>
      const fill = contextFill(last)
      const window = num(pick(info, 'model_context_window', 'modelContextWindow')) || this.contextWindow
      if (window) this.contextWindow = window
      if (fill > 0) this.emit('usage', fill, this.contextWindow)
    }

    const limits = pick<Record<string, unknown>>(params, 'rate_limits', 'rateLimits')
    if (limits) {
      const primary = pick<Record<string, unknown>>(limits, 'primary')
      const secondary = pick<Record<string, unknown>>(limits, 'secondary')
      if (primary) {
        const m: Meter = {
          kind: 'plan',
          usedPercent: num(pick(primary, 'used_percent', 'usedPercent')),
          windowMinutes: num(pick(primary, 'window_minutes', 'windowMinutes')),
          ...(pick(limits, 'plan_type', 'planType') ? { plan: String(pick(limits, 'plan_type', 'planType')) } : {}),
          ...(pick(primary, 'resets_at', 'resetsAt') ? { resetsAt: num(pick(primary, 'resets_at', 'resetsAt')) } : {}),
          ...(secondary
            ? {
                secondary: {
                  usedPercent: num(pick(secondary, 'used_percent', 'usedPercent')),
                  windowMinutes: num(pick(secondary, 'window_minutes', 'windowMinutes')),
                  ...(pick(secondary, 'resets_at', 'resetsAt') ? { resetsAt: num(pick(secondary, 'resets_at', 'resetsAt')) } : {}),
                },
              }
            : {}),
        }
        this._meter = m
        this.emit('meter', m)
      }
    }
  }

  /**
   * The turn ended — and this has to read HOW.
   *
   * `turn/completed` carries the final turn state, and its `status` is
   * `completed`, `interrupted` or `failed`; the app-server documents an
   * interrupt as finishing the turn "with `status: 'interrupted'`". This
   * handler read none of it: every terminal turn went idle and emitted `done`,
   * so a turn the model FAILED on — a rate limit, a sandbox denial, a model
   * error, which are the everyday Codex failures — was recorded as a success.
   * If the agent had already moved its own card to a review column, the user
   * then got "ready for you to test" for work that never finished.
   *
   * The `turn/failed` case in `onNotification` was the intended path for that
   * and it is unreachable: there is no such notification, a failure arrives
   * inside this one. It is kept as a second accepted spelling rather than
   * deleted, on the same principle as reading both item spellings.
   */
  private onTurnCompleted(params: Record<string, unknown>): void {
    // `{ turn }` on the app-server, flat on the exec surface — read both.
    const turn = pick<Record<string, unknown>>(params, 'turn') ?? params
    const usage = pick<Record<string, unknown>>(params, 'usage') ?? pick<Record<string, unknown>>(turn, 'usage')
    if (usage) this.onUsage({ info: { last_token_usage: usage } })
    this.reportUnknown()
    this.clearPending()

    const status = normKind(pick(turn, 'status'))
    if (status === 'failed') {
      const e = pick<Record<string, unknown>>(turn, 'error')
      this.fail(new Error(String(pick(e, 'message') ?? 'Codex reported a failed turn.')))
      this.finalText = ''
      return
    }
    if (status === 'interrupted') {
      // The board's own vocabulary for "the user stopped it", and deliberately
      // NOT `done`: a stopped turn that reports success is the same class of
      // lie as a killed run that does not say so.
      this.setState({ kind: 'idle' })
      this.emit('interrupted')
      this.finalText = ''
      return
    }
    this.setState({ kind: 'idle' })
    this.emit('done', this.finalText, this._meter)
    this.finalText = ''
  }

  /** Say once, at the end of a turn, what this build could not read.
   *
   *  Codex's protocol is versioned and its own docs tell integrators to expect
   *  drift. Dropping unknown frames silently is how a transcript quietly loses
   *  half its rows; warning per frame would put a string build on the streaming
   *  path. Once per turn is the honest middle. */
  private reportUnknown(): void {
    if (!this.unknownMethods.size) return
    const names = [...this.unknownMethods].slice(0, 6).join(', ')
    this.emit('flagWarning',
      `This build of the board did not recognise ${this.unknownMethods.size} kind(s) of Codex ` +
      `message (${names}). They are missing from the transcript above. Codex ${this.opts.location.version ?? ''} ` +
      'is newer than this extension expects — the run itself was unaffected.')
    this.unknownMethods.clear()
  }

  // -------------------------------------------------------------------------
  // Approvals
  // -------------------------------------------------------------------------

  /**
   * Codex asking permission.
   *
   * The server BLOCKS on this, so an unanswered request is a wedged agent that
   * looks like a thinking one. Every branch below therefore ends in an answer:
   * a request we do not recognise is refused with a reason rather than left
   * hanging, because a refusal the agent can read and route around beats a
   * silent stall it cannot.
   */
  private onRequest(req: IncomingRequest): void {
    this.touch()
    const kind = normKind(req.method)
    /* BOTH generations of the name, because these were RENAMED and not merely
       respelled — which is the one kind of drift `normKind()` cannot bridge.
       The exec/MCP era sent `execCommandApproval` and `applyPatchApproval`; the
       app-server sends `item/commandExecution/requestApproval` and
       `item/fileChange/requestApproval`. Only the old pair was recognised, so
       on a current server every approval was answered with a JSON-RPC ERROR
       before any human saw it — while `capabilities.approvals` told the board
       this runtime's permission prompts mean something. The prompt could not
       fire at all, and Codex got an error where it expected a decision, so the
       command simply did not run. */
    const isExec = kind === 'execcommandapproval' || kind === 'itemcommandexecutionrequestapproval'
    const isPatch = kind === 'applypatchapproval' || kind === 'itemfilechangerequestapproval'
    const toolName = isExec ? 'Bash' : isPatch ? 'Edit' : undefined

    if (!toolName) {
      req.fail(`Agents Kanban does not implement ${req.method}.`)
      this.unknownMethods.add(req.method)
      return
    }

    const input: Record<string, unknown> = isExec
      ? {
          command: String(pick(req.params, 'command') ?? ''),
          ...(pick(req.params, 'cwd') ? { cwd: pick(req.params, 'cwd') } : {}),
          ...(pick(req.params, 'reason') ? { reason: pick(req.params, 'reason') } : {}),
        }
      : {
          ...(pick(req.params, 'changes', 'fileChanges') ? { changes: pick(req.params, 'changes', 'fileChanges') } : {}),
          ...(pick(req.params, 'reason') ? { reason: pick(req.params, 'reason') } : {}),
        }

    const id = `codex-${++this.permissionSeq}`
    this.permissions.set(id, { req, toolName })
    const prompt = isExec
      ? `Codex wants to run: ${String(input.command).slice(0, 300)}`
      : `Codex wants to change ${changeCount(input.changes)} in your worktree`
    this.emit('permission', {
      id,
      toolName,
      input,
      prompt,
      resolve: (allow: boolean, reason?: string) => this.answerPermission(id, allow, reason),
    })
    this.setState({ kind: 'needsInput', question: prompt, requestId: id })
  }

  answerPermission(id: string, allow: boolean, reason?: string): boolean {
    const held = this.permissions.get(id)
    if (!held) return false
    this.permissions.delete(id)
    /* Codex's own vocabulary, and the DENY arm was not in it.
       The published decisions are `accept` / `acceptForSession` / `decline` /
       `cancel`. `reject` — what this sent — is in no version of the
       vocabulary, so Deny posted a value the server cannot deserialise: the
       turn errored or blocked rather than the command being refused, and the
       board had already dropped the request and gone back to `working`, so
       there was nothing left to answer. Deny was a control that could not say
       no.
       `decline` is the documented partner of the `accept` this already sends.
       Stated honestly: the accept arm is unverified against a live server — the
       older snake_case `ReviewDecision` surface spells these
       `approved`/`denied` — but `reject` is wrong in BOTH vocabularies, so this
       is strictly a correction rather than a guess. A real Codex run is what
       settles which pair is in force. */
    held.req.respond({
      decision: allow ? 'accept' : 'decline',
      ...(reason && !allow ? { reason } : {}),
    })
    this.setState({ kind: 'working' })
    return true
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  /**
   * A follow-up while a turn is running.
   *
   * `turn/steer` adds input to the turn in flight rather than starting a new
   * one, which is what the board's composer has always meant by sending during
   * a run. When nothing is running there is no turn to steer, so it starts one.
   */
  send(text: string, images: readonly AttachedImage[] = []): void {
    const input = this.inputFor(text, images)
    this.pending.push(text.trim() || `(${describeImages(images.length)})`)
    this.setState({ kind: 'working' })
    this.emit('queued', [...this.pending])
    const rpc = this.rpc
    if (!rpc) return
    const method = this.turnRunning ? 'turn/steer' : 'turn/start'
    if (!this.turnRunning) this.turnRunning = true
    void rpc.request(method, { threadId: this._sessionId, input }, 0)
      .then(() => { if (method === 'turn/start') this.turnRunning = false })
      .catch((e: unknown) => {
        this.turnRunning = false
        if (!this.stopped && !this.interrupted) this.fail(e)
      })
  }

  private clearPending(): void {
    if (!this.pending.length) return
    this.pending.length = 0
    this.emit('queued', [])
  }

  clearQueue(): number {
    const n = this.pending.length
    this.clearPending()
    return n
  }

  async interrupt(): Promise<void> {
    if (!this.rpc) { this.stop(); return }
    this.interrupted = true
    for (const [id] of this.permissions) this.answerPermission(id, false, 'The user interrupted.')
    this.clearPending()
    try {
      await this.rpc.request('turn/interrupt', { threadId: this._sessionId }, 10_000)
    } catch {
      // An interrupt that the server did not acknowledge is still an interrupt
      // as far as the user is concerned; the turn either ends or the frame-age
      // readout keeps climbing, which is visible either way.
    }
    this.turnRunning = false
    this.setState({ kind: 'idle' })
    this.emit('interrupted')
    // Interrupt ends the TURN and keeps the session; the flag must not outlive
    // it, or the next turn's result is discarded as if the user had stopped it.
    this.interrupted = false
  }

  /**
   * Change the permission stance of a running session.
   *
   * Returns false when the server will not take it, rather than reporting a
   * success we did not get: the board renders the mode from this answer, and a
   * picker that moves when nothing changed is a control that cannot say no.
   */
  async setPermissionMode(mode: PermissionMode): Promise<boolean> {
    if (!this.rpc || !this._sessionId) return false
    try {
      await this.rpc.request('thread/settings/update', {
        threadId: this._sessionId,
        ...codexPermissions(mode),
      }, 10_000)
      return true
    } catch {
      return false
    }
  }

  stop(): void {
    this.stopped = true
    for (const [id] of this.permissions) this.answerPermission(id, false, 'The session was stopped.')
    this.rpc?.dispose()
    this.child = undefined
  }

  private fail(e: unknown): void {
    const message = msg(e)
    this.setState({ kind: 'error', message })
    this.emit('error', message)
  }
}

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

/** Ask a short-lived app-server one question and shut it down.
 *
 *  Used for `model/list` and `account/read`, which are answered from the
 *  initialize handshake and cost no model tokens. Never called on the render
 *  path or the activation path — it spawns a process. */
async function ask(
  loc: RuntimeLocation,
  method: string,
  params: Record<string, unknown> = {},
  env?: Record<string, string>,
): Promise<unknown> {
  const child = spawn(loc.command, ['app-server'], {
    env: agentEnv(process.env, env ?? {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams
  const rpc = new JsonRpcPeer(child)
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'agents-kanban', title: 'Agents Kanban', version: '1' },
      capabilities: { experimentalApi: false },
    }, 20_000)
    rpc.notify('initialized', {})
    return await rpc.request(method, params, 20_000)
  } finally {
    rpc.dispose()
  }
}

export const codexRuntime: AgentRuntime = {
  id: 'codex',
  label: 'Codex',
  vendor: 'OpenAI',
  blurb: 'Runs on the Codex login already on this machine — a ChatGPT subscription or an OpenAI API key. No proxy, nothing to configure.',
  installHint: 'npm install -g @openai/codex',
  capabilities: {
    // Codex authenticates as itself. There is no backend for an environment
    // profile to select, so the provider controls do not appear.
    providerProfiles: false,
    interrupt: true,
    steer: true,
    approvals: true,
    // `local_image` takes a PATH, and this board never writes to the user's
    // repository. See `inputFor`.
    images: false,
    // Codex expresses reasoning depth through effort alone; there is no second
    // on/off switch to offer.
    thinkingToggle: false,
    durableHistory: true,
    // Codex takes MCP servers as commands to spawn, so the board's tools are
    // served over a socket. See `board-bridge.ts`.
    boardTools: 'stdio',
  },

  async detect(configured?: string): Promise<RuntimeLocation | undefined> {
    const { promises: fs, constants } = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const exec = promisify(execFile)

    const usable = async (p: string): Promise<boolean> => {
      try { await fs.access(p, constants.X_OK); return true } catch { return false }
    }

    const version = async (command: string): Promise<string | undefined> => {
      try {
        const { stdout } = await exec(command, ['--version'], { timeout: 10_000 })
        return stdout.trim().split('\n')[0] || undefined
      } catch { return undefined }
    }

    const finish = async (command: string, source: RuntimeLocation['source']): Promise<RuntimeLocation> => {
      const v = await version(command)
      return { command, source, ...(v ? { version: v } : {}) }
    }

    if (configured?.trim()) {
      const c = configured.trim()
      if (await usable(c)) return finish(c, 'setting')
    }

    // PATH first, as with `claude`: the copy the user maintains is the one that
    // should run, and a dev checkout must not silently run a different Codex.
    try {
      const which = process.platform === 'win32' ? 'where' : 'which'
      const { stdout } = await exec(which, ['codex'], { timeout: 10_000 })
      const first = stdout.split('\n').map((s) => s.trim()).find(Boolean)
      if (first && (await usable(first))) return finish(first, 'path')
    } catch { /* not on PATH */ }

    const home = os.homedir()
    const candidates = process.platform === 'win32'
      ? [path.join(home, 'AppData', 'Local', 'Programs', 'codex', 'codex.exe')]
      : [
          path.join(home, '.local', 'bin', 'codex'),
          path.join(home, '.codex', 'bin', 'codex'),
          '/usr/local/bin/codex',
          '/opt/homebrew/bin/codex',
        ]
    for (const c of candidates) if (await usable(c)) return finish(c, 'wellKnown')
    return undefined
  },

  /**
   * Who Codex thinks it is.
   *
   * Asked of the runtime rather than derived from our own configuration, for
   * the same reason `accountInfo()` is asked of Claude Code: a readout that can
   * only repeat our own settings back is decorative. It reads `~/.codex/auth.json`
   * as a fallback ONLY to distinguish "signed out" from "could not ask" — those
   * have different fixes and collapsing them is the failure this whole shape
   * exists to avoid.
   */
  async login(loc: RuntimeLocation): Promise<LoginState> {
    try {
      const r = await ask(loc, 'account/read') as Record<string, unknown>
      const account = pick<Record<string, unknown>>(r, 'account') ?? r
      const mode = String(pick(account, 'authMode', 'auth_mode', 'mode') ?? '')
      const email = pick<string>(account, 'email', 'accountId', 'account_id')
      const plan = pick<string>(account, 'planType', 'plan_type', 'plan')
      if (!mode && !email) {
        return { kind: 'signedOut', fix: 'Run `codex login` in a terminal, then reopen this page.' }
      }
      return {
        kind: 'signedIn',
        via: mode.toLowerCase().includes('chatgpt') ? 'subscription' : 'apiKey',
        ...(email ? { account: email } : {}),
        ...(plan ? { plan } : {}),
      }
    } catch (e) {
      // Fall back to the credential file, which tells us whether a login EXISTS
      // even when the server would not answer.
      try {
        const { promises: fs } = await import('node:fs')
        const raw = await fs.readFile(`${codexHome()}/auth.json`, 'utf8')
        const parsed = JSON.parse(raw) as Record<string, unknown>
        const mode = String(parsed.auth_mode ?? parsed.authMode ?? '')
        if (mode) {
          return {
            kind: 'signedIn',
            via: mode.toLowerCase().includes('chatgpt') ? 'subscription' : 'apiKey',
          }
        }
        if (parsed.OPENAI_API_KEY) return { kind: 'signedIn', via: 'apiKey' }
        return { kind: 'signedOut', fix: 'Run `codex login` in a terminal, then reopen this page.' }
      } catch {
        return { kind: 'unknown', reason: msg(e) }
      }
    }
  },

  /**
   * What Codex can run right now.
   *
   * Three sources, in the order the project's existing rule prescribes: the
   * runtime's own answer, then a cache, then the built-in list — and the caller
   * DISCLOSES which one it used, because "why is the model I use missing?" has
   * to be answerable from the UI.
   *
   * The cache here is Codex's OWN (`~/.codex/models_cache.json`), not ours. It
   * is written by the Codex CLI when it refreshes its catalogue, so it is real
   * data about this machine's account rather than a table that goes stale
   * between our releases.
   */
  async models(loc: RuntimeLocation, env?: Record<string, string>): Promise<ModelCatalogue> {
    try {
      const r = await ask(loc, 'model/list', {}, env) as Record<string, unknown>
      const list = pick<unknown[]>(r, 'models', 'items', 'data')
      const models = parseModels(list)
      if (models.length) return { models, source: 'runtime' }
    } catch { /* fall through to the cache */ }

    try {
      const { promises: fs } = await import('node:fs')
      const raw = await fs.readFile(`${codexHome()}/models_cache.json`, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const models = parseModels(parsed.models as unknown[])
      if (models.length) {
        return {
          models,
          source: 'cache',
          note: `From Codex's own model cache${typeof parsed.fetched_at === 'string' ? `, fetched ${parsed.fetched_at.slice(0, 10)}` : ''}. Start Codex once to refresh it.`,
        }
      }
    } catch { /* fall through to the built-in list */ }

    return {
      models: BUILTIN_MODELS,
      source: 'builtin',
      note: 'Codex did not answer, so this is the built-in list. It may be missing models your account has.',
    }
  },

  builtinModels(): RuntimeModel[] { return BUILTIN_MODELS },

  start(spec: RunSpec): AgentRun {
    const location = spec.executable
      ? { command: spec.executable, source: 'setting' as const }
      : undefined
    if (!location) {
      throw new Error(
        'Codex was not found on this machine. Install it with `npm install -g @openai/codex` and ' +
        'sign in with `codex login`, or set `agentsKanban.codexExecutable`.',
      )
    }
    return new CodexSession({ ...spec, location })
  },

  history: codexHistory,
}

/**
 * Codex's model catalogue, in the board's shape.
 *
 * Two entries in the real file are `visibility: "hide"` — internal models that
 * the Codex UI itself does not offer. Listing them would put ids in the picker
 * that fail at the first request with somebody else's error message, so they
 * are dropped here rather than shown and hoped for.
 */
export function parseModels(raw: unknown): RuntimeModel[] {
  if (!Array.isArray(raw)) return []
  const out: RuntimeModel[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const m = entry as Record<string, unknown>
    const id = pick<string>(m, 'slug', 'id', 'model')
    if (!id) continue
    if (pick<string>(m, 'visibility') === 'hide') continue
    const efforts = effortLevels(pick(m, 'supported_reasoning_levels', 'supportedReasoningLevels', 'supportedEffort'))
    const window = num(pick(m, 'context_window', 'contextWindow'))
    out.push({
      id,
      label: pick<string>(m, 'display_name', 'displayName', 'label') ?? id,
      ...(window ? { contextWindow: window } : {}),
      ...(efforts.length ? { supportedEffort: efforts } : {}),
      ...(pick<string>(m, 'description') ? { description: pick<string>(m, 'description')! } : {}),
    })
  }
  return out
}

/** The board's five effort levels, filtered to what this model actually takes.
 *
 *  Codex reports each level as an object with a description, and its list
 *  includes levels the board has no name for (`minimal`, `ultra`,
 *  `persistent`). Those are dropped rather than surfaced: an effort the Claude
 *  path could never honour would make the picker mean two different things
 *  depending on which runtime the card is on. */
function effortLevels(raw: unknown): EffortLevel[] {
  const known: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']
  if (!Array.isArray(raw)) return []
  const named = raw
    .map((e) => (typeof e === 'string' ? e : pick<string>(e as Record<string, unknown>, 'effort', 'level', 'name')))
    .filter((s): s is string => typeof s === 'string')
  return known.filter((k) => named.includes(k))
}

/**
 * How full the context is, from one Codex usage record.
 *
 * Exported because it is the arithmetic the meter is derived from, and the one
 * place a runtime's token accounting can quietly disagree with the board's.
 *
 * **Codex counts cached tokens differently from Claude, and getting this
 * backwards inflates the meter.** In an Anthropic `usage` block,
 * `input_tokens` and `cache_read_input_tokens` are DISJOINT and must be summed
 * — that is what `contextOfUsage` does. In a Codex record,
 * `cached_input_tokens` is a SUBSET of `input_tokens`, already counted. Adding
 * them the Claude way would report ~26K on a real 14K turn: a needle at double
 * the truth, on a meter whose whole purpose is knowing when to compact.
 *
 * Verified against a real rollout on this machine, where
 * `total_tokens` (14270) == `input_tokens` (14041) + `output_tokens` (229),
 * with `cached_input_tokens` (12160) inside the input figure.
 */
export function contextFill(u: Record<string, unknown> | undefined): number {
  if (!u) return 0
  const total = num(pick(u, 'total_tokens', 'totalTokens'))
  if (total > 0) return total
  return num(pick(u, 'input_tokens', 'inputTokens')) + num(pick(u, 'output_tokens', 'outputTokens'))
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function msg(e: unknown): string {
  if (e instanceof RpcError) return `${e.message}${e.overloaded ? ' (Codex is busy; try again shortly)' : ''}`
  return e instanceof Error ? e.message : String(e)
}

function short(p: string, cwd: string): string {
  return p.startsWith(cwd) ? p.slice(cwd.length).replace(/^\//, '') : p
}

function changeCount(changes: unknown): string {
  const n = Array.isArray(changes) ? changes.length : 0
  return n === 1 ? '1 file' : `${n} files`
}
