/**
 * What a session cost, and how full its context is — both derived from the
 * token counts Claude Code already writes into its own transcript.
 *
 * Why this file exists at all: the board used to learn both numbers ONLY from
 * the live run. Context fill came from the `usage` event, spend came from the
 * `total_cost_usd` on the result message, and neither is written anywhere we
 * can read again. So restarting VS Code — or just selecting a session that
 * finished before the window opened — showed no context meter and no spend,
 * because the only copy of both numbers died with the extension host.
 *
 * The transcript, however, keeps every `message.usage` forever. Context fill is
 * the last assistant message's input side; spend is every message's usage
 * priced at the published per-model rates. Both survive a restart, and both
 * cover turns this extension never saw (a session someone continued in a
 * terminal), which the live-only numbers never could.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not invent a cost when it does not know the rate. An unknown model
 *    sets `priced: false` and lands in `unpriced`, and the view says "at least"
 *    rather than showing a confident number that is missing a model's spend.
 *  - It does not claim to beat the CLI's own `total_cost_usd`. That figure is
 *    authoritative — it comes from the service that did the billing — but it
 *    exists only at the END of a turn, only for turns this extension watched,
 *    and is written nowhere. So the board shows this arithmetic, which covers
 *    every turn and climbs while one is running, and `AgentSession.settleTurn`
 *    checks it against the bill each time one lands: a disagreement means the
 *    rates below have moved, and it says so in the output channel.
 */

/** The usage object Claude Code records on an assistant message. */
export interface TokenUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** Cache writes split by TTL. They are priced differently, so when this is
   *  present it is used in preference to the flat `cache_creation_input_tokens`. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
}

/** Published price of a model, in USD per million tokens. */
export interface ModelRate {
  input: number
  output: number
  /** Absolute per-million cache rates, when the vendor publishes them instead
   *  of Anthropic's fixed multiples. Anthropic's are derived (see
   *  `CACHE_READ`); OpenRouter states them per model, and one router's cache
   *  discount is not another's. Absent means "derive them". */
  cacheRead?: number
  cacheWrite?: number
}

/**
 * What a model costs and how big its window is, for models these tables cannot
 * know about.
 *
 * `MODEL_RATES` and `MODEL_WINDOWS` are keyed by Anthropic's ids and no other
 * vendor uses them, so every session on a custom endpoint reported `≥ $0.00`
 * against a meter with no denominator — honest, because `priced: false` IS
 * "unknown model", and useless. The endpoint itself publishes both: OpenRouter
 * states an exact per-token price and a context length for all 431 of its
 * models. `agent/endpoint.ts` reads them; this is where they arrive.
 *
 * Keyed by the id EXACTLY as the endpoint spells it. `normaliseModel` exists to
 * strip Anthropic's provider decorations, and `deepseek/deepseek-chat-v3.1` is
 * not a decorated Anthropic id — running it through would be inventing a
 * relationship between two strings that have none.
 */
export interface ModelFacts {
  rate?: ModelRate
  contextWindow?: number
}
export type ModelBook = Readonly<Record<string, ModelFacts>>

/**
 * USD per million tokens, base rates only.
 *
 * Deliberately two numbers per model rather than five. The cache rates are
 * fixed MULTIPLES of the input rate, so deriving them means a price change is
 * one edit and the ratios can never drift out of step with each other.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  // Fable is the expensive one, and it was MISSING here while the picker
  // offered it — so every Fable session reported `≥ $0.00` and a `?` window.
  // A model the picker can select and this table cannot price is the gap
  // `models.test.ts` now ties shut: every model in its real-CLI fixture must
  // have a rate and a window here.
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  // List price. This read 2/10 — Sonnet 5's introductory rate, which ran
  // through 2026-08-31 and has since lapsed, so every Sonnet session was
  // under-reported by a third. A dated price in an undated table goes wrong
  // silently on a specific day; `settleTurn`'s comparison against the CLI's
  // own `total_cost_usd` is what would eventually have said so.
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
}

/** Cache writes cost more than fresh input; cache reads cost a tenth of it.
 *  The 5-minute and 1-hour TTLs are priced differently and the transcript
 *  records which was used, so both are carried rather than averaged. */
export const CACHE_WRITE_5M = 1.25
export const CACHE_WRITE_1H = 2
export const CACHE_READ = 0.1

/**
 * The context window per model, for sessions with no live run to ask.
 *
 * A LAST RESORT, and the least trustworthy number here. The window a run
 * actually gets is the one the SDK reports on its result message, and it can be
 * smaller than the model's maximum — a compaction policy can pin a 1M model to
 * 200K. So the order of preference is: the live run, then the window this
 * session last reported (persisted in the sidecar), then this table.
 */
export const MODEL_WINDOWS: Record<string, number> = {
  'claude-fable-5': 1_000_000,
  'claude-mythos-5': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
}

/** Messages the CLI generates itself — a cancellation notice, a hook's output.
 *  They never went to the API, so they cost nothing and must not be reported as
 *  a model whose price is unknown. */
export const SYNTHETIC_MODEL = '<synthetic>'

/**
 * Reduce a model id to the one the price and window tables are keyed by.
 *
 * Dated snapshots (`claude-haiku-4-5-20251001`) are the same model at the same
 * price as the undated alias, and the CLI writes whichever form it was invoked
 * with. Matching only the exact string made a perfectly ordinary session
 * unpriced.
 *
 * The same is true, harder, off first-party. The tables above are keyed by
 * Anthropic's ids, and no other provider uses them:
 *
 *     us.anthropic.claude-haiku-4-5-20251001-v1:0   Bedrock, cross-region profile
 *     global.anthropic.claude-opus-5                Bedrock, global profile
 *     anthropic.claude-sonnet-5                     Bedrock Mantle
 *     claude-sonnet-4-6@20260115                    Vertex
 *     claude-sonnet-4-6[1m]                         a pinned 1M-window variant
 *
 * Every one of those is the same model at the same price as its bare id, so
 * without this a whole Bedrock deployment reported `≥ $0.00` and a `?` context
 * window — technically honest, since `priced: false` is exactly what "we do not
 * know this model" means, and completely useless. The prefixes are stripped
 * rather than the table being duplicated per provider, because five copies of a
 * price list is five things to forget when a price moves.
 *
 * `[1m]` maps to the base model deliberately. The 1M window carries a premium
 * above 200K tokens that these two-number rates cannot express, so the estimate
 * runs low on a long session — but low-by-a-known-mechanism is better than a
 * total that gives up, and `settleTurn` already compares every turn against the
 * CLI's own `total_cost_usd` and says so when the gap exceeds 20%.
 *
 * What is deliberately NOT unwrapped is an inference-profile ARN
 * (`arn:aws:bedrock:…:application-inference-profile/…`). It names a profile, not
 * a model, and the mapping lives in the user's AWS account — so it stays
 * unpriced, which is the truth.
 */
export function normaliseModel(model: string): string {
  return model
    // Bedrock cross-region inference profile prefix, then the vendor segment.
    // `us-gov` before `us` is not an accident: alternation is first-match.
    .replace(/^(us-gov|global|apac|us|eu|jp|au)\./, '')
    .replace(/^anthropic\./, '')
    // Bedrock foundation-model version suffix.
    .replace(/-v\d+:\d+$/, '')
    // A pinned 1M-window variant, and Vertex's `@`-dated form.
    .replace(/\[1m\]$/i, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '')
}

/**
 * The rate for a model: what its own endpoint published, else the built-in table.
 *
 * The book is consulted by EXACT id first and only then through
 * `normaliseModel`, and the order is load-bearing. An endpoint id
 * (`deepseek/deepseek-chat-v3.1`) is not an Anthropic id with decoration on it,
 * so normalising it can only produce a string that means nothing; but a
 * gateway serving Claude under a normalisable id should still match. Exact,
 * then normalised, then the table — most specific first.
 */
export function rateFor(model: string, book?: ModelBook): ModelRate | undefined {
  return book?.[model]?.rate ?? book?.[normaliseModel(model)]?.rate ?? MODEL_RATES[normaliseModel(model)]
}

/** The context window for a model, from the same three sources in the same
 *  order. The denominator the meter measures against when no live run has
 *  reported one. */
export function windowFor(model: string, book?: ModelBook): number | undefined {
  return book?.[model]?.contextWindow
    ?? book?.[normaliseModel(model)]?.contextWindow
    ?? MODEL_WINDOWS[normaliseModel(model)]
}

/** What one assistant message cost, or `undefined` if the model has no rate. */
export function costOfUsage(model: string, usage: TokenUsage, book?: ModelBook): number | undefined {
  if (model === SYNTHETIC_MODEL) return 0
  const rate = rateFor(model, book)
  if (!rate) return undefined
  // The split is authoritative when present. When it is not, the flat total is
  // charged at the 5-minute rate, which is the CLI's default TTL — and the
  // cheaper of the two, so an unknown split under-reports rather than over.
  const split = usage.cache_creation
  const write1h = split?.ephemeral_1h_input_tokens ?? 0
  const write5m = split
    ? (split.ephemeral_5m_input_tokens ?? 0)
    : (usage.cache_creation_input_tokens ?? 0)
  /* Anthropic's cache rates are fixed MULTIPLES of the input rate, so they are
     derived; another vendor's are whatever that vendor says, so an explicit one
     wins. OpenRouter, for instance, prices a cache read at a tenth on some
     models and at the full input rate on others — deriving there would be
     making the number up. */
  const readRate = rate.cacheRead ?? rate.input * CACHE_READ
  const write5mRate = rate.cacheWrite ?? rate.input * CACHE_WRITE_5M
  const write1hRate = rate.cacheWrite ?? rate.input * CACHE_WRITE_1H
  const dollars =
    (usage.input_tokens ?? 0) * rate.input +
    (usage.output_tokens ?? 0) * rate.output +
    (usage.cache_read_input_tokens ?? 0) * readRate +
    write5m * write5mRate +
    write1h * write1hRate
  return dollars / 1_000_000
}

/**
 * How much of the window this message was holding when it was produced.
 *
 * Everything the model READ, which is fresh input plus both kinds of cached
 * input — a cache hit still occupies the window, it is only cheaper. Output is
 * excluded: it becomes part of the next request's input, and counting it here
 * would double it.
 */
export function contextOfUsage(usage: TokenUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

/**
 * The context window this run actually has, out of the result chunk's
 * `modelUsage` — which has one entry PER MODEL THE SESSION USED, not one.
 *
 * That plural is the bug this function exists for. Claude Code runs background
 * tasks (session title generation) on a haiku-class model, so a Fable or Opus
 * session's map contains that model too — and measured against a real CLI its
 * 200K entry comes FIRST in iteration order. The old code took the first entry
 * with a window, so every 1M session's meter was measured against Haiku's
 * denominator: a Fable session read `172k/200k (86%)` while filling a 1M
 * window it was nowhere near.
 *
 * So the entry is chosen by MATCHING THE MAIN MODEL, with both sides put
 * through `normaliseModel` — the map is keyed by forms like
 * `claude-opus-5[1m]` while the assistant frames say `claude-opus-5`, and the
 * suffix must not break the match.
 *
 * No match returns undefined rather than a guess. The caller keeps its previous
 * value, and downstream falls back to the sidecar's remembered window and then
 * the table — all of which are honest, where "some other model's window" is
 * not. This is why the signature takes the model rather than defaulting: there
 * is no safe entry to pick without knowing whose meter this is.
 */
export function mainWindowOf(
  modelUsage: Record<string, { contextWindow?: number }> | undefined,
  mainModel: string | undefined,
): number | undefined {
  if (!modelUsage || !mainModel) return undefined
  const want = normaliseModel(mainModel)
  for (const [key, mu] of Object.entries(modelUsage)) {
    if (mu?.contextWindow && normaliseModel(key) === want) return mu.contextWindow
  }
  return undefined
}

/** The shape `summariseUsage` reads. Structurally what the SDK's
 *  `getSessionMessages` returns, so it can be handed the raw array. */
export interface UsageMessage {
  type: string
  message?: unknown
  parent_tool_use_id?: string | null
}

export interface UsageTotals {
  /** How full the main thread's context was at the last assistant message. */
  contextTokens: number
  /** The window that fill is measured against, if a model said which. */
  contextWindow?: number
  /** The model the main thread last ran on. */
  model?: string
  /** Every token this session has been billed for, by kind. */
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  /** What those tokens cost at published rates. */
  costUsd: number
  /** False when a model in this session has no rate, so `costUsd` is a FLOOR
   *  rather than a total. The view must say so. */
  priced: boolean
  /** The models that had no rate, for the tooltip and for a bug report. */
  unpriced: string[]
  /** How many API responses were counted. The denominator behind the number,
   *  and the thing to look at when a total looks wrong. */
  responses: number
}

export function emptyTotals(): UsageTotals {
  return {
    contextTokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0,
    costUsd: 0, priced: true, unpriced: [], responses: 0,
  }
}

/**
 * Total a session's usage from its transcript.
 *
 * The one thing that makes this correct rather than roughly 2.7x too big:
 * **frames of the same response are deduplicated by `message.id`.** While a
 * response streams, the CLI writes one assistant record per completed content
 * block, and every one of them repeats the SAME cumulative `usage` for the
 * whole response. Summing per record charged a three-block answer three times
 * over. Measured on a real session: 57 assistant records, 21 responses.
 *
 * Subagent frames (`parent_tool_use_id` set) are counted in the COST — a Task's
 * tokens are billed like any others — but never in the context fill, because a
 * subagent's context is its own and the meter is about the main thread's.
 */
export function summariseUsage(messages: readonly UsageMessage[], book?: ModelBook): UsageTotals {
  /** The last frame seen for each response id, main thread or subagent. */
  const responses = new Map<string, { model: string; usage: TokenUsage; main: boolean; seq: number }>()
  let seq = 0
  for (const m of messages) {
    /* A compaction resets the context, so everything before it is no longer IN
       the window. The live path resets explicitly for this; the disk path could
       not even see the boundary until `readTranscript` began asking for system
       messages. Only the FILL is reset — the spend before a compaction was
       still spent, so the priced responses are kept. */
    if (m.type === 'system' && (m as { subtype?: unknown }).subtype === 'compact_boundary') {
      for (const [k, r] of responses) if (r.main) responses.set(k, { ...r, main: false })
      continue
    }
    if (m.type !== 'assistant') continue
    const body = m.message as { id?: unknown; model?: unknown; usage?: TokenUsage } | undefined
    const usage = body?.usage
    if (!usage) continue
    const model = typeof body?.model === 'string' ? body.model : ''
    // A response with no id cannot be deduplicated against anything, so it is
    // keyed by its position and counted once — which is what it is.
    const id = typeof body?.id === 'string' && body.id ? body.id : `@${seq}`
    // A repeat frame supersedes the usage but keeps the response's ORIGINAL
    // position. Re-dating it would let a trailing frame of an earlier response
    // pose as the newest one, and the context meter would then be drawn from a
    // response that is not the last thing the model said.
    const seen = responses.get(id)
    responses.set(id, { model, usage, main: !m.parent_tool_use_id, seq: seen ? seen.seq : seq })
    seq++
  }

  const totals = emptyTotals()
  const unpriced = new Set<string>()
  let lastMain: { model: string; usage: TokenUsage; seq: number } | undefined
  for (const r of responses.values()) {
    totals.responses++
    totals.input += r.usage.input_tokens ?? 0
    totals.output += r.usage.output_tokens ?? 0
    totals.cacheWrite += r.usage.cache_creation_input_tokens ?? 0
    totals.cacheRead += r.usage.cache_read_input_tokens ?? 0
    const cost = costOfUsage(r.model, r.usage, book)
    if (cost === undefined) unpriced.add(r.model || 'unknown')
    else totals.costUsd += cost
    if (r.main && (!lastMain || r.seq > lastMain.seq)) lastMain = r
  }

  if (lastMain) {
    totals.contextTokens = contextOfUsage(lastMain.usage)
    if (lastMain.model) {
      totals.model = lastMain.model
      const window = windowFor(lastMain.model, book)
      if (window) totals.contextWindow = window
    }
  }
  if (unpriced.size) {
    totals.priced = false
    totals.unpriced = [...unpriced].sort()
  }
  return totals
}
