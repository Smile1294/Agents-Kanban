/**
 * WHICH AGENT, WHICH BACKEND, WHICH MODEL a spawned session runs on.
 *
 * A session's runtime, backend and model are three separate facts and this
 * project has a rule about two of them already: *"A RUNTIME is not a provider,
 * and the difference is which process"*, and *"a session keeps the runtime it
 * started on"*. Per-piece routing is where all three arrive at once, from a
 * model-written tool call, before any worktree exists — so this file is the
 * whole policy, pure, and `AgentManager.split()` is the only place that runs it.
 *
 * ## The bug it exists to fix
 *
 * `split()` passed `runtime: parent.runtime` to every child and said NOTHING
 * about the backend, so `launch()` fell through to `this.opts.provider` — the
 * workspace's ACTIVE profile. A session that had been running on DeepSeek all
 * morning fanned out into children on Anthropic: a different bill, different
 * model ids, and nothing on the board saying so. That is the exact mirror of
 * the runtime bug the comment above `runtime: parent.runtime` exists to record,
 * in the one place the fix was never applied. A route now carries BOTH halves
 * and the default is the parent's whole agent, not half of it.
 *
 * ## Why routing is CHECKING and not DECIDING
 *
 * The elegant design is *requirements in, route out*: the planner emits a
 * requirement vector and a pure function picks the model. It cannot be built
 * honestly here, because the facts a router would need are absent on the
 * default runtime — `claudeRuntime.models()` omits `supportedEffort`, so a
 * router would announce "Opus 5 has no effort levels" about a model with five.
 * A router whose facts are absent is a router that fabricates.
 *
 * So the agent NAMES the agent, model and effort; the host validates against
 * the catalogue and refuses an id it does not serve. That is not a placeholder:
 * a model choosing its own tool is exactly how model and effort already work
 * per session on the composer.
 *
 * ## The four refusals, and why they are four
 *
 * Each one has a DIFFERENT fix, which is the whole reason they are not one
 * message — the same rule the four `LoginState` cases and the four
 * `checkEndpoint()` answers already follow:
 *
 *  - `spawn-agent` — that agent program or backend is not configured. Configure
 *    it, or route the piece somewhere else.
 *  - `spawn-model` — the backend is real and does not serve that id. Name one
 *    it does, or re-tick it on the settings page.
 *  - `spawn-catalogue` — the backend is real and NOBODY HAS ASKED IT what it
 *    serves, so its "model list" is the built-in Anthropic table standing in.
 *    Refusing on that as though it were fact would be fabrication; the fix is
 *    to go and read the backend, not to change the id.
 *  - `spawn-effort` — the model does not take that effort level. Named as an
 *    open gap by the orchestration research: a piece proposing `xhigh` on a
 *    model with no such level was accepted, silently dropped by the flag gate
 *    at launch, and nothing on the card said the request was discarded. That is
 *    "a session flag is a request the CLI never refuses" in a new place.
 *
 * Plain Node, no `vscode`, no I/O — so the entire policy is exercised by
 * `routing.test.ts` without an editor, a CLI or a credential.
 */
import { RUNTIME_IDS, type RuntimeId } from './runtime.ts'
import { EFFORT_LEVELS, type EffortLevel } from '../sessions/meta.ts'

/** The composer's key for "what does this run on", and deliberately the same
 *  string here. The picker the user clicks and the value an agent names must
 *  not be two vocabularies that can drift apart — they did once, when the
 *  composer offered an agent picker and the settings page owned the backend,
 *  and the bar showed half of the answer. */
export function agentKeyOf(runtime: RuntimeId, provider: string): string {
  return `${runtime}|${provider}`
}

/**
 * Read a key back into its halves.
 *
 * Parsed, never cast: this value arrives from a webview message and from
 * storage written by a build that may predate a runtime being added. An
 * unknown runtime half is `undefined` rather than a `RuntimeId` the registry
 * has never heard of, which is the same treatment `parseRuntimeId` gives.
 */
export function parseAgentKey(raw: unknown): { runtime: RuntimeId; provider: string } | undefined {
  if (typeof raw !== 'string') return undefined
  const cut = raw.indexOf('|')
  if (cut < 0) return undefined
  const runtime = raw.slice(0, cut)
  if (!(RUNTIME_IDS as readonly string[]).includes(runtime)) return undefined
  return { runtime: runtime as RuntimeId, provider: raw.slice(cut + 1) }
}

/**
 * Which `SpawnPolicy` entry an agent's per-model ticks live under.
 *
 * The policy is keyed by BACKEND, because that is what a model id belongs to.
 * For a runtime that signs in as itself there is no backend, so the runtime IS
 * the key — namespaced, because profile ids are user data and a profile called
 * `codex` must not silently share a tick list with the Codex runtime.
 *
 * A profile-bearing runtime keys on the bare profile id and NOT on the agent
 * key, deliberately: policies written before per-piece routing existed are
 * keyed that way, and absence in this scheme reads as "allowed" — so keying on
 * something new would quietly re-allow every model a user had unticked.
 */
export function spawnKeyFor(_runtime: RuntimeId, provider: string): string {
  return provider || `runtime:${_runtime}`
}

/**
 * The short name an agent is called by in a tool call.
 *
 * A profile id is a uuid. Asking a model to emit one is asking for a
 * transcription error that would surface as `spawn-agent` on a piece the agent
 * routed correctly — so every agent gets a slug derived from its label, and
 * `findSpawnAgent` accepts the key and the label as well.
 *
 * Deduped by numbering rather than by appending the id: two profiles labelled
 * "Self-hosted" are a thing people really have, and `self-hosted-2` is a name a
 * model can carry from a description into a tool call.
 */
export function slugFor(label: string, taken: ReadonlySet<string>): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

/** One model a spawned session may run on, and what it takes. `efforts` EMPTY
 *  means nobody has asked — never "none", which is why the effort gate is
 *  one-sided. */
export interface SpawnModel {
  id: string
  efforts: EffortLevel[]
}

/** One agent program + backend combination a spawned session may run on: the
 *  same cross product the composer offers, narrowed by the spawn policy. */
export interface SpawnAgent {
  /** The short, model-facing name. Unique within the catalogue. */
  slug: string
  /** `<runtime>|<profile>` — the composer's key. */
  key: string
  /** What the user calls it. Used in refusals, so they name the thing on screen. */
  label: string
  runtime: RuntimeId
  /** `''` when the runtime has no backend concept. */
  provider: string
  models: SpawnModel[]
  /**
   * Whether `models` was READ from this backend, or is the built-in Anthropic
   * table standing in because nothing has ever asked it.
   *
   * Load-bearing, and the reason `spawn-catalogue` is a separate rule: the
   * built-in list is about Anthropic's first-party models and about nothing
   * else. `MODEL_RATES` and `MODEL_WINDOWS` are keyed by Anthropic's ids and no
   * other provider uses them — so treating that list as a gateway's is the same
   * mistake as a probe reporting the CLI's `supportedModels()` as the
   * endpoint's, which this project has a postmortem about.
   */
  known: boolean
}

export interface SpawnCatalogue {
  /**
   * Every combination on offer. An agent with no allowed model is OMITTED by
   * the host, so an EMPTY array is a real state and means "the user unticked
   * everything" — distinct from an ABSENT catalogue, which means no policy.
   */
  agents: SpawnAgent[]
}

export type RouteRule = 'spawn-agent' | 'spawn-model' | 'spawn-catalogue' | 'spawn-effort'

/** Enumerated so `decompositionLine()` can be checked to render all of them. A
 *  rule with no case there falls through to "the split was declined", which is
 *  the feature working and the feature broken rendering the same. */
export const ALL_ROUTE_RULES: readonly RouteRule[] =
  ['spawn-agent', 'spawn-model', 'spawn-catalogue', 'spawn-effort'] as const

/** What one piece asks to run on, as the model wrote it — every field a raw
 *  string, because that is what arrives. */
export interface RouteAsk {
  agent?: string
  model?: string
  effort?: string
}

/** Where a piece will actually run, once resolved and checked. `model` absent
 *  means "let the launch resolve the default", which is only ever the answer
 *  for a piece staying on the parent's own agent. */
export interface PieceRoute {
  runtime: RuntimeId
  provider: string
  model?: string
  effort?: EffortLevel
}

export type RouteVerdict =
  | { ok: true; route: PieceRoute }
  | { ok: false; rule: RouteRule; message: string }

/** A few ids then a count — never the whole of OpenRouter's 431. */
function nameSome(ids: readonly string[], most: number): string {
  const shown = ids.slice(0, most).join(', ')
  return ids.length > most ? `${shown} +${ids.length - most} more` : shown
}

/** Model-written input, so matched the way `board/questions.ts` matches: on the
 *  slug, the full key and the label, and on all three with the separators
 *  stripped, because "Deep Seek" and "deepseek" are the same request. */
const loose = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

export function findSpawnAgent(asked: string, agents: readonly SpawnAgent[]): SpawnAgent | undefined {
  const want = asked.trim()
  if (!want) return undefined
  const exact = agents.find((a) => a.slug === want || a.key === want)
  if (exact) return exact
  const key = loose(want)
  if (!key) return undefined
  return agents.find((a) => loose(a.slug) === key || loose(a.key) === key || loose(a.label) === key)
}

/**
 * The agents, for the tool description.
 *
 * BOUNDED, deliberately. The old description interpolated
 * `ctx.spawnModels.join(', ')` whole, and on a router profile that is 431 ids
 * with no ceiling — a tool description the agent re-reads before every split.
 * The refusals are the authoritative list; this is the menu.
 */
export function describeSpawnAgents(agents: readonly SpawnAgent[], maxModels = 6): string {
  if (!agents.length) return ''
  return agents
    .map((a) => {
      const models = nameSome(a.models.map((m) => m.id), maxModels)
      // Said out loud rather than hidden: a list we have not read is a list the
      // agent should name a model from cautiously, and it will be told so by
      // `spawn-catalogue` if it guesses.
      const unread = a.known ? '' : ' · list not read from this backend yet'
      return `  - ${a.slug} — ${a.label} (models: ${models}${unread})`
    })
    .join('\n')
}

const effortOf = (raw: string): EffortLevel | undefined =>
  EFFORT_LEVELS.find((e) => e.key === raw)?.key

/**
 * Resolve one piece's routing, and check it.
 *
 * `parent` is the whole agent the splitting session is on — BOTH halves. A
 * piece that names nothing inherits both, which is the fix for the bug in this
 * file's header; a piece that names an agent gets that one, validated.
 *
 * `catalogue` ABSENT means no gate, which is the pre-existing behaviour and is
 * what keeps the manager unit-testable without an editor. `{ agents: [] }` is
 * the opposite claim and refuses.
 *
 * `fallbackModel` is the workspace default for new sessions — the EFFECTIVE
 * model for a piece that names none. It is gated, not waved through: unticking
 * the default on the settings page means "not even on my default". It is only
 * an honest fallback for a piece staying on the parent's own agent, because it
 * is an id belonging to whatever backend is active, and a different backend
 * does not serve it.
 */
export function resolveRoute(
  asked: RouteAsk,
  parent: { runtime: RuntimeId; provider: string },
  catalogue: SpawnCatalogue | undefined,
  fallbackModel?: string,
): RouteVerdict {
  const named = typeof asked.model === 'string' && asked.model.trim() ? asked.model.trim() : undefined
  const wantsAgent = typeof asked.agent === 'string' && asked.agent.trim() ? asked.agent.trim() : undefined
  const levels = EFFORT_LEVELS.map((e) => e.key)

  // Junk first, and refused rather than dropped, whether or not there is a
  // catalogue: `xhigh` is checkable against the model, but `banana` is not a
  // level at all and needs no facts to reject. Dropping it is precisely what
  // made `ultracode: 'banana'` resolve cleanly and change nothing.
  let effort: EffortLevel | undefined
  if (typeof asked.effort === 'string' && asked.effort.trim()) {
    effort = effortOf(asked.effort.trim())
    if (!effort) {
      return {
        ok: false,
        rule: 'spawn-effort',
        message: `"${asked.effort.trim().slice(0, 40)}" is not an effort level. ` +
          `Use one of: ${levels.join(', ')} — or leave it out and the subtask runs at the ` +
          'level the user has chosen for new sessions.',
      }
    }
  }

  const inheritedRoute = (): RouteVerdict => ({
    ok: true,
    route: {
      runtime: parent.runtime,
      provider: parent.provider,
      ...(named ? { model: named } : {}),
      ...(effort ? { effort } : {}),
    },
  })

  if (!catalogue) return inheritedRoute()

  const parentKey = agentKeyOf(parent.runtime, parent.provider)
  const target = wantsAgent
    ? findSpawnAgent(wantsAgent, catalogue.agents)
    : catalogue.agents.find((a) => a.key === parentKey)

  if (!target) {
    // An EMPTY catalogue is `spawn-model`, not `spawn-agent`, because the rules
    // are told apart by their FIX and this one's fix is a tick: the host omits
    // an agent with no allowed model, so an empty catalogue is the user having
    // unticked every model on every backend.
    if (!catalogue.agents.length) {
      return {
        ok: false,
        rule: 'spawn-model',
        message: 'No model is allowed for spawned agents right now — the user unticked every one ' +
          'on the settings page. Do the work yourself, or ask the user to re-tick a model.',
      }
    }
    const offered = catalogue.agents.map((a) => a.slug).join(', ')
    return {
      ok: false,
      rule: 'spawn-agent',
      message: wantsAgent
        ? `"${wantsAgent.slice(0, 60)}" is not an agent this board can start. ` +
          `Use one of: ${offered}. Each one is a different agent program or a different backend, ` +
          'and a session keeps the one it starts on for life.'
        // Accurate about BOTH causes, because they are equally likely and the
        // board cannot tell them apart from here: the profile may have been
        // deleted, or it may still exist with every one of its models
        // unticked. Either way naming another agent is a fix the agent can
        // apply on its own, so the message leads with that.
        : "This session's own backend is not available for spawned agents — it has either had " +
          'all of its models unticked on the settings page, or been removed. Name an agent ' +
          `explicitly — one of: ${offered} — or do the work yourself.`,
    }
  }

  // The EFFECTIVE model is what gets gated, exactly as before: a piece that
  // names none inherits the default, so unticking the default means "not even
  // on my default". What is new is that the default is only an honest fallback
  // on the parent's OWN agent — it is an id belonging to the active backend,
  // and a piece routed elsewhere would launch on an id that backend does not
  // serve. That is the failure a gate against the wrong catalogue produces, so
  // it is refused here rather than defaulted.
  const staying = target.key === parentKey
  const effective = named ?? (staying ? fallbackModel : undefined)
  const serves = target.models.map((m) => m.id)

  if (!effective && !staying) {
    return {
      ok: false,
      rule: 'spawn-model',
      message: `"${target.label}" is a different backend from this session's, so the model has to be ` +
        `named — the default for new sessions belongs to another one. Use one of: ${nameSome(serves, 12)}.`,
    }
  }

  if (effective && !serves.includes(effective)) {
    if (!target.known) {
      return {
        ok: false,
        rule: 'spawn-catalogue',
        message: `The board has not read which models "${target.label}" serves, so it cannot tell ` +
          `whether "${effective}" is one of them — the list it has is the built-in Anthropic one ` +
          'standing in. Ask the user to open the settings page and test that backend, then propose ' +
          'the split again; or route this subtask to an agent the board has read.',
      }
    }
    return {
      ok: false,
      rule: 'spawn-model',
      message: `"${target.label}" does not serve "${effective}"` +
        `${named ? '' : ' (the default for new sessions)'}. ` +
        `Spawned agents may use: ${nameSome(serves, 12)}. Name one of those, or do the work yourself.`,
    }
  }

  // The seventh gate. ONE-SIDED on purpose: an EMPTY `efforts` list means
  // nobody asked this backend, and refusing on an absence would stop every
  // gateway session choosing a level it may well support. `supportedEffort` is
  // ABSENT rather than false on a model that has none, which is why the check
  // is `length && !includes` and not `!includes`.
  if (effort && effective) {
    const known = target.models.find((m) => m.id === effective)
    if (known?.efforts.length && !known.efforts.includes(effort)) {
      return {
        ok: false,
        rule: 'spawn-effort',
        message: `"${effective}" does not take ${effort} effort. It takes: ${known.efforts.join(', ')}. ` +
          'Leaving effort out is also fine — the subtask then runs at the level the user has chosen.',
      }
    }
  }

  return {
    ok: true,
    route: {
      runtime: target.runtime,
      provider: target.provider,
      ...(named ? { model: named } : {}),
      ...(effort ? { effort } : {}),
    },
  }
}
