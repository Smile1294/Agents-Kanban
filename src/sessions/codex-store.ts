/** Reading Codex's own session store.
 *
 * The rule this file exists for is in CLAUDE.md and applies to every runtime,
 * not just Claude Code: **a number the board shows must not depend on a process
 * being alive.** Context fill, the meter and the transcript all have to survive
 * the extension host going away — which a VS Code restart does to every session
 * at once. For Claude that means `~/.claude/projects/…`; for Codex it means
 * this.
 *
 * ## The layout
 *
 * ```
 * $CODEX_HOME/                       (~/.codex, or CODEX_HOME)
 *   session_index.jsonl              {id, thread_name, updated_at} per line
 *   sessions/YYYY/MM/DD/
 *     rollout-<iso>-<uuid>.jsonl     one session, one line per record
 * ```
 *
 * Two things about it decide the shape of the code here.
 *
 * **The index has no `cwd`.** Claude Code keys its store by encoded working
 * directory, so "which sessions belong to this worktree" is a directory
 * listing. Codex keys by date, and the cwd is inside the file — in the first
 * record. So `list()` opens each rollout and reads ONLY its first line, newest
 * day first, and stops once it has looked at `SCAN_LIMIT` of them. A full parse
 * per session would be the render-path cost this project already has a
 * postmortem about; a `head -1` is a few hundred bytes.
 *
 * **A rollout is append-only.** That makes a cached parse safe to reuse for as
 * long as the file's size and mtime are unchanged, and it is why the transcript
 * cache below can be keyed on those two numbers rather than invalidated on a
 * timer.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { Entry } from './store.ts'
import { summariseTool } from './store.ts'
import type { HistoricSession, Meter, RuntimeHistory } from '../agent/runtime.ts'

/**
 * Where Codex keeps everything, honouring `CODEX_HOME`.
 *
 * It lives HERE, in the module that owns the on-disk layout, rather than beside
 * the runtime that spawns the CLI — because the runtime needs the store (for
 * `history`) and the store needs the home, and having them import each other
 * puts `codexRuntime`'s `history:` initialiser in a temporal dead zone whenever
 * this file happens to load first. That is a crash with a stack trace pointing
 * at neither module, so the cycle is removed rather than tolerated.
 *
 * Not a constant, because the launch gate seeds a throwaway home precisely so
 * it does not read the machine's real sessions — exactly as it already does
 * with `CLAUDE_CONFIG_DIR`. A hardcoded `~/.codex` would make `smoke.mjs`
 * non-hermetic and its assertions dependent on whoever ran it.
 */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEX_HOME?.trim()) return env.CODEX_HOME.trim()
  const home = env.HOME || env.USERPROFILE || ''
  return path.join(home, '.codex')
}

/**
 * How many rollout files `list()` will open before giving up.
 *
 * A cap rather than a full scan because the store is global to the machine
 * rather than per project: someone who has used Codex daily for a year has
 * thousands of sessions, and all but a handful belong to other repositories.
 * Newest first, so the cap costs the oldest sessions — the ones a board would
 * not show anyway.
 */
const SCAN_LIMIT = 400

/** Parsed rollouts, keyed by path, valid while size and mtime are unchanged. */
const parsed = new Map<string, { size: number; mtime: number; entries: Entry[]; usage: CodexUsage }>()

/** Where the head scan got to, refreshed at most this often. */
const LIST_TTL_MS = 1000
let listCache: { at: number; sessions: HistoricSession[] } | undefined

export interface CodexUsage {
  contextTokens: number
  contextWindow?: number
  meter: Meter
  model?: string
}

/**
 * The last filesystem walk, on the same one-second window `list()` uses.
 *
 * `rolloutFiles()` readdirs `sessions/` and then every year, month and day
 * directory under it, and the store is global to the MACHINE, not per project —
 * "someone who has used Codex daily for a year has thousands of sessions", as
 * `SCAN_LIMIT` already says. `list()` caps and caches; `load()` did neither, and
 * `getState()` calls it TWICE per repaint for a selected Codex card, on a path
 * that `refreshAll()` drives per streamed token. That is precisely the cost the
 * coalescer exists to bound, reintroduced below it.
 *
 * A path list cannot go stale in a harmful way inside a second: a rollout that
 * appears during the window is picked up on the next one, and one that
 * disappears fails its own `stat` and is handled already.
 */
let walkCache: { at: number; home: string; files: Promise<string[]> } | undefined

async function rolloutFiles(home: string): Promise<string[]> {
  const now = Date.now()
  if (walkCache && walkCache.home === home && now - walkCache.at < LIST_TTL_MS) return walkCache.files
  // The PROMISE, not the result: two callers arriving together — which is
  // exactly what `getState()` does — must share one walk rather than each
  // starting their own.
  const files = walkRollouts(home)
  walkCache = { at: now, home, files }
  return files
}

/** Every rollout file, newest first. */
async function walkRollouts(home: string): Promise<string[]> {
  const root = path.join(home, 'sessions')
  const out: string[] = []
  // YYYY / MM / DD, each sorted descending, so the walk is newest-first without
  // stating every file to sort by mtime.
  const desc = async (dir: string): Promise<string[]> => {
    try {
      const names = await fs.readdir(dir)
      return names.sort((a, b) => b.localeCompare(a))
    } catch { return [] }
  }
  for (const y of await desc(root)) {
    for (const m of await desc(path.join(root, y))) {
      for (const d of await desc(path.join(root, y, m))) {
        const dir = path.join(root, y, m, d)
        for (const f of await desc(dir)) {
          if (f.startsWith('rollout-') && f.endsWith('.jsonl')) out.push(path.join(dir, f))
        }
      }
    }
  }
  return out
}

/**
 * The first line of a file, without reading the rest of it.
 *
 * The comment here used to say a rollout's `session_meta` is "in the first few
 * hundred bytes", and it is not: `session_meta` embeds
 * `payload.instructions` — the whole Codex system prompt. Measured against
 * every real rollout on the machine this was found on, the first line is
 * **22,168 to 22,385 bytes**. With a single fixed 8,192-byte read there was no
 * newline in the buffer, `bytesRead === buf.length`, and this returned
 * `undefined` for every rollout Codex has ever written.
 *
 * That is not a slow list, it is an EMPTY one. `list()` skips any file whose
 * first line it cannot read, and `SessionStore.foreign()` is the only source of
 * a card for a non-Claude session — so every Codex card disappeared from the
 * board the moment `AgentManager` stopped holding it in memory: on Stop, on a
 * window reload, on archive-and-unarchive. The worktree stayed on disk with an
 * unmerged branch and no card pointing at it. This file's own docstring says it
 * exists so that "the transcript, the meter and the context fill all have to
 * survive the extension host going away".
 *
 * So it reads in chunks until it finds a newline, with a CAP rather than a
 * single attempt — the point of not reading the whole file stands, since a
 * rollout can be megabytes. The cap is generous enough for a system prompt that
 * grows, and reaching it returns `undefined` the same way a genuinely
 * unparseable file does.
 *
 * `bytesRead < CHUNK` is the end-of-file case and returns what there is: a
 * rollout with exactly one line and no trailing newline is still a rollout.
 */
const FIRST_LINE_CHUNK = 64 * 1024
/** Codex's own first records measure ~22KB. A megabyte is room for that to grow
 *  by a factor of forty before a session goes missing again — and if one ever
 *  does, `list()` skips it rather than reading a whole rollout per card on the
 *  render path. */
const FIRST_LINE_CAP = 1024 * 1024
async function firstLine(file: string): Promise<string | undefined> {
  let handle
  try {
    handle = await fs.open(file, 'r')
    let text = ''
    let at = 0
    const buf = Buffer.alloc(FIRST_LINE_CHUNK)
    while (at < FIRST_LINE_CAP) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, at)
      if (bytesRead <= 0) return text || undefined
      at += bytesRead
      text += buf.subarray(0, bytesRead).toString('utf8')
      const nl = text.indexOf('\n')
      if (nl >= 0) return text.slice(0, nl)
      // Short read: that was the end of the file, and it has no newline.
      if (bytesRead < buf.length) return text || undefined
    }
    return undefined
  } catch {
    return undefined
  } finally {
    await handle?.close().catch(() => {})
  }
}

/** Thread names, as Codex's own index records them.
 *
 *  This is the field the Codex UI shows and `thread/name/set` writes — the
 *  direct analogue of `renameSession()` on the Claude side, which is why the
 *  board uses it rather than inventing a title from the first prompt. */
async function threadNames(home: string): Promise<Map<string, { title: string; at: number }>> {
  const out = new Map<string, { title: string; at: number }>()
  try {
    const raw = await fs.readFile(path.join(home, 'session_index.jsonl'), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const d = JSON.parse(line) as Record<string, unknown>
        const id = typeof d.id === 'string' ? d.id : undefined
        if (!id) continue
        const title = typeof d.thread_name === 'string' ? d.thread_name : ''
        const at = typeof d.updated_at === 'string' ? Date.parse(d.updated_at) : 0
        if (title) out.set(id, { title, at: Number.isFinite(at) ? at : 0 })
      } catch { /* one bad line is not a bad index */ }
    }
  } catch { /* no index yet: every session simply has no name */ }
  return out
}

/** The uuid Codex uses as the thread id, taken from the filename.
 *
 *  Cheaper and more reliable than parsing: the id is in both places and the
 *  filename is already in hand. `rollout-2026-05-16T23-36-11-<uuid>.jsonl`. */
function idFromName(file: string): string | undefined {
  const m = /rollout-.*?-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path.basename(file))
  return m?.[1]
}

export const codexHistory: RuntimeHistory = {
  async list(dir: string): Promise<HistoricSession[]> {
    const now = Date.now()
    if (listCache && now - listCache.at < LIST_TTL_MS) {
      return listCache.sessions.filter((s) => samePath(s.cwd, dir))
    }
    const home = codexHome()
    const [files, names] = await Promise.all([rolloutFiles(home), threadNames(home)])
    const sessions: HistoricSession[] = []
    for (const file of files.slice(0, SCAN_LIMIT)) {
      const head = await firstLine(file)
      if (!head) continue
      let meta: Record<string, unknown>
      try {
        const rec = JSON.parse(head) as Record<string, unknown>
        if (rec.type !== 'session_meta') continue
        meta = (rec.payload ?? {}) as Record<string, unknown>
      } catch { continue }
      const id = (typeof meta.id === 'string' && meta.id) || idFromName(file)
      const cwd = typeof meta.cwd === 'string' ? meta.cwd : undefined
      if (!id || !cwd) continue
      const named = names.get(id)
      const stamp = typeof meta.timestamp === 'string' ? Date.parse(meta.timestamp) : 0
      sessions.push({
        id,
        cwd,
        updatedAt: named?.at || (Number.isFinite(stamp) ? stamp : 0),
        ...(named?.title ? { title: named.title } : {}),
        ...(typeof meta.model === 'string' ? { model: meta.model } : {}),
      })
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    listCache = { at: now, sessions }
    return sessions.filter((s) => samePath(s.cwd, dir))
  },

  async transcript(id: string): Promise<Entry[]> {
    const found = await load(id)
    return found?.entries ?? []
  },

  async usage(id: string): Promise<CodexUsage> {
    const found = await load(id)
    return found?.usage ?? { contextTokens: 0, meter: { kind: 'unknown' } }
  },

  /**
   * Remove a rollout, and the index row that points at it.
   *
   * Both halves matter. The rollout is what `list()` walks, so leaving it makes
   * the card come back on the next scan — which is the bug this exists to fix.
   * The index is Codex's OWN resume list, so leaving that row puts a dangling
   * entry in `codex resume` pointing at a file that is gone.
   *
   * A missing rollout answers `false` rather than throwing: two board windows,
   * or a second click on a batch, must not raise a failure dialog for work that
   * is already done.
   */
  async delete(id: string): Promise<boolean> {
    const home = codexHome()
    let file = (await rolloutFiles(home)).find((f) => idFromName(f) === id)
    if (!file) {
      // Same re-walk as `load()`: the cached listing may predate the file.
      walkCache = undefined
      file = (await rolloutFiles(home)).find((f) => idFromName(f) === id)
    }
    if (!file) return false
    await fs.rm(file, { force: true })
    parsed.delete(file)
    await pruneIndex(home, id)
    _resetCodexCaches()
    return true
  },
}

/**
 * Drop one id from `session_index.jsonl`, leaving every other line byte for
 * byte as it was.
 *
 * Rewritten line-wise rather than parsed and re-serialised: this is Codex's
 * file, it may carry fields this build has never heard of, and round-tripping
 * it through our own idea of the shape would quietly rewrite them. A line we
 * cannot parse is KEPT — it is not ours to discard.
 */
async function pruneIndex(home: string, id: string): Promise<void> {
  const file = path.join(home, 'session_index.jsonl')
  const raw = await fs.readFile(file, 'utf8').catch(() => undefined)
  if (raw === undefined) return
  const keep = raw.split('\n').filter((line) => {
    if (!line.trim()) return false
    try {
      return (JSON.parse(line) as { id?: unknown }).id !== id
    } catch {
      return true
    }
  })
  await fs.writeFile(file, keep.length ? `${keep.join('\n')}\n` : '', 'utf8')
}

/** Locate and parse one session, reusing the last parse while the file is
 *  unchanged. Append-only files make that safe without a TTL. */
async function load(id: string): Promise<{ entries: Entry[]; usage: CodexUsage } | undefined> {
  const home = codexHome()
  const files = await rolloutFiles(home)
  const file = files.find((f) => idFromName(f) === id)
  // A rollout the cached walk has not seen — one created since the window
  // opened. Re-walk ONCE for it rather than never finding it, which would make
  // a freshly-started Codex session's transcript unreadable for a second.
  if (!file) {
    walkCache = undefined
    const fresh = await rolloutFiles(home)
    const late = fresh.find((f) => idFromName(f) === id)
    if (!late) return undefined
    return loadFile(late)
  }
  return loadFile(file)
}

async function loadFile(file: string): Promise<{ entries: Entry[]; usage: CodexUsage } | undefined> {
  let stat
  try { stat = await fs.stat(file) } catch { return undefined }
  const hit = parsed.get(file)
  if (hit && hit.size === stat.size && hit.mtime === stat.mtimeMs) return hit
  let raw: string
  try { raw = await fs.readFile(file, 'utf8') } catch { return undefined }
  const result = parseRollout(raw)
  parsed.set(file, { size: stat.size, mtime: stat.mtimeMs, ...result })
  return result
}

/**
 * A rollout file, as board transcript entries and a usage total.
 *
 * Exported and pure so it can be tested against the REAL files on a machine
 * that has used Codex — the same standard `sessions/store.test.ts` holds itself
 * to, and for the same reason: a mock of a format we do not own proves only
 * that we can read our own mock.
 *
 * ## What is deliberately NOT rendered
 *
 * A rollout carries every record the model saw, including the whole system
 * prompt, the permissions preamble and the collaboration-mode instructions, as
 * `role: "developer"` and `role: "user"` messages. Replaying those into the
 * transcript would open every Codex card with several thousand words of
 * boilerplate the user did not write. So user-side text comes from the
 * `user_message` EVENT, which is what the person actually typed, and
 * `response_item` messages are read for the assistant side only.
 *
 * Reasoning is usually absent by design: Codex stores it as
 * `encrypted_content` with an empty `summary`, so there is nothing to show and
 * nothing is invented to fill the gap.
 */
export function parseRollout(raw: string): { entries: Entry[]; usage: CodexUsage } {
  const entries: Entry[] = []
  const usage: CodexUsage = { contextTokens: 0, meter: { kind: 'unknown' } }
  /** Open tool rows by Codex's call id, so an output resolves the row that
   *  started it rather than appending a second one. */
  const open = new Map<string, Extract<Entry, { kind: 'tool' }>>()

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let rec: Record<string, unknown>
    try { rec = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) || 0 : 0
    const p = (rec.payload ?? {}) as Record<string, unknown>
    const kind = typeof p.type === 'string' ? p.type : ''

    switch (rec.type) {
      case 'session_meta':
        if (typeof p.model === 'string') usage.model = p.model
        break

      case 'turn_context':
        // The model can change between turns; the LAST one is what the meter's
        // label should name.
        if (typeof p.model === 'string') usage.model = p.model
        break

      case 'event_msg':
        switch (kind) {
          case 'user_message': {
            const text = typeof p.message === 'string' ? p.message : ''
            if (text) {
              const images = Array.isArray(p.images) ? p.images.length : 0
              entries.push({ kind: 'prompt', at, text, ...(images ? { images } : {}) })
            }
            break
          }
          case 'token_count':
            readUsage(p, usage)
            break
          case 'task_complete': {
            const summary = typeof p.last_agent_message === 'string' ? p.last_agent_message : ''
            entries.push({ kind: 'result', at, summary })
            break
          }
          case 'turn_aborted': {
            const reason = typeof p.reason === 'string' ? p.reason : 'aborted'
            entries.push({
              kind: 'notice', at, urgency: 'info',
              message: reason === 'interrupted' ? 'You interrupted this turn.' : `The turn stopped: ${reason}.`,
            })
            break
          }
          case 'context_compacted':
            // The same divider the Claude path draws on `compact_boundary`, and
            // for the same reason: without it the meter appears to have jumped
            // backwards for no reason anybody can see.
            entries.push({ kind: 'notice', at, urgency: 'info', message: 'Codex compacted the conversation here.' })
            usage.contextTokens = 0
            break
          default:
            break
        }
        break

      case 'response_item':
        switch (kind) {
          case 'message': {
            if (p.role !== 'assistant') break
            const text = textOf(p.content)
            if (text) entries.push({ kind: 'text', at, text })
            break
          }
          case 'reasoning': {
            const text = textOf(p.summary)
            if (text) entries.push({ kind: 'thinking', at, text })
            break
          }
          case 'function_call':
          case 'custom_tool_call': {
            const id = typeof p.call_id === 'string' ? p.call_id : `${entries.length}`
            const name = typeof p.name === 'string' ? p.name : 'tool'
            const input = kind === 'function_call' ? jsonish(p.arguments) : { input: p.input }
            const row: Extract<Entry, { kind: 'tool' }> = {
              kind: 'tool', at, id, name: toolLabel(name),
              summary: summariseTool(toolLabel(name), input),
              status: 'running',
            }
            open.set(id, row)
            entries.push(row)
            break
          }
          case 'function_call_output':
          case 'custom_tool_call_output': {
            const id = typeof p.call_id === 'string' ? p.call_id : ''
            const row = open.get(id)
            if (!row) break
            open.delete(id)
            const out = outputMeta(p.output)
            row.status = out.ok ? 'ok' : 'error'
            if (out.durationMs) row.durationMs = out.durationMs
            break
          }
          default:
            break
        }
        break

      default:
        break
    }
  }

  // A row whose output never arrived belongs to a turn that was cut off. Left
  // as `running` it would tick a timer forever on a session with no process;
  // marked ok it would claim a result nobody saw.
  for (const row of open.values()) row.status = 'error'

  return { entries, usage }
}

/** Codex's tool names, in the board's vocabulary.
 *
 *  Only where the two genuinely mean the same thing, so a row reads the same
 *  whichever agent produced it. Anything else keeps Codex's own name rather
 *  than being forced into a Claude-shaped box the user would then have to
 *  translate back. */
function toolLabel(name: string): string {
  switch (name) {
    case 'exec_command':
    case 'shell':
    case 'unified_exec':
      return 'Bash'
    case 'apply_patch':
      return 'Edit'
    case 'update_plan':
      return 'TodoWrite'
    case 'web_search':
      return 'WebSearch'
    default:
      return name
  }
}

/** Text out of a Codex content array, whatever the block is called.
 *  `output_text` for assistant messages, `input_text` for user ones,
 *  `summary_text` inside reasoning summaries. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (!block || typeof block !== 'object') continue
    const b = block as Record<string, unknown>
    const t = b.text ?? b.summary ?? b.content
    if (typeof t === 'string') parts.push(t)
  }
  return parts.join('\n').trim()
}

/** A tool call's arguments, which Codex sends as a JSON STRING rather than an
 *  object. Left as `{ arguments }` when it does not parse, so a row still says
 *  something instead of vanishing. */
function jsonish(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : { arguments: raw }
  } catch {
    return { arguments: raw }
  }
}

/** Whether a tool call succeeded, and how long it took.
 *
 *  Codex nests this: the output is a JSON string carrying `{output, metadata:
 *  {exit_code, duration_seconds}}` for the tools that have one, and a bare
 *  string for the tools that do not. A missing exit code is treated as success,
 *  because most tools have none and marking every `update_plan` as failed would
 *  make the ✕ meaningless. */
function outputMeta(raw: unknown): { ok: boolean; durationMs?: number } {
  if (typeof raw !== 'string') return { ok: true }
  try {
    const v = JSON.parse(raw) as Record<string, unknown>
    const meta = (v.metadata ?? {}) as Record<string, unknown>
    const code = typeof meta.exit_code === 'number' ? meta.exit_code : undefined
    const secs = typeof meta.duration_seconds === 'number' ? meta.duration_seconds : undefined
    return {
      ok: code === undefined || code === 0,
      ...(secs ? { durationMs: Math.round(secs * 1000) } : {}),
    }
  } catch {
    return { ok: true }
  }
}

/**
 * Context fill and the meter, from one `token_count` record.
 *
 * The last one in the file wins, which is what makes this survive a restart:
 * the figure the board shows after a reload is the same figure the live run
 * last emitted, from the same arithmetic (`contextFill` in the runtime), rather
 * than a second implementation that can drift from it.
 */
function readUsage(p: Record<string, unknown>, into: CodexUsage): void {
  const info = p.info as Record<string, unknown> | null | undefined
  if (info) {
    const last = (info.last_token_usage ?? info) as Record<string, unknown>
    const total = numOf(last.total_tokens)
    const fill = total || numOf(last.input_tokens) + numOf(last.output_tokens)
    if (fill > 0) into.contextTokens = fill
    const window = numOf(info.model_context_window)
    if (window > 0) into.contextWindow = window
  }

  const limits = p.rate_limits as Record<string, unknown> | null | undefined
  if (!limits) return
  const primary = limits.primary as Record<string, unknown> | null | undefined
  if (!primary) return
  const secondary = limits.secondary as Record<string, unknown> | null | undefined
  into.meter = {
    kind: 'plan',
    usedPercent: numOf(primary.used_percent),
    windowMinutes: numOf(primary.window_minutes),
    ...(typeof limits.plan_type === 'string' ? { plan: limits.plan_type } : {}),
    ...(numOf(primary.resets_at) ? { resetsAt: numOf(primary.resets_at) } : {}),
    ...(secondary
      ? {
          secondary: {
            usedPercent: numOf(secondary.used_percent),
            windowMinutes: numOf(secondary.window_minutes),
            ...(numOf(secondary.resets_at) ? { resetsAt: numOf(secondary.resets_at) } : {}),
          },
        }
      : {}),
  }
}

function numOf(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * Is this session's cwd inside the directory we are listing?
 *
 * A PREFIX match, not equality, and that is the direct analogue of
 * `includeWorktrees: true` on the Claude side. Every agent works in
 * `<repo>/.agentskanban/worktrees/<name>`, which is a different directory from
 * the workspace root — so an equality test would drop every agent session from
 * the board the moment it started, which is a bug this project has already had
 * once, in the other store.
 *
 * The separator check is what stops `/repo` matching `/repo-backup`.
 */
function samePath(cwd: string, dir: string): boolean {
  const norm = (s: string): string => s.replace(/[/\\]+$/, '')
  const a = norm(cwd)
  const b = norm(dir)
  return a === b || a.startsWith(`${b}/`) || a.startsWith(`${b}\\`)
}

/** Test hook: drop the caches so a test can write files and read them back. */
export function _resetCodexCaches(): void {
  parsed.clear()
  listCache = undefined
  // The walk cache too, or a test that seeds a fresh CODEX_HOME reads the
  // previous one's paths for a second — which is a test asserting on somebody
  // else's fixture.
  walkCache = undefined
}
