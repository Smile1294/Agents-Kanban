/**
 * The pure half of scheduled runs: when a schedule fires, and what comes back
 * out of storage. The firing half (extension.ts) is not testable hermetically —
 * it spawns the CLI — so the rules that CAN be tested live here, and the
 * postmortem habit is to put every rule that decides a fire in this file.
 */
import {
  DAY_NAMES,
  describeWhen,
  nextFireAt,
  parseScheduleDraft,
  parseSchedules,
  type Schedule,
} from '../schedules.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

const local = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi, 0, 0).getTime()

// --- nextFireAt -------------------------------------------------------------

// A fixed Wednesday, 2026-09-09 08:00 local, for day-of-week arithmetic.
const WED_08 = local(2026, 9, 9, 8, 0)

{
  // Daily at 09:00, now 08:00 the same day -> today 09:00.
  const r = nextFireAt({ hour: 9, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] }, WED_08)
  ok(r === local(2026, 9, 9, 9, 0), 'later today fires today')
}
{
  // Daily at 07:00, now 08:00 -> tomorrow 07:00.
  const r = nextFireAt({ hour: 7, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] }, WED_08)
  ok(r === local(2026, 9, 10, 7, 0), 'already passed today fires tomorrow')
}
{
  // At exactly the fire instant, the instant itself does not re-fire.
  const exact = local(2026, 9, 9, 9, 0)
  const r = nextFireAt({ hour: 9, minute: 0, days: [0, 1, 2, 3, 4, 5, 6] }, exact)
  ok(r === local(2026, 9, 10, 9, 0), 'the boundary instant itself is in the past')
}
{
  // Weekdays only (Mon–Fri), now Wed 08:00 -> Wed 09:00.
  const r = nextFireAt({ hour: 9, minute: 0, days: [1, 2, 3, 4, 5] }, WED_08)
  ok(r === local(2026, 9, 9, 9, 0), 'weekday schedule fires on this weekday')
}
{
  // Weekdays only, now Friday 10:00 -> Monday 09:00, never the weekend.
  const fri = local(2026, 9, 11, 10, 0)
  const r = nextFireAt({ hour: 9, minute: 0, days: [1, 2, 3, 4, 5] }, fri)
  ok(r === local(2026, 9, 14, 9, 0), 'a Friday miss rolls to Monday, not Saturday')
}
{
  // Sunday only, now Saturday -> Sunday.
  const sat = local(2026, 9, 12, 10, 0)
  const r = nextFireAt({ hour: 9, minute: 0, days: [0] }, sat)
  ok(r === local(2026, 9, 13, 9, 0), 'single-day schedules land on that day')
}
{
  const r = nextFireAt({ hour: 9, minute: 0, days: [] }, WED_08)
  ok(r === undefined, 'a schedule with no days never fires')
}
{
  // Junk in days (out of range, non-integers, duplicates) is tolerated, not fatal.
  const r = nextFireAt({ hour: 9, minute: 0, days: [3, 3, -1, 9, 2.5, 3] }, WED_08)
  ok(r === local(2026, 9, 9, 9, 0), 'duplicate and out-of-range days do not break the scan')
}

// --- describeWhen -----------------------------------------------------------

ok(describeWhen({ hour: 9, minute: 5, days: [0, 1, 2, 3, 4, 5, 6] }) === 'Daily at 09:05',
  'every day reads as Daily')
ok(describeWhen({ hour: 9, minute: 0, days: [1, 2, 3, 4, 5] }) === 'Mon–Fri at 09:00',
  'a run of weekdays collapses to a range')
ok(describeWhen({ hour: 9, minute: 0, days: [1, 2, 3, 5] }) === 'Mon–Wed, Fri at 09:00',
  'a gap splits the range')
ok(describeWhen({ hour: 9, minute: 0, days: [0] }) === 'Sun at 09:00', 'a lone day names itself')
ok(describeWhen({ hour: 9, minute: 0, days: [] }) === 'No days — never fires',
  'no days says so rather than pretending')

// --- parseSchedules (the read-back) -----------------------------------------

{
  const good: Schedule = {
    id: 's1', title: ' Morning patrol ', prompt: 'Check the bug board\nand start fixing.',
    hour: 9, minute: 30, days: [1, 2, 3, 4, 5], enabled: true, createdAt: 1000,
    lastFiredAt: 2000, lastRun: { at: 2000, ok: false, note: 'no provider' },
  }
  const round = parseSchedules(JSON.parse(JSON.stringify([good])))
  ok(round.length === 1, 'a well-formed schedule survives the round trip')
  ok(round[0]!.title === 'Morning patrol', 'title is trimmed on the way back')
  ok(round[0]!.prompt === good.prompt, 'the prompt survives byte for byte')
  ok(round[0]!.hour === 9 && round[0]!.minute === 30 && round[0]!.days.join(',') === '1,2,3,4,5',
    'time and days survive')
  ok(round[0]!.lastRun?.ok === false && round[0]!.lastRun?.note === 'no provider',
    'a failed last run is read back as failed, with its reason')
}
{
  const junk = [
    null, 'nope', {}, { id: '', title: 'x', prompt: 'p', hour: 9, minute: 0 },
    { id: 'a', title: ' ', prompt: 'p', hour: 9, minute: 0 },
    { id: 'b', title: 'x', prompt: '', hour: 9, minute: 0 },
    { id: 'c', title: 'x', prompt: 'p', hour: 25, minute: 0 },
    { id: 'd', title: 'x', prompt: 'p', hour: 9, minute: -1 },
  ]
  ok(parseSchedules(junk).length === 0, 'every malformed entry is dropped, not half-accepted')
}
{
  // An entry missing only the new fields keeps defaults rather than dying.
  const old = parseSchedules([{ id: 's2', title: 'x', prompt: 'p', hour: 9, minute: 0 }])
  ok(old.length === 1 && old[0]!.enabled === true && old[0]!.createdAt === 0,
    'an old record without new fields parses with defaults')
  ok(parseSchedules('not an array').length === 0 && parseSchedules(undefined).length === 0,
    'a non-array store reads as empty, never throws')
}
{
  // DAY_NAMES exists so view and tests share the labels; sanity-check the
  // numbering the whole module assumes: JS getDay() 0 = Sunday. Local
  // constructors — a UTC string would land on a different weekday west of
  // Greenwich.
  ok(DAY_NAMES[new Date(2026, 8, 6).getDay()] === 'Sun' &&
    DAY_NAMES[new Date(2026, 8, 7).getDay()] === 'Mon',
    'day numbering matches JS getDay (0 = Sunday)')
}

// --- parseScheduleDraft (the board-tools fence) ------------------------------

{
  const good = parseScheduleDraft({
    title: ' Morning patrol ', prompt: 'Check the bug board\nand start fixing.',
    hour: 9, minute: 30, days: [1, 2, 2, 3], enabled: false,
  })
  ok(good.ok && good.draft.title === 'Morning patrol',
    'a well-formed draft parses, with the title trimmed')
  ok(good.ok && good.draft.hour === 9 && good.draft.minute === 30,
    'hour and minute come through as named')
  ok(good.ok && good.draft.days.join(',') === '1,2,3',
    'duplicate days collapse to a set, in order')
  ok(good.ok && good.draft.enabled === false,
    'an explicit enabled:false is respected, not defaulted away')
  ok(good.ok && good.draft.enabled !== undefined, 'enabled is never undefined — a real boolean')
}
{
  const junk = [
    undefined, null, 'nope', 42,
    { title: '', prompt: 'p', hour: 9, minute: 0, days: [1] },
    { title: 'x', prompt: '  ', hour: 9, minute: 0, days: [1] },
    { title: 'x', prompt: 'p', hour: 24, minute: 0, days: [1] },
    { title: 'x', prompt: 'p', hour: -1, minute: 0, days: [1] },
    { title: 'x', prompt: 'p', hour: 9.5, minute: 0, days: [1] },
    { title: 'x', prompt: 'p', hour: 9, minute: 60, days: [1] },
    { title: 'x', prompt: 'p', hour: 9, minute: 0, days: [] },
    { title: 'x', prompt: 'p', hour: 9, minute: 0, days: [-1, 7, 2.5] },
    { title: 'x', prompt: 'p', hour: 9, minute: 0, days: 'weekdays' },
  ]
  for (const bad of junk) {
    const r = parseScheduleDraft(bad)
    ok(!r.ok && r.message.length > 0, `refuses ${JSON.stringify(bad)?.slice(0, 60)} with a reason: ${r.ok ? '' : r.message}`)
  }
  // A draft that would not survive parseSchedules must be refused, not written
  // and then silently dropped on the next read-back.
  const tooLongTitle = parseScheduleDraft({ title: 'x'.repeat(201), prompt: 'p', hour: 9, minute: 0, days: [1] })
  ok(!tooLongTitle.ok, 'a title longer than the reader accepts is refused up front')
}

// --- createdBy: the agent stamp survives the read-back ------------------------
{
  // The exact object the host's tool path writes: a parsed draft, an id, a
  // stamp, and the creator's card title. The READ BACK is parseSchedules — this
  // is the write/read round trip the persistence rule asks for.
  const created = parseScheduleDraft({ title: 'Bug patrol', prompt: 'Fix them.', hour: 9, minute: 0, days: [1] })
  ok(created.ok, 'sanity: the draft parses')
  if (created.ok) {
    const s: Schedule = {
      id: 'a1', ...created.draft,
      createdAt: 1000,
      createdBy: 'Pricing, spawn policy and schedules',
    }
    const round = parseSchedules(JSON.parse(JSON.stringify([s])))
    ok(round[0]?.createdBy === 'Pricing, spawn policy and schedules',
      'a schedule written with createdBy reads back with its creator')
    ok(round[0]?.createdBy !== undefined, 'and it is a real field on the schedule, not derived on the page')
  }
}
{
  // A schedule the user typed into the settings form has no creator stamp, and
  // must stay unmarked — an old record must not grow a badge the host never wrote.
  const userMade = parseSchedules([{ id: 'u1', title: 'x', prompt: 'p', hour: 9, minute: 0, createdAt: 5 }])
  ok(userMade[0]?.createdBy === undefined, 'a user-created schedule has no creator — absence, not a default')
  const junkBy = parseSchedules([{ id: 'j1', title: 'x', prompt: 'p', hour: 9, minute: 0, createdAt: 5, createdBy: 42 }])
  ok(junkBy[0]?.createdBy === undefined, 'a non-string creator stamp is dropped, never cast')
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('schedule: all ok')
