/** Package the extension and install it into VS Code.
 *
 * The previous version hardcoded
 * `/Applications/Visual Studio Code.app/.../bin/code`, so it worked on exactly
 * one operating system and failed with a confusing "not found" everywhere else.
 * VS Code ships a `code` launcher on every platform; find it, and say clearly
 * how to get it when it is absent.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...opts })

/** VS Code's CLI, wherever this platform keeps it. `code-insiders` counts. */
function findCode() {
  const fromEnv = process.env.VSCODE_CLI
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  for (const name of ['code', 'code-insiders']) {
    const probe = spawnSync(name, ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' })
    if (probe.status === 0) return name
  }

  const home = os.homedir()
  const candidates = {
    darwin: [
      '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
      path.join(home, 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code',
    ],
    linux: [
      '/usr/bin/code', '/usr/share/code/bin/code', '/snap/bin/code',
      '/usr/bin/code-insiders', path.join(home, '.local/bin/code'),
    ],
    win32: [
      path.join(process.env.LOCALAPPDATA ?? '', 'Programs/Microsoft VS Code/bin/code.cmd'),
      'C:/Program Files/Microsoft VS Code/bin/code.cmd',
    ],
  }[process.platform] ?? []

  return candidates.find((p) => existsSync(p))
}

console.log('Building…')
if (run('npm', ['run', 'build']).status !== 0) process.exit(1)

console.log('\nPackaging…')
if (run(process.execPath, [path.join(root, 'scripts', 'run-bin.mjs'), '@vscode/vsce', 'vsce', 'package']).status !== 0) process.exit(1)

const { version, name } = JSON.parse(
  await import('node:fs').then((fs) => fs.promises.readFile(path.join(root, 'package.json'), 'utf8')),
)
const vsix = path.join(root, `${name}-${version}.vsix`)
if (!existsSync(vsix)) {
  console.error(`\n  ✗ Expected ${path.basename(vsix)} but it was not produced.\n`)
  process.exit(1)
}

const code = findCode()
if (!code) {
  console.error(
    `\n  ✗ Could not find VS Code's command line launcher.\n` +
    `\n    The package is built and waiting at:\n      ${vsix}\n` +
    `\n    Install it by hand with:\n      code --install-extension "${vsix}" --force\n` +
    `\n    If \`code\` is not on your PATH, open VS Code and run\n` +
    `    "Shell Command: Install 'code' command in PATH" from the command palette,\n` +
    `    or point this script at it:  VSCODE_CLI=/path/to/code npm run install-local\n`,
  )
  process.exit(1)
}

console.log(`\nInstalling into ${code}…`)
if (run(code, ['--install-extension', vsix, '--force']).status !== 0) process.exit(1)
console.log('\n  ✓ Installed. Reload the VS Code window to pick it up (Developer: Reload Window).\n')
