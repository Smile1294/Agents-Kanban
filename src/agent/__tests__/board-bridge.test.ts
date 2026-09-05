/* Can a runtime that spawns MCP servers actually move its own card?
 *
 * This drives the REAL bridge and the REAL built `dist/board-mcp.js`, over a
 * real socket, speaking real MCP — because every part of that sentence is a
 * seam, and this project's whole test philosophy is that the bugs live in seams
 * rather than in modules. A mock of the child process would prove that our mock
 * can talk to our host.
 *
 * It asserts against the BUILT BUNDLE for the same reason
 * `executable.test.ts` does: the child is spawned as `node dist/board-mcp.js`
 * in production, so a bundling mistake — a stray external, an import that
 * resolves in a dev checkout and not in a spawned process — is invisible to
 * every test that runs the source.
 *
 * The load-bearing case is the LAST one. `set_phase('complete')` must be
 * refused across the socket, because the human-only guard is the board's
 * approval gate, and a guard that only holds for the runtime we happened to
 * write first is not a guard.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBoardBridge } from '../board-bridge.ts'
import { DEFAULT_BOARD } from '../../board/config.ts'
import type { BoardToolContext } from '../tools.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../../..')
const script = path.join(root, 'dist', 'board-mcp.js')

/** A client that speaks MCP to the child exactly as Codex would. */
class McpClient {
  private readonly child: ReturnType<typeof spawn>
  private readonly waiting = new Map<number, (v: Record<string, unknown>) => void>()
  private buffer = ''
  private id = 1
  readonly stderr: string[] = []

  constructor(cmd: string, args: string[], env: Record<string, string>) {
    this.child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdout!.setEncoding('utf8')
    this.child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk
      for (;;) {
        const at = this.buffer.indexOf('\n')
        if (at < 0) break
        const line = this.buffer.slice(0, at)
        this.buffer = this.buffer.slice(at + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line) as Record<string, unknown>
        const w = this.waiting.get(msg.id as number)
        if (w) { this.waiting.delete(msg.id as number); w(msg) }
      }
    })
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (c: string) => this.stderr.push(c))
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.id++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000)
      this.waiting.set(id, (v) => { clearTimeout(timer); resolve(v) })
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  kill(): void { this.child.kill() }
}

function textOf(result: unknown): string {
  const content = (result as { content?: { text?: string }[] })?.content ?? []
  return content.map((c) => c.text ?? '').join('\n')
}

async function main(): Promise<void> {
  try {
    await access(script)
  } catch {
    console.log('FAIL: dist/board-mcp.js is missing — run `npm run build` first.')
    process.exit(1)
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'ak-bridge-'))

  // A store small enough to answer the tools, and honest about what was asked.
  const phases: string[] = []
  let title = 'guessed from the prompt'
  const store = {
    card: async () => ({ phase: 'planning', tags: [] as string[] }),
    setPhase: async (_k: string, phase: string) => { phases.push(phase) },
    setTags: async () => {},
    list: async () => [],
    childrenOf: async () => [],
    patch: async () => {},
  }
  const ctx: BoardToolContext = {
    store: store as never,
    key: () => 'session-1',
    onChanged: () => {},
    onRename: (t: string) => { title = t; return { renamed: true } },
    derivedTitle: () => 'guessed from the prompt',
  }

  const bridge = await startBoardBridge(DEFAULT_BOARD, ctx, { dir, script })

  // The auto-allow list is DERIVED, never written out. `split_task` is the one
  // tool deliberately left off it.
  ok(bridge.autoAllow.includes('mcp__board__set_phase'), 'set_phase is auto-allowed')
  ok(!bridge.autoAllow.some((n) => n.endsWith('split_task')), 'split_task still asks first')

  const client = new McpClient(bridge.descriptor.command, bridge.descriptor.args, bridge.descriptor.env)

  const init = await client.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'codex-alike', version: '1' },
  })
  const initResult = init.result as Record<string, unknown>
  ok(!!initResult, 'the MCP server completes an initialize handshake')
  ok((initResult.serverInfo as { name?: string })?.name === 'board', 'it names itself `board`')

  const listed = await client.send('tools/list')
  const tools = ((listed.result as { tools?: { name: string; inputSchema?: Record<string, unknown> }[] })?.tools) ?? []
  const names = tools.map((t) => t.name)
  ok(names.includes('set_phase'), `tools/list carries set_phase (got ${names.join(', ')})`)
  ok(names.includes('set_title'), 'tools/list carries set_title')

  // A schema the model can actually fill in. An empty properties object would
  // list the tool and make it uncallable — worse than not listing it.
  const setPhase = tools.find((t) => t.name === 'set_phase')
  const props = (setPhase?.inputSchema?.properties ?? {}) as Record<string, unknown>
  ok('phase' in props, `set_phase advertises a \`phase\` argument (got ${Object.keys(props).join(', ')})`)

  // --- the round trip that is the whole point -------------------------------
  const moved = await client.send('tools/call', { name: 'set_phase', arguments: { phase: 'implementing' } })
  ok(phases.includes('implementing'), 'a tools/call reached the REAL handler in the host')
  ok(!(moved.result as { isError?: boolean })?.isError, `the move succeeded (${textOf(moved.result)})`)

  const renamed = await client.send('tools/call', { name: 'set_title', arguments: { title: 'Drive Codex from the board' } })
  ok(title === 'Drive Codex from the board', `set_title renamed the card (title is now "${title}")`)
  ok(!(renamed.result as { isError?: boolean })?.isError, 'set_title reported success')

  // --- the boundary ---------------------------------------------------------
  // `complete` is humanOnly. The guard lives in the host, on our side of the
  // socket, precisely so that a runtime spawning this server cannot route
  // around it.
  const denied = await client.send('tools/call', { name: 'set_phase', arguments: { phase: 'complete' } })
  ok(!phases.includes('complete'), 'set_phase("complete") never reached the store')
  ok((denied.result as { isError?: boolean })?.isError === true, 'and came back as a tool error the agent can read')

  // --- an unknown tool is refused, not dropped ------------------------------
  const bogus = await client.send('tools/call', { name: 'delete_everything', arguments: {} })
  ok((bogus.result as { isError?: boolean })?.isError === true, 'an unknown tool answers with an error rather than hanging')

  // --- the schema it ADVERTISES is the schema it enforces --------------------
  //
  // `tools/list` publishes a JSON Schema generated from the tool's zod object,
  // and this path enforced nothing beyond `typeof args === 'object'`. The
  // in-process path gets validation free — the SDK parses before it calls the
  // handler — so the socket was the one transport where a model-written
  // argument reached the handler unchecked. "The guard stays on our side of the
  // socket" is the rule this transport exists to keep; it kept the
  // authorisation guard and not the shape one.
  {
    const before = phases.length
    const wrongType = await client.send('tools/call', { name: 'set_phase', arguments: { phase: 42 } })
    ok(phases.length === before, 'a wrongly-typed argument never reaches the handler')
    ok(/invalid arguments/i.test(JSON.stringify(wrongType)),
       `and comes back as a tool error the agent can act on (${JSON.stringify(wrongType).slice(0, 120)})`)

    const missing = await client.send('tools/call', { name: 'set_phase', arguments: {} })
    ok(phases.length === before, 'a missing required argument never reaches it either')
    ok(/invalid arguments/i.test(JSON.stringify(missing)), 'and is also a described error')

    // A VALID call still goes through — a validator that refuses everything is
    // the card-cannot-move failure in a new place.
    await client.send('tools/call', { name: 'set_phase', arguments: { phase: 'backlog' } })
    ok(phases.includes('backlog'), 'while a well-formed call still reaches the store')
  }

  // --- the token is required ------------------------------------------------
  // A second client with the wrong token must get nothing. The socket path is
  // guessable from a process listing; the token is what makes that not enough.
  const impostor = new McpClient(bridge.descriptor.command, bridge.descriptor.args, {
    ...bridge.descriptor.env,
    AGENTS_KANBAN_TOKEN: 'not-the-token',
  })
  const refused = await impostor.send('tools/list').then(() => false).catch(() => true)
  ok(refused, 'a client with the wrong token gets no tools')
  impostor.kill()

  client.kill()
  bridge.dispose()
  await rm(dir, { recursive: true, force: true })

  console.log(fails ? `\n${fails} failed` : '\nall passed')
  process.exit(fails ? 1 : 0)
}

void main()
