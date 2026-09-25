/* The app an agent starts for itself, against REAL child processes and REAL
   sockets. The two ways this goes wrong are both silent: a port found by
   scanning belongs to another worktree (the screenshot shows old code and looks
   fine), and a server whose shell was killed keeps the port forever. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AppProcesses, announcedUrl } from '../app.ts'
import { isListening } from '../recipe.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// ---------------------------------------------------------------------------
// 1. The URL a dev server prints, in the spellings real ones use.
ok(announcedUrl('  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m')?.port === 5173,
  'Vite\'s banner, with the port painted in its own colour, is read')
ok(announcedUrl('   - Local:        http://localhost:3000')?.url === 'http://localhost:3000', 'Next\'s banner is read')
ok(announcedUrl('   INFO  Server running on [http://127.0.0.1:8000].')?.port === 8000, 'artisan\'s bracketed URL is read')
ok(announcedUrl('listening on http://0.0.0.0:4000')?.url === 'http://localhost:4000', '0.0.0.0 becomes somewhere a browser can go')
ok(announcedUrl('  ➜  Network: http://192.168.1.4:5173/') === undefined, 'a LAN address is not taken for the app')
ok(announcedUrl('see https://vitejs.dev/config for more') === undefined, 'an external URL in a log is not the app')

// ---------------------------------------------------------------------------
// 2. A server that honours PORT: started, the chosen port answers, the log is
// kept, and stop takes it down so the port is free again.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-app-'))
await fs.writeFile(path.join(tmp, 'serve.mjs'), `
import http from 'node:http'
const port = Number(process.env.PORT || process.argv[2])
http.createServer((q, s) => s.end('hi')).listen(port, '127.0.0.1', () => console.log('ready on http://localhost:' + port))
console.error('a warning on stderr')
`)
// One that ignores PORT entirely, as Vite does, and prints the port it took.
await fs.writeFile(path.join(tmp, 'stubborn.mjs'), `
import http from 'node:http'
const port = Number(process.argv[2])
http.createServer((q, s) => s.end('hi')).listen(port, '127.0.0.1', () => console.log('  Local:   http://localhost:' + port + '/'))
`)
const node = JSON.stringify(process.execPath)
const apps = new AppProcesses()
const st = await apps.start('card-1', tmp, {
  steps: [{ name: 'serve', command: `${node} serve.mjs`, serves: true }],
  why: 'test',
}, { timeoutMs: 15_000 })
ok(st.state === 'running', `a server that honours PORT comes up (${st.state} ${st.detail ?? ''})`)
ok(!!st.port && st.port >= 3100, `on a port chosen here, not a conventional one (${st.port})`)
ok(st.url === `http://localhost:${st.port}`, 'the URL is the one it announced')
await new Promise((r) => setTimeout(r, 200))
const logs = apps.logs('card-1').join('\n')
ok(/ready on http:\/\/localhost/.test(logs), 'stdout is kept for the agent to read')
ok(/! a warning on stderr/.test(logs), 'stderr is kept too, marked')
const again = await apps.start('card-1', tmp, { steps: [{ name: 'x', command: 'exit 1', serves: true }], why: 'second' })
ok(again.port === st.port && again.why === 'test', 'a second start for the same card returns the running app, not another one')
ok(await apps.stop('card-1'), 'stop reports that there was something to stop')
ok(!(await isListening(st.port!)), 'and the port is free afterwards — the whole group died, not just the shell')

// ---------------------------------------------------------------------------
// 3. A server that ignores PORT and prints the port it took: that one is used.
const fixed = 3900 + Math.floor(Math.random() * 90)
const st2 = await apps.start('card-2', tmp, {
  steps: [{ name: 'serve', command: `${node} stubborn.mjs ${fixed}`, serves: true }],
  why: 'test',
}, { timeoutMs: 15_000 })
ok(st2.state === 'running' && st2.port === fixed, `a server that ignores PORT is found by what it printed (${st2.port} vs ${fixed})`)
await apps.stop('card-2')

// ---------------------------------------------------------------------------
// 4. A server that dies on boot is an ANSWER, with the reason in the log.
const st3 = await apps.start('card-3', tmp, {
  steps: [{ name: 'boom', command: `${node} -e "console.error('Error: Cannot find module x'); process.exit(3)"`, serves: true }],
  why: 'test',
}, { timeoutMs: 10_000 })
ok(st3.state === 'failed' && /code 3/.test(st3.detail ?? ''), `a crash on boot is reported as failed with its exit code (${st3.detail})`)
ok(apps.logs('card-3').some((l) => /Cannot find module x/.test(l)), 'and the stack trace is in the logs')

// 5. A configured command with no URL names the fix rather than guessing a port.
const st4 = await apps.start('card-4', tmp, {
  steps: [{ name: 'quiet', command: `${node} -e "setTimeout(()=>{}, 5000)"`, serves: true }],
  why: 'agentsKanban.runCommand', configured: true,
}, { timeoutMs: 1500 })
ok(st4.state === 'failed' && /runUrl/.test(st4.detail ?? ''), `a server that never says where it is names the setting (${st4.detail})`)
await apps.stopAll()
ok(apps.keys().length === 0, 'stopAll leaves nothing behind')

await fs.rm(tmp, { recursive: true, force: true })
if (fails) { console.log(`${fails} failure(s)`); process.exit(1) }
