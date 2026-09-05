/**
 * Which models the picker offers, and what each one can do — asked of the CLI
 * rather than written down here.
 *
 * The hardcoded list this replaces was wrong in three separate ways at once, and
 * none of them were visible from inside the extension:
 *
 *  - **It was missing models.** Fable 5 shipped and the picker did not have it.
 *    A table of model ids is a table that goes stale between releases, and the
 *    person who notices is the user, who cannot fix it.
 *  - **It was missing the 1M variants.** `claude-opus-5[1m]` and plain
 *    `claude-opus-5` are different context windows and the picker knew only one.
 *  - **It offered controls models do not have.** Every model got the full
 *    `low…max` effort picker and an "Extended thinking" toggle. Haiku 4.5
 *    supports NEITHER — `supportsEffort` is absent on it — so both controls were
 *    decoration that quietly did nothing, which is the same class of bug as a
 *    spinner over a wedged process.
 *
 * `Query.supportedModels()` answers all three, because it comes from the CLI's
 * `initialize` response — the same list `/model` shows, for whatever provider is
 * actually active. It costs nothing to ask (see `connect.ts`), so the only real
 * design question is when, and the answer is: once per provider, cached, never
 * on the render path.
 *
 * The fallback matters as much as the discovery. A CLI too old to answer, a
 * provider that is down, a first paint before the round trip lands — all of them
 * must still produce a usable picker, so `MODELS` in `sessions/meta.ts` stays as
 * the built-in list and `mergeModels()` decides which is in force. What must
 * never happen is an EMPTY picker: that reads as "this extension is broken", and
 * it would be caused by something as ordinary as being offline.
 */
import type { EffortLevel } from '../sessions/meta.ts'
import { withSilentQuery, type ConnectOptions } from './connect.ts'
import type { ProviderEnv, ProviderProfile } from './providers.ts'

/** What `Query.supportedModels()` returns, narrowed to what we use. Declared
 *  here rather than imported so a shape change shows up as a compile error in
 *  one place instead of spreading through the UI. */
export interface SdkModelInfo {
  value: string
  resolvedModel?: string
  displayName?: string
  description?: string
  supportsEffort?: boolean
  supportedEffortLevels?: EffortLevel[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

/**
 * One entry in the composer's model picker.
 *
 * `efforts` and `thinking` are per model on purpose. They used to be global,
 * which is how Haiku came to show a five-level effort picker it ignores.
 */
export interface ModelChoice {
  /** The id handed to `query()`. Verbatim: an alias like `default` or `sonnet`
   *  is a real thing to pass, and resolving it ourselves would second-guess the
   *  CLI's own resolution. */
  id: string
  label: string
  /** `1M`, `200K`, `?` — the shorthand under the picker. */
  context: string
  /** The CLI's own one-liner, shown as the menu item's detail. */
  detail?: string
  /** Effort levels this model accepts. EMPTY means it has none, and the effort
   *  picker must disappear rather than show choices that do nothing. */
  efforts: EffortLevel[]
  /** Whether the extended-thinking toggle means anything for this model. */
  thinking: boolean
  /**
   * Whether this model can run ultracode — "xhigh effort plus standing
   * dynamic-workflow orchestration", in the SDK's words.
   *
   * Derived from `xhigh` being in the model's effort levels rather than asked
   * for directly, because the SDK states the requirement in exactly those
   * terms and there is no separate capability flag. It is the ONLY part of
   * ultracode we can check before running: `applyFlagSettings()` resolves for
   * a made-up key and a wrong-typed value alike, so the call itself can never
   * say no. See `session.ts` for the other half — the read-back.
   */
  ultracode: boolean
  /** Whether Claude Code's fast mode applies to this model. */
  fastMode: boolean
}

/** Where the list in force came from. Shown in the picker, because "why is
 *  Fable missing" is answerable only if you can see whether we asked. */
export type ModelSource = 'cli' | 'profile' | 'builtin'

export interface ModelCatalogue {
  choices: ModelChoice[]
  source: ModelSource
  /** When the CLI was last asked, for the cache and for the picker's footer. */
  at?: number
  /** Why discovery did not happen, when it did not. Never swallowed: a picker
   *  silently falling back to the built-in list is how a missing model becomes
   *  a mystery. */
  problem?: string
}

/** Every level the SDK accepts, in order. The per-model list is a subset of
 *  this, and is filtered THROUGH it so an unknown level from a newer CLI cannot
 *  reach a `query()` call that would reject it. */
export const ALL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Turn the CLI's answer into picker entries.
 *
 * Pure, so the whole mapping — including the awkward parts below — is testable
 * without a CLI.
 *
 * The context window is derived rather than asked for, because `ModelInfo` does
 * not carry one. Two signals, in order:
 *
 *  1. A `[1m]` suffix on the id or on `resolvedModel`. That marker exists
 *     precisely to distinguish the 1M variant from the standard one, so it is
 *     the most specific thing available and it beats the table.
 *  2. `MODEL_WINDOWS`, looked up through `normaliseModel` on `resolvedModel` —
 *     which is the field that turns `sonnet` into `claude-sonnet-5` and
 *     `us.anthropic.claude-haiku-4-5-…-v1:0` into something the table knows.
 *
 * Anything else is `?`. That is honest: a live run reports the real window on
 * its result message and that always wins, so a `?` in the picker is a label,
 * not a broken meter.
 */
export function toChoices(
  models: readonly SdkModelInfo[],
  normaliseModel: (id: string) => string,
  windows: Record<string, number>,
  windowLabel: (tokens: number | undefined) => string,
): ModelChoice[] {
  const out: ModelChoice[] = []
  for (const m of models) {
    if (!m || typeof m.value !== 'string' || !m.value.trim()) continue
    const id = m.value.trim()
    const resolved = typeof m.resolvedModel === 'string' && m.resolvedModel ? m.resolvedModel : id
    const oneMillion = /\[1m\]$/i.test(id) || /\[1m\]$/i.test(resolved)
    const tokens = oneMillion ? 1_000_000 : windows[normaliseModel(resolved)]

    // `supportsEffort: false` and "the field is absent" are the same answer —
    // Haiku sends neither field — so the levels are gated on the flag being
    // explicitly true, not on the array being present.
    const efforts = m.supportsEffort === true
      ? ALL_EFFORTS.filter((e) => (m.supportedEffortLevels ?? ALL_EFFORTS).includes(e))
      : []

    out.push({
      id,
      label: m.displayName?.trim() || id,
      context: windowLabel(tokens),
      ...(m.description?.trim() ? { detail: m.description.trim() } : {}),
      efforts,
      thinking: m.supportsAdaptiveThinking === true,
      ultracode: efforts.includes('xhigh'),
      fastMode: m.supportsFastMode === true,
    })
  }
  return out
}

/**
 * Ask the CLI what it can run.
 *
 * Never throws: the caller is a picker, and "we could not ask" has to end in a
 * usable list rather than an error dialog. The reason travels back in
 * `problem` so it can be logged and shown, because a silent fallback is how
 * "why is Fable missing?" becomes unanswerable.
 */
export async function discoverModels(
  _profile: ProviderProfile,
  env: ProviderEnv,
  deps: {
    normaliseModel: (id: string) => string
    windows: Record<string, number>
    windowLabel: (tokens: number | undefined) => string
  },
  opts: ConnectOptions = {},
): Promise<{ choices: ModelChoice[]; problem?: string }> {
  try {
    const models = await withSilentQuery(env, { timeoutMs: 15_000, ...opts }, async (q, race) => {
      if (typeof q.supportedModels !== 'function') return undefined
      return race(q.supportedModels()) as Promise<SdkModelInfo[] | undefined>
    })
    if (!Array.isArray(models) || !models.length) {
      return { choices: [], problem: 'The CLI did not report a model list. Older versions do not.' }
    }
    const choices = toChoices(models, deps.normaliseModel, deps.windows, deps.windowLabel)
    return choices.length
      ? { choices }
      : { choices: [], problem: 'The CLI reported a model list this version cannot read.' }
  } catch (e) {
    return { choices: [], problem: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Read a catalogue back out of extension storage.
 *
 * `globalState` outlives the extension VERSION that wrote it, so a cache is
 * another program's output — specifically, an older build of this one. When
 * `ModelChoice` gained `ultracode` and `fastMode`, every previously cached entry
 * became a `ModelChoice` with holes in it, and `effortsFor()` handed back
 * `undefined` where the composer does `levels.includes(...)`. That throws inside
 * `getState()`, which this project has a postmortem for: it is not an error
 * message, it is a silently blank panel.
 *
 * So the cache is parsed, not trusted — the same treatment `parseProfiles` gives
 * `settings.json`.
 *
 * A single malformed entry discards the WHOLE cache rather than being skipped.
 * A shape change invalidates every entry at once, so a partial result would mean
 * "some of your models silently vanished"; an empty one means "ask again", which
 * costs one 400ms round trip and produces the right answer.
 */
export function parseCachedChoices(raw: unknown): ModelChoice[] {
  if (!Array.isArray(raw) || !raw.length) return []
  const out: ModelChoice[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return []
    const c = entry as Record<string, unknown>
    if (typeof c.id !== 'string' || !c.id) return []
    if (typeof c.label !== 'string' || typeof c.context !== 'string') return []
    if (!Array.isArray(c.efforts)) return []
    if (typeof c.thinking !== 'boolean') return []
    if (typeof c.ultracode !== 'boolean' || typeof c.fastMode !== 'boolean') return []
    out.push({
      id: c.id,
      label: c.label,
      context: c.context,
      ...(typeof c.detail === 'string' && c.detail ? { detail: c.detail } : {}),
      // Filtered THROUGH the known levels, so a cache from a build that knew a
      // level this one does not cannot reach a `query()` call that rejects it.
      efforts: ALL_EFFORTS.filter((e) => (c.efforts as unknown[]).includes(e)),
      thinking: c.thinking,
      ultracode: c.ultracode,
      fastMode: c.fastMode,
    })
  }
  return out
}

/**
 * The models a profile DECLARES, as picker entries.
 *
 * The built-in Claude list is right on first-party and wrong everywhere else:
 * Bedrock wants `us.anthropic.claude-opus-5`, and behind a router serving Qwen
 * the Claude ids name nothing at all. So a profile may name its own ids.
 *
 * Returns EMPTY when it declares nothing, and that is the entire contract: it
 * answers "what did this profile declare", never "what should the picker show".
 *
 * That distinction is not pedantry — it is the bug this file now guards. This
 * function used to fall back to the built-in list here, which read as helpful.
 * But its caller composes it with `mergeModels`, whose FIRST rule is "a list the
 * profile declares wins" — so a profile that declared nothing handed over the
 * built-in three, that branch matched, and the CLI's real answer was thrown away
 * on every refresh. Fable never appeared, and every unit test was green because
 * neither function was wrong on its own.
 *
 * Labels and windows are DERIVED. `normaliseModel` already knows that
 * `us.anthropic.claude-haiku-4-5-20251001-v1:0` is Haiku 4.5, so a Bedrock
 * profile listing full inference-profile ids gets the same readable name and the
 * same window as first-party, from the same table the context meter measures
 * against. `known` is consulted for that and nothing else; it is never returned
 * wholesale.
 *
 * Capabilities get the SAFE defaults, not the permissive ones: nobody asked this
 * endpoint what it supports, so effort and thinking stay available (losing them
 * only costs a control) while ultracode and fast mode stay off (offering them
 * would spend money on a mode the model may not have).
 */
export function modelsForProfile(
  profile: Pick<ProviderProfile, 'models' | 'contextWindow'>,
  known: readonly ModelChoice[],
  normalise: (id: string) => string,
  windows: Record<string, number>,
  windowLabel: (tokens: number | undefined) => string,
): ModelChoice[] {
  if (!profile.models?.length) return []
  return profile.models.map((id) => {
    const base = normalise(id)
    const match = known.find((f) => f.id === base)
    return {
      id,
      label: match?.label ?? id,
      context: windowLabel(windows[base] ?? profile.contextWindow),
      efforts: [...ALL_EFFORTS],
      thinking: true,
      ultracode: false,
      fastMode: false,
    }
  })
}

/**
 * The catalogue the picker shows: profile, then CLI, then built-in.
 *
 * ONE call, because the host used to compose two functions itself and got the
 * order wrong in a way no unit test could see. There is now a single entry
 * point, and `models.test.ts` exercises exactly it.
 */
export function catalogueFor(
  profile: Pick<ProviderProfile, 'models' | 'contextWindow'>,
  discovered: readonly ModelChoice[],
  builtin: readonly ModelChoice[],
  deps: {
    normaliseModel: (id: string) => string
    windows: Record<string, number>
    windowLabel: (tokens: number | undefined) => string
  },
  problem?: string,
): ModelCatalogue {
  return mergeModels(
    discovered,
    modelsForProfile(profile, builtin, deps.normaliseModel, deps.windows, deps.windowLabel),
    builtin,
    problem,
  )
}

/**
 * Decide which list is in force.
 *
 * Order, and the reasoning for it:
 *
 *  1. **The profile's own `models`**, if it declares any. Someone who wrote a
 *     list into their settings has said something more specific than any
 *     discovery could, and behind a router the CLI's list is its own, not the
 *     router's.
 *  2. **What the CLI reported.** The truth for whatever provider is active,
 *     including models that shipped after this extension did.
 *  3. **The built-in list.** Offline, an old CLI, or the first paint before the
 *     round trip lands.
 *
 * Never empty. An empty picker reads as a broken extension, and the cause would
 * be something as ordinary as being on a train.
 */
export function mergeModels(
  discovered: readonly ModelChoice[],
  fromProfile: readonly ModelChoice[] | undefined,
  builtin: readonly ModelChoice[],
  problem?: string,
): ModelCatalogue {
  if (fromProfile?.length) return { choices: [...fromProfile], source: 'profile' }
  if (discovered.length) return { choices: [...discovered], source: 'cli' }
  return { choices: [...builtin], source: 'builtin', ...(problem ? { problem } : {}) }
}

/** The effort levels to offer for the selected model, and whether to offer any.
 *  A model with none must lose the control, not be shown a disabled one — the
 *  question "why is this greyed out" has no answer worth reading. */
export function effortsFor(choices: readonly ModelChoice[], modelId: string): EffortLevel[] {
  const m = choices.find((c) => c.id === modelId)
  // An unknown selection (a hand-edited setting, a stale workspaceState) keeps
  // the full list rather than losing the control: better a level the CLI may
  // ignore than a picker that vanishes for no visible reason.
  return m ? m.efforts : ALL_EFFORTS
}

/** Whether the extended-thinking toggle means anything for the selected model. */
export function thinkingFor(choices: readonly ModelChoice[], modelId: string): boolean {
  const m = choices.find((c) => c.id === modelId)
  return m ? m.thinking : true
}

/**
 * Whether to offer the ultracode toggle for the selected model.
 *
 * Note the asymmetry with `effortsFor` and `thinkingFor`: an UNKNOWN model gets
 * `false` here, not the permissive default. Those two lose a control when they
 * guess wrong; this one would offer a mode the model cannot run, and ultracode
 * costs real money — it is xhigh effort plus a standing instruction to fan out
 * into workflows. Guessing "yes" on a model we have never heard of is the
 * expensive direction to be wrong in.
 */
export function ultracodeFor(choices: readonly ModelChoice[], modelId: string): boolean {
  return choices.find((c) => c.id === modelId)?.ultracode === true
}

/** Whether to offer fast mode for the selected model. Same asymmetry, same
 *  reason: unknown means no. */
export function fastModeFor(choices: readonly ModelChoice[], modelId: string): boolean {
  return choices.find((c) => c.id === modelId)?.fastMode === true
}
