/* The repaint rate limiter.
 *
 * This exists because `refreshAll()` was called once per streamed token and did
 * ~40ms of work each time, twice over. What it guards is not "the UI feels
 * smoother" but "the extension host stops competing with the agent for the
 * event loop it is being streamed on", so the properties tested here are the
 * three that make that true: the first call is never delayed, a burst collapses
 * to one trailing run, and runs never overlap.
 */
import { coalesce } from '../coalesce.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

/** A hand-cranked clock and timer queue: no real time passes in this file. */
function clock() {
  let t = 0
  const queue: { at: number; fn: () => void; h: number }[] = []
  let h = 0
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => { const id = ++h; queue.push({ at: t + ms, fn, h: id }); return id },
    clearTimeout: (id: unknown) => {
      const i = queue.findIndex((q) => q.h === id)
      if (i >= 0) queue.splice(i, 1)
    },
    /** Advance time, firing anything due. */
    async advance(ms: number): Promise<void> {
      t += ms
      for (const due of queue.filter((q) => q.at <= t)) {
        queue.splice(queue.indexOf(due), 1)
        due.fn()
      }
      await Promise.resolve()
      await Promise.resolve()
    },
    pending: () => queue.length,
  }
}

const settle = () => new Promise<void>((r) => setImmediate(r))

// --- a burst collapses --------------------------------------------------------
{
  const c = clock()
  let runs = 0
  const co = coalesce(() => { runs++ }, 100, c)

  co.schedule()
  await settle()
  ok(runs === 1, 'the first call in a quiet period runs immediately, not after the interval')

  // 2,000 tokens arriving inside one interval, which is a perfectly ordinary
  // second of streaming.
  for (let i = 0; i < 2000; i++) co.schedule()
  await settle()
  ok(runs === 1, `a burst inside the interval does not run again yet (${runs})`)
  ok(c.pending() === 1, 'exactly one trailing run is scheduled, however long the burst')

  await c.advance(100)
  await settle()
  ok(runs === 2, `2,000 calls produced 2 runs, not 2,000 (${runs})`)

  // And the trailing run really is the LAST word: nothing further is queued.
  ok(c.pending() === 0, 'nothing is left scheduled once the burst has drained')
}

// --- runs never overlap -------------------------------------------------------
{
  const c = clock()
  let started = 0
  let finished = 0
  let release: (() => void) | undefined
  const co = coalesce(() => {
    started++
    return new Promise<void>((r) => { release = () => { finished++; r() } })
  }, 100, c)

  co.schedule()
  await settle()
  ok(started === 1 && finished === 0, 'the run is in flight')

  // The interval passes while the run is still going — the case that turned a
  // rate limiter into a queue of overlapping reads.
  await c.advance(500)
  for (let i = 0; i < 50; i++) co.schedule()
  await settle()
  ok(started === 1, `nothing starts on top of a run in flight (${started} started)`)

  release?.()
  await settle()
  ok(finished === 1, 'the first run finished')
  ok(started === 2, 'and the work that arrived during it gets exactly one run afterwards')
}

// --- a failing run does not wedge the loop ------------------------------------
{
  const c = clock()
  let runs = 0
  const errors: unknown[] = []
  const co = coalesce(() => { runs++; throw new Error('boom') }, 100, { ...c, onError: (e) => errors.push(e) })
  co.schedule()
  await settle()
  await c.advance(100)
  co.schedule()
  await settle()
  ok(runs === 2, `a throwing run is reported and the next one still happens (${runs})`)
  ok(errors.length === 2, 'and every failure is surfaced, never swallowed')
}

// --- flush ---------------------------------------------------------------------
{
  const c = clock()
  let runs = 0
  const co = coalesce(() => { runs++ }, 100, c)
  co.schedule()
  await settle()
  co.schedule()
  await co.flush()
  ok(runs === 2, `flush runs the pending repaint immediately (${runs})`)
  ok(c.pending() === 0, 'and cancels the timer it replaced')

  co.schedule()
  co.dispose()
  await c.advance(1000)
  await settle()
  ok(runs === 2, 'dispose cancels a scheduled run rather than leaving a timer behind')
}

// --- the interval adapts to what a repaint COSTS ----------------------------
//
// A fixed 100ms is a budget, not a measurement. A repaint is O(transcript), and
// a reasoning model's session — measured at 145 entries and 121KB of thinking —
// takes several times longer to build than one with six. Ten a second then
// means the host never finishes one before the next arrives, which is what "it
// lags and sometimes crashes" is.
//
// Asserted on the DELAY the limiter asks for, rather than by counting runs
// through async plumbing: the delay is the decision, and reading it directly is
// what makes this a test of the rule instead of a test of a timer mock.
{
  const bench = (costMs: number) => {
    let t = 0
    const asked: number[] = []
    const c = coalesce(async () => { t += costMs }, 100, {
      now: () => t,
      setTimeout: (_fn: () => void, ms: number) => { asked.push(ms); return asked.length },
      clearTimeout: () => {},
      dutyCycle: 4,
      maxIntervalMs: 500,
    })
    return { c, asked, advance: (ms: number) => { t += ms } }
  }

  // A cheap repaint stays at the floor. A small session must be exactly as live
  // as it was before any of this existed.
  {
    const b = bench(1)
    await b.c.flush()
    b.c.schedule()
    ok(b.asked.length === 1 && b.asked[0]! >= 95 && b.asked[0]! <= 100,
       `a 1ms repaint waits the floor interval (${b.asked[0]}ms)`)
  }

  // An expensive one backs off, so painting never occupies more than its share
  // of the clock it is trying to describe.
  {
    const b = bench(50)
    await b.c.flush()
    b.c.schedule()
    ok(b.asked[0]! > 100,
       `a 50ms repaint waits longer than the floor (${b.asked[0]}ms)`)
    ok(b.asked[0]! >= 140 && b.asked[0]! <= 200,
       `about four times what it cost, minus what has already elapsed (${b.asked[0]}ms)`)
  }

  // And the backoff is BOUNDED. A board that updates every four seconds reads
  // as broken, which is worse than being slow.
  {
    const b = bench(5_000)
    await b.c.flush()
    b.c.schedule()
    ok(b.asked.length === 0 || b.asked[0]! <= 500,
       `however slow a repaint is, the wait is capped (${b.asked[0] ?? 0}ms)`)
  }

  // One slow frame — a garbage collection, a cold file read — must not pin the
  // board at its slowest rate for the rest of the session.
  {
    let t = 0
    let cost = 200
    const asked: number[] = []
    const c = coalesce(async () => { t += cost }, 100, {
      now: () => t,
      setTimeout: (_fn: () => void, ms: number) => { asked.push(ms); return asked.length },
      clearTimeout: () => {},
      dutyCycle: 4,
      maxIntervalMs: 500,
    })
    await c.flush()
    cost = 1
    for (let i = 0; i < 8; i++) await c.flush()
    c.schedule()
    ok(asked[asked.length - 1]! <= 100,
       `it comes back down once repaints are cheap again (${asked[asked.length - 1]}ms)`)
  }
}

console.log(fails === 0 ? 'PASS — repaints coalesce, never overlap, and never go missing' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
