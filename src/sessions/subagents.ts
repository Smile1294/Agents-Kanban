/**
 * Background agents: the ones a session spawns with the `Agent` tool.
 *
 * Reported as "I thought they are still working but they weren't". Two agents
 * were launched, the parent's turn ended, the CLI process went away, and the
 * board showed nothing — because the only place subagent frames were ever read
 * is the LIVE run parser (`agent/session.ts`). This is the same rule the context
 * meter already follows and this did not: **what the board shows must not depend
 * on a process being alive.**
 *
 * ## What is actually knowable
 *
 * Claude Code writes each background agent to
 * `projects/<dir>/<session-id>/subagents/agent-<id>.{jsonl,meta.json}`. Verified
 * against a real store: the sidecar carries `agentType`, `description`,
 * `toolUseId` and `spawnDepth` — and **no status field at all**. The launch's
 * own `tool_result` says only "Async agent launched successfully", which is the
 * start, not the finish.
 *
 * So an outcome comes from exactly one place: the `<task-notification>` the
 * harness writes back into the PARENT transcript, carrying `<task-id>` and
 * `<status>completed|stopped</status>`. Everything else here is derived, and the
 * derivation is stated rather than dressed up as a reading — see `agentStatus`.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/** How a background agent ended, or why we cannot say it ended. */
export type AgentStatus =
  /** The parent transcript reported it finished. */
  | 'completed'
  /** The parent transcript reported it stopped — `stopped`, or `killed`,
   *  which is what a `TaskStop` actually writes. */
  | 'stopped'
  /** The parent transcript reported it failed. */
  | 'failed'
  /** No outcome reported, and the session is live — it may still be working. */
  | 'running'
  /** No outcome reported and nothing is live. A background agent is a child of
   *  the CLI process, so this one CANNOT still be working, whatever the last
   *  thing it wrote said. This is the state that was invisible. */
  | 'orphaned'

export interface BackgroundAgent {
  id: string
  description: string
  agentType?: string
  /** When its transcript was last written. The only liveness number that
   *  exists — it climbs when nothing is happening, which is what lets the panel
   *  say "bad". Absent for an agent whose transcript has not appeared yet. */
  lastFrameAt?: number
}

/** An outcome the parent transcript stated. */
export type ReportedStatus = 'completed' | 'stopped' | 'failed'
/** A reported outcome, per task id. Only what the transcript actually said. */
export type ReportedOutcomes = Map<string, ReportedStatus>

/**
 * The status words a notification can carry, each read into an outcome.
 *
 * Both spellings, per this project's rule about another program's protocol: the
 * SDK's type declares `completed | failed | stopped`, and the record a
 * `TaskStop` actually writes says `killed`. Reading the declared word alone
 * showed a stopped agent as "still working". Anything not listed is DROPPED,
 * never guessed — see `parseTaskNotifications`.
 */
const REPORTED: Record<string, ReportedStatus> = {
  completed: 'completed',
  stopped: 'stopped',
  killed: 'stopped',
  failed: 'failed',
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g
const TASK_ID = /<task-id>\s*([A-Za-z0-9_-]{1,64})\s*<\/task-id>/g
const STATUS = /<status>\s*([a-z_]+)\s*<\/status>/

/**
 * Outcomes reported in a session's own transcript.
 *
 * Pure, and over the entries the store has ALREADY parsed — no second file read
 * on a path the board repaints from. One notification can name several task ids
 * (a pair of agents finishing together writes exactly that), so every id in the
 * block takes the block's status.
 *
 * A status this build does not recognise is DROPPED rather than coerced into one
 * it does. The text is another program's output and the vocabulary can grow; a
 * new terminal state guessed as "completed" would be the board reporting an
 * outcome nobody stated.
 */
export function parseTaskNotifications(
  entries: ReadonlyArray<{ readonly kind: string; readonly text?: string | undefined }>,
): ReportedOutcomes {
  const out: ReportedOutcomes = new Map()
  for (const e of entries) {
    const text = e.text
    if (!text || !text.includes('<task-notification>')) continue
    NOTIFICATION.lastIndex = 0
    for (let block = NOTIFICATION.exec(text); block; block = NOTIFICATION.exec(text)) {
      const body = block[1] ?? ''
      const status = REPORTED[STATUS.exec(body)?.[1] ?? '']
      if (!status) continue
      TASK_ID.lastIndex = 0
      for (let id = TASK_ID.exec(body); id; id = TASK_ID.exec(body)) {
        if (id[1]) out.set(id[1], status)
      }
    }
  }
  return out
}

/**
 * Outcomes reported in a session's transcript, read off the FILE.
 *
 * Not off the parsed transcript, because the notification is only sometimes a
 * message. Measured on a real session with two agents, one completed and one
 * killed: eight records carried the notification text, in THREE shapes —
 * `queue-operation` records (`content`), `attachment` records
 * (`attachment.prompt`, how the CLI delivers a notification that arrives
 * while a turn is in flight), and a plain `user` message (`message.content`)
 * only when one is dequeued at a turn boundary. The SDK's reader returns
 * messages, so it returned ONE of the eight, and the store's entries could
 * never carry the rest — which is why both agents read "still working" under a
 * run that had printed "Finished". So every string in a matching record is
 * read, whatever key it sits under; the same notification appears up to three
 * times and collapses in the map, last one in file order winning.
 *
 * Cheap and cached: only sessions that spawned an agent are asked, and the
 * answer is keyed on the file's size and mtime, so a finished session costs one
 * read and a live one costs a read per change — a line filter, not a parse.
 */
const notificationCache = new Map<string, { size: number; mtimeMs: number; outcomes: ReportedOutcomes }>()
export async function readTaskNotifications(file: string): Promise<ReportedOutcomes> {
  const st = await fs.stat(file).catch(() => undefined)
  if (!st) return new Map()
  const hit = notificationCache.get(file)
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.outcomes
  const raw = await fs.readFile(file, 'utf8').catch(() => '')
  const entries: Array<{ kind: string; text: string }> = []
  for (const line of raw.split('\n')) {
    if (!line.includes('<task-notification>')) continue
    // Parsed, not cast: another program's file. A record with no message (the
    // `last-prompt` marker quotes the text too) is skipped, not crashed on.
    let rec: unknown
    try { rec = JSON.parse(line) } catch { continue }
    // Every string in the record that carries the marker, wherever it sits —
    // the three shapes above, and whatever the next version files it under.
    const walk = (x: unknown, depth: number): void => {
      if (depth > 6) return
      if (typeof x === 'string') { if (x.includes('<task-notification>')) entries.push({ kind: 'prompt', text: x }) }
      else if (Array.isArray(x)) x.forEach((v) => walk(v, depth + 1))
      else if (x && typeof x === 'object') for (const v of Object.values(x as Record<string, unknown>)) walk(v, depth + 1)
    }
    walk(rec, 0)
  }
  const outcomes = parseTaskNotifications(entries)
  notificationCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, outcomes })
  return outcomes
}

/**
 * What to say about one agent.
 *
 * A REPORTED outcome always wins: it is the only statement anyone actually
 * made. Everything else is inference, and the inference is only ever allowed to
 * narrow to "may still be working" or "cannot be working" — never to invent a
 * success. `orphaned` is not a guess: the agent is a child of the CLI process,
 * so with nothing live there is nothing left running.
 */
export function agentStatus(
  agent: { id: string },
  reported: ReportedOutcomes,
  sessionRunning: boolean,
): AgentStatus {
  const said = reported.get(agent.id)
  if (said) return said
  return sessionRunning ? 'running' : 'orphaned'
}

/**
 * Every background agent a session spawned, read off disk.
 *
 * Identity comes from the `.meta.json` sidecar and the time from the sibling
 * `.jsonl`. An agent whose transcript has not been written yet is still LISTED,
 * with no time — dropping it would hide an agent during the first seconds after
 * launch, which is precisely when someone is watching. A missing directory is
 * "none", never an error: most sessions never spawn one.
 */
export async function readBackgroundAgents(
  home: string,
  sessionId: string,
): Promise<BackgroundAgent[]> {
  const dir = await subagentDir(home, sessionId)
  return dir ? agentsIn(dir) : []
}

/** The agents in one `subagents` directory. The single implementation both
 *  entry points share — two readers of another program's format is two places
 *  to drift from it. */
async function agentsIn(dir: string): Promise<BackgroundAgent[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const out: BackgroundAgent[] = []
  for (const name of names) {
    const id = /^agent-(.+)\.meta\.json$/.exec(name)?.[1]
    if (!id) continue
    const raw = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')
    let meta: Record<string, unknown> = {}
    // Parsed, not cast: another program's file, read on a render path.
    try { meta = JSON.parse(raw) as Record<string, unknown> } catch { /* identity only */ }
    const at = await fs.stat(path.join(dir, `agent-${id}.jsonl`))
      .then((s) => s.mtimeMs, () => undefined)
    out.push({
      id,
      description: typeof meta.description === 'string' && meta.description.trim()
        ? meta.description.trim()
        : id,
      ...(typeof meta.agentType === 'string' ? { agentType: meta.agentType } : {}),
      ...(at ? { lastFrameAt: at } : {}),
    })
  }
  // Stable order, so the panel does not reshuffle between repaints — a list
  // that reorders under the pointer is the scroll-jump bug in miniature.
  return out.sort((a, b) => a.description.localeCompare(b.description) || a.id.localeCompare(b.id))
}

/**
 * Every session's background agents, in ONE directory walk.
 *
 * The board draws a badge on every card, so asking per session would be
 * O(sessions x project directories) of `stat` on the render path — the shape of
 * per-repaint cost this project already has a postmortem about. This walks
 * `projects/<dir>/<session>/subagents` once and keys the answer by session id;
 * the host caches it on the same short TTL as the session scan.
 *
 * Only sessions that actually spawned an agent get a key, so "no agents" costs
 * a missing lookup rather than an empty array per card.
 */
/** One session's background agents, and where its own transcript is — the
 *  file the outcomes are read from, found by the same walk rather than a
 *  second one. */
export interface SessionAgents {
  agents: BackgroundAgent[]
  transcript: string
}

export async function scanBackgroundAgents(home: string): Promise<Map<string, SessionAgents>> {
  const projects = path.join(home, 'projects')
  const out = new Map<string, SessionAgents>()
  for (const project of await fs.readdir(projects).catch(() => [] as string[])) {
    const base = path.join(projects, project)
    // A session's own directory sits BESIDE its `<id>.jsonl`, so the entries
    // here are a mix of files and per-session directories. Only the latter can
    // hold agents, and a name that is not a directory costs one failed stat.
    for (const entry of await fs.readdir(base).catch(() => [] as string[])) {
      const dir = path.join(base, entry, 'subagents')
      if (!(await fs.stat(dir).then((st) => st.isDirectory(), () => false))) continue
      const agents = await agentsIn(dir)
      if (agents.length) out.set(entry, { agents, transcript: path.join(base, `${entry}.jsonl`) })
    }
  }
  return out
}

/**
 * Where a session's background agents live.
 *
 * Scanned rather than derived, for the reason `sessionFileFor` gives: Claude
 * Code's directory sanitizer is ITS format and has drifted before (truncation
 * plus a hash for long paths), while a session id is globally unique — so
 * looking for the id is exact where re-deriving the name is a guess.
 */
async function subagentDir(home: string, sessionId: string): Promise<string | undefined> {
  const projects = path.join(home, 'projects')
  const dirs = await fs.readdir(projects).catch(() => [] as string[])
  for (const d of dirs) {
    const candidate = path.join(projects, d, sessionId, 'subagents')
    if (await fs.stat(candidate).then((s) => s.isDirectory(), () => false)) return candidate
  }
  return undefined
}
