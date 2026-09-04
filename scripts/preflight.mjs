/** Is this checkout actually able to run anything?
 *
 * `tsc: not found`, `Cannot find module 'esbuild'`, `Cannot find name 'process'`
 * — every one of these means the same thing, none of them says so, and which one
 * you get depends on whether you happen to have a global TypeScript. On a fresh
 * clone the very first thing anyone does is press F5, and it failed with a
 * message that named neither the cause nor the fix.
 *
 * So: check, say plainly what is wrong, and for the one case that is obviously
 * just "you have not installed yet", do the install.
 *
 * Pure Node, no dependencies — it has to run when nothing is installed.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

/** Node 22.6 is where `--experimental-strip-types` landed, and every test runs
 *  through it. On anything older the suite fails with a parse error that looks
 *  like broken code rather than a missing feature. */
const MIN_NODE = [22, 6, 0]

function die(title, ...lines) {
  console.error(`\n  ✗ ${title}\n`)
  for (const l of lines) console.error(`    ${l}`)
  console.error('')
  process.exit(1)
}

// --- Node itself -------------------------------------------------------------
const current = process.versions.node.split('.').map(Number)
const older = (a, b) => a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]
if (older(current, MIN_NODE)) {
  die(
    `Node ${process.versions.node} is too old — this project needs ${MIN_NODE.join('.')} or newer.`,
    'The tests run TypeScript directly through `node --experimental-strip-types`,',
    `which arrived in Node ${MIN_NODE.slice(0, 2).join('.')}. On older Node they fail with a`,
    'syntax error that looks like broken code rather than a missing feature.',
    '',
    '  nvm install 22   (or https://nodejs.org)',
  )
}

// --- dependencies ------------------------------------------------------------
const modules = path.join(root, 'node_modules')

if (!existsSync(modules)) {
  // The first-run case. Nothing to diagnose — just do it, loudly.
  console.log('\n  Dependencies are not installed yet. Running `npm install`…\n')
  const r = spawnSync('npm', ['install'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    die(
      '`npm install` failed.',
      'Run it yourself to see the full output:',
      '',
      '  npm install',
    )
  }
  console.log('')
}

/** Everything a script here actually reaches for, and why. */
const REQUIRED = [
  ['typescript', 'npm run typecheck'],
  ['esbuild', 'npm run build'],
  ['@types/node', 'the typecheck (without it every `process` and `console` is an error)'],
  ['@anthropic-ai/claude-agent-sdk', 'running agents at all — it is an external, not bundled'],
  ['zod', 'the SDK’s tool schemas; it must be the SAME instance the SDK resolves'],
]

const missing = REQUIRED.filter(([name]) => !existsSync(path.join(modules, ...name.split('/'))))
if (missing.length) {
  die(
    `node_modules is present but incomplete — ${missing.length} package(s) missing.`,
    ...missing.map(([name, why]) => `${name.padEnd(34)} needed for ${why}`),
    '',
    'Usually this means the install was interrupted, or was run with',
    '--omit=dev / --production. This project needs its dev dependencies:',
    '',
    '  npm install',
  )
}

// The executables the scripts run. Checked by RESOLUTION, not by looking in
// node_modules/.bin — npm fills that with symlinks, which are simply absent on a
// filesystem that has no symlinks (a Windows drive under WSL, a network share,
// some Docker mounts) or after `npm install --no-bin-links`. Nothing is broken
// in that case, so demanding they exist reported a healthy install as corrupt
// and told the user to reinstall something that would come back identical.
// scripts/run-bin.mjs runs them through Node's resolver for the same reason.
const require_ = createRequire(path.join(root, 'package.json'))
const ENTRIES = [
  ['typescript', 'bin/tsc', 'npm run typecheck'],
  ['@vscode/vsce', 'vsce', 'npm run package'],
]
const unresolvable = ENTRIES.filter(([pkg, rel]) => {
  try { require_.resolve(`${pkg}/${rel}`); return false } catch { return true }
})
if (unresolvable.length) {
  die(
    `${unresolvable.length} dependency executable(s) cannot be resolved.`,
    ...unresolvable.map(([pkg, rel, why]) => `${`${pkg}/${rel}`.padEnd(34)} needed for ${why}`),
    '',
    'The package directories exist but their contents do not, so the install',
    'was interrupted. Reinstall from scratch:',
    '',
    '  rm -rf node_modules && npm install',
  )
}

if (process.argv.includes('--verbose')) {
  console.log(`  ✓ Node ${process.versions.node}, ${REQUIRED.length} required packages, ${pkg.name}@${pkg.version}`)
}
