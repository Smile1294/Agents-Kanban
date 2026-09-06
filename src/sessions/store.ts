/** The board's model: Claude Code's sessions, plus our board metadata.
 *
 * Sessions and transcripts come from Claude Code itself, via the SDK's session
 * API — the same JSONL under ~/.claude/projects that `claude --resume` reads.
 * We add only what Claude Code has no concept of: a board phase, tags, archive
 * state, and which worktree the session belongs to.
 *
 * The payoff is that the board is a view over your real work: a session started
 * in the terminal appears here, and a session started here resumes in the CLI.
 */
import { loadSdk, type SDKSessionInfo } from '../agent/sdk.ts'
import { CLEAR_TEST_PLAN, MetaStore, type SessionMeta, type TestPlan } from './meta.ts'
import { emptyTotals, summariseUsage, type ModelBook, type UsageMessage, type UsageTotals } from './usage.ts'
import { allRuntimes, getRuntime, type HistoricSession, type Meter, type RuntimeHistory, type RuntimeId } from '../agent/runtime.ts'

export interface BoardSession {
  id: string
  /** Which agent program this session runs on. Undefined on a session written
   *  before the board had more than one, which is Claude Code. */
  runtime?: RuntimeId
  title: string
  phase: string
  tags: string[]
  archived: boolean
  pinned: boolean
  updated: number
  created?: number
  cwd?: string
  gitBranch?: string
  worktree?: string
  branch?: string
  base?: string
  /** The session this one was split out of. One level only. */
  parent?: string
  /** When a run started, if one was still marked running. See SessionMeta.running. */
  running?: number
  contextWindow?: number
  testPlan?: TestPlan
  model?: string
  effort?: string
  thinking?: string
}

/**
 * Sessions whose run was killed by the extension host going away.
 *
 * The mark is written when a run registers and cleared when that run reaches a
 * terminal state or the user stops it, so a mark left on disk with no live
 * agent to account for it means exactly one thing: the process is gone and was
 * never told to stop. A window reload, a reinstall, a crash.
 *
 * A session with a LIVE agent is never interrupted however old its mark — that
 * agent IS the run the mark refers to. Getting this backwards would put an
 * "interrupted" banner on a card that is working in front of you.
 *
 * Pure, and separate from the host, because the alternative is asserting on it
 * through VS Code.
 */
export function interruptedSessions(
  sessions: readonly BoardSession[],
  liveKeys: Iterable<string>,
): Map<string, number> {
  const live = new Set(liveKeys)
  const out = new Map<string, number>()
  for (const s of sessions) {
    if (s.running && !live.has(s.id)) out.set(s.id, s.running)
  }
  return out
}

/** A transcript entry, already reduced to what the chat view draws. */
export type Entry =
  | {
      kind: 'prompt'; at: number; text: string
      /** How many images went with this message. The COUNT, not the bytes:
       *  this array is serialised to the webview on every repaint, and a few
       *  megabytes of base64 per frame is the per-token cost this board
       *  already has a postmortem about. */
      images?: number
    }
  | {
      kind: 'text'; at: number; text: string
      /** Which model wrote this block.
       *
       *  The transcript header said the literal string "Claude Agent" over
       *  every answer, including ones produced by `deepseek-v4-pro` on a
       *  gateway. Naming the SESSION's current model instead would be a
       *  different lie: a session can change model between turns, and an
       *  answer from an hour ago was not written by whatever is selected now.
       *  It is carried per block because that is the only place the truth is. */
      model?: string
    }
  | { kind: 'thinking'; at: number; text: string }
  | {
      kind: 'tool'; at: number; id: string; name: string; summary: string
      status: 'running' | 'ok' | 'error'
      /** When this call started, on a LIVE row only — the view ticks it up
       *  while the call is outstanding. Absent on a row rehydrated from disk:
       *  the SDK's session API does not expose message timestamps, and a timer
       *  counting from when you opened the view would be a made-up number. */
      runningSince?: number
      /** How long the call took, once it came back. This is where the answer to
       *  "what were those four minutes?" lives — the age of the last frame says
       *  something is still moving, not which call is spending the time. */
      durationMs?: number
      /** For a Task: everything its subagent did, in order. Rendered nested and
       *  collapsed, so the main thread stays readable but the work is there. */
      children?: Entry[]
    }
  | { kind: 'phase'; at: number; from: string; to: string; note?: string }
  | { kind: 'result'; at: number; summary: string; durationMs?: number; costUsd?: number }
  | { kind: 'notice'; at: number; message: string; urgency: 'info' | 'blocked' }
  | { kind: 'error'; at: number; message: string }

/**
 * How long a session-index scan is reused for.
 *
 * `listSessions()` stats and reads the head of every session file Claude Code
 * has for this project — measured at ~1.7ms per session, so ~104ms on a
 * 60-session board. The board repaints while an agent streams, and that scan
 * was being redone on every repaint, for an answer that changes only when a
 * session is created, renamed or deleted.
 *
 * A second is short enough that a session started in a terminal still appears
 * "immediately" by any human measure, and long enough that a streaming turn
 * costs one scan a second instead of dozens.
 */
const SCAN_TTL_MS = 1000

/** How many of a session's most recent messages the chat view renders. */
const TRANSCRIPT_LIMIT = 400

/**
 * How long an untouched session's parse is kept.
 *
 * Longer than the scan window on purpose: the parse is invalidated by the
 * session file CHANGING, not by time passing, so there is no correctness reason
 * to drop it after a second — and dropping it meant a finished session that
 * stayed selected while another agent streamed was fully re-parsed once a
 * second, for a file nobody had written to. This is a memory bound, not a
 * freshness one.
 */
const TRANSCRIPT_TTL_MS = 5 * 60_000

export class SessionStore {
  private readonly dir: string
  private readonly meta: MetaStore
  private readonly defaultPhase: string
  /** The last index scan, and when it started. Shared by every caller inside
   *  the window — including the two that arrive together on every repaint. */
  private scan?: { at: number; infos: Promise<SDKSessionInfo[]> }
  /** The same one-second window over every OTHER runtime's session store. */
  private foreignScan?: { at: number; sessions: Promise<Array<HistoricSession & { runtime: RuntimeId }>> }
  /**
   * One parse of a session's JSONL, serving both the transcript and its usage
   * totals. Keyed by session id and swept on write so it cannot grow into a
   * leak. The arrays handed out are shared: callers read them, never mutate.
   *
   * `key` is the session file's identity from the index — its size and mtime.
   * When it is unchanged the parse is REUSED however long ago it happened,
   * because a file that has not changed cannot parse differently. That is what
   * makes a full-transcript read affordable on the board's hot path: the usage
   * total needs every message in the file, and a finished session parses once
   * and then never again, however many times an agent elsewhere repaints.
   *
   * `at` is the fallback for a session the index does not list — a run in its
   * first moment — which falls back to the scan's own one-second window.
   */
  private readonly transcripts = new Map<
    string,
    { at: number; key: string; limit: number; entries: Entry[]; usage: UsageTotals }
  >()

  /**
   * Prices and windows for models the built-in tables cannot know about.
   *
   * A custom endpoint publishes both, and without them every session on one
   * reported `≥ $0.00` against a meter with no denominator. See `ModelBook`.
   */
  private book: ModelBook = {}

  constructor(workspaceDir: string, meta: MetaStore, defaultPhase = 'planning') {
    this.dir = workspaceDir
    this.meta = meta
    this.defaultPhase = defaultPhase
  }

  /**
   * Learn what a custom endpoint's models cost.
   *
   * The parsed-transcript cache is DROPPED when this changes, and that is the
   * whole reason this is a method rather than a field read on the way past:
   * `transcripts` caches `{entries, usage}` keyed by the session FILE's size
   * and mtime, so a file that has not changed is never re-totalled. Learning a
   * price after that point would change no number on screen — every session
   * would keep the `≥ $0.00` it was cached with until it was next written to,
   * which for a finished session is never.
   */
  setModelBook(book: ModelBook): void {
    if (JSON.stringify(book) === JSON.stringify(this.book)) return
    this.book = book
    this.transcripts.clear()
  }

  /**
   * Claude Code's session index for this project, at most once per SCAN_TTL_MS.
   *
   * Deliberately caches ONLY this half. The board metadata it is merged with —
   * phase, tags, test plan — is read fresh every time, because that is what an
   * agent changes mid-turn when it moves its own card, and a card that takes a
   * second to move is a card that looks like it did not.
   */
  private infos(): Promise<SDKSessionInfo[]> {
    const now = Date.now()
    if (!this.scan || now - this.scan.at >= SCAN_TTL_MS) {
      this.scan = {
        at: now,
        infos: loadSdk()
          .then(({ listSessions }) => listSessions({ dir: this.dir, includeWorktrees: true }))
          .catch(() => [] as SDKSessionInfo[]),
      }
    }
    return this.scan.infos
  }

  /** Drop the cached scan. Called from anything that changes what it returns —
   *  a rename or a delete — so the board never shows an old title. */
  private invalidate(): void { this.scan = undefined; this.foreignScan = undefined }

  /**
   * Every session for this project, newest first.
   * `includeWorktrees` matters: an agent works in a worktree, which is a
   * different directory, so without it every agent session vanishes from the
   * board the moment it starts.
   */
  async list(opts: { includeArchived?: boolean } = {}): Promise<BoardSession[]> {
    const [infos, metas, foreign] = await Promise.all([
      this.infos(), this.meta.getAll(), this.foreign(),
    ])

    const out: BoardSession[] = []
    for (const i of infos) {
      const m: SessionMeta = metas[i.sessionId] ?? {
        phase: this.defaultPhase, tags: [], archived: false, pinned: false, activity: [],
      }
      if (m.archived && !opts.includeArchived) continue
      out.push({
        id: i.sessionId,
        title: i.customTitle || i.summary || i.firstPrompt || 'Untitled session',
        phase: m.phase,
        tags: m.tags,
        archived: m.archived,
        pinned: m.pinned,
        updated: i.lastModified,
        ...(i.createdAt !== undefined ? { created: i.createdAt } : {}),
        ...(i.cwd ? { cwd: i.cwd } : {}),
        ...(i.gitBranch ? { gitBranch: i.gitBranch } : {}),
        ...(m.worktree ? { worktree: m.worktree } : {}),
        ...(m.branch ? { branch: m.branch } : {}),
        ...(m.base ? { base: m.base } : {}),
        ...(m.parent ? { parent: m.parent } : {}),
        ...(m.running ? { running: m.running } : {}),
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.testPlan ? { testPlan: m.testPlan } : {}),
        ...(m.model ? { model: m.model } : {}),
        ...(m.effort ? { effort: m.effort } : {}),
        ...(m.thinking ? { thinking: m.thinking } : {}),
        ...(m.runtime ? { runtime: m.runtime } : {}),
      })
    }

    // Sessions belonging to another runtime, from ITS store. Claude Code's
    // index does not know about them, so without this pass a Codex card
    // disappears from the board the moment its process ends — which a window
    // reload does to all of them at once. Same rule as the context meter: what
    // the board shows must not depend on a process being alive.
    for (const f of foreign) {
      const m = metas[f.id]
      if (m?.archived && !opts.includeArchived) continue
      out.push({
        id: f.id,
        runtime: f.runtime,
        title: f.title || 'Untitled session',
        phase: m?.phase ?? this.defaultPhase,
        tags: m?.tags ?? [],
        archived: m?.archived ?? false,
        pinned: m?.pinned ?? false,
        updated: f.updatedAt,
        ...(f.cwd ? { cwd: f.cwd } : {}),
        ...(f.model ? { model: f.model } : {}),
        ...(m?.worktree ? { worktree: m.worktree } : {}),
        ...(m?.branch ? { branch: m.branch } : {}),
        ...(m?.base ? { base: m.base } : {}),
        ...(m?.parent ? { parent: m.parent } : {}),
        ...(m?.running ? { running: m.running } : {}),
        ...(m?.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m?.testPlan ? { testPlan: m.testPlan } : {}),
        ...(m?.effort ? { effort: m.effort } : {}),
      })
    }

    return out.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated)
  }

  /**
   * Sessions belonging to a runtime other than Claude Code.
   *
   * Cached on the same one-second window as the Claude scan, and for the same
   * reason: `getState()` runs ten times a second while an agent streams, and
   * this walks a directory tree. It is deliberately forgiving — a runtime whose
   * store cannot be read contributes nothing rather than failing the whole
   * board, because the alternative is one broken agent program blanking the
   * cards of every other.
   */
  private foreign(): Promise<Array<HistoricSession & { runtime: RuntimeId }>> {
    const now = Date.now()
    if (!this.foreignScan || now - this.foreignScan.at >= SCAN_TTL_MS) {
      this.foreignScan = {
        at: now,
        sessions: Promise.all(
          allRuntimes()
            .filter((rt) => rt.id !== 'claude' && rt.history)
            .map((rt) => rt.history!.list(this.dir)
              .then((list) => list.map((s) => ({ ...s, runtime: rt.id })))
              .catch(() => [])),
        ).then((lists) => lists.flat()),
      }
    }
    return this.foreignScan.sessions
  }

  /**
   * One session by id, and a MISS is never trusted to the cache.
   *
   * `launch()` asks this which worktree a resumed session belongs to. A false
   * "not found" there does not degrade gracefully — it builds the agent a
   * second, empty worktree and strands its earlier work in the first. So a miss
   * forces a fresh scan and asks again; a hit costs nothing, and a miss costs
   * one scan on a path that runs once per session, not once per repaint.
   */
  async get(id: string): Promise<BoardSession | undefined> {
    const hit = (await this.list({ includeArchived: true })).find((s) => s.id === id)
    if (hit) return hit
    this.invalidate()
    return (await this.list({ includeArchived: true })).find((s) => s.id === id)
  }

  /**
   * Board state for a key that may be a session id OR a live run id.
   *
   * `get()` only knows about sessions Claude Code has told us about, so it
   * returns undefined for a run in its first moment — and for one whose id was
   * refused as a duplicate. That left an agent unable to read or move its own
   * card at all. The sidecar is keyed by whatever the board calls the run, so
   * it always has an answer.
   */
  async card(
    key: string,
  ): Promise<{ phase: string; tags: string[]; testPlan?: TestPlan; parent?: string; fanout?: number }> {
    // The sidecar first, and usually only. setPhase/setTags/setTestPlan write
    // ONLY to meta, so it is authoritative for all three fields — while get()
    // costs a listSessions() scan of every Claude Code project. This is the hot
    // path: every set_phase and set_tags from every concurrent agent lands here.
    const all = await this.meta.getAll()
    const m = all[key]
    if (m) {
      return {
        phase: m.phase, tags: m.tags,
        ...(m.testPlan ? { testPlan: m.testPlan } : {}),
        ...(m.parent ? { parent: m.parent } : {}),
        // How many subtasks this card was split into, so the roll-up can tell
        // "every child is settled" from "every child that has a card yet".
        ...(m.fanout ? { fanout: m.fanout } : {}),
      }
    }
    return { phase: this.defaultPhase, tags: [] }
  }

  /**
   * Where a session's work lives — its worktree, branch and base — from the
   * sidecar, which is the only thing that ever writes them. `get()` would say
   * the same, at the cost of a listSessions() scan, and would say NOTHING for
   * a key Claude Code has not indexed yet (a run in its first moment, an id
   * refused as a duplicate): the same gap `card()` exists to close. The
   * empty-string convention holds — an empty worktree is "no longer has one".
   */
  async worktreeMeta(key: string): Promise<{ worktree?: string; branch?: string; base?: string }> {
    const m = (await this.meta.getAll())[key]
    if (!m) return {}
    return {
      ...(m.worktree ? { worktree: m.worktree } : {}),
      ...(m.branch ? { branch: m.branch } : {}),
      ...(m.base ? { base: m.base } : {}),
    }
  }

  /**
   * The keys of every session split out of `key`, in creation order.
   *
   * Derived from the children rather than stored on the parent: a card's key
   * changes when Claude Code assigns a session id, and one pointer per child is
   * a fact that `MetaStore.rename()` can repoint, where a list on the parent is
   * a second copy of the truth waiting to disagree with the first.
   *
   * Sidecar only, so it costs nothing — this runs on the board's hot path.
   */
  async childrenOf(key: string): Promise<string[]> {
    const all = await this.meta.getAll()
    return Object.entries(all).filter(([, m]) => m.parent === key).map(([k]) => k)
  }

  /** Every sidecar entry, for callers rendering cards that have no session yet. */
  async allMeta(): Promise<Record<string, SessionMeta>> {
    return this.meta.getAll()
  }

  /** Carry board state from a run id to the session id Claude Code assigned. */
  async adoptKey(from: string, to: string): Promise<void> {
    await this.meta.rename(from, to)
  }

  /**
   * Rehydrate a transcript from Claude Code's own JSONL.
   *
   * NO `dir`. A session id is globally unique, and the SDK searches every
   * project directory when `dir` is omitted — whereas passing one scopes the
   * lookup to a single directory, which is exactly wrong here: an agent runs
   * with its cwd set to its WORKTREE, so its session is filed under the
   * worktree's project directory, not the workspace root. Pinning `dir` to the
   * workspace returned an empty transcript for precisely the agent sessions the
   * board exists to show, and it looked like a session with nothing in it.
   *
   * This is the same trap as `listSessions({ includeWorktrees: true })`, in the
   * opposite direction: there the scope must be widened, here it must be dropped.
   */
  async transcript(id: string, limit = TRANSCRIPT_LIMIT): Promise<Entry[]> {
    const rt = await this.runtimeOf(id)
    if (rt) return (await rt.transcript(id)) as Entry[]
    return (await this.parse(id, limit)).entries
  }

  /**
   * The history reader for a session that is NOT Claude Code's, or undefined.
   *
   * Routed on the session's own recorded runtime rather than on which store
   * happens to have a file with that id. Ids are uuids and could not realistically
   * collide, but "whichever store answers first" is a rule that silently picks
   * the wrong reader the day one does — and the symptom would be an empty
   * transcript, which reads as a lost session.
   */
  private async runtimeOf(id: string): Promise<RuntimeHistory | undefined> {
    const meta = (await this.meta.getAll())[id]
    if (!meta?.runtime || meta.runtime === 'claude') return undefined
    return getRuntime(meta.runtime)?.history
  }

  /**
   * What this session has consumed, in the unit its runtime can justify.
   *
   * Separate from `usage()` because they are not the same claim and collapsing
   * them would produce the exact number this project forbids: a Codex session
   * on a ChatGPT subscription is billed nothing per request, so folding it into
   * `UsageTotals.costUsd` would put `$0.00` — or worse, `≥ $0.00` — on a card
   * that has just spent 13% of a five-hour window. See `Meter`.
   */
  async meter(id: string): Promise<Meter> {
    const rt = await this.runtimeOf(id)
    if (rt) return (await rt.usage(id)).meter
    const totals = await this.usage(id)
    return { kind: 'usd', spentUsd: totals.costUsd, priced: totals.priced }
  }

  /**
   * What this session has cost, and how full its context is.
   *
   * Comes off the same parse as the transcript, so asking for it is free once
   * the transcript has been read. Both numbers used to exist only inside a live
   * run: restarting VS Code left the context meter with nothing to draw and the
   * spend readout with nothing to add up. See `sessions/usage.ts`.
   */
  async usage(id: string): Promise<UsageTotals> {
    const rt = await this.runtimeOf(id)
    if (rt) {
      // Context fill and its window are real for every runtime; the token
      // BREAKDOWN and the price are not, so they stay at their empty values
      // rather than being invented. `priced: true` with `costUsd: 0` is the
      // honest pair here — nothing was billed per request, so the dollar total
      // is exactly zero and is not a floor. The real figure is `meter()`.
      const u = await rt.usage(id)
      return {
        ...emptyTotals(),
        contextTokens: u.contextTokens,
        ...(u.contextWindow ? { contextWindow: u.contextWindow } : {}),
      }
    }
    return (await this.parse(id, TRANSCRIPT_LIMIT)).usage
  }

  /** The cached parse for a session, re-read only when its file has changed. */
  private async parse(
    id: string,
    limit: number,
  ): Promise<{ entries: Entry[]; usage: UsageTotals }> {
    const now = Date.now()
    const key = await this.fileKey(id)
    const hit = this.transcripts.get(id)
    // A file whose size and mtime are unchanged cannot parse differently, so
    // the age of the parse is irrelevant. Only a session the index does not
    // list — a run in its first moment — falls back to the scan's own window.
    const fresh = hit && (key ? hit.key === key : now - hit.at < SCAN_TTL_MS)
    if (fresh && hit.limit === limit) {
      // Touched, so the sweep below measures IDLE time rather than age. An
      // entry in constant use — the selected session, on every repaint — was
      // otherwise dropped and fully re-parsed every five minutes for no reason.
      hit.at = now
      return hit
    }
    const read = await this.readTranscript(id, limit)
    for (const [k, v] of this.transcripts) {
      // Swept by age, not by key: an untouched session's parse is still valid,
      // but holding every transcript this window ever showed is a leak.
      if (k !== id && now - v.at >= TRANSCRIPT_TTL_MS) this.transcripts.delete(k)
    }
    this.transcripts.set(id, { at: now, key, limit, ...read })
    return read
  }

  /** A session file's identity, as the index reports it. Empty when the index
   *  has never heard of it, which is a "cannot tell", not "unchanged". */
  private async fileKey(id: string): Promise<string> {
    const info = (await this.infos()).find((i) => i.sessionId === id)
    if (!info) return ''
    return `${info.lastModified}:${info.fileSize ?? '?'}`
  }

  private async readTranscript(
    id: string,
    limit: number,
  ): Promise<{ entries: Entry[]; usage: UsageTotals }> {
    const { getSessionMessages } = await loadSdk()
    let all: Awaited<ReturnType<typeof getSessionMessages>>
    try {
      // NO `limit` on the read. The SDK's `limit` takes the FIRST n messages,
      // not the last — verified against a 425-message session, where
      // `{limit: 400}` returned the first 400 and silently dropped the 25 most
      // recent, which are the ones anybody opening a transcript wants. The
      // window's bound is applied below, to the TAIL. The usage total needs
      // every message anyway, and this parse is cached on the file's identity,
      // so a finished session is read once and never again.
      // `includeSystemMessages: true` — the compact boundary is a SYSTEM
      // record, and the SDK gates those behind this option. Without it
      // `summariseUsage` could never see one, so a session read back from disk
      // reported its PRE-compaction context fill: a card that says it is nearly
      // out of window when the compaction just gave most of it back. That is
      // the same trap the live path has an explicit reset for; the disk path
      // could not even observe it.
      all = await getSessionMessages(id, { includeSystemMessages: true })
    } catch {
      return { entries: [], usage: emptyTotals() }
    }
    // Spend and context fill are totalled over the WHOLE session, including the
    // messages too old to render.
    const usage = summariseUsage(all as readonly UsageMessage[], this.book)
    const msgs = all.length > limit ? all.slice(all.length - limit) : all
    const entries: Entry[] = []
    const toolNames = new Map<string, { list: Entry[]; idx: number }>()
    /** Subagent work, keyed by the id of the Task tool_use that started it.
     *  Collected as we go and attached to that Task's entry at the end.
     *
     *  This used to be `if (m.parent_tool_use_id) continue` — dropped on the
     *  floor, on the grounds that it would swamp the main thread. It does not
     *  need to: nested under its own Task and collapsed, it is invisible until
     *  asked for. Dropping it meant a Task that ran for four minutes rendered
     *  as one motionless row, which is the single most common reason the board
     *  looks like it has stopped when it has not. */
    const bySubagent = new Map<string, Entry[]>()

    for (const m of msgs) {
      const body = (m.message ?? {}) as { content?: unknown }
      const at = Date.now()
      const blocks = Array.isArray(body.content)
        ? (body.content as Array<Record<string, unknown>>)
        : typeof body.content === 'string'
          ? [{ type: 'text', text: body.content }]
          : []

      // Subagent frames go into their Task's own list instead of the main one.
      // Everything below is otherwise identical, which is the point: a subagent
      // transcript is a transcript.
      const parentId = m.parent_tool_use_id ?? undefined
      let target = entries
      if (parentId) {
        let list = bySubagent.get(parentId)
        if (!list) { list = []; bySubagent.set(parentId, list) }
        target = list
      }

      // Attachments are content blocks on the user message. Counted before the
      // loop so the prompt row can say what went with it — a message read back
      // from disk otherwise renders as text alone, and an image-only message
      // renders as nothing at all.
      const imageCount = m.type === 'user'
        ? blocks.filter((b) => b.type === 'image').length
        : 0
      if (imageCount && m.type === 'user' && !parentId && !blocks.some((b) => b.type === 'text')) {
        target.push({ kind: 'prompt', at, text: '', images: imageCount })
      }

      for (const b of blocks) {
        if (m.type === 'user' && b.type === 'text' && typeof b.text === 'string') {
          // A subagent's "user" turn is the brief it was handed, not something
          // the person typed, so it must not render as their prompt.
          target.push(parentId
            ? { kind: 'text', at, text: b.text }
            : { kind: 'prompt', at, text: b.text, ...(imageCount ? { images: imageCount } : {}) })
        } else if (m.type === 'user' && b.type === 'tool_result') {
          // Tool ids are unique across the session, so one map serves both the
          // main thread and every subagent.
          const found = toolNames.get(String(b.tool_use_id))
          if (found) {
            const e = found.list[found.idx]
            if (e?.kind === 'tool') e.status = b.is_error === true ? 'error' : 'ok'
          }
        } else if (m.type === 'assistant' && b.type === 'text' && typeof b.text === 'string') {
          const wrote = (m.message as { model?: unknown } | undefined)?.model
          target.push({
            kind: 'text', at, text: b.text,
            ...(typeof wrote === 'string' && wrote ? { model: wrote } : {}),
          })
        } else if (m.type === 'assistant' && b.type === 'thinking' && typeof b.thinking === 'string') {
          target.push({ kind: 'thinking', at, text: b.thinking })
        } else if (m.type === 'assistant' && b.type === 'tool_use' && typeof b.name === 'string') {
          const toolId = String(b.id ?? '')
          toolNames.set(toolId, { list: target, idx: target.length })
          target.push({
            kind: 'tool', at, id: toolId, name: b.name,
            summary: summariseTool(b.name, b.input), status: 'running',
          })
        }
      }
    }

    // Hang each subagent's transcript off the Task that started it. A Task whose
    // children never arrived just renders as it always did.
    if (bySubagent.size) {
      for (const e of entries) {
        if (e.kind !== 'tool') continue
        const kids = bySubagent.get(e.id)
        if (kids?.length) e.children = kids
      }
    }
    return { entries, usage }
  }

  async setPhase(id: string, phase: string): Promise<void> {
    await this.meta.update(id, { phase }, this.defaultPhase)
  }

  /** How the user tests this session's work, written by the agent. */
  async setTestPlan(id: string, testPlan: TestPlan): Promise<void> {
    await this.meta.update(id, { testPlan }, this.defaultPhase)
  }
  /** Retract a test plan. Through the `CLEAR_TEST_PLAN` sentinel, because a
   *  patch drops `undefined` and so cannot unset anything — the same reason
   *  `worktree` clears with `''` and `running` with `0`. */
  async clearTestPlan(id: string): Promise<void> {
    await this.meta.update(id, { testPlan: CLEAR_TEST_PLAN })
    this.invalidate()
  }


  /**
   * Pin a session to the top of its column.
   *
   * `pinned` was parsed on read, carried into `BoardSession`, forwarded to the
   * webview and used as the PRIMARY SORT KEY below — and nothing in the
   * extension could ever set it. A sort key nobody can change is a control that
   * does not exist, dressed as one that does.
   */
  async setPinned(id: string, pinned: boolean): Promise<void> {
    await this.meta.update(id, { pinned }, this.defaultPhase)
    this.invalidate()
  }

  async setTags(id: string, tags: string[]): Promise<void> {
    await this.meta.update(id, { tags }, this.defaultPhase)
  }

  async patch(id: string, patch: Partial<SessionMeta>): Promise<void> {
    await this.meta.update(id, patch, this.defaultPhase)
  }

  /** Soft-hide from the board. The transcript stays — Claude Code owns it. */
  async archive(id: string, archived = true): Promise<void> {
    await this.meta.update(id, { archived }, this.defaultPhase)
  }

  /**
   * Permanently delete the session from Claude Code's store, and our sidecar.
   * Unscoped by directory, for the same reason as `transcript()`.
   *
   * Reports whether it actually worked, because it can silently not. This used
   * to be `catch {}` returning `void`, so "Delete permanently" promised the
   * transcript was gone from Claude Code with no way of knowing whether it was.
   * Observed: delete a session that another Claude Code window has OPEN, and
   * that window writes its own state back out afterwards — leaving a two-line
   * stub (`last-prompt`, `atis-latch`) that is enough for the session to still
   * appear in its history, with the transcript itself genuinely gone.
   *
   * Our sidecar entry is dropped either way: the card leaves the board even if
   * Claude Code's copy survives, because a card we cannot delete is worse than
   * a stale transcript.
   */
  /**
   * Drop a sidecar entry for a run that never became a session.
   *
   * Deliberately NOT `delete()`: there is no session to delete, only a board
   * entry keyed by a run id that nothing will ever look up again. `delete()`
   * would call Claude Code's `deleteSession` on a run id and report a failure
   * that means nothing.
   *
   * Without this those entries were immortal — `MetaStore.remove` is reachable
   * only through `delete()`, and the host's delete handler skips run-id keys.
   * A subtask that died before its id arrived therefore stayed in
   * `childrenOf()` forever, in a phase that is never settled, so its parent's
   * roll-up could never fire again.
   */
  async forget(key: string): Promise<void> {
    await this.meta.remove(key)
    this.invalidate()
    this.transcripts.delete(key)
  }

  async delete(id: string): Promise<{ deleted: boolean; reason?: string }> {
    const { deleteSession, getSessionInfo } = await loadSdk()
    let reason: string | undefined
    try {
      await deleteSession(id)
    } catch (e) {
      reason = e instanceof Error ? e.message : String(e)
    }
    await this.meta.remove(id)
    this.invalidate()
    this.transcripts.delete(id)

    // Verify rather than assume. Note this cannot catch a resurrection that
    // happens after we look — only the live client can stop doing that.
    const survived = await getSessionInfo(id).catch(() => undefined)
    if (!survived) return { deleted: true }
    return {
      deleted: false,
      reason: reason ??
        'Claude Code still has this session open and wrote it back after it was deleted. ' +
        'Close its tab in Claude Code, then delete again.',
    }
  }

  /** Unscoped by directory, for the same reason as `transcript()`: an agent's
   *  session is filed under its worktree, not under the workspace root.
   *
   *  Retried, because the id arrives BEFORE the file it names. Claude Code
   *  announces the session id on the `init` message and writes the session file
   *  a moment later, so renaming immediately loses a race and reports
   *  "Session <id> not found in any project directory" — a warning popup on
   *  every new session, for a condition that fixes itself in well under a
   *  second. */
  async rename(id: string, title: string): Promise<{ renamed: boolean; reason?: string }> {
    // `renameSession` is CLAUDE CODE's API and knows only Claude Code's JSONL
    // store. A Codex thread id is a uuid, so it passed the SDK's uuid guard and
    // then failed the store lookup with "not found in any project directory" —
    // which matches `retryWhileMissing`'s pattern, so every call burned ~3.5s
    // of backoff and then threw.
    //
    // That was not cosmetic. It threw on three paths at once: the adoption path
    // fired a warning toast on EVERY Codex session start, four seconds in, on a
    // card that was in fact registered and working; the agent's own `set_title`
    // came back as a tool error naming a store its session was never in, while
    // the live card had visibly taken the new name; and the user's own rename
    // from the board failed as an error dialog. A signal that can only ever say
    // "bad" is as useless as one that can only say "good".
    //
    // Refused rather than attempted, and it returns the reason instead of
    // throwing, so a caller can say something true. `RuntimeHistory` has no
    // `rename` member — a runtime that owns its own session names is a real
    // thing, and inventing one here would be the abstraction leaking.
    const runtime = await this.runtimeOf(id)
    if (runtime) return { renamed: false, reason: 'this agent owns its own session names' }
    const { renameSession } = await loadSdk()
    await retryWhileMissing(() => renameSession(id, title))
    this.invalidate()
    return { renamed: true }
  }
}

/** One-line description of a tool call for a transcript row. */
/**
 * The one line a tool call gets in the transcript.
 *
 * It has to answer "what is it doing" on its own, and for a long time it did
 * not. Three separate reasons, all visible in one screenshot:
 *
 *  - `mcp__claude_ai_Atlassian__getJiraIssue` rendered verbatim. The old prefix
 *    strip was `^mcp__[^_]+__`, which needs a server name containing no
 *    underscore — so any real MCP server name defeated it entirely.
 *  - No arguments were shown for it, because the key it puts them under is not
 *    `command`/`file_path`/`path`/`pattern`/`url`. So "fetching ACME-184" showed
 *    as a bare function name.
 *  - `Read` printed an absolute path from the worktree root, which is ~70
 *    characters of prefix that is identical on every row.
 */
/**
 * Retry an operation that can fail only because the session file has not been
 * written yet.
 *
 * Narrow on purpose: a "not found" is the one error worth waiting on, and every
 * other failure is reported immediately rather than after several seconds of
 * pointless retrying. Exported so the backoff can be tested without a session.
 */
export async function retryWhileMissing<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 7
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try { return await fn() } catch (e) {
      last = e
      const msg = e instanceof Error ? e.message : String(e)
      if (!/not found/i.test(msg)) throw e
      if (i === attempts - 1) break
      // 100, 200, 400, 800, then 1s — about 3.5s in total, which is far longer
      // than the write actually takes and still short enough not to hang a turn.
      await sleep(Math.min(1000, 100 * 2 ** i))
    }
  }
  throw last
}

export function summariseTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>

  // mcp__<server>__<tool>. The server name may contain underscores, so the
  // split is non-greedy on the FIRST `__` and greedy to the LAST.
  const mcp = /^mcp__(.+)__([^_]+(?:_[^_]+)*)$/.exec(name)
  let label = name
  if (mcp) {
    // "claude_ai_Atlassian" -> "Atlassian": a capitalised segment is the brand
    // name, and the rest is registration plumbing. With no capitalised segment
    // the whole thing IS the name ("board", "some_server"), so keep it — taking
    // the last segment there would turn "some_server" into "server".
    const segs = (mcp[1] ?? '').split('_').filter(Boolean)
    const server = segs.find((x) => /^[A-Z]/.test(x)) ?? segs.join('_')
    label = server ? `${server} · ${mcp[2]}` : (mcp[2] ?? name)
  }

  const str = (k: string): string => (typeof i[k] === 'string' ? (i[k] as string) : '')
  // Ordered by how much each one tells you, not alphabetically.
  const KEYS = [
    'command', 'file_path', 'path', 'notebook_path', 'pattern', 'query', 'url',
    'issueIdOrKey', 'issue_key', 'issueKey', 'cloudId', 'description', 'prompt',
    'phase', 'title', 'name', 'skill', 'subagent_type',
  ]
  let detail = ''
  for (const k of KEYS) {
    const v = str(k)
    if (v) { detail = v; break }
  }
  // Still nothing? Take the first short string in the input rather than showing
  // a bare tool name — an unknown MCP tool is exactly the case that needs it.
  if (!detail) {
    for (const v of Object.values(i)) {
      if (typeof v === 'string' && v.trim() && v.length <= 120) { detail = v; break }
    }
  }

  detail = shortenPath(detail).replace(/\s+/g, ' ').trim()
  return detail ? `${label}  ${detail.slice(0, 180)}` : label
}

/** An absolute path keeps its last few segments and loses the rest.
 *
 *  Every path in an agent's transcript starts with the same worktree root, so
 *  the informative half is always pushed off the end of a single-line row. */
export function shortenPath(v: string): string {
  if (!v.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(v)) return v
  if (/\s/.test(v)) return v
  const parts = v.split('/').filter(Boolean)
  if (parts.length <= 3) return v
  return '…/' + parts.slice(-3).join('/')
}
