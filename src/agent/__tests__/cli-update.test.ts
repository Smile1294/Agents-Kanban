/* Keeping Claude Code current — against a stand-in `claude` on disk.
 *
 * The model list is only as new as the CLI that answers it, and this extension
 * disables the CLI's own updater on every process it spawns. So the update
 * button is the one path by which a board-only machine ever gets new models,
 * and the failure it must not have is claiming an update that did not happen.
 *
 * The stand-in is a real executable spawned for real, because the traps are in
 * the process boundary: the environment it is handed, the exit code it returns,
 * and whether its stdin is a pipe it can wait on forever. It behaves like the
 * real CLI where that matters — most of all that `DISABLE_UPDATES` makes
 * `update` print a refusal and EXIT 0, which is the line the real 2.1.281
 * bundle carries.
 */
import {
  claudeVersion, compareVersions, judgeUpdate, parseCliVersion, replacedInPlace,
  saidOf, updateClaudeCode, updateEnv,
} from '../cli-update.ts'
import { agentEnv, HOST_SESSION_VARS } from '../session.ts'
import { mkdtemp, writeFile, chmod, rm, readFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

/** A stand-in `claude`. Its version lives in a JSON file named by
 *  FAKE_CLAUDE_STATE, so `update` can change what the next `--version` says —
 *  which is the only thing the code under test believes. */
const FAKE = `
const fs = require('node:fs')
const file = process.env.FAKE_CLAUDE_STATE
const st = JSON.parse(fs.readFileSync(file, 'utf8'))
const arg = process.argv[2]
if (arg === '--version') { console.log(st.version + ' (Claude Code)'); process.exit(0) }
if (arg !== 'update') process.exit(2)
// Verbatim from the real CLI: a refusal, and exit 0.
if (process.env.DISABLE_UPDATES) {
  process.stdout.write('Updates are disabled by your administrator. Contact your IT team to get the latest version.\\n')
  process.exit(0)
}
console.log('Current version: ' + st.version)
console.log('Checking for updates to latest version...')
if (st.mode === 'hang') { setTimeout(() => {}, 60000) }
else if (st.mode === 'ask') {
  // An updater that stops to ask: resolves only when stdin ENDS.
  process.stdin.resume()
  process.stdin.on('end', () => { console.log('Claude Code is up to date (' + st.version + ')') })
}
else if (st.mode === 'fail') { console.error('Error: Failed to install native update'); process.exit(1) }
else if (st.mode === 'brew') {
  console.log('Claude is managed by Homebrew.')
  console.log('Update available: ' + st.next)
  console.log('To update, run:')
  console.log('  brew upgrade claude-code')
}
else if (st.next && st.next !== st.version) {
  const from = st.version
  st.version = st.next
  fs.writeFileSync(file, JSON.stringify(st))
  console.log('Successfully updated from ' + from + ' to version ' + st.next)
}
else { console.log('Claude Code is up to date (' + st.version + ')') }
`

const dir = await mkdtemp(path.join(tmpdir(), 'ak-cli-update-'))
const bin = path.join(dir, 'claude')
await writeFile(bin, `#!/usr/bin/env node\n${FAKE}\n`, 'utf8')
await chmod(bin, 0o755)
const stateFile = path.join(dir, 'state.json')
const setState = (s: Record<string, unknown>) => writeFile(stateFile, JSON.stringify(s), 'utf8')
/** The environment a fresh VS Code window would hand us: no DISABLE_UPDATES. */
const cleanEnv = (): Record<string, string | undefined> => {
  const e: Record<string, string | undefined> = { ...process.env, FAKE_CLAUDE_STATE: stateFile }
  delete e.DISABLE_UPDATES
  delete e.DISABLE_AUTOUPDATER
  return e
}

try {
  // --- reading a version -------------------------------------------------------
  {
    ok(parseCliVersion('2.1.272 (Claude Code)') === '2.1.272', 'the version is read out of what `claude --version` prints')
    ok(parseCliVersion('Claude Code v2.1.281\n') === '2.1.281', 'wherever it sits in the line')
    ok(parseCliVersion('command not found') === undefined, 'and nothing is guessed when there is none')
    ok(parseCliVersion(undefined) === undefined, 'a non-string is not a version either')

    ok(compareVersions('2.1.281', '2.1.272') > 0, '2.1.281 is newer than 2.1.272')
    ok(compareVersions('2.1.100', '2.1.99') > 0,
       'numerically, part by part — a string compare says 2.1.100 is OLDER, on exactly a patch bump')
    ok(compareVersions('2.1.272', '2.1.272') === 0, 'a version equals itself')
    ok(compareVersions('2.1', '2.1.0') === 0, 'a missing part counts as zero')

    await setState({ version: '2.1.272' })
    ok(await claudeVersion(bin, updateEnv(cleanEnv())) === '2.1.272', 'claudeVersion asks the binary itself')
    ok(await claudeVersion(path.join(dir, 'nope'), updateEnv(cleanEnv())) === undefined,
       'and a binary that is not there has no version, rather than an exception')
  }

  // --- the environment: the trap this file exists for --------------------------
  {
    const base = { PATH: '/bin', CLAUDE_CODE_SESSION_ID: 'host-session', HOME: '/h' }
    const env = updateEnv(base)
    ok(env.PATH === '/bin' && env.HOME === '/h', 'the host environment is passed through')
    ok(HOST_SESSION_VARS.every((k) => !(k in env)), 'minus the identity of the session the host runs inside')
    ok(!('DISABLE_UPDATES' in env) && !('DISABLE_AUTOUPDATER' in env),
       'and it never ADDS the switches that turn `claude update` into a no-op')
    ok(agentEnv(base).DISABLE_UPDATES === '1',
       'which agentEnv() does add, on purpose, for every agent run — so the update must not be built from it')
    ok(updateEnv({ DISABLE_UPDATES: '1' }).DISABLE_UPDATES === '1',
       'an administrator setting it themselves is a policy, and is left in place')
  }

  // --- judging an outcome by the version, not the exit code --------------------
  {
    const up = judgeUpdate({ before: '2.1.272', after: '2.1.281', code: 0,
      out: 'Current version: 2.1.272\nChecking for updates to latest version...\nSuccessfully updated from 2.1.272 to version 2.1.281\n' })
    ok(up.kind === 'updated' && up.kind === 'updated' && up.from === '2.1.272' && up.to === '2.1.281',
       'a version that went up is an update, with both ends named')
    ok(up.said === 'Successfully updated from 2.1.272 to version 2.1.281',
       'and the CLI’s own words are kept, without the progress chatter around them')

    const refused = judgeUpdate({ before: '2.1.272', after: '2.1.272', code: 0,
      out: 'Updates are disabled by your administrator. Contact your IT team to get the latest version.\n' })
    ok(refused.kind === 'unchanged',
       'an exit 0 that changed nothing is NOT an update — this is the DISABLE_UPDATES refusal, verbatim')
    ok(refused.said.startsWith('Updates are disabled by your administrator'),
       'and the reason reaches the user in the CLI’s words')

    const current = judgeUpdate({ before: '2.1.281', after: '2.1.281', code: 0,
      out: 'Current version: 2.1.281\nChecking for updates to latest version...\nClaude Code is up to date (2.1.281)\n' })
    ok(current.kind === 'unchanged' && current.said === 'Claude Code is up to date (2.1.281)',
       'already current is unchanged, and says so')

    const broke = judgeUpdate({ before: '2.1.272', after: '2.1.272', code: 1, out: 'Error: Failed to install native update\n' })
    ok(broke.kind === 'failed' && broke.said.includes('Failed to install'), 'a non-zero exit is a failure, with its message')

    const timedOut = judgeUpdate({ before: '2.1.272', code: null, out: '', error: 'No answer within 300s.' })
    ok(timedOut.kind === 'failed' && timedOut.said.includes('No answer'), 'so is a wall clock running out')

    const blind = judgeUpdate({ after: '2.1.281', code: 0, out: 'Successfully updated from 2.1.272 to version 2.1.281' })
    ok(blind.kind === 'updated' && blind.to === '2.1.281',
       'with no version to compare against, the CLI’s own claim is the evidence')
    ok(judgeUpdate({ after: '2.1.281', code: 0, out: 'Claude Code is up to date (2.1.281)' }).kind === 'unchanged',
       'and only when it actually claims an update')

    ok(saidOf('\x1b[32mClaude Code is up to date (2.1.281)\x1b[0m') === 'Claude Code is up to date (2.1.281)',
       'terminal colours are not words')
  }

  // --- the real process boundary -----------------------------------------------
  {
    await setState({ version: '2.1.272', next: '2.1.281' })
    const r = await updateClaudeCode(bin, { env: cleanEnv(), timeoutMs: 20_000 })
    ok(r.kind === 'updated' && r.from === '2.1.272' && r.to === '2.1.281',
       `an update that happened is reported as one (${JSON.stringify(r)})`)
    ok(JSON.parse(await readFile(stateFile, 'utf8')).version === '2.1.281', 'and it really did happen on disk')

    // The shape of the bug this module is built around: the same button, but
    // with the environment every AGENT run gets. The CLI refuses and exits 0.
    await setState({ version: '2.1.272', next: '2.1.281' })
    const viaAgentEnv = await updateClaudeCode(bin, { env: agentEnv(cleanEnv() as Record<string, string>), timeoutMs: 20_000 })
    ok(viaAgentEnv.kind === 'unchanged',
       `with agentEnv's DISABLE_UPDATES the update silently does nothing — and is reported as nothing (${viaAgentEnv.kind})`)
    ok(JSON.parse(await readFile(stateFile, 'utf8')).version === '2.1.272', 'the binary is untouched')

    await setState({ version: '2.1.281' })
    const same = await updateClaudeCode(bin, { env: cleanEnv(), timeoutMs: 20_000 })
    ok(same.kind === 'unchanged' && same.said.includes('up to date'), 'an up-to-date CLI is reported as up to date')

    await setState({ version: '2.1.272', next: '2.1.281', mode: 'brew' })
    const brew = await updateClaudeCode(bin, { env: cleanEnv(), timeoutMs: 20_000 })
    ok(brew.kind === 'unchanged' && brew.said.includes('brew upgrade claude-code'),
       `a package-managed install says which command to run instead (${brew.said})`)

    await setState({ version: '2.1.272', mode: 'fail' })
    const failed = await updateClaudeCode(bin, { env: cleanEnv(), timeoutMs: 20_000 })
    ok(failed.kind === 'failed' && failed.said.includes('Failed to install native update'),
       'a failed install is a failure, carrying the CLI’s message')

    // stdin is IGNORED, so an updater that waits on it sees end-of-file at once.
    // Left as an open pipe it would wait out the whole five-minute wall clock.
    await setState({ version: '2.1.281', mode: 'ask' })
    const t0 = Date.now()
    const asked = await updateClaudeCode(bin, { env: cleanEnv(), timeoutMs: 8_000 })
    ok(asked.kind === 'unchanged' && Date.now() - t0 < 6_000,
       `an updater reading stdin is not left waiting on it (${Date.now() - t0}ms, ${asked.kind})`)

    await setState({ version: '2.1.272', mode: 'hang' })
    const hung = await updateClaudeCode(bin, { env: cleanEnv(), timeoutMs: 700 })
    ok(hung.kind === 'failed' && hung.said.includes('No answer within'),
       `a hung updater is stopped by the wall clock and reported (${hung.said})`)
  }

  // --- in place or not --------------------------------------------------------
  {
    const versions = path.join(dir, 'share', 'claude', 'versions')
    await mkdir(versions, { recursive: true })
    const real = path.join(versions, '2.1.272')
    await writeFile(real, '', 'utf8')
    const link = path.join(dir, 'bin-claude')
    await symlink(real, link)
    ok(await replacedInPlace(link) === false,
       'a native install (a symlink into claude/versions/) keeps every version in its own file')
    ok(await replacedInPlace(bin) === true, 'anything else is assumed to be rewritten in place')
    ok(await replacedInPlace(path.join(dir, 'missing')) === true, 'and so is a path we cannot resolve')
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} cli-update test(s) failed` : '\nall cli-update tests passed')
process.exit(fails ? 1 : 0)
