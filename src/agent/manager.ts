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
import type { WorktreeService } from '../git/worktree.ts'
import { resolveEffort, resolveThinking, type EffortLevel, type ThinkingMode } from '../sessions/meta.ts'
import { summariseTool, type Entry, type SessionStore } from '../sessions/store.ts'
import type { AgentState, BoardConfig } from '../board/config.ts'
import { AgentSession, type PermissionRequest } from './session.ts'
import type { AttachedImage } from './images.ts'
import { boardToolNames, createBoardServer, type BoardChange, type BoardNotice } from './tools.ts'

export interface ManagerOptions {
  store: SessionStore
  worktrees: WorktreeService
  board: BoardConfig
  defaults: { model?: string; effort?: EffortLevel; thinking?: ThinkingMode }
  /** All six the SDK accepts. It used to list four, and only compiled because
   *  extension.ts cast every value to 'acceptEdits' — a type that was a lie
   *  about values that were real at runtime. */
  permissionMode: NonNullable<Options['permissionMode']>
  maxConcurrent: number
  claudeExecutable?: string
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
  tags?: string[]
}

export type SplitResult =
  | { ok: true; started: { key: string; title: string; branch: string }[] }
  | { ok: false; message: string }

interface LaunchOptions {
  /** Resume a Claude Code session (and reuse its worktree). */
  resume?: string
  title?: string
  /** The session this run was split out of. */
  parent?: string
  /** Fork the worktree from this branch instead of the repo's current one. */
  base?: string
  /** Images attached to the FIRST message. Held only until the run starts —
   *  they ride inside the message to the model and are stored nowhere. */
  images?: AttachedImage[]
}

export interface RunningAgent {
  runId: string
  /** Set once Claude Code assigns one. Until then the card is keyed by runId. */
  sessionId?: string
  title: string
  state: AgentState
  worktreePath: string
  branch: string
  /** The branch the worktree forked from, for the review panel's diff and merge. */
  base?: string
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
  pendingPermission?: PermissionRequest
  startedAt: number
  /** When the CLI last emitted anything. The board renders its age, which is
   *  the difference between telling the user it is working and letting them
   *  see that it is. */
  lastEventAt?: number
}

export class AgentManager extends EventEmitter {
  private opts: ManagerOptions
  private readonly sessions = new Map<string, AgentSession>()
  private readonly agents = new Map<string, RunningAgent>()
  private readonly queue: Array<{ runId: string; prompt: string; opts: LaunchOptions }> = []
  private counter = 0

  constructor(opts: ManagerOptions) {
    super()
    this.opts = opts
  }

  list(): RunningAgent[] { return [...this.agents.values()] }

  /** Picker changes apply to the next run; a running session keeps its settings. */
  setDefaults(d: ManagerOptions['defaults']): void { this.opts.defaults = d }

  /** Find a live run by either key — the UI may hold whichever it saw first. */
  byKey(key: string): RunningAgent | undefined {
    return this.agents.get(key) ?? [...this.agents.values()].find((a) => a.sessionId === key)
  }

  get activeCount(): number {
    return [...this.agents.values()].filter(
      (a) => ['working', 'starting', 'needsInput'].includes(a.state.kind),
    ).length
  }

  private touch(): void { this.emit('change') }

  private keyFor(a: RunningAgent): string { return a.sessionId ?? a.runId }

  /** Start a new session from a prompt. Returns the local run id immediately. */
  async start(prompt: string, opts: LaunchOptions = {}): Promise<string> {
    const runId = `run-${++this.counter}-${Date.now().toString(36)}`
    if (this.activeCount >= this.opts.maxConcurrent) {
      this.queue.push({ runId, prompt, opts })
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
  async split(parentKey: string, subtasks: SubtaskSpec[]): Promise<SplitResult> {
    const parent = this.byKey(parentKey)
    if (!parent) return { ok: false, message: 'This session is not running, so it cannot start subtasks.' }

    const specs = subtasks
      .map((t) => ({ ...t, title: t.title.trim(), prompt: t.prompt.trim() }))
      .filter((t) => t.title && t.prompt)
    if (specs.length < 2) {
      return {
        ok: false,
        message: 'A split needs at least two subtasks, each with a title and a prompt. ' +
          'If the work is one thing, just do it.',
      }
    }
    if (specs.length > MAX_SUBTASKS) {
      return {
        ok: false,
        message: `At most ${MAX_SUBTASKS} subtasks. Each one is a real agent with a real bill — ` +
          'group the small pieces together rather than making one session each.',
      }
    }

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

    const started: { key: string; title: string; branch: string }[] = []
    for (const spec of specs) {
      const runId = await this.start(spec.prompt, {
        title: spec.title,
        parent: parentKey,
        ...(parent.base ? { base: parent.base } : {}),
      })
      if (spec.tags?.length) {
        await this.opts.store.setTags(runId, spec.tags).catch(() => {})
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

  /** Continue an existing session: same worktree, resumed Claude session. */
  async send(key: string, text: string, images: readonly AttachedImage[] = []): Promise<void> {
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
    await this.start(text, { resume: key, ...(existing?.title ? { title: existing.title } : {}) })
  }

  private async launch(runId: string, prompt: string, opts: LaunchOptions): Promise<void> {
    const title = opts.title ?? titleFrom(prompt)

    // Reuse the worktree of the session being resumed, so a follow-up does not
    // strand the agent in a fresh checkout without its earlier work.
    const prior = opts.resume ? await this.opts.store.get(opts.resume) : undefined
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

    const agent: RunningAgent = {
      runId, title, history, priorUsd,
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

    const boardServer = await createBoardServer(this.opts.board, {
      store: this.opts.store,
      key: () => agent.sessionId ?? agent.runId,
      onChanged: (change?: BoardChange) => {
        if (change?.phase) {
          agent.live.push({ kind: 'phase', at: Date.now(), from: change.phase.from, to: change.phase.to })
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
      onSplit: async (subtasks) => {
        const result = await this.split(agent.sessionId ?? agent.runId, subtasks)
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
    })

    // Derived from the tool definitions, so a rename can never leave the agent
    // unable to move its own card.
    const { tool } = await loadSdk()

    const session = new AgentSession({
      taskId: runId,
      cwd: wt.path,
      permissionMode: this.opts.permissionMode,
      boardServer,
      boardTools: boardToolNames(this.opts.board, tool),
      appendSystemPrompt: buildBrief(this.opts.board, title, wt.branch),
      ...(opts.resume ? { resume: opts.resume } : {}),
      ...(this.opts.claudeExecutable ? { claudeExecutable: this.opts.claudeExecutable } : {}),
      ...(this.opts.log ? { log: this.opts.log } : {}),
      ...(this.opts.defaults.model ? { model: this.opts.defaults.model } : {}),
      ...(resolveEffort(undefined, this.opts.defaults.effort) ? { effort: resolveEffort(undefined, this.opts.defaults.effort)! } : {}),
      ...(resolveThinking(undefined, this.opts.defaults.thinking) === 'disabled' ? { thinking: 'disabled' as const } : {}),
    })
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
      void this.opts.store.adoptKey(previousKey, id).then(() => this.opts.store.patch(id, {
        phase: prior?.phase ?? this.opts.board.columns.find((c) => c.category === 'started')?.id ?? 'implementing',
        worktree: wt.path,
        branch: wt.branch,
        // Written here because this is the moment the card becomes durable: a
        // run that dies before this point has no transcript and no session to
        // resume, and discardIfUntouched() takes its worktree back. From here
        // on, a mark left behind means the host went away mid-turn.
        running: agent.startedAt,
        ...(wt.base ? { base: wt.base } : {}),
        ...(opts.parent ? { parent: opts.parent } : {}),
      }))
        .then(() => this.opts.store.rename(id, title))
        .catch((e) => {
          // Never silent: a failed rename leaves the card under Claude Code's
          // own summary, and a failed patch leaves it with no worktree link at
          // all — both look like the board losing track of a session.
          this.emit('warning', `Could not register "${title}" on the board: ${e instanceof Error ? e.message : String(e)}`)
        })
        .then(() => this.touch())
    })

    session.on('state', (s: AgentState) => {
      agent.lastEventAt = session.lastEvent
      agent.state = s
      if (s.kind !== 'needsInput') delete agent.pendingPermission
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
      else agent.live.push({ kind: 'text', at: Date.now(), text: chunk })
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
    session.on('permission', (req: PermissionRequest) => {
      agent.pendingPermission = req
      this.touch()
    })

    const finish = () => {
      delete agent.streaming
      this.sessions.delete(runId)
      // This run reached the end under its own power, so it was not cut off.
      // Zero, not undefined: a patch drops undefined and the mark would stay.
      if (agent.sessionId) void this.opts.store.patch(agent.sessionId, { running: 0 }).catch(() => {})
      this.touch()
      // A finished agent has left changes in its worktree; the host reloads the
      // review panel rather than making the user press Refresh to find out.
      this.emit('finished', agent)
      void this.drain()
    }
    session.on('done', (summary: string, costUsd?: number) => {
      agent.costUsd = costUsd
      agent.live.push({
        kind: 'result', at: Date.now(), summary,
        durationMs: Date.now() - agent.startedAt,
        ...(costUsd !== undefined ? { costUsd } : {}),
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
  }

  private async drain(): Promise<void> {
    while (this.queue.length && this.activeCount < this.opts.maxConcurrent) {
      const next = this.queue.shift()!
      try { await this.launch(next.runId, next.prompt, next.opts) }
      catch { /* surfaced through state */ }
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
    return a
      ? this.sessions.get(a.runId)?.answerPermission(requestId, allow, undefined, selections) ?? false
      : false
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
    this.agents.delete(a.runId)
    const i = this.queue.findIndex((q) => q.runId === a.runId)
    if (i >= 0) this.queue.splice(i, 1)
    this.touch()
    // Stopping frees a slot too, and nothing else was going to notice.
    void this.drain()
  }

  /** Forget a finished run so the board falls back to the on-disk transcript. */
  release(key: string): void {
    const a = this.byKey(key)
    if (a && !this.sessions.has(a.runId)) { this.agents.delete(a.runId); this.touch() }
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
  stopAll(): void { for (const a of [...this.agents.values()]) this.halt(a) }
}

/** Appended to the Claude Code system prompt. Tells the agent it owns a card. */
export function buildBrief(board: BoardConfig, title: string, branch: string): string {
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
    `Moving to "${review}" means "your turn to check it", so it REQUIRES \`howToTest\`:`,
    'a one-line summary, the concrete steps, and links to the files you changed and',
    'the command that verifies them. They become buttons on the card. The user has',
    'not read your code — assume they are starting from nothing.',
    '',
    'Use `set_tags` once you know what this work touches, so it can be found later.',
    '',
    'If what you have been asked for is really two or more UNRELATED pieces of work,',
    'use `split_task` BEFORE you change anything. Each subtask gets its own agent,',
    'its own worktree and its own card under this one, so the user can test and merge',
    'them separately. Do not use it to parallelise one coherent change, and do not use',
    'it once you have started editing — subtasks fork from where this session started,',
    'so anything already written here would be stranded.',
  ].join('\n')
}

/** A card title from a free-form prompt: first sentence, trimmed. */
export function titleFrom(prompt: string): string {
  const first = prompt.trim().split(/\n/)[0]?.trim() ?? ''
  const sentence = first.split(/(?<=[.?!])\s/)[0] ?? first
  const t = (sentence || first).replace(/\s+/g, ' ').trim()
  if (!t) return 'Untitled session'
  return t.length > 72 ? t.slice(0, 69).trimEnd() + '…' : t
}

function shortId(runId: string): string {
  return runId.replace(/^run-/, 'S').split('-').slice(0, 2).join('')
}
