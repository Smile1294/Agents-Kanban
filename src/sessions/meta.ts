/** Per-session metadata that Claude Code does not store for us.
 *
 * Claude Code owns the session and its transcript. It has no concept of a board
 * phase, our tags, or which worktree a session belongs to — so we keep a
 * sidecar, the same shape Nimbalyst keeps in its `ai_sessions.metadata` JSON
 * column.
 *
 * The sidecar lives in the extension's global storage, NEVER in the repository.
 * That was the original mistake: board state is not source code, and writing it
 * into the working tree meant every agent turn produced a git diff.
 *
 * Archiving is a soft flag, as in Nimbalyst — archived sessions leave the board
 * but the transcript survives, because Claude Code still owns it.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { MODEL_WINDOWS } from './usage.ts'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type ThinkingMode = 'enabled' | 'disabled'

export const EFFORT_LEVELS: { key: EffortLevel; label: string }[] = [
  { key: 'low', label: 'Low' },
  { key: 'medium', label: 'Medium' },
  { key: 'high', label: 'High' },
  { key: 'xhigh', label: 'xHigh' },
  { key: 'max', label: 'Max' },
]

/**
 * The picker's options. The `agentsKanban.model` default MUST be one of these
 * ids, or the composer shows a nameless agent — smoke.mjs asserts exactly that.
 *
 * `context` is the label under the picker, and it is DERIVED from the window
 * table in `usage.ts` rather than written out again here. It used to be its own
 * string, and said 200K for all three when two of them are 1M. Now there is one
 * place to edit, and a label that disagrees with the meter beside it is not
 * expressible.
 *
 * The label is still not what the live meter measures against: that is the
 * window the SDK reports per run (`modelUsage[].contextWindow`), which is
 * authoritative and can be smaller. The table is the fallback for a session
 * with no run left to ask — see MODEL_WINDOWS.
 *
 * Ids are the canonical undated forms. `claude-haiku-4-5-20251001` also works,
 * but dated suffixes are not the documented ids and drift as snapshots move.
 */
export const MODELS: { id: string; label: string; context: string }[] = [
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
].map((m) => ({ ...m, context: windowLabel(MODEL_WINDOWS[m.id]) }))

/** `1M`, `200K` — the picker's shorthand for a window size. */
export function windowLabel(tokens: number | undefined): string {
  if (!tokens) return '?'
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`
  return `${Math.round(tokens / 1000)}K`
}

/**
 * How to test what an agent built.
 *
 * An agent that parks its card in a review column and says nothing has handed
 * the user a puzzle: which files, run what, look where. So the phase move now
 * carries the answer, and the board renders it as something you can click.
 *
 * `kind` decides what clicking does, which is why it is a closed set:
 *  - `file`    a path inside the worktree — opens in the editor
 *  - `command` a shell line — opens a terminal already in the worktree
 *  - `url`     an address — opens in the browser
 */
export type TestLinkKind = 'file' | 'command' | 'url'

export interface TestLink {
  label: string
  target: string
  kind: TestLinkKind
}

export interface TestPlan {
  summary: string
  steps: string[]
  links: TestLink[]
  at: number
}

export function normaliseTestPlan(raw: unknown): TestPlan | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const summary = typeof r.summary === 'string' ? r.summary.trim() : ''
  const steps = Array.isArray(r.steps)
    ? r.steps.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim())
    : []
  const links: TestLink[] = Array.isArray(r.links)
    ? (r.links as unknown[]).flatMap((l) => {
        if (!l || typeof l !== 'object') return []
        const o = l as Record<string, unknown>
        const target = typeof o.target === 'string' ? o.target.trim() : ''
        if (!target) return []
        const kind: TestLinkKind =
          o.kind === 'file' || o.kind === 'command' || o.kind === 'url' ? o.kind : guessLinkKind(target)
        const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : target
        return [{ label, target, kind }]
      })
    : []
  if (!summary && !steps.length && !links.length) return undefined
  return {
    summary,
    steps,
    links,
    at: typeof r.at === 'number' ? r.at : Date.now(),
  }
}

/** Best guess when an agent omits `kind`, so a usable link is never dropped. */
export function guessLinkKind(target: string): TestLinkKind {
  if (/^https?:\/\//i.test(target)) return 'url'
  // A bare path with no spaces is a file; anything with an argument is a command.
  if (/^[\w./@~-]+$/.test(target) && /[./]/.test(target)) return 'file'
  return 'command'
}

/** One phase change, mirroring the tracker activity shape. */
export interface ActivityEntry {
  action: 'phase_changed' | 'tags_changed' | 'archived' | 'unarchived'
  oldValue?: string
  newValue?: string
  at: number
}

export interface SessionMeta {
  phase: string
  tags: string[]
  archived: boolean
  pinned: boolean
  /** The worktree's directory. An EMPTY STRING means "no longer has one" —
   *  `undefined` cannot say that, because stripUndefined() drops it and the
   *  removed worktree's path would survive the patch that meant to clear it. */
  worktree?: string
  branch?: string
  /** The branch the worktree forked from — the other half of every diff and
   *  the target of the merge back. Without it a reloaded session can only guess. */
  base?: string
  /**
   * The session that split this one out of a larger task, if any.
   *
   * One level only, enforced in code: a subtask cannot split again. Stored on
   * the CHILD rather than as a list on the parent, because a card's key changes
   * when Claude Code assigns a session id — one pointer to repoint is a fact,
   * a list of them is a bookkeeping problem. `rename()` repoints it.
   */
  parent?: string
  /** How the user tests this session's work. Written by the agent when it moves
   *  into a review column; rendered on the card as clickable actions. */
  testPlan?: TestPlan
  /**
   * The context window the last run of this session actually got.
   *
   * Written from the SDK's `modelUsage[].contextWindow`, which is the only
   * authoritative figure and can be SMALLER than the model's maximum — a
   * compaction policy may pin a 1M-window model to 200K. After a restart there
   * is no run left to ask, so this is what keeps the meter measuring against
   * the right denominator instead of the model table's optimistic one.
   */
  contextWindow?: number
  /** Per-session overrides; unset means fall through to the workspace default. */
  model?: string
  effort?: EffortLevel
  thinking?: ThinkingMode
  activity: ActivityEntry[]
}

/** Keep the activity log bounded, as Nimbalyst does. */
const MAX_ACTIVITY = 100

export function emptyMeta(phase: string): SessionMeta {
  return { phase, tags: [], archived: false, pinned: false, activity: [] }
}

/**
 * A complete session cannot still be awaiting input. Normalising at every write
 * boundary stops the board, the card badge and the transcript disagreeing.
 */
export function normalise(m: SessionMeta): SessionMeta {
  const tags = [...new Set(m.tags.filter((t) => typeof t === 'string' && t.trim()))]
  return { ...m, tags, activity: m.activity.slice(-MAX_ACTIVITY) }
}

export class MetaStore {
  private readonly file: string
  private cache: Record<string, SessionMeta> | undefined
  private writing: Promise<void> = Promise.resolve()
  private writeSeq = 0

  /** @param dir extension global storage; @param workspaceRoot scopes the file */
  constructor(dir: string, workspaceRoot: string) {
    this.file = path.join(dir, 'sessions', `${encodeURIComponent(workspaceRoot)}.json`)
  }

  private async all(): Promise<Record<string, SessionMeta>> {
    if (this.cache) return this.cache
    let raw = ''
    try { raw = await fs.readFile(this.file, 'utf8') } catch { /* first run */ }
    let parsed: unknown
    try { parsed = raw ? JSON.parse(raw) : {} } catch { parsed = {} }
    const out: Record<string, SessionMeta> = {}
    if (parsed && typeof parsed === 'object') {
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        const m = v as Partial<SessionMeta>
        const testPlan = normaliseTestPlan(m.testPlan)
        out[id] = normalise({
          phase: typeof m.phase === 'string' ? m.phase : 'planning',
          tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [],
          archived: m.archived === true,
          pinned: m.pinned === true,
          ...(typeof m.worktree === 'string' ? { worktree: m.worktree } : {}),
          ...(typeof m.branch === 'string' ? { branch: m.branch } : {}),
          ...(typeof m.base === 'string' ? { base: m.base } : {}),
          ...(typeof m.parent === 'string' ? { parent: m.parent } : {}),
          ...(testPlan ? { testPlan } : {}),
          ...(typeof m.model === 'string' ? { model: m.model } : {}),
          ...(typeof m.effort === 'string' ? { effort: m.effort as EffortLevel } : {}),
          ...(typeof m.thinking === 'string' ? { thinking: m.thinking as ThinkingMode } : {}),
          activity: Array.isArray(m.activity) ? (m.activity as ActivityEntry[]) : [],
        })
      }
    }
    this.cache = out
    return out
  }

  async get(id: string, defaultPhase = 'planning'): Promise<SessionMeta> {
    return (await this.all())[id] ?? emptyMeta(defaultPhase)
  }

  async getAll(): Promise<Record<string, SessionMeta>> {
    return { ...(await this.all()) }
  }

  /** Patch one session's metadata, recording phase and tag changes as activity. */
  async update(id: string, patch: Partial<SessionMeta>, defaultPhase = 'planning'): Promise<SessionMeta> {
    const all = await this.all()
    const before = all[id] ?? emptyMeta(defaultPhase)
    const activity = [...before.activity]

    if (patch.phase !== undefined && patch.phase !== before.phase) {
      activity.push({ action: 'phase_changed', oldValue: before.phase, newValue: patch.phase, at: Date.now() })
    }
    if (patch.tags !== undefined && patch.tags.join(',') !== before.tags.join(',')) {
      activity.push({ action: 'tags_changed', oldValue: before.tags.join(','), newValue: patch.tags.join(','), at: Date.now() })
    }
    if (patch.archived !== undefined && patch.archived !== before.archived) {
      activity.push({ action: patch.archived ? 'archived' : 'unarchived', at: Date.now() })
    }

    const next = normalise({ ...before, ...stripUndefined(patch), activity })
    all[id] = next
    await this.flush()
    return next
  }

  /**
   * Move an entry from one key to another, merging into anything already there.
   *
   * Board state is keyed by `sessionId ?? runId`, because a run has no session
   * id for its first moment and may never get one. When the real id arrives,
   * whatever the agent already wrote under the run id has to follow it, or the
   * phase and test plan it recorded in that window are silently orphaned.
   */
  async rename(from: string, to: string): Promise<void> {
    if (from === to) return
    const all = await this.all()
    // Subtasks point at their parent by key, and a parent's key changes the
    // moment Claude Code assigns it a session id — which is exactly when this
    // runs. Repoint them here or every child is orphaned seconds after it
    // starts, still running, with nothing on the board joining it to anything.
    // Done before the early return: children can outlive a parent's own entry.
    let repointed = false
    for (const [k, m] of Object.entries(all)) {
      if (m.parent === from) { all[k] = { ...m, parent: to }; repointed = true }
    }
    const src = all[from]
    if (!src) { if (repointed) await this.flush(); return }
    const dst = all[to]
    all[to] = normalise(
      dst
        // Anything already written under the real id is newer and wins; the
        // activity logs concatenate so neither half of the run is lost.
        ? { ...src, ...stripUndefined(dst as object) as Partial<SessionMeta>, activity: [...src.activity, ...dst.activity] } as SessionMeta
        : src,
    )
    delete all[from]
    await this.flush()
  }

  async remove(id: string): Promise<void> {
    const all = await this.all()
    delete all[id]
    await this.flush()
  }

  private async flush(): Promise<void> {
    const snapshot = JSON.stringify(this.cache ?? {}, null, 2)
    const seq = ++this.writeSeq

    // Serialise writes so two rapid updates cannot interleave — but chain on
    // SETTLEMENT, not on success.
    //
    // This was `this.writing.then(write, () => {})`, which reads like "ignore
    // the previous failure". It does the opposite: when the previous write
    // rejected, the rejection handler ran INSTEAD of the write, so the next
    // update wrote nothing — and resolved, so its caller was told it had been
    // saved. One transient failure silently swallowed the phase change after it.
    const run = this.writing.then(
      () => this.writeFile(snapshot, seq),
      () => this.writeFile(snapshot, seq),
    )
    // The queue survives this write's outcome; the caller still hears about it.
    this.writing = run.then(() => {}, () => {})
    return run
  }

  private async writeFile(snapshot: string, seq: number): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    // Unique per write: a shared temp name is only safe while the queue holds,
    // and the queue is exactly what fails under the condition above.
    const tmp = `${this.file}.${process.pid}.${seq}.tmp`
    try {
      await fs.writeFile(tmp, snapshot, 'utf8')
      await fs.rename(tmp, this.file)
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch(() => {})
      throw e
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
}

/**
 * An explicit per-session value wins, then the workspace default, then nothing —
 * leaving the CLI on its own default. Skipping the last step is a real bug:
 * the picker shows "Max" while the session quietly runs at the CLI's "high".
 */
export function resolveEffort(session: unknown, workspaceDefault: EffortLevel | undefined): EffortLevel | undefined {
  const valid = (v: unknown): v is EffortLevel =>
    typeof v === 'string' && EFFORT_LEVELS.some((e) => e.key === v)
  if (valid(session)) return session
  if (valid(workspaceDefault)) return workspaceDefault
  return undefined
}

/**
 * "Extended: On" means OMIT the thinking option so the model runs its adaptive
 * default. Only "Off" sends anything, and some models reject `disabled`
 * outright — the caller falls back to omitting when that happens.
 */
export function resolveThinking(session: unknown, workspaceDefault: ThinkingMode | undefined): ThinkingMode {
  const valid = (v: unknown): v is ThinkingMode => v === 'enabled' || v === 'disabled'
  if (valid(session)) return session
  if (valid(workspaceDefault)) return workspaceDefault
  return 'enabled'
}
