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
import { renderBoard } from './test/dom.mjs'

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
  }),
)

const ctl = {
  repo,
  noFolder: false,
  config: { model: 'claude-opus-5', maxConcurrentAgents: 3, permissionMode: 'acceptEdits', worktreeRoot: '' },
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

// Every script that needs dependencies must run the preflight first, or it
// fails with the original cryptic message instead of the useful one.
for (const name of ['verify', 'verify:package', 'build']) {
  ok((scripts[name] ?? '').includes('preflight'), `${name} runs the preflight before anything else`)
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
ok(Math.abs((sel?.composer?.spentUsd ?? 0) - STORED_COST) < 1e-9,
   `and its spend is priced from those tokens: $${sel?.composer?.spentUsd} (expected $${STORED_COST})`)
ok(sel?.composer?.spendPriced === true, 'with every model in it priced')
// The dedupe, end to end: the two frames of one response must be billed once.
ok((sel?.composer?.spentUsd ?? 0) < STORED_COST * 1.5,
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
const bogus = await ctl.contentProvider
  .provideTextDocumentContent({ path: '/nope.ts', query: '' })
  .catch((e) => `THREW: ${e.message}`)
ok(bogus === '', `an unresolvable base version yields empty, not a throw (${JSON.stringify(bogus)})`)

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

// ---------------------------------------------------------------------- teardown

ext.deactivate()
await fs.rm(claudeHome, { recursive: true, force: true })
await fs.rm(repo, { recursive: true, force: true })
await fs.rm(storage, { recursive: true, force: true })
console.log(fails === 0 ? '\nPASS — the built extension activates, wires up and renders' : `\n${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
