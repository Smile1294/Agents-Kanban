/** Run every test file, without depending on the shell.
 *
 * This was `for f in src/**‌/__tests__/*.test.ts; do …` in an npm script, which
 * assumes bash. npm runs scripts through `sh` — dash on most Linux — where `**`
 * is just `*`, so the pattern silently covered only two directory levels and
 * would quietly stop matching the moment a test moved. It also cannot work on
 * Windows at all.
 *
 * Walking the tree in Node is shorter, works everywhere, and can say what it
 * found — a suite that runs zero files should never look like a pass.
 */
import { readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function find(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      find(full, out)
    } else if (/\.test\.(ts|mjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = find(path.join(root, 'src')).sort()
if (!files.length) {
  console.error('\n  ✗ No test files found under src/. That is a broken checkout, not a pass.\n')
  process.exit(1)
}

let failed = 0
for (const file of files) {
  const rel = path.relative(root, file)
  console.log(`— ${rel}`)
  // .ts runs through type stripping; .mjs is already plain JavaScript.
  const args = file.endsWith('.ts')
    ? ['--experimental-strip-types', '--no-warnings', file]
    : [file]
  const r = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' })
  if (r.status !== 0) {
    failed++
    console.error(`  ✗ ${rel} exited ${r.status ?? `on ${r.signal}`}`)
    break   // stop at the first failure, as the shell loop did
  }
}

console.log(
  failed
    ? `\n${failed} test file(s) failed`
    : `\n${files.length} test files passed`,
)
process.exit(failed ? 1 : 0)
