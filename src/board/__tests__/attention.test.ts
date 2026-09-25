/* The attention list: every card waiting on the user, one list, blocking
   first. What it guards: a question on a card scrolled out of view, a crash
   nobody saw, and a list that disagrees with the cards it came from. */
import { DEFAULT_BOARD } from '../config.ts'
import { attentionFor, attentionSummary } from '../attention.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const review = DEFAULT_BOARD.columns.find((c) => c.category === 'review')!.id
const started = DEFAULT_BOARD.columns.find((c) => c.category === 'started')!.id
const items = attentionFor([
  { key: 'r', title: 'Ready one', phase: review, testPlan: { at: 50 } },
  { key: 's', title: 'Stalled one', phase: started, stalled: 30 },
  { key: 'q2', title: 'Later question', phase: started, agent: { kind: 'needsInput', lastEventAt: 200 } },
  { key: 'q1', title: 'Early question', phase: started, agent: { kind: 'needsInput', lastEventAt: 100 } },
  { key: 'e', title: 'Crashed', phase: started, agent: { kind: 'error', message: 'spawn ENOENT\nstack…' } },
  { key: 'i', title: 'Cut off', phase: started, interrupted: 10 },
  { key: 'w', title: 'Working', phase: started, agent: { kind: 'working' } },
  { key: 'a', title: 'Archived question', phase: started, archived: true, agent: { kind: 'needsInput' } },
  { key: 'rc', title: 'Has unsent comments', phase: review, testPlan: { at: 1 }, reviewComments: 2 },
  { key: 'rw', title: 'In review but running', phase: review, testPlan: { at: 1 }, agent: { kind: 'working' } },
], DEFAULT_BOARD)

ok(items.map((i) => i.key).join(',') === 'q1,q2,e,i,s,r',
   `blocking questions first (oldest first), then failures, cut-offs, stalls, then work ready to test (${items.map((i) => i.key).join(',')})`)
ok(!items.some((i) => i.key === 'w' || i.key === 'a'), 'a working card and an archived one need nothing')
{
  const broken = attentionFor([{ key: 'b', title: 'Broken', phase: review, testPlan: { at: 1, autoCheck: { ok: false, at: 9 } } }], DEFAULT_BOARD)
  ok(broken[0]?.kind === 'failed' && /auto-check/.test(broken[0].why), 'a card that failed the board\'s own check is a failure, not "ready to test"')
}
ok(!items.some((i) => i.key === 'rc'), 'a review card whose comments you are still writing is yours already, not waiting')
ok(!items.some((i) => i.key === 'rw'), 'nor one whose agent is running again')
ok(items.find((i) => i.key === 'e')?.why === 'failed: spawn ENOENT', 'a failure says why, in one line')
ok(attentionSummary(items) === '2 waiting on you · 4 more need you', `the status bar leads with what blocks (${attentionSummary(items)})`)
ok(attentionSummary([]) === undefined, 'nothing waiting says nothing')
ok(attentionSummary(items.filter((i) => i.kind === 'review')) === '1 needs you', 'singular')

if (fails) { console.log(`${fails} failure(s)`); process.exit(1) }
console.log('PASS — what waits on the user is one list, and it agrees with the cards')
