/**
 * Scheduled runs — the board's time triggers.
 *
 * A schedule says "at HH:MM on these weekdays, start a session with this
 * prompt". It fires only while the extension is running, so the honest model is
 * catch-up, not cron: if the due moment passes with VS Code closed (or with no
 * git repo open), the run starts at the next check — once, not once per missed
 * day, because `nextFireAt` is anchored to `lastFiredAt`. A schedule paused
 * for a week and resumed catches up on the next check too; that is the same
 * rule, and the settings page says so.
 *
 * Purely host-side bookkeeping — nothing here touches a card, a session or a
 * worktree, and nothing is written to the user's repository. The firing itself
 * lives in extension.ts (`fireScheduleNow`), which owns the CLI; this module is
 * the parts that must be testable hermetically.
 */
export interface ScheduleRun {
  /** When the run was attempted. */
  at: number
  /** Whether the host managed to START the session. A session that starts and
   *  then fails on the CLI is a failed session on the board, not a failed
   *  schedule — that is the card's story to tell. */
  ok: boolean
  /** Why it could not start, when it could not. */
  note?: string
}

export interface Schedule {
  id: string
  /** Becomes the fired session's card title. */
  title: string
  /** The instruction the fired session starts with. */
  prompt: string
  /** Local wall-clock time. getDay() numbering: 0 = Sunday … 6 = Saturday. */
  hour: number
  minute: number
  days: number[]
  enabled: boolean
  createdAt: number
  /**
   * The card title of the agent session that created this schedule, when an
   * agent did. Absent on user-created schedules — the settings page marks only
   * the ones an agent made, so the user can tell whose word they are taking
   * when a run they did not write fires.
   */
  createdBy?: string
  /** When the last fire was ATTEMPTED. The anchor for `nextFireAt`, and the
   *  thing that makes catch-up fire once rather than once per missed day. Set
   *  before the attempt, so a crash between persist and start costs one day's
   *  run, not a double fire. */
  lastFiredAt?: number
  lastRun?: ScheduleRun
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/**
 * The next fire instant strictly after `after`, or undefined when the schedule
 * has no days to fire on.
 *
 * Dates are built from the LOCAL clock (setHours / setDate), so a DST
 * transition shifts a fire by an hour in one direction or the other rather than
 * dropping or doubling it — the time the user set is wall-clock time, and the
 * day boundary that matters is the local one.
 */
export function nextFireAt(
  s: Pick<Schedule, 'hour' | 'minute' | 'days'>,
  after: number,
): number | undefined {
  const days = s.days.filter((d) => d >= 0 && d <= 6 && Number.isInteger(d))
  if (!days.length) return undefined
  // A week is enough: every day-of-week recurs within seven days.
  for (let off = 0; off <= 7; off++) {
    const t = new Date(after)
    t.setDate(t.getDate() + off)
    t.setHours(s.hour, s.minute, 0, 0)
    if (t.getTime() <= after) continue
    if (days.includes(t.getDay())) return t.getTime()
  }
  return undefined
}

/**
 * A schedule list read back from storage — parsed, never cast.
 *
 * Storage outlives the version that wrote it, so this validates every field a
 * fire depends on: a schedule whose time or instruction is junk must not be
 * offered in a list that looks editable, and must not fire. One malformed
 * entry drops that entry, not the rest — unlike a cache, where a shape change
 * invalidates everything at once, these are independent user records.
 */
export function parseSchedules(raw: unknown): Schedule[] {
  if (!Array.isArray(raw)) return []
  const out: Schedule[] = []
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue
    const o = v as Record<string, unknown>
    const id = typeof o.id === 'string' && o.id ? o.id.slice(0, 200) : ''
    const title = typeof o.title === 'string' ? o.title.trim() : ''
    const prompt = typeof o.prompt === 'string' ? o.prompt : ''
    const hour = typeof o.hour === 'number' && Number.isInteger(o.hour) && o.hour >= 0 && o.hour <= 23
      ? o.hour : -1
    const minute = typeof o.minute === 'number' && Number.isInteger(o.minute) && o.minute >= 0 && o.minute <= 59
      ? o.minute : -1
    const createdAt = typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) && o.createdAt > 0
      ? o.createdAt : 0
    const days = Array.isArray(o.days)
      ? [...new Set(o.days.filter((d): d is number =>
          typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))]
      : []
    if (!id || !title || !prompt.trim() || hour === -1 || minute === -1) continue
    const s: Schedule = {
      id, title, prompt, hour, minute,
      days,
      enabled: o.enabled !== false,
      createdAt,
    }
    if (typeof o.createdBy === 'string' && o.createdBy.trim()) s.createdBy = o.createdBy.trim().slice(0, 200)
    if (typeof o.lastFiredAt === 'number' && Number.isFinite(o.lastFiredAt)) s.lastFiredAt = o.lastFiredAt
    const lr = o.lastRun as Record<string, unknown> | undefined
    if (lr && typeof lr === 'object' && typeof lr.at === 'number' && Number.isFinite(lr.at)) {
      s.lastRun = { at: lr.at, ok: lr.ok !== false, ...(typeof lr.note === 'string' ? { note: lr.note } : {}) }
    }
    out.push(s)
  }
  return out
}

/** "Daily at 09:00" / "Mon–Fri at 09:00" / "Sun at 09:00" — the one-line shape
 *  of a schedule. Pure so the page and the tests share it. */
export function describeWhen(s: Pick<Schedule, 'hour' | 'minute' | 'days'>): string {
  const hh = String(s.hour).padStart(2, '0')
  const mm = String(s.minute).padStart(2, '0')
  const days = s.days.filter((d) => d >= 0 && d <= 6)
  const time = `${hh}:${mm}`
  if (days.length === 7) return `Daily at ${time}`
  if (days.length === 0) return `No days — never fires`
  // Consecutive runs collapse to ranges: [1,2,3,5] -> "Mon–Wed, Fri".
  const sorted = [...days].sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0]!
  let prev = start
  for (const d of sorted.slice(1)) {
    if (d === prev + 1) { prev = d; continue }
    parts.push(start === prev ? DAY_NAMES[start]! : `${DAY_NAMES[start]}–${DAY_NAMES[prev]!}`)
    start = d
    prev = d
  }
  parts.push(start === prev ? DAY_NAMES[start]! : `${DAY_NAMES[start]}–${DAY_NAMES[prev]!}`)
  return `${parts.join(', ')} at ${time}`
}

/**
 * The fields a schedule creator names; the host assigns the id and stamps
 * `createdAt` (and `createdBy` when the creator is an agent).
 */
export interface ScheduleDraft {
  title: string
  prompt: string
  hour: number
  minute: number
  days: number[]
  enabled: boolean
}

/**
 * A schedule draft read off the board tools — parsed, never cast.
 *
 * The in-process MCP path gets zod validation free, but the socket bridge
 * (Codex) enforces the advertised schema at the transport and this is still the
 * host's last word: a future transport, a drift in the schema, or a runtime
 * that does not enforce its own published JSON Schema all land here, and a
 * schedule that fires sessions with a bill is not the thing to validate with
 * prose. Every refusal names the field and the fix, because the tool result is
 * the one message the agent reads at the moment it acts.
 *
 * Bounds deliberately match `parseSchedules`' own: a draft that would not
 * survive a read-back is refused rather than written and then silently dropped.
 */
export function parseScheduleDraft(raw: unknown): { ok: true; draft: ScheduleDraft } | { ok: false; message: string } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const title = typeof o.title === 'string' ? o.title.trim() : ''
  if (!title) return { ok: false, message: 'A schedule needs a title — it becomes the fired session\'s card title.' }
  if (title.length > 200) return { ok: false, message: 'The title is longer than 200 characters — shorten it.' }
  const prompt = typeof o.prompt === 'string' ? o.prompt : ''
  if (!prompt.trim()) return { ok: false, message: 'A schedule needs an instruction — it is the prompt the fired session starts with.' }
  if (prompt.length > 20_000) return { ok: false, message: 'The instruction is longer than 20,000 characters — shorten it.' }
  const hour = typeof o.hour === 'number' && Number.isInteger(o.hour) && o.hour >= 0 && o.hour <= 23 ? o.hour : -1
  if (hour === -1) return { ok: false, message: '`hour` must be an integer 0–23, local wall-clock time.' }
  const minute = typeof o.minute === 'number' && Number.isInteger(o.minute) && o.minute >= 0 && o.minute <= 59 ? o.minute : -1
  if (minute === -1) return { ok: false, message: '`minute` must be an integer 0–59.' }
  const days = Array.isArray(o.days)
    ? [...new Set(o.days.filter((d): d is number =>
        typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6))]
    : []
  if (!days.length) {
    return { ok: false, message: '`days` must list at least one day (0 = Sunday … 6 = Saturday) — a schedule with no days never fires.' }
  }
  return {
    ok: true,
    draft: { title, prompt, hour, minute, days, enabled: o.enabled !== false },
  }
}
