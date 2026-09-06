/**
 * The redaction boundary of Remote Control, at the level where a card becomes
 * the wire payload. The relay test pins the SHAPE the wire may carry; this
 * file pins that `toRemoteCard` actually produces that shape from the full
 * local card — fed every sensitive field this codebase has on a card, and
 * asserting none of them survive.
 */
import { toRemoteCard, remoteAgent } from '../cards.ts'
import type { RemoteAgent } from '../cards.ts'
import type { RunningAgent } from '../../agent/manager.ts'
import type { UiCard } from '../../board/panel.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

/** A card that KNOWS everything: every field the local board renders, loaded
 *  with the kind of value that must never leave the machine. */
function venomCard(over: Partial<UiCard> = {}): UiCard {
  return {
    key: 'sess-1',
    sessionId: 'sess-1',
    runtime: 'claude',
    title: 'Fix the login bug',
    phase: 'implementing',
    tags: ['auth'],
    archived: false,
    pinned: false,
    updated: 1000,
    // The venom: everything a card knows that the remote must not.
    branch: 'task/fix-login',
    worktree: '/home/me/repo/.agentskanban/worktrees/sess-1',
    parent: 'sess-0',
    testPlan: {
      summary: 'run the secret fix',
      steps: ['rm -rf /'],
      links: [{ label: 'open it', target: 'src/secret.ts', kind: 'file' }],
      at: 999,
    },
    decomposition: { line: 'two jobs', stated: 'split', refused: false },
    queued: ['a follow-up prompt'],
    agent: {
      kind: 'working',
      tool: 'Bash',
      since: 500,
      subagent: 'a subagent',
      lastEventAt: 900,
      message: 'boom: /etc/passwd',
      costUsd: 12.34,
      contextTokens: 5000,
      contextWindow: 200000,
      resolvedProvider: 'deepseek',
      providerLabel: 'DeepSeek',
      pendingPermission: {
        id: 'pp-1',
        summary: 'run: rm -rf /',
        prompt: 'the runtime rendered this',
      },
    },
    ...over,
  }
}

// --- the live agent card -----------------------------------------------------

{
  const c = venomCard()
  const out = JSON.parse(JSON.stringify(toRemoteCard(c)))
  const keys = Object.keys(out).sort()
  ok(keys.join(',') === 'agent,archived,key,phase,runtime,tags,title,updated',
    `the remote card carries exactly the declared fields (got: ${keys.join(',')})`)
  ok(out.agent.kind === 'working' && out.agent.tool === 'Bash' && out.agent.since === undefined,
    'the agent block keeps kind and tool — the tool NAME only')
  ok(out.agent.costUsd === undefined && out.agent.message === undefined &&
    out.agent.resolvedProvider === undefined && out.agent.pendingPermission === undefined &&
    out.agent.subagent === undefined && out.agent.lastEventAt === undefined,
    'cost, error text, provider, permission, subagent and event age do not leave')
  ok(out.worktree === undefined && out.branch === undefined && out.parent === undefined,
    'worktree path, branch and parent do not leave')
  ok(out.testPlan === undefined && out.decomposition === undefined && out.queued === undefined &&
    out.interrupted === undefined,
    'test plan, decomposition, queued prompts and the interrupted stamp do not leave as card fields')
}

// --- a cut-off run says so in the one field that can ------------------------

{
  const out = toRemoteCard(venomCard({ agent: undefined, interrupted: 999 }))
  ok(out.agent?.kind === 'interrupted' && out.agent?.since === 999,
    'a run cut off by the host becomes agent kind "interrupted" with its time')
}

// --- queued and idle cards ---------------------------------------------------

{
  const q = toRemoteCard(venomCard({ agent: { ...venomCard().agent!, kind: 'queued', since: 777 } }))
  ok(q.agent?.kind === 'queued' && q.agent?.since === 777 && q.agent?.tool === undefined,
    'a queued run keeps its since, never a tool')
  const idle = toRemoteCard(venomCard({ agent: undefined }))
  ok(idle.agent === undefined && idle.archived === false,
    'an idle card has no agent block at all')
}

// --- remoteAgent: the live-run filter ---------------------------------------

{
  const agent = {
    state: { kind: 'working', tool: 'Bash' },
    lastEventAt: 900, costUsd: 12.34, contextTokens: 5000,
  } as unknown as RunningAgent
  const ra = remoteAgent(agent)
  ok(ra.kind === 'working' && ra.tool === 'Bash', 'remoteAgent keeps the state kind and tool name')
  ok(Object.keys(ra).sort().join(',') === 'kind,tool',
    `remoteAgent carries exactly kind and tool (got: ${Object.keys(ra).join(',')})`)
  const q = { state: { kind: 'queued', since: 42 } } as unknown as RunningAgent
  const qo = remoteAgent(q) as RemoteAgent
  ok(qo.kind === 'queued' && qo.since === 42, 'a queued agent keeps its since')
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('cards: all ok')
