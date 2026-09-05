/* Is the .vsix we would actually install a working extension?
 *
 * The bundle deliberately does NOT contain the Agent SDK or zod — they are
 * externals, resolved from node_modules at runtime. That makes the packaging
 * step load-bearing: a .vsix built without its dependencies installs perfectly
 * and then fails on the first dynamic import, which reaches the user as a blank
 * board and nothing in the log. `vsce package --no-dependencies` produces
 * exactly that, and it is one flag away from the real command.
 *
 * Slow (it packages), so it is `npm run verify:package` rather than part of the
 * edit loop. Run it before installing.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { repoRoot } from './harness.mjs'

const exec = promisify(execFile)
let fails = 0
const ok = (cond, msg) => { console.log(cond ? '  ok:' : 'FAIL:', msg); if (!cond) fails++ }

const out = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ck-vsix-')), 'test.vsix')

// A worktree is a whole checkout of this repository, and it now lives INSIDE
// it. vsce packages everything not listed in .vscodeignore, so a developer who
// happens to have one live session open would otherwise ship the entire repo
// inside the .vsix — and find out from the download size, if at all. Seed one
// so the assertion below has something to catch.
// `.agentskanban/` is the ONE directory this extension owns inside the user's
// repository, and it is where LIVE AGENT WORKTREES live — whole checkouts, with
// their own uncommitted and untracked files. So the cleanup below removes only
// the probe this test created, and removes `.agentskanban` itself only if this
// test is what brought it into existence.
//
// It used to be `fs.rm(<repo>/.agentskanban, { recursive: true, force: true })`
// in the `finally`, which deleted every live worktree in the repository — on the
// command CLAUDE.md tells you to run before installing. Verified on this repo
// while the bug was live: two real worktrees, one holding modified CLAUDE.md,
// PLAN.md and DECISIONS.md plus an UNTRACKED docs/FEATURES.md, which no git
// object would have brought back.
const kanbanDir = path.join(repoRoot, '.agentskanban')
const ourDirectory = !(await fs.stat(kanbanDir).then(() => true, () => false))
// A name nothing else can collide with, so the cleanup cannot widen.
const worktreeProbe = path.join(kanbanDir, 'worktrees', `packaging-probe-${process.pid}`)
await fs.mkdir(worktreeProbe, { recursive: true })
await fs.writeFile(path.join(worktreeProbe, 'leaked.txt'), 'this must not ship\n')

console.log('— packaging (this is the slow part)')
try {
  await exec(process.execPath, [path.join(repoRoot, 'scripts', 'run-bin.mjs'), '@vscode/vsce', 'vsce', 'package', '--out', out],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
} finally {
  await fs.rm(worktreeProbe, { recursive: true, force: true })
  // Only if there was nothing here before. `rmdir` and not `rm -r`: it refuses
  // on a non-empty directory, which is the guard rather than a courtesy — if a
  // worktree appeared while we were packaging, this leaves it alone.
  if (ourDirectory) {
    await fs.rmdir(path.join(kanbanDir, 'worktrees')).catch(() => {})
    await fs.rmdir(kanbanDir).catch(() => {})
  }
}

const { stdout } = await exec('unzip', ['-l', out], { maxBuffer: 64 * 1024 * 1024 })
const entries = stdout.split('\n')
  .map((l) => l.trim().split(/\s+/).slice(3).join(' '))
  .filter((n) => n.startsWith('extension/'))
const has = (suffix) => entries.some((e) => e === 'extension/' + suffix)
const hasPrefix = (p) => entries.some((e) => e.startsWith('extension/' + p))

console.log('\n— what the user installs')
const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
ok(has(manifest.main.replace(/^\.\//, '')), `the bundle is in the package: ${manifest.main}`)
for (const f of ['media/board.js', 'media/board.css', 'media/board.svg', 'media/settings.js', 'media/settings.css']) {
  ok(has(f), `webview asset is in the package: ${f}`)
}

/* The board's MCP server, as its own program.
 *
 * A SECOND bundle, spawned by Codex as `node dist/board-mcp.js`. It is asserted
 * separately because its failure mode is the quietest one in the whole package:
 * an extension shipped without it installs perfectly, runs Claude sessions
 * perfectly, and leaves every Codex agent unable to move its own card — with
 * the reason in a log nobody reads. `**\/*.ts` and `**\/*.map` are ignored by
 * .vscodeignore, so this is exactly the sort of file a glob change would drop.
 */
ok(has('dist/board-mcp.js'), 'the board MCP server ships, or Codex agents cannot move their own cards')

// The listing's own assets. A missing icon does not fail the build — the
// Marketplace just shows a grey placeholder next to everyone else's artwork,
// and you find out after publishing.
ok(has(manifest.icon), `the Marketplace icon ships: ${manifest.icon}`)
// vsce renames both on the way in: README.md becomes readme.md and LICENSE
// becomes LICENSE.txt, so these are matched case-insensitively by stem.
const hasStem = (stem) => entries.some((e) => new RegExp(`^extension/${stem}(\\.[a-z]+)?$`, 'i').test(e))
ok(hasStem('readme'), 'the README ships — it IS the Marketplace listing page')
ok(hasStem('license'), 'the MIT licence ships')

// Development docs are for the repo, not for every user's disk.
for (const d of ['CLAUDE.md', 'PLAN.md', 'docs/DECISIONS.md', 'docs/NIMBALYST.md']) {
  ok(!has(d), `internal doc stays out of the package: ${d}`)
}

// Screenshots are pulled from GitHub by absolute URL, so shipping them again
// would only pad the download. See docs/PUBLISHING.md.
ok(!hasPrefix('docs/screenshots/'), 'screenshots stay out of the package')

// Agent worktrees live in the repository now. They are somebody's task branch,
// not part of the extension.
ok(!hasPrefix('.agentskanban/'), 'agent worktrees stay out of the package')

// The externals. These are the ones a packaging mistake silently drops.
ok(has('node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs'),
  'the Agent SDK ships — it is external, so the bundle cannot stand in for it')
ok(hasPrefix('node_modules/zod/'),
  'zod ships — it is the SDK peer dependency and must be the SAME instance')

// And the one that must NOT ship: ~190MB per platform, an 87MB .vsix.
ok(!hasPrefix('node_modules/@anthropic-ai/claude-agent-sdk-'),
  'the SDK native binary is excluded (resolveClaudeExecutable finds the CLI instead)')

const size = (await fs.stat(out)).size
ok(size < 20 * 1024 * 1024, `package is ${(size / 1024 / 1024).toFixed(1)}MB, under the 20MB ceiling`)
ok(size > 1024 * 1024, `package is ${(size / 1024 / 1024).toFixed(1)}MB, so dependencies were not dropped`)

await fs.rm(path.dirname(out), { recursive: true, force: true })
console.log(fails === 0 ? '\nPASS — the packaged extension carries what it needs' : `\n${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
