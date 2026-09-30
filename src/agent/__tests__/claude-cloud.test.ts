/* A cloud run, end to end, against a stand-in `claude`.
 *
 * The stand-in is spawned FOR REAL, twice over: by the Agent SDK, exactly as a
 * connected run spawns the CLI, and by `script(1)`, exactly as a detached
 * create does. That is the point of it. The fallback from one to the other is
 * decided by the text of the SDK's own error — "Claude Code process exited
 * with code 1. stderr: Error: --cloud requires an interactive terminal." — and
 * a unit test that fed `connectedRefusal` a string it wrote itself would prove
 * nothing about the string the SDK actually builds.
 *
 * Where the stand-in behaves like the real CLI, it is quoting the 2.1.285
 * bundle: the two refusals, the three lines a create prints, the JSON a
 * follow-up prints, the archived error, and "Unable to get organization UUID"
 * for a machine with no claude.ai login.
 *
 * The connected SUCCESS path cannot be produced by any CLI available to this
 * suite (it needs Anthropic's server-side gate), so it is driven through the
 * `connect` seam with a stand-in run — which proves what CloudRun does with a
 * stream once it has one, and nothing about the CLI. DECISIONS.md says so.
 */
import { CloudRun } from '../runtimes/claude-cloud.ts'
import type { AgentRun, RunSpec } from '../runtime.ts'
import type { CloudUpdate } from '../cloud.ts'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const ID = 'session_01CloudStandIn0001'
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const log = (o) => fs.appendFileSync(process.env.FAKE_CLOUD_LOG, JSON.stringify(o) + '\\n')
const mode = process.env.FAKE_CLOUD_MODE || 'ok'
const at = (f) => args.indexOf(f)
log({ argv: args, tty: !!process.stdout.isTTY, bundle: process.env.CCR_FORCE_BUNDLE || null })
if (args.includes('--input-format')) {
  // The SDK's transport. Without the connected-sessions gate, 2.1.285 says one
  // of these and exits 1 before reading anything.
  const next = args[at('--cloud') + 1]
  if (next && !next.startsWith('-')) {
    process.stderr.write('Error: --cloud <session_id> does not support --output-format stream-json\\n')
  } else if (mode === 'nologin-connected') {
    process.stderr.write('Error: Unable to get organization UUID\\n')
  } else {
    process.stderr.write('Error: --cloud requires an interactive terminal.\\nNon-interactive invocations (piped stdout, --init-only, --sdk-url) run locally and would silently ignore --cloud. Drop --cloud, or run from a TTY.\\n')
  }
  process.exit(1)
}
if (args.includes('-p')) {
  let input = ''
  process.stdin.on('data', (d) => { input += d })
  process.stdin.on('end', () => {
    const id = args[at('--cloud') + 1]
    log({ delivered: input, to: id })
    if (mode === 'archived') {
      process.stdout.write(JSON.stringify({ ok: false, session_id: id, error: 'cloud session ' + id + ' is archived and cannot accept new messages' }) + '\\n')
      process.stderr.write('Error: failed to send message to cloud session ' + id + ': archived\\n')
      process.exit(1)
    }
    process.stdout.write(JSON.stringify({ ok: true, session_id: id, url: 'https://claude.ai/code/' + id + '?from=cli&m=0' }) + '\\n')
    process.exit(0)
  })
  return
}
const task = (args.find((a) => a.startsWith('--cloud=')) || '').slice('--cloud='.length)
if (!process.stdout.isTTY) { process.stderr.write('Error: --cloud requires an interactive terminal.\\n'); process.exit(1) }
if (mode === 'trust') {
  process.stdout.write('\\u001b[2GQuick\\u001b[8Gsafety\\u001b[15Gcheck:\\r\\n\\u001b[4GYes,\\u001b[9GI\\u001b[11Gtrust\\u001b[17Gthis\\u001b[22Gfolder\\r\\n')
  setInterval(() => {}, 1000)
  return
}
if (mode === 'nologin') {
  process.stdout.write('\\u001b[38;5;211mError: Unable to get organization UUID\\u001b[39m\\r\\n')
  process.exit(1)
}
process.stderr.write('\\u001b[2mCreating remote session\\u2026\\u001b[22m\\n')
setTimeout(() => {
  const name = at('--name') >= 0 ? args[at('--name') + 1] : task.slice(0, 40)
  process.stdout.write('Created cloud session: ' + name + '\\n')
  process.stdout.write('View: https://claude.ai/code/${ID}?from=cli&m=0\\n')
  process.stdout.write('Resume with: claude --teleport ${ID}\\n')
  process.stdout.write('Left out of the upload: .env (named like a credential)\\n')
  process.exit(0)
}, mode === 'slow' ? 8000 : mode === 'medium' ? 2000 : 150)
`

type Seen = { events: Array<[string, unknown[]]> }
function watch(run: AgentRun): Seen {
  const seen: Seen = { events: [] }
  // The manager always listens for `error`; an EventEmitter with no listener
  // for it throws instead of emitting.
  run.on('error', () => {})
  const orig = run.emit.bind(run)
  run.emit = ((ev: string, ...args: unknown[]) => { seen.events.push([ev, args]); return orig(ev, ...args) }) as typeof run.emit
  return seen
}
const of = (s: Seen, ev: string) => s.events.filter(([e]) => e === ev).map(([, a]) => a)

const dir = await mkdtemp(path.join(tmpdir(), 'ak-cloudrun-'))
const exe = path.join(dir, 'claude')
const logFile = path.join(dir, 'calls.jsonl')
await writeFile(exe, FAKE)
await chmod(exe, 0o755)
const calls = async () => (await readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
const reset = async (mode: string) => { await writeFile(logFile, ''); process.env.FAKE_CLOUD_LOG = logFile; process.env.FAKE_CLOUD_MODE = mode }

const spec = (over: Partial<RunSpec> = {}): RunSpec & { cloud: NonNullable<RunSpec['cloud']> } => ({
  taskId: 'run-1-test', cwd: dir, permissionMode: 'acceptEdits', executable: exe,
  cloud: { title: 'Fix the flaky auth test' }, ...over,
} as RunSpec & { cloud: NonNullable<RunSpec['cloud']> })

const linux = process.platform === 'linux'

try {
  console.log('\n— a new session: the CLI declines to stream it, so it is created the terminal way')
  if (!linux) console.log('  (skipped off Linux: the pseudo-terminal half needs util-linux script)')
  else {
    await reset('ok')
    const run = new CloudRun(spec())
    const seen = watch(run)
    await run.run('Fix the flaky auth test in auth.spec.ts')
    const c = await calls()
    ok(c.length === 2, `two CLI starts: the connected attempt, then the create (${c.length})`)
    ok(Array.isArray(c[0]?.argv) && (c[0]!.argv as string[]).includes('--cloud') && (c[0]!.argv as string[]).includes('--input-format'),
      'first through the SDK, with a bare --cloud')
    ok(!(c[0]!.argv as string[]).includes('--resume'), 'and never with --resume, which the CLI refuses beside --cloud')
    ok(c[0]?.bundle === '1' && c[1]?.bundle === '1', 'CCR_FORCE_BUNDLE on both: the repository is uploaded, no GitHub needed')
    ok(c[1]?.tty === true, 'the create runs on a terminal')
    ok((c[1]!.argv as string[])[0] === '--cloud=Fix the flaky auth test in auth.spec.ts', 'with the task exactly as typed')
    ok((c[1]!.argv as string[]).includes('--name'), 'and the card title as the session name')
    ok(!of(seen, 'error').length, `the refusal never reaches the card as an error (${JSON.stringify(of(seen, 'error'))})`)
    ok(of(seen, 'sessionId')[0]?.[0] === ID, 'the card adopts the cloud session id')
    const cloud = of(seen, 'cloud').map((a) => a[0] as CloudUpdate)
    ok(cloud.length === 1 && cloud[0]!.via === 'detached' && cloud[0]!.id === ID, 'and records where it is, detached')
    ok(cloud[0]?.url === `https://claude.ai/code/${ID}?from=cli&m=0`, 'with the link the CLI printed')
    ok(cloud[0]?.sent?.text === 'Fix the flaky auth test in auth.spec.ts' && cloud[0]?.sent?.ok === true, 'and the task as the first delivered message')
    ok((cloud[0]?.notices ?? []).some((n) => /Left out of the upload/.test(n)), 'the upload notice is carried to the card')
    const done = of(seen, 'done')[0]
    ok(!!done && /Anthropic's cloud/.test(String(done[0])), 'the run ends: created, and working there')
    ok((done?.[1] as { kind?: string } | undefined)?.kind === 'unknown', 'with an unknown meter — never $0.00 for spend nobody here can see')
    ok(run.state.kind === 'done', 'and its state says so')
  }

  console.log('\n— a follow-up to a detached session')
  {
    await reset('ok')
    const run = new CloudRun(spec({ cloud: { id: ID, title: 'T' } }))
    const seen = watch(run)
    await run.run('also update the changelog')
    const c = await calls()
    ok((c[0]!.argv as string[]).join(' ').includes(`--cloud ${ID}`), 'first an attach through the SDK: --cloud <id>')
    const delivered = c.find((x) => 'delivered' in x)
    ok(delivered?.delivered === 'also update the changelog' && delivered?.to === ID, 'then the message, on stdin, to that session')
    const sent = c.find((x) => Array.isArray(x.argv) && (x.argv as string[]).includes('-p'))
    ok(!!sent && !(sent.argv as string[]).includes('also update the changelog'), 'never in the arguments')
    const cloud = of(seen, 'cloud').map((a) => a[0] as CloudUpdate)
    ok(cloud.length === 1 && cloud[0]!.sent?.ok === true && cloud[0]!.sent?.text === 'also update the changelog', 'the delivery is recorded')
    ok(!of(seen, 'sessionId').length, 'no new id is announced — the card already has it')
    ok(/cannot read it/.test(String(of(seen, 'done')[0]?.[0])), 'and the result says the reply is on claude.ai')
  }

  console.log('\n— a follow-up that cannot be delivered')
  {
    await reset('archived')
    const run = new CloudRun(spec({ cloud: { id: ID } }))
    const seen = watch(run)
    await run.run('hello?')
    const err = String(of(seen, 'error')[0]?.[0] ?? '')
    ok(/is archived/.test(err) && /Start a new session instead/.test(err), `the CLI's reason and the fix: ${err}`)
    const cloud = of(seen, 'cloud').map((a) => a[0] as CloudUpdate)
    ok(cloud[0]?.sent?.ok === false, 'recorded as NOT delivered, so the transcript cannot show it as sent')
    ok(!of(seen, 'done').length, 'and never as done')
  }

  if (linux) {
    console.log('\n— a folder nobody has trusted')
    await reset('trust')
    const run = new CloudRun(spec())
    const seen = watch(run)
    const t0 = Date.now()
    await run.run('x')
    const err = String(of(seen, 'error')[0]?.[0] ?? '')
    ok(/trust this folder/.test(err) && /will not answer that/.test(err), `refused, naming the fix: ${err.slice(0, 90)}…`)
    ok(Date.now() - t0 < 8000, 'promptly — the dialog is recognised, not waited out')
    ok(!of(seen, 'cloud').length && !of(seen, 'sessionId').length, 'and no session is claimed')

    console.log('\n— no claude.ai login on this machine')
    await reset('nologin')
    const r2 = new CloudRun(spec())
    const s2 = watch(r2)
    await r2.run('x')
    const e2 = String(of(s2, 'error')[0]?.[0] ?? '')
    ok(/Unable to get organization UUID/.test(e2) && /claude auth login/.test(e2), `the CLI's words, then the fix: ${e2}`)

    console.log('\n— a message typed while the session is still being created')
    // `medium`: the upload takes two seconds, so the message lands mid-create —
    // after the connected attempt was declined, before the link is printed.
    await reset('medium')
    const r3 = new CloudRun(spec())
    const s3 = watch(r3)
    const going = r3.run('first')
    await new Promise((r) => setTimeout(r, 900))
    ok(r3.state.kind === 'working', `still creating when it is typed (${r3.state.kind})`)
    r3.send('and a second thing')
    ok(of(s3, 'queued').some((a) => (a[0] as string[]).includes('and a second thing')), 'it is shown as queued')
    await going
    const c3 = await calls()
    ok(c3.some((x) => x.delivered === 'and a second thing'), 'and delivered once the session exists')
    ok(of(s3, 'cloud').length === 2, 'both messages are on the record')

    console.log('\n— interrupted mid-create')
    await reset('slow')
    const r4 = new CloudRun(spec())
    const s4 = watch(r4)
    const g4 = r4.run('x')
    await new Promise((r) => setTimeout(r, 900))
    await r4.interrupt()
    await g4
    const e4 = String(of(s4, 'error')[0]?.[0] ?? '')
    ok(/Interrupted before the cloud session was created/.test(e4) && /may exist anyway/.test(e4), 'the run ENDS, and says the session may exist anyway')
  }

  console.log('\n— on Windows there is no terminal to lend it')
  {
    await reset('ok')
    const run = new CloudRun(spec(), { platform: 'win32' })
    const seen = watch(run)
    await run.run('x')
    const err = String(of(seen, 'error')[0]?.[0] ?? '')
    ok(/Windows/.test(err) && /claude --cloud/.test(err), 'it says so, and gives the command to run by hand')
  }

  console.log('\n— a failure that is NOT a refusal is never retried the other way')
  {
    await reset('nologin-connected')
    const run = new CloudRun(spec())
    const seen = watch(run)
    await run.run('x')
    const c = await calls()
    ok(c.length === 1, 'one CLI start only — no second session attempted behind the user\'s back')
    ok(/claude auth login/.test(String(of(seen, 'error')[0]?.[0] ?? '')), 'and the error carries the fix')
  }

  console.log('\n— connected: the CLI streams it here')
  {
    await reset('ok')
    class Streamed extends EventEmitter {
      taskId = 't'; runtime = 'claude' as const; state = { kind: 'idle' as const }; lastEvent = 0
      sessionId: string | undefined; resolvedProvider = undefined; meter = { kind: 'usd' as const, spentUsd: 0.01, priced: true }
      sentText: string[] = []
      async run() {
        this.emit('state', { kind: 'starting' })
        this.sessionId = 'session_01LiveStream0001'
        this.emit('sessionId', this.sessionId)
        this.emit('text', 'Looking at auth.spec.ts')
        this.emit('done', 'Fixed.', this.meter, 0.01)
      }
      send(t: string) { this.sentText.push(t) }
      clearQueue() { return 0 }
      async interrupt() {}
      answerPermission() { return true }
      async setPermissionMode() { return true }
      stop() {}
    }
    let given: Record<string, unknown> | undefined
    const inner = new Streamed()
    const run = new CloudRun(spec({ model: 'claude-opus-5', effort: 'high', thinking: 'disabled' }),
      { connect: (o) => { given = o as unknown as Record<string, unknown>; return inner as unknown as AgentRun } })
    const seen = watch(run)
    await run.run('go')
    ok((given?.extraArgs as Record<string, unknown>)?.cloud === null, 'the stream is asked for with a bare --cloud')
    ok((given?.env as Record<string, string>)?.CCR_FORCE_BUNDLE === '1', 'and the upload flag')
    ok(given?.resume === undefined && given?.boardServer === undefined, 'no --resume, and no board tools the cloud cannot reach')
    ok(given?.model === undefined && given?.effort === undefined && given?.thinking === undefined,
      'and no model: the composer offers none for a cloud session, so the workspace default is not sent as if chosen')
    ok(of(seen, 'text')[0]?.[0] === 'Looking at auth.spec.ts', 'the agent\'s text reaches the card as it would locally')
    const cloud = of(seen, 'cloud').map((a) => a[0] as CloudUpdate)
    ok(cloud.length === 1 && cloud[0]!.via === 'live' && cloud[0]!.id === 'session_01LiveStream0001', 'recorded as live, once')
    ok(of(seen, 'done').length === 1 && !of(seen, 'error').length, 'it ends like a local run')
    ok((await calls()).length === 0, 'and nothing was created the terminal way')
    run.send('more')
    ok(inner.sentText[0] === 'more', 'a follow-up goes into the stream')
  }
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(fails ? `\nclaude-cloud: ${fails} FAILED` : '\nclaude-cloud: all ok')
process.exit(fails ? 1 : 0)
