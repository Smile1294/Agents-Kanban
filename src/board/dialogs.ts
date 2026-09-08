/** Dialog indirection — one code path for "ask the user", two sinks.
 *
 * The board host asks the user through `vscode.window`: quick picks, input
 * boxes, modal confirmations and toasts. A message that arrives from the LOCAL
 * webview answers those on the VS Code window. A message that arrives from the
 * REMOTE page must answer them on the phone instead — as an overlay drawn by
 * the relay's bridge, answered back over the relay as a `remote.dialog`
 * message. Both are the SAME host method; only the sink differs, and the sink
 * is chosen by where the dispatch happens to be running.
 *
 * That is what AsyncLocalStorage is for: the remote executor runs the shared
 * dispatcher inside `withRemoteDialogSink(relaySink, …)`, and every `confirm` /
 * `input` / `pick` / `toast` below reads the sink from context. Outside any
 * context (the ordinary local case) the DEFAULT sink applies — installed once
 * from extension.ts, because this module is plain Node and `vscode` may only be
 * a TYPE here (the test runner and the headless board both run it without a
 * real VS Code).
 *
 * The relay sink itself lives here too (`makeRelayDialogSink`): it posts a
 * `{ type:'remote', kind:'dialog', id, spec }` event and waits for the
 * matching `remote.dialog` answer, with a timeout so a page that goes away can
 * never leave the host awaiting forever. The answer routing is a callback the
 * caller installs — the message client calls `resolve(id, answer)` when a
 * `remote.dialog` message arrives.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

export type DialogLevel = 'info' | 'warning' | 'error'

/** One choice in a picker, flattened to what the wire and the view can draw. */
export interface PickItem {
  label: string
  detail?: string
  kind?: number
  item?: unknown
}

/** What a sink offers. Every method is the whole surface the host needs; the
 *  shapes are deliberately small so a sink can be a VS Code window or a
 *  relay-posting object with no third case. */
export interface DialogSink {
  /** Ask a yes/no-or-choices question. Resolves the chosen label, or
   *  `undefined` when dismissed. `modal` means "must be answered" — the local
   *  sink makes it a modal warning, the remote sink an overlay. */
  confirm(text: string, opts: ConfirmOptions): Promise<string | undefined>
  /** One free-text line. Resolves the string, or `undefined` when dismissed. */
  input(opts: InputOptions): Promise<string | undefined>
  /** A single- or multi-select list. Resolves the picked items (or `[]` for a
   *  cancelled multi-pick), or `undefined` when dismissed. */
  pick(items: PickItem[], opts: PickOptions): Promise<PickItem[] | undefined>
  /** A one-way note. Never awaited — a toast cannot answer. */
  toast(level: DialogLevel, text: string, url?: string): void
}

export interface ConfirmOptions {
  modal?: boolean
  choices?: string[]
  level?: DialogLevel
}

export interface InputOptions {
  prompt?: string
  value?: string
  password?: boolean
  placeHolder?: string
}

export interface PickOptions {
  many?: boolean
  placeHolder?: string
}

/** The store holds BOTH the sink and whether this dispatch is remote — the
 *  editor-only actions (open a worktree, show a diff) read the second flag to
 *  decide whether to drive VS Code or say "that happens on the board's
 *  machine". */
interface DialogContext {
  sink: DialogSink
  remote: boolean
}

const storage = new AsyncLocalStorage<DialogContext>()

/** The sink used when no context is running. Installed once from extension.ts. */
let defaultSink: DialogSink | undefined

/** Install the fallback sink. Called from extension.ts at activation with the
 *  `vscode.window`-backed sink. */
export function setDefaultDialogSink(sink: DialogSink): void {
  defaultSink = sink
}

/** Run `fn` with `sink` as the dialog sink, and mark the context LOCAL. */
export function withDialogSink<T>(sink: DialogSink, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run({ sink, remote: false }, fn)
}

/** Run `fn` with `sink` as the dialog sink, and mark the context REMOTE — the
 *  remote message executor's wrapper, so editor-only actions can tell they are
 *  being driven from the page. */
export function withRemoteDialogSink<T>(sink: DialogSink, fn: () => T | Promise<T>): T | Promise<T> {
  return storage.run({ sink, remote: true }, fn)
}

/** Whether the running dispatch came from the remote page. */
export function isRemoteDialog(): boolean {
  return storage.getStore()?.remote === true
}

const sinkOf = (): DialogSink | undefined => storage.getStore()?.sink ?? defaultSink

/** Ask the active sink to confirm. Resolves `undefined` when there is no sink
 *  at all (nothing to show — an honest cancel, never a thrown dialog). */
export async function confirm(text: string, opts: ConfirmOptions = {}): Promise<string | undefined> {
  const s = sinkOf()
  if (!s) return undefined
  return s.confirm(text, opts)
}

/** Ask the active sink for a line of text. */
export async function input(opts: InputOptions = {}): Promise<string | undefined> {
  const s = sinkOf()
  if (!s) return undefined
  return s.input(opts)
}

/** Ask the active sink to pick from a list. */
export async function pick(items: PickItem[], opts: PickOptions = {}): Promise<PickItem[] | undefined> {
  const s = sinkOf()
  if (!s) return undefined
  return s.pick(items, opts)
}

/** Fire a one-way note at the active sink. A no-op with no sink. */
export function toast(level: DialogLevel, text: string, url?: string): void {
  const s = sinkOf()
  if (s) s.toast(level, text, url)
}

/** The remote page's dialog, in the spec the bridge renders and answers:
 *  `{ level, title, text, choices[] }`, optionally with `input` or
 *  `quickpick`. The answer comes back as `{ type:'remote.dialog', id, answer }`
 *  — chosen label, input string, picked item(s), or `null` on dismiss. */
export interface RemoteDialogSpec {
  level: DialogLevel
  title: string
  text: string
  choices?: string[]
  input?: { value: string; password: boolean }
  quickpick?: { items: PickItem[]; many: boolean }
}

/** The handle the remote executor keeps: the sink to install, plus `resolve`
 *  to feed a `remote.dialog` answer back to the dialog waiting on it. */
export interface RelayDialogHandle {
  sink: DialogSink
  /** Route a `remote.dialog` answer to the waiting dialog. Returns true when
   *  the id matched a pending dialog (the message is then acked, never
   *  dispatched to the board). */
  resolve(id: string, answer: unknown): boolean
}

/** How long a remote dialog may wait for its answer before it reads as
 *  cancelled. A page that is closed mid-question must not strand a host method
 *  awaiting a reply that can never come. */
const REMOTE_DIALOG_TIMEOUT_MS = 10 * 60 * 1000

/** Build the relay sink. `post` is the transport that appends one host→page
 *  event to the relay — the caller binds it to `RemoteMessageClient.postEvents`.
 *  Pending dialogs live in the returned handle's `resolve`, so the message
 *  client (which owns the nonce gate) is the thing that hands answers back. */
export function makeRelayDialogSink(
  post: (event: object) => void,
  timeoutMs: number = REMOTE_DIALOG_TIMEOUT_MS,
): RelayDialogHandle {
  const pending = new Map<string, (answer: unknown) => void>()
  let seq = 0

  const ask = (spec: RemoteDialogSpec): Promise<unknown> => {
    const id = String(++seq)
    return new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(undefined)
      }, timeoutMs)
      pending.set(id, (answer) => {
        clearTimeout(timer)
        resolve(answer)
      })
      post({ type: 'remote', kind: 'dialog', id, spec })
    })
  }

  const sink: DialogSink = {
    async confirm(text, opts) {
      return await ask({
        level: opts.level ?? 'info',
        title: 'Confirmation',
        text,
        choices: opts.choices ?? [],
      }) as string | undefined
    },
    async input(opts) {
      return await ask({
        level: 'info',
        title: opts.prompt ?? 'Input',
        text: opts.prompt ?? '',
        input: { value: opts.value ?? '', password: opts.password === true },
      }) as string | undefined
    },
    async pick(items, opts) {
      return await ask({
        level: 'info',
        title: 'Choose',
        text: opts.placeHolder ?? '',
        quickpick: { items, many: opts.many === true },
      }) as PickItem[] | undefined
    },
    toast(level, text, url) {
      post({ type: 'remote', kind: 'toast', spec: { level, text, ...(url ? { url } : {}) } })
    },
  }

  return {
    sink,
    resolve(id, answer) {
      const r = pending.get(id)
      if (!r) return false
      pending.delete(id)
      r(answer)
      return true
    },
  }
}
