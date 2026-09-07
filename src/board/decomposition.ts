/** How eagerly a card should break itself into subtasks.
 *
 * The user-facing half of orchestration, and deliberately the smallest thing
 * that could be one: a dial with three positions whose ENTIRE mechanism is
 * which sentence `buildBrief()` puts in front of the agent.
 *
 * ## The product principle, stated as two invariants
 *
 * "Use exactly as much orchestration as the task justifies." Concretely:
 *
 *  - a trivial task stays ONE agent even at Maximum, and
 *  - a genuinely large one still splits at Minimal.
 *
 * Both hold **by construction** here rather than by clamping arithmetic,
 * because the level may only ever ASK FOR MORE and ALLOW LESS:
 *
 *  - `aim` is prose. It reaches the model and nothing else. Prose cannot pass a
 *    code gate, so a level can never *require* a split.
 *  - `maxPieces` is a ceiling, floored at 2. A ceiling can never *require* a
 *    split either, and a floor of 2 means it can never *forbid* one.
 *
 * **No gate anywhere else reads `level`.** That is the load-bearing rule of this
 * file and it has a test of its own: `checkProposal` must return IDENTICAL
 * verdicts for two policies differing only in `level`. An invariant enforced by
 * a term the dial moves is not an invariant — the moment a refusal consults the
 * level, "a huge task still splits at Minimal" stops being true and nothing
 * would say so.
 *
 * ## Why three positions and not four
 *
 * `MAX_SUBTASKS` is 4 and `maxConcurrentAgents` defaults to 3, so a fourth level
 * would resolve to the same cap AND the same sentence as its neighbour — a named
 * position whose entire observable effect is identical to the one beside it. The
 * user would move the dial and nothing on the board could report that the move
 * did nothing, which is the same class of bug as a control that cannot say no.
 * A fourth arrives if and when something can honestly raise the ceiling.
 *
 * Plain Node, no `vscode`, so all of it is unit-tested without an editor.
 */
// TYPE-ONLY, and that is load-bearing rather than tidy. `sessions/meta.ts`
// imports this file for `parseOrchestrationLevel`, and `agent/routing.ts`
// imports `meta.ts` for the effort levels — so a VALUE import here closes the
// cycle `meta -> decomposition -> routing -> meta`, and the whole board fails
// to load with "Cannot access 'ALL_ROUTE_RULES' before initialization". A type
// import is erased, so it carries no runtime edge. See `ALL_PROPOSAL_RULES`
// below for how the rules stay enumerated exactly once anyway.
import type { RouteRule } from '../agent/routing.ts'

export type OrchestrationLevel = 'minimal' | 'balanced' | 'maximum'

export const ORCHESTRATION_LEVELS = ['minimal', 'balanced', 'maximum'] as const

/** What the picker shows. `detail` is the whole explanation the user gets, so it
 *  says what the level DOES rather than how eager it sounds. */
export const ORCHESTRATION_CHOICES: { key: OrchestrationLevel; label: string; detail: string }[] = [
  {
    key: 'minimal',
    label: 'Minimal',
    detail: 'Prefer one agent. It may still split work that is genuinely unrelated.',
  },
  {
    key: 'balanced',
    label: 'Balanced',
    detail: 'Split when the pieces are independent and worth testing separately.',
  },
  {
    key: 'maximum',
    label: 'Maximum',
    detail: 'Split readily, up to four agents. A small task still stays one.',
  },
]

export const DEFAULT_ORCHESTRATION: OrchestrationLevel = 'balanced'

/**
 * Read a level back out of storage or a webview message.
 *
 * Parsed, never cast — modelled on `parseRuntimeId`, and for the same reason:
 * this value outlives the extension version that wrote it and is read on the
 * path that builds a brief.
 */
export function parseOrchestrationLevel(raw: unknown): OrchestrationLevel | undefined {
  return typeof raw === 'string' && (ORCHESTRATION_LEVELS as readonly string[]).includes(raw)
    ? (raw as OrchestrationLevel)
    : undefined
}

export interface OrchestrationPolicy {
  level: OrchestrationLevel
  /** THE mechanism: which disposition sentence `buildBrief()` emits. The only
   *  thing about the agent's behaviour that the level changes. */
  aim: 'one' | 'few' | 'several'
  /** Ceiling on pieces. Floored at 2 so it can never forbid a split, and
   *  `min()`'d with `MAX_SUBTASKS` by the caller so there is one real cap. */
  maxPieces: number
}

/** Monotone by construction: a higher level never allows fewer pieces. */
export function policyFor(level: OrchestrationLevel): OrchestrationPolicy {
  switch (level) {
    case 'minimal': return { level, aim: 'one', maxPieces: 2 }
    case 'maximum': return { level, aim: 'several', maxPieces: 4 }
    case 'balanced':
    default: return { level: 'balanced', aim: 'few', maxPieces: 3 }
  }
}

/**
 * The one paragraph the level changes.
 *
 * This REPLACES the disposition half of `buildBrief()`'s split paragraph rather
 * than being added beside it. Two paragraphs that both tell the agent how eager
 * to be is two things that know the policy — and the longer, more specific one
 * would win, so the dial would move nothing while every unit test stayed green.
 * The OPERATIONAL half (fork-from-base, split-before-editing) is invariant and
 * stays where it is.
 *
 * Every sentence says the same two things in different proportions: split only
 * for genuinely unrelated work, and do it before editing. Nothing here promises
 * a number of agents, because the level does not decide that — the work does.
 */
export function aimSentence(p: OrchestrationPolicy): string {
  switch (p.aim) {
    case 'one':
      return [
        'STRONGLY PREFER doing this yourself, in this one session. Splitting costs a',
        'fresh agent that has read none of this conversation, a separate worktree and a',
        'separate merge, so it has to earn that. Use `split_task` only when the request',
        'is plainly two or more jobs that share nothing — not when one job is merely',
        'large, and not to work in parallel.',
      ].join('\n')
    case 'several':
      return [
        'If this request contains pieces that are independent — different subsystems,',
        'different deliverables, work the user would want to test and merge separately —',
        `use \`split_task\` and give each its own agent, up to ${p.maxPieces}. Splitting readily is`,
        'wanted here. It is still wrong for one coherent change: if the pieces have to',
        'know about each other, or share a design decision you have not made yet, do',
        'them yourself in order.',
      ].join('\n')
    case 'few':
    default:
      return [
        'If what you have been asked for is really two or more UNRELATED pieces of work,',
        `use \`split_task\` — up to ${p.maxPieces} agents — so the user can test and merge them`,
        'separately. Do not use it to parallelise one coherent change: two agents editing',
        'two halves of the same feature cannot see each other and will merge into a mess.',
      ].join('\n')
  }
}

// ---------------------------------------------------------------------------
// What the agent proposes, and what the host does with it
// ---------------------------------------------------------------------------

/** One piece, as the agent proposes it. */
export interface PieceProposal {
  title: string
  prompt: string
  /**
   * Paths or globs this piece expects to touch.
   *
   * A PREDICTION confirmed at merge, never a fence. Nothing sandboxes the
   * filesystem, so this cannot stop a write — it exists so the split can later
   * be shown to have been wrong, which is the only signal in the whole feature
   * that can say "bad".
   */
  scope?: string[]
  tags?: string[]
  /**
   * WHAT THIS PIECE ASKS TO RUN ON, as the model wrote it.
   *
   * `agent` is a `<runtime>|<profile>` slug from the tool description — one
   * agent program on one backend, the same flat combination the composer
   * offers, because making the user do that cross product in their head got
   * the answer wrong on screen once and would get it wrong here too. Absent
   * means "the parent's whole agent", which is the only honest default while a
   * session keeps the runtime it started on.
   *
   * All three are raw strings and all three are checked HOST-side, by
   * `resolveRoute()` in `agent/routing.ts`: whether `deepseek` is a configured
   * backend is a question about host state, and this function is deliberately
   * pure of it — the same division `spawn-model` has always had. What happens
   * here is only trimming and bounding, so a refusal can never quote an
   * unbounded model-written value back at the user.
   */
  agent?: string
  model?: string
  effort?: string
}

/** Everything `checkProposal` can refuse on, plus everything the ROUTING gate
 *  can — the latter produced by `AgentManager.split()` and never here, because
 *  the allowed set is host state and this function is deliberately pure of it.
 *
 *  See `RouteRule` in `agent/routing.ts` for why the routing half is four
 *  rules and not one: each has a different fix. */
export type ProposalRule =
  | 'one-piece'
  | 'over-cap'
  | 'scope-missing'
  | 'brief-cross-reference'
  | 'brief-too-long'
  | RouteRule

/**
 * Every rule, enumerated so `decompositionLine()` can be SHOWN to render all
 * of them. A rule with no case there falls through to "the split was declined"
 * — the feature working and the feature broken rendering the same, on the one
 * record that exists to tell them apart.
 *
 * Written as keys with a `satisfies Record<ProposalRule, true>` rather than as
 * an array, because that makes the compiler the check: add a member to
 * `ProposalRule` — here or in `RouteRule` — and this object fails to compile
 * until it is listed. A `readonly ProposalRule[]` literal would have accepted a
 * list missing half of them, which is exactly the drift a hand-written copy of
 * the auto-allow list already caused once in this codebase.
 */
const PROPOSAL_RULES = {
  'one-piece': true,
  'over-cap': true,
  'scope-missing': true,
  'brief-cross-reference': true,
  'brief-too-long': true,
  'spawn-agent': true,
  'spawn-model': true,
  'spawn-catalogue': true,
  'spawn-effort': true,
} as const satisfies Record<ProposalRule, true>

export const ALL_PROPOSAL_RULES: readonly ProposalRule[] =
  Object.keys(PROPOSAL_RULES) as ProposalRule[]

/** Recorded and SHOWN at the approval, never refused.
 *
 *  Refusing on declared overlap treats a prediction as a contract; it would
 *  refuse two honest unrelated tasks that both add a dependency to
 *  `package.json`, and it would teach the model to under-declare — which
 *  destroys the drift readout, the only thing that can say the split was wrong.
 *  The human at the confirmation dialog is the right decider, and that moment
 *  already exists. */
export interface ProposalNote {
  kind: 'scope-overlap'
  paths: string[]
  pieces: string[]
}

export type ProposalVerdict =
  | { ok: true; pieces: PieceProposal[]; notes: ProposalNote[] }
  /** A described failure, never a throw and never a silent truncation — the
   *  shape `SplitResult` and `MergeResult` already use. Truncation reads as
   *  "covered everything". */
  | { ok: false; rule: ProposalRule; message: string }

/**
 * `split_task.prompt` had no cap, and models measurably ignore a length asked
 * for in a description. Enforced where it can be.
 *
 * There is deliberately NO minimum: a character floor is a proxy for
 * completeness that can only reward padding, and it would refuse a correct
 * 143-character brief.
 */
export const MAX_BRIEF = 6000

/** How much of the agent's own sentence is kept. Bounded host-side for the same
 *  reason: a length in a schema is not a limit. */
export const MAX_STATED = 240

/** Phrases that only make sense if the reader can see the other subtasks.
 *  A brief is handed to an agent that has read NONE of this conversation and
 *  none of its siblings, so a cross-reference is a brief that cannot be run. */
const CROSS_REFERENCE = /\b(?:the other (?:task|subtask|agent|piece)|task (?:one|two|three|four|[1-4])\b|as (?:decided|agreed|described) (?:above|in the other)|see the other|sibling (?:task|agent))/i

/**
 * One model-written routing field, trimmed and bounded.
 *
 * The bound exists so a refusal message never carries an unbounded value the
 * model wrote. Truncating cannot turn a disallowed id into an allowed one, only
 * into a different disallowed one — so it is safe here in a way it is NOT safe
 * for the piece list, which is refused rather than truncated.
 */
function bounded<K extends string>(key: K, raw: unknown): Record<K, string | undefined> {
  const clean = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 200) : undefined
  // The key is ALWAYS written, `undefined` included, because these fields are
  // spread from the model's own object first — so returning `{}` for a blank
  // one left `agent: '   '` in place from that spread and the sanitiser did
  // nothing. It was latent on `model` for the same reason and no test could
  // see it: the only symptom is a whitespace id reaching the routing gate,
  // where it is refused with a message quoting three spaces.
  return { [key]: clean } as Record<K, string | undefined>
}

/**
 * Every host-side gate on a proposed split, in one pure function.
 *
 * Deliberately knows nothing about git, the manager or the editor, so the whole
 * policy is testable without starting anything. `AgentManager.split()`'s
 * STRUCTURAL refusals — dirty worktree, already split, is itself a subtask —
 * run first and unconditionally: a dirty parent cannot split however good the
 * proposal is.
 *
 * `policy.level` is NOT read here, and that is the point. It reaches this
 * function only as `maxPieces`, a ceiling. See the file header.
 */
export function checkProposal(
  raw: readonly PieceProposal[],
  policy: OrchestrationPolicy,
  cap: number,
): ProposalVerdict {
  const pieces = raw
    .map((p) => ({
      ...p,
      title: String(p.title ?? '').trim(),
      prompt: String(p.prompt ?? '').trim(),
      // A model id is a short string; the bound exists so a refusal message
      // never carries an unbounded model-written value. Any truncation still
      // fails the spawn gate — it cannot turn a disallowed id into an allowed
      // one, only into a different disallowed one. Absent stays absent.
      ...bounded('model', p.model),
      // Same treatment, same reason. A blank one is ABSENT rather than an
      // empty string, because absent is a meaning here — "inherit the
      // parent's" — and `''` would be a third state nothing handles.
      ...bounded('agent', p.agent),
      ...bounded('effort', p.effort),
      ...(p.scope ? { scope: p.scope.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()) } : {}),
    }))
    .filter((p) => p.title && p.prompt)

  if (pieces.length < 2) {
    return {
      ok: false,
      rule: 'one-piece',
      message: 'A split needs at least two subtasks, each with a title and a prompt. ' +
        'If the work is one thing, just do it.',
    }
  }

  // Floored at 2, so the ceiling can never forbid a split that the structural
  // checks would otherwise allow.
  const limit = Math.max(2, Math.min(cap, policy.maxPieces))
  if (pieces.length > limit) {
    // REFUSED, never truncated. Truncating to the cap would run agents against
    // briefs written on the assumption that their siblings exist — and would
    // read to the user as "covered everything".
    return {
      ok: false,
      rule: 'over-cap',
      message: `You proposed ${pieces.length} subtasks and the limit here is ${limit}. ` +
        'Group the smaller pieces together and propose again, or do the work yourself. ' +
        'Each subtask is a real agent with a real bill.',
    }
  }

  for (const p of pieces) {
    if (!p.scope?.length) {
      return {
        ok: false,
        rule: 'scope-missing',
        message: `"${p.title}" declares no \`scope\`. Every subtask must say which files or ` +
          'directories it expects to touch — a task with nothing of its own is not a ' +
          'separate task, and the declaration is what lets the board tell you afterwards ' +
          'whether the split was right.',
      }
    }
    if (p.prompt.length > MAX_BRIEF) {
      return {
        ok: false,
        rule: 'brief-too-long',
        message: `The brief for "${p.title}" is ${p.prompt.length} characters and the limit is ` +
          `${MAX_BRIEF}. Say what to do, where, and what done looks like; the agent can read ` +
          'the repository for the rest.',
      }
    }
    if (CROSS_REFERENCE.test(p.prompt)) {
      return {
        ok: false,
        rule: 'brief-cross-reference',
        message: `The brief for "${p.title}" refers to another subtask. Each one starts a FRESH ` +
          'agent that has never seen this conversation and cannot see its siblings, so a ' +
          'brief that depends on another is a brief it cannot follow. Either make it ' +
          'standalone, or do the work yourself in order.',
      }
    }
  }

  return { ok: true, pieces, notes: overlapNotes(pieces) }
}

/** Declared scopes that two pieces share. A note at the approval, not a gate. */
function overlapNotes(pieces: readonly PieceProposal[]): ProposalNote[] {
  const byPath = new Map<string, string[]>()
  for (const p of pieces) {
    for (const s of new Set(p.scope ?? [])) {
      const key = s.replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
      if (!key) continue
      ;(byPath.get(key) ?? byPath.set(key, []).get(key)!).push(p.title)
    }
  }
  const shared = [...byPath.entries()].filter(([, who]) => who.length > 1)
  if (!shared.length) return []
  return [{
    kind: 'scope-overlap',
    paths: shared.map(([path]) => path),
    pieces: [...new Set(shared.flatMap(([, who]) => who))],
  }]
}

// ---------------------------------------------------------------------------
// What gets recorded
// ---------------------------------------------------------------------------

/**
 * Why a card became several — or why it did not.
 *
 * Written once, on the PARENT, at the moment of the decision. It exists because
 * a refusal used to reach the model and nothing else: a session that tried to
 * split, was refused, and did the work alone was byte-identical on the board to
 * the correct adaptive outcome. The feature working and the feature broken
 * rendered the same, on a feature whose whole principle is adaptivity.
 *
 * `stated` is the agent's OWN sentence, captured at the tool call — a
 * commitment checkable against the outcome, not a rationalisation produced
 * afterwards. Quoted and attributed on the card, never merged into ours.
 */
export interface DecompositionRecord {
  at: number
  /**
   * The level in force at LAUNCH, captured with the brief.
   *
   * The gate reads this, never live config. `buildBrief()` runs once when the
   * session starts and bakes the aim sentence in; the split arrives a turn
   * later. Reading the setting at split time would refuse "at Minimal" an agent
   * whose brief had said "several" — so a level change applies to the NEXT
   * session, which is the same honest answer `setProvider()` already gives.
   */
  level: OrchestrationLevel
  /** Two cases, and there is deliberately no third. The ABSENCE of a record is
   *  the "it never considered splitting" answer; asking an agent to record that
   *  would cost a permission prompt for a no-op. */
  outcome: 'split' | 'refused'
  /** How many the agent asked for. With `fanout`, this makes `over-cap`
   *  visible: "asked for 6, the limit is 3 at Balanced". */
  requested: number
  /** Present only on `refused`. Absent, not `'none'`. */
  rule?: ProposalRule
  /** The agent's own line, bounded host-side. */
  stated?: string
}

/** One sentence for the card, DERIVED from the record — the record never stores
 *  a rendered string, so a wording change cannot make old cards lie. */
export function decompositionLine(r: DecompositionRecord, started: number | undefined): string {
  const level = ORCHESTRATION_CHOICES.find((c) => c.key === r.level)?.label ?? r.level
  if (r.outcome === 'split') {
    const n = started ?? r.requested
    return `Split into ${n} subtask${n === 1 ? '' : 's'} · ${level}`
  }
  const why =
    r.rule === 'over-cap' ? `asked for ${r.requested}, over the limit at ${level}`
    : r.rule === 'one-piece' ? 'proposed only one piece'
    : r.rule === 'scope-missing' ? 'a subtask declared no files of its own'
    : r.rule === 'brief-cross-reference' ? 'a brief depended on another subtask'
    : r.rule === 'brief-too-long' ? 'a brief was too long to hand over'
    : r.rule === 'spawn-model' ? 'a subtask asked for a model spawned agents may not run on'
    : r.rule === 'spawn-agent' ? 'a subtask asked for an agent this board cannot start'
    : r.rule === 'spawn-catalogue' ? 'a subtask named a model on a backend the board has not read'
    : r.rule === 'spawn-effort' ? 'a subtask asked for an effort level its model does not take'
    : 'the split was declined'
  return `Kept as one agent — ${why}`
}
