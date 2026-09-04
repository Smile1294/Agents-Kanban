/** Run a dependency's executable without relying on `node_modules/.bin`.
 *
 * npm puts `.bin` on PATH for scripts, and populates it with SYMLINKS. That
 * fails silently on any filesystem without symlink support — a Windows drive
 * mounted into WSL, a network share, some Docker volumes — and is skipped
 * outright by `npm install --no-bin-links`. The packages install correctly; only
 * the links are missing. `tsc: not found` is what that looks like, and
 * reinstalling does not fix it because nothing was broken.
 *
 * Node's own module resolution does not care about symlinks, so resolve the
 * package's declared `bin` entry and run it with the Node we are already in.
 *
 *   node scripts/run-bin.mjs typescript tsc --noEmit
 *   node scripts/run-bin.mjs @vscode/vsce vsce package
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [pkgName, binName, ...args] = process.argv.slice(2)

if (!pkgName || !binName) {
  console.error('usage: node scripts/run-bin.mjs <package> <bin> [args…]')
  process.exit(2)
}

const require_ = createRequire(path.join(root, 'package.json'))

let entry
try {
  const manifest = require_(`${pkgName}/package.json`)
  // `bin` is either a string (one executable, named after the package) or a map.
  const bin = typeof manifest.bin === 'string' ? { [manifest.name]: manifest.bin } : (manifest.bin ?? {})
  const rel = bin[binName]
  if (!rel) {
    console.error(`\n  ✗ ${pkgName} declares no "${binName}" executable (has: ${Object.keys(bin).join(', ') || 'none'}).\n`)
    process.exit(1)
  }
  entry = require_.resolve(`${pkgName}/${rel.replace(/^\.\//, '')}`)
} catch (e) {
  console.error(
    `\n  ✗ Could not find ${pkgName}. Dependencies are not installed correctly.\n` +
    `\n      npm install\n` +
    `\n    (${e instanceof Error ? e.message : String(e)})\n`,
  )
  process.exit(1)
}

const r = spawnSync(process.execPath, [entry, ...args], { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
