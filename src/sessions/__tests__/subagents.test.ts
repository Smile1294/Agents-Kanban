/* Background agents: the ones a session spawns with the `Agent` tool and then
   stops being able to tell you about.
 *
 * Reported as: "I thought they are still working but they weren't". Two agents
 * were launched, the parent's turn ended, the CLI process went away — and the
 * board showed nothing at all, because the only place subagent frames were ever
 * read is the LIVE run parser. The same rule as the context meter applies here
 * and was not applied: what the board shows must not depend on a process being
 * alive.
 *
 * Every shape below is one taken from a real `~/.claude` on a machine that has
 * run these — the `subagents/agent-<id>.meta.json` sidecar, the `.jsonl` beside
 * it, and the `<task-notification>` the harness writes back into the PARENT
 * transcript. Seeded into a throwaway config dir, so the numbers asserted are
 * known rather than whatever this laptop happens to hold. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { agentStatus, parseTaskNotifications, readBackgroundAgents, scanBackgroundAgents } from '../subagents.ts'
import type { Entry } from '../store.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// --- the notification the harness writes into the PARENT transcript ----------
// This is the only authoritative statement of outcome anywhere: the `.meta.json`
// carries identity and NO status, and the launch tool_result says only that the
// agent started. Verbatim shape, including the two-ids-in-one-notification case
// that a pair of agents finishing together actually produces.
{
  const notif = (ids: string[], status: string): Entry => ({
    kind: 'prompt' as const, at: 1,
    text: `<task-notification>\n${ids.map((i) => `<task-id>${i}</task-id>`).join('\n')}\n` +
      `<tool-use-id>toolu_x</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`,
  })
  const entries: Entry[] = [
    { kind: 'prompt', at: 0, text: 'do the thing' },
    notif(['aaa111'], 'completed'),
    notif(['bbb222', 'ccc333'], 'stopped'),
    { kind: 'text', at: 2, text: 'working on it' },
  ]
  const m = parseTaskNotifications(entries)
  ok(m.get('aaa111') === 'completed', `a completed agent is read as completed (${m.get('aaa111')})`)
  ok(m.get('bbb222') === 'stopped' && m.get('ccc333') === 'stopped',
     'one notification can settle SEVERAL agents, which is what a pair finishing together writes')
  ok(m.size === 3, `and nothing else is invented from ordinary messages (${m.size})`)

  // Anything we cannot read is NOT a status. Silence is the honest answer.
  ok(parseTaskNotifications([{ kind: 'prompt', at: 1, text: '<task-notification>garbage' } as Entry]).size === 0,
     'a notification with no id and no status settles nothing')
  ok(parseTaskNotifications([{ kind: 'prompt', at: 1, text: '<task-id>x</task-id>' } as Entry]).size === 0,
     'and an id with no status is not a status')
  // A status this build has never seen must not be coerced into one it knows.
  const odd = parseTaskNotifications([notif(['ddd444'], 'exploded')])
  ok(odd.get('ddd444') === undefined, `an unrecognised status is dropped, never mapped (${odd.get('ddd444')})`)
}

// --- what the four states mean ----------------------------------------------
// The one that matters is `orphaned`. A background agent is a child of the CLI
// process, so when no run is live and nothing ever reported an outcome, it
// CANNOT still be working — and that certainty is exactly what was missing.
{
  const a = { id: 'x', description: 'Assessment A' }
  ok(agentStatus(a, new Map([['x', 'completed' as const]]), true) === 'completed',
     'a reported outcome wins over anything derived')
  ok(agentStatus(a, new Map([['x', 'stopped' as const]]), true) === 'stopped',
     'including when it says the agent stopped')
  ok(agentStatus(a, new Map(), true) === 'running',
     'no outcome yet, with the session live, means it may still be working')
  ok(agentStatus(a, new Map(), false) === 'orphaned',
     'no outcome and no live run means it CANNOT be working — the case that was invisible')
}

// --- reading them off disk ---------------------------------------------------
{
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-subagents-'))
  const id = '6fc5b07e-5cc5-4782-bc64-570103b9c960'
  const dir = path.join(home, 'projects', '-Users-x-proj')
  const sub = path.join(dir, id, 'subagents')
  await fs.mkdir(sub, { recursive: true })
  await fs.writeFile(path.join(dir, `${id}.jsonl`), '{}\n')

  const write = async (agentId: string, desc: string, withTranscript = true) => {
    await fs.writeFile(path.join(sub, `agent-${agentId}.meta.json`), JSON.stringify({
      agentType: 'general-purpose', description: desc, toolUseId: 'toolu_1', spawnDepth: 1,
    }))
    if (withTranscript) await fs.writeFile(path.join(sub, `agent-${agentId}.jsonl`), '{"type":"user"}\n')
  }
  await write('ac5028c484a2bcf9d', 'Independent PR assessment A')
  await write('a5a952bd7b5f05939', 'Independent PR assessment B')
  // A sidecar whose transcript has not been written yet: the agent is real and
  // must be listed. Dropping it would hide an agent during the seconds after it
  // launches, which is exactly when you are watching.
  await write('c0ffee0000000dead', 'Just launched', false)

  const found = await readBackgroundAgents(home, id)
  ok(found.length === 3, `every launched agent is listed (${found.length})`)
  const a = found.find((x) => x.id === 'ac5028c484a2bcf9d')
  ok(a?.description === 'Independent PR assessment A', `the description comes from the sidecar (${a?.description})`)
  ok(a?.agentType === 'general-purpose', 'and so does the agent type')
  ok(typeof a?.lastFrameAt === 'number' && a.lastFrameAt > 0,
     'the last-frame time is read from the transcript, which is the only liveness number there is')
  const fresh = found.find((x) => x.id === 'c0ffee0000000dead')
  ok(!!fresh && fresh.lastFrameAt === undefined,
     'an agent with no transcript yet is listed WITHOUT a made-up time')

  // Sorted, so the panel does not reorder itself between repaints.
  ok(found.map((x) => x.description).join('|') === [...found].map((x) => x.description).sort().join('|'),
     'the list has a stable order')

  ok((await readBackgroundAgents(home, 'no-such-session')).length === 0,
     'a session that never spawned one reads as none, not as an error')

  // The board draws a badge on EVERY card, so a per-session directory walk
  // would be O(sessions x project dirs) on the render path — the exact shape of
  // cost this project has a postmortem about. One walk answers for all of them.
  const second = 'aaaaaaaa-1111-2222-3333-444444444444'
  const sub2 = path.join(home, 'projects', '-Users-x-other', second, 'subagents')
  await fs.mkdir(sub2, { recursive: true })
  await fs.writeFile(path.join(sub2, 'agent-beefbeefbeefbeef.meta.json'),
    JSON.stringify({ agentType: 'general-purpose', description: 'Elsewhere' }))
  const all = await scanBackgroundAgents(home)
  ok(all.get(id)?.length === 3, `one scan finds this session's agents (${all.get(id)?.length})`)
  ok(all.get(second)?.length === 1, 'and another session\'s, across project directories')
  ok(all.get('no-such-session') === undefined, 'and invents nothing for a session that has none')
  ok(all.size === 2, `only sessions that actually spawned agents are keyed (${all.size})`)
  await fs.rm(home, { recursive: true, force: true })
}

console.log(fails === 0 ? 'PASS — background agents are readable without a live process' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
