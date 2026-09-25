/* One run's app and browser tools, bound: the recipe the HOST chose starts in
   the agent's worktree, the browser opens what it started, and nothing is
   thrown at the agent — every failure is text it can act on. Real child
   processes; the browser is a recording stand-in (browser.test.ts drives the
   real one). */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AppProcesses } from '../../run/app.ts'
import { bindHarness, harnessBrief, MAX_APPS } from '../harness.ts'
import type { BrowserPool } from '../browser.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }
type Out = { content: Array<{ type: string; text?: string }>; isError?: boolean }
const text = (r: Out) => r.content.map((c) => c.text ?? '').join('\n')

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-harness-'))
await fs.writeFile(path.join(tmp, 'serve.mjs'),
  "import http from 'node:http'; const p = Number(process.env.PORT); http.createServer((q, s) => s.end('ok')).listen(p, '127.0.0.1', () => console.log('Local: http://localhost:' + p))\n")

const opened: string[] = []
const browser = {
  open: async (key: string, url: string) => { opened.push(`${key} ${url}`); return `Opened ${url}` },
  close: async () => true,
  snapshot: async () => { throw new Error('No page is open for this card. Use browser_open first.') },
  act: async () => 'Done',
  screenshot: async () => ({ data: 'AA', mimeType: 'image/jpeg', saved: '/shots/shot-001.jpg', where: 'x', news: '' }),
  errorsOnPage: () => 2,
  url: () => 'http://localhost:3100/',
} as unknown as BrowserPool

const apps = new AppProcesses()
let recipeFor = ''
const h = bindHarness({
  apps, browser,
  recipe: async (dir) => { recipeFor = dir; return { steps: [{ name: 'serve', command: `${JSON.stringify(process.execPath)} serve.mjs`, serves: true }], why: 'package.json — npm run dev' } },
  startTimeoutMs: 15_000,
}, () => tmp, 'run-1')

try {
  const noApp = await h.open() as Out
  ok(noApp.isError === true && /app_start first/.test(text(noApp)), 'browser_open with nothing running and no url names the fix')

  const started = await h.appStart() as Out
  ok(!started.isError && /running at http:\/\/localhost:\d+/.test(text(started)), `app_start comes up and says where (${text(started).split('\n')[0]})`)
  ok(recipeFor === tmp, 'the recipe is asked for the AGENT\'s worktree')
  ok(/npm run dev/.test(text(started)), 'and says what it started, from the recipe')

  const again = await h.appStart() as Out
  ok(/already started/.test(text(again)), 'a second app_start does not start a second server')

  await h.open()
  ok(opened.length === 1 && /^run-1 http:\/\/localhost:\d+$/.test(opened[0]!), `browser_open with no url opens the running app, keyed by RUN (${opened[0]})`)

  ok(h.ledger()?.pages === 1, 'the ledger counts the page it opened')
  await h.act({ action: 'click', target: '#add' })
  await h.screenshot({})
  const led = h.ledger()
  ok(led?.actions === 1 && led?.screenshots[0] === '/shots/shot-001.jpg' && led?.consoleErrors === 2 && led?.url === 'http://localhost:3100/',
     `and the action, the screenshot and the errors on the page it left (${JSON.stringify(led)})`)

  const logs = h.appLogs(20) as Out
  ok(/Local: http:\/\/localhost/.test(text(logs)), 'app_logs shows the server\'s own output')

  const thrown = await h.snapshot() as Out
  ok(thrown.isError === true && /browser_open first/.test(text(thrown)), 'a throw inside the browser comes back as a tool error, not an exception')

  const stopped = await h.appStop() as Out
  ok(/Stopped/.test(text(stopped)) && apps.keys().length === 0, 'app_stop stops it')

  const none = bindHarness({ apps, browser, recipe: async () => undefined }, () => tmp, 'run-2')
  const refused = await none.appStart() as Out
  ok(refused.isError === true && /runCommand/.test(text(refused)) && /Bash/.test(text(refused)),
    'no recipe is an answer naming the setting and the way round it — never a guessed command')

  ok(none.ledger() === undefined, 'a run that opened nothing has no record — not a record of zero')
  const noTree = bindHarness({ apps, browser, recipe: async () => undefined }, () => undefined, 'run-3')
  ok(/no worktree/.test(text(await noTree.appStart() as Out)), 'a run without a worktree says so')

  ok(MAX_APPS >= 2, 'more than one agent app may be up at once')
  ok(harnessBrief().join(' ').includes('app_start') && harnessBrief().join(' ').includes('howToTest'),
    'the brief names the tools and where the evidence goes')
} finally {
  await apps.stopAll()
  await fs.rm(tmp, { recursive: true, force: true })
}
if (fails) { console.log(`${fails} failure(s)`); process.exit(1) }
