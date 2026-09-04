import { withRepoLock, _pendingRepos } from '../lock.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// mutual exclusion: overlapping critical sections would interleave
let active = 0, maxActive = 0
const order: number[] = []
await Promise.all([1, 2, 3, 4, 5].map(i =>
  withRepoLock('/repo/a', async () => {
    active++; maxActive = Math.max(maxActive, active)
    await sleep(10 - i)   // later callers finish faster if run concurrently
    order.push(i)
    active--
  })
))
ok(maxActive === 1, `only one critical section at a time (peak ${maxActive})`)
ok(order.join(',') === '1,2,3,4,5', `FIFO order preserved (got ${order.join(',')})`)

// different repos do not block each other
let bStarted = false
const slowA = withRepoLock('/repo/x', async () => { await sleep(50) })
await withRepoLock('/repo/y', async () => { bStarted = true })
ok(bStarted, 'a different repo runs without waiting')
await slowA

// a rejection does not poison the queue
const results: string[] = []
const failing = withRepoLock('/repo/c', async () => { throw new Error('boom') })
const following = withRepoLock('/repo/c', async () => { results.push('ran'); return 'ok' })
await failing.then(() => results.push('should-not-resolve'), () => results.push('rejected'))
ok(await following === 'ok', 'the next caller still runs after a rejection')
ok(results.includes('rejected') && results.includes('ran'), 'rejection surfaced to its own caller only')

// return values pass through
ok(await withRepoLock('/repo/d', async () => 42) === 42, 'return value passes through')

// the map does not leak
await sleep(20)
ok(_pendingRepos() === 0, `queues cleaned up (${_pendingRepos()} left)`)

console.log(fails === 0 ? 'PASS — repo lock serialises correctly and cleans up' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
