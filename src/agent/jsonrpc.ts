/** A newline-delimited JSON-RPC 2.0 peer, over a child process's stdio.
 *
 * Written generically rather than inside the Codex adapter because it is the
 * transport several agent runtimes have converged on — Codex's `app-server`,
 * and anything speaking LSP-style JSON-RPC without the `Content-Length` header.
 * The next runtime that needs it should not have to re-derive line framing and
 * id correlation.
 *
 * ## What is different from textbook JSON-RPC, and why it matters
 *
 * **The `"jsonrpc": "2.0"` member is omitted on the wire.** Codex's app-server
 * documents this explicitly. Sending it anyway is harmless, but *requiring* it
 * on the way in is not: a strict parser would reject every message the server
 * sends. So this reads permissively and writes without it.
 *
 * **It is bidirectional.** The server sends *requests* to us — approvals for a
 * command it wants to run, or a patch it wants to apply — and blocks until we
 * answer. That is the whole permission round trip, so an implementation that
 * only handled responses would hang the agent at the first `rm`, silently,
 * looking exactly like a wedged process. Incoming messages are therefore routed
 * on whether they carry `method` (a request or notification from them) or
 * `result`/`error` (an answer to us), never on id ranges: the two sides
 * allocate ids independently and both start at 1.
 *
 * ## Failure is reported, never swallowed
 *
 * Three ways this can go wrong, and all three are surfaced rather than logged:
 * the child dies (every in-flight request rejects with the exit status and
 * whatever it last wrote to stderr), a line does not parse (`protocolError`,
 * because a version mismatch must not present as silence), and the server says
 * it is overloaded (`-32001`, which the docs prescribe retrying — the caller is
 * told rather than having a retry hidden from it).
 */
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/** A request we received from the other side and owe an answer to. */
export interface IncomingRequest {
  id: number | string
  method: string
  params: Record<string, unknown>
  /** Answer it. Exactly one of these may be called, and calling neither leaves
   *  the server waiting forever — which is why `handleRequest` returning
   *  without answering is treated as a protocol error by the caller, not here. */
  respond: (result: unknown) => void
  fail: (message: string, code?: number) => void
}

interface RpcEvents {
  /** A message with a method and no id. */
  notification: (method: string, params: Record<string, unknown>) => void
  /** A message with a method AND an id: they want an answer. */
  request: (req: IncomingRequest) => void
  /** A line we could not parse, or a shape we did not expect. Never fatal on
   *  its own — a newer server may emit members we do not know — but never
   *  silent either. */
  protocolError: (message: string, raw: string) => void
  /** Anything the child wrote to stderr, a line at a time. Kept because it is
   *  the only place a CLI explains why it refused to start. */
  stderr: (line: string) => void
  /** The child exited. `code` is null when it was killed by a signal. */
  exit: (code: number | null, signal: string | null) => void
}

/** Thrown when the peer answers with an error object. */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(message: string, code: number, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
  /** The server is shedding load and the documentation says to retry. Callers
   *  that can wait should; callers that cannot should say why they gave up. */
  get overloaded(): boolean { return this.code === -32001 }
}

/** How long to wait for a reply before giving up on a request.
 *
 * A request with no timeout is a hang with no explanation, and the symptom —
 * a card that says "working" forever — is indistinguishable from an agent
 * thinking hard. Turn-scoped calls are exempt and pass `timeoutMs: 0`, because
 * a turn legitimately takes minutes and the board already shows the age of the
 * last frame for exactly that case. */
const DEFAULT_TIMEOUT_MS = 30_000

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  method: string
  timer?: NodeJS.Timeout
}

export class JsonRpcPeer extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private buffer = ''
  private errBuffer = ''
  /** Last few stderr lines, so a rejection can say what the child complained
   *  about instead of just "exited with 1". */
  private readonly recentErr: string[] = []
  private closed = false
  private exitReason?: string

  constructor(child: ChildProcessWithoutNullStreams) {
    super()
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => this.onStderr(chunk))

    child.on('exit', (code, signal) => {
      this.closed = true
      const tail = this.recentErr.slice(-4).join('\n')
      this.exitReason = signal
        ? `the agent process was killed (${signal})`
        : `the agent process exited with status ${code ?? 'unknown'}`
      const detail = tail ? `${this.exitReason}: ${tail}` : this.exitReason
      for (const [id, p] of this.pending) {
        p.reject(new Error(`${p.method} did not complete — ${detail}`))
        this.pending.delete(id)
      }
      this.emit('exit', code, signal)
    })

    // A spawn failure (ENOENT) arrives here, not on 'exit'. Without this the
    // promise from the first request would hang rather than name the missing
    // executable.
    child.on('error', (e: Error) => {
      this.closed = true
      this.exitReason = e.message
      for (const [id, p] of this.pending) {
        p.reject(new Error(`${p.method} could not be sent — ${e.message}`))
        this.pending.delete(id)
      }
    })
  }

  /** Has the child gone away? */
  get ended(): boolean { return this.closed }

  private onStdout(chunk: string): void {
    this.buffer += chunk
    for (;;) {
      const at = this.buffer.indexOf('\n')
      if (at < 0) break
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (line) this.dispatch(line)
    }
  }

  private onStderr(chunk: string): void {
    this.errBuffer += chunk
    for (;;) {
      const at = this.errBuffer.indexOf('\n')
      if (at < 0) break
      const line = this.errBuffer.slice(0, at)
      this.errBuffer = this.errBuffer.slice(at + 1)
      if (!line.trim()) continue
      this.recentErr.push(line)
      if (this.recentErr.length > 20) this.recentErr.shift()
      this.emit('stderr', line)
    }
  }

  private dispatch(line: string): void {
    let msg: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.emit('protocolError', 'expected a JSON object', line)
        return
      }
      msg = parsed as Record<string, unknown>
    } catch (e) {
      this.emit('protocolError', e instanceof Error ? e.message : 'unparseable line', line)
      return
    }

    const hasMethod = typeof msg.method === 'string'
    const id = msg.id

    // Their request or notification. Routed on `method`, never on the id's
    // value: both sides number from 1 and a server request id 3 has nothing to
    // do with our request id 3.
    if (hasMethod) {
      const params = (msg.params && typeof msg.params === 'object' && !Array.isArray(msg.params)
        ? msg.params
        : {}) as Record<string, unknown>
      if (id === undefined || id === null) {
        this.emit('notification', msg.method as string, params)
        return
      }
      let answered = false
      this.emit('request', {
        id: id as number | string,
        method: msg.method as string,
        params,
        respond: (result: unknown) => {
          if (answered) return
          answered = true
          this.write({ id, result: result ?? {} })
        },
        fail: (message: string, code = -32000) => {
          if (answered) return
          answered = true
          this.write({ id, error: { code, message } })
        },
      })
      return
    }

    // An answer to one of ours.
    if (typeof id !== 'number') {
      this.emit('protocolError', 'a response with no numeric id', line)
      return
    }
    const p = this.pending.get(id)
    if (!p) {
      // Late answer to something we already timed out. Worth saying — a server
      // that is consistently slower than the timeout is a real condition — but
      // not worth failing anything over.
      this.emit('protocolError', `an answer to request ${id}, which is no longer waiting`, line)
      return
    }
    this.pending.delete(id)
    if (p.timer) clearTimeout(p.timer)
    if (msg.error && typeof msg.error === 'object') {
      const err = msg.error as { code?: number; message?: string; data?: unknown }
      p.reject(new RpcError(err.message ?? 'the agent reported an error', err.code ?? -32000, err.data))
      return
    }
    p.resolve(msg.result)
  }

  private write(msg: Record<string, unknown>): void {
    if (this.closed) return
    try {
      this.child.stdin.write(`${JSON.stringify(msg)}\n`)
    } catch {
      // A closed stdin means the child is gone; the exit handler rejects
      // everything in flight with a described reason, which is more useful than
      // whatever EPIPE says.
    }
  }

  /** Send a request and wait for its answer. */
  request(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error(`${method} could not be sent — ${this.exitReason ?? 'the agent process is not running'}`))
    }
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const entry: Pending = { resolve, reject, method }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`${method} did not answer within ${Math.round(timeoutMs / 1000)}s`))
        }, timeoutMs)
        // Never hold the extension host's event loop open for a reply.
        entry.timer.unref?.()
      }
      this.pending.set(id, entry)
      this.write({ id, method, params })
    })
  }

  /** Send a notification: no id, no answer expected. */
  notify(method: string, params: Record<string, unknown> = {}): void {
    this.write({ method, params })
  }

  /** Close stdin and end the child. */
  dispose(): void {
    this.closed = true
    try { this.child.stdin.end() } catch { /* already gone */ }
    // SIGTERM rather than SIGKILL: the app-server flushes its rollout file on
    // the way out, and losing the tail of a transcript is losing the session's
    // history, which the board reads back after a restart.
    try { this.child.kill('SIGTERM') } catch { /* already gone */ }
  }
}
