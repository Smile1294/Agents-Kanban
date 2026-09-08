/* The relay contract gate. The shared rules between this extension and the
 * relay it pushes to are pinned by remote-contract.json, carried VERBATIM in
 * both repository roots. A rule that drifts apart silently — one end accepting
 * ids or prompts the other end will not — breaks pairing in the field and
 * reads as a dead feature, so `verify` runs this script.
 *
 * Shown red twice when it was new: bumping CMD_TEXT_MAX in commands.ts, and
 * editing the relay repo's copy of remote-contract.json, each exited 1 naming
 * the drift; both were restored before the gate went into `verify`.
 *
 * Three checks, in order:
 *
 *  (a) LOCAL — the constants this repo duplicates from the contract file,
 *      against the JSON (single-line literals, read by regex because the
 *      sources are TypeScript):
 *        KEY_OK        src/remote/relay.ts
 *        NONCE_OK      src/remote/commands.ts
 *        SETTING_OK    src/remote/commands.ts
 *        THINKING_OK   src/remote/commands.ts
 *        CMD_TEXT_MAX  src/remote/commands.ts
 *        FN_PATH       src/remote/pusher.ts
 *      idOk and cmdMax are not duplicated here — the extension never holds
 *      them — so they are pinned only by the relay repo's own
 *      tests/contract.test.mjs and by check (b) below.
 *
 *  (b) REMOTE — this copy against the relay repo's copy. The sibling
 *      directory (../agents-kanban-relay) is the answer on a dev machine;
 *      elsewhere AGENTS_KANBAN_RELAY_URL or the package.json `relayRepo`
 *      field is fetched. Drift exits 1 naming the field.
 *
 *  (c) NEITHER reachable — the gate prints
 *      'contract UNCHECKED — could not reach the relay repo' and exits 0.
 *      A loud skip, never a silent one: a fresh clone has no sibling, and a
 *      fetch failure means "could not compare", not "equal".
 */
import { access, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const fails = []
const ok = (cond, msg) => { console.log((cond ? 'ok: ' : 'FAIL: ') + msg); if (!cond) fails.push(msg) }
const fail = (msg) => { console.log('FAIL: ' + msg); fails.push(msg) }

// Two roots, because this script runs in the main checkout AND inside a
// worktree (.agentskanban/worktrees/<name>/, which is a full checkout nested
// INSIDE the main repo). The files under check are always this checkout's own
// — the copy of remote-contract.json, src/remote/*.ts and package.json sitting
// next to the script — but the relay repo is a sibling of the MAIN checkout,
// which in a worktree only git knows how to name. So ROOT is where the script
// lives, MAIN is the main checkout root from git's common dir.
const ROOT = path.resolve(HERE, '..')
const gitCommon = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: HERE, encoding: 'utf8' })
const MAIN = gitCommon.status === 0
  ? path.dirname(gitCommon.stdout.trim().replace(/\/+$/, ''))
  : ROOT

const sourceOf = async (rel) => readFile(path.join(ROOT, rel), 'utf8')

// The four duplicated literals are declared on a single line each. Read them
// by regex rather than importing the TypeScript: this is a plain-node script
// and the values it guards are exactly the ones a stray import might mask.
const grab = (src, name) => {
  const regex = new RegExp(`export const ${name} = /([^/]+)/`, 'm')
  const m = regex.exec(src)
  return m ? m[1] : undefined
}
const grabNumber = (src, name) => {
  const m = new RegExp(`export const ${name} = (\\d[\\d_]*)`, 'm').exec(src)
  return m ? Number(m[1].replaceAll('_', '')) : undefined
}
const grabString = (src, name) => {
  const m = new RegExp(`export const ${name} = '([^']*)'`, 'm').exec(src)
  return m ? m[1] : undefined
}

console.log('— relay contract')
const contract = JSON.parse(await readFile(path.join(ROOT, 'remote-contract.json'), 'utf8'))

if (contract.version !== 1) fail(`remote-contract.json version is ${contract.version}, expected 1`)

// (a) the local duplicates
const relaySrc = await sourceOf('src/remote/relay.ts')
const commandsSrc = await sourceOf('src/remote/commands.ts')
const pusherSrc = await sourceOf('src/remote/pusher.ts')
const local = [
  ['keyOk', contract.keyOk, grab(relaySrc, 'KEY_OK'), 'src/remote/relay.ts KEY_OK'],
  ['nonceOk', contract.nonceOk, grab(commandsSrc, 'NONCE_OK'), 'src/remote/commands.ts NONCE_OK'],
  ['settingOk', contract.settingOk, grab(commandsSrc, 'SETTING_OK'), 'src/remote/commands.ts SETTING_OK'],
  ['thinkingOk', contract.thinkingOk, grab(commandsSrc, 'THINKING_OK'), 'src/remote/commands.ts THINKING_OK'],
  ['cmdTextMax', contract.cmdTextMax, grabNumber(commandsSrc, 'CMD_TEXT_MAX'), 'src/remote/commands.ts CMD_TEXT_MAX'],
  ['fnPath', contract.fnPath, grabString(pusherSrc, 'FN_PATH'), 'src/remote/pusher.ts FN_PATH'],
]
for (const [field, want, got, where] of local) {
  ok(got === want, `contract ${field} matches ${where}`)
  if (got !== undefined && got !== want) {
    fail(`  ${field} drifted: the contract says ${JSON.stringify(want)}, ${where} is ${JSON.stringify(got)}`)
  }
}

// (b) the relay repo's copy. Sibling directory first; a URL (env var, or the
// package.json `relayRepo` field) otherwise.
async function relayCopy() {
  const sibling = path.join(path.dirname(MAIN), 'agents-kanban-relay', 'remote-contract.json')
  try {
    await access(sibling)
    return { where: '../agents-kanban-relay (sibling)', json: JSON.parse(await readFile(sibling, 'utf8')) }
  } catch { /* fall through to the URL */ }

  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const url = process.env.AGENTS_KANBAN_RELAY_URL || pkg.relayRepo
  if (!url) return { why: 'no AGENTS_KANBAN_RELAY_URL and package.json has no relayRepo' }
  // A repo URL (github.com/owner/repo) resolves to the raw file; anything else
  // is taken as already pointing at the file.
  const gh = /^https:\/\/github\.com\/([^/]+\/[^/]+?)\/?$/.exec(url)
  const target = gh
    ? `https://raw.githubusercontent.com/${gh[1]}/HEAD/remote-contract.json`
    : url.replace(/\/+$/, '') + (url.endsWith('remote-contract.json') ? '' : '/remote-contract.json')
  try {
    const res = await fetch(target, { signal: AbortSignal.timeout(5_000) })
    if (res.ok) return { where: target, json: JSON.parse(await res.text()) }
    return { why: `${target} answered ${res.status}` }
  } catch (e) {
    return { why: `${target} could not be fetched (${e.cause?.code ?? e.message})` }
  }
}

const relay = await relayCopy()
if (!relay?.json) {
  console.log(`contract UNCHECKED — could not reach the relay repo (${relay?.why})`)
  console.log('  skipping the cross-repo check (exit 0 — a loud skip, never a silent pass)')
} else {
  console.log(`ok: relay repo copy read (${relay.where})`)
  for (const field of Object.keys(contract)) {
    const same = JSON.stringify(contract[field]) === JSON.stringify(relay.json[field])
    ok(same, `remote-contract.json ${field} matches the relay repo's copy`)
  }
}

if (fails.length) {
  console.log(`\n${fails.length} contract FAILURE${fails.length > 1 ? 's' : ''} — the extension and the relay no longer agree.`)
  process.exit(1)
}
console.log(relay?.json
  ? '\ncontract OK — this repo and the relay agree on every shared rule'
  : '\ncontract local checks OK; cross-repo copy not compared (see UNCHECKED above)')
