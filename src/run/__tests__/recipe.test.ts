/* How the Run button decides what to start, against REAL directories and a
   REAL listening socket. The detection is the whole feature — a recipe that
   picks the wrong launcher starts a server on the main checkout's database, and
   a recipe that returns a plausible-but-wrong port opens a page showing the old
   code, which reads as "the change did nothing". */
import { promises as fs } from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  detect, findWt, freeTcpPort, isListening, readWtRegistry, waitForPort, wtSlug,
} from '../recipe.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-run-'))
const home = path.join(tmp, 'home')
await fs.mkdir(path.join(home, '.local', 'bin'), { recursive: true })
await fs.mkdir(path.join(home, '.wt'), { recursive: true })
// A stand-in for the user's own launcher. Only its existence is detected.
const wtPath = path.join(home, '.local', 'bin', 'wt')
await fs.writeFile(wtPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 })

const mkWorktree = async (name: string, files: Record<string, string>) => {
  const dir = path.join(tmp, name)
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel)
    await fs.mkdir(path.dirname(full), { recursive: true })
    await fs.writeFile(full, body)
  }
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// 1. The slug must match the launcher's own, or a provisioned worktree reads as
// unprovisioned and the button offers to provision it a second time.
ok(wtSlug('/x/S1mtmsjdd3-okay-we-are-on-branch-feature-pb-295-sso') ===
   's1mtmsjdd3_okay_we_are_on_branch_feature',
   `slug lowercases, replaces punctuation and TRUNCATES at 40: ${wtSlug('/x/S1mtmsjdd3-okay-we-are-on-branch-feature-pb-295-sso')}`)
ok(wtSlug('/x/Simple') === 'simple', 'a plain name is just lowercased')
ok(wtSlug('/x/a.b-c_d') === 'a_b_c_d', 'dots, dashes and underscores all become underscores')

// ---------------------------------------------------------------------------
// 2. A provisioned Laravel worktree: the port comes from the registry, exactly.
const provisioned = await mkWorktree('S1-provisioned', { artisan: '#!/usr/bin/env php\n' })
await fs.writeFile(
  path.join(home, '.wt', wtSlug(provisioned)),
  `SLUG=${wtSlug(provisioned)}\nDIR=${provisioned}\nAPP_PORT=8007\nVITE_PORT=5187\nDB=pim\nMODE=shared\n`,
)
const reg = await readWtRegistry(provisioned, home)
ok(reg?.APP_PORT === '8007', `the registry is read back (APP_PORT=${reg?.APP_PORT})`)

const r1 = await detect({ worktree: provisioned, home, pathEnv: '' })
ok(!!r1, 'a provisioned worktree gets a recipe')
ok(r1?.steps.length === 1 && /wt.* serve$/.test(r1.steps[0]!.command),
   `and it is the project's own launcher: ${r1?.steps[0]?.command}`)
ok(r1?.port === 8007, `with the port the launcher assigned, not a guess (${r1?.port})`)
ok(r1?.url === 'http://localhost:8007', `and the URL that follows from it: ${r1?.url}`)
ok(!/provision/.test(r1?.steps[0]?.command ?? ''), 'and it does NOT re-provision what is already provisioned')

// ---------------------------------------------------------------------------
// 3. An UNPROVISIONED worktree provisions first.
//
// This is the exact wall the user hit: `wt serve` alone answers "not
// provisioned yet — run: wt provision", which reads as a broken tool rather
// than a missing step.
const fresh = await mkWorktree('S2-fresh', { artisan: '#!/usr/bin/env php\n' })
const r2 = await detect({ worktree: fresh, home, pathEnv: '' })
ok(/provision/.test(r2?.steps[0]?.command ?? ''),
   `an unprovisioned worktree provisions first: ${r2?.steps[0]?.command}`)
ok(/&&/.test(r2?.steps[0]?.command ?? ''),
   'chained with && so a failed provision cannot leave a server on the wrong database')
ok(r2?.port === undefined,
   'and claims NO port — the launcher picks it, and a guess here would open the wrong app')

// ---------------------------------------------------------------------------
// 4. The main checkout is not a worktree, and the launcher refuses it.
//
// Reported verbatim: running it in the main checkout printed "not provisioned
// yet" and the user could not tell whether the tool or the change was broken.
// Offering `wt` there would reproduce that inside the button.
const mainCheckout = await mkWorktree('pim-main', { artisan: '#!/usr/bin/env php\n' })
const r3 = await detect({ worktree: mainCheckout, repoRoot: mainCheckout, home, pathEnv: '' })
ok(!/wt/.test(r3?.steps.map((s) => s.command).join(' ') ?? ''),
   `the main checkout is never handed to the per-worktree launcher: ${r3?.steps[0]?.command}`)
ok(/artisan serve/.test(r3?.steps.find((s) => s.serves)?.command ?? ''),
   'it falls through to a plain server instead')

// ---------------------------------------------------------------------------
// 5. Laravel with no launcher on the machine: the port must be CHOSEN, because
// the main checkout is usually already holding 8000.
const laravel = await mkWorktree('S3-laravel', {
  artisan: '#!/usr/bin/env php\n',
  'package.json': JSON.stringify({ scripts: { dev: 'vite' } }),
})
// A home with no launcher in it — otherwise the branch above wins and this
// tests nothing, which is how this assertion first went green-then-red.
const bareHome = path.join(tmp, 'no-launcher-home')
await fs.mkdir(bareHome, { recursive: true })
const asked: number[] = []
const r4 = await detect({
  worktree: laravel, home: bareHome, pathEnv: '',
  freePort: async (from) => { asked.push(from); return 8042 },
})
ok(asked[0] === 8000, `a free port is looked for from 8000 up (asked from ${asked[0]})`)
ok(r4?.port === 8042 && /--port=8042/.test(r4.steps.find((s) => s.serves)?.command ?? ''),
   `and the server is TOLD that port rather than left to pick: ${r4?.steps.find((s) => s.serves)?.command}`)
ok(r4?.steps.length === 2, `the asset watcher is started too (${r4?.steps.length} steps)`)
ok(r4?.steps.filter((s) => s.serves).length === 1,
   'but only one step is the one to wait on — a watcher never answers on the app port')
ok(r4?.steps[0]?.command === 'npm run dev' && r4?.steps[1]?.serves === true,
   'and the watcher goes first, so the server comes up against built assets')

// A Laravel project with no `dev` script gets one step, not an npm command that
// does not exist.
const bare = await mkWorktree('S4-bare-laravel', { artisan: '#!/usr/bin/env php\n' })
const r5 = await detect({ worktree: bare, home: bareHome, pathEnv: '', freePort: async () => 8001 })
ok(r5?.steps.length === 1, 'no dev script means no npm step')

// ---------------------------------------------------------------------------
// 6. A plain Node project. The port is whatever the tool picks, so none is
// claimed — the caller probes.
const node = await mkWorktree('S5-node', {
  'package.json': JSON.stringify({ scripts: { build: 'tsc', dev: 'next dev' } }),
})
const r6 = await detect({ worktree: node, home, pathEnv: '' })
ok(r6?.steps[0]?.command === 'npm run dev', `a Node project runs its dev script: ${r6?.steps[0]?.command}`)
ok(r6?.port === undefined, 'and claims no port')

// `start` is used when there is no `dev`, and a script that is not there is
// never invented.
const startOnly = await mkWorktree('S6-start', {
  'package.json': JSON.stringify({ scripts: { start: 'node server.js' } }),
})
ok((await detect({ worktree: startOnly, home, pathEnv: '' }))?.steps[0]?.command === 'npm run start',
   'falls back to the start script')
const noScripts = await mkWorktree('S7-empty', { 'package.json': JSON.stringify({ name: 'x' }) })
ok((await detect({ worktree: noScripts, home, pathEnv: '' })) === undefined,
   'a project with nothing to run gets no recipe, rather than a made-up command')
const malformed = await mkWorktree('S8-broken', { 'package.json': '{ not json' })
ok((await detect({ worktree: malformed, home, pathEnv: '' })) === undefined,
   'and a broken package.json is not a crash')

// ---------------------------------------------------------------------------
// 7. The user's own setting wins over everything, and is reported as theirs so
// a failure is not blamed on detection.
const configured = await detect({
  worktree: provisioned, home, pathEnv: '',
  configuredCommand: 'make serve DIR=${worktree}',
  configuredUrl: 'http://localhost:9123/app',
})
ok(configured?.steps[0]?.command === `make serve DIR=${provisioned}`,
   `the setting is used verbatim, with \${worktree} filled in: ${configured?.steps[0]?.command}`)
ok(configured?.port === 9123, `and the port is taken from the configured URL (${configured?.port})`)
ok(configured?.url === 'http://localhost:9123/app', 'which is opened exactly as written, path and all')
ok(configured?.configured === true, 'and it is marked as the user\'s own, not a detection')
const noUrl = await detect({ worktree: provisioned, home, pathEnv: '', configuredCommand: 'make serve' })
ok(noUrl?.port === undefined && noUrl?.url === undefined,
   'a configured command with no URL claims neither — nothing is inferred from it')

// ---------------------------------------------------------------------------
// 8. Finding the launcher. `~/.local/bin` is checked as well as PATH, because
// a VS Code started from the desktop does not inherit a login shell's PATH —
// the same trap this project already has a postmortem about for Node.
ok((await findWt(home, '')) === wtPath, 'the launcher is found in ~/.local/bin with an empty PATH')
const onPath = path.join(tmp, 'bin')
await fs.mkdir(onPath, { recursive: true })
await fs.writeFile(path.join(onPath, 'wt'), '#!/bin/sh\n', { mode: 0o755 })
ok((await findWt(path.join(tmp, 'nohome'), onPath)) === path.join(onPath, 'wt'),
   'and on PATH when it is not in ~/.local/bin')
ok((await findWt(path.join(tmp, 'nohome'), '')) === undefined, 'and is absent when it is absent')

// ---------------------------------------------------------------------------
// 9. Waiting for the port, against a REAL socket. This is the half that decides
// whether the browser opens onto a working page or a connection error.
const port = await freeTcpPort(45_000)
ok(port >= 45_000, `a free port is found (${port})`)
ok((await isListening(port, '127.0.0.1', 200)) === false, 'nothing is listening on it yet')

const server = net.createServer(() => {})
await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()))
ok((await isListening(port, '127.0.0.1', 500)) === true, 'and it is seen the moment something listens')
ok((await waitForPort(port, { timeoutMs: 2000, intervalMs: 50 })) === true, 'waitForPort returns as soon as it answers')
await new Promise<void>((r) => server.close(() => r()))

// A port nothing ever binds must time out rather than hang the button forever.
// A real sleep, deliberately. An injected one that returns immediately makes
// the deadline meaningless — the loop spins as fast as the event loop allows
// and the assertion passes for the wrong reason.
const slept: number[] = []
const timedOut = await waitForPort(port, {
  timeoutMs: 250, intervalMs: 80,
  sleep: async (ms) => { slept.push(ms); await new Promise<void>((r) => setTimeout(r, ms)) },
  probe: async () => false,
})
ok(timedOut === false, 'a port that never answers times out')
ok(slept.length > 0 && slept.length < 10 && slept.every((m) => m === 80),
   `waiting between probes rather than spinning (${slept.length} probes of ${slept[0]}ms)`)

// Cancel must be able to interrupt a multi-minute wait: `wt provision` can
// spend minutes cloning a database, and a wait nobody can stop has to be killed.
let probes = 0
const cancelled = await waitForPort(port, {
  timeoutMs: 60_000, intervalMs: 1,
  probe: async () => { probes++; return false },
  shouldStop: () => probes >= 3,
})
ok(cancelled === false && probes === 3, `a cancel stops the wait (${probes} probes)`)

// A recipe with no port is not waited on at all — that is the caller's cue to
// probe the conventional ports instead of blocking on a number it invented.
ok(r6?.port === undefined && r6?.url === undefined, 'a portless recipe offers nothing to wait on')

await fs.rm(tmp, { recursive: true, force: true })
console.log(fails ? `\n${fails} FAILURES` : '\nPASS — the Run button knows what to start and where it will answer')
process.exit(fails ? 1 : 0)
