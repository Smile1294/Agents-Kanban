/* Cloud sessions — what the CLI says, and what the board makes of it.
 *
 * The two terminal captures below are REAL: `claude --cloud 'say hi'` run by
 * 2.1.285 under `script(1)` from a board worktree, once with no claude.ai login
 * (its error) and once in a folder nobody had trusted (its safety prompt). They
 * are here byte for byte because the trap they guard is in the bytes: Ink
 * draws the gap between two words as a cursor jump, and a stripper that does
 * not know that reads the trust prompt as one long word and matches nothing.
 *
 * The success lines cannot be captured without creating a real session on
 * somebody's account, so they are written exactly as the CLI's source writes
 * them (`process.stdout.write('Created cloud session: …')` and the two lines
 * after it), with the PTY's CRLF.
 *
 * The last block runs the Linux pseudo-terminal command FOR REAL, through
 * `script`, against a stand-in `claude`: a task containing quotes, `$(…)` and
 * newlines has to reach the CLI as one untouched argument. That is a shell
 * boundary with user-typed text on one side of it.
 */
import {
  cloudCreateArgs, cloudEligibility, cloudSendArgs, cloudSessionIdIn, cloudTranscript, cloudUrlFor,
  connectedRefusal, explainCloudError, isCloudUrl, mergeCloud, parseCloud, ptyInvocation,
  readCloudCreate, readCloudSend, screenText, shellQuote, unknownCloudFlag, MAX_CLOUD_LOG,
} from '../cloud.ts'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// ——— the real captures ———————————————————————————————————————————————————

const NO_LOGIN = '\u001b7\u001b[r\u001b8\u001b[?25h\u001b[38;5;211mError: Unable to get organization UUID\u001b[39m\r\r\n\u001b[?25h\u001b(B\u000f\u001b[?1016l\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l\u001b[>4m\u001b[?1004l\u001b[?2031l\u001b[?2004l\u001b[<u\u001b[?25h\u001b7\u001b[r\u001b8\u001b]0;\u0007\u001b[?25h'

const TRUST = '\u001b7\u001b[r\u001b8\u001b[?25h\u001b[?25l\u001b[?2004h\u001b[?2031h\u001b[?1004h\r\r\n\u001b[38;5;220m────────────────────────────────────────\u001b[39m\r\r\n\u001b[2G\u001b[38;5;220m\u001b[1mAccessing\u001b[12Gworkspace:\u001b[22m\u001b[39m\r\r\n\r\r\n\u001b[2G\u001b[1m/tmp/exp/repo/.agentskanban/worktrees/x\u001b[22m\r\r\n\r\r\n\u001b[2GQuick\u001b[8Gsafety\u001b[15Gcheck:\u001b[22GIs\u001b[25Gthis\u001b[30Ga\u001b[32Gproject\u001b[40Gyou\u001b[44Gcreated\u001b[52Gor\u001b[55Gone\u001b[59Gyou\u001b[63Gtrust?\r\r\n\u001b[2G\u001b[38;5;153m❯\u001b[4GNo,\u001b[8Gexit\u001b[39m\r\r\n\u001b[4GYes,\u001b[9GI\u001b[11Gtrust\u001b[17Gthis\u001b[22Gfolder\r\r\n\r\r\n\u001b[2G\u001b[38;5;246mEnter\u001b[8Gto\u001b[11Gconfirm\u001b[19G·\u001b[21GEsc\u001b[25Gto\u001b[28Gcancel\u001b[39m\r\r\n\u001b[1C\u001b[4A\u001b[>0q\u001b[?u\u001b[c\n'

const ID = 'session_01DiUkqY2kzbUbDmW1w96rfi'
const CREATED =
  '\u001b[2mCreating remote session…\u001b[22m\r\n' +
  'Created cloud session: Fix the flaky auth test\r\n' +
  `View: https://claude.ai/code/${ID}?from=cli&m=0\r\n` +
  `Resume with: claude --teleport ${ID}\r\n` +
  'Left out of the upload: .env (named like a credential)\r\n'

console.log('\n— reading the terminal')
{
  const t = screenText(TRUST)
  ok(/Quick safety check: Is this a project you created/.test(t), `column jumps read as spaces: ${JSON.stringify(t.slice(t.indexOf('Quick'), t.indexOf('Quick') + 45))}`)
  ok(/Yes, I trust this folder/.test(t), 'the option the user would have to pick is readable')
  ok(!/\u001b/.test(t), 'no escape survives')
  ok(readCloudCreate(TRUST, false).kind === 'trust', 'the trust prompt is recognised while the CLI is still waiting on it')

  const e = readCloudCreate(NO_LOGIN, true)
  ok(e.kind === 'error' && e.message === 'Error: Unable to get organization UUID', `the no-login error is quoted exactly: ${JSON.stringify(e)}`)
  ok(e.kind === 'error' && /claude auth login/.test(explainCloudError(e.message)),
    'and explained: that sentence is what a missing claude.ai login looks like')
  ok(explainCloudError('Error: something new') === 'Error: something new', 'an error we do not know is shown as the CLI said it')

  const c = readCloudCreate(CREATED, false)
  ok(c.kind === 'created', 'the three lines the CLI writes are a created session')
  if (c.kind === 'created') {
    ok(c.id === ID, 'the id comes from the teleport line')
    ok(c.url === `https://claude.ai/code/${ID}?from=cli&m=0`, 'the link is the one the CLI printed')
    ok(c.title === 'Fix the flaky auth test', 'and the title the cloud gave it')
    ok(c.notices.length === 1 && /Left out of the upload/.test(c.notices[0]!), 'the bundle notices after it are kept')
  }
  const noView = readCloudCreate(`Resume with: claude --teleport ${ID}\r\n`, true)
  ok(noView.kind === 'created' && noView.url === cloudUrlFor(ID), 'no View line: the documented link form is built from the id')

  ok(readCloudCreate('\u001b[2mCreating remote session…\u001b[22m\r\n', false).kind === 'pending',
    'half-way through is pending, not a failure')
  const quiet = readCloudCreate('\u001b[2mCreating remote session…\u001b[22m\r\n', true)
  ok(quiet.kind === 'error' && /exited without creating a cloud session\. It said: Creating remote session/.test(quiet.message),
    'exiting half-way is a failure that quotes what it last said')
  const silent = readCloudCreate('', true)
  ok(silent.kind === 'error' && /said nothing/.test(silent.message), 'and a silent exit says so')

  const tui = readCloudCreate(`\u001b[2G╭ Remote session https://claude.ai/code/${ID}?from=cli ╮`, false)
  ok(tui.kind === 'attached' && tui.id === ID, 'a link inside an interactive screen is an attached session, not a created one')
}

console.log('\n— a follow-up')
{
  const sent = readCloudSend(`{"ok":true,"session_id":"${ID}","url":"https://claude.ai/code/${ID}?from=cli&m=0"}\n`, '', 0)
  ok(sent.ok && sent.id === ID && !!sent.url, 'the JSON success is read')
  const archived = readCloudSend(`{"ok":false,"session_id":"${ID}","error":"cloud session ${ID} is archived and cannot accept new messages"}\n`, `Error: failed to send message to cloud session ${ID}: …\n`, 1)
  ok(!archived.ok && /is archived/.test(archived.error), 'a failed delivery carries the CLI\'s own reason')
  const policy = readCloudSend('', 'Error: Cloud sessions are disabled by your organization\'s policy. Contact your organization admin to enable them.\n', 1)
  ok(!policy.ok && /^Cloud sessions are disabled/.test(policy.error), 'a configuration error has no JSON and is read off stderr')
  ok(!policy.ok && /admin-settings/.test(explainCloudError(policy.error)), 'and gets the fix from the error table')
  const text = readCloudSend(`Sent to cloud session.\nSession ID: ${ID}\nView: https://claude.ai/code/${ID}\n`, '', 0)
  ok(text.ok && text.id === ID, 'the text form counts too')
  const none = readCloudSend('', '', 137)
  ok(!none.ok && /exited with code 137 and said nothing/.test(none.error), 'nothing at all is a failure that says so, never a success')
  ok(cloudSendArgs(ID).join(' ') === `-p --cloud ${ID} --output-format json`, 'the message is not in the arguments — it goes on stdin')
}

console.log('\n— the CLI refusing to stream it here')
{
  // As they reach us: inside the SDK's own error, after the stderr tail.
  const sdk = (s: string) => `Claude Code process exited with code 1. stderr: ${s}`
  ok(connectedRefusal(sdk('Error: --cloud requires an interactive terminal.\nNon-interactive invocations (piped stdout, --init-only, --sdk-url) run locally and would silently ignore --cloud. Drop --cloud, or run from a TTY.')),
    'a create without the connected gate is a refusal')
  ok(connectedRefusal(sdk('Error: --cloud <session_id> does not support --output-format stream-json')), 'so is an attach')
  ok(connectedRefusal(sdk('Error: Attaching to an existing cloud session is not enabled for your account.')), 'and the attach gate by name')
  ok(!connectedRefusal(sdk('Error: Unable to get organization UUID')), 'a missing login is NOT a refusal — falling back would fail the same way, later')
  ok(!connectedRefusal('Claude Code process exited with code 1'), 'nor is a bare crash')
  ok(unknownCloudFlag("error: unknown option '--cloud'"), 'a CLI older than the flag is its own case')
}

console.log('\n— who may start one')
{
  // EXACTLY what 2.1.285 reports for a claude.ai subscription: a plan, and NO
  // tokenSource (the CLI omits it for subscribers). The first version required
  // tokenSource === 'claude.ai' and told every subscriber they were signed out.
  const sub = cloudEligibility({ subscriptionType: 'Claude Max', email: 'd@example.com', organization: 'Prduct', apiProvider: 'firstParty' })
  ok(sub.ok && sub.plan === 'Claude Max' && sub.account === 'd@example.com', 'a claude.ai subscription, as the CLI really reports it, can')
  ok(cloudEligibility({ subscriptionType: 'Claude Team', apiProvider: 'firstParty' }).ok, 'a Team plan can')
  const yes = cloudEligibility({ tokenSource: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max', email: 'd@example.com' })
  ok(yes.ok && yes.plan === 'max' && yes.account === 'd@example.com', 'an older CLI naming claude.ai as the source can too')
  const both = cloudEligibility({ subscriptionType: 'Claude Pro', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })
  ok(!both.ok && /ANTHROPIC_API_KEY/.test(both.reason), 'a subscription with an API key overriding it cannot — the key is what requests use')
  const token = cloudEligibility({ tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' })
  ok(!token.ok && /setup-token/.test(token.reason), 'a setup-token token cannot — it is inference-only — and is told why')
  const key = cloudEligibility({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })
  ok(!key.ok && /ANTHROPIC_API_KEY/.test(key.reason), 'an API key cannot, and the reason names it')
  const gw = cloudEligibility({ tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' })
  ok(!gw.ok, 'a gateway profile with its own token cannot')
  const bedrock = cloudEligibility({ apiProvider: 'bedrock' })
  ok(!bedrock.ok && /bedrock/.test(bedrock.reason), 'a third-party backend cannot')
  ok(!cloudEligibility({ tokenSource: 'none', apiKeySource: 'none' }).ok, 'nobody signed in cannot')
  ok(!cloudEligibility(undefined).ok, 'no answer is not a yes')
}

console.log('\n— the commands')
{
  const a = cloudCreateArgs('--help me', { title: 'A card', permissionMode: 'plan' })
  ok(a[0] === '--cloud=--help me', 'a task starting with a dash stays the value of --cloud')
  ok(a.includes('--name') && a[a.indexOf('--name') + 1] === 'A card', 'the card title names the cloud session')
  ok(a.includes('--permission-mode') && a[a.indexOf('--permission-mode') + 1] === 'plan', 'plan mode is forwarded')
  ok(!cloudCreateArgs('x', { permissionMode: 'bypassPermissions' }).includes('--permission-mode'), 'bypass is not — cloud sessions refuse it')
  ok(!cloudCreateArgs('x', { permissionMode: 'default' }).includes('--permission-mode'), 'nor the default, which is the cloud\'s own')
  ok(!cloudCreateArgs('x').some((s) => s.startsWith('--model')), 'no model: the CLI would drop it here and the card would name the wrong one')

  ok(shellQuote(`it's`) === `'it'\\''s'`, 'a quote inside a quote')
  ok(ptyInvocation('win32', ['claude']) === undefined, 'Windows has no script(1), and the answer says so')
  const mac = ptyInvocation('darwin', ['/usr/local/bin/claude', '--cloud=x y'])!
  ok(mac.command === 'script' && mac.args.slice(-2).join('|') === '/usr/local/bin/claude|--cloud=x y', 'BSD script gets the argv untouched, after a shell that sets the width')

  ok(isCloudUrl(`https://claude.ai/code/${ID}?from=cli&m=0`), 'a claude.ai session link is openable')
  ok(!isCloudUrl('javascript:alert(1)') && !isCloudUrl('http://claude.ai/code/x') && !isCloudUrl('https://evil.example/code/x'),
    'anything else is not: the link came out of another program\'s output')
  ok(cloudSessionIdIn(`see claude.ai/code/${ID}?x`) === ID, 'an id is found inside a link')
}

console.log('\n— what the sidecar keeps')
{
  const r1 = mergeCloud(undefined, { id: ID, url: cloudUrlFor(ID), via: 'detached', title: 'T', sent: { at: 10, text: 'do it', ok: true } }, 5)
  ok(r1.id === ID && r1.createdAt === 5 && r1.log.length === 1 && r1.title === 'T', 'the first update makes the record')
  const r2 = mergeCloud(r1, { id: ID, url: cloudUrlFor(ID), via: 'detached', sent: { at: 20, text: 'more', ok: false, error: 'archived' } })
  ok(r2.log.length === 2 && r2.createdAt === 5 && r2.title === 'T', 'a delivery appends, keeping when and what')
  const other = mergeCloud(r2, { id: 'session_somethingelse01', url: cloudUrlFor('session_somethingelse01'), via: 'live' })
  ok(other.id === ID && other.via === 'detached', 'a different id does not re-point the card')
  ok(mergeCloud(r2, { id: ID, url: cloudUrlFor(ID), via: 'live' }).via === 'live', 'live, once seen, wins')

  // Key order is not meaning: compare canonically.
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : x)
  const back = parseCloud(JSON.parse(JSON.stringify(r2)))
  ok(!!back && canon(back) === canon(r2), 'it round-trips through JSON unchanged')
  ok(parseCloud({ id: 'not an id', url: 'x' }) === undefined, 'an entry without a real id is no record')
  ok(parseCloud({ id: ID, url: 'javascript:x' })?.url === cloudUrlFor(ID), 'a stored link that is not claude.ai is replaced, not trusted')
  ok(parseCloud({ id: ID, log: [{ at: 1, text: 'x', ok: true }, { at: 'no' }, null, 'junk'] })?.log.length === 1, 'bad log rows are dropped, good ones kept')
  let big = r1
  for (let i = 0; i < MAX_CLOUD_LOG + 20; i++) big = mergeCloud(big, { id: ID, url: r1.url, via: 'detached', sent: { at: i, text: String(i), ok: true } })
  ok(big.log.length === MAX_CLOUD_LOG && big.log[big.log.length - 1]!.text === String(MAX_CLOUD_LOG + 19), 'the log is bounded, newest kept')

  const t = cloudTranscript(r2)
  ok(t[0]?.kind === 'prompt' && t[1]?.kind === 'notice', 'the transcript is the first prompt, then where the replies are')
  ok(t[1]?.kind === 'notice' && /cannot read its replies/.test(t[1].message) && t[1].message.includes(r2.url),
    'and the notice says the board cannot read them, with the link')
  ok(t.some((e) => e.kind === 'error' && /Not delivered.*archived/.test(e.message)), 'a failed delivery is a red row, not a sent message')
  ok(cloudTranscript({ ...r2, log: [] }).length === 1, 'no messages: the notice alone, never an empty chat')
  ok(/not on this machine/.test((cloudTranscript({ ...r2, via: 'live', log: [] })[0] as { message: string }).message),
    'a live session that has gone says its conversation is kept in the cloud')
}

console.log('\n— through a real pseudo-terminal')
if (process.platform !== 'linux') {
  console.log('  (skipped: the util-linux form is what runs here; BSD script is checked by shape above)')
} else {
  const dir = await mkdtemp(path.join(tmpdir(), 'ak-cloud-'))
  try {
    const seen = path.join(dir, 'argv.json')
    const fake = path.join(dir, 'claude')
    // A stand-in that proves it got a TTY, records exactly what it was given,
    // and answers the way the real CLI does.
    await writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ argv: process.argv.slice(2), tty: !!process.stdout.isTTY, cols: process.stdout.columns }))
if (!process.stdout.isTTY) { process.stderr.write('Error: --cloud requires an interactive terminal.\\n'); process.exit(1) }
process.stdout.write('Created cloud session: T\\n')
process.stdout.write('View: https://claude.ai/code/${ID}?from=cli&m=0\\n')
process.stdout.write('Resume with: claude --teleport ${ID}\\n')
`)
    await chmod(fake, 0o755)
    const task = `fix it's "quoted" $(touch ${path.join(dir, 'pwned')}) \`id\`\nsecond line`
    const inv = ptyInvocation('linux', [fake, ...cloudCreateArgs(task)])!
    const out = await new Promise<{ text: string; code: number | null }>((resolve) => {
      const p = spawn(inv.command, inv.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, SHELL: '/bin/sh' } })
      let text = ''
      p.stdout.on('data', (b: Buffer) => { text += b.toString('utf8') })
      p.stderr.on('data', (b: Buffer) => { text += b.toString('utf8') })
      p.on('close', (code) => resolve({ text, code }))
    })
    const got = JSON.parse(await readFile(seen, 'utf8')) as { argv: string[]; tty: boolean; cols: number }
    ok(got.tty, 'the CLI gets a terminal')
    ok(got.cols === 200, `at 200 columns, so nothing it draws wraps (${got.cols})`)
    ok(got.argv[0] === `--cloud=${task}`, 'a task with quotes, $(…), backticks and a newline arrives as ONE untouched argument')
    const pwned = await readFile(path.join(dir, 'pwned')).then(() => true, () => false)
    ok(!pwned, 'and nothing in it ran')
    const r = readCloudCreate(out.text, true)
    ok(r.kind === 'created' && r.id === ID, `and what it printed reads as a created session (${r.kind}, exit ${out.code})`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

console.log(fails ? `\ncloud: ${fails} FAILED` : '\ncloud: all ok')
process.exit(fails ? 1 : 0)
