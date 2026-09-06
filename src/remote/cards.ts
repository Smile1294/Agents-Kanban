/**
 * Remote Control — the two redaction mappings that sit between the board and
 * the wire.
 *
 * `toRemoteCard` is the ONE place a UiCard becomes what may leave this machine.
 * The local card knows everything — worktree paths, branch names, test plans,
 * a permission question that names a file, a live cost figure — and all of it
 * must stay home. The input type is the whole UiCard precisely so that the
 * filter is a real filter: this module is given every field and returns the
 * declared few, and its test feeds it a card stuffed with the most sensitive
 * fields this codebase has and asserts none of them survive.
 *
 * `remoteAgent` is the same filter one level down: the card's `agent` block
 * carries `costUsd`, `message`, `resolvedProvider`, `pendingPermission`, and
 * the tool NAME is the only piece of a live agent's activity that may leave
 * (a tool name is not a command, and a command can carry a secret).
 *
 * Type-only imports, both: everything here is erased at runtime, so this
 * module runs under the plain-Node test runner.
 */
import type { RunningAgent } from '../agent/manager.ts'
import type { UiCard } from '../board/panel.ts'
import type { RemoteCardSource } from './relay.ts'

/** The live-agent activity that may leave, filtered out of the full agent
 *  state. `kind` is the run's state kind — queued / working / error / etc. */
export interface RemoteAgent {
  kind: string
  tool?: string
  since?: number
}

/** The ONE piece of a live run's activity that may leave this machine: its
 *  state kind, the tool NAME it is running (never a command's text), and when
 *  a queued run was accepted. No cost, no message, no provider, no permission
 *  question. */
export function remoteAgent(a: RunningAgent): RemoteAgent {
  const s = a.state
  return {
    kind: s.kind,
    ...(s.kind === 'queued' && s.since !== undefined ? { since: s.since } : {}),
    ...(s.kind === 'working' && s.tool ? { tool: s.tool } : {}),
  }
}

/**
 * The card, minus everything the remote must never see. Every field of the
 * input is read here and either mapped or dropped — deliberately written as a
 * literal rather than a pick, so a field ADDED to UiCard later fails the
 * typecheck on this file and forces a decision about it.
 */
export function toRemoteCard(c: UiCard): RemoteCardSource {
  return {
    key: c.key,
    title: c.title,
    phase: c.phase,
    tags: c.tags,
    archived: c.archived === true,
    updated: c.updated,
    ...(c.runtime ? { runtime: c.runtime } : {}),
    // A run cut off by the host's death is not a live agent — it is the
    // opposite — but the remote must be able to say so too, or a card that
    // simply stopped on a phone reads exactly like a card that finished. The
    // same state the local "Interrupted 9m ago" reads.
    ...(c.interrupted
      ? { agent: { kind: 'interrupted', since: c.interrupted } as RemoteAgent }
      : c.agent
        ? { agent: remoteAgentSource(c.agent) }
        : {}),
  }
}

/** The card's already-rendered agent block, filtered to the safe three. */
function remoteAgentSource(a: NonNullable<UiCard['agent']>): RemoteAgent {
  return {
    kind: a.kind,
    ...(a.kind === 'queued' && a.since !== undefined ? { since: a.since } : {}),
    ...(a.kind === 'working' && a.tool ? { tool: a.tool } : {}),
  }
}
