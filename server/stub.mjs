/** A fake VS Code that lets the built extension run HEADLESS on a plain box.
 *
 * Same idea as test/harness.mjs — the extension bundle resolves `vscode` to a
 * stub and activates against it — but the seams land in different places:
 *
 *  - a fake webview's `postMessage` becomes an SSE frame to every browser
 *    watching that surface, and `onDidReceiveMessage` is fed by POSTs from
 *    those browsers (one surface, many mirrors: the extension already posts
 *    full state to each surface, so every viewer sees the same board);
 *  - dialogs (`showQuickPick`, `showInputBox`, modal `showWarningMessage`)
 *    become an overlay in the browser, answered back over the same channel;
 *  - toasts (`showInformationMessage` and friends, `openExternal`, terminals,
 *    text documents) become browser toasts, because a headless box has no
 *    window of its own to show them in.
 *
 * The stub deliberately stays SMALL: the point is that it is incomplete, so a
 * missing API fails here at activation exactly as it would in the real editor
 * (the same rule test/harness.mjs exists under). The server's gate test drives
 * the real message flow through it.
 */
import * as path from 'node:path'
import { promises as fs } from 'node:fs'

const disposable = { dispose() {} }

/**
 * Build the stub. `ctl` is live state the server mutates after activation:
 * `broadcast` is installed by the server, `dialog`/`toast` are what the stub
 * asks of it, `config` seeds `getConfiguration`.
 */
export function makeVscodeStub(ctl) {
  const calls = []
  const cmds = new Map()

  /** Inbound message handlers per surface, as the extension's `wire()` registers
   *  them. Keyed by panel id: 'agentsKanban.panel' and 'agentsKanban.settings'. */
  const handlers = new Map()
  /** The panel objects per surface, so the server can ask whether one is open. */
  const panels = new Map()

  const folders = [{ uri: { fsPath: ctl.repo }, name: path.basename(ctl.repo), index: 0 }]

  /** A surface's outbound path: every postMessage lands here. The server sets
   *  `ctl.broadcast` before the first webview exists. */
  const makeWebview = (surface) => ({
    html: '',
    cspSource: 'vscode-webview://x',
    asWebviewUri: (u) => ({ toString: () => `vscode-webview://x${u.fsPath}`, fsPath: u.fsPath }),
    options: {},
    onDidReceiveMessage: (fn) => {
      const list = handlers.get(surface) ?? []
      list.push(fn)
      handlers.set(surface, list)
      return disposable
    },
    postMessage: async (m) => {
      ctl.broadcast?.(surface, m)
      return true
    },
  })

  /** One headless panel. `reveal` is a no-op: every viewer is already watching. */
  const makePanel = (id) => {
    const viewStateListeners = []
    const disposeListeners = []
    const panel = {
      webview: makeWebview(id),
      reveal() { calls.push('reveal:' + id) },
      dispose() { calls.push('disposePanel:' + id) },
      visible: true,
      onDidChangeViewState: (fn) => { viewStateListeners.push(fn); return disposable },
      onDidDispose: (fn) => { disposeListeners.push(fn); return disposable },
      iconPath: undefined,
    }
    panels.set(id, panel)
    return panel
  }

  const vscode = {
    version: '1.130.0',
    Uri: {
      file: (p) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
      joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), scheme: 'file', toString: () => `file://${path.join(u.fsPath, ...p)}` }),
      from: (parts) => ({ ...parts, fsPath: parts.path ?? '', toString: () => `${parts.scheme}:${parts.path}?${parts.query ?? ''}` }),
      parse: (u) => ({ fsPath: u, scheme: String(u).split(':')[0], toString: () => u }),
    },
    EventEmitter: class { constructor() { this.event = () => disposable } fire() {} dispose() {} },
    ViewColumn: { Active: -1, One: 1, Beside: -2 },
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
        return makePanel(id)
      },
      createOutputChannel: () => ({
        info: (m) => ctl.log?.(String(m)),
        warn: (m) => ctl.log?.(String(m)),
        error: (m) => ctl.log?.(String(m)),
        appendLine: (m) => ctl.log?.(String(m)),
        dispose() {},
      }),
      registerWebviewViewProvider: (id, provider) => {
        calls.push('registerWebviewViewProvider:' + id)
        ctl.provider = provider
        return disposable
      },
      createStatusBarItem: () => ({
        text: '', tooltip: '', command: undefined, name: '',
        show() {}, hide() {}, dispose() {},
      }),
      showErrorMessage: (m, ...items) => {
        calls.push('error:' + String(m))
        ctl.toast?.({ level: 'error', text: String(m) })
        return resolveChoice(items, ctl)
      },
      showInformationMessage: (m, ...items) => {
        calls.push('info:' + String(m))
        ctl.toast?.({ level: 'info', text: String(m) })
        return resolveChoice(items, ctl)
      },
      /** Non-modal warnings are toasts; a modal one is a real question and
       *  becomes an overlay the browser answers. The distinction is the point:
       *  a merge confirmation must not be auto-dismissed on a box with no one
       *  looking at it. */
      showWarningMessage: (m, opts, ...items) => {
        calls.push('warning:' + String(m))
        const choices = Array.isArray(opts) ? [...opts, ...items] : items
        if (opts && typeof opts === 'object' && opts.modal) {
          return ctl.dialog({
            level: 'warning',
            title: 'Confirmation',
            text: String(m),
            choices: choices.map(String),
          })
        }
        ctl.toast?.({ level: 'warning', text: String(m) })
        return resolveChoice(choices, ctl)
      },
      showInputBox: async (opts) => {
        calls.push('inputBox:' + (opts?.title ?? opts?.prompt ?? ''))
        return ctl.dialog({
          level: 'info',
          title: opts?.title ?? opts?.prompt ?? 'Input',
          text: opts?.prompt ?? '',
          input: { value: opts?.value ?? '', password: opts?.password === true },
          choices: [],
        })
      },
      showQuickPick: async (items, opts) => {
        calls.push('quickPick:' + (opts?.title ?? ''))
        const pick = items.map((it) => {
          if (typeof it === 'string') return { label: it, kind: 0 }
          return {
            label: it.label,
            detail: it.detail ?? '',
            kind: it.kind === undefined ? 0 : it.kind,
            item: it,
          }
        })
        return ctl.dialog({
          level: 'info',
          title: opts?.title ?? 'Choose',
          text: opts?.placeHolder ?? '',
          quickpick: { items: pick, many: opts?.canPickMany === true },
          choices: [],
        })
      },
      /** Runs the task for real: provider probes, merges and discovery all go
       *  through here, and a stub that only resolved would make them invisible. */
      withProgress: async (_opts, task) => {
        calls.push('progress:' + (_opts?.title ?? ''))
        return task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => disposable })
      },
      showTextDocument: async (uri, _opts) => {
        calls.push('showTextDocument:' + (uri?.fsPath ?? ''))
        ctl.toast?.({ level: 'info', text: `Opened ${uri?.fsPath ?? ''} (no editor on this box)` })
        return {}
      },
      createTerminal: (opts) => {
        calls.push('createTerminal:' + (opts?.cwd ?? ''))
        ctl.toast?.({ level: 'info', text: `Terminal requested in ${opts?.cwd ?? ''} — there is no shell to show headlessly.` })
        return { show() {}, sendText() {}, dispose() {} }
      },
    },
    workspace: {
      get workspaceFolders() { return ctl.noFolder ? undefined : folders },
      onDidChangeWorkspaceFolders: () => disposable,
      onDidChangeConfiguration: () => disposable,
      getConfiguration: () => ({
        get: (k) => (ctl.config ?? {})[k],
        update: async (k, v) => { (ctl.config ??= {})[k] = v },
        inspect: () => undefined,
        has: (k) => k in (ctl.config ?? {}),
      }),
      createFileSystemWatcher: () => ({
        onDidCreate: () => disposable, onDidChange: () => disposable,
        onDidDelete: () => disposable, dispose() {},
      }),
      openTextDocument: async (uri) => {
        calls.push('openTextDocument:' + (uri?.fsPath ?? ''))
        return { getText: () => '', uri }
      },
      updateWorkspaceFolders: () => true,
      /** A REAL walk of the repo, because the @-mention picker and the
       *  settings' file scopes ask this lazily and the answer must be real.
       *  Bounded and cached by the caller; nothing here runs per repaint. */
      findFiles: async (include, _exclude, maxResults) => {
        const base = include?.base?.uri?.fsPath ?? folders[0]?.uri?.fsPath ?? ctl.repo
        const pat = String(include?.pattern ?? '**/*')
        return await globWalk(base, pat, maxResults ?? 2000)
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
        ctl.contentProviders ??= new Map()
        ctl.contentProviders.set(scheme, provider)
        return disposable
      },
    },
    env: {
      openExternal: async (uri) => {
        calls.push('openExternal:' + String(uri))
        ctl.openExternal?.(String(uri))
        return true
      },
      clipboard: { writeText: async () => {}, readText: async () => '' },
    },
    commands: {
      registerCommand: (id, fn) => { calls.push('cmd:' + id); cmds.set(id, fn); return disposable },
      executeCommand: async (id, ...args) => {
        calls.push('exec:' + id)
        if (id === 'vscode.diff') {
          ctl.toast?.({
            level: 'info',
            text: `Diff requested for ${args.map((a) => a?.fsPath ?? '').filter(Boolean).join(' ↔ ') || 'a file'} — diffs open in the local editor, not on the web board yet.`,
          })
          return
        }
        // Commands the extension itself registered run for real.
        const fn = cmds.get(id)
        if (fn) return fn(...args)
      },
    },
  }

  ctl.stub = { vscode, calls, cmds, panels, handlers }
  return vscode
}

/** A small glob walk, real enough for findFiles: the patterns this extension
 *  issues are `**`-style over the workspace. Skips the heavy directories. */
async function globWalk(base, pattern, max) {
  const skipSeg = new Set(['.git', 'node_modules', '.agentskanban', '.vscode', 'out', 'dist', 'build', 'coverage', '.next', 'vendor', 'bin', 'obj'])
  const skipExt = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.wasm', '.zip', '.tar', '.gz', '.mp3', '.mp4', '.mov', '.wav', '.jar', '.class', '.o', '.a'])
  const prefix = pattern.replace(/\/\*\*\/\*$/, '').replace(/\/\*$/, '').replace(/\*\*\/?$/, '')
  const out = []
  async function walk(dir) {
    if (out.length >= max) return
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (out.length >= max) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (skipSeg.has(e.name)) continue
        await walk(full)
      } else if (!skipExt.has(path.extname(e.name))) {
        const rel = path.relative(base, full).replaceAll(path.sep, '/')
        if (!prefix || rel.startsWith(prefix)) out.push({ fsPath: full, scheme: 'file' })
      }
    }
  }
  await walk(base)
  return out
}

/** Non-modal message buttons: shown as toast actions when the server renders
 *  them; never awaited by the caller. */
function resolveChoice(items, ctl) {
  const text = items.map(String)
  if (!text.length) return Promise.resolve(undefined)
  const { promise, resolve } = deferred()
  ctl.dialog?.({
    level: 'info',
    title: 'Message',
    text: '',
    choices: text,
  }).then(resolve, () => resolve(undefined))
  return promise
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
