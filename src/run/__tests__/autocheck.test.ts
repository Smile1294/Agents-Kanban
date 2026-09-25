/* The board's own check at review time, against REAL child processes, a REAL
   Chromium and a project's own e2e script. What it guards: a check that
   passes a page which throws on load, an e2e failure that reads as a pass, and
   a check that runs (and costs a browser) when nothing a browser shows changed.
   Needs a Chromium, like browser.test.ts; FAILS without one. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AppProcesses } from '../app.ts'
import { BrowserPool, findBrowser } from '../../agent/browser.ts'
import { autoCheckPrompt, e2eScript, runAutoCheck, uiFilesIn } from '../autocheck.ts'
import { parseAutoCheck } from '../../sessions/meta.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

ok(uiFilesIn(['src/App.tsx', 'README.md', 'server/db.ts', 'resources/views/home.blade.php', 'src/components/Nav.ts', 'styles/a.css'])
  .join(',') === 'src/App.tsx,resources/views/home.blade.php,src/components/Nav.ts,styles/a.css', 'UI files are told from the rest')

if (!(await findBrowser())) { console.log('FAIL: no Chromium to check with'); process.exit(1) }

const node = JSON.stringify(process.execPath)
async function project(page: string, e2eBody?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-autocheck-'))
  await fs.writeFile(path.join(dir, 'server.mjs'), `import http from 'node:http'; import fs from 'node:fs'
const port = Number(process.env.PORT)
http.createServer((q, s) => { s.setHeader('content-type', 'text/html'); s.end(fs.readFileSync('index.html')) }).listen(port, '127.0.0.1', () => console.log('Local: http://localhost:' + port))\n`)
  await fs.writeFile(path.join(dir, 'index.html'), page)
  const scripts: Record<string, string> = { dev: `${node} server.mjs` }
  if (e2eBody) {
    await fs.writeFile(path.join(dir, 'e2e.mjs'), e2eBody)
    scripts['test:e2e'] = `${node} e2e.mjs`
  }
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'p', scripts }))
  return dir
}
const recipe = async () => ({ steps: [{ name: 'dev', command: `${node} server.mjs`, serves: true }], why: 'test' })
const apps = new AppProcesses()
const browser = new BrowserPool({ shotsDir: await fs.mkdtemp(path.join(os.tmpdir(), 'ak-ac-shots-')) })
const deps = { apps, browser, recipe, startTimeoutMs: 15_000, e2eTimeoutMs: 30_000 }

try {
  // A good page, and an e2e suite that checks it against BASE_URL.
  const good = await project('<!doctype html><title>OK</title><h1>Hello</h1>',
    "const r = await fetch(process.env.BASE_URL); const t = await r.text(); if (!t.includes('Hello')) { console.log('missing Hello'); process.exit(1) } console.log('1 passed')\n")
  ok((await e2eScript(good)) === 'test:e2e', 'the project\'s own e2e script is found')
  const pass = await runAutoCheck(deps, 'card-good', good, ['index.html'])
  ok(pass.ok && pass.pageErrors === 0 && !!pass.url && !!pass.screenshot, `a clean page passes, with its URL and a screenshot (${JSON.stringify({ ok: pass.ok, e: pass.pageErrors })})`)
  ok(pass.e2e?.ok === true && pass.e2e.tail.includes('1 passed'), 'and the e2e suite ran against the app the board started (BASE_URL)')
  ok(!browser.has('autocheck:card-good'), 'the check closes its own page')

  // A page that throws while loading, and a suite that fails.
  const bad = await project("<!doctype html><title>Bad</title><script>undefinedCall()</script>",
    "console.log('Expected: Hello'); console.log('1 failed'); process.exit(1)\n")
  const fail = await runAutoCheck(deps, 'card-bad', bad, ['src/App.tsx'])
  ok(!fail.ok && (fail.pageErrors ?? 0) >= 1 && (fail.errorLines ?? []).some((l) => /undefinedCall/.test(l)),
     'a page that throws on load FAILS, with the error named')
  ok(fail.e2e?.ok === false && fail.e2e.tail.includes('1 failed'), 'a failing suite fails, with its output kept')
  const prompt = autoCheckPrompt(fail)
  ok(/undefinedCall/.test(prompt) && /npm run test:e2e` failed/.test(prompt) && /move back to "validating"/.test(prompt),
     'the message for the agent carries both failures and how to hand back')
  ok(JSON.stringify(parseAutoCheck(JSON.parse(JSON.stringify(fail)))) === JSON.stringify(fail), 'the result survives a store round trip unchanged')

  // Nothing a browser shows, and no suite: nothing is started.
  const none = await project('<h1>x</h1>')
  const skip = await runAutoCheck(deps, 'card-none', none, ['server/db.ts', 'README.md'])
  ok(skip.ok && /no UI files changed/.test(skip.skipped ?? '') && !apps.status(none), 'no UI change and no suite: skipped, and no app was started')

  // UI changed but the board cannot start the app: said, not passed silently.
  const unknown = await runAutoCheck({ ...deps, recipe: async () => undefined }, 'card-u', none, ['index.html'])
  ok(/cannot tell how to start/.test(unknown.skipped ?? ''), 'a UI change with no way to start the app says so')

  // An app that dies on boot is a failure, with its log.
  const dies = await runAutoCheck({ ...deps, recipe: async () => ({ steps: [{ name: 'x', command: `${node} -e "console.error('Error: EADDRINUSE'); process.exit(1)"`, serves: true }], why: 't' }) },
    'card-d', await project('<h1>x</h1>'), ['index.html'])
  ok(!dies.ok && /EADDRINUSE/.test(dies.appError ?? ''), 'an app that dies on boot fails the check, with its output')
} finally {
  await apps.stopAll()
  await browser.shutdown()
}
if (fails) { console.log(`${fails} failure(s)`); process.exit(1) }
console.log('PASS — the board checks the work itself at review time')
