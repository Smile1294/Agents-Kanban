/**
 * The spawn allowlist's arithmetic, pure.
 *
 * The settings page's per-model "allowed for spawned agents" tick writes
 * through `toggledSpawn`; `AgentManager.split()` gates through
 * `allowedSpawnModels`. The write and the read have to agree, or a policy the
 * user saved comes back different — this file is the round trip, and the
 * round trip is the point: "anything persisted must be READ BACK by a test,
 * not just written" is this project's own rule, and the postmortem that rule
 * came from (`contextWindow` lost on every launch) was a write with a parse
 * that never read it.
 */
import { allowedSpawnModels, parseSpawnPolicy, toggledSpawn } from '../spawn-policy.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ---------------------------------------------------------------------------
// 1. The parse. `workspaceState.get()` returns unknown, and the value may
// predate this field or be junk. Absence reads back as "all allowed", which
// is the default — never as a throw on the settings render path.
{
  ok(same(parseSpawnPolicy(undefined), {}), 'no stored policy is all-allowed')
  ok(same(parseSpawnPolicy('banana'), {}), 'a non-object is all-allowed, not a crash')
  ok(same(parseSpawnPolicy([1, 2]), {}), 'an array is not a policy')
  ok(same(parseSpawnPolicy({ ds: 'deepseek-v4-pro' }), {}),
     'a profile whose entry is not an array is dropped rather than trusted')
  ok(same(parseSpawnPolicy({ ds: [42, null] }), {}),
     'non-string ids are dropped — a model id reaching split() must be a string')
  ok(same(parseSpawnPolicy({ ds: ['deepseek-v4-pro'], '': ['x'] }), { ds: ['deepseek-v4-pro'] }),
     'a real entry survives, junk beside it does not')
  ok(same(parseSpawnPolicy({ ds: ['a', 'a', ' b ', ''] }), { ds: ['a', ' b '] }),
     'ids are deduplicated and blanks are dropped')
}

// ---------------------------------------------------------------------------
// 2. The round trip: what the settings tick WRITES comes back out of the parse
// the gate READS. This is the gate the postmortem describes — a write with no
// round trip is not persistence.
{
  const p0 = parseSpawnPolicy(undefined)
  const p1 = toggledSpawn(p0, 'ds', 'deepseek-v4-pro', false)
  const read1 = parseSpawnPolicy(JSON.parse(JSON.stringify(p1)))
  ok(same(read1, { ds: ['deepseek-v4-pro'] }),
     `unticking a model round-trips through storage (${JSON.stringify(read1)})`)

  const p2 = toggledSpawn(read1, 'ds', 'deepseek-chat', false)
  const read2 = parseSpawnPolicy(JSON.parse(JSON.stringify(p2)))
  ok(same(read2, { ds: ['deepseek-v4-pro', 'deepseek-chat'] }),
     'and so does a second one — the list accumulates, never overwrites')

  // Ticking it back on REMOVES the id, and the last one removes the key: an
  // emptied profile must read back exactly like one that was never touched,
  // because both mean the same thing and a policy that round-trips `[]` into
  // `undefined` silently is a policy whose empty state is an accident.
  const p3 = toggledSpawn(read2, 'ds', 'deepseek-v4-pro', true)
  const read3 = parseSpawnPolicy(JSON.parse(JSON.stringify(p3)))
  ok(same(read3, { ds: ['deepseek-chat'] }), 're-ticking removes the id')

  const p4 = toggledSpawn(read3, 'ds', 'deepseek-chat', true)
  const read4 = parseSpawnPolicy(JSON.parse(JSON.stringify(p4)))
  ok(same(read4, {}), 'ticking the last one reads back as "all allowed" — no key, no empty list')

  // The write itself must be immutable in spirit: toggling a NEW policy never
  // mutates the one it was derived from, or two readers share surprises.
  const base: Record<string, string[]> = { ds: ['a'] }
  void toggledSpawn(base, 'ds', 'b', false)
  ok(same(base, { ds: ['a'] }), 'the toggle derives a new policy instead of mutating the stored one')
}

// ---------------------------------------------------------------------------
// 3. The allowed half: offered minus blocked, per profile. A blocked id the
// backend does not serve is noise, never an extra refusal; a profile the
// policy has never heard of keeps everything it offers.
{
  const policy = { ds: ['deepseek-reasoner'], gw: [] as string[] }
  ok(same(allowedSpawnModels(policy, 'ds', ['deepseek-chat', 'deepseek-reasoner', 'gpt-x']),
    ['deepseek-chat', 'gpt-x']),
  'allowed = what the backend offers minus what was unticked')
  ok(same(allowedSpawnModels(policy, 'other', ['opus-5']), ['opus-5']),
     'a profile with no entry allows everything it offers')
  ok(same(allowedSpawnModels(policy, 'ds', []), []),
     'an offered list that is empty stays empty — the gate refuses on it, it does not invent models')
}

console.log(fails ? `\n${fails} FAILED` : '\nPASS — the spawn policy round-trips through its own parse')
process.exit(fails ? 1 : 0)
