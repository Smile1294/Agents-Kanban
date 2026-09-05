/** Serving the board's own tools to a runtime that cannot take them in-process.
 *
 * The whole premise of this board is that **agents move their own cards**. That
 * works for Claude Code because the Agent SDK accepts an in-process MCP server
 * object — `createSdkMcpServer` — so `tools.ts` runs inside the extension host
 * with the `SessionStore` already in scope. No port, no token, no transport.
 *
 * Codex cannot take that. It accepts MCP servers as **commands to spawn**. A
 * Codex session with no board tools would still be a session, but it would be a
 * second-class card: it could not move itself out of Planning, could not write
 * a test plan, could not split. That is not "Codex support", it is a chat
 * window on a kanban board.
 *
 * So the same tool definitions are served twice, over two transports, from ONE
 * set of definitions — `buildBoardTools` in `tools.ts`. Writing a second copy
 * for the second runtime is the exact shape of the bug this project already
 * has a rule about: the hand-maintained auto-allow list drifted from the tool
 * names and left agents unable to move their own cards, silently.
 *
 * ## The shape
 *
 * ```
 *   extension host                                   codex
 *   ┌──────────────────────────┐                    ┌──────────────┐
 *   │ buildBoardTools(...)     │                    │  app-server  │
 *   │        ▲                 │                    └──────┬───────┘
 *   │   BoardBridge (net)      │                           │ stdio MCP
 *   │        ▲                 │                    ┌──────┴───────┐
 *   └────────┼─────────────────┘   unix socket /    │ board-mcp.js │
 *            └───────────────────  named pipe ──────┤  (this repo) │
 *                                                   └──────────────┘
 * ```
 *
 * ## Three things that are load-bearing
 *
 * **The socket, not a port.** A TCP listener on localhost is reachable by every
 * process on the machine, and these tools write to the board and can START
 * OTHER AGENTS (`split_task`). A unix socket in the extension's own storage
 * directory carries filesystem permissions; on Windows a named pipe is the
 * equivalent. Nimbalyst needs a port and a bearer token because Electron is
 * multi-process — we are not, and adding a port would be adding an attack
 * surface to solve a problem we do not have.
 *
 * **A token as well.** Belt and braces, because a socket path is guessable from
 * a process listing and the cost of checking a string is nothing.
 *
 * **The bridge is per SESSION.** Each one is bound to one card's `key()`,
 * exactly as the in-process server is, so a Codex agent cannot move somebody
 * else's card even by inventing an id — because there is no id to invent: the
 * tools take none.
 */
import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { z } from 'zod'
import { ASKS_FIRST, boardToolName, buildBoardTools, type BoardToolContext } from './tools.ts'
import type { BoardConfig } from '../board/config.ts'

/** What a runtime needs in order to spawn the bridge. */
export interface BridgeDescriptor {
  command: string
  args: string[]
  env: Record<string, string>
}

export interface BoardBridge {
  descriptor: BridgeDescriptor
  /** Fully-qualified names to auto-allow, derived from the definitions. */
  autoAllow: string[]
  dispose: () => void
}

/** One tool, flattened to what MCP needs on the wire. */
interface WireTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * A minimal `tool()` in the Agent SDK's shape.
 *
 * `buildBoardTools` takes the SDK's `tool` helper as an argument — it was
 * written that way so `boardToolNames()` could enumerate the definitions
 * without loading the SDK. That same seam is what lets the bridge collect them
 * here: this factory keeps the zod schema and the handler, and hands back an
 * object of the shape the builder expects.
 *
 * Typed as the SDK's helper at the call site because it is structurally
 * compatible and the builder only ever reads the four fields.
 */
function collector(into: Map<string, {
  def: WireTool
  run: (args: Record<string, unknown>) => Promise<unknown>
  /** The zod object the wire schema was generated FROM, kept so the socket path
   *  can enforce what it advertises. */
  parse: z.ZodTypeAny
}>) {
  return (
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ) => {
    let inputSchema: Record<string, unknown>
    try {
      // zod 4 emits JSON Schema directly. `io: 'input'` matters: an output-shaped
      // schema would advertise defaults as required and the model would send
      // fields the handler never asked for.
      inputSchema = z.toJSONSchema(z.object(schema), { io: 'input' }) as Record<string, unknown>
    } catch {
      // A schema we cannot express is still a tool the agent may call — an
      // empty object schema means "arguments not described", not "no tool".
      // Losing the tool entirely would be the card-cannot-move failure again.
      inputSchema = { type: 'object', properties: {} }
    }
    into.set(name, { def: { name, description, inputSchema }, run: handler, parse: z.object(schema) })
    return { name, description, inputSchema: schema, handler }
  }
}

/**
 * Start a bridge for one session.
 *
 * The socket lives under `dir` — the extension's storage, never the user's
 * repository, and the path is random so two sessions never collide.
 */
export async function startBoardBridge(
  board: BoardConfig,
  ctx: BoardToolContext,
  opts: { dir: string; script: string; node?: string },
): Promise<BoardBridge> {
  const tools = new Map<string, { def: WireTool; run: (args: Record<string, unknown>) => Promise<unknown>; parse: z.ZodTypeAny }>()
  // The cast is the same seam `boardToolNames` uses: the builder reads name,
  // description, schema and handler, and nothing else on the SDK's helper.
  buildBoardTools(board, ctx, collector(tools) as never)

  const token = randomBytes(24).toString('hex')
  const address = socketPath(opts.dir)
  if (process.platform !== 'win32') {
    await fs.mkdir(path.dirname(address), { recursive: true }).catch(() => {})
    await fs.rm(address, { force: true }).catch(() => {})
  }

  const server: Server = createServer((socket: Socket) => serve(socket, token, tools))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, () => resolve())
  })
  // A socket nobody connects to must not hold the extension host open.
  server.unref()

  return {
    descriptor: {
      command: opts.node ?? process.execPath,
      args: [opts.script],
      env: { AGENTS_KANBAN_BRIDGE: address, AGENTS_KANBAN_TOKEN: token },
    },
    autoAllow: [...tools.keys()]
      .filter((n) => !ASKS_FIRST.has(n))
      .map((n) => boardToolName(n)),
    dispose: () => {
      server.close()
      if (process.platform !== 'win32') void fs.rm(address, { force: true }).catch(() => {})
    },
  }
}

/** Where the socket goes. A named pipe on Windows, which has no filesystem
 *  socket and where the path is a reserved namespace rather than a file. */
function socketPath(dir: string): string {
  const id = randomBytes(8).toString('hex')
  if (process.platform === 'win32') return `\\\\.\\pipe\\agents-kanban-${id}`
  // Sockets have a ~104 byte path limit on macOS. A long storage path plus a
  // name would silently exceed it and `listen` would fail with ENAMETOOLONG at
  // the worst possible moment — the first agent run. tmpdir is short and is
  // where a socket belongs anyway.
  const base = dir.length > 60 ? os.tmpdir() : dir
  return path.join(base, `ak-${id}.sock`)
}

/**
 * One connection from a bridge script.
 *
 * Newline-delimited JSON both ways. Deliberately NOT MCP: the child speaks MCP
 * to Codex and this simpler protocol to us, so the MCP shape lives in exactly
 * one file and this side stays a function table.
 */
function serve(
  socket: Socket,
  token: string,
  tools: Map<string, { def: WireTool; run: (args: Record<string, unknown>) => Promise<unknown>; parse: z.ZodTypeAny }>,
): void {
  socket.setEncoding('utf8')
  let buffer = ''
  let authed = false

  const reply = (msg: Record<string, unknown>): void => {
    try { socket.write(`${JSON.stringify(msg)}\n`) } catch { /* the child went away */ }
  }

  socket.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const at = buffer.indexOf('\n')
      if (at < 0) break
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (!line.trim()) continue
      let msg: Record<string, unknown>
      try { msg = JSON.parse(line) as Record<string, unknown> } catch { continue }
      const id = msg.id

      if (!authed) {
        // The first message must be the token. Anything else and the connection
        // is dropped without an explanation — a caller that has not read this
        // file has no business here.
        if (msg.method === 'hello' && msg.token === token) {
          authed = true
          reply({ id, result: { tools: [...tools.values()].map((t) => t.def) } })
        } else {
          socket.destroy()
        }
        continue
      }

      if (msg.method === 'call') {
        const name = typeof msg.name === 'string' ? msg.name : ''
        const entry = tools.get(name)
        if (!entry) { reply({ id, error: `No board tool called ${name}.` }); continue }
        const raw = (msg.args && typeof msg.args === 'object' ? msg.args : {}) as Record<string, unknown>
        /* VALIDATED on our side of the socket, against the very schema this
           server advertises in `tools/list`.
           The in-process path gets this free: the SDK parses the zod schema
           before it calls the handler. The socket path advertised the same
           schema and enforced nothing beyond `typeof === 'object'`, so a
           model-written argument reached the handler unchecked — an
           out-of-enum `urgency` slipped past the `'blocked'` test and
           downgraded a blocked agent's alarm to a chime, and a wrong type
           reached code that assumed the parsed one. "The guard stays on our
           side of the socket" is the rule this transport exists to keep; it
           kept the AUTHORISATION guard and not the shape one.
           A failure comes back as a tool ERROR, so the agent can read the
           schema complaint and fix its call, rather than as a dropped message. */
        const checked = entry.parse.safeParse(raw)
        if (!checked.success) {
          reply({ id, error: `Invalid arguments for ${name}: ${checked.error.issues.map((i: { path: (string | number | symbol)[]; message: string }) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}` })
          continue
        }
        const args = checked.data as Record<string, unknown>
        void Promise.resolve()
          .then(() => entry.run(args))
          .then((result) => reply({ id, result }))
          // A throwing handler must come back as a tool ERROR the agent can
          // read and react to, never as a dropped message: an unanswered MCP
          // call blocks the agent's turn forever, which is the same wedge the
          // permission round trip has a rule about.
          .catch((e: unknown) => reply({ id, error: e instanceof Error ? e.message : String(e) }))
        continue
      }

      reply({ id, error: `Unknown bridge method ${String(msg.method)}.` })
    }
  })

  socket.on('error', () => { /* the child died; the session will report it */ })
}
