/** Rate-limit a repaint that is driven by a firehose.
 *
 * The board repaints from one function, `refreshAll()`, and it is called on
 * every event an agent produces — including every streamed token, because that
 * is what makes the transcript type out live. A repaint is not cheap: it reads
 * Claude Code's session index, rebuilds every card, and serialises the whole
 * transcript to the webview. Measured on a 20-session store that is ~40ms, and
 * it grows linearly with the number of sessions (60 sessions: ~104ms).
 *
 * That was being run once per token, twice over — the side bar and the panel
 * each asked for their own copy. At any realistic streaming rate the extension
 * host cannot keep up, and the work queues without bound. The agent slows down
 * with it: the CLI is a child process whose stdout is drained on this same
 * event loop, and `canUseTool` answers travel back over it, so a saturated host
 * is a slower agent. The board's own liveness readout gets it wrong too, since
 * `lastEventAt` is stamped when a frame is HANDLED, not when it arrived.
 *
 * So repaints are coalesced. Three properties, and all three are load-bearing:
 *
 *  1. The FIRST call in a quiet period runs immediately. A repaint must never
 *     be delayed behind a timer when nothing else is happening — that is the
 *     difference between a live UI and a laggy one.
 *  2. Calls during a run, or inside the interval, collapse into exactly one
 *     trailing run. The last state always paints; nothing is dropped.
 *  3. Runs never overlap. `run` is async, and a rate limiter that ignores that
 *     just moves the pile-up rather than removing it.
 *  4. The interval ADAPTS to what a repaint actually costs. A fixed 100ms is a
 *     budget, not a measurement: it assumes a repaint is cheap, and a repaint
 *     is O(transcript). A reasoning model's session — measured at 145 entries
 *     and 121KB of thinking — takes several times longer to build than one with
 *     six, so ten a second means the host and the webview never finish one
 *     before the next arrives. That is what "it lags and sometimes crashes"
 *     looks like. The floor stays `intervalMs`, so a small session is exactly
 *     as live as before.
 *
 * Pure and timer-injectable, so the behaviour above can be tested without
 * waiting for real time to pass and without VS Code.
 */
export interface Coalescer {
  /** Ask for a run. Cheap, and safe to call thousands of times a second. */
  schedule(): void
  /** Run now, awaiting it. For teardown and for tests. */
  flush(): Promise<void>
  /** Cancel a pending trailing run. */
  dispose(): void
  /** How many times `run` has actually been called. Test-only. */
  readonly runs: number
}

export interface CoalesceDeps {
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (h: unknown) => void
  onError?: (e: unknown) => void
  /**
   * How much of the wall clock repaints may occupy, as a divisor: 4 means a
   * repaint that takes 40ms is followed by at least 160ms of quiet, so painting
   * never costs more than a quarter of the time it is trying to describe.
   *
   * A share rather than a fixed ceiling because the right answer scales with
   * the session: six entries stay at the floor, and a 145-entry one backs off
   * on its own rather than needing a number someone guessed.
   */
  dutyCycle?: number
  /** Never wait longer than this, however slow a repaint is. A board that
   *  updates twice a second still reads as live; one that updates every four
   *  seconds reads as broken, which is worse than being slow. */
  maxIntervalMs?: number
}

export function coalesce(
  run: () => Promise<void> | void,
  intervalMs: number,
  deps: CoalesceDeps = {},
): Coalescer {
  const now = deps.now ?? Date.now
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms))
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  const dutyCycle = deps.dutyCycle ?? 4
  const maxIntervalMs = deps.maxIntervalMs ?? 500

  let timer: unknown
  let inflight: Promise<void> | undefined
  let pending = false
  let lastStart = -Infinity
  let runs = 0
  /** What the last repaint cost, smoothed. Smoothed rather than taken raw so
   *  one slow frame — a garbage collection, a cold file read — does not pin the
   *  board at its slowest rate for the rest of the session. */
  let cost = 0

  /** How long to leave between repaints, given what they cost. */
  const gap = (): number =>
    Math.min(maxIntervalMs, Math.max(intervalMs, Math.round(cost * dutyCycle)))

  const start = (): Promise<void> => {
    lastStart = now()
    runs++
    const began = now()
    const p = Promise.resolve()
      .then(run)
      .catch((e) => deps.onError?.(e))
      .then(() => {
        // Measured AFTER the run, including everything it awaited: the point is
        // how long the board is unresponsive, not how long our own code ran.
        const took = Math.max(0, now() - began)
        cost = cost === 0 ? took : Math.round(cost * 0.6 + took * 0.4)
        inflight = undefined
        // Anything that asked while this was in flight gets exactly one run,
        // scheduled from here rather than stacked behind it.
        if (pending) { pending = false; api.schedule() }
      })
    inflight = p
    return p
  }

  const api: Coalescer = {
    schedule(): void {
      if (inflight) { pending = true; return }
      if (timer !== undefined) return
      const wait = gap() - (now() - lastStart)
      if (wait <= 0) { void start(); return }
      timer = setT(() => { timer = undefined; void start() }, wait)
    },
    async flush(): Promise<void> {
      if (timer !== undefined) { clearT(timer); timer = undefined }
      // Never start a second run on top of a live one — wait for it, then run
      // once more so what paints is the state as of the flush, not as of
      // whenever the in-flight run happened to read it.
      if (inflight) await inflight
      pending = false
      await start()
    },
    dispose(): void {
      if (timer !== undefined) { clearT(timer); timer = undefined }
      pending = false
    },
    get runs(): number { return runs },
  }
  return api
}
