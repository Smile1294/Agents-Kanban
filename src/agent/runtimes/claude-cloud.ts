/** A Claude Code session on Anthropic's cloud, behind the same `AgentRun` a
 * local session is — so the manager, the card and the chat need no branch for
 * where a session happens to run.
 *
 * Two ways in, tried in order, and the order is the feature (see
 * `agent/cloud.ts` for what the CLI allows and why nothing else is used):
 *
 *  1. CONNECTED. An ordinary `AgentSession` whose CLI is started with
 *     `--cloud` (or `--cloud <id>` to continue one). When the account has the
 *     CLI's connected-sessions gate, the CLI creates the session and streams
 *     its frames back over the same stream-json transport a local run uses,
 *     and everything the chat already draws — text, tools, permissions,
 *     follow-ups, interrupt — simply works. This is the path that makes "it
 *     still works through the chat" true.
 *  2. DETACHED. When the CLI refuses that with one of the three sentences in
 *     `connectedRefusal`, and ONLY then, the session is created the way a
 *     person creates one from a terminal: `claude --cloud "<task>"` inside
 *     `script(1)`, reading the link it prints. Follow-ups go through
 *     `claude -p --cloud <id>`. The board can deliver messages and cannot read
 *     one reply, so this run ends as soon as its message is delivered and the
 *     card says where the conversation is.
 *
 * A refusal is recognised before anything was heard from the session, never
 * after: a connected run that fails halfway is a failure to show, not a
 * reason to start a second session behind the user's back.
 */
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { AgentSession, agentEnv, type AgentSessionOptions } from '../session.ts'
import {
  CLOUD_ENV, cloudCreateArgs, cloudSendArgs, cloudSessionIdIn, cloudUrlFor, connectedRefusal,
  explainCloudError, isCloudUrl, ptyInvocation, readCloudCreate, readCloudSend, screenText,
  unknownCloudFlag, type CloudMessage,
} from '../cloud.ts'
import type { AgentRun, CloudTarget, Meter, PermissionMode, RunSpec } from '../runtime.ts'
import type { AgentState } from '../../board/config.ts'
import type { AttachedImage } from '../images.ts'

export interface CloudRunDeps {
  /** The connected attempt. Injected so a test can stand in for a CLI with the
   *  gate on; the default is a real `AgentSession`. */
  connect?: (opts: AgentSessionOptions) => AgentRun
  platform?: string
  /** How long creating a session may take. Bundling and uploading a large
   *  repository is minutes, not seconds; the CLI prints as it goes, and the
   *  card shows how long ago it last did. */
  createTimeoutMs?: number
  sendTimeoutMs?: number
}

/** Events an `AgentSession` emits, forwarded untouched once connected.
 *  `state` and `error` are decided separately — see `connected()`. */
const FORWARDED = [
  'text', 'partial', 'thinking', 'tool', 'toolResult', 'queued', 'interrupted', 'usage', 'meter',
  'spend', 'committed', 'permission', 'provider', 'flagWarning', 'limit', 'waiting', 'done',
] as const

/** Frames that mean the SESSION answered — after one of these, an error is the
 *  session's failure, never the CLI declining to connect. */
const HEARD = new Set<string>(['text', 'partial', 'thinking', 'tool', 'toolResult', 'usage', 'permission', 'done', 'waiting'])

/**
 * The permission stance a cloud session accepts. Bypass is refused there, and
 * `dontAsk` means "deny what is not pre-approved" for a session whose prompts
 * nobody on this machine may ever see; both become the cloud's own default,
 * accept-edits, rather than a flag the CLI rejects.
 */
function cloudMode(m: PermissionMode): PermissionMode {
  return m === 'bypassPermissions' || m === 'dontAsk' ? 'acceptEdits' : m
}

export class CloudRun extends EventEmitter implements AgentRun {
  readonly taskId: string
  readonly runtime = 'claude' as const
  private readonly spec: RunSpec & { cloud: CloudTarget }
  private readonly deps: Required<Omit<CloudRunDeps, 'connect'>> & Pick<CloudRunDeps, 'connect'>
  /** The connected session, once the CLI has agreed to stream it here. */
  private inner?: AgentRun
  private child?: ChildProcess
  private _state: AgentState = { kind: 'idle' }
  private _sessionId?: string
  private lastEventAt = 0
  /** Torn down: the card is going away, so nothing more is said. */
  private stopped = false
  /** Interrupted mid-create or mid-delivery: the run ends, and says how. */
  private cancelled = false
  /** Messages typed while a detached create or delivery is still in flight.
   *  Delivered, in order, before the run ends. */
  private pending: Array<{ text: string; images: readonly AttachedImage[] }> = []
  /** The cloud session this run is about, once known. */
  private cloudId?: string
  private cloudUrl?: string
  private lastRepaint = 0

  constructor(spec: RunSpec & { cloud: CloudTarget }, deps: CloudRunDeps = {}) {
    super()
    this.spec = spec
    this.taskId = spec.taskId
    this.cloudId = spec.cloud.id
    this.deps = {
      platform: deps.platform ?? process.platform,
      createTimeoutMs: deps.createTimeoutMs ?? 10 * 60_000,
      sendTimeoutMs: deps.sendTimeoutMs ?? 2 * 60_000,
      ...(deps.connect ? { connect: deps.connect } : {}),
    }
  }

  get state(): AgentState { return this.inner?.state ?? this._state }
  get lastEvent(): number { return this.inner ? this.inner.lastEvent : this.lastEventAt }
  get sessionId(): string | undefined { return this.inner?.sessionId ?? this._sessionId }
  get resolvedProvider(): string | undefined { return this.inner?.resolvedProvider }
  /** `unknown` while detached, and that is the whole reason it is not
   *  `NO_SPEND`: the session is spending the account's allowance on claude.ai,
   *  and nothing here can see how much. `—`, never `$0.00`. */
  get meter(): Meter { return this.inner?.meter ?? { kind: 'unknown' } }

  private setState(s: AgentState): void {
    this._state = s
    this.emit('state', s)
  }

  /** The CLI printed something. Its AGE is what the card shows, so it is
   *  re-announced — at most once a second, because each one is a repaint. */
  private heard(): void {
    this.lastEventAt = Date.now()
    if (this.lastEventAt - this.lastRepaint < 1000) return
    this.lastRepaint = this.lastEventAt
    this.emit('state', this._state)
  }

  async run(prompt: string, images: readonly AttachedImage[] = [], messageId?: string): Promise<void> {
    this.setState({ kind: 'starting' })
    if (!this.spec.executable) {
      return this.fail('The Claude Code CLI was not found, so the session could not be sent to the cloud.')
    }
    if (await this.connected(prompt, images, messageId)) return
    if (this.stopped) return
    const created = this.cloudId ? true : await this.create(prompt, images)
    if (!created || this.stopped) return
    // A follow-up to an existing session, then whatever was typed meanwhile.
    const queue = this.spec.cloud.id ? [{ text: prompt, images }, ...this.pending] : [...this.pending]
    this.pending = []
    for (const m of queue) {
      if (this.stopped) return
      if (!(await this.deliver(m.text, m.images))) return
    }
    this.finishDetached(this.spec.cloud.id
      ? 'Delivered to the cloud session. Its reply is on claude.ai — the board cannot read it from here.'
      : `Created on Anthropic's cloud. It is working there now; follow it on claude.ai.`)
  }

  // ——— 1. connected ————————————————————————————————————————————————————

  /** True when the CLI streamed the session here (whatever became of it);
   *  false when it declined to, which is the only thing that falls back. */
  private async connected(prompt: string, images: readonly AttachedImage[], messageId?: string): Promise<boolean> {
    const s = this.spec
    const opts: AgentSessionOptions = {
      taskId: s.taskId,
      cwd: s.cwd,
      permissionMode: cloudMode(s.permissionMode),
      claudeExecutable: s.executable,
      // NOT `resume`: the CLI refuses `--cloud` with `--resume`, and continuing
      // a cloud session is `--cloud <id>`, which is what this is.
      extraArgs: { cloud: s.cloud.id ?? null },
      env: { ...(s.env ?? {}), ...CLOUD_ENV },
      ...(s.envClear ? { envClear: s.envClear } : {}),
      ...(s.provider ? { provider: s.provider } : {}),
      ...(s.modelBook ? { modelBook: s.modelBook } : {}),
      // No model, effort or thinking. The composer offers none for a cloud
      // session — the detached path drops `--model`, and which path a run
      // takes is only known once the CLI answers — so passing the workspace
      // default here would be a choice nobody made on this card.
      ...(s.log ? { log: s.log } : {}),
      // The session's link, wherever the CLI mentions it.
      onStderr: (chunk) => this.spotLink(chunk),
    }
    const inner = this.deps.connect ? this.deps.connect(opts) : new AgentSession(opts)
    let refused = false
    for (const ev of FORWARDED) {
      inner.on(ev, (...args: unknown[]) => {
        if (HEARD.has(ev)) this.goLive(inner)
        if (ev === 'done') this.announce('live')
        this.emit(ev, ...args)
      })
    }
    inner.on('sessionId', (id: string) => {
      this.goLive(inner)
      this._sessionId = id
      this.emit('sessionId', id)
      // The stream's own id, when it is the cloud one.
      if (!this.cloudId && cloudSessionIdIn(id) === id) this.cloudId = id
      this.announce('live')
    })
    inner.on('state', (st: AgentState) => {
      // An error state is announced with its error below, once it is known
      // whether it was a refusal to connect — which must not reach the card.
      if (st.kind === 'error') return
      this.emit('state', st)
    })
    inner.on('error', (message: string) => {
      if (!this.live && connectedRefusal(message)) { refused = true; return }
      const said = unknownCloudFlag(message)
        ? 'This Claude Code is too old to start cloud sessions (it has no --cloud). Update it, then try again.'
        : explainCloudError(message)
      this.emit('state', { kind: 'error', message: said })
      this.emit('error', said)
    })
    this.inner = inner
    await inner.run(prompt, images, messageId)
    if (!refused) return true
    inner.removeAllListeners()
    this.inner = undefined
    s.log?.('Claude Code declined to stream this cloud session to the board (connected sessions are not enabled for this account); creating it the way a terminal does, and following it on claude.ai.')
    return false
  }

  /**
   * The session answered through the stream: from here on it IS the run.
   *
   * Until this moment a message typed on the card is held by THIS run, not
   * handed to the connected attempt — that attempt may yet be declined, and a
   * message queued inside it would be discarded with it. Found by the test,
   * which typed a follow-up 400ms into a create.
   */
  private live = false
  private goLive(inner: AgentRun): void {
    if (this.live) return
    this.live = true
    const held = this.pending
    this.pending = []
    for (const m of held) inner.send(m.text, m.images)
    if (held.length) this.emit('queued', [])
  }

  /** A claude.ai session link in what the CLI said. */
  private spotLink(text: string): void {
    const m = /https:\/\/claude\.ai\/code\/[^\s)'"]+/.exec(screenText(text))
    if (!m || !isCloudUrl(m[0])) return
    const id = cloudSessionIdIn(m[0])
    if (!id || (this.cloudId && this.cloudId !== id)) return
    this.cloudId = id
    this.cloudUrl = m[0]
    this.announce('live')
  }

  private announcedLive = false
  /** Tell the manager where this session is, once there is an id to say. */
  private announce(via: 'live'): void {
    if (this.announcedLive || !this.cloudId) return
    this.announcedLive = true
    this.emit('cloud', {
      id: this.cloudId, url: this.cloudUrl ?? cloudUrlFor(this.cloudId), via,
      ...(this.spec.cloud.title ? { title: this.spec.cloud.title } : {}),
    })
  }

  // ——— 2. detached ———————————————————————————————————————————————————————

  /** `claude --cloud "<task>"` on a pseudo-terminal, until it prints the link. */
  private async create(prompt: string, images: readonly AttachedImage[]): Promise<boolean> {
    const s = this.spec
    const inv = ptyInvocation(this.deps.platform, [
      s.executable!, ...cloudCreateArgs(prompt, {
        ...(s.cloud.title ? { title: s.cloud.title } : {}),
        permissionMode: s.permissionMode,
      }),
    ])
    if (!inv) {
      this.fail(
        'This Claude Code does not stream cloud sessions to an editor for your account, and on Windows the ' +
        'board cannot give it the terminal it needs to start one on its own. Start it from a terminal ' +
        'instead: claude --cloud "<your task>".',
      )
      return false
    }
    if (images.length) this.imagesNotSent(images.length)
    this.setState({ kind: 'working', tool: 'Uploading the repository and creating the cloud session' })

    const outcome = await new Promise<ReturnType<typeof readCloudCreate>>((resolve) => {
      let out = ''
      let settled = false
      const child = spawn(inv.command, inv.args, {
        cwd: s.cwd,
        env: agentEnv(process.env, {
          ...(s.env ?? {}), ...CLOUD_ENV,
          // A terminal type Ink knows, and a plain shell for util-linux
          // `script -c` to run the line with — the user's own shell reads its
          // rc files, and a prompt theme printing on start would be in the
          // capture.
          TERM: 'xterm-256color', SHELL: '/bin/sh',
        }, s.envClear ?? []),
        // stdin stays OPEN: `script` ends the session when its input does.
        stdio: ['pipe', 'pipe', 'pipe'],
        // Its own process group where the command is a wrapper shell, so a
        // stop reaches everything it started (see `ptyInvocation`).
        ...(inv.group ? { detached: true } : {}),
      })
      if (inv.group) this.groups.add(child)
      this.child = child
      const done = (r: ReturnType<typeof readCloudCreate>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        this.kill(child)
        const said = screenText(out).split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ')
        done({
          kind: 'error',
          message: `Claude Code did not finish creating the cloud session within ${Math.round(this.deps.createTimeoutMs / 60_000)} minutes` +
            (said ? `. It last said: ${said}` : ', and said nothing.') +
            ' If it had already uploaded the repository, the session may exist anyway — check claude.ai/code.',
        })
      }, this.deps.createTimeoutMs)
      const read = (b: Buffer) => {
        out += b.toString('utf8')
        this.heard()
        const r = readCloudCreate(out, false)
        if (r.kind === 'created') {
          // Printed, and about to exit by itself. Nothing to wait for.
          done(r)
        } else if (r.kind === 'trust' || r.kind === 'attached') {
          // A dialog nobody here may answer, or an interactive screen nobody
          // is looking at: stop it, and say which.
          this.kill(child)
          done(r)
        }
        // An error is left to the exit, so its whole text is in.
      }
      child.stdout?.on('data', read)
      child.stderr?.on('data', read)
      child.on('error', (e) => done({ kind: 'error', message: `Could not start a terminal for Claude Code: ${e.message}` }))
      child.on('close', () => { this.child = undefined; done(readCloudCreate(out, true)) })
    })

    if (this.stopped) return false
    if (this.cancelled && outcome.kind !== 'created') {
      this.fail('Interrupted before the cloud session was created. If Claude Code had already uploaded the ' +
        'repository, the session may exist anyway — check claude.ai/code.')
      return false
    }
    if (outcome.kind === 'created' || outcome.kind === 'attached') {
      this.cloudId = outcome.id
      this.cloudUrl = outcome.url
      this._sessionId = outcome.id
      this.emit('sessionId', outcome.id)
      this.emit('cloud', {
        id: outcome.id, url: outcome.url, via: 'detached',
        ...(this.spec.cloud.title ? { title: this.spec.cloud.title } : outcome.kind === 'created' && outcome.title ? { title: outcome.title } : {}),
        // No image count: none were sent (see `imagesNotSent`), and a prompt
        // row that says "1 image" is a claim that one arrived.
        sent: { at: Date.now(), text: prompt, ok: true },
        notices: outcome.kind === 'attached'
          ? ['Claude Code opened this cloud session interactively instead of printing its link, so the board ' +
             'cannot tell whether your task reached it. Open it on claude.ai to check.']
          : outcome.notices,
      })
      return true
    }
    if (outcome.kind === 'trust') {
      this.fail(
        'Claude Code wants you to trust this folder before it uploads it, and the board will not answer that ' +
        'for you. Run `claude` once in the repository, choose "Yes, I trust this folder", then start the ' +
        'session again.',
      )
      return false
    }
    this.fail(outcome.kind === 'error' ? explainCloudError(outcome.message) : 'Claude Code did not create the cloud session.')
    return false
  }

  /** One message to an existing session: `claude -p --cloud <id>`, text on stdin. */
  private async deliver(text: string, images: readonly AttachedImage[]): Promise<boolean> {
    const id = this.cloudId!
    const s = this.spec
    if (images.length) this.imagesNotSent(images.length)
    this.setState({ kind: 'working', tool: 'Sending to the cloud session' })
    const at = Date.now()
    const result = await new Promise<ReturnType<typeof readCloudSend>>((resolve) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const child = spawn(s.executable!, cloudSendArgs(id), {
        cwd: s.cwd,
        env: agentEnv(process.env, { ...(s.env ?? {}), ...CLOUD_ENV }, s.envClear ?? []),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child
      const done = (r: ReturnType<typeof readCloudSend>) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(r)
      }
      const timer = setTimeout(() => {
        this.kill(child)
        done({ ok: false, error: `Claude Code did not answer within ${Math.round(this.deps.sendTimeoutMs / 1000)}s, so the message may not have arrived.` })
      }, this.deps.sendTimeoutMs)
      child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); this.heard() })
      child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); this.heard() })
      child.on('error', (e) => done({ ok: false, error: `Could not start Claude Code: ${e.message}` }))
      child.on('close', (code) => { this.child = undefined; done(readCloudSend(stdout, stderr, code)) })
      child.stdin?.on('error', () => { /* it exited before reading; the close says why */ })
      child.stdin?.end(text)
    })
    if (this.stopped) return false
    if (this.cancelled && !result.ok) {
      this.fail('Interrupted before Claude Code confirmed the delivery, so the message may or may not have ' +
        'arrived — check claude.ai before sending it again.')
      return false
    }
    const sent: CloudMessage = {
      at, text, ok: result.ok,
      ...(!result.ok ? { error: explainCloudError(result.error) } : {}),
    }
    const url = result.ok && result.url && isCloudUrl(result.url) ? result.url : this.cloudUrl ?? cloudUrlFor(id)
    this.cloudUrl = url
    this.emit('cloud', { id, url, via: 'detached', ...(s.cloud.title ? { title: s.cloud.title } : {}), sent })
    if (!result.ok) {
      this.fail(`The message did not reach the cloud session: ${explainCloudError(result.error)}`)
      return false
    }
    return true
  }

  private imagesNotSent(n: number): void {
    this.emit('flagWarning',
      `${n === 1 ? 'An image was' : `${n} images were`} not sent: a cloud session reached from the terminal ` +
      'takes text only. Describe it, or attach it on claude.ai.')
  }

  private finishDetached(summary: string): void {
    this.setState({ kind: 'done', summary })
    this.emit('done', summary, { kind: 'unknown' } satisfies Meter)
  }

  private fail(message: string): void {
    this.setState({ kind: 'error', message })
    this.emit('error', message)
  }

  /** Children spawned as a process-group leader — signalled as a group. */
  private readonly groups = new WeakSet<ChildProcess>()

  private kill(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return
    const signal = (sig: NodeJS.Signals) => {
      if (this.groups.has(child) && child.pid) {
        try { process.kill(-child.pid, sig); return } catch { /* the group is gone; fall through */ }
      }
      child.kill(sig)
    }
    signal('SIGTERM')
    const hard = setTimeout(() => { if (child.exitCode === null) signal('SIGKILL') }, 3000)
    hard.unref?.()
  }

  // ——— the rest of the contract ——————————————————————————————————————————

  send(text: string, images: readonly AttachedImage[] = [], messageId?: string): void {
    if (this.inner && this.live) { this.inner.send(text, images, messageId); return }
    this.pending.push({ text, images })
    this.emit('queued', this.pending.map((p) => p.text))
  }

  clearQueue(): number {
    if (this.inner && this.live) return this.inner.clearQueue()
    const n = this.pending.length
    this.pending = []
    if (n) this.emit('queued', [])
    return n
  }

  backgroundTasks(): string[] { return this.inner?.backgroundTasks?.() ?? [] }

  async interrupt(): Promise<void> {
    if (this.inner) return this.inner.interrupt()
    // Detached, there is no turn here to interrupt — only the CLI creating or
    // delivering. Stopping THAT is the honest version of the button, and the
    // run must still END: a killed child with nothing emitted is a card that
    // says "working" forever. `create`/`deliver` say how it ended.
    if (this.child) {
      this.cancelled = true
      this.kill(this.child)
    }
  }

  answerPermission(id: string, allow: boolean, reason?: string, selections?: Record<string, string[]>): boolean {
    return this.inner?.answerPermission(id, allow, reason, selections) ?? false
  }

  async setPermissionMode(mode: PermissionMode): Promise<boolean> {
    return this.inner ? this.inner.setPermissionMode(cloudMode(mode)) : false
  }

  /**
   * Idempotent, and it reports nothing as an error. The manager calls this from
   * `finish()` on every ending as well as from Stop, and an error emitted here
   * re-entered `finish()`, which calls it again. A Stop mid-create is said as a
   * WARNING, because it is the one moment where the user's action may not have
   * had the effect they wanted — the CLI's own line for it is "it may still
   * have been created".
   */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    const creating = !!this.child && !this.cloudId
    this.inner?.stop()
    if (this.child) this.kill(this.child)
    if (creating) {
      this.emit('flagWarning', 'Stopped while the cloud session was being created. If Claude Code had already ' +
        'uploaded the repository, the session may exist anyway — check claude.ai/code.')
    }
  }
}
