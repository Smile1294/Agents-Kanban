/* The schedule rows on the settings page, and the one mark the board tools
   added: which schedules an AGENT created.

   Same harness as `settings-view.test.mjs` and `settings-spawn.test.mjs`:
   media/settings.js runs against a stub DOM, and a webview script has no type
   checking — a runtime throw in it is a silently blank tab. A schedule that
   fires sessions with a bill must be traceable to its maker, so the page marks
   agent-created rows with the creator's card title and leaves user-created
   rows unmarked — a badge the host never wrote is a schedule the user cannot
   audit. */
import { renderSettings } from '../../../test/dom.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const schedState = (rows) => ({
  defaultRuntime: 'claude',
  runtimes: [],
  schedules: { rows, canRun: true },
})

{
  const v = await renderSettings(schedState([
    {
      id: 'a1', title: 'Bug patrol', prompt: 'Fix them.', hour: 9, minute: 0,
      days: [1, 2, 3, 4, 5], enabled: true, when: 'Mon–Fri at 09:00',
      createdBy: 'Pricing, spawn policy and schedules',
    },
    {
      id: 'a2', title: 'Build check', prompt: 'Run the build.', hour: 14, minute: 30,
      days: [0], enabled: true, when: 'Sun at 14:30',
    },
  ]))

  const badges = v.root.querySelectorAll('.sched-by')
  ok(badges.length === 1,
     `exactly the agent-created row carries a creator badge (${badges.length})`)
  ok((badges[0]?.textContent ?? '').includes('Pricing, spawn policy and schedules'),
     'and the badge names the card that created it — the thing the user can find on the board')
  ok(typeof badges[0]?.title === 'string' && badges[0]?.title.includes('not typed into this form'),
     'with a tooltip that says it was not typed into the form below')

  const rows = v.root.querySelectorAll('.row')
  const userRow = [...rows].find((r) => (r.textContent ?? '').includes('Build check'))
  ok(userRow && userRow.querySelectorAll('.sched-by').length === 0,
     'a schedule with no creator stamp renders unmarked — absence, not a default badge')

  // The run buttons still post the right ids beside the new badge: the mark is
  // a readout, not a control, and must not eat the row's actions.
  const remove = [...v.root.querySelectorAll('button')].find((b) => (b.textContent ?? '') === 'Remove')
  remove.onclick()
  const posts = v.posted.filter((m) => m.type === 'removeSchedule')
  ok(posts.length === 1 && posts[0].id === 'a1',
     'and the row\'s own controls still post their ids, unchanged by the badge')
}

{
  // A state from an older host has no `schedules` at all — the section must not
  // crash and must not appear, rather than showing a page that says nothing.
  const legacy = await renderSettings({ defaultRuntime: 'claude', runtimes: [] })
  ok(legacy.root.querySelectorAll('.sched-by').length === 0,
     'a host that never sends schedules draws no schedule section at all')
}

console.log(fails ? `\n${fails} FAILED` : '\nPASS — the creator badge marks only agent-created schedules')
process.exit(fails ? 1 : 0)
