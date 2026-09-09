/** A fake VS Code, good enough to activate the built bundle and talk to it.
 *
 * The unit tests cover pieces; this covers the thing the user actually presses.
 * It exists because every "it didn't even launch" bug so far lived in the seam
 * between the manifest, activation, the host and the webview — a seam no unit
 * test crosses.
 *
 * The two capabilities that matter and that a plain stub does not give you:
 *
 *  - it CAPTURES the webview's message handler, so a test can post `ready` and
 *    drive the real host, and
 *  - it CAPTURES what the host posts back, so a test can assert on the real
 *    UiState instead of a hand-written fixture that has quietly drifted.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** A throwaway git repository, because agents need a real one to make worktrees in. */
export async function makeRepo(prefix = 'ck-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  const g = (args) => exec('git', args, { cwd: dir })
  await g(['init', '-b', 'main'])
  await g(['config', 'user.email', 't@e.com'])
  await g(['config', 'user.name', 'T'])
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n')
  await g(['add', '-A'])
  await g(['commit', '-m', 'init'])
  return dir
}

const disposable = { dispose() {} }

/**
 * Build the stub. `ctl` is live state the caller can mutate between activations
 * (`ctl.noFolder = true` reproduces the regression where registration used to
 * depend on a folder being open).
 */
export function makeVscodeStub(ctl) {
  const calls = []
  const cmds = new Map()

  /**
   * The workbench areas, as STATE.
   *
   * Asserting on command names cannot catch a layout bug, and did not: closing
   * with `closeSidebar` and restoring with `toggleSidebarVisibility` reads as a
   * tidy symmetric pair, and is not one, because the icon click that triggers
   * the restore reopens the side bar first — so the toggle closed it. Every
   * assertion in the suite was green while the left side bar vanished on
   * essentially every path.
   *
   * So the stub models what the commands DO, the tests assert on where the
   * window ended up, and a pair of commands that does not cancel out shows up
   * as a side bar that is not where the user left it.
   */
  const KANBAN_CONTAINER = 'agentsKanban'
  const layout = {
    sideBar: true,
    /** The activity-bar container the side bar is showing. */
    sideBarView: 'workbench.view.explorer',
    /** The bottom panel — terminal, problems, output. */
    panel: true,
    /** The secondary side bar on the right, where Claude Code lives. */
    auxBar: true,
  }
  ctl.layout = layout

  /** Set by registerWebviewViewProvider: push `layout` into the view's own
   *  `visible`, and fire onDidChangeVisibility if it actually changed. */
  let syncBoardView = () => {}

  /** What the workbench commands this extension issues actually do. */
  const applyLayoutCommand = (id) => {
    if (id === 'workbench.action.closePanel') layout.panel = false
    else if (id === 'workbench.action.togglePanel') layout.panel = !layout.panel
    else if (id === 'workbench.action.closeAuxiliaryBar') layout.auxBar = false
    else if (id === 'workbench.action.toggleAuxiliaryBar') layout.auxBar = !layout.auxBar
    else if (id === 'workbench.action.closeSidebar') layout.sideBar = false
    else if (id === 'workbench.action.toggleSidebarVisibility') layout.sideBar = !layout.sideBar
    else if (id.startsWith('workbench.view.')) { layout.sideBar = true; layout.sideBarView = id }
    else return
    syncBoardView()
  }
  /** Every message the host posted to a webview, newest last. */
  const posted = []
  /** The host's inbound message handlers, one per webview surface. */
  const handlers = []
  /** `onDidChangeConfiguration` listeners, so a test can edit a setting the way
   *  a person does. Stubbed to nothing, every path that re-derives state from a
   *  settings change was unreachable from a test. */
  const configListeners = []
  const infos = []
  const errors = []
  const folders = [{ uri: { fsPath: ctl.repo ?? '' }, name: 'proj', index: 0 }]

  /* `own`, when given, ALSO collects this surface's handler.
     The host now answers each surface with its own state — the side bar, the
     editor panel and a remote page can be looking at three different sessions
     — so a test has to be able to speak AS one surface rather than to all of
     them at once. `handlers` keeps every one, because `send()` fanning out to
     both webviews is what most of the suite means by "the user did this". */
  const makeWebview = (own) => ({
    html: '',
    cspSource: 'vscode-webview://x',
    asWebviewUri: (u) => ({ toString: () => `vscode-webview://x${u.fsPath}`, fsPath: u.fsPath }),
    onDidReceiveMessage: (fn) => { handlers.push(fn); own?.push(fn); return disposable },
    postMessage: async (m) => { posted.push(m); return true },
  })

  const vscode = {
    // The version the built-in dictation gate compares against. A real API;
    // the stub's job is to exist so a wrong spelling fails here instead of at
    // activation. Below the gate's floor on purpose: the smoke test must
    // exercise the whisper path, and a stub that opened the built-in branch
    // would hide a regression in the fallback.
    version: '1.130.0',
    Uri: {
      file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
      joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), scheme: 'file', toString: () => `file://${path.join(u.fsPath, ...p)}` }),
      from: (parts) => ({ ...parts, fsPath: parts.path ?? '', toString: () => `${parts.scheme}:${parts.path}?${parts.query ?? ''}` }),
      parse: (u) => ({ fsPath: u, scheme: String(u).split(':')[0], toString: () => u }),
    },
    EventEmitter: class { constructor() { this.event = () => disposable } fire() {} dispose() {} },
    ViewColumn: { Active: -1, One: 1, Beside: -2 },
    /* Just a carrier for base+pattern — mentionFiles scopes its search to the
       workspace folder with one of these, and nothing in the stub walks globs. */
    RelativePattern: class {
      constructor(base, pattern) { this.base = base; this.pattern = pattern }
    },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    QuickPickItemKind: { Separator: -1, Default: 0 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: {
      createWebviewPanel: (id) => {
        calls.push('createWebviewPanel:' + id)
        const viewStateListeners = []
        const disposeListeners = []
        /* The SETTINGS tab is not the board, and conflating them made the
           harness lie about the window.
           Every panel used to set `boardPanelOpen` and claim
           `setBoardPanelVisible`, so opening settings told the focus rules a
           board had appeared and handed the "hide the board" control to a
           different tab. It also had a quieter cost: the settings page's own
           message handler was unreachable, so everything it can do — including
           choosing which of a backend's models the composer offers — was
           testable only by reading the code. */
        if (id === 'agentsKanban.settings') {
          /* Its own handlers and its own outbox.
             The page registers its handler AFTER this function returns, so it
             cannot be picked out of the shared list by position — it has to be
             captured as it arrives. And its `postMessage` payload is
             `{type:'state', state}`, the same shape the BOARD posts, so sharing
             one outbox would let a settings refresh answer a question asked
             about the board. Two surfaces, two mailboxes. */
          const own = []
          const outbox = []
          const base = makeWebview()
          const webview = {
            ...base,
            onDidReceiveMessage: (fn) => { own.push(fn); return disposable },
            postMessage: async (m) => { outbox.push(m); return true },
          }
          const panel = {
            webview,
            reveal() { calls.push('reveal:' + id) },
            dispose() { calls.push('disposePanel:' + id) },
            visible: true,
            onDidChangeViewState: (fn) => { viewStateListeners.push(fn); return disposable },
            onDidDispose: (fn) => { disposeListeners.push(fn); return disposable },
            iconPath: undefined,
          }
          ctl.settings = {
            panel,
            posted: outbox,
            /** Speak to the page's host exactly as the real webview does. */
            send: async (msg) => { for (const fn of own) await fn(msg) },
            /** The most recent state it was handed. */
            state: () => [...outbox].reverse().find((m) => m?.type === 'state')?.state,
          }
          return panel
        }
        ctl.boardPanelOpen = true
        const panelHandlers = []
        const panelOut = []
        const panelWebview = makeWebview(panelHandlers)
        const panel = {
          webview: {
            ...panelWebview,
            postMessage: async (m) => { posted.push(m); panelOut.push(m); return true },
          },
          reveal() { calls.push('reveal:' + id) },
          dispose() { calls.push('disposePanel:' + id); ctl.boardPanelOpen = false },
          visible: true,
          onDidChangeViewState: (fn) => { viewStateListeners.push(fn); return disposable },
          onDidDispose: (fn) => { disposeListeners.push(fn); return disposable },
          iconPath: undefined,
        }
        // Switching to another editor tab is what hands the window back, so the
        // test needs to be able to do exactly that.
        ctl.setBoardPanelVisible = (visible) => {
          panel.visible = visible
          for (const fn of viewStateListeners) fn()
        }
        // The X on the board's tab, which is one of only two ways it closes.
        ctl.disposeBoardPanel = () => { for (const fn of disposeListeners) fn() }
        /** Speak AS the editor panel, and read what only it was handed. */
        ctl.boardPanel = {
          posted: panelOut,
          send: async (msg) => { for (const fn of panelHandlers) await fn(msg) },
          state: () => [...panelOut].reverse().find((m) => m?.type === 'state')?.state,
        }
        return panel
      },
      createOutputChannel: () => ({
        info: (m) => infos.push(String(m)),
        warn: (m) => infos.push(String(m)),
        error: (m) => { errors.push(String(m)); infos.push(String(m)) },
        appendLine: (m) => infos.push(String(m)),
        dispose() {},
      }),
      registerWebviewViewProvider: (id, provider) => {
        calls.push('registerWebviewViewProvider:' + id)
        ctl.provider = provider
        // A real WebviewView the test can show and hide: clicking the activity
        // bar icon is what opens and closes the board, so the test has to be
        // able to click it.
        const listeners = []
        /* Its own mailbox, for the reason the settings panel has one: the side
           bar and the editor panel are two surfaces, they are posted DIFFERENT
           payloads (the control draws no transcript, so it is not sent one),
           and a shared outbox would let one answer a question asked about the
           other — `latestState()` reads the newest post, and which surface
           that came from is a race. */
        const sideBarOut = []
        const sideBarHandlers = []
        const view = {
          visible: layout.sideBar && layout.sideBarView === KANBAN_CONTAINER,
          webview: {
            ...makeWebview(sideBarHandlers),
            postMessage: async (m) => { posted.push(m); sideBarOut.push(m); return true },
          },
          onDidChangeVisibility: (fn) => { listeners.push(fn); return disposable },
          onDidDispose: () => disposable,
          show: () => {},
        }
        // A webview view is visible exactly when the side bar is open AND
        // showing its container. It is never set directly, by the stub or by
        // the test, because it is never set directly by VS Code either — it is
        // a consequence of the layout, which is the whole point.
        syncBoardView = () => {
          const visible = layout.sideBar && layout.sideBarView === KANBAN_CONTAINER
          if (visible === view.visible) return
          view.visible = visible
          for (const fn of listeners) fn()
        }
        // Pressing the icon in the activity bar. VS Code answers it by opening
        // the side bar on OUR container, evicting whatever was there, and there
        // is no API to decline — so that is what the test presses.
        ctl.clickActivityIcon = () => {
          layout.sideBar = true
          layout.sideBarView = KANBAN_CONTAINER
          syncBoardView()
        }
        /** Clicking any other activity-bar icon — Explorer, Source Control. */
        ctl.clickSideBarView = (id) => {
          layout.sideBar = true
          layout.sideBarView = id
          syncBoardView()
        }
        ctl.boardView = view
        /** What the SIDE BAR was handed, as opposed to the editor panel. */
        ctl.sideBar = {
          posted: sideBarOut,
          /** Speak AS the side bar. See makeWebview's `own`. */
          send: async (msg) => { for (const fn of sideBarHandlers) await fn(msg) },
          state: () => [...sideBarOut].reverse().find((m) => m?.type === 'state')?.state,
        }
        return disposable
      },
      createStatusBarItem: (alignment, priority) => {
        calls.push('createStatusBarItem:' + alignment + ':' + priority)
        const item = {
          text: '', tooltip: '', command: undefined, name: '',
          show() { item.visible = true }, hide() { item.visible = false },
          dispose() {}, visible: false,
        }
        ctl.statusItem = item
        return item
      },
      showErrorMessage: (m) => { errors.push('showErrorMessage: ' + m); return Promise.resolve(undefined) },
      showInformationMessage: () => Promise.resolve(undefined),
      showWarningMessage: () => Promise.resolve(undefined),
      showInputBox: async (opts) => {
        calls.push('inputBox:' + (opts?.title ?? opts?.prompt ?? ''))
        // A function lets a test answer a MULTI-STEP form differently per
        // field, which is what the provider flow is. A plain value still works
        // for the single-box cases that were here first.
        return typeof ctl.inputBox === 'function' ? ctl.inputBox(opts) : ctl.inputBox
      },
      showQuickPick: async (items, opts) => {
        calls.push('quickPick:' + (opts?.title ?? ''))
        return typeof ctl.quickPick === 'function' ? ctl.quickPick(items, opts) : ctl.quickPick
      },
      // Runs the task rather than faking it: every provider probe and merge goes
      // through here, so a stub that only resolved would make those code paths
      // invisible to the smoke test.
      withProgress: async (opts, task) => {
        calls.push('progress:' + (opts?.title ?? ''))
        return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable })
      },
      // What the editor really does with a document: opened into the ACTIVE
      // group it takes that group, and a webview panel living there stops being
      // visible — which is the very event the board reads as "clicked away".
      // Opened beside, the panel keeps its group and stays visible. Modelled
      // here because asserting "showTextDocument was called" cannot see the
      // difference, and the difference is whether the board survives the click.
      showTextDocument: async (uri, opts) => {
        calls.push('showTextDocument:' + (uri?.fsPath ?? '') + (opts?.viewColumn === vscode.ViewColumn.Beside ? ' beside' : ''))
        if (opts?.viewColumn !== vscode.ViewColumn.Beside) takesTheActiveGroup()
        return {}
      },
      createTerminal: (opts) => {
        calls.push('createTerminal:' + (opts?.cwd ?? ''))
        const sent = []
        ctl.terminal = { opts, sent }
        return { show() {}, sendText: (t) => sent.push(t), dispose() {} }
      },
    },
    workspace: {
      get workspaceFolders() { return ctl.noFolder ? undefined : folders },
      onDidChangeWorkspaceFolders: () => disposable,
      /* A REAL event, because a settings change is a real code path: the
         extension re-derives which agents are installed and which backend is
         active when one fires. Stubbed to nothing, all of that was unreachable
         from a test. `ctl.changeConfig` is how a test edits a setting. */
      onDidChangeConfiguration: (fn) => { configListeners.push(fn); return disposable },
      getConfiguration: () => ({
        get: (k) => (ctl.config ?? {})[k],
        // Writes go back into the same object a test reads, so "saved the
        // profile" is checkable — and so a credential accidentally written
        // here instead of into SecretStorage is VISIBLE to a test rather than
        // being a quiet security bug. See providers in smoke.mjs.
        update: async (k, v) => { (ctl.config ??= {})[k] = v; calls.push('config:' + k) },
        inspect: () => undefined,
        has: (k) => k in (ctl.config ?? {}),
      }),
      createFileSystemWatcher: () => ({
        onDidCreate: () => disposable, onDidChange: () => disposable,
        onDidDelete: () => disposable, dispose() {},
      }),
      openTextDocument: async () => ({}),
      updateWorkspaceFolders: () => true,
      /* A walk of what a test seeded (`ctl.files`, workspace-relative, forward
         slashes) minus what the real glob excludes. Glob engines are not what
         the suite tests — that the host asks lazily, scoped to the folder, and
         answers in workspace-relative paths, is. */
      findFiles: async (include, _exclude, maxResults) => {
        const base = include?.base?.uri?.fsPath ?? folders[0]?.uri?.fsPath ?? ''
        const skipSeg = new Set(['.git', 'node_modules', '.agentskanban', '.vscode', 'out', 'dist', 'build', 'coverage', '.next', 'vendor', 'bin', 'obj'])
        const skipExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.wasm', '.zip', '.tar', '.gz', '.mp3', '.mp4', '.mov', '.wav']
        const hits = (ctl.files ?? [])
          .filter((p) => {
            const dirs = p.split('/').slice(0, -1)
            return !dirs.some((d) => skipSeg.has(d)) && !skipExt.some((e) => p.endsWith(e))
          })
          .slice(0, maxResults ?? 2000)
        return hits.map((p) => ({ fsPath: path.join(base, ...p.split('/')), scheme: 'file' }))
      },
      asRelativePath: (u, includeWorkspaceFolder) => {
        const base = folders[0]?.uri?.fsPath ?? ''
        const rel = base && u.fsPath.startsWith(base + path.sep)
          ? u.fsPath.slice(base.length + 1)
          : u.fsPath
        return includeWorkspaceFolder === false ? rel.replaceAll(path.sep, '/') : rel
      },
      registerTextDocumentContentProvider: (scheme, provider) => {
        calls.push('contentProvider:' + scheme)
        ctl.contentProvider = provider
        return disposable
      },
    },
    env: {
      openExternal: async (uri) => { calls.push('openExternal:' + String(uri)); return true },
    },
    commands: {
      registerCommand: (id, fn) => { calls.push('cmd:' + id); cmds.set(id, fn); return disposable },
      executeCommand: async (id, ...args) => {
        calls.push('exec:' + id)
        // `vscode.diff(left, right, title, options)` is an editor open like any
        // other, and lands in the active group unless told otherwise.
        if (id === 'vscode.diff') { if (args[3]?.viewColumn !== vscode.ViewColumn.Beside) takesTheActiveGroup(); return }
        applyLayoutCommand(id)
      },
    },
  }

  /** An editor opened into the active group while the board is there: the
   *  board's webview is no longer visible, and it hears about it. */
  function takesTheActiveGroup() {
    if (ctl.boardPanelOpen && ctl.setBoardPanelVisible) ctl.setBoardPanelVisible(false)
  }

  /** Edit a setting and tell the extension, as VS Code would. */
  ctl.changeConfig = async (patch) => {
    Object.assign(ctl.config, patch)
    const keys = Object.keys(patch)
    const event = { affectsConfiguration: (k) => keys.some((n) => `agentsKanban.${n}` === k || k === 'agentsKanban') }
    for (const fn of configListeners) await fn(event)
  }

  return { vscode, calls, cmds, posted, handlers, infos, errors, folders, makeWebview, layout }
}

/** Load the BUILT bundle with `vscode` resolved to the stub. */
export function loadBundle(vscode) {
  const require_ = createRequire(path.join(repoRoot, 'package.json'))
  const stubPath = path.join(repoRoot, 'vscode-stub.cjs')
  require_.cache[stubPath] = { id: stubPath, filename: stubPath, loaded: true, exports: vscode }
  const Module = require_('node:module')
  if (!Module.__ckPatched) {
    const orig = Module._resolveFilename
    Module._resolveFilename = function (request, ...rest) {
      return request === 'vscode' ? stubPath : orig.call(this, request, ...rest)
    }
    Module.__ckPatched = true
  }
  return require_(path.join(repoRoot, 'dist', 'extension.js'))
}

export async function makeContext(storage) {
  /** A real store, not a no-op.
   *
   *  A credential is the one piece of provider configuration that must NOT end
   *  up in settings, and the only way to check that is to have somewhere else
   *  for it to go and then look in both places. A stub that swallowed writes
   *  would make "the key went into settings.json" pass. */
  const secretStore = new Map()
  const globalStore = new Map()
  const workspaceStore = new Map()
  return {
    subscriptions: [],
    extensionUri: { fsPath: repoRoot },
    globalStorageUri: { fsPath: storage ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'ck-storage-'))) },
    /** A REAL store, like `globalState` below it and for the same reason.
     *
     *  It was a no-op, so `workspaceState.update()` went nowhere and `get()`
     *  always came back undefined — which made every workspace-persisted field
     *  invisible to the launch gate. The spawn allowlist lives there, and the
     *  rule it must obey is this project's own: anything persisted must be
     *  READ BACK by a test, not just written. A stub that swallows writes
     *  cannot fail on that, and did not. */
    workspaceState: {
      get: (k, fallback) => (workspaceStore.has(k) ? workspaceStore.get(k) : fallback),
      update: async (k, v) => { workspaceStore.set(k, v) },
      keys: () => [...workspaceStore.keys()],
    },
    /** Test handle: what survived into workspace storage. */
    _workspaceState: workspaceStore,
    /** A REAL store, like `secrets` above and for the same reason.
     *
     *  It was a no-op, so every `globalState.update()` went nowhere and every
     *  `get()` came back undefined — which meant the model-cache path was
     *  invisible to the launch gate. That is where a bug lived: a cached
     *  catalogue is read back on the render path, and one written by a build
     *  with a different `ModelChoice` shape reaches the composer as
     *  `undefined.includes(...)`. A stub that swallows writes cannot fail on
     *  that, and did not. */
    globalState: {
      get: (k, fallback) => (globalStore.has(k) ? globalStore.get(k) : fallback),
      update: async (k, v) => { globalStore.set(k, v) },
      keys: () => [...globalStore.keys()],
      setKeysForSync: () => {},
    },
    /** Test handle: what survived into extension storage. */
    _globalState: globalStore,
    secrets: {
      get: async (k) => secretStore.get(k),
      store: async (k, v) => { secretStore.set(k, v) },
      delete: async (k) => { secretStore.delete(k) },
      onDidChange: () => ({ dispose() {} }),
    },
    /** Test handle: what is in the keychain. */
    _secrets: secretStore,
  }
}
