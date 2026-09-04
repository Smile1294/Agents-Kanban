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
    spentUsd: 1234.56, spendPriced: false,
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
  const clamped = measured.find((m) => m.title.startsWith('✦xxxx'))
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

  /* --- a repaint must not move a scrolled column -------------------------------
     render() rebuilds the tree on every state message, and an agent at work sends
     one every few hundred milliseconds. The column body is the scroll container,
     so it was destroyed and recreated at scrollTop 0 each time: scroll down a
     busy column and the next frame threw you back to the top. Measured in a real
     browser because scrollTop only means anything once the box has a height. */
  const tall = {
    ...state,
    cards: Array.from({ length: 40 }, (_, i) => ({
      key: 't' + i, sessionId: 't' + i, title: 'Session number ' + i, phase: 'implementing', tags: [], updated: 1000 + i,
    })),
  }
  const scrolled = await browser.newPage({ viewport: { width: 1400, height: 600 } })
  await scrolled.setContent(page$(tall))
  await scrolled.waitForSelector('.card', { timeout: 5000 })
  const kept = await scrolled.evaluate((st) => {
    const body = [...document.querySelectorAll('.column')]
      .find((c) => c.querySelector('.column-head').textContent.includes('Implementing'))
      .querySelector('.cards')
    body.scrollTop = 150
    const set = body.scrollTop
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: st } }))
    const again = [...document.querySelectorAll('.column')]
      .find((c) => c.querySelector('.column-head').textContent.includes('Implementing'))
      .querySelector('.cards')
    return { set, rebuilt: again !== body, after: again.scrollTop }
  }, tall)
  ok(kept.set === 150, `the column body is tall enough to scroll (asked for 150, got ${kept.set})`)
  ok(kept.rebuilt, 'the state message rebuilt the column')
  ok(Math.abs(kept.after - 150) <= 1, `and the new column body is scrolled to where the old one was (${kept.after}px)`)
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

} finally {
  await browser.close()
}

console.log(fails ? `\n${fails} FAILURES` : '\nPASS — the board fits inside itself')
process.exit(fails ? 1 : 0)
