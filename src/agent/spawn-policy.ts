/**
 * Which models an agent-SPAWNED session may run on.
 *
 * When a session splits itself, the subtask spec may name a `model` — an id
 * that reaches `AgentManager.split()`, which starts processes that cost money
 * nobody typed a prompt for. So the user gets a per-model tick on the settings
 * page ("allowed for spawned agents"), and this file is the policy's
 * arithmetic: pure functions, so the whole thing is testable without an
 * editor, with the gate itself living in `manager.ts` and the UI in
 * `media/settings.js`.
 *
 * The policy is the DISALLOWED half, keyed by provider profile id. Absence is
 * load-bearing: a profile with no entry, or a model id that does not appear,
 * means ALLOWED — "every offered model allowed until un-ticked" is the default
 * the settings page promises. The ALLOWED half is derived at gate time from
 * what the backend offers minus what is blocked (`allowedSpawnModels`), so
 * there is exactly one place that knows how to compose it — the "two functions
 * that both know how to fall back is one bug" rule.
 *
 * Stored in `workspaceState`, so it is per-workspace, survives restarts, and
 * is parsed on every read like everything else that outlives the extension
 * version that wrote it.
 */
export type SpawnPolicy = Record<string, string[]>

/**
 * A `workspaceState` value as it comes back out of storage: unknown, from a
 * build that may predate this field. Rejected wholesale on nonsense, per-key
 * on junk — a profile's entry that is not an array of non-empty strings is
 * dropped, which reads back as "all allowed" for that profile, the same
 * answer an absent key gives.
 */
export function parseSpawnPolicy(raw: unknown): SpawnPolicy {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: SpawnPolicy = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || !Array.isArray(value)) continue
    const ids = value.filter((v): v is string => typeof v === 'string' && !!v.trim())
    if (ids.length) out[key] = [...new Set(ids)]
  }
  return out
}

/**
 * Tick or untick one model for one profile. The write and the parse must
 * agree, or a policy saved through here comes back different — so an emptied
 * profile's key is DELETED rather than left as `[]`, and a tick REMOVES the
 * id rather than recording "allowed: true" somewhere a parse would have to
 * look for it. Absence IS the answer.
 */
export function toggledSpawn(
  policy: SpawnPolicy,
  profileId: string,
  modelId: string,
  allowed: boolean,
): SpawnPolicy {
  const set = new Set(policy[profileId] ?? [])
  if (allowed) set.delete(modelId)
  else set.add(modelId)
  const next = { ...policy }
  if (set.size) next[profileId] = [...set]
  else delete next[profileId]
  return next
}

/** The allowed half: everything the backend offers, minus what was unticked.
 *  `offered` is the ACTIVE profile's catalogue — the same list the composer
 *  shows, because a spawned child runs on the active backend and an id it does
 *  not serve is not a choice, it is a hallucination the gate must refuse. */
export function allowedSpawnModels(
  policy: SpawnPolicy,
  profileId: string,
  offered: readonly string[],
): string[] {
  const blocked = new Set(policy[profileId] ?? [])
  return offered.filter((id) => !blocked.has(id))
}
