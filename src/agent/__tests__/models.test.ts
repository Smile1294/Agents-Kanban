/* The model list, asked of the CLI rather than written down.
 *
 * The hardcoded table this replaces was wrong in three ways at once, and every
 * one of them was invisible from inside the extension. The three sections below
 * are those three failures, turned into assertions:
 *
 *  1. A model shipped and the picker did not have it (Fable 5).
 *  2. `claude-opus-5[1m]` and `claude-opus-5` are different context windows,
 *     and the picker knew only one number.
 *  3. Every model was offered five effort levels and an extended-thinking
 *     toggle. Haiku 4.5 has NEITHER, so both were controls that could not say
 *     no.
 *
 * The fixture is the real answer from a real CLI, copied verbatim — including
 * the awkward parts (an alias as the `value`, a `[1m]` suffix on one side of
 * `resolvedModel` and not the other, and Haiku omitting the capability fields
 * rather than setting them false).
 */
import {
  ALL_EFFORTS, catalogueFor, effortsFor, endpointChoices, fastModeFor, mergeModels,
  modelsForProfile, parseCachedChoices, priceLabel, thinkingFor, toChoices,
  ultracodeFor, type SdkModelInfo,
} from '../models.ts'
import type { EndpointModel } from '../endpoint.ts'
import type { ProviderProfile } from '../providers.ts'
import { ultracodeWarning } from '../session.ts'
import { MODEL_RATES, MODEL_WINDOWS, normaliseModel } from '../../sessions/usage.ts'
import { MODELS, windowLabel } from '../../sessions/meta.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

/** Verbatim from `Query.supportedModels()` on a real Claude Code 2.1.239. */
const REAL: SdkModelInfo[] = [
  {
    value: 'default', resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true,
  },
  {
    value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Opus (1M context)',
    description: 'Opus 5 with 1M context · Best for everyday, complex tasks',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true,
  },
  {
    value: 'claude-fable-5[1m]', resolvedModel: 'claude-fable-5',
    displayName: 'Fable',
    description: 'Fable 5 · Most capable for your hardest and longest-running tasks',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true, supportsAutoMode: true,
  },
  {
    value: 'sonnet', resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet', description: 'Sonnet 5 · Efficient for routine tasks',
    supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    supportsAdaptiveThinking: true, supportsAutoMode: true,
  },
  // Note what this one does NOT have: no supportsEffort, no
  // supportedEffortLevels, no supportsAdaptiveThinking. Absent, not false.
  {
    value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers',
  },
]

const choices = toChoices(REAL, normaliseModel, MODEL_WINDOWS, windowLabel)
const by = (id: string) => choices.find((c) => c.id === id)

// --- 1. the models that were missing ----------------------------------------
{
  ok(choices.length === REAL.length, `every model the CLI reported is offered (${choices.length})`)

  // The one that started this: Fable 5 shipped and the built-in table did not
  // have it. A hardcoded list goes stale between releases and the person who
  // notices is the user, who cannot fix it.
  ok(!!by('claude-fable-5[1m]'), 'Fable is in the picker, which the built-in table never had')
  ok(by('claude-fable-5[1m]')?.label === 'Fable', 'under the name the CLI gives it')
  ok(!MODELS.some((m) => m.id.includes('fable')),
     'and the built-in table still does not have it — which is the point of asking')

  ok(!!by('default'), 'the CLI’s "Default (recommended)" entry is offered too')
  ok(by('default')?.label === 'Default (recommended)',
     'with its own display name rather than a resolved id nobody chose')

  // The id is passed through VERBATIM. `default` and `sonnet` are real things
  // to hand `query()`, and resolving them ourselves would second-guess the
  // CLI's own resolution — which is per provider and can change without us.
  ok(by('sonnet')?.id === 'sonnet', 'an alias stays an alias: the CLI resolves it, not us')
}

// --- 2. the context window ---------------------------------------------------
{
  ok(by('opus[1m]')?.context === '1M', 'a [1m] variant is a 1M window')
  ok(by('default')?.context === '1M', 'including when the marker is only on resolvedModel')
  ok(by('claude-fable-5[1m]')?.context === '1M',
     'and when it is only on the id — the marker counts from either side')
  ok(by('haiku')?.context === '200K',
     'a dated id resolves through the same window table the context meter uses')

  // Nothing is invented. A live run reports the real window on its result
  // message and always wins, so `?` is a label, not a broken meter.
  const unknown = toChoices(
    [{ value: 'qwen3-coder', displayName: 'Qwen' }], normaliseModel, MODEL_WINDOWS, windowLabel,
  )
  ok(unknown[0]?.context === '?', 'a model with no known window says so rather than guessing')
}

// --- 3. the controls that could not say no ----------------------------------
{
  ok(by('haiku')?.efforts.length === 0,
     'Haiku accepts NO effort levels — it was being offered five')
  ok(by('haiku')?.thinking === false,
     'and has no adaptive thinking — it was being offered an On/Off toggle')
  ok(by('opus[1m]')?.efforts.length === 5, 'Opus accepts all five')
  ok(by('opus[1m]')?.thinking === true, 'and has adaptive thinking')

  // Absent and false must mean the same thing. Haiku sends neither field, so
  // gating on the array being present would have given it the full list back.
  const absent = toChoices([{ value: 'x' }], normaliseModel, MODEL_WINDOWS, windowLabel)
  ok(absent[0]?.efforts.length === 0, 'a model that says nothing about effort gets none')
  ok(absent[0]?.thinking === false, 'and none about thinking gets no toggle')

  // A newer CLI naming a level this SDK cannot pass must not reach `query()`.
  const future = toChoices(
    [{ value: 'y', supportsEffort: true, supportedEffortLevels: ['low', 'ultra' as never] }],
    normaliseModel, MODEL_WINDOWS, windowLabel,
  )
  ok(future[0]?.efforts.join() === 'low', 'a level this version does not know is filtered out, not passed on')

  // The order is ours, not the CLI's: a picker whose levels are shuffled
  // between refreshes is a picker nobody can build muscle memory for.
  const shuffled = toChoices(
    [{ value: 'z', supportsEffort: true, supportedEffortLevels: ['max', 'low', 'high'] }],
    normaliseModel, MODEL_WINDOWS, windowLabel,
  )
  ok(shuffled[0]?.efforts.join() === 'low,high,max', 'levels come back in a stable order')
}

// --- ultracode and fast mode ------------------------------------------------
// Both are session flags the CLI accepts WITHOUT VALIDATION: measured against a
// real CLI, `applyFlagSettings()` resolves for `ultracode: true` on a model
// with no xhigh, for `ultracode: 'banana'`, and for a key that does not exist.
// So the model's own capability is the only gate available before the run, and
// it has to be right.
{
  ok(by('opus[1m]')?.ultracode === true, 'ultracode is offered on an xhigh-capable model')
  ok(by('claude-fable-5[1m]')?.ultracode === true, 'and on Fable, which is also xhigh-capable')
  ok(by('haiku')?.ultracode === false,
     'and NOT on Haiku, which has no effort levels at all — it cannot run xhigh')

  // Derived from xhigh rather than a flag of its own, because the SDK states
  // the requirement in exactly those terms: "requires an xhigh-capable model".
  const noXhigh = toChoices(
    [{ value: 'm', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }],
    normaliseModel, MODEL_WINDOWS, windowLabel,
  )
  ok(noXhigh[0]?.ultracode === false, 'a model that stops at high cannot run ultracode')

  ok(by('opus[1m]')?.fastMode === true, 'fast mode follows the CLI’s own flag')
  ok(by('claude-fable-5[1m]')?.fastMode === false, 'and is absent on a model that does not report it')

  // The asymmetry that matters. `effortsFor` and `thinkingFor` are permissive
  // on an unknown model — they only risk losing a control. These two would
  // offer a mode the model cannot run, and ultracode is xhigh effort plus a
  // standing instruction to fan out into workflows. Guessing "yes" is the
  // expensive direction to be wrong in.
  ok(ultracodeFor(choices, 'no-such-model') === false,
     'an unknown model is NOT offered ultracode — the expensive guess is the one not to make')
  ok(fastModeFor(choices, 'no-such-model') === false, 'nor fast mode')
  ok(ultracodeFor([], 'anything') === false, 'and neither is anything, before the list has loaded')
  ok(ultracodeFor(choices, 'opus[1m]') === true, 'while a known capable model is')
}

// --- what the pickers ask for -----------------------------------------------
{
  ok(effortsFor(choices, 'haiku').length === 0, 'the effort control disappears for Haiku')
  ok(effortsFor(choices, 'opus[1m]').length === 5, 'and is full for Opus')
  ok(thinkingFor(choices, 'haiku') === false, 'the thinking toggle disappears for Haiku')

  // An unrecognised selection — a hand-edited setting, a stale workspaceState,
  // a model list that has not loaded yet — keeps the controls. Better a level
  // the CLI may ignore than a control that vanishes for no visible reason.
  ok(effortsFor(choices, 'no-such-model').join() === ALL_EFFORTS.join(),
     'an unknown selection keeps the full effort list rather than losing the control')
  ok(thinkingFor(choices, 'no-such-model') === true, 'and keeps the thinking toggle')
  ok(effortsFor([], 'anything').length === ALL_EFFORTS.length,
     'and so does an empty catalogue, which is what the first paint looks like')
}

// --- which list is in force -------------------------------------------------
{
  const builtin = MODELS.map((m) => ({
    ...m, efforts: [...ALL_EFFORTS], thinking: true, ultracode: false, fastMode: false,
  }))
  const declared = [{
    id: 'qwen', label: 'Qwen', context: '128K', efforts: [], thinking: false,
    ultracode: false, fastMode: false,
  }]

  ok(mergeModels(choices, undefined, builtin).source === 'cli',
     'what the CLI reported beats the built-in table')
  ok(mergeModels(choices, declared, builtin).source === 'profile',
     'but a list the profile declares beats even that — it is the more specific statement')
  ok(mergeModels([], undefined, builtin).source === 'builtin',
     'and with no answer, the built-in table is the floor')

  // The one thing that must never happen. An empty picker reads as a broken
  // extension, and the cause would be something as ordinary as being offline.
  for (const [d, p] of [[choices, declared], [choices, undefined], [[], undefined], [[], []]] as const) {
    ok(mergeModels(d, p, builtin).choices.length > 0, 'the picker is never empty, whatever failed')
  }
  ok(mergeModels([], undefined, builtin, 'offline').problem === 'offline',
     'and a fallback carries the reason, so "why is my model missing" is answerable')
  ok(mergeModels(choices, undefined, builtin, 'offline').problem === undefined,
     'while a successful discovery carries none')
}

// --- junk in, usable list out -----------------------------------------------
// `supportedModels()` is another program's output.
{
  const junk = toChoices(
    [null, 3, {}, { value: '' }, { value: '  ' }, { value: 'ok' }] as never,
    normaliseModel, MODEL_WINDOWS, windowLabel,
  )
  ok(junk.length === 1 && junk[0]?.id === 'ok', 'unusable entries are dropped, not rendered as blanks')
  ok(junk[0]?.label === 'ok', 'a model with no display name falls back to its id rather than an empty chip')
  ok(toChoices([], normaliseModel, MODEL_WINDOWS, windowLabel).length === 0,
     'an empty answer is empty, not an error — mergeModels decides what to do about it')
}

// --- a model the picker offers must be one the meters can measure ------------
//
// The picker is now driven by the CLI, so it offers whatever Claude Code can
// run — including models released after this extension was. `MODEL_RATES` and
// `MODEL_WINDOWS` are not, and the gap is silent: an unpriced model reports
// `≥ $0.00` and a `?` window, which is honest and useless.
//
// Fable shipped, the picker gained it, and neither table had it. This ties the
// two together the way `tools.test.ts` ties the auto-allow list to the tool
// definitions, so the NEXT model to appear fails here rather than in a session.
{
  for (const m of REAL) {
    const id = normaliseModel(m.resolvedModel ?? m.value)
    ok(!!MODEL_RATES[id], `${m.displayName} (${id}) has a published rate, so its spend is a total and not a floor`)
    ok(!!MODEL_WINDOWS[id], `${m.displayName} (${id}) has a context window, so the meter has a denominator`)
  }
  ok(!!MODEL_RATES['claude-fable-5'], 'Fable specifically — it was in the picker and in neither table')

  // Every rate needs a window and vice versa: one without the other is a model
  // that shows a cost with no meter, or a meter with no cost.
  for (const id of Object.keys(MODEL_RATES)) {
    ok(!!MODEL_WINDOWS[id], `${id} is priced, so it needs a window too`)
  }
  for (const id of Object.keys(MODEL_WINDOWS)) {
    ok(!!MODEL_RATES[id], `${id} has a window, so it needs a rate too`)
  }
}

// --- the COMPOSITION: what the picker actually ends up showing ---------------
//
// This section exists because of a bug that shipped. Every unit above was green
// and the picker still showed the built-in three, Fable missing, on an account
// whose CLI reports five.
//
// The cause was two functions that both knew how to fall back.
// `modelsForProfile` returned the built-in list when a profile declared no
// models of its own, and `mergeModels`' first rule is "a list the profile
// declares wins" — so the inherit profile handed it three entries, that branch
// matched, and the CLI's real answer was discarded on every refresh. Discovery
// worked perfectly; nothing ever looked at it.
//
// Neither function was wrong alone, which is exactly why testing them alone
// found nothing. So these assertions run them TOGETHER, in the order the host
// runs them.
{
  const builtin = MODELS.map((m) => ({
    ...m, efforts: [...ALL_EFFORTS], thinking: true, ultracode: false, fastMode: false,
  }))
  const declares = (models?: string[]): ProviderProfile =>
    ({ id: 'p', kind: 'inherit', ...(models ? { models } : {}) })

  /** The single call `extension.ts` makes. Testing the composition rather than
   *  its parts is the entire point of this section. */
  const compose = (profile: ProviderProfile, discovered: typeof choices) =>
    catalogueFor(profile, discovered, builtin,
      { normaliseModel, windows: MODEL_WINDOWS, windowLabel })

  const cli = compose(declares(), choices)
  ok(cli.source === 'cli',
     `a profile that declares no models must NOT outrank the CLI (got "${cli.source}")`)
  ok(cli.choices.length === choices.length,
     `so the picker shows all ${choices.length} models the CLI reported, not ${builtin.length}`)
  ok(cli.choices.some((c) => c.label === 'Fable'),
     'and Fable is in it — the bug this whole section is about')

  // The declaring case still wins, which is the behaviour that made the wrong
  // fallback look reasonable in the first place.
  const declared = compose(declares(['qwen3-coder']), choices)
  ok(declared.source === 'profile', 'a profile that DOES declare models still wins')
  ok(declared.choices.length === 1, 'and shows only what it declared')

  // And the floor still holds when there is nothing to show.
  ok(compose(declares(), []).source === 'builtin',
     'with no declaration and no CLI answer, the built-in list is the floor')
  ok(compose(declares(), []).choices.length === builtin.length, 'and it is not empty')
}

// --- endpoint models have NO capabilities until someone says so --------------
//
// The effort dial is Anthropic's reasoning effort. `deepseek-v4-pro` has no
// such dial, and the composer was showing it the full low…max picker and an
// Extended-thinking toggle anyway — controls that cannot say no, which is the
// same class of bug as a spinner over a wedged process. The endpoint's model
// list carries no capability fields, so nothing here is known-true, and the
// composer gates every capability on `=== true`: unknown renders as ABSENT,
// and the controls disappear. This section is the gate for that.
{
  const endpoint: EndpointModel[] = [
    { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', contextWindow: 161_000, rate: { input: 0.28, output: 0.42 } },
  ]
  const got = endpointChoices(endpoint, undefined, windowLabel)
  ok(got.length === 1 && got[0]!.efforts.length === 0,
     'an endpoint model is offered NO effort levels — the dial disappears')
  ok(got[0]!.thinking === false, 'and no extended-thinking toggle')
  ok(got[0]!.ultracode === false && got[0]!.fastMode === false,
     'and neither ultracode nor fast mode')
  ok(got[0]!.rate?.input === 0.28, 'while the price the endpoint DID publish still arrives')

  // A profile-declared list: capabilities come from the KNOWN match, or not at
  // all. A Bedrock id normalises to a Claude model, whose capabilities are real
  // knowledge and carry over; an id nothing knows gets none.
  const known = MODELS.map((m) => ({
    ...m, efforts: [...ALL_EFFORTS], thinking: true, ultracode: false, fastMode: false,
  }))
  const declared = modelsForProfile(
    { models: ['us.anthropic.claude-opus-5', 'deepseek-v4-pro'] },
    known, normaliseModel, MODEL_WINDOWS, windowLabel,
  )
  const opus = declared.find((c) => c.id === 'us.anthropic.claude-opus-5')
  const deepseek = declared.find((c) => c.id === 'deepseek-v4-pro')
  ok(opus?.efforts.length === ALL_EFFORTS.length && opus.thinking === true,
     'a Bedrock id that normalises to a known model keeps the model’s real capabilities')
  ok(deepseek?.efforts.length === 0 && deepseek.thinking === false,
     'an id nothing knows gets none — the controls disappear, they do not grey out')

  // And the composition the host actually runs: a gateway serving DeepSeek ends
  // in a catalogue whose choices carry no capabilities, so the composer shows
  // no dial for any of them.
  const composed = catalogueFor(
    { models: ['deepseek-v4-pro'] },
    choices, known,
    { normaliseModel, windows: MODEL_WINDOWS, windowLabel },
    undefined,
    { models: endpoint },
  )
  ok(composed.source === 'profile',
     'the declared list is in force — the endpoint serves what it declares (source: ' + composed.source + ')')
  ok(composed.choices.every((c) => c.efforts.length === 0 && c.thinking === false),
     'and every choice in it has no effort and no thinking — the composer has nothing to render')
}

// --- the ultracode read-back ------------------------------------------------
// The other half of the safety argument. The gate above stops the toggle being
// OFFERED where it cannot work; this is what happens when it was offered, the
// model can do xhigh, and workflows turn out to be off anyway — which we cannot
// see until the session exists.
{
  const TOOLS = ['Task', 'Bash', 'Read', 'Workflow', 'Write']
  const NO_WF = TOOLS.filter((t) => t !== 'Workflow')

  ok(ultracodeWarning(false, NO_WF) === undefined,
     'no ultracode requested, nothing to warn about — even with no Workflow tool')
  ok(ultracodeWarning(true, TOOLS) === undefined,
     'ultracode with the Workflow tool present says nothing')
  const warn = ultracodeWarning(true, NO_WF)
  ok(!!warn, 'ultracode WITHOUT the Workflow tool warns — the toggle would otherwise look on and do nothing')
  ok(!!warn?.includes('Workflow'), 'and names what is missing')
  ok(!!warn?.includes('xhigh'), 'while saying which half still applies, so the warning is not read as "it did nothing"')

  // Silence is not evidence. A CLI that reported no tool list tells us nothing
  // either way, and inventing a warning from that is its own kind of lying.
  ok(ultracodeWarning(true, undefined) === undefined, 'no tool list means no claim')
  ok(ultracodeWarning(true, 'not an array') === undefined, 'and neither does a malformed one')
  ok(ultracodeWarning(true, []) !== undefined,
     'but an EMPTY list is a real answer: there is no Workflow tool in it')
}

// --- THE CUSTOM ENDPOINT, which is where the picker was wrong -----------------
//
// This section is a bug report with assertions on it. A real profile, verbatim
// from a real `settings.json`:
//
//     { id: "openrouter", kind: "gateway", baseUrl: "https://api.deepseek.com/anthropic",
//       models: ["default","opus[1m]","claude-fable-5-1[1m]","sonnet","sonnet[1m]","haiku"] }
//
// Six Claude aliases declared against DeepSeek. Nobody typed them: the provider
// test read `Query.supportedModels()` — Claude Code's own list, which answers
// for Claude Code however `ANTHROPIC_BASE_URL` is pointed — offered to "use
// these models in the picker", and saved them. A declared list outranks
// everything, so the composer offered those six and nothing else, and every one
// of them fails at the first request. The owner's words: "I literally don't
// have access to it in my options."
{
  const DEEPSEEK: EndpointModel[] = [
    { id: 'deepseek-chat', label: 'DeepSeek Chat', contextWindow: 128_000, rate: { input: 0.28, output: 0.42 } },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', contextWindow: 128_000, rate: { input: 0.55, output: 2.19 } },
  ]
  const deps = { normaliseModel, windows: MODEL_WINDOWS, windowLabel }
  const builtin = MODELS.map((m) => ({ ...m, efforts: [...ALL_EFFORTS], thinking: true, ultracode: false, fastMode: false }))
  const broken = {
    models: ['default', 'opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'sonnet[1m]', 'haiku'],
  }

  // Before: nothing to check the declared list against, so it stands.
  const blind = catalogueFor(broken, [], builtin, deps)
  ok(blind.source === 'profile' && blind.choices.length === 6,
     'with no endpoint answer a declared list still wins — that rule is not what was wrong')

  // After: the endpoint has been asked, and it serves none of them.
  const healed = catalogueFor(broken, [], builtin, deps, undefined,
                              { models: DEEPSEEK, host: 'api.deepseek.com' })
  ok(healed.source === 'endpoint', 'a declared list that names NOTHING the endpoint serves is not honoured')
  ok(healed.choices.map((c) => c.id).join() === 'deepseek-chat,deepseek-reasoner',
     'the models the endpoint actually serves are offered instead')
  ok(!!healed.problem && healed.problem.includes('api.deepseek.com') && healed.problem.includes('6'),
     'and it SAYS so, naming the host and the count — a setting overruled in silence is the next surprise')
  // A menu footer, not a report. The long version — which ids, and where to fix
  // them — belongs on the settings page, where the ticks are.
  ok((healed.problem ?? '').length < 90, `and says it in one line (${(healed.problem ?? '').length} chars)`)

  // A list that selects SOME of what is served is a filter, and a filter is a
  // legitimate thing to want: nobody picks from 431 models on every message.
  const filtered = catalogueFor({ models: ['deepseek-chat'] }, [], builtin, deps, undefined,
                                { models: DEEPSEEK, host: 'api.deepseek.com' })
  ok(filtered.source === 'profile' && filtered.choices.length === 1,
     'a declared list the endpoint DOES serve is still honoured — it is how you pin two models out of 431')
  ok(!filtered.problem, 'and there is nothing to warn about')
  ok(filtered.choices[0]?.context === '128K' && filtered.choices[0]?.contextTokens === 128_000,
     "a pinned model still gets the endpoint's window — the label and the meter's denominator agree")
  ok(priceLabel(filtered.choices[0]?.rate) === '$0.28/$0.42 per Mtok',
     'and its published price, which is the whole reason the endpoint was asked')

  // Partly served: honoured, but the dead entries are called out. Silence here
  // would be a picker with a model in it that cannot work.
  const partly = catalogueFor({ models: ['deepseek-chat', 'sonnet'] }, [], builtin, deps, undefined,
                              { models: DEEPSEEK, host: 'api.deepseek.com' })
  ok(partly.source === 'profile' && !!partly.problem && partly.problem.includes('sonnet'),
     'a list that is only partly served keeps its entries and names the ones that will fail')

  // ...but names a FEW of them. A footer that lists four hundred dead ids is a
  // footer nobody reads, and the count is the part that matters.
  const manyDead = catalogueFor(
    { models: ['deepseek-chat', 'a', 'b', 'c', 'd', 'e'] }, [], builtin, deps, undefined,
    { models: DEEPSEEK, host: 'api.deepseek.com' },
  )
  ok(/\+2 more/.test(manyDead.problem ?? ''),
     `a long list of dead ids is summarised rather than printed (${manyDead.problem})`)

  // Nothing declared: the endpoint IS the list.
  const open = catalogueFor({}, [], builtin, deps, undefined, { models: DEEPSEEK, host: 'api.deepseek.com' })
  ok(open.source === 'endpoint' && open.choices.length === 2,
     'with nothing declared the endpoint\u2019s own list is what the picker shows')

  // And the ordering that is the actual fix.
  const cli = toChoices(REAL, normaliseModel, MODEL_WINDOWS, windowLabel)
  const both = catalogueFor({}, cli, builtin, deps, undefined, { models: DEEPSEEK, host: 'api.deepseek.com' })
  ok(both.source === 'endpoint',
     'the ENDPOINT outranks the CLI: `supportedModels()` describes Claude Code, not the endpoint it is pointed at')
  ok(!both.choices.some((c) => c.id === 'sonnet'),
     'so no Claude alias reaches a picker in front of a DeepSeek endpoint')

  // The floor is unchanged. An empty picker reads as a broken extension.
  ok(catalogueFor({}, [], builtin, deps, 'offline', { models: [], host: 'x' }).source === 'builtin',
     'an endpoint that answered with nothing falls through to the CLI and then the built-in list')
}

// --- what the picker SHOWS about a model ------------------------------------
//
// A list of ids is not a choice anybody can make. These two numbers are what
// turn it into one, and both are absent from the built-in tables for every
// model this extension has never heard of.
{
  ok(priceLabel(undefined) === undefined, 'no price is ABSENT — a blank says "not stated"')
  ok(priceLabel({ input: 0, output: 0 }) === 'Free',
     'while a genuine zero says Free — $0.00 for an unknown price is the mistake this avoids')
  ok(priceLabel({ input: 0.0000005, output: 10 })?.startsWith('<$0.0001') === true,
     'a price too small to write does not round to $0, which would read as free')
  ok(priceLabel({ input: 3, output: 15 }) === '$3.00/$15 per Mtok', 'and an ordinary one reads plainly')

  const one = toChoices([{ value: 'claude-opus-5' }], normaliseModel, MODEL_WINDOWS, windowLabel)[0]!
  ok(one.context === '1M' && one.contextTokens === 1_000_000,
     'the window is carried as a NUMBER as well as a label — a label cannot be measured against anything')
}

// --- the cache, which outlives the build that wrote it ----------------------
{
  const rich = [{
    id: 'deepseek-chat', label: 'DeepSeek Chat', context: '128K', contextTokens: 128_000,
    rate: { input: 0.28, output: 0.42 }, efforts: ['high'], thinking: true, ultracode: false, fastMode: false,
  }]
  const back = parseCachedChoices(JSON.parse(JSON.stringify(rich)))
  ok(back[0]?.contextTokens === 128_000 && back[0]?.rate?.input === 0.28,
     'a cached choice keeps its window and price — written on every refresh and lost on every read is the bug this repeats otherwise')

  // Written by a build before those fields existed. Not a rejection: this cache
  // is re-asked on a miss, and discarding every entry for a MISSING optional
  // would re-spawn a CLI on every launch.
  const old = parseCachedChoices([{
    id: 'claude-opus-5', label: 'Opus 5', context: '1M',
    efforts: ['high'], thinking: true, ultracode: false, fastMode: false,
  }])
  ok(old.length === 1 && old[0]?.rate === undefined,
     'an entry from an older build still reads, with the new fields simply absent')
  ok(parseCachedChoices([{ id: 'x', label: 'x', context: '1M', efforts: [], thinking: true, ultracode: false, fastMode: false, rate: { input: 1 } }])[0]?.rate === undefined,
     'but a half-written rate is dropped rather than half-applied')
}

console.log(fails ? `\n${fails} model test(s) failed` : '\nall model tests passed')
process.exit(fails ? 1 : 0)
