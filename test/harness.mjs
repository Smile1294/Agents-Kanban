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
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
export const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

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
  const infos = []
  const errors = []
  const folders = [{ uri: { fsPath: ctl.repo ?? '' }, name: 'proj', index: 0 }]

  const makeWebview = () => ({
    html: '',
    cspSource: 'vscode-webview://x',
    asWebviewUri: (u) => ({ toString: () => `vscode-webview://x${u.fsPath}`, fsPath: u.fsPath }),
    onDidReceiveMessage: (fn) => { handlers.push(fn); return disposable },
    postMessage: async (m) => { posted.push(m); return true },
  })

  const vscode = {
    Uri: {
      file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
      joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), scheme: 'file', toString: () => `file://${path.join(u.fsPath, ...p)}` }),
      from: (parts) => ({ ...parts, fsPath: parts.path ?? '', toString: () => `${parts.scheme}:${parts.path}?${parts.query ?? ''}` }),
      parse: (u) => ({ fsPath: u, scheme: String(u).split(':')[0], toString: () => u }),
    },
    EventEmitter: class { constructor() { this.event = () => disposable } fire() {} dispose() {} },
    ViewColumn: { Active: -1, One: 1, Beside: -2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    window: {
      createWebviewPanel: (id) => {
        calls.push('createWebviewPanel:' + id)
        const viewStateListeners = []
        const disposeListeners = []
        ctl.boardPanelOpen = true
        const panel = {
          webview: makeWebview(),
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
        const view = {
          visible: layout.sideBar && layout.sideBarView === KANBAN_CONTAINER,
          webview: makeWebview(),
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
      showInputBox: async () => ctl.inputBox,
      showQuickPick: async () => ctl.quickPick,
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
      onDidChangeConfiguration: () => disposable,
      getConfiguration: () => ({ get: (k) => (ctl.config ?? {})[k] }),
      createFileSystemWatcher: () => ({
        onDidCreate: () => disposable, onDidChange: () => disposable,
        onDidDelete: () => disposable, dispose() {},
      }),
      openTextDocument: async () => ({}),
      updateWorkspaceFolders: () => true,
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
  return {
    subscriptions: [],
    extensionUri: { fsPath: repoRoot },
    globalStorageUri: { fsPath: storage ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'ck-storage-'))) },
    workspaceState: { get: () => undefined, update: async () => {} },
    globalState: { get: () => undefined, update: async () => {} },
  }
}
