/** The board's tools, as an MCP server a runtime can spawn.
 *
 * This file is its own bundle (`dist/board-mcp.js`) and its own process. It is
 * spawned by Codex — not by us — because that is how Codex takes MCP servers,
 * and it exists so that a Codex session can move its own card, write a test
 * plan and split itself, exactly as a Claude session can. See
 * `agent/board-bridge.ts` for why the tools are served over two transports from
 * one set of definitions.
 *
 * It holds no board logic whatsoever. Every call is forwarded to the extension
 * host over the socket named in `AGENTS_KANBAN_BRIDGE`, and the host runs the
 * real handler with the real `SessionStore`. That split is deliberate: the
 * tools guard a phase the agent may not reach and a split it may not perform,
 * and **a boundary enforced in a process the agent's runtime spawned is not a
 * boundary**. `isHumanOnly()` stays on our side of the socket.
 *
 * ## Protocol
 *
 * Two hops, and they are different on purpose:
 *
 *  - **stdio ↔ Codex**: MCP over newline-delimited JSON-RPC 2.0. `initialize`,
 *    `tools/list`, `tools/call`.
 *  - **socket ↔ extension host**: a four-message private protocol (`hello`,
 *    `call`). Keeping MCP out of the host side means the wire format lives in
 *    one file and the host stays a function table.
 *
 * It must never write to stdout except JSON-RPC. A stray `console.log` here is
 * a corrupted MCP stream and an agent with no board tools, so diagnostics go to
 * stderr, which Codex surfaces in its logs.
 */
import { connect, type Socket } from 'node:net'

interface WireTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** The MCP revision this speaks. Echoed back rather than asserted: a client
 *  asking for a newer one still gets a working server, and refusing over a date
 *  string would break the whole board for a version bump. */
const PROTOCOL_VERSION = '2024-11-05'

function out(msg: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
}

function note(text: string): void {
  process.stderr.write(`[agents-kanban] ${text}\n`)
}

/** The host connection, as a request/response pair over one socket. */
class Bridge {
  private readonly socket: Socket
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private nextId = 1
  private buffer = ''
  private failed?: string

  constructor(socket: Socket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      for (;;) {
        const at = this.buffer.indexOf('\n')
        if (at < 0) break
        const line = this.buffer.slice(0, at)
        this.buffer = this.buffer.slice(at + 1)
        if (!line.trim()) continue
        let msg: Record<string, unknown>
        try { msg = JSON.parse(line) as Record<string, unknown> } catch { continue }
        const id = typeof msg.id === 'number' ? msg.id : -1
        const p = this.pending.get(id)
        if (!p) continue
        this.pending.delete(id)
        if (msg.error) p.reject(new Error(String(msg.error)))
        else p.resolve(msg.result)
      }
    })
    const die = (why: string): void => {
      this.failed = why
      for (const [id, p] of this.pending) { p.reject(new Error(why)); this.pending.delete(id) }
    }
    socket.on('close', () => {
      die('The Agents Kanban board is no longer listening. Its window was probably closed.')
      // And leave. This process exists only to serve that socket, and the agent
      // runtime that spawned us has no reason to reap it — so without this,
      // every finished session leaves a node process behind for as long as the
      // editor is open.
      process.exit(0)
    })
    socket.on('error', (e: Error) => die(e.message))
  }

  send(method: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    if (this.failed) return Promise.reject(new Error(this.failed))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.socket.write(`${JSON.stringify({ id, method, ...extra })}\n`) } catch (e) {
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }
}

async function main(): Promise<void> {
  const address = process.env.AGENTS_KANBAN_BRIDGE
  const token = process.env.AGENTS_KANBAN_TOKEN
  if (!address || !token) {
    note('AGENTS_KANBAN_BRIDGE and AGENTS_KANBAN_TOKEN are required. This server is spawned by the extension, not by hand.')
    process.exit(2)
  }

  const socket = connect(address)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('error', reject)
  })
  const bridge = new Bridge(socket)
  const hello = (await bridge.send('hello', { token })) as { tools?: WireTool[] }
  const tools = hello?.tools ?? []
  note(`connected; ${tools.length} board tools available`)

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const at = buffer.indexOf('\n')
      if (at < 0) break
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim()) handle(line, bridge, tools)
    }
  })
  // Codex closing stdin is how it says the session is over.
  process.stdin.on('end', () => process.exit(0))
}

function handle(line: string, bridge: Bridge, tools: WireTool[]): void {
  let msg: Record<string, unknown>
  try { msg = JSON.parse(line) as Record<string, unknown> } catch { return }
  const id = msg.id
  const method = typeof msg.method === 'string' ? msg.method : ''

  switch (method) {
    case 'initialize':
      out({
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'board', version: '0.2.0' },
          instructions:
            "Tools for this workspace's kanban board. Keep your own card honest: move it " +
            'into the implementing column when you start and the validating column when you finish.',
        },
      })
      return

    // Notifications carry no id and must not be answered. Replying to one is a
    // protocol error that some clients treat as fatal.
    case 'notifications/initialized':
    case 'initialized':
      return

    case 'tools/list':
      out({ id, result: { tools } })
      return

    case 'tools/call': {
      const params = (msg.params ?? {}) as Record<string, unknown>
      const name = typeof params.name === 'string' ? params.name : ''
      const args = (params.arguments ?? {}) as Record<string, unknown>
      void bridge.send('call', { name, args })
        .then((result) => out({ id, result: normalise(result) }))
        // An MCP call that never comes back blocks the agent's turn forever, so
        // a failure is answered AS A TOOL RESULT — visible to the model, which
        // can then say what went wrong — rather than as a JSON-RPC error.
        .catch((e: unknown) => out({
          id,
          result: {
            content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
            isError: true,
          },
        }))
      return
    }

    case 'ping':
      out({ id, result: {} })
      return

    default:
      if (id !== undefined) out({ id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

/** The board handlers already return MCP content blocks; anything else is
 *  wrapped rather than dropped, so a handler that returns a bare string still
 *  reaches the model. */
function normalise(result: unknown): Record<string, unknown> {
  if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) {
    return result as Record<string, unknown>
  }
  return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? {}) }] }
}

main().catch((e: unknown) => {
  note(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
