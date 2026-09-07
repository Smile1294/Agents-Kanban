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
  /** The parent transcript reported it stopped. */
  | 'stopped'
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

/** A reported outcome, per task id. Only what the transcript actually said. */
export type ReportedOutcomes = Map<string, 'completed' | 'stopped'>

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
      const status = STATUS.exec(body)?.[1]
      if (status !== 'completed' && status !== 'stopped') continue
      TASK_ID.lastIndex = 0
      for (let id = TASK_ID.exec(body); id; id = TASK_ID.exec(body)) {
        if (id[1]) out.set(id[1], status)
      }
    }
  }
  return out
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
export async function scanBackgroundAgents(home: string): Promise<Map<string, BackgroundAgent[]>> {
  const projects = path.join(home, 'projects')
  const out = new Map<string, BackgroundAgent[]>()
  for (const project of await fs.readdir(projects).catch(() => [] as string[])) {
    const base = path.join(projects, project)
    // A session's own directory sits BESIDE its `<id>.jsonl`, so the entries
    // here are a mix of files and per-session directories. Only the latter can
    // hold agents, and a name that is not a directory costs one failed stat.
    for (const entry of await fs.readdir(base).catch(() => [] as string[])) {
      const dir = path.join(base, entry, 'subagents')
      if (!(await fs.stat(dir).then((st) => st.isDirectory(), () => false))) continue
      const agents = await agentsIn(dir)
      if (agents.length) out.set(entry, agents)
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
