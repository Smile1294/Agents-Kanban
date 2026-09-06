/* Does the thing the user actually presses still work?
 *
 * Loads the BUILT bundle with a stubbed `vscode` and drives it the way VS Code
 * does. Five gates, each one standing over a bug that shipped:
 *
 *   1. activation      — it registers what it promises to register
 *   2. manifest        — package.json and the code agree about what exists
 *   3. no folder open  — registration never depends on workspace state
 *   4. live wiring     — posting `ready` gets a real UiState back
 *   5. view contract   — that real UiState renders through the real board.js
 *
 * Gates 2, 4 and 5 exist because the unit tests all passed while the extension
 * did not launch. A blank panel and a "command not found" both live in seams
 * that only a built, activated, message-driven extension can cross.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { loadBundle, makeContext, makeRepo, makeVscodeStub, repoRoot } from './test/harness.mjs'
import { renderBoard, walk as walkNodes } from './test/dom.mjs'

let fails = 0
const ok = (cond, msg) => { console.log(cond ? '  ok:' : 'FAIL:', msg); if (!cond) fails++ }

const manifest = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
const repo = await makeRepo('ck-smoke-')
const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-storage-'))

// One session that HAS a worktree — the repo itself, a real checkout with a
// README in it. The board never lists it (Claude Code has no transcript for it),
// but the sidecar knows its worktree, branch and base, and that is all the
// review actions need. It is what lets this test press a test-plan link and a
// changed-file row for real, instead of only aiming them at sessions that have
// nowhere to open.
/**
 * A REAL Claude Code session for the throwaway repo, in a throwaway config dir.
 *
 * `CLAUDE_CONFIG_DIR` is set before the bundle loads, so the SDK reads this
 * tree instead of the developer's own `~/.claude`. Two things follow, and both
 * matter: the run is hermetic — it no longer behaves differently depending on
 * what sessions happen to be on the machine — and the transcript below has
 * KNOWN token counts, so the context meter and the spend readout can be
 * asserted to the cent rather than merely "present".
 *
 * The project directory's name is the session's cwd with every character that
 * is not a letter or a digit replaced by `-` — `_` included, which is not
 * obvious and is exactly what caught this out: macOS's per-user temp path has
 * an underscore in it, so replacing only `/` and `.` produced a directory the
 * SDK never looks in. It is the REALPATH that gets encoded, too, since the temp
 * directory is reached through a symlink. If the SDK ever changes this scheme
 * the assertion below goes red and names it, rather than quietly skipping.
 */
const claudeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-claude-'))
process.env.CLAUDE_CONFIG_DIR = claudeHome
const STORED_SESSION = '11111111-2222-3333-4444-555555555555'
/** A card that records the agent, backend and model it was launched with. */
const ON_GATEWAY = '5c5c5c5c-0000-4000-8000-00000000feed'
const STORED_USAGE = {
  input_tokens: 100,
  output_tokens: 1000,
  cache_read_input_tokens: 200_000,
  cache_creation_input_tokens: 4_000,
  cache_creation: { ephemeral_1h_input_tokens: 4_000, ephemeral_5m_input_tokens: 0 },
}
// Opus 5 at $5/$25 per MTok, cache reads at a tenth of input and 1h writes at
// double it: 100*5 + 1000*25 + 200000*0.5 + 4000*10 = 165,500 millionths.
const STORED_COST = 0.1655
const STORED_CONTEXT = 100 + 200_000 + 4_000
{
  const projectDir = path.join(
    claudeHome, 'projects', (await fs.realpath(repo)).replace(/[^a-zA-Z0-9]/g, '-'),
  )
  await fs.mkdir(projectDir, { recursive: true })
  const common = {
    sessionId: STORED_SESSION, cwd: await fs.realpath(repo),
    isSidechain: false, userType: 'external', version: '2.0.0', gitBranch: 'main',
  }
  await fs.writeFile(path.join(projectDir, `${STORED_SESSION}.jsonl`), [
    { ...common, type: 'user', uuid: 'u1', parentUuid: null,
      timestamp: new Date(1e12).toISOString(),
      message: { role: 'user', content: 'seeded prompt' } },
    { ...common, type: 'assistant', uuid: 'a1', parentUuid: 'u1',
      timestamp: new Date(1e12 + 1000).toISOString(),
      message: {
        id: 'msg_seed', model: 'claude-opus-5', role: 'assistant', type: 'message',
        content: [{ type: 'text', text: 'seeded answer' }], usage: STORED_USAGE,
      } },
    // A second frame of the SAME response, which is how a streamed answer is
    // written. It must not double the bill — see sessions/usage.ts.
    { ...common, type: 'assistant', uuid: 'a2', parentUuid: 'a1',
      timestamp: new Date(1e12 + 2000).toISOString(),
      message: {
        id: 'msg_seed', model: 'claude-opus-5', role: 'assistant', type: 'message',
        content: [{ type: 'text', text: ' and more' }], usage: STORED_USAGE,
      } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')

  /* A second real session, for the card that RECORDS what it is running on.
     Its own session rather than fields bolted onto the one above, so the
     assertions about that one stay about that one — and a real transcript,
     because a sidecar entry with no session is not a card and cannot be
     selected. */
  const onGw = { ...common, sessionId: ON_GATEWAY }
  await fs.writeFile(path.join(projectDir, `${ON_GATEWAY}.jsonl`), [
    { ...onGw, type: 'user', uuid: 'g1', parentUuid: null,
      timestamp: new Date(1e12).toISOString(),
      message: { role: 'user', content: 'run this on the gateway' } },
    { ...onGw, type: 'assistant', uuid: 'g2', parentUuid: 'g1',
      timestamp: new Date(1e12 + 1000).toISOString(),
      message: {
        id: 'msg_gw', model: 'deepseek-v4-pro', role: 'assistant', type: 'message',
        content: [{ type: 'text', text: 'working on it' }],
        usage: { input_tokens: 10, output_tokens: 20 },
      } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
}

const SEEDED = 'seeded-session-with-worktree'
const INTERRUPTED_AT = 1_700_000_000_000
await fs.mkdir(path.join(storage, 'sessions'), { recursive: true })
await fs.writeFile(
  path.join(storage, 'sessions', encodeURIComponent(repo) + '.json'),
  JSON.stringify({
    [SEEDED]: {
      phase: 'validating', tags: [], archived: false, pinned: false, activity: [],
      worktree: repo, branch: 'task/seeded', base: 'main',
    },
    // A run that was still marked running when the extension host went away.
    // This is what a reload, a reinstall or a crash leaves behind: the CLI
    // process died with the old host and nothing can re-attach to it.
    [STORED_SESSION]: {
      phase: 'implementing', tags: [], archived: false, pinned: false, activity: [],
      running: INTERRUPTED_AT,
    },
    /* A card that RECORDS WHAT IT IS RUNNING ON — the fields `durablePatch`
       writes at launch. Its own entry rather than fields bolted onto one of the
       above, so the assertions about those stay about those.
       `litellm` is the id the add-a-provider flow below produces from the
       preset of the same name; a mismatch here is a card pointing at a backend
       that does not exist, which is itself worth not shipping. */
    [ON_GATEWAY]: {
      phase: 'implementing', tags: [], archived: false, pinned: false, activity: [],
      runtime: 'claude', provider: 'litellm', model: 'deepseek-v4-pro', effort: 'low',
    },
  }),
)

const ctl = {
  repo,
  noFolder: false,
  config: {
    model: 'claude-opus-5', maxConcurrentAgents: 3, permissionMode: 'acceptEdits', worktreeRoot: '',
    // Model discovery spawns a real `claude` process to ask what it can run.
    // This gate seeds a throwaway CLAUDE_CONFIG_DIR precisely so it does not
    // depend on the machine, so discovery is off here and the built-in list is
    // what the view contract is checked against. The discovery mapping itself
    // is pure and covered by src/agent/__tests__/models.test.ts.
    discoverModels: false,
  },
}
const stub = makeVscodeStub(ctl)
const ext = loadBundle(stub.vscode)

const context = await makeContext(storage)
await ext.activate(context)

// ---------------------------------------------------------------- 1. activation

console.log('\n— activation')
ok(stub.calls.includes('registerWebviewViewProvider:agentsKanban.board'), 'the board view provider registers')
ok(stub.calls.some((c) => c.startsWith('createStatusBarItem:')), 'and the status bar item')
ok(context.subscriptions.length >= 8, `${context.subscriptions.length} disposables registered`)

// ------------------------------------------------------------------ 2. manifest
//
// A command declared in package.json but never registered is exactly what
// "command not found" looks like from the palette; the reverse is a command
// the user can never reach. Neither shows up in a unit test.

console.log('\n— manifest and code agree')
const declared = (manifest.contributes?.commands ?? []).map((c) => c.command)
const registered = [...stub.cmds.keys()]
for (const c of declared) ok(registered.includes(c), `declared command is registered: ${c}`)
for (const c of registered) ok(declared.includes(c), `registered command is declared: ${c}`)

// The activity-bar icon is the toggle, so the view must exist. What it renders
// is a CONTROL, not a board: five columns cannot be read in 300px, and drawn
// beside the real board it was the same thing twice.
const viewIds = Object.values(manifest.contributes?.views ?? {}).flat().map((v) => v.id)
for (const id of viewIds) {
  ok(stub.calls.includes('registerWebviewViewProvider:' + id), `declared view has a provider: ${id}`)
}
const containers = (manifest.contributes?.viewsContainers?.activitybar ?? []).map((c) => c.id)
for (const key of Object.keys(manifest.contributes?.views ?? {})) {
  ok(containers.includes(key), `view container "${key}" is declared`)
}
ok((manifest.contributes?.keybindings ?? []).some((k) => k.command === 'agentsKanban.openBoard'),
   'the board also has a keybinding')
ok(stub.calls.some((c) => c.startsWith('createStatusBarItem:')), 'and a status bar item')
for (const [where, entries] of Object.entries(manifest.contributes?.menus ?? {})) {
  for (const m of entries) ok(declared.includes(m.command), `${where} entry points at a real command: ${m.command}`)
}

// The status bar item is created in activate(), so with a purely lazy
// activation it does not exist until something else has already activated the
// extension — the icon, or a command. Which makes "the status bar is a way in"
// false precisely for the person who has not found the other ways in yet, and
// leaves the extension's own log channel absent when you go looking for why
// nothing happened.
ok((manifest.activationEvents ?? []).includes('onStartupFinished'),
   'the extension activates at startup, so the status bar item and the log exist')

// Files the manifest promises must exist, and an icon of zero bytes renders as
// a gap in the activity bar rather than an error.
const mainFile = path.join(repoRoot, manifest.main)
ok(await fs.stat(mainFile).then((s) => s.size > 0, () => false), `main exists and is non-empty: ${manifest.main}`)
for (const icon of [manifest.contributes?.viewsContainers?.activitybar?.[0]?.icon].filter(Boolean)) {
  const st = await fs.stat(path.join(repoRoot, icon)).catch(() => null)
  ok(st?.size > 0, `activity bar icon exists and is non-empty: ${icon}`)
}

// Every setting the code reads must be declared, or it silently resolves to
// undefined and the documented default never applies.
const props = Object.keys(manifest.contributes?.configuration?.properties ?? {})
const src = await fs.readFile(path.join(repoRoot, 'src', 'extension.ts'), 'utf8')
const read = [...src.matchAll(/cfg\(\)\.get<[^>]+>\('([^']+)'\)/g)].map((m) => m[1])
for (const key of new Set(read)) {
  ok(props.includes('agentsKanban.' + key), `setting read by the code is declared: agentsKanban.${key}`)
}
for (const p of props) {
  ok(read.includes(p.replace(/^agentsKanban\./, '')), `declared setting is actually read: ${p}`)
}

// --------------------------------------------------- 2b. the project can be run
//
// `tsc: not found` on a fresh clone, because nothing installed anything and
// nothing said so. The failure even differs by machine — with a global
// TypeScript you instead get a hundred "Cannot find name 'process'" errors.
// Neither message names the cause or the fix.

console.log('\n— the project can be run from a clean checkout')
const scripts = manifest.scripts ?? {}
const preflightSource = await fs.readFile(path.join(repoRoot, 'scripts', 'preflight.mjs'), 'utf8')

// npm runs scripts through `sh` (dash on most Linux), where `**` is just `*`
// and bashisms are syntax errors. Every script must be plain Node.
for (const [name, body] of Object.entries(scripts)) {
  ok(!body.includes('**'), `${name}: no shell globbing (sh has no globstar)`)
  ok(!/\bfor\b.+\bdo\b/.test(body), `${name}: no shell loop`)
  ok(!/\/Applications\/|[A-Z]:\\/.test(body), `${name}: no hardcoded platform path`)
}

// A script may only invoke `node` or `npm`. Anything else — a bare `tsc`, or
// `npx` — is resolved through node_modules/.bin, which npm fills with SYMLINKS.
// Those are simply absent on a filesystem without symlink support (a Windows
// drive under WSL, a network share, some Docker mounts) and after
// `npm install --no-bin-links`. The install is fine; only the links are gone,
// and `tsc: not found` is what that looks like. scripts/run-bin.mjs resolves
// executables through Node instead, which does not care.
for (const [name, body] of Object.entries(scripts)) {
  for (const step of body.split('&&')) {
    const first = step.trim().split(/\s+/)[0]
    if (!first) continue
    ok(first === 'node' || first === 'npm',
       `${name}: "${first}" is node or npm, not a .bin symlink`)
  }
}

// And the preflight must judge dependencies the same way, or it condemns a
// perfectly good install: it once required node_modules/.bin/tsc to exist and
// told the user to reinstall something that would come back identical.
// Comments are stripped first — the file explains this at length, and the
// explanation is not the behaviour.
const preflightCode = preflightSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n')
ok(!/\.bin/.test(preflightCode), 'the preflight does not require node_modules/.bin to exist')

// The preflight's Node floor and the manifest's must agree, or one of them lies.
const floor = /const MIN_NODE = \[(\d+), (\d+), (\d+)\]/.exec(preflightSource)
ok(!!floor, 'the preflight declares a minimum Node version')
ok(!!manifest.engines?.node, 'and package.json declares one too')
if (floor && manifest.engines?.node) {
  const declared = manifest.engines.node.replace(/[^\d.]/g, '')
  ok(declared === floor.slice(1, 4).join('.'),
     `they agree: engines.node ${manifest.engines.node} vs preflight ${floor.slice(1, 4).join('.')}`)
}

// EVERY script must run the preflight first, or it fails with the original
// cryptic message instead of the useful one. CLAUDE.md states the rule without
// exceptions — "Never add a script that skips it" — and this gate used to name
// three scripts explicitly, which encoded the exception rather than the rule:
// nine of twelve skipped it and nothing could say so. A script that only
// delegates (`npm run x`) is covered by what it delegates to.
for (const [name, body] of Object.entries(scripts)) {
  if (name === 'preflight') continue
  const delegates = body.trimStart().startsWith('npm run ')
  ok(delegates || body.includes('preflight'),
     `${name} runs the preflight before anything else`)
}

// ------------------------------------------------------------- 3. no folder open
//
// REGRESSION: activate() used to return early when no folder was open, before
// registering anything, so every command reported "command not found" and the
// view stayed blank. Registration must not depend on workspace state.

console.log('\n— with no folder open')
ctl.noFolder = true
stub.calls.length = 0
stub.cmds.clear()
const ctx2 = await makeContext(storage)
await ext.activate(ctx2)
for (const c of declared) ok(stub.cmds.has(c), `${c} still registers`)
ok(stub.calls.includes('registerWebviewViewProvider:agentsKanban.board'), 'the view provider still registers')
ctl.noFolder = false

// ------------------------------------------------------------------ 4. live wiring
//
// The webview's first act is to post `ready`. If the host throws on the way to
// a UiState, nothing is ever posted back and the panel sits blank forever with
// no error anywhere. Nothing below the getState() call was covered before.

console.log('\n— live message wiring')
// One stub throughout: `require` caches the bundle, so the `vscode` it closed
// over at load time is the only one it will ever see. A second stub would be
// built, wired to nothing, and quietly assert against an empty map.
const ctx3 = await makeContext(storage)
await ext.activate(ctx3)

await stub.cmds.get('agentsKanban.openBoard')()
ok(stub.calls.includes('createWebviewPanel:agentsKanban.panel'), 'openBoard creates the editor panel')
ok(stub.handlers.length > 0, 'the panel installs a message handler')

const send = async (msg) => { for (const h of stub.handlers) await h(msg) }
const latestState = () => [...stub.posted].reverse().find((m) => m.type === 'state')?.state
await send({ type: 'ready' })
const state = latestState()
ok(!!state, 'posting `ready` gets a state message back')
ok(state?.ready === true, 'the state is ready, not stuck on a setup screen')
ok((state?.columns ?? []).length > 0, `the board has columns (${(state?.columns ?? []).length})`)
ok(!!state?.composer?.models?.length, 'the composer offers models')
ok(state?.noRepo !== true, 'a git repository is recognised as one')

// The model the settings default to must be one the picker can actually show,
// or the composer displays a nameless agent.
const defaultModel = manifest.contributes.configuration.properties['agentsKanban.model'].default
ok(state?.composer?.models?.some((m) => m.id === defaultModel),
  `the default model is in the picker: ${defaultModel}`)

// Every permission mode the manifest offers must be one the composer can show,
// and vice versa — a mode in one and not the other is a dead setting.
const manifestModes = manifest.contributes.configuration.properties['agentsKanban.permissionMode'].enum
const uiModes = (state?.composer?.permissionModes ?? []).map((m) => m.key)
for (const m of manifestModes) ok(uiModes.includes(m), `manifest permission mode is offered in the UI: ${m}`)
for (const m of uiModes) ok(manifestModes.includes(m), `UI permission mode is a real setting: ${m}`)
ok(uiModes.includes(state?.composer?.permissionMode), 'the active mode is one of the offered ones')

// Slash commands are discovered from the workspace, and an absent directory is
// the normal case rather than an error.
ok(Array.isArray(state?.commands ?? []), 'slash commands are a list (or absent)')

// A session with NOTHING RUNNING still reports its context fill and its spend.
//
// This is the restart bug, as a gate. Both numbers used to be copied off the
// live agent and nowhere else, so every session became blank the moment its
// process ended — which is what a VS Code restart does to all of them at once.
// It is checked here rather than only in a unit test because it takes the whole
// path: activation, the real session store, Claude Code's own transcripts on
// disk, and the state the panel actually posts.
ok((state?.cards ?? []).some((c) => c.sessionId === STORED_SESSION),
   'the seeded Claude Code session appears on the board')
await send({ type: 'select', id: STORED_SESSION })
const sel = latestState()
ok(sel?.selectedKey === STORED_SESSION, 'and can be selected with nothing running')
ok((sel?.transcript ?? []).length > 0, 'its transcript is read back from disk')
ok(sel?.composer?.contextTokens === STORED_CONTEXT,
   `its context fill is read back exactly: ${sel?.composer?.contextTokens} (expected ${STORED_CONTEXT})`)
ok(sel?.composer?.contextWindow === 1_000_000,
   `measured against the model's window: ${sel?.composer?.contextWindow}`)
// Off `composer.meter`, which is the ONE source now. It was `spentUsd` — a bare
// number — and `spend` is emitted by exactly one runtime, so every Codex session
// reached the bar as a zero and rendered "$0.00" over a subscription card. The
// union is the fix and this asserts the `usd` arm still carries the same figure.
const meter = sel?.composer?.meter
ok(meter?.kind === 'usd', `its meter is a dollar figure for a Claude session (got ${meter?.kind})`)
ok(Math.abs((meter?.spentUsd ?? 0) - STORED_COST) < 1e-9,
   `and its spend is priced from those tokens: $${meter?.spentUsd} (expected $${STORED_COST})`)
ok(meter?.priced === true, 'with every model in it priced')
// The dedupe, end to end: the two frames of one response must be billed once.
ok((meter?.spentUsd ?? 0) < STORED_COST * 1.5,
   'the repeated frame of a streamed response is not billed twice')

// Every inbound message the view can send must be survivable. A throw here
// surfaces as an error toast at best, and a dead button at worst.
console.log('\n— every inbound message is handled')
const before = stub.errors.length
for (const msg of [
  { type: 'setMode', mode: 'chat' },
  { type: 'setMode', mode: 'kanban' },
  { type: 'select', id: '' },
  { type: 'toggleArchived' },
  { type: 'toggleArchived' },
  // Pin: the board's primary sort key, which for a long time nothing could set.
  { type: 'pin', id: SEEDED, pinned: true },
  { type: 'pin', id: SEEDED, pinned: false },
  { type: 'pin', id: 'nope', pinned: true },
  // The split dial. Per card when one is selected, and the workspace default
  // otherwise — and a level this build cannot read must be ignored rather than
  // reaching `buildBrief()`, which is what the agent is told.
  { type: 'composer', orchestration: 'maximum', forKey: SEEDED },
  { type: 'composer', orchestration: 'minimal' },
  { type: 'composer', orchestration: 'aggressive' },
  { type: 'composer', orchestration: 'balanced', forKey: 'nope' },
  // A collapsed section is remembered host-side, so these must survive being
  // aimed at nonsense as much as any other inbound message.
  // An attachment that cannot be sent must be refused, not thrown on. Both
  // entries carry text that is blank AFTER the refusal, so neither can start a
  // real agent — the same reason the plain `send` above uses whitespace.
  { type: 'send', id: 'nope', text: '  ', images: [{ name: 'x.mp4', mediaType: 'video/mp4', data: 'AAAA' }] },
  { type: 'send', id: 'nope', text: '  ', images: 'not-an-array' },
  { type: 'send', id: 'nope', text: '  ', images: [null, {}, { data: 5 }] },
  { type: 'newSession', text: '  ', images: [{ name: 'y.png', mediaType: 'image/png', data: '!!!' }] },
  // Run must survive a session with no worktree — every session, until an
  // agent makes one — and one whose worktree has nothing runnable in it.
  { type: 'run', id: 'nope' },
  { type: 'run', id: SEEDED },
  { type: 'disclosure', key: 'review', open: false },
  { type: 'disclosure', key: 'review', open: true },
  { type: 'disclosure', key: '', open: false },
  { type: 'disclosure' },
  { type: 'composer', model: 'claude-opus-5' },
  { type: 'composer', effort: 'low' },
  { type: 'composer', thinking: 'disabled' },
  { type: 'composer', thinking: 'enabled' },
  { type: 'init' },
  { type: 'newSession', text: '   ' },      // blank: must be ignored, not launched
  { type: 'send', id: 'nope', text: '  ' },
  // The review half. Each must survive being aimed at a session that has no
  // worktree, which is every session until an agent makes one.
  { type: 'review', id: 'nope' },
  { type: 'diff', id: 'nope', file: 'src/x.ts' },
  { type: 'commit', id: 'nope' },
  { type: 'merge', id: 'nope' },
  { type: 'testLink', id: 'nope', kind: 'file', target: 'src/x.ts' },
  { type: 'testLink', id: 'nope', kind: 'command', target: 'npm test' },
  { type: 'testLink', id: 'nope', kind: 'url', target: 'http://localhost:3000' },
  { type: 'testLink', id: 'nope', kind: 'file', target: '' },
  { type: 'interrupt', id: 'nope' },
  { type: 'clearQueue', id: 'nope' },
  { type: 'composer', permissionMode: 'plan' },
  { type: 'composer', permissionMode: 'acceptEdits', id: 'nope' },
  { type: 'composer', permissionMode: 'not-a-real-mode' },
  { type: 'focus' },
  { type: 'focus' },
  { type: 'openBoard' },
  { type: 'closeBoard' },
  { type: 'openSession', id: 'nope' },
  { type: 'nonsense' },
]) {
  await send(msg)
}
ok(stub.errors.length === before, `no errors from the inbound message sweep (${stub.errors.slice(before).join('; ') || 'clean'})`)

// The diff's left-hand side is served by a content provider registered at
// activation. A wrong API name there throws before anything else runs — which
// is how a whole extension fails to start.
ok(stub.calls.some((c) => c.startsWith('contentProvider:')), 'the base-version content provider registers')
ok(typeof ctl.contentProvider?.provideTextDocumentContent === 'function', 'it provides document content')
// `query: ''` reaches only the guard clause, so this never called
// `WorktreeService.show()` — the thing that actually runs `git show <ref>:<file>`
// and is the only way to produce an "unresolvable base version". The assertion
// asserted its own name. A real query is passed now, so the provider is
// exercised end to end.
const bogus = await ctl.contentProvider
  .provideTextDocumentContent({ path: '/nope.ts', query: '' })
  .catch((e) => `THREW: ${e.message}`)
ok(bogus === '', `a malformed base-version URI yields empty, not a throw (${JSON.stringify(bogus)})`)

{
  const q = (ref, file) => ({ path: file, query: `dir=${encodeURIComponent(repo)}&ref=${ref}` })
  const readme = await ctl.contentProvider
    .provideTextDocumentContent(q('main', '/README.md'))
    .catch((e) => `THREW: ${e.message}`)
  ok(typeof readme === 'string' && readme.includes('#'),
     `the base version of a real file is served (${JSON.stringify(String(readme).slice(0, 24))})`)
  // Byte for byte: a trimmed left-hand side makes every diff report a change at
  // the head and the tail that the agent never made.
  const onDisk = await fs.readFile(path.join(repo, 'README.md'), 'utf8')
  ok(readme === onDisk,
     `and byte for byte, so the diff shows only what CHANGED (${readme === onDisk ? 'exact' : JSON.stringify(String(readme).slice(-12))} vs ${JSON.stringify(onDisk.slice(-12))})`)

  const missingRef = await ctl.contentProvider
    .provideTextDocumentContent(q('no-such-ref', '/README.md'))
    .catch((e) => `THREW: ${e.message}`)
  ok(missingRef === '', `a ref that does not resolve yields empty, not a throw (${JSON.stringify(missingRef)})`)
  const missingFile = await ctl.contentProvider
    .provideTextDocumentContent(q('main', '/never-existed.ts'))
    .catch((e) => `THREW: ${e.message}`)
  ok(missingFile === '',
     `and so does a file the agent ADDED — an empty left side is the right diff there (${JSON.stringify(missingFile)})`)
}

// The layout. This is the gate that matters most in daily use, and the one
// that was hardest to get right: the board must take the editor area, the
// terminal and the right-hand chat, and must NEVER take the left side bar.
//
// It asserts on where the window ENDED UP, not on which commands were issued.
// The previous version asserted on command names, and `closeSidebar` paired
// with `toggleSidebarVisibility` looks perfectly symmetric written down — but
// the icon click that triggers the restore reopens the side bar first, so the
// toggle closed it. Every one of those assertions was green while the left side
// bar disappeared on nearly every path through this code.
console.log('\n— the icon toggles the board; the left side bar is never taken')
ctl.provider.resolveWebviewView(ctl.boardView)
const L = stub.layout
const HOME = 'workbench.view.explorer'
const settle = () => new Promise((r) => setTimeout(r, 300))
const act = async (fn) => { stub.calls.length = 0; fn(); await new Promise((r) => setTimeout(r, 60)); return [...stub.calls] }

// Every workbench command the extension issued across this whole section.
const issued = []
const record = (calls) => { issued.push(...calls); return calls }

// The layout the user actually keeps: files on the left, terminal below the
// editor, Claude Code on the right.
await send({ type: 'closeBoard' })
await settle()
Object.assign(L, { sideBar: true, sideBarView: HOME, panel: true, auxBar: true })
ok(L.sideBar && L.sideBarView === HOME && L.panel && L.auxBar,
   'start: explorer on the left, terminal below, chat on the right')

// 1. The icon opens the board and takes the editor area — and only that.
const opened = record(await act(() => ctl.clickActivityIcon()))
ok(opened.some((c) => c === 'createWebviewPanel:agentsKanban.panel' || c === 'reveal:agentsKanban.panel'),
   'the board opens in the editor area')
ok(L.panel === false, 'the terminal at the bottom closes')
ok(L.auxBar === false, 'the chat on the right closes')
ok(L.sideBar === true, 'the left side bar STAYS OPEN — the board never takes it')
ok(L.sideBarView === HOME, 'and it is showing your files, not the Kanban control')

// 2. Handing the side bar back hides our own view, and that is the very event
//    that opens the board. Unguarded it reads as a second press and undoes
//    everything we just did.
ok(ctl.boardView.visible === false, 'our own view is hidden again, having given the side bar back')
ok(!opened.includes('disposePanel:agentsKanban.panel'),
   'the hand-back does not read as a second press of the icon')

// 3. The icon again closes it, and the terminal and the chat come back together.
await settle()
const viaIcon = record(await act(() => ctl.clickActivityIcon()))
ok(viaIcon.includes('disposePanel:agentsKanban.panel'), 'pressing the icon again closes the board')
ok(L.panel === true, 'the terminal comes back')
ok(L.auxBar === true, 'the chat comes back')
ok(L.sideBar === true, 'and the left side bar is STILL open — it never moved')
ok(L.sideBarView === HOME, 'still showing your files')

// 4. Switching the side bar while the board is open is the user's business, not
//    ours. This is the reported break: it used to collapse the side bar you had
//    just asked for.
await settle()
record(await act(() => ctl.clickActivityIcon()))
await settle()
const viaScm = record(await act(() => ctl.clickSideBarView('workbench.view.scm')))
ok(L.sideBar === true, 'switching to Source Control while the board is open leaves the side bar OPEN')
ok(L.sideBarView === 'workbench.view.scm', 'and showing Source Control')
ok(!viaScm.includes('disposePanel:agentsKanban.panel'), 'and does not close the board')

// 5. Clicking away from the board closes it, and still nothing happens on the left.
await settle()
const viaAway = record(await act(() => ctl.setBoardPanelVisible(false)))
ok(viaAway.includes('disposePanel:agentsKanban.panel'), 'clicking away from the board closes it')
ok(L.panel === true && L.auxBar === true, 'the terminal and the chat come back')
ok(L.sideBar === true && L.sideBarView === 'workbench.view.scm',
   'and Source Control is exactly where it was left')

// 6. And so does the X on its tab.
await settle()
Object.assign(L, { sideBar: true, sideBarView: HOME, panel: true, auxBar: true })
record(await act(() => ctl.clickActivityIcon()))
await settle()
const viaX = record(await act(() => ctl.disposeBoardPanel()))
ok(L.panel === true, 'closing it with the X puts the terminal back')
ok(L.auxBar === true, 'and the chat')
ok(L.sideBar === true && L.sideBarView === HOME, 'and leaves the left side bar alone')

// 7. And with closeOnClickAway off, clicking away does NOT close it — the
//    board becomes a pure toggle. A setting that silently does nothing is worse
//    than no setting, and this one is a single early return away from that.
await settle()
Object.assign(L, { sideBar: true, sideBarView: HOME, panel: true, auxBar: true })
record(await act(() => ctl.clickActivityIcon()))
await settle()
ctl.config.closeOnClickAway = false
const stayed = record(await act(() => ctl.setBoardPanelVisible(false)))
ok(!stayed.includes('disposePanel:agentsKanban.panel'),
   'with closeOnClickAway off, clicking away leaves the board open')
ok(L.panel === false && L.auxBar === false, 'and the terminal and the chat stay away')
// Back to a toggle we can still close, so the section ends where it started.
ctl.config.closeOnClickAway = true
await settle()
record(await act(() => ctl.clickActivityIcon()))
ok(L.panel === true && L.auxBar === true && L.sideBar === true,
   'and the icon still closes it afterwards')

// 8. Opening a file FROM the board must not close the board. A test-plan link
//    and a changed-file row both open an editor. Opened into the board's own
//    group, the editor takes the group, the webview stops being visible, and
//    that is exactly the event "click away" closes on — so pressing a button
//    on the board made the board vanish, and the file appearing where it had
//    been read as "nothing happened". The seeded session is the one with a
//    worktree; every other id returns before anything opens.
await settle()
Object.assign(L, { sideBar: true, sideBarView: HOME, panel: true, auxBar: true })
record(await act(() => ctl.clickActivityIcon()))
await settle()
stub.calls.length = 0
await send({ type: 'testLink', id: SEEDED, kind: 'file', target: 'README.md' })
await settle()
ok(stub.calls.some((c) => c.startsWith('showTextDocument:')), 'a file link on the test plan opens the file')
ok(!stub.calls.includes('disposePanel:agentsKanban.panel'), 'and the board is still open')
ok(L.panel === false && L.auxBar === false, 'and still has the window — the terminal and the chat did not come back')
stub.calls.length = 0
await send({ type: 'diff', id: SEEDED, file: 'README.md' })
await settle()
ok(stub.calls.includes('exec:vscode.diff'), 'a changed-file row opens a diff')
ok(!stub.calls.includes('disposePanel:agentsKanban.panel'), 'and the board is still open after that too')
ok(L.panel === false && L.auxBar === false, 'with the window still its own')
await settle()
record(await act(() => ctl.clickActivityIcon()))
ok(L.panel === true && L.auxBar === true, 'and the icon closes it afterwards, as before')

// The rule underneath all six, stated directly: the extension has no business
// opening or closing the left side bar, so it must never issue a command that
// does. Switching it back after the icon click is `workbench.view.*`, which is
// a different thing — it hands the bar to a view without ever hiding it.
ok(!issued.includes('exec:workbench.action.closeSidebar'),
   'the extension never closes the side bar')
ok(!issued.includes('exec:workbench.action.toggleSidebarVisibility'),
   'and never toggles its visibility either — those two are what broke it')
ok(issued.includes('exec:' + HOME),
   'it does hand the side bar back after the icon click, which is the only way to undo the eviction')

// ---------------------------------------------------------------- 5. view contract
//
// The host builds a UiState; board.js draws it. Both are tested alone, and both
// can pass while disagreeing about the shape — the host renames a field, the
// view reads undefined, the panel goes blank and every test is still green.
// So: take the REAL state from above and put it through the REAL view.

console.log('\n— the real state renders through the real view')
await send({ type: 'setMode', mode: 'kanban' })
await send({ type: 'ready' })
const live = latestState()

try {
  const view = await renderBoard(live, { layout: 'full' })
  const text = view.text()
  ok(text.length > 0, 'full: the board draws something')
  for (const col of live.columns) {
    ok(text.includes(col.name), `full: column "${col.name}" is on screen`)
  }
  ok(view.posted.some((m) => m.type === 'ready'), 'full: the view announces itself')
} catch (e) {
  ok(false, `full: the view threw on the host's own state — ${e.message}`)
}

// --- a run the host never got to finish -------------------------------------
//
// The whole path, because every layer of it was capable of dropping the signal
// silently: the sidecar reader (which was already dropping contextWindow the
// same way), the host's derivation, the state it posts, and the view. A run
// killed by a restart that says nothing is indistinguishable from one that
// finished, and the difference is whether the work was ever done.
{
  const cut = (live.cards ?? []).find((c) => c.sessionId === STORED_SESSION)
  ok(cut?.interrupted === INTERRUPTED_AT,
     `a run still marked running, with no agent, comes back interrupted: ${cut?.interrupted}`)
  try {
    const view = await renderBoard(live, { layout: 'full' })
    ok(view.text().includes('Interrupted'), 'and the real view says so on the board')
  } catch (e) {
    ok(false, `the view threw on an interrupted card — ${e.message}`)
  }

  // Dismissing it is the user saying "I know" — and it must actually stick, in
  // the sidecar, or the banner is back on the next launch.
  await send({ type: 'dismissInterrupted', id: STORED_SESSION })
  await send({ type: 'ready' })
  const after = (latestState().cards ?? []).find((c) => c.sessionId === STORED_SESSION)
  ok(!after?.interrupted, 'dismissing it clears the banner')
  const onDisk = JSON.parse(await fs.readFile(
    path.join(storage, 'sessions', encodeURIComponent(repo) + '.json'), 'utf8'))
  ok(!onDisk[STORED_SESSION]?.running, 'and clears the mark on disk, so it stays dismissed')
}

// The side bar renders a control, not a board.
const boardSrc = await fs.readFile(path.join(repoRoot, 'media', 'board.js'), 'utf8')
ok(!boardSrc.includes('compact'), 'the squeezed "compact" board layout is gone')
try {
  const view = await renderBoard({ ...live, boardOpen: true }, { layout: 'control' })
  const text = view.text()
  ok(text.includes('Board is open'), 'the side bar says the board is open')
  ok(text.includes('Close board'), 'and offers to close it — the quick toggle')
  ok(!live.columns.every((c) => text.includes(c.name)),
     'and does NOT redraw the columns beside the real board')
} catch (e) {
  ok(false, `the side bar control threw on the host's own state — ${e.message}`)
}

// The same for chat mode, which draws an entirely different tree.
await send({ type: 'setMode', mode: 'chat' })
await send({ type: 'ready' })
const chatState = latestState()
try {
  const view = await renderBoard(chatState, { layout: 'full' })
  ok(view.text().includes('Start a session'), 'chat mode draws the new-session hint')
} catch (e) {
  ok(false, `chat mode threw on the host's own state — ${e.message}`)
}

// A repaint is driven by the agent stream, and the stream is a firehose.
//
// Reported as "it worked for four and a half minutes and I could not tell what
// it was doing". `refreshAll()` is called on every event an agent produces —
// every streamed token included — and it used to do the whole job each time,
// TWICE: the side bar and the panel each called `getState()`, which reads
// Claude Code's session index (~40ms on a 20-session store, ~104ms on 60) and
// serialises the entire transcript. The extension host cannot keep up with that
// at any real streaming rate, and it is the same event loop that drains the
// CLI's stdout and answers `canUseTool` — so the board lagging and the agent
// running slowly were one bug, not two.
//
// This asserts on the property that fixes it: a burst of host events produces a
// bounded number of paints, not one per event.
console.log('\n— a burst of events does not become a burst of repaints')
{
  const paints = () => stub.posted.filter((m) => m.type === 'state').length
  const BURST = 30
  const before = paints()
  for (let i = 0; i < BURST; i++) await send({ type: 'archive', id: 'no-such-session', archived: false })
  // `send` delivers to every wired webview, so the burst is a multiple of this.
  const events = BURST * Math.max(1, stub.handlers.length)
  // Long enough for the trailing repaint to land: a rate limiter that drops the
  // final update leaves the board showing a stale turn forever, which is worse
  // than the lag it was meant to fix.
  await new Promise((r) => setTimeout(r, 400))
  const drawn = paints() - before
  ok(drawn > 0, 'the burst still paints — coalescing must never mean silence')
  ok(drawn < events / 3, `${events} events produced ${drawn} paints, not one each`)
}

// -------------------------------------------------------------- 6. providers
//
// Two seams, and both are the kind that stay silent when they break.
//
// The first is a SECURITY seam: a provider profile is written to settings.json,
// which syncs between machines and can be committed in a `.vscode/` directory,
// and its credential must go to SecretStorage instead. Both stores are real in
// the harness precisely so this can be checked in both directions — a stub that
// swallowed writes would let "the API key went into settings" pass.
//
// The second is the usual host↔view one: the composer gained fields, and the
// view reads them. Either side can be right alone while they disagree.

console.log('\n— providers: the picker, and where the credential goes')
{
  await send({ type: 'setMode', mode: 'chat' })
  await send({ type: 'ready' })
  const before = latestState().composer
  ok(before.provider === 'inherit',
     'a fresh install is on "inherit" — it changes nothing about how the CLI resolves its provider')
  ok((before.providers ?? []).some((p) => p.id === 'inherit'),
     'and that profile is always offered, so there is never nothing to select')
  ok(Array.isArray(before.models) && before.models.length > 0,
     'the model picker still has entries on the default profile')

  // Drive the real "Add a provider" flow through the real command, answering
  // the quick pick and every input box the way a person would.
  const CREDENTIAL = 'sk-smoke-secret-value'
  // Matched by PREFIX, not by the full label. The parenthetical after a preset
  // name is prose — it went from "LiteLLM proxy" to "LiteLLM proxy
  // (translator)" when OpenRouter and Ollama stopped needing one — and an
  // exact match turns that copy edit into a silent no-op: the pick returns
  // undefined, the whole add-a-provider flow does nothing, and six assertions
  // below fail with "0 entry" pointing at nothing in particular.
  ctl.quickPick = (items) => items.find((i) => i.label.startsWith('LiteLLM proxy'))
  ctl.inputBox = (opts) => {
    const t = String(opts?.title ?? '')
    if (t.includes('Base URL')) return 'http://localhost:4000'
    if (t.includes('Credential')) return CREDENTIAL
    // A gateway that serves its own models — the case where the built-in Claude
    // list is simply wrong, and the picker has to follow.
    if (t.includes('Model ids')) return 'qwen3-coder, us.anthropic.claude-haiku-4-5-20251001-v1:0'
    if (t.includes('Context window')) return '128000'
    return ''
  }
  await stub.cmds.get('agentsKanban.addProvider')()

  // --- where the credential went, and where it did NOT ---------------------
  const saved = ctl.config.providers ?? []
  ok(saved.length === 1, `the profile was written to settings (${saved.length} entry)`)
  ok(saved[0]?.kind === 'gateway' && saved[0]?.baseUrl === 'http://localhost:4000',
     'with the endpoint that was typed')
  ok(saved[0]?.hasCredential === true, 'and a flag recording that a credential exists')
  ok(!JSON.stringify(saved).includes(CREDENTIAL),
     'but the credential itself is NOWHERE in settings — that file syncs, and can be committed')
  ok(!saved.some((p) => 'inherit' === p.id),
     'and the synthesised inherit profile is not written back, which would duplicate on every save')

  // ctx3 is the live activation — section 4 re-activated onto it, and secret
  // storage belongs to the context, as it does in the real editor.
  const keys = [...ctx3._secrets.keys()]
  ok(keys.length === 1, `the credential went to secret storage instead (${keys.length} key)`)
  ok(ctx3._secrets.get(keys[0]) === CREDENTIAL,
     'and it reads back intact — a write with no round trip is not persistence')
  ok(!!keys[0]?.includes(saved[0].id),
     'under a key derived from the profile, so two profiles cannot share one')

  // --- and the board now offers it -----------------------------------------
  await send({ type: 'ready' })
  const after = latestState().composer
  ok(after.provider === saved[0].id, 'the new provider became active')
  ok((after.providers ?? []).some((p) => p.id === saved[0].id), 'and is listed in the picker')
  ok((after.providers ?? []).some((p) => p.detail?.includes('localhost:4000')),
     'described by where it is, which is the only distinguishing thing about a gateway')

  // The model picker is per-provider, and the selection has to follow it. Left
  // alone, `claude-opus-5` stays selected under a gateway that has never heard
  // of it: a nameless entry in the picker, then a failure at the first API call
  // phrased by somebody else's system.
  ok(after.models.length === 2, `the picker now offers the gateway's own models (${after.models.length})`)
  ok(after.models.some((m) => m.id === 'qwen3-coder'), 'including one that is not a Claude model at all')
  ok(after.model === 'qwen3-coder',
     `the selection followed the provider instead of being stranded (${after.model})`)
  // Labels and windows stay derived, so a provider-shaped Claude id still reads
  // as the model it is and measures against the same window as first-party.
  const bedrockish = after.models.find((m) => m.id.startsWith('us.anthropic.'))
  ok(bedrockish?.label === 'Haiku 4.5',
     `a provider-shaped Claude id still reads as its model (${bedrockish?.label})`)
  ok(bedrockish?.context === '200K', 'and against the window the context meter uses')
  ok(after.models.find((m) => m.id === 'qwen3-coder')?.context === '128K',
     'while an unknown model takes the window the profile declared')
  ok(!JSON.stringify(after).includes(CREDENTIAL),
     'and no credential is serialised to the webview, which is another program')

  // --- the real view draws it ----------------------------------------------
  try {
    const view = await renderBoard(latestState(), { layout: 'full' })
    const text = view.text()
    // ONE list of things you can run on, and the entry names both halves: the
    // backend (what distinguishes it) and, underneath, the agent program and
    // the endpoint. Two pickers made this a cross product the user had to do in
    // their head, and the bar showed only one half of it.
    ok(text.includes('LiteLLM'), 'the real view names the combination the next session runs on')
    const agents = latestState().composer.agents ?? []
    ok(agents.some((a) => a.key === `claude|${saved[0].id}` && a.detail.includes('localhost:4000')),
       'and the menu entry carries the endpoint, so which models it serves is explicable')
    ok(agents.some((a) => a.key === 'claude|inherit'),
       'with the default backend as its own entry beside it — the two are separate things to run on')
    ok(!text.includes(CREDENTIAL), 'and never the credential')
  } catch (e) {
    ok(false, `the view threw on a state with a provider — ${e.message}`)
  }

  /* --- an agent that is not installed is not offered ------------------------
   *
   * Reported, with feeling: "the OpenAI Codex shouldn't even appear because I
   * didn't download the app in the first place and I didn't even log in to it."
   * Fair. It was on the composer as a peer of the agent doing all the work, and
   * picking it would have made every session fail at its first step.
   *
   * ABSENT means "we know it is missing". NOT CHECKED still shows, because
   * hiding something we have not looked for is the same mistake as asserting a
   * state we did not read.
   */
  {
    const listed = () => (latestState().composer.agents ?? []).map((a) => a.key)
    /* Looking for an executable is real I/O — `which`, and a `--version` for
       Codex — and the settings listener starts it without waiting. So this
       polls for the answer rather than sleeping a guessed number of
       milliseconds, which is the difference between a gate and a flake. */
    const settle = async (want) => {
      for (let i = 0; i < 60; i++) {
        await send({ type: 'ready' })
        if (listed().some((k) => k.startsWith('codex|')) === want) return
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    ok(listed().some((k) => k.startsWith('claude|')),
       `Claude Code is offered (${listed().join(', ')})`)

    /* Hermetic, and it has to be: `detect()` shells out to `which`, so a gate
       that asked the machine would pass or fail depending on whose machine it
       was. `codexExecutable` is the real setting people use to point at a
       binary the search would miss, so pointing it at THIS process's own node
       is a Codex that exists, and at a path that does not is one that does
       not. Both go through the same code a user's setting does. */
    await ctl.changeConfig({ codexExecutable: process.execPath })
    await settle(true)
    ok(listed().some((k) => k.startsWith('codex|')),
       `an agent that IS installed is offered (${listed().join(', ')})`)

    await ctl.changeConfig({ codexExecutable: path.join(repo, 'no-such-codex') })
    await settle(false)
    ok(!listed().some((k) => k.startsWith('codex|')),
       `and one this machine does not have is not (${listed().join(', ')})`)
    ok(listed().some((k) => k.startsWith('claude|')),
       'while the agent that IS here stays')
    await ctl.changeConfig({ codexExecutable: '' })
  }

  /* --- A SESSION KEEPS WHAT IT IS RUNNING ON ------------------------------
   *
   * Reported: "if I switch chats, the models that are working on it should stay
   * selected — it shouldn't change, then it gets confusing, because I go to
   * that chat and it shows as if Claude was working on it, not deepseek."
   *
   * Exactly right. The composer was built from the WORKSPACE DEFAULT and never
   * looked at the session in front of it, so opening a card that had been on
   * `deepseek-v4-pro` all morning said "Claude Code · Opus 5". The fields were
   * on `SessionMeta` and were parsed on the way back in — nothing ever wrote
   * them, and nothing ever read them. A whole feature that existed only as
   * types, which is the mirror of the write-with-no-round-trip rule.
   */
  {
    // A card launched on the gateway, with a model only that backend serves.
    ctx3._globalState.set(`endpointModels:${saved[0].id}`, [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 128000, rate: { input: 0.28, output: 0.42 } },
    ])
    ok(saved[0].id === 'litellm',
       `the seeded card points at a backend that exists (${saved[0].id})`)

    // The workspace default is something else entirely.
    await send({ type: 'composer', provider: 'inherit' })
    await send({ type: 'ready' })
    const dflt = latestState().composer
    ok(dflt.model !== 'deepseek-v4-pro',
       `the workspace default is a different model (${dflt.model})`)

    await send({ type: 'setMode', mode: 'chat' })
    await send({ type: 'select', id: ON_GATEWAY })
    await send({ type: 'ready' })
    const open = latestState().composer
    ok(open.model === 'deepseek-v4-pro',
       `opening the card shows the model that is working on it (${open.model})`)
    ok(open.provider === saved[0].id,
       `and the backend it is on, not the active one (${open.provider})`)
    ok(open.agent === `claude|${saved[0].id}`,
       `so the agent chip names that combination (${open.agent})`)
    ok(open.effort === 'low', `and the effort it was launched with (${open.effort})`)
    ok(open.models.some((m) => m.id === 'deepseek-v4-pro'),
       'with a model list from THAT backend — not the active one, which has never served it')
    ok(open.agentLocked === true,
       'and the agent chip is a readout, not a picker: a started session cannot change agent or backend')

    // Switching away and back must not move it.
    await send({ type: 'select', id: STORED_SESSION })
    await send({ type: 'ready' })
    await send({ type: 'select', id: ON_GATEWAY })
    await send({ type: 'ready' })
    ok(latestState().composer.model === 'deepseek-v4-pro',
       'and it is still there after switching to another chat and back')

    // A card with nothing recorded — every session that predates this — falls
    // through to the workspace default rather than showing a blank.
    await send({ type: 'select', id: STORED_SESSION })
    await send({ type: 'ready' })
    const old = latestState().composer
    ok(!!old.model && old.models.some((m) => m.id === old.model),
       `a session from before this was recorded still shows a usable model (${old.model})`)
    ok(old.agentLocked !== true || !!old.agent, 'and still names something to be running on')

    // Deselect: back to the default, because THAT is what a new session gets.
    await send({ type: 'select', id: '' })
    await send({ type: 'setMode', mode: 'kanban' })
    await send({ type: 'ready' })
    ok(latestState().composer.agentLocked === false,
       'with nothing selected the agent picker is a picker again — a new session can choose')

    // Put the board back where the rest of this file found it: a chat, with the
    // card the earlier sections use. A gate that leaves the window somewhere
    // else makes the next section's failure about this one.
    ctx3._globalState.delete(`endpointModels:${saved[0].id}`)
    await send({ type: 'setMode', mode: 'chat' })
    await send({ type: 'select', id: SEEDED })
    await send({ type: 'ready' })
  }

  // --- switching back -------------------------------------------------------
  await send({ type: 'composer', provider: 'inherit' })
  await send({ type: 'ready' })
  const back = latestState().composer
  ok(back.provider === 'inherit', 'the picker switches back')
  ok(back.models.some((m) => m.id === 'claude-opus-5'), 'and the built-in model list comes back with it')
  ok(back.models.some((m) => m.id === back.model),
     `the selection is valid again rather than left on the gateway's id (${back.model})`)
  ok(ctx3._secrets.size === 1,
     'and switching away does not delete the credential — the profile is still there to switch back to')

  // --- controls a model does not have must DISAPPEAR ------------------------
  //
  // Host↔view, and the reason it is here rather than only in a unit test: the
  // host decides which controls apply and the view draws them, and both sides
  // passed for months while Haiku 4.5 — which accepts no effort levels and has
  // no adaptive thinking — was shown a five-level effort picker and an On/Off
  // toggle. Two controls that could not say no.
  try {
    const base = latestState()
    const capable = await renderBoard(base, { layout: 'full' })
    ok(capable.text().includes('Extended:'), 'a model with adaptive thinking gets the toggle')

    const limited = {
      ...base,
      composer: {
        ...base.composer,
        models: [{ id: 'haiku', label: 'Haiku', context: '200K', detail: 'Fastest for quick answers' }],
        model: 'haiku',
        efforts: [],
        thinkingSupported: false,
        modelSource: 'cli',
      },
    }
    const view = await renderBoard(limited, { layout: 'full' })
    const text = view.text()
    ok(text.includes('Haiku'), 'the limited model still renders')
    ok(!text.includes('Extended:'), 'but the thinking toggle is gone, not greyed out')
    ok(!/\bxHigh\b/.test(text), 'and so is the effort picker it does not accept')
  } catch (e) {
    ok(false, `the view threw on a model with no effort or thinking — ${e.message}`)
  }

  // --- ultracode: offered only where it can actually run --------------------
  //
  // The flag path validates NOTHING — measured against a real CLI,
  // `applyFlagSettings()` resolves for `ultracode: true` on a model with no
  // xhigh, for `ultracode: 'banana'`, and for a key that does not exist. So the
  // model's own capability is the only check available before the run starts,
  // and it has to hold on both sides: the view must not draw the toggle, and
  // the host must refuse it even if a stale webview posts one.
  try {
    const base = latestState()
    const capable = {
      ...base,
      composer: {
        ...base.composer,
        models: [{ id: 'opus[1m]', label: 'Opus (1M context)', context: '1M' }],
        model: 'opus[1m]', ultracodeSupported: true, ultracode: false,
        fastModeSupported: true, fastMode: false,
      },
    }
    ok((await renderBoard(capable, { layout: 'full' })).text().includes('Ultracode'),
       'an xhigh-capable model is offered ultracode')
    ok((await renderBoard(capable, { layout: 'full' })).text().includes('Fast'),
       'and fast mode when the CLI reports it')

    const incapable = {
      ...base,
      composer: {
        ...base.composer,
        models: [{ id: 'haiku', label: 'Haiku', context: '200K' }],
        model: 'haiku', ultracodeSupported: false, ultracode: false,
        fastModeSupported: false, fastMode: false, efforts: [], thinkingSupported: false,
      },
    }
    const off = (await renderBoard(incapable, { layout: 'full' })).text()
    ok(!off.includes('Ultracode'),
       'and a model that cannot run xhigh is not offered it — the toggle would do nothing')
    ok(!off.includes('Fast:'), 'nor fast mode')

    // Turning it on replaces the effort picker rather than sitting beside it:
    // ultracode IS xhigh, and two controls arguing over one value is worse
    // than one.
    const on = {
      ...capable,
      composer: { ...capable.composer, ultracode: true, efforts: [] },
    }
    const onText = (await renderBoard(on, { layout: 'full' })).text()
    ok(onText.includes('Ultracode: On'), 'with it on, the chip says so')
    ok(!/\bxHigh\b/.test(onText), 'and the effort picker steps aside, because ultracode owns effort')
  } catch (e) {
    ok(false, `the view threw on the ultracode toggle — ${e.message}`)
  }

  // The host half of the same gate. A webview rendered before a model switch
  // can post a flag the new model cannot run; the host must not take its word.
  await send({ type: 'composer', model: 'claude-opus-5' })
  await send({ type: 'composer', ultracode: 'on' })
  await send({ type: 'ready' })
  ok(latestState().composer.ultracode !== true,
     'the host refuses ultracode on a model it has not confirmed can run it')

  // --- the model cache: the seam both model bugs lived in --------------------
  //
  // `globalState` outlives the extension VERSION that wrote it, and the cached
  // catalogue is read back on the RENDER path. Two bugs have lived here and
  // neither was visible from a unit test:
  //
  //  1. The cached list was composed with the profile's declared list in the
  //     wrong order, so the CLI's answer was discarded and the picker showed
  //     the built-in three. Every unit was green.
  //  2. A cache written by a build with a different `ModelChoice` shape reached
  //     the composer as `undefined.includes(...)` — a throw inside `getState()`,
  //     which this project knows as a silently blank panel.
  //
  // The harness now has a real `globalState` for exactly this. Both of these
  // drive the BUILT bundle.
  {
    // Keyed by RUNTIME as well as profile. The models a picker may offer are
    // per agent program AND per backend — keying on the profile alone filed
    // Codex's `gpt-5.5` under `inherit` and handed it back to the next Claude
    // session. This string must match `catalogueKey()` in extension.ts; a
    // mismatch is a cache that is written and never read, which is the failure
    // `contextWindow` already has a postmortem about.
    const KEY = 'models:claude:inherit'
    const cached = [
      { id: 'default', label: 'Default (recommended)', context: '1M', detail: 'Opus 5 with 1M context',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'], thinking: true, ultracode: true, fastMode: true },
      { id: 'claude-fable-5[1m]', label: 'Fable', context: '1M',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'], thinking: true, ultracode: true, fastMode: false },
      { id: 'haiku', label: 'Haiku', context: '200K',
        efforts: [], thinking: false, ultracode: false, fastMode: false },
    ]

    // 1. A good cache must reach the picker. This is the bug that shipped: the
    //    inherit profile declares no models, and that must NOT outrank it.
    //
    //    The catalogue is rebuilt on activation and on a provider CHANGE, not on
    //    every repaint — so seeding the cache and asking for the same provider
    //    again would test nothing. Switch away and back, which is the real
    //    sequence a user goes through.
    ctx3._globalState.set(KEY, cached)
    await send({ type: 'composer', provider: saved[0].id })
    await send({ type: 'composer', provider: 'inherit' })
    await send({ type: 'ready' })
    const c = latestState().composer
    ok(c.models.length === 3, `the cached list reaches the picker (${c.models.length} models)`)
    ok(c.models.some((m) => m.label === 'Fable'),
       'including Fable — a profile that declares nothing must not outrank the CLI')
    ok(c.modelSource === 'cli', `and it is reported as coming from the CLI (${c.modelSource})`)

    // 2. Capabilities survive the round trip, or the toggles are decoration.
    await send({ type: 'composer', model: 'haiku' })
    await send({ type: 'ready' })
    const haiku = latestState().composer
    ok(haiku.efforts.length === 0, 'a cached model with no effort levels still has none after a reload')
    ok(haiku.thinkingSupported === false, 'and no thinking toggle')
    ok(haiku.ultracodeSupported === false, 'and no ultracode')

    await send({ type: 'composer', model: 'default' })
    await send({ type: 'ready' })
    const opus = latestState().composer
    ok(opus.efforts.length === 5, 'while a capable one keeps all five levels')
    ok(opus.ultracodeSupported === true, 'and its ultracode')

    // 3. A cache from a build whose ModelChoice had a different shape. This is
    //    the crash: getState() throws and the panel goes blank with no error.
    for (const [what, junk] of [
      ['an older shape, before the capability fields', [{ id: 'opus[1m]', label: 'Opus', context: '1M' }]],
      ['a non-array', 'nonsense'],
      ['entries that are not objects', [null, 3]],
      ['efforts that is not an array', [{ id: 'a', label: 'A', context: '1M', efforts: 'all', thinking: true, ultracode: false, fastMode: false }]],
    ]) {
      ctx3._globalState.set(KEY, junk)
      // Seeding the cache is not enough: the catalogue is rebuilt on a provider
      // CHANGE, not on every repaint, so without this switch the assertions
      // below run against the catalogue from the PREVIOUS case and prove
      // nothing. The switch also runs `alignModelToProvider`, which moves the
      // selection onto the first cached entry — so the selected model becomes
      // the malformed one, which is exactly how a real user reaches the crash.
      await send({ type: 'composer', provider: saved[0].id })
      await send({ type: 'composer', provider: 'inherit' })
      // Count the states POSTED, not just the last one seen. `latestState()`
      // reverse-finds the most recent `state` message, so when `getState()`
      // throws nothing new is posted and it quietly returns the PREVIOUS one —
      // which every assertion below then passes against. That is not a
      // hypothetical: it is why the first version of this gate survived having
      // the shape check deleted.
      const before = stub.posted.filter((m) => m.type === 'state').length
      let state
      try {
        await send({ type: 'ready' })
        state = latestState()
      } catch (e) {
        ok(false, `getState() threw on ${what} — that is the blank panel: ${e.message}`)
        continue
      }
      ok(stub.posted.filter((m) => m.type === 'state').length > before,
         `${what}: a state was posted after the reload`)
      ok(!!state?.composer, `${what}: the board still renders`)
      // The precondition, asserted rather than assumed. Everything below is
      // about the INHERIT profile's cache, and an earlier version of this loop
      // silently measured the gateway profile instead because the two provider
      // switches had not settled — passing for the wrong reason, which is worse
      // than failing.
      ok(state.composer.provider === 'inherit',
         `${what}: the board is on the inherit profile (${state.composer.provider})`)
      // The discriminating assertion: a cache this build cannot read must fall
      // THROUGH to the built-in list. Trusted instead of parsed, the junk would
      // satisfy `mergeModels`' "discovered" branch and be reported as `cli`.
      ok(state.composer.modelSource === 'builtin',
         `${what}: an unreadable cache falls back to the built-in list (${state.composer.modelSource})`)
      ok(state.composer.models.length > 0, `${what}: and the picker is not empty`)
      ok(Array.isArray(state.composer.efforts), `${what}: efforts is still a list, so the composer cannot throw`)
      ok(state.composer.models.every((m) => m && typeof m.id === 'string' && m.id
                                     && typeof m.label === 'string'),
         `${what}: every entry that reached the picker is a real model`)
      try {
        await renderBoard(state, { layout: 'full' })
      } catch (e) {
        ok(false, `${what}: the real view threw — ${e.message}`)
      }
    }
    ctx3._globalState.delete(KEY)
    await send({ type: 'composer', model: 'claude-opus-5' })
    await send({ type: 'ready' })

    /* --- WHAT THE ENDPOINT ITSELF SERVES ---------------------------------
     *
     * The bug this gate is named after, driven end to end through the built
     * bundle. A real profile from a real settings.json:
     *
     *   { id: "openrouter", kind: "gateway",
     *     baseUrl: "https://api.deepseek.com/anthropic",
     *     models: ["default","opus[1m]","claude-fable-5-1[1m]","sonnet","sonnet[1m]","haiku"] }
     *
     * Nobody typed those six. The provider test read them from
     * `Query.supportedModels()` — Claude Code's own list, which answers for
     * Claude Code however `ANTHROPIC_BASE_URL` is pointed — offered to "use
     * these models in the picker", and saved them. A declared list outranks
     * everything, so the composer offered six models that endpoint has never
     * served and no way to select one it does. The owner's report: "I literally
     * don't have access to it in my options."
     *
     * Hermetic: the catalogue is seeded into the same `globalState` key the
     * host writes, so nothing here touches the network. The key string is the
     * seam — a mismatch with `endpointKey()` is a cache written and never read,
     * which this project already has a postmortem about.
     */
    {
      const gw = saved[0].id
      ctx3._globalState.set(`endpointModels:${gw}`, [
        { id: 'deepseek-chat', label: 'DeepSeek Chat', contextWindow: 128000,
          rate: { input: 0.28, output: 0.42 } },
        { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextWindow: 128000,
          rate: { input: 0.55, output: 2.19 } },
      ])
      // The gateway profile still declares `qwen3-coder` and a Bedrock-shaped
      // Claude id from the add-a-provider flow above. This endpoint serves
      // neither, which is exactly the state the bug leaves behind.
      await send({ type: 'composer', provider: 'inherit' })
      await send({ type: 'composer', provider: gw })
      await send({ type: 'ready' })
      const c = latestState().composer

      ok(c.modelSource === 'endpoint',
         `the list comes from the endpoint, not from Claude Code (${c.modelSource})`)
      ok(c.models.map((m) => m.id).join() === 'deepseek-chat,deepseek-reasoner',
         `the picker offers what the endpoint serves (${c.models.map((m) => m.id).join()})`)
      ok(!c.models.some((m) => /sonnet|haiku|opus|qwen/.test(m.id)),
         'and nothing the endpoint has never heard of')
      ok(c.model === 'deepseek-chat',
         `the selection followed instead of being stranded on a dead id (${c.model})`)
      ok(!!c.modelNote && c.modelNote.includes('localhost:4000'),
         `and it SAYS so, naming the endpoint — a setting overruled in silence is the next surprise (${c.modelNote})`)
      ok((c.modelNote ?? '').length < 90,
         `in one line, because it is a menu footer and not a report (${(c.modelNote ?? '').length} chars)`)

      // The two facts that make a list of ids a choice. Both are absent from
      // the built-in tables for every model this extension has never heard of,
      // and both are what the endpoint publishes about itself.
      const chat = c.models.find((m) => m.id === 'deepseek-chat')
      ok(chat?.context === '128K' && chat?.contextTokens === 128000,
         `each model carries its window as a label AND as the meter's denominator (${chat?.context})`)
      ok(chat?.price === '$0.28/$0.42 per Mtok', `and its published price (${chat?.price})`)

      // The real view, on the real state. Either side can be right alone.
      try {
        const view = await renderBoard(latestState(), { layout: 'full' })
        ok(view.text().includes('DeepSeek Chat'), 'the real view names the endpoint\u2019s model')
      } catch (e) {
        ok(false, `the view threw on an endpoint-sourced catalogue — ${e.message}`)
      }

      /* --- and the settings page can narrow it -------------------------- */
      // The note above tells the user to pick the ones they want in Settings,
      // so that has to be a real place where a real message does a real thing.
      stub.cmds.get('agentsKanban.openSettings')()
      await new Promise((r) => setTimeout(r, 0))
      ok(!!ctl.settings, 'the settings tab opens as its own panel, not as a second board')
      await ctl.settings.send({ type: 'ready' })
      const page = ctl.settings.state()
      const card = (page?.providers ?? []).find((p) => p.id === gw)
      ok((card?.models ?? []).length === 2,
         `the page lists what the endpoint serves (${(card?.models ?? []).length})`)
      ok(card?.models?.[0]?.price === '$0.28/$0.42 per Mtok', 'with the price, formatted once, host-side')
      ok(card?.models?.every((m) => m.offered === false),
         'none of them ticked yet — the profile still declares the ids the endpoint does not serve')

      await ctl.settings.send({ type: 'setProfileModels', id: gw, models: ['deepseek-reasoner'] })
      const declared = (ctl.config.providers ?? []).find((p) => p.id === gw)?.models
      ok(JSON.stringify(declared) === JSON.stringify(['deepseek-reasoner']),
         `ticking one writes it to the profile (${JSON.stringify(declared)})`)
      await send({ type: 'ready' })
      const pinned = latestState().composer
      ok(pinned.models.length === 1 && pinned.models[0].id === 'deepseek-reasoner',
         `and the composer follows immediately (${pinned.models.map((m) => m.id).join()})`)
      ok(pinned.modelSource === 'profile' && !pinned.modelNote,
         'reported as the profile\u2019s own list, with nothing left to warn about')
      ok(pinned.model === 'deepseek-reasoner',
         `with the selection moved onto it (${pinned.model})`)

      // Untick everything: back to the whole catalogue, not to an empty picker.
      await ctl.settings.send({ type: 'setProfileModels', id: gw, models: [] })
      await send({ type: 'ready' })
      const all = latestState().composer
      ok(all.models.length === 2 && all.modelSource === 'endpoint',
         'unticking everything offers the whole catalogue again rather than nothing')
      ok(!(ctl.config.providers ?? []).find((p) => p.id === gw)?.models,
         'and the key is REMOVED from settings, not left as an empty list that parses back as undefined')

      // Put the board back where the rest of this file expects it. The
      // provider switch finishes its model refresh asynchronously, so a `ready`
      // is what makes the next `latestState()` the state AFTER the switch
      // rather than the one before it.
      ctx3._globalState.delete(`endpointModels:${gw}`)
      await send({ type: 'composer', provider: 'inherit' })
      await send({ type: 'ready' })
      ok(latestState().composer.modelSource === 'builtin',
         'and with the endpoint forgotten, the picker falls back rather than remembering a list it can no longer justify')
    }
  }

  // --- where the model list came from --------------------------------------
  // Only shown when it is NOT the CLI's, because that is the only case with a
  // question attached: "why is the model I use in Claude Code missing here?"
  try {
    const base = latestState()
    const fallback = {
      ...base,
      composer: { ...base.composer, modelSource: 'builtin', modelNote: 'the CLI did not answer' },
    }
    const view = await renderBoard(fallback, { layout: 'full' })
    // The note lives INSIDE the model menu, which is where the question gets
    // asked — a permanent chip on the bar would be noise every other minute.
    // So the menu has to be opened, which is also a check that the picker is
    // clickable at all.
    const buttons = walkNodes(view.root).filter(
      (n) => (n.className || '').split(' ').includes('picker') && /Opus|Model|Haiku/.test(n.textContent ?? ''),
    )
    ok(buttons.length > 0, 'the model picker is on the bar')
    buttons[0].onclick({ stopPropagation() {} })
    const opened = view.text()
    ok(opened.includes('Built-in list'),
       'opening it says the list is the fallback, so a missing model is answerable rather than a mystery')
    ok(opened.includes('the CLI did not answer'), 'and says why we could not ask')
  } catch (e) {
    ok(false, `the view threw on a fallback model list — ${e.message}`)
  }

  // --- a disagreement is shown, not swallowed ------------------------------
  //
  // The one signal that makes any of this trustworthy: the CLI can be on a
  // different backend than the profile asked for, and the bar has to say so.
  try {
    const state = latestState()
    const withNote = {
      ...state,
      composer: { ...state.composer, providerNote: 'asked for Amazon Bedrock, but the CLI is on Anthropic API' },
    }
    const view = await renderBoard(withNote, { layout: 'full' })
    ok(view.text().includes('but the CLI is on'),
       'a provider disagreement reaches the screen rather than only the log')
  } catch (e) {
    ok(false, `the view threw on a provider note — ${e.message}`)
  }
}

// ---------------------------------------------------------------------- teardown

ext.deactivate()
await fs.rm(claudeHome, { recursive: true, force: true })
await fs.rm(repo, { recursive: true, force: true })
await fs.rm(storage, { recursive: true, force: true })
console.log(fails === 0 ? '\nPASS — the built extension activates, wires up and renders' : `\n${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
