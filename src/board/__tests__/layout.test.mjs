/* Does the board actually FIT?
 *
 * Every other view test asserts on text, and text is not layout. A card whose
 * title is a pasted URL — one token, no spaces — pushed its tail outside the
 * card and rendered as "…example.atlassian.ne" with a stray "184" on the line
 * below. board.js produced exactly the right characters, board.css put them in
 * the wrong place, and nothing in the suite looked at a pixel.
 *
 * So this renders the REAL media/board.css and media/board.js in real Chromium
 * and measures. It is the only test here that can fail on a stylesheet.
 *
 * Chromium comes from playwright, already a devDependency.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { chromium } from 'playwright'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..')

let fails = 0
const ok = (c, m) => { console.log(c ? '  ok:' : 'FAIL:', m); if (!c) fails++ }

const css = await fs.readFile(path.join(repoRoot, 'media', 'board.css'), 'utf8')
const js = await fs.readFile(path.join(repoRoot, 'media', 'board.js'), 'utf8')

/** The title that broke it: a slash command followed by a bare URL. */
const NASTY = '/jira-task https://example.atlassian.net/browse/ACME-184'

const COLUMNS = [
  { id: 'backlog', name: 'Backlog', category: 'backlog' },
  { id: 'implementing', name: 'Implementing', category: 'started' },
]
const state = {
  ready: true, mode: 'kanban', columns: COLUMNS,
  cards: [
    { key: 'a', sessionId: 'a', title: NASTY, phase: 'implementing', tags: [], updated: Date.now(),
      branch: 'task/S1mtm15tju-jira-task-https-example-atlassian-net-',
      // A split card carries a whole list inside itself, and the titles in it
      // are as unbounded as any other. Same box, same rules.
      subtasks: [
        { key: 'a1', title: NASTY, phase: 'validating', ready: true },
        { key: 'a2', title: 'y'.repeat(160), phase: 'implementing', ready: false },
      ] },
    // A single unbroken 200-character token — nothing may escape the card.
    { key: 'b', sessionId: 'b', title: 'x'.repeat(200), phase: 'implementing', tags: [], updated: Date.now(),
      parent: 'a', parentTitle: NASTY },
    // A run the host killed. Its banner is another flex row inside the card, so
    // it is measured with the rest rather than trusted — the two bugs this gate
    // has caught were both a flex item's default min-width: auto.
    { key: 'c', sessionId: 'c', title: NASTY, phase: 'implementing', tags: [], updated: Date.now(),
      interrupted: Date.now() - 3 * 24 * 60 * 60 * 1000 },
  ],
  composer: {
    model: 'claude-opus-5', effort: 'high', thinking: 'enabled',
    models: [{ id: 'claude-opus-5', label: 'Opus 5', context: '1M' }],
    efforts: [{ key: 'high', label: 'High' }], contextTokens: 0,
    permissionMode: 'acceptEdits', permissionModes: [{ key: 'acceptEdits', label: 'Auto', detail: 'x' }],
  },
  running: 0, waiting: 0,
}

/* Chat mode, with the rows that carry a timing.
   A tool row is a flex line of mark / summary / timer / status, and the summary
   is the elastic one. A counter that grew a digit every ten seconds had every
   opportunity to squeeze it, push the tick mark off the end, or make the row
   scroll — none of which any text assertion can see. */
const chatState = {
  ...state, mode: 'chat', selectedKey: 'a',
  // The composer bar with everything on it at once: five pickers plus the
  // context meter and the spend figure. This is the row most at risk of a
  // squeeze, and both readouts are numbers whose whole purpose is to be read.
  composer: {
    ...state.composer,
    contextTokens: 998_000, contextWindow: 1_000_000,
    meter: { kind: 'usd', spentUsd: 1234.56, priced: false },
    // The split dial is a SIXTH picker on a bar that was already the row most
    // at risk of a squeeze — and the readouts to its right are the two things
    // on it that are pure information.
    orchestration: 'maximum',
    orchestrationLevels: [
      { key: 'minimal', label: 'Minimal', detail: 'Prefer one agent.' },
      { key: 'balanced', label: 'Balanced', detail: 'Split when independent.' },
      { key: 'maximum', label: 'Maximum', detail: 'Split readily.' },
    ],
  },
  transcript: [
    { kind: 'tool', at: 1, id: 't1', name: 'mcp__claude_ai_Atlassian__getJiraIssue',
      summary: 'Atlassian · getJiraIssue  ' + NASTY + ' ' + 'y'.repeat(120),
      status: 'ok', durationMs: 272000 },
    { kind: 'tool', at: 2, id: 't2', name: 'mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql',
      summary: 'Atlassian · searchJiraIssuesUsingJql  project = ACME AND status != Done ORDER BY created DESC',
      status: 'running', runningSince: Date.now() - 3661000 },
  ],
}

const page$ = (st, layout = 'board') => `<!DOCTYPE html>
<html lang="en" data-layout="${layout}"><head><meta charset="utf-8">
<style>:root { --vscode-font-family: sans-serif; --vscode-font-size: 13px; --vscode-foreground: #ccc;
  --vscode-editor-background: #1f1f1f; --vscode-widget-border: #313131; --vscode-focusBorder: #0078d4; }</style>
<style>${css}</style></head>
<body><div id="root"></div>
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} })</script>
<script>${js}</script>
<script>window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: ${JSON.stringify(st)} } }))</script>
</body></html>`

const html = page$(state)

/* Playwright pins one browser build per version, and a machine often has a
   NEWER one cached from some other tool — which playwright refuses to use,
   telling you to download the one it wants. Any Chromium can measure a box, so
   take whatever is here rather than making `npm run verify` pull ~170MB. */
async function findChromium() {
  const os = await import('node:os')
  // PLAYWRIGHT_BROWSERS_PATH first: where it is set — CI images, containers —
  // it is the only place browsers are, and the default cache does not exist at
  // all. Looking only in the default is how this gate reports "no Chromium" on
  // a machine that has three.
  const roots = [
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? [process.env.PLAYWRIGHT_BROWSERS_PATH] : []),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ]
  for (const cache of roots) {
    const dirs = await fs.readdir(cache).catch(() => [])
    const builds = dirs
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      .sort((a, b) => Number(b.match(/\d+$/)[0]) - Number(a.match(/\d+$/)[0]))
    for (const d of builds) {
      for (const rel of [['chrome-linux', 'headless_shell'], ['chrome-linux', 'chrome'],
                         ['chrome-linux64', 'chrome'],
                         ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
                         ['chrome-win', 'chrome.exe']]) {
        const exe = path.join(cache, d, ...rel)
        if (await fs.stat(exe).then((st) => st.isFile(), () => false)) return exe
      }
    }
  }
  return undefined
}

const exe = await findChromium()
let browser
try {
  browser = await chromium.launch(exe ? { executablePath: exe } : {})
} catch (e) {
  console.log('FAIL: no Chromium to measure with — run `npx playwright install chromium`')
  console.log(`       (${String(e).split('\n')[0]})`)
  process.exit(1)
}
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent(html)
  await page.waitForSelector('.card', { timeout: 5000 })
  ok(errors.length === 0, `the view renders without throwing (${errors.join('; ') || 'clean'})`)

  const measured = await page.evaluate(() => {
    const out = []
    for (const card of document.querySelectorAll('.card')) {
      const t = card.querySelector('.title')
      const cb = card.getBoundingClientRect()
      const tb = t.getBoundingClientRect()
      out.push({
        title: (t.textContent || '').slice(0, 30),
        // Does content spill horizontally out of its own box?
        titleOverflow: Math.round(t.scrollWidth - t.clientWidth),
        cardOverflow: Math.round(card.scrollWidth - card.clientWidth),
        // Does the title box stick out past the card's padding box?
        escapesRight: Math.round(tb.right - cb.right),
        height: Math.round(cb.height),
      })
    }
    return out
  })

  for (const m of measured) {
    // 1px of slack: sub-pixel text metrics round either way.
    ok(m.titleOverflow <= 1, `title does not overflow its box (${m.titleOverflow}px): ${JSON.stringify(m.title)}`)
    ok(m.cardOverflow <= 1, `card does not scroll horizontally (${m.cardOverflow}px)`)
    ok(m.escapesRight <= 1, `title stays inside the card (${m.escapesRight}px past the right edge)`)
  }

  // The clamp: one pathological title must not make a card tower over the rest.
  // Measured on the card whose title is the 200-character token — the split
  // card beside it is legitimately taller, because it is carrying a list.
  // Matched on the token rather than the row's opening character: the title row
  // now leads with the select-this-card box, so anchoring on '✦' silently found
  // NOTHING and the clamp assertion read `undefinedpx`.
  const clamped = measured.find((m) => m.title.includes('xxxx'))
  ok(!!clamped && clamped.height < 200,
     `a 200-character title is clamped, not a full-height card (${clamped?.height}px)`)

  // The subtask list a split adds to its parent card, and the parent reference
  // a subtask adds to its own. Both hold titles the user pasted, inside a column
  // that is 300px wide on a good day.
  const sub = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.subtask')].map((r) => ({
      overflow: Math.round(r.scrollWidth - r.clientWidth),
      escapes: Math.round(r.getBoundingClientRect().right - r.closest('.card').getBoundingClientRect().right),
      height: Math.round(r.getBoundingClientRect().height),
    }))
    const up = document.querySelector('.subtask-of')
    return {
      rows,
      upOverflow: up ? Math.round(up.scrollWidth - up.clientWidth) : -1,
      upEscapes: up ? Math.round(up.getBoundingClientRect().right - up.closest('.card').getBoundingClientRect().right) : -1,
    }
  })
  ok(sub.rows.length === 2, `both subtask rows drew (${sub.rows.length})`)
  for (const r of sub.rows) {
    ok(r.overflow <= 1, `a subtask row does not scroll horizontally (${r.overflow}px)`)
    ok(r.escapes <= 1, `and stays inside the card (${r.escapes}px past the edge)`)
    ok(r.height < 40, `on one line (${r.height}px)`)
  }
  ok(sub.upOverflow <= 1, `the parent reference does not overflow (${sub.upOverflow}px)`)
  ok(sub.upEscapes <= 1, `and stays inside its card (${sub.upEscapes}px past the edge)`)

  // --- the transcript's tool rows, which now carry a timing ------------------
  const chat = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const chatErrors = []
  chat.on('pageerror', (e) => chatErrors.push(String(e)))
  await chat.setContent(page$(chatState))
  await chat.waitForSelector('.tool', { timeout: 5000 })
  ok(chatErrors.length === 0, `the chat view renders without throwing (${chatErrors.join('; ') || 'clean'})`)

  /* The rail is `flex: 0 0 258px`, which is a request, not a width: a flex item
     will not shrink below its content unless told to. The 200-character session
     title stretched it to 1350px inside a 900px window and left the transcript
     beside it ZERO pixels wide — the chat did not look wrong, it looked empty.
     Measured here because that is the only way to see it: every text assertion
     was green, and the text was all present, in a box nobody could read. */
  const frame = await chat.evaluate(() => {
    const q = (sel) => { const n = document.querySelector(sel); return n ? Math.round(n.getBoundingClientRect().width) : -1 }
    return { rail: q('.rail'), main: q('.main.chat'), shell: q('.shell') }
  })
  ok(frame.rail > 0 && frame.rail <= 300,
     `the session rail keeps its width beside an unbreakable title (${frame.rail}px)`)
  ok(frame.main > 300, `so the transcript still has room to be read (${frame.main}px)`)

  const rows = await chat.evaluate(() => {
    const out = []
    for (const row of document.querySelectorAll('.tool')) {
      const rb = row.getBoundingClientRect()
      const time = row.querySelector('.tool-time')
      const status = row.querySelector('.tool-status')
      out.push({
        text: (row.textContent || '').slice(0, 24),
        rowOverflow: Math.round(row.scrollWidth - row.clientWidth),
        // The timing and the tick both have to survive to the right-hand end.
        timeText: time ? time.textContent : null,
        timeWidth: time ? Math.round(time.getBoundingClientRect().width) : 0,
        statusEscapes: status ? Math.round(status.getBoundingClientRect().right - rb.right) : 0,
        height: Math.round(rb.height),
      })
    }
    return out
  })

  /* The context meter and the spend figure, measured rather than asserted on
     text. They are the two things in the bar that are pure information: a
     picker that loses a few pixels is still recognisable, whereas `$1,234` cut
     to `$1,2` is worse than absent. Both are `flex: none` for that reason, and
     this is what checks it. */
  const measureReadouts = () => {
    const bar = document.querySelector('.composer-bar')
    const bb = bar.getBoundingClientRect()
    const box = (sel) => {
      const n = bar.querySelector(sel)
      if (!n) return null
      const r = n.getBoundingClientRect()
      return {
        text: n.textContent, width: Math.round(r.width), height: Math.round(r.height),
        top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right),
        escapesRight: Math.round(r.right - bb.right), clipped: n.scrollWidth - n.clientWidth,
      }
    }
    return {
      barOverflow: Math.round(bar.scrollWidth - bar.clientWidth),
      barHeight: Math.round(bb.height),
      ctx: box('.ctx'), spend: box('.spend'), meter: box('.ctx-meter'),
    }
  }

  const checkReadouts = (readouts, where) => {
    ok(readouts.barOverflow <= 1, `${where}: the composer bar does not scroll horizontally (${readouts.barOverflow}px)`)
    for (const [name, m] of [['context', readouts.ctx], ['spend', readouts.spend]]) {
      ok(!!m, `${where}: the ${name} readout is on the bar`)
      if (!m) continue
      ok(m.width > 20, `${where}: the ${name} readout is not squeezed to nothing (${JSON.stringify(m.text)} @ ${m.width}px)`)
      ok(m.clipped <= 1, `${where}: and is not clipped mid-number (${m.clipped}px hidden)`)
      ok(m.escapesRight <= 1, `${where}: and stays inside the bar (${m.escapesRight}px past the edge)`)
      ok(m.height < 30, `${where}: on one line (${m.height}px)`)
    }
    /* The spend figure sits NEXT TO the context figure — the thing that was
       asked for, and the thing that silently stopped being true when the bar
       wrapped and put the spend at the start of a second row, 576px away from
       the number it belongs beside. Same row, and touching. */
    if (readouts.ctx && readouts.spend) {
      ok(readouts.spend.top === readouts.ctx.top,
         `${where}: the spend figure is on the same row as the context figure ` +
         `(${readouts.spend.top}px vs ${readouts.ctx.top}px)`)
      const gap = readouts.spend.left - readouts.ctx.right
      ok(gap >= 0 && gap < 40,
         `${where}: and immediately beside it, not across the bar (${gap}px apart)`)
    }
    ok(readouts.meter && readouts.meter.width > 10, `${where}: the meter itself has width (${readouts.meter?.width}px)`)
    ok(readouts.barHeight < 90, `${where}: and the bar does not grow into the transcript (${readouts.barHeight}px)`)
  }

  checkReadouts(await chat.evaluate(measureReadouts), 'at 900px')

  ok(rows.length === 2, `both tool rows drew (${rows.length})`)
  for (const r of rows) {
    ok(r.rowOverflow <= 1, `tool row does not scroll horizontally (${r.rowOverflow}px): ${JSON.stringify(r.text)}`)
    ok(r.statusEscapes <= 1, `the status mark stays inside the row (${r.statusEscapes}px past the edge)`)
    ok(r.timeWidth > 0, `the timing is not squeezed to nothing by a long summary (${JSON.stringify(r.timeText)} @ ${r.timeWidth}px)`)
    // One line. A wrapped tool row turns a transcript into a wall.
    ok(r.height < 40, `the row stays on one line (${r.height}px)`)
  }
  await chat.close()

  /* The same bar in a SPLIT editor, which is where it actually gets squeezed.
     Everything left of the readouts is elastic and will happily take the row:
     at 560px the pickers alone want more than the width, so without `flex:
     none` on the two readouts the browser shrinks them instead — and a spend
     figure clipped to "$1,2" is worse than one that is not there. Measured at a
     width where the squeeze is real, because an assertion that cannot fail is
     not a gate. */
  const narrow = await browser.newPage({ viewport: { width: 560, height: 800 } })
  const narrowErrors = []
  narrow.on('pageerror', (e) => narrowErrors.push(String(e)))
  await narrow.setContent(page$(chatState))
  await narrow.waitForSelector('.composer-bar', { timeout: 5000 })
  ok(narrowErrors.length === 0, `the narrow chat renders without throwing (${narrowErrors.join('; ') || 'clean'})`)
  checkReadouts(await narrow.evaluate(measureReadouts), 'in a split editor (560px)')
  await narrow.close()

  /* The SUBSCRIPTION arm of the meter, at the narrow width, because it is
     materially wider than a price and nothing had ever measured it.
     "27% of 5h · plus" is roughly twice the width of "$1.23", and the readouts
     sit at the right-hand end of a bar whose contents already want more than
     560px — so this is exactly the shape that pushes a number off the edge
     while every text assertion stays green. Two of this project's postmortems
     are that failure; the plan meter arrived with none of them covered. */
  const plan = await browser.newPage({ viewport: { width: 560, height: 800 } })
  const planErrors = []
  plan.on('pageerror', (e) => planErrors.push(String(e)))
  await plan.setContent(page$({
    ...chatState,
    composer: {
      ...chatState.composer,
      // A worst case that is still real: three digits, the longer 7d window,
      // and a plan name.
      meter: {
        kind: 'plan', usedPercent: 100, windowMinutes: 10080, plan: 'enterprise',
        resetsAt: Math.floor(Date.now() / 1000) + 7200,
      },
    },
  }))
  await plan.waitForSelector('.composer-bar', { timeout: 5000 })
  ok(planErrors.length === 0, `the plan meter renders without throwing (${planErrors.join('; ') || 'clean'})`)
  const planReadouts = await plan.evaluate(measureReadouts)
  checkReadouts(planReadouts, 'a subscription meter at 560px')
  ok(/100% of 7d/.test(planReadouts.spend?.text ?? ''),
     `and says the window it spent rather than a price (${JSON.stringify(planReadouts.spend?.text)})`)
  ok(!/\$/.test(planReadouts.spend?.text ?? ''),
     'with no dollar sign anywhere on it — a subscription session has no price to show')
  await plan.close()

  /* And the "we could not read it" arm. An em dash is one character, so the
     risk here is the opposite one: a chip so narrow it reads as an empty gap. */
  const unknown = await browser.newPage({ viewport: { width: 900, height: 800 } })
  await unknown.setContent(page$({
    ...chatState,
    composer: { ...chatState.composer, meter: { kind: 'unknown' } },
  }))
  await unknown.waitForSelector('.composer-bar', { timeout: 5000 })
  const unknownReadouts = await unknown.evaluate(measureReadouts)
  ok((unknownReadouts.spend?.width ?? 0) > 8,
     `an unknown meter is still wide enough to be seen (${unknownReadouts.spend?.width}px)`)
  ok(unknownReadouts.spend?.text === '—',
     `and is an em dash, never a zero (${JSON.stringify(unknownReadouts.spend?.text)})`)
  await unknown.close()

  /* --- a repaint must not move a scrolled column -------------------------------
     An agent at work produces a state message every few hundred milliseconds,
     and the column body is the scroll container. Two rules, and they are
     different rules:

     1. A frame that changes NOTHING structural must not rebuild the column at
        all. Restoring the offset onto a fresh node is not good enough: a node
        that is destroyed mid-gesture takes the wheel scroll or the scrollbar
        drag with it, and no restored number brings that back. This is the
        "I cannot scroll the board while it is running" report.
     2. A frame that genuinely changes the chrome DOES rebuild, and then the
        offset has to be carried across — the `data-scroll` harvest.

     Measured in a real browser because scrollTop only means anything once the
     box has a height. */
  const tall = {
    ...state,
    cards: Array.from({ length: 40 }, (_, i) => ({
      key: 't' + i, sessionId: 't' + i, title: 'Session number ' + i, phase: 'implementing', tags: [], updated: 1000 + i,
    })),
  }
  /* What the HOST actually sends while an agent streams: the same board, with
     the running card's volatile readouts moving. `updated` moves too — a live
     session's transcript file is being written — and the whole freeze was that
     any movement in it rebuilt the tree. */
  /* Anchored to the START of the current minute, so the three frames below
     cannot straddle one. `ago()` renders at minute resolution and the board
     legitimately redraws when that text changes — a test that sometimes
     crossed the boundary would fail once an hour for the right reason, which
     is indistinguishable from failing for the wrong one. */
  const T0 = Math.floor(Date.now() / 60000) * 60000
  const busyCards = (tool, at) => [
    { ...tall.cards[0], updated: at, agent: { kind: 'working', tool, lastEventAt: at, contextTokens: 40000, contextWindow: 200000 } },
    ...tall.cards.slice(1),
  ]
  const busy = { ...tall, cards: busyCards('Bash', T0), running: 1 }
  const scrolled = await browser.newPage({ viewport: { width: 1400, height: 600 } })
  await scrolled.setContent(page$(busy))
  await scrolled.waitForSelector('.card', { timeout: 5000 })
  const kept = await scrolled.evaluate((frames) => {
    const find = () => [...document.querySelectorAll('.column')]
      .find((c) => c.querySelector('.column-head').textContent.includes('Implementing'))
      .querySelector('.cards')
    const body = find()
    body.scrollTop = 150
    const set = body.scrollTop
    for (const f of frames.volatile) {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: f } }))
    }
    const live = find()
    const out = {
      set,
      rebuiltOnVolatile: live !== body,
      afterVolatile: live.scrollTop,
      tool: document.querySelector('.agent-row').textContent,
    }
    // Now something real changes: a card is renamed. That must rebuild, and the
    // offset must survive the rebuild.
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: frames.renamed } }))
    const after = find()
    out.rebuiltOnChrome = after !== body
    out.afterChrome = after.scrollTop
    out.renamed = document.body.textContent.includes('Session renamed')
    return out
  }, {
    volatile: [
      { ...busy, cards: busyCards('Bash', T0 + 300) },
      { ...busy, cards: busyCards('Edit', T0 + 600) },
    ],
    renamed: {
      ...busy,
      cards: [{ ...busy.cards[0], title: 'Session renamed' }, ...busy.cards.slice(1)],
    },
  })
  ok(kept.set === 150, `the column body is tall enough to scroll (asked for 150, got ${kept.set})`)
  ok(!kept.rebuiltOnVolatile, 'a streaming frame does NOT rebuild the column — the node the reader is scrolling survives')
  ok(Math.abs(kept.afterVolatile - 150) <= 1, `and it stays where it was scrolled to (${kept.afterVolatile}px)`)
  ok(kept.tool.includes('Edit'), `while the card's tool readout still updated in place (${JSON.stringify(kept.tool)})`)
  ok(kept.rebuiltOnChrome, 'a real change (a renamed card) still rebuilds the column')
  ok(kept.renamed, 'and the new title is on screen')
  ok(Math.abs(kept.afterChrome - 150) <= 1, `with the scroll offset carried across the rebuild (${kept.afterChrome}px)`)
  await scrolled.close()

  /* --- rendered markdown must stay inside the transcript ------------------------
     A code block carries lines as long as the agent wrote them, and a table is
     as wide as its columns. Either one, left to itself, widens the transcript
     and puts a horizontal scrollbar on the whole conversation — the same flex
     trap as the tool row, one level up. The block has to scroll inside its own
     box, and the box has to stay readable. Only a browser can say that. */
  const wide = {
    ...chatState,
    transcript: [{
      kind: 'text', at: 1,
      text: 'Run this:\n\n```sql\nSELECT ' + 'a_very_long_column_name, '.repeat(14) + 'done FROM t;\n```\n\n' +
        '| ' + Array(8).fill('a column header of some length').join(' | ') + ' |\n' +
        '|' + '---|'.repeat(8) + '\n' +
        '| ' + Array(8).fill('a cell value of some length too').join(' | ') + ' |\n',
    }],
  }
  const mdPage = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const mdErrors = []
  mdPage.on('pageerror', (e) => mdErrors.push(String(e)))
  await mdPage.setContent(page$(wide))
  await mdPage.waitForSelector('pre', { timeout: 5000 })
  ok(mdErrors.length === 0, `markdown renders without throwing (${mdErrors.join('; ') || 'clean'})`)
  const boxes = await mdPage.evaluate(() => {
    const t = document.querySelector('.transcript-scroll')
    const pre = document.querySelector('pre')
    const table = document.querySelector('table')
    const tr = t.getBoundingClientRect()
    return {
      transcriptOverflow: Math.round(t.scrollWidth - t.clientWidth),
      preWidth: Math.round(pre.getBoundingClientRect().width),
      preScrolls: pre.scrollWidth > pre.clientWidth + 1,
      preEscapes: Math.round(pre.getBoundingClientRect().right - tr.right),
      tableEscapes: table ? Math.round(table.parentElement.getBoundingClientRect().right - tr.right) : 0,
    }
  })
  ok(boxes.transcriptOverflow <= 1, `the transcript does not scroll horizontally (${boxes.transcriptOverflow}px)`)
  ok(boxes.preWidth > 300, `the code block is a readable width (${boxes.preWidth}px)`)
  ok(boxes.preScrolls, 'a long code line scrolls inside its own block rather than being lost')
  ok(boxes.preEscapes <= 1, `the code block stays inside the transcript (${boxes.preEscapes}px past the edge)`)
  ok(boxes.tableEscapes <= 1, `and so does the table (${boxes.tableEscapes}px past the edge)`)
  await mdPage.close()

  /* The AskUserQuestion picker. A long option description is exactly the shape
     that has twice defeated `text-overflow: ellipsis` in this stylesheet — a
     flex item's default `min-width: auto` refusing to shrink — and the picker
     is nested three flex containers deep inside a narrow chat column. If it
     overflows, the buttons the whole feature exists for are off screen. */
  const askPage = await browser.newPage({ viewport: { width: 900, height: 900 } })
  await askPage.setContent(page$({
    ...chatState,
    cards: chatState.cards.map((c) => (c.key === 'a'
      ? { ...c, agent: { kind: 'needsInput', contextTokens: 1, contextWindow: 2,
            pendingPermission: { id: 'q1', summary: 'AskUserQuestion', questions: [{
              question: 'Which way should I fix the redirect loop? ' + 'w'.repeat(90),
              header: 'Approach', multiSelect: false,
              options: [
                { label: 'Verify the JWT signature ' + 'x'.repeat(70),
                  description: 'The correct fix. ' + 'y'.repeat(150) },
                { label: 'Cap the redirects' },
              ] }] } } }
      : c)),
  }))
  await askPage.waitForSelector('.ask-questions', { timeout: 5000 })
  const ask = await askPage.evaluate(() => {
    const box = document.querySelector('.ask-questions')
    const br = box.getBoundingClientRect()
    const opts = [...document.querySelectorAll('.ask-opt')].map((o) => ({
      escapes: Math.round(o.getBoundingClientRect().right - br.right),
      overflow: Math.round(o.scrollWidth - o.clientWidth),
      height: Math.round(o.getBoundingClientRect().height),
    }))
    const send = [...document.querySelectorAll('.ask-questions button')]
      .find((b) => /still to answer|Send answer/.test(b.textContent))
    const other = document.querySelector('.ask-other')
    return {
      boxOverflow: Math.round(box.scrollWidth - box.clientWidth),
      opts,
      sendVisible: !!send && send.getBoundingClientRect().right <= br.right + 1,
      otherEscapes: Math.round(other.getBoundingClientRect().right - br.right),
    }
  })
  ok(ask.boxOverflow <= 1, `the picker does not scroll horizontally (${ask.boxOverflow}px)`)
  ok(ask.opts.length === 2, `both options drew (${ask.opts.length})`)
  for (const o of ask.opts) {
    ok(o.escapes <= 1, `an option stays inside the picker (${o.escapes}px past the edge)`)
    ok(o.overflow <= 1, `and does not scroll horizontally (${o.overflow}px)`)
  }
  // A 150-character description has to wrap, not be clipped to one line.
  ok(ask.opts[0].height > 40, `a long description wraps instead of being cut off (${ask.opts[0].height}px)`)
  ok(ask.otherEscapes <= 1, `the free-text box stays inside the picker (${ask.otherEscapes}px past the edge)`)
  ok(ask.sendVisible, 'the Send button is on screen — it is the point of the whole picker')
  await askPage.close()

  /* --- the model menu, measured, because it is now hundreds of rows ---------
   *
   * The list used to be three Claude models with a five-word label each. It is
   * now whatever the endpoint serves — 431 entries on OpenRouter, each with an
   * id, a context window, a price and a sentence of description. Every text
   * assertion about that menu can pass while it draws off the side of the
   * panel or a mile down the page, which is exactly the class of failure this
   * file exists for.
   */
  const menuPage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  const many = [{
    id: 'deepseek/deepseek-chat-v3.1', label: 'DeepSeek: DeepSeek V3.1 ' + 'z'.repeat(60),
    context: '161K', price: '$0.55/$1.65 per Mtok',
    detail: 'A large hybrid reasoning model. ' + 'y'.repeat(200),
  }]
  for (let i = 0; i < 80; i++) {
    many.push({ id: `vendor/model-${i}`, label: `Model ${i}`, context: '128K', price: '$1.00/$2.00 per Mtok' })
  }
  await menuPage.setContent(page$({
    ...chatState,
    composer: { ...chatState.composer, model: many[0].id, models: many, modelSource: 'endpoint' },
  }))
  await menuPage.waitForSelector('.composer-bar', { timeout: 5000 })
  await menuPage.evaluate(() => {
    const b = [...document.querySelectorAll('.picker')].find((x) => /DeepSeek/.test(x.textContent))
    b.click()
  })
  await menuPage.waitForSelector('.menu-list', { timeout: 5000 })
  const menu = await menuPage.evaluate(() => {
    const menu = document.querySelector('.menu')
    const list = document.querySelector('.menu-list')
    const item = document.querySelector('.menu-item')
    const mb = menu.getBoundingClientRect()
    const ib = item.getBoundingClientRect()
    return {
      menuOverflow: Math.round(menu.scrollWidth - menu.clientWidth),
      // A menu wider than the window is a menu whose right-hand half — where
      // the price is — cannot be read.
      widerThanWindow: Math.round(mb.width - window.innerWidth),
      offRight: Math.round(mb.right - window.innerWidth),
      offLeft: Math.round(0 - mb.left),
      // It has to be BOUNDED and scrollable, or 81 rows run off the bottom of
      // a screen with no way back.
      listHeight: Math.round(list.getBoundingClientRect().height),
      scrolls: list.scrollHeight > list.clientHeight + 1,
      itemOverflow: Math.round(item.scrollWidth - item.clientWidth),
      itemEscapes: Math.round(ib.right - mb.right),
      // Two lines: the name, then the id/window/price. A row that has grown to
      // the height of a paragraph is a menu you scroll rather than read.
      itemHeight: Math.round(ib.height),
      filterInside: Math.round(document.querySelector('.menu-filter').getBoundingClientRect().right - mb.right),
    }
  })
  ok(menu.menuOverflow <= 1, `the model menu does not scroll horizontally (${menu.menuOverflow}px)`)
  ok(menu.widerThanWindow < 0, `and is narrower than the window (${menu.widerThanWindow}px)`)
  ok(menu.offRight <= 1, `it does not run off the right of the window (${menu.offRight}px)`)
  ok(menu.offLeft <= 1, `nor off the left (${menu.offLeft}px)`)
  ok(menu.listHeight <= 340, `the list is bounded rather than as tall as the catalogue (${menu.listHeight}px)`)
  ok(menu.scrolls, 'and scrolls inside itself, so the rows below the fold are reachable')
  ok(menu.itemOverflow <= 1, `a row with a 60-character name does not overflow it (${menu.itemOverflow}px)`)
  ok(menu.itemEscapes <= 1, `nor escape the menu (${menu.itemEscapes}px past the edge)`)
  ok(menu.itemHeight > 24 && menu.itemHeight < 90,
     `a row is two lines of information, not one and not a paragraph (${menu.itemHeight}px)`)
  ok(menu.filterInside <= 1, `the filter box stays inside the menu (${menu.filterInside}px past the edge)`)
  await menuPage.close()

  /* --- the transcript-search screen, measured --------------------------------
   *
   * A hit row is a flex column of title / kind / clipped snippet, and the
   * snippet may be a 340-character token with no spaces — the exact shape
   * (a flex item's default min-width: auto) that has escaped this stylesheet
   * twice before. The rail head also holds a second pill now, and the pair
   * must not shove the title off the rail. Driven through the real pill and
   * the real message channel, because the screen opens on a click and fills
   * on an answer, and neither is reachable by text.
   */
  const searchPage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await searchPage.setContent(page$(state))
  await searchPage.waitForSelector('.card', { timeout: 5000 })
  await searchPage.evaluate(() => {
    const pill = [...document.querySelectorAll('button')].find((b) => /Search/.test(b.textContent))
    pill.click()
  })
  await searchPage.waitForSelector('.ts-input', { timeout: 5000 })
  await searchPage.evaluate(() => {
    // Ask first — the answer channel only accepts an answer to the query in
    // the box, so drive the box like a user (Enter searches; the debounce
    // never gets to fire).
    const inp = document.querySelector('.ts-input')
    inp.value = 'jira'
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'searchResults', q: 'jira', more: 0,
      matches: [
        { key: 'a', entryIndex: 0, at: Date.now(), kind: 'prompt',
          snippet: '/jira-task https://example.atlassian.net/browse/ACME-184 jira ' + 'x'.repeat(300),
          lead: false },
        { key: 'b', entryIndex: 0, at: Date.now(), kind: 'text',
          snippet: 'jira ' + 'y'.repeat(330), lead: true },
      ],
    } }))
  })
  await searchPage.waitForSelector('.srow', { timeout: 5000 })
  const search = await searchPage.evaluate(() => {
    const list = document.querySelector('.search-list')
    const rows = [...document.querySelectorAll('.srow')]
    const first = rows[0]
    const title = first.querySelector('.srow-title')
    const snip = first.querySelector('.srow-snip')
    const mark = first.querySelector('mark.hl')
    const head = document.querySelector('.rail-head')
    const nb = list.getBoundingClientRect()
    const rb = first.getBoundingClientRect()
    const tb = title.getBoundingClientRect()
    return {
      listOverflow: Math.round(list.scrollWidth - list.clientWidth),
      rowEscapes: Math.round(tb.right - nb.right),
      rowOverflow: Math.round(rb.width - nb.width + (rb.right - nb.right)),
      snipHeight: Math.round(snip.getBoundingClientRect().height),
      rows: rows.length,
      markInside: !!mark && mark.getBoundingClientRect().right <= tb.right + 1,
      headOverflow: Math.round(head.scrollWidth - head.clientWidth),
      pillVisible: [...document.querySelectorAll('.rail-head button')]
        .every((p) => p.getBoundingClientRect().right <= head.getBoundingClientRect().right + 1),
    }
  })
  ok(search.listOverflow <= 1, `the result list does not scroll horizontally (${search.listOverflow}px)`)
  ok(search.rowEscapes <= 1, `a hit title stays inside the list (${search.rowEscapes}px past the edge)`)
  ok(search.rows === 2, `both hits drew (${search.rows})`)
  ok(search.snipHeight > 16 && search.snipHeight < 46,
     `a snippet is at most two lines, never a paragraph (${search.snipHeight}px)`)
  ok(search.markInside, 'the highlight mark sits inside the row')
  ok(search.headOverflow <= 1, `the rail head with two pills does not overflow (${search.headOverflow}px)`)
  ok(search.pillVisible, 'both pills are on screen')
  await searchPage.close()

  /* --- the "agent stopped here" marker, in a real 300px column --------------
   *
   * A kanban column is 300px on a good day, and this marker carries a sentence
   * and a button on a card that already has a title, tags and a branch line. The
   * first draft read "Stopped 24m ago — card not moved" and ellipsised away to
   * "Stopped 24m ago — car…", which is a sentence nobody can read. A screenshot
   * caught it; no text assertion could, because every character was present and
   * correct in a box too narrow to show them. So: does it fit, and is the
   * button — the only action on it — actually on screen? */
  const stalledPage = await browser.newPage({ viewport: { width: 1400, height: 900 } })
  await stalledPage.setContent(page$({
    ...state,
    // The shared COLUMNS fixture has no review column; the real board does, and
    // the marker reads its destination off the board rather than off the card.
    columns: [...COLUMNS, { id: 'validating', name: 'Validating', category: 'review' }],
    cards: [{
      key: 'sk', sessionId: 'sk',
      title: 'Fix supplier invite 404 without registration number (PB-615)',
      phase: 'implementing', tags: ['PB-615', 'suppliers', 'supply-chain'],
      updated: Date.now() - 71 * 60000,
      branch: 'task/S405w-jira-task-https-eachthing-atlassian-net-browse-PB-615',
      worktree: '/repo/.agentskanban/worktrees/S405w',
      stalled: Date.now() - 71 * 60000,
    }],
  }))
  await stalledPage.waitForSelector('.stalled', { timeout: 5000 })
  const stld = await stalledPage.evaluate(() => {
    const box = document.querySelector('.stalled')
    const card = box.closest('.card')
    const title = box.querySelector('.stalled-title')
    const btn = box.querySelector('button')
    const cb = card.getBoundingClientRect()
    const bb = btn ? btn.getBoundingClientRect() : null
    return {
      boxOverflow: Math.round(box.scrollWidth - box.clientWidth),
      cardOverflow: Math.round(card.scrollWidth - card.clientWidth),
      titleClipped: title.scrollWidth - title.clientWidth > 1,
      label: btn && btn.textContent,
      btnInside: !!bb && bb.right <= cb.right + 1 && bb.left >= cb.left - 1 && bb.width > 0 && bb.height > 0,
    }
  })
  ok(stld.boxOverflow <= 1, `the stopped marker does not scroll horizontally (${stld.boxOverflow}px)`)
  ok(stld.cardOverflow <= 1, `nor widen its card (${stld.cardOverflow}px)`)
  ok(!stld.titleClipped, 'and its sentence is readable rather than ellipsised away')
  ok(stld.btnInside, `the hand-back button is on screen in a 300px column: ${JSON.stringify(stld.label)}`)
  await stalledPage.close()

  /* --- the uncommitted-merge banner, at split-editor width ------------------
   *
   * It carries the two things this stylesheet has been bitten by twice — a
   * branch name in a flex row and a list of file paths — plus a list long
   * enough that the banner's own height cap has to hold. Nothing else in the
   * suite can see any of it: every text assertion on this banner is green
   * whether or not it is readable. Each assertion below was watched failing
   * (1070px of overflow with the title's ellipsis removed, 734px with the file
   * row's, a 1000px-tall banner with its max-height removed). Abort especially
   * has to stay on screen: a review with only a yes on it is not a review. */
  const mergePage = await browser.newPage({ viewport: { width: 560, height: 800 } })
  await mergePage.setContent(page$({
    ...chatState,
    pendingMerge: {
      into: 'main',
      from: 'task/S1mtmz1zmy-' + 'can-you-please-review-this-repository-and-figure-out-how-it-works'.repeat(3),
      head: 'd8293def79a69d84ff02264ca216243a815db152',
      files: [
        'src/board/__tests__/' + 'very/deeply/nested/directory/'.repeat(6) + 'component.test.ts',
        ...Array.from({ length: 40 }, (_, i) => `src/generated/module-${i}.ts`),
      ],
      conflicted: false,
    },
  }, 'compact'))
  await mergePage.waitForSelector('.pending-merge', { timeout: 5000 })
  const pm = await mergePage.evaluate(() => {
    const box = document.querySelector('.pending-merge')
    const row = document.querySelector('.merge-file')
    const bb = box.getBoundingClientRect()
    const buttons = [...box.querySelectorAll('.row-actions button')]
    return {
      boxOverflow: Math.round(box.scrollWidth - box.clientWidth),
      rowOverflow: Math.round(row.scrollWidth - row.clientWidth),
      files: document.querySelectorAll('.merge-file').length,
      height: Math.round(bb.height),
      labels: buttons.map((b) => b.textContent),
      buttonsInside: buttons.every((b) => {
        const r = b.getBoundingClientRect()
        return r.right <= bb.right + 1 && r.left >= bb.left - 1 && r.width > 0 && r.height > 0
      }),
    }
  })
  ok(pm.boxOverflow <= 1, `a long branch name does not make the banner scroll sideways (${pm.boxOverflow}px)`)
  ok(pm.rowOverflow <= 1, `nor does a deep file path widen its row (${pm.rowOverflow}px)`)
  ok(pm.files === 41, `every staged file drew (${pm.files})`)
  ok(pm.height > 0 && pm.height < 400,
     `41 files leave the banner bounded, not half the screen (${pm.height}px)`)
  ok(pm.buttonsInside, `both answers are on screen at 560px: ${JSON.stringify(pm.labels)}`)
  await mergePage.close()

  /* --- upward pagination, MEASURED: the reader stays on their paragraph ------
   *
   * The stub DOM cannot reflow, so the anchor arithmetic — scrollTop += the
   * height the prepend added — is only verifiable where layout is real. A
   * reader mid-transcript, the widened window arrives, the fast path prepends
   * the older rows: the paragraph that was at the top of the viewport must
   * still be there, pixel for pixel, and the offset must have grown by the
   * prepended height. A rebuild would pass neither (scroll restore puts back
   * a NUMBER, and the number would be stale).
   */
  const pagRows = Array.from({ length: 40 }, (_, i) => ({ kind: 'text', at: 200 + i, text: 'tail row ' + i }))
  const oldRows = Array.from({ length: 10 }, (_, i) => ({ kind: 'text', at: 100 + i, text: 'old row ' + i }))
  const pagPage = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const pagErrors = []
  pagPage.on('pageerror', (e) => pagErrors.push(String(e)))
  await pagPage.setContent(page$({ ...state, mode: 'chat', selectedKey: 'a', transcriptMore: true, transcript: pagRows }))
  await pagPage.waitForSelector('.transcript-scroll', { timeout: 5000 })
  const beforeWiden = await pagPage.evaluate(() => {
    const sc = document.querySelector('.transcript-scroll')
    sc.scrollTop = Math.floor(sc.scrollHeight / 2) // reading the middle
    const topEl = document.elementFromPoint(140, 140)
    return { scrollTop: sc.scrollTop, topText: topEl ? (topEl.textContent || '').slice(0, 20) : '' }
  })
  const widenedState = { ...state, mode: 'chat', selectedKey: 'a', transcriptMore: true, transcript: [...oldRows, ...pagRows] }
  await pagPage.evaluate((st) => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: st } }))
  }, widenedState)
  const afterWiden = await pagPage.evaluate(() => {
    const sc = document.querySelector('.transcript-scroll')
    const topEl = document.elementFromPoint(140, 140)
    return {
      scrollTop: sc.scrollTop,
      topText: topEl ? (topEl.textContent || '').slice(0, 20) : '',
      pill: !!document.querySelector('.load-earlier'),
    }
  })
  ok(pagErrors.length === 0, `the paginated chat renders without throwing (${pagErrors.join('; ') || 'clean'})`)
  ok(afterWiden.scrollTop > beforeWiden.scrollTop,
     `the offset grew by the prepended height (${beforeWiden.scrollTop}px -> ${afterWiden.scrollTop}px)`)
  ok(afterWiden.topText === beforeWiden.topText,
     `and the same paragraph is at the viewport top (was "${beforeWiden.topText}", now "${afterWiden.topText}")`)
  ok(afterWiden.pill, 'the load-earlier pill is drawn when more remains')
  const jumps = await pagPage.evaluate(() => {
    const j = document.querySelector('.jump-cluster')
    if (!j) return null
    const jb = j.getBoundingClientRect()
    const sb = document.querySelector('.transcript-scroll').getBoundingClientRect()
    return { inside: jb.right <= sb.right + 1 && jb.bottom <= sb.bottom + 1 }
  })
  ok(!!jumps && jumps.inside, 'the jump buttons sit inside the transcript area')
  await pagPage.close()

  /* --- the composer's input row, MEASURED: one height for its buttons --------
   *
   * Attach, mic and send sit in one row beside the textarea. Measured in real
   * Chromium they came out at 27, 29 and 33px — bottoms flush (flex-end),
   * tops ragged, and ragged reads as broken. The fix is one shared height;
   * this gate fails the moment the three drift apart again. The jump buttons
   * overlay the transcript, so their background is measured too: transparent
   * buttons over the last row's text are illegible.
   */
  const compPage = await browser.newPage({ viewport: { width: 900, height: 900 } })
  const compErrors = []
  compPage.on('pageerror', (e) => compErrors.push(String(e)))
  await compPage.setContent(page$({
    ...state, mode: 'chat', selectedKey: 'a',
    composer: { ...state.composer, voice: { available: true, mode: 'builtin', recording: false } },
    transcript: [
      { kind: 'prompt', at: 1, text: 'hi' },
      { kind: 'text', at: 2, text: 'hello' },
    ],
  }))
  await compPage.waitForSelector('.composer .send', { timeout: 5000 })
  const comp = await compPage.evaluate(() => {
    const h = (sel) => {
      const el = document.querySelector(sel)
      if (!el) return 0
      return Math.round(el.getBoundingClientRect().height)
    }
    const jb = document.querySelector('.jump-cluster button')
    const bg = jb ? getComputedStyle(jb).backgroundColor : ''
    const shadow = jb ? getComputedStyle(jb).boxShadow : ''
    return {
      attach: h('.composer .attach'), mic: h('.composer .mic'), send: h('.composer .send'),
      micDrawn: !!document.querySelector('.composer .mic'),
      jumpBg: bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && shadow !== 'none',
    }
  })
  ok(compErrors.length === 0, `the composer renders without throwing (${compErrors.join('; ') || 'clean'})`)
  ok(comp.micDrawn, 'the mic renders when the host gate answered')
  ok(comp.attach === comp.send && comp.mic === comp.send,
     `attach, mic and send are ONE height (${comp.attach}/${comp.mic}/${comp.send})`)
  ok(comp.jumpBg, 'the jump buttons carry a background and shadow — they overlay the text')
  await compPage.close()

} finally {
  await browser.close()
}

console.log(fails ? `\n${fails} FAILURES` : '\nPASS — the board fits inside itself')
process.exit(fails ? 1 : 0)
