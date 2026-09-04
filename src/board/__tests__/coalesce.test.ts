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

console.log(fails === 0 ? 'PASS — repaints coalesce, never overlap, and never go missing' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
