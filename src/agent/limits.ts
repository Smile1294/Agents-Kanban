/**
 * An ACCOUNT's usage limit, tracked by the host — whichever company's agent is
 * spending it.
 *
 * Reported as "keep track of the session limit of the account and set timers
 * for when to wake up or continue — VS Code based rather than the agent, so it
 * works no matter which company the model is from". The agent is the wrong
 * place for this twice over: a process that has hit its limit cannot run a
 * turn to decide anything, and a prompt telling it to watch its own budget is
 * a request, not a mechanism. The host sees every frame of every runtime, so
 * it keeps one reading per ACCOUNT — `<runtime>|<provider profile>`, the same
 * pair the composer's agent picker is keyed by, because that pair is what a
 * login and a meter belong to.
 *
 * Three signals, from most to least specific, all normalised to one shape:
 *
 *  1. Claude Code's `rate_limit_event` — status, the window's reset time and,
 *     undeclared in `sdk.d.ts` but present on a real 2.1 CLI, `unifiedWindows`
 *     with the utilisation of every window (probed: five_hour 0.33, seven_day
 *     0.44). `resetsAt` there is Unix SECONDS.
 *  2. Codex's plan meter — `usedPercent` of a rolling window, `resetsAt` in
 *     seconds. The same numbers the card's meter already shows.
 *  3. The ERROR TEXT of a failed turn, for everything else: a gateway, an
 *     OpenAI-compatible endpoint, Gemini, a runtime added next year. Every
 *     vendor phrases it differently ("usage limit reached|1790439600",
 *     "resets 3pm (Europe/Prague)", "try again in 1 hour 23 minutes",
 *     "Please retry in 32.5s", "429 Too Many Requests"), so this reads the
 *     three shapes a reset time comes in — an epoch, a clock time, a
 *     duration — and when there is none it says the time is an ESTIMATE and
 *     backs off, rather than inventing a precise-looking one.
 *
 * Plain Node, no clock of its own: every function takes `now`.
 */

export type LimitStatus = 'ok' | 'warning' | 'limited'

/** One rolling window, as the vendor reports it. */
export interface LimitWindow {
  /** `five_hour`, `seven_day`, `5h`… — whatever the vendor calls it. */
  name: string
  /** 0..1, when reported. Absent is "not reported", never zero. */
  used?: number
  /** Epoch MILLISECONDS. */
  resetsAt?: number
}

export interface LimitReading {
  status: LimitStatus
  /** When a `limited` account is expected to accept requests again, epoch ms. */
  resetsAt?: number
  /** True when `resetsAt` is our back-off guess, not a time the vendor stated.
   *  The board says "about", because a guess drawn as a fact is a signal that
   *  cannot say bad. */
  estimated?: boolean
  windows: LimitWindow[]
  /** Which signal produced this. */
  source: 'claude' | 'plan' | 'error' | 'retry' | 'restored'
  /** The vendor's own words, when there are any. Shown verbatim. */
  detail?: string
  at: number
}

/** The key a login and a meter belong to. `provider` is `''` for a runtime
 *  that signs in as itself. */
export function accountKey(runtime: string, provider?: string): string {
  return `${runtime}|${provider ?? ''}`
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
/** Seconds or milliseconds, to milliseconds. A value below 1e12 cannot be ms
 *  (that is 2001), so it is seconds — and every vendor here sends seconds. */
const toMs = (v: number): number => (v < 1e12 ? v * 1000 : v)

// ---------------------------------------------------------------------------
// 1. Claude Code
// ---------------------------------------------------------------------------

/** A `rate_limit_event`'s `rate_limit_info`, read defensively. */
export function parseClaudeRateLimit(raw: unknown, now: number): LimitReading | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const info = raw as Record<string, unknown>
  const status = info.status
  if (status !== 'allowed' && status !== 'allowed_warning' && status !== 'rejected') return undefined
  const windows: LimitWindow[] = []
  const unified = info.unifiedWindows
  if (unified && typeof unified === 'object') {
    for (const [name, w] of Object.entries(unified as Record<string, unknown>)) {
      if (!w || typeof w !== 'object') continue
      const u = num((w as Record<string, unknown>).utilization)
      const r = num((w as Record<string, unknown>).resetsAt)
      windows.push({ name, ...(u !== undefined ? { used: u } : {}), ...(r !== undefined ? { resetsAt: toMs(r) } : {}) })
    }
  }
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined
  const resets = num(info.resetsAt)
  if (type && !windows.some((w) => w.name === type)) {
    const u = num(info.utilization)
    windows.push({ name: type, ...(u !== undefined ? { used: u } : {}), ...(resets !== undefined ? { resetsAt: toMs(resets) } : {}) })
  }
  // Paying for overage IS being allowed: the requests go through.
  const limited = status === 'rejected' && info.isUsingOverage !== true
  const at = resets !== undefined ? toMs(resets) : undefined
  return {
    status: limited ? 'limited' : status === 'allowed_warning' ? 'warning' : 'ok',
    ...(limited && at && at > now ? { resetsAt: at } : {}),
    windows, source: 'claude', at: now,
    ...(limited ? { detail: `${type ? windowName(type) : 'usage'} limit reached` } : {}),
  }
}

// ---------------------------------------------------------------------------
// 2. A plan meter (Codex)
// ---------------------------------------------------------------------------

interface PlanLike {
  kind?: unknown
  usedPercent?: unknown
  windowMinutes?: unknown
  resetsAt?: unknown
  secondary?: { usedPercent?: unknown; windowMinutes?: unknown; resetsAt?: unknown }
}

/** The warning line for a plan window: past it, the board says so. */
export const WARN_FRACTION = 0.8

export function limitFromPlanMeter(raw: unknown, now: number): LimitReading | undefined {
  const m = raw as PlanLike | undefined
  if (!m || m.kind !== 'plan') return undefined
  const windows: LimitWindow[] = []
  for (const w of [m, m.secondary]) {
    if (!w) continue
    const pct = num(w.usedPercent)
    const mins = num(w.windowMinutes)
    const r = num(w.resetsAt)
    if (pct === undefined) continue
    windows.push({
      name: mins ? minutesName(mins) : 'window',
      used: pct / 100,
      ...(r !== undefined ? { resetsAt: toMs(r) } : {}),
    })
  }
  if (!windows.length) return undefined
  const full = windows.filter((w) => (w.used ?? 0) >= 1)
  // The LATEST reset among full windows: the account is limited until every
  // window that is full has emptied.
  const until = full.map((w) => w.resetsAt ?? 0).reduce((a, b) => Math.max(a, b), 0)
  const status: LimitStatus = full.length ? 'limited' : windows.some((w) => (w.used ?? 0) >= WARN_FRACTION) ? 'warning' : 'ok'
  return {
    status, windows, source: 'plan', at: now,
    ...(status === 'limited' && until > now ? { resetsAt: until } : {}),
    ...(status === 'limited' ? { detail: `${full.map((w) => w.name).join(' and ')} window full` } : {}),
  }
}

// ---------------------------------------------------------------------------
// 3. Error text, from any vendor
// ---------------------------------------------------------------------------

/** Phrases that mean the ACCOUNT is out of allowance. Deliberately excludes a
 *  model's own context limit ("prompt is too long", "context window") and a
 *  service being overloaded (529) — neither is fixed by waiting for a reset. */
const LIMIT_TEXT = /usage limit|rate[ _-]?limit|limit reached|hit your (usage )?limit|out of (credits|usage|quota)|quota|too many requests|\b429\b|resource[_ ]exhausted|insufficient_quota|credit balance is too low/i
const NOT_ACCOUNT = /context (window|length)|prompt is too long|maximum context|max_tokens|token limit exceeded|overloaded/i

/**
 * A limit, read out of a failed turn's message. Undefined when the text is
 * not about a limit at all — most errors are not, and treating one as a limit
 * would park a card that needs fixing, not waiting.
 */
export function limitFromErrorText(text: string, now: number): LimitReading | undefined {
  if (!text || !LIMIT_TEXT.test(text) || NOT_ACCOUNT.test(text)) return undefined
  const resetsAt = resetTimeIn(text, now)
  return {
    status: 'limited', windows: [], source: 'error', at: now,
    ...(resetsAt && resetsAt > now ? { resetsAt } : {}),
    detail: text.replace(/\|\d{10,13}\b/, '').trim().slice(0, 240),
  }
}

/** The reset time a message states, in any of the three shapes, epoch ms. */
export function resetTimeIn(text: string, now: number): number | undefined {
  // An epoch: Claude Code's old "Claude AI usage limit reached|1790439600",
  // or a JSON `"resets_at": 1790439600` pasted into an error.
  const epoch = /(?:\||resets?_?at["']?\s*[:=]\s*)(\d{10,13})\b/i.exec(text)
  if (epoch) return toMs(Number(epoch[1]))
  // An ISO timestamp.
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/.exec(text)
  if (iso && /reset|again|until|after|retry|available/i.test(text)) {
    const t = Date.parse(iso[1]!)
    if (Number.isFinite(t)) return t
  }
  // A duration: "try again in 1 hour 23 minutes", "retry in 32.5s",
  // "resets in 2h 5m", "Retry-After: 30".
  const lead = /(?:try again|retry|resets?|available again|wait|please wait)\s*(?:in|after)\s*:?\s*((?:[^.;\n]|\.(?=\d)){1,60})|retry-after\s*:?\s*(\d+)/i.exec(text)
  if (lead) {
    if (lead[2]) return now + Number(lead[2]) * 1000
    const ms = durationMs(lead[1]!)
    if (ms) return now + ms
  }
  // A clock time: "resets 3pm (Europe/Prague)", "try again at 3:05 PM",
  // "reset at 15:05".
  const clock = /(?:resets?|try again|available again|retry)\s*(?:at|after|on)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\)|([A-Z][A-Za-z]+\/[A-Za-z_]+))?/i.exec(text)
  if (clock && (clock[2] || clock[3])) {
    let h = Number(clock[1])
    const m = clock[2] ? Number(clock[2]) : 0
    const ap = clock[3]?.toLowerCase()
    if (ap === 'pm' && h < 12) h += 12
    if (ap === 'am' && h === 12) h = 0
    if (h < 24 && m < 60) return nextClockTime(h, m, now, clock[4] ?? clock[5])
  }
  return undefined
}

const UNIT_MS: Array<[RegExp, number]> = [
  [/^(d|days?)$/i, 86_400_000],
  [/^(h|hrs?|hours?)$/i, 3_600_000],
  [/^(m|mins?|minutes?)$/i, 60_000],
  [/^(s|secs?|seconds?)$/i, 1000],
  [/^ms$/i, 1],
]

/** "1 hour 23 minutes", "2h5m", "32.5s" → ms. Undefined when nothing parses. */
export function durationMs(text: string): number | undefined {
  let total = 0
  let any = false
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const unit = UNIT_MS.find(([re]) => re.test(m[2]!))
    if (!unit) break
    total += Number(m[1]) * unit[1]
    any = true
  }
  return any && total > 0 ? Math.round(total) : undefined
}

/** The next time the wall clock in `tz` (or this machine's zone) reads h:m. */
export function nextClockTime(h: number, m: number, now: number, tz?: string): number {
  const off = offsetMs(now, tz)
  const wall = new Date(now + off)
  let t = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate(), h, m) - off
  if (t <= now) t += 86_400_000
  return t
}

/** How far `tz`'s wall clock is ahead of UTC at `at`. An unknown zone is this
 *  machine's, because the vendor wrote the time for the person reading it. */
function offsetMs(at: number, tz?: string): number {
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz.trim(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(at))
      const g = (t: string) => Number(parts.find((p) => p.type === t)?.value)
      const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'))
      return asUtc - Math.floor(at / 1000) * 1000
    } catch { /* not a zone Intl knows: fall through */ }
  }
  return -new Date(at).getTimezoneOffset() * 60_000
}

// ---------------------------------------------------------------------------
// The API retry the CLI is doing itself
// ---------------------------------------------------------------------------

/** Claude Code's `api_retry` on a 429: the CLI is waiting and will try again,
 *  so it is a WARNING, never a park — the turn may yet succeed. */
export function limitFromRetry(raw: unknown, now: number): LimitReading | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (r.error_status !== 429) return undefined
  const delay = num(r.retry_delay_ms)
  return {
    status: 'warning', windows: [], source: 'retry', at: now,
    detail: `rate limited — the agent is retrying${delay ? ` in ${Math.round(delay / 1000)}s` : ''} (attempt ${num(r.attempt) ?? '?'} of ${num(r.max_retries) ?? '?'})`,
  }
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

/** The first guess when a vendor names no reset time, doubled per repeat. */
export const BACKOFF_MS = 15 * 60_000
export const BACKOFF_CAP_MS = 2 * 3_600_000

export class LimitTracker {
  private readonly readings = new Map<string, LimitReading>()
  /** Consecutive limited readings with no stated reset — the back-off step. */
  private readonly strikes = new Map<string, number>()

  /**
   * Take a reading. Returns what is now in force for the account — which is
   * not always the reading: a limited account with no stated reset gets a
   * back-off estimate, and windows a new reading does not mention are kept
   * (Claude reports every window, a 429 reports none).
   */
  record(account: string, r: LimitReading): LimitReading {
    const prior = this.readings.get(account)
    let next: LimitReading = { ...r, windows: r.windows.length ? r.windows : prior?.windows ?? [] }
    if (r.status === 'limited' && !r.resetsAt) {
      // A limit we already know the end of is not made shorter by a vaguer
      // report of the same thing.
      if (prior?.status === 'limited' && prior.resetsAt && prior.resetsAt > r.at && !prior.estimated) {
        next = { ...next, resetsAt: prior.resetsAt }
      } else {
        const n = (this.strikes.get(account) ?? 0) + 1
        this.strikes.set(account, n)
        next = { ...next, resetsAt: r.at + Math.min(BACKOFF_MS * 2 ** (n - 1), BACKOFF_CAP_MS), estimated: true }
      }
    } else if (r.status !== 'limited') {
      // A request went through: the account is not limited, whatever we guessed.
      this.strikes.delete(account)
    }
    this.readings.set(account, next)
    return next
  }

  get(account: string): LimitReading | undefined {
    return this.readings.get(account)
  }

  /** When the account can be used again, or undefined when it can be now. */
  limitedUntil(account: string, now: number): number | undefined {
    const r = this.readings.get(account)
    return r?.status === 'limited' && r.resetsAt && r.resetsAt > now ? r.resetsAt : undefined
  }

  /** The reset time came: the account is presumed usable. Kept as a reading
   *  (its windows are still the last thing we know) but no longer limited. */
  lift(account: string, now: number): void {
    const r = this.readings.get(account)
    if (r?.status === 'limited') this.readings.set(account, { ...r, status: 'ok', at: now, detail: 'the limit was due to reset' })
  }

  all(): Array<[string, LimitReading]> {
    return [...this.readings.entries()]
  }
}

/** `five_hour` → `5-hour`, for sentences. */
export function windowName(name: string): string {
  const known: Record<string, string> = {
    five_hour: '5-hour', seven_day: '7-day', seven_day_opus: '7-day Opus', seven_day_sonnet: '7-day Sonnet',
    seven_day_overage_included: '7-day', overage: 'overage',
  }
  return known[name] ?? name.replace(/_/g, ' ')
}

function minutesName(mins: number): string {
  if (mins % 1440 === 0) return `${mins / 1440}d`
  if (mins % 60 === 0) return `${mins / 60}h`
  return `${mins}m`
}

/** How a card waiting on its account is recorded in the sidecar. */
export interface ParkedRecord {
  /** Epoch ms the account is expected back. */
  until: number
  /** The vendor's words, or ours. */
  reason: string
  account: string
  /** How many times in a row this session was resumed into the same limit. */
  attempts: number
  /** Whether the board resumes it by itself when `until` passes. */
  auto: boolean
  estimated?: boolean
}

/** Resumes into a limit before the board stops trying by itself. A reset time
 *  that keeps being wrong must not become a loop that bills a turn an hour. */
export const MAX_AUTO_RESUMES = 3

export function parseParked(raw: unknown): ParkedRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const p = raw as Record<string, unknown>
  const until = num(p.until)
  if (!until || typeof p.account !== 'string') return undefined
  return {
    until, account: p.account,
    reason: typeof p.reason === 'string' ? p.reason : 'usage limit reached',
    attempts: Math.max(0, Math.floor(num(p.attempts) ?? 0)),
    auto: p.auto !== false,
    ...(p.estimated === true ? { estimated: true } : {}),
  }
}

/** What an automatic resume says. It allows "nothing left to do", because a
 *  prompt that only permits carrying on invents work. */
export const RESUME_PROMPT =
  'Your previous turn was cut off because this account reached its usage limit, and the limit has now reset. ' +
  'Carry on from where you stopped. If the work was already finished, say so and move the card on as usual.'
