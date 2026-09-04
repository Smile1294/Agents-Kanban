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
}

/**
 * USD per million tokens, base rates only.
 *
 * Deliberately two numbers per model rather than five. The cache rates are
 * fixed MULTIPLES of the input rate, so deriving them means a price change is
 * one edit and the ratios can never drift out of step with each other.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
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
  'claude-opus-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-haiku-4-5': 200_000,
}

/** Messages the CLI generates itself — a cancellation notice, a hook's output.
 *  They never went to the API, so they cost nothing and must not be reported as
 *  a model whose price is unknown. */
export const SYNTHETIC_MODEL = '<synthetic>'

/**
 * Reduce a model id to the one the price table is keyed by.
 *
 * Dated snapshots (`claude-haiku-4-5-20251001`) are the same model at the same
 * price as the undated alias, and the CLI writes whichever form it was invoked
 * with. Matching only the exact string made a perfectly ordinary session
 * unpriced.
 */
export function normaliseModel(model: string): string {
  return model.replace(/-\d{8}$/, '')
}

/** What one assistant message cost, or `undefined` if the model has no rate. */
export function costOfUsage(model: string, usage: TokenUsage): number | undefined {
  if (model === SYNTHETIC_MODEL) return 0
  const rate = MODEL_RATES[normaliseModel(model)]
  if (!rate) return undefined
  // The split is authoritative when present. When it is not, the flat total is
  // charged at the 5-minute rate, which is the CLI's default TTL — and the
  // cheaper of the two, so an unknown split under-reports rather than over.
  const split = usage.cache_creation
  const write1h = split?.ephemeral_1h_input_tokens ?? 0
  const write5m = split
    ? (split.ephemeral_5m_input_tokens ?? 0)
    : (usage.cache_creation_input_tokens ?? 0)
  const dollars =
    (usage.input_tokens ?? 0) * rate.input +
    (usage.output_tokens ?? 0) * rate.output +
    (usage.cache_read_input_tokens ?? 0) * rate.input * CACHE_READ +
    write5m * rate.input * CACHE_WRITE_5M +
    write1h * rate.input * CACHE_WRITE_1H
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
export function summariseUsage(messages: readonly UsageMessage[]): UsageTotals {
  /** The last frame seen for each response id, main thread or subagent. */
  const responses = new Map<string, { model: string; usage: TokenUsage; main: boolean; seq: number }>()
  let seq = 0
  for (const m of messages) {
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
    const cost = costOfUsage(r.model, r.usage)
    if (cost === undefined) unpriced.add(r.model || 'unknown')
    else totals.costUsd += cost
    if (r.main && (!lastMain || r.seq > lastMain.seq)) lastMain = r
  }

  if (lastMain) {
    totals.contextTokens = contextOfUsage(lastMain.usage)
    if (lastMain.model) {
      totals.model = lastMain.model
      const window = MODEL_WINDOWS[normaliseModel(lastMain.model)]
      if (window) totals.contextWindow = window
    }
  }
  if (unpriced.size) {
    totals.priced = false
    totals.unpriced = [...unpriced].sort()
  }
  return totals
}
