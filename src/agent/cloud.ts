/** Running a card's session on Anthropic's cloud instead of this machine —
 * Claude Code on the web — through the `claude` CLI and nothing else.
 *
 * ## Why the CLI, and only the CLI
 *
 * Anthropic's terms are explicit: "developers may not collect, store, or
 * intermediate Claude.ai credentials or session tokens"
 * (code.claude.com/docs/en/legal-and-compliance). The CLI talks to claude.ai's
 * session API with the login it keeps in `~/.claude/.credentials.json` or the
 * macOS keychain, and it would be easy to read that token and call the same
 * API from here — that is precisely what the sentence forbids. So nothing in
 * this board reads that login or calls claude.ai. Everything goes through the
 * unmodified binary, signed in with the user's own subscription, which is the
 * one arrangement the same page says it does not restrict.
 *
 * ## What the CLI lets an editor do (2.1.285, read out of its own bundle)
 *
 * | Ask | How | Available |
 * |---|---|---|
 * | Create a session and STREAM it | the Agent SDK's stream-json transport plus `--cloud` | behind a server-side gate ("connected sessions"); refused otherwise with "--cloud requires an interactive terminal" |
 * | Attach to one and stream it | stream-json plus `--cloud <id>` | the same gate; refused with "--cloud <session_id> does not support --output-format stream-json" |
 * | Create one, print its link, exit | `claude --cloud "<task>"` on a TTY | yes: `Created cloud session: …` / `View: <url>` / `Resume with: claude --teleport <id>` |
 * | Create one from a pipe | `claude -p --cloud "<task>"` | no: `cloudPrintEnabled()` is compiled to `false` |
 * | Send a follow-up | `claude -p --cloud <id> --output-format json`, message on stdin | yes: `{ok, session_id, url}` |
 * | Read its replies | — | nothing: `-p --teleport` checks the branch out and then runs a LOCAL turn |
 *
 * So a cloud run tries the first row, which is the whole feature — its frames
 * arrive through the same `AgentSession` a local run uses. When the CLI
 * refuses, it creates the session through the third row inside a
 * pseudo-terminal (`script(1)`, because the CLI checks for a TTY) and sends
 * follow-ups through the fifth. In that DETACHED mode the board can start the
 * work and deliver messages but cannot read one reply, and the card says so
 * instead of drawing a spinner over a conversation it cannot see.
 *
 * ## No GitHub
 *
 * `CCR_FORCE_BUNDLE=1` on every cloud run. The CLI then uploads the checkout
 * as a git bundle — history, and uncommitted changes to tracked files —
 * instead of asking the cloud to clone a remote. For a repository with no
 * GitHub remote that is the only way in at all; for one with a remote it is
 * still the right semantics, because a card forks from a LOCAL branch that was
 * never pushed, and the cloud must start from exactly the commit a local card
 * would. The flag is documented by Anthropic for this purpose. What a bundle
 * cannot do is come back: a session seeded from one pushes only where the
 * user's GitHub connection reaches, so without GitHub its changes stay in the
 * cloud session — which the card also says.
 *
 * Pure: no process is spawned here, so every rule above is testable without a
 * login. The spawning is `runtimes/claude-cloud.ts`.
 */
import type { Entry } from '../sessions/store.ts'

/** Added to every cloud run's environment. See "No GitHub" above. */
export const CLOUD_ENV: Readonly<Record<string, string>> = { CCR_FORCE_BUNDLE: '1' }

/** Where a cloud session is watched, from its id — the documented form
 *  (`claude.ai/code/<id>`). Used only when the CLI named the id and not the
 *  link; the CLI's own link is preferred whenever it printed one. */
export function cloudUrlFor(id: string): string {
  return `https://claude.ai/code/${encodeURIComponent(id)}`
}

/** A link this board will open for a cloud card: claude.ai's own pages, https
 *  only. The URL came out of another program's terminal output, and
 *  `openExternal` hands any scheme to the OS. */
export function isCloudUrl(url: string): boolean {
  return /^https:\/\/claude\.ai\/code\/[A-Za-z0-9_%-]+(?:[/?#][^\s]*)?$/.test(url)
}

/** A cloud session id as the CLI accepts it: `session_…` or `cse_…` — the same
 *  session under two prefixes, both taken by `--cloud <id>`. */
const SESSION_ID = /\b((?:session|cse)_[A-Za-z0-9]{6,})\b/

export function cloudSessionIdIn(text: string): string | undefined {
  return SESSION_ID.exec(text)?.[1]
}

// ---------------------------------------------------------------------------
// Who may start one
// ---------------------------------------------------------------------------

export type CloudEligibility =
  | { ok: true; plan?: string; account?: string }
  | { ok: false; reason: string }

/**
 * Can THIS login start a cloud session? From `Query.accountInfo()`, asked in
 * the environment a session would get — so a gateway profile that sets its
 * own key is judged as that key, not as whatever `claude` does on its own.
 *
 * The line is `tokenSource === 'claude.ai'`, and it is narrower than
 * "subscription" on purpose. It is what the CLI's own cloud path requires (it
 * reads the stored claude.ai OAuth login and nothing else), and it excludes a
 * token from `claude setup-token`: that is a subscription credential too, but
 * it is inference-only, and cloud-session control needs a scope it does not
 * carry — so offering the checkbox on it would be a control that cannot work.
 * Each refusal names its own fix, because they are different fixes.
 */
export function cloudEligibility(info: unknown): CloudEligibility {
  if (!info || typeof info !== 'object') {
    return { ok: false, reason: 'Claude Code did not say which account it is signed in to.' }
  }
  const i = info as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const provider = str(i.apiProvider)
  if (provider && provider !== 'firstParty') {
    return {
      ok: false,
      reason: `Cloud sessions run on Anthropic's own infrastructure and need an Anthropic account; ` +
        `this backend is ${provider}.`,
    }
  }
  const token = str(i.tokenSource)
  if (token === 'claude.ai') {
    const plan = str(i.subscriptionType)
    const account = str(i.email) ?? str(i.emailAddress)
    return { ok: true, ...(plan ? { plan } : {}), ...(account ? { account } : {}) }
  }
  if (token === 'CLAUDE_CODE_OAUTH_TOKEN' || token === 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR') {
    return {
      ok: false,
      reason: 'Claude Code is using a long-lived token (claude setup-token), which can run models but ' +
        'not cloud sessions. Sign in with `claude auth login` to use them.',
    }
  }
  const key = str(i.apiKeySource)
  if ((key && key !== 'none') || (token && token !== 'none')) {
    return {
      ok: false,
      reason: 'Cloud sessions need a claude.ai subscription login, and this backend signs in with ' +
        `${key && key !== 'none' ? key : token}.`,
    }
  }
  return { ok: false, reason: 'Claude Code is not signed in to a claude.ai account. Run `claude auth login`.' }
}

// ---------------------------------------------------------------------------
// What the CLI said
// ---------------------------------------------------------------------------

/**
 * The CLI refusing to stream a cloud session to this host, as opposed to a
 * run that failed. Only these three sentences, all quoted from the 2.1.285
 * bundle: anything else is a real failure and must be shown as one, or a
 * broken flag would silently turn into a session nobody can read.
 */
export function connectedRefusal(message: string): boolean {
  return /--cloud requires an interactive terminal/i.test(message)
    || /--cloud <session_id> does not support --output-format stream-json/i.test(message)
    || /Attaching to an existing cloud session is not enabled/i.test(message)
}

/** A CLI that predates `--cloud`. Not a refusal: the detached path uses the
 *  same flag, so there is nothing to fall back to — only an update. */
export function unknownCloudFlag(message: string): boolean {
  return /unknown option ['"]?--cloud/i.test(message)
}

/**
 * A terminal's bytes as the words a person would read.
 *
 * Ink draws the gap between two words by moving the cursor to a column
 * (`ESC[12G`), not by printing a space, so stripping escapes naively turns the
 * CLI's trust prompt into "Isthisaprojectyoucreated…" and no pattern matches
 * it — that is what the first capture of it looked like. A column jump becomes
 * one space, cursor-forward that many; every other escape goes.
 */
export function screenText(raw: string): string {
  return raw
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => ' '.repeat(Math.min(Number(n) || 1, 200)))
    .replace(/\x1b\[\d*G/g, ' ')
    .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '')
    .replace(/\x1b[78=>@-Z\\^_]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

export type CloudCreateOutcome =
  | { kind: 'created'; id: string; url: string; title?: string; notices: string[] }
  /** A newer CLI opened the session interactively instead of printing its link
   *  and exiting. The session exists; whether the task reached it, the board
   *  cannot tell. */
  | { kind: 'attached'; id: string; url: string }
  /** Claude Code stopped to ask whether to trust the folder. Never answered from
   *  here: that dialog is the user's safety check, not a formality. */
  | { kind: 'trust' }
  | { kind: 'error'; message: string }
  | { kind: 'pending' }

/**
 * Read the output of `claude --cloud "<task>"`, so far.
 *
 * The success lines are the CLI's own `process.stdout.write` calls — raw, not
 * drawn by Ink, so a narrow terminal does not wrap them. `exited` turns
 * "nothing yet" into a failure that quotes whatever the CLI did say last.
 */
export function readCloudCreate(raw: string, exited: boolean): CloudCreateOutcome {
  const text = screenText(raw)
  const id = /Resume with:\s*claude --teleport\s+(\S+)/.exec(text)?.[1]
  if (id) {
    const url = /View:\s*(https:\/\/\S+)/.exec(text)?.[1]
    const title = /Created cloud session:\s*([^\n]*)/.exec(text)?.[1]?.trim()
    const after = text.slice(text.search(/Resume with:/))
    const notices = after.split('\n').slice(1).map((l) => l.trim()).filter(Boolean).slice(0, 8)
    return {
      kind: 'created', id,
      url: url && isCloudUrl(url) ? url : cloudUrlFor(id),
      ...(title ? { title } : {}),
      notices,
    }
  }
  if (/Quick safety check|Yes, I trust this folder|trust this folder/i.test(text)) return { kind: 'trust' }
  const err = text.search(/(^|\n)\s*Error: /)
  if (err >= 0) return { kind: 'error', message: tidy(text.slice(err)) }
  const link = /https:\/\/claude\.ai\/code\/((?:session|cse)_[A-Za-z0-9]{6,})[^\s]*/.exec(text)
  if (link) return { kind: 'attached', id: link[1]!, url: link[0] }
  if (exited) {
    const said = tidy(text)
    return {
      kind: 'error',
      message: said
        ? `Claude Code exited without creating a cloud session. It said: ${said}`
        : 'Claude Code exited without creating a cloud session, and said nothing.',
    }
  }
  return { kind: 'pending' }
}

/**
 * The CLI's cloud errors, with the fix Anthropic's own error table gives for
 * each. The message is the CLI's; only the second half is ours, and only for
 * the errors whose words do not already say what to do — "Unable to get
 * organization UUID" is what a missing claude.ai login looks like, and nobody
 * would guess that from the sentence.
 */
export function explainCloudError(message: string): string {
  const fix =
    /Unable to get organization UUID|API key authentication is not sufficient|require[s]? a claude\.ai login/i.test(message)
      ? 'Claude Code is not signed in to a claude.ai account here (an API key is not enough). Run `claude auth login`, then try again.'
      : /disabled by your organization'?s policy/i.test(message)
        ? 'An Owner of your organization can turn cloud sessions on at claude.ai/admin-settings/claude-code.'
        : /Session not found/i.test(message)
          ? 'The session may have been deleted on claude.ai.'
          : /is archived and cannot accept new messages/i.test(message)
            ? 'Start a new session instead.'
            : /Couldn'?t verify your organization'?s policy/i.test(message)
              ? 'Claude Code could not reach Anthropic to check; this is usually the network.'
              : undefined
  return fix ? `${message} — ${fix}` : message
}

/** A message's last lines, deduplicated — Ink redraws frames, so the same line
 *  can appear many times in one capture — and bounded, because this lands on a
 *  card. */
function tidy(text: string): string {
  const lines: string[] = []
  for (const l of text.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    if (lines[lines.length - 1] !== l) lines.push(l)
  }
  const joined = lines.slice(-12).join(' ')
  return joined.length > 600 ? joined.slice(0, 600) + '…' : joined
}

export type CloudSendOutcome =
  | { ok: true; id: string; url?: string }
  | { ok: false; error: string }

/**
 * Read `claude -p --cloud <id> --output-format json`.
 *
 * JSON on stdout for a delivery, either way (`{ok, session_id, url}` or
 * `{ok: false, session_id, error}`); a CONFIGURATION error — a third-party
 * backend, a disabled organisation policy — goes to stderr with no JSON at
 * all, which is why stderr is read too rather than reporting "no answer".
 */
export function readCloudSend(stdout: string, stderr: string, code: number | null): CloudSendOutcome {
  for (const line of stdout.split('\n').reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      const j = JSON.parse(t) as Record<string, unknown>
      if (j.ok === true && typeof j.session_id === 'string') {
        return { ok: true, id: j.session_id, ...(typeof j.url === 'string' ? { url: j.url } : {}) }
      }
      if (j.ok === false) {
        return { ok: false, error: typeof j.error === 'string' && j.error ? j.error : 'the message was not delivered' }
      }
    } catch {
      // Not the line we want; keep looking.
    }
  }
  // The text form, from a CLI that ignored the format flag.
  if (code === 0 && /Sent to cloud session\./.test(stdout)) {
    const id = cloudSessionIdIn(stdout)
    if (id) return { ok: true, id }
  }
  const said = screenText(stderr).split('\n').map((l) => l.trim()).filter(Boolean)
  const error = said.find((l) => /^Error:/.test(l)) ?? said[said.length - 1]
  return {
    ok: false,
    error: error ? error.replace(/^Error:\s*/, '') : `Claude Code exited with code ${code ?? 'unknown'} and said nothing.`,
  }
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

/** The permission modes a cloud session accepts. Bypass is refused there, and
 *  `dontAsk` has no meaning for a session nobody is watching; both are left
 *  to the session's own default rather than sent and silently dropped. */
const CLOUD_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto'])

/**
 * The arguments that create a cloud session, printing its link.
 *
 * `--cloud=<task>` rather than `--cloud <task>`: a task that begins with `-`
 * would otherwise be read as a flag. No `--model`: in this mode the CLI
 * forwards a model only when the connected gate is on, and silently drops it
 * otherwise — so sending one would put a model on the card that the session
 * is not running.
 */
export function cloudCreateArgs(task: string, opts: { title?: string; permissionMode?: string } = {}): string[] {
  return [
    `--cloud=${task}`,
    ...(opts.title ? ['--name', opts.title] : []),
    ...(opts.permissionMode && CLOUD_MODES.has(opts.permissionMode) && opts.permissionMode !== 'default'
      ? ['--permission-mode', opts.permissionMode] : []),
  ]
}

/** The arguments that deliver one message to a cloud session. The message
 *  itself goes on STDIN — documented, and immune to a message that starts with
 *  a dash or runs past the argument-length limit. */
export function cloudSendArgs(id: string): string[] {
  return ['-p', '--cloud', id, '--output-format', 'json']
}

/** One argument, quoted for `sh`. */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/**
 * How to run a command on a pseudo-terminal, per platform, with nothing
 * installed: `script(1)`. The CLI refuses `--cloud "<task>"` without a TTY,
 * and a PTY library is a native module this extension does not ship.
 *
 * `stty cols 200` first, so the lines Ink does draw — an error, the trust
 * prompt — are not wrapped at 80 columns into something a pattern cannot
 * match. util-linux `script` takes one command STRING (hence the quoting);
 * BSD `script` takes argv, so a shell is put in front to run `stty` and then
 * `exec` the real command with its arguments untouched.
 *
 * Undefined on Windows, which has no `script`: the caller must say so rather
 * than pretend.
 */
export function ptyInvocation(
  platform: string,
  argv: readonly string[],
): { command: string; args: string[] } | undefined {
  if (platform === 'win32') return undefined
  if (platform === 'linux') {
    const line = `stty cols 200 rows 50 2>/dev/null; exec ${argv.map(shellQuote).join(' ')}`
    return { command: 'script', args: ['-q', '-e', '-f', '-c', line, '/dev/null'] }
  }
  // macOS and the BSDs.
  return {
    command: 'script',
    args: ['-q', '/dev/null', '/bin/sh', '-c', 'stty cols 200 rows 50 2>/dev/null; exec "$@"', 'sh', ...argv],
  }
}

// ---------------------------------------------------------------------------
// What the board keeps about one
// ---------------------------------------------------------------------------

/** One message the board handed to a cloud session. */
export interface CloudMessage {
  at: number
  text: string
  ok: boolean
  error?: string
  /** How many images went with it — the COUNT, as on every other prompt row. */
  images?: number
}

/**
 * A card's cloud session, in the sidecar.
 *
 * It exists because a DETACHED session has nothing on this machine at all: no
 * transcript under `~/.claude/projects`, so Claude Code's index never lists it
 * and has nowhere to keep its title. Without this record the card would vanish
 * with the process that created it — which is the rule about numbers that
 * depend on a process being alive, applied to the card itself.
 */
export interface CloudRecord {
  /** `session_…` — what `--cloud <id>` and `claude --teleport <id>` take. */
  id: string
  url: string
  /** `live`: this Claude Code streamed the session to the board. `detached`:
   *  the CLI created it and printed a link; its replies are on claude.ai. */
  via: 'live' | 'detached'
  createdAt: number
  title?: string
  /** Everything the board sent it, oldest first — for a detached session, the
   *  only transcript the board has. Bounded. */
  log: CloudMessage[]
}

/** What a cloud run reports as it learns things. */
export interface CloudUpdate {
  id: string
  url: string
  via: 'live' | 'detached'
  title?: string
  sent?: CloudMessage
  /** Things the CLI said while creating it — the files it left out of the
   *  upload, say. Shown on the card once; never stored. */
  notices?: string[]
}

export const MAX_CLOUD_LOG = 200
const MAX_TEXT = 50_000

/** Read a record back out of the sidecar. Parsed, never cast: it outlives the
 *  extension version that wrote it, and it is read on the render path. A
 *  record without an id is no record — there is nothing to reach. */
export function parseCloud(raw: unknown): CloudRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id : ''
  if (!SESSION_ID.test(id)) return undefined
  const url = typeof r.url === 'string' && isCloudUrl(r.url) ? r.url : cloudUrlFor(id)
  const log: CloudMessage[] = []
  for (const m of Array.isArray(r.log) ? r.log : []) {
    if (!m || typeof m !== 'object') continue
    const e = m as Record<string, unknown>
    if (typeof e.text !== 'string' || typeof e.at !== 'number' || !Number.isFinite(e.at)) continue
    log.push({
      at: e.at, text: e.text, ok: e.ok === true,
      ...(typeof e.error === 'string' && e.error ? { error: e.error } : {}),
      ...(typeof e.images === 'number' && e.images > 0 ? { images: Math.floor(e.images) } : {}),
    })
  }
  return {
    id, url,
    via: r.via === 'live' ? 'live' : 'detached',
    createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : log[0]?.at ?? 0,
    ...(typeof r.title === 'string' && r.title.trim() ? { title: r.title.trim() } : {}),
    log: log.slice(-MAX_CLOUD_LOG),
  }
}

/** Fold one update into a record. A record keeps the FIRST session it was told
 *  about: `--cloud <id>` can only answer for the id it was given, so a
 *  different one arriving later is a fault somewhere, and a card that silently
 *  re-pointed at another cloud session would be sending the user's messages
 *  somewhere they are not looking. */
export function mergeCloud(prev: CloudRecord | undefined, u: CloudUpdate, now = Date.now()): CloudRecord {
  const base: CloudRecord = prev ?? { id: u.id, url: u.url, via: u.via, createdAt: now, log: [] }
  const same = base.id === u.id
  const log = u.sent
    ? [...base.log, { ...u.sent, text: u.sent.text.slice(0, MAX_TEXT) }].slice(-MAX_CLOUD_LOG)
    : base.log
  const title = u.title ?? base.title
  return {
    ...base,
    url: same && isCloudUrl(u.url) ? u.url : base.url,
    // Live wins: once the CLI has streamed it here, it can again.
    via: base.via === 'live' || (same && u.via === 'live') ? 'live' : 'detached',
    ...(title ? { title } : {}),
    log,
  }
}

/**
 * The transcript of a cloud session with nothing on this machine: what the
 * board sent it, and one line saying where the rest is.
 *
 * The notice is the load-bearing row. Without it a detached card is a list of
 * prompts with no answers, which reads as an agent that never replied — when
 * the replies exist and are simply somewhere this board is not allowed to
 * read from.
 */
export function cloudTranscript(rec: CloudRecord): Entry[] {
  const out: Entry[] = []
  const notice: Entry = {
    kind: 'notice', urgency: 'info', at: rec.createdAt,
    message: rec.via === 'live'
      ? `This session runs on Anthropic's cloud. Its conversation is kept there, not on this machine — ` +
        `open it on claude.ai (${rec.url}) to read what happened while the board was not attached.`
      : `Running on Anthropic's cloud (${rec.url}). This Claude Code does not stream cloud sessions to an ` +
        `editor for your account, so the board can deliver messages to it but cannot read its replies — ` +
        `they are on claude.ai, and so are its changes.`,
  }
  let placed = false
  for (const m of rec.log) {
    out.push({ kind: 'prompt', at: m.at, text: m.text, ...(m.images ? { images: m.images } : {}) })
    if (!placed) { out.push({ ...notice, at: Math.max(notice.at, m.at) }); placed = true }
    if (!m.ok) out.push({ kind: 'error', at: m.at, message: `Not delivered to the cloud session: ${m.error ?? 'no reason given'}` })
  }
  if (!placed) out.push(notice)
  return out
}
