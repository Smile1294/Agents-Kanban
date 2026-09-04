/** What a session cost, and how full its context is.
 *
 * The load-bearing case is the FIRST one. Everything else here is arithmetic
 * that would be obvious from the source; the deduplication is the thing that
 * was wrong in the obvious implementation and wrong by a factor of nearly
 * three, which is the difference between a number worth showing and a lie.
 */
import {
  CACHE_READ, CACHE_WRITE_1H, CACHE_WRITE_5M, MODEL_RATES, MODEL_WINDOWS,
  contextOfUsage, costOfUsage, normaliseModel, summariseUsage,
  type UsageMessage,
} from '../usage.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

/** An assistant frame as Claude Code writes it. */
const frame = (
  id: string,
  usage: Record<string, unknown>,
  opts: { model?: string; parent?: string } = {},
): UsageMessage => ({
  type: 'assistant',
  message: { id, model: opts.model ?? 'claude-opus-5', usage },
  parent_tool_use_id: opts.parent ?? null,
})

// ---------------------------------------------------------------------------
// 1. The one that matters: frames of the same response must be counted ONCE.
//
// While a response streams, the CLI writes one assistant record per completed
// content block and every record repeats the SAME cumulative usage for the
// whole response. Summing per record charges a three-block answer three times.
// Measured on a real 57-frame session: 21 responses, so ~2.7x too much.
const streamed: UsageMessage[] = [
  frame('msg_1', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 }),
  frame('msg_1', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 }),
  frame('msg_1', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 }),
]
const one = summariseUsage(streamed)
ok(one.responses === 1, `three frames of one response count as one response (got ${one.responses})`)
ok(one.output === 100, `and its output tokens are counted once, not three times (got ${one.output})`)
const expected = (10 * 5 + 100 * 25 + 1000 * 5 * CACHE_READ) / 1e6
ok(near(one.costUsd, expected), `priced once: $${one.costUsd.toFixed(6)} vs $${expected.toFixed(6)}`)
// The failure this guards, spelled out: had the frames been summed.
ok(one.costUsd < expected * 1.5, 'a summing implementation would be ~3x this and fails here')

// A later frame of the same response SUPERSEDES rather than adds — usage grows
// as the response completes, and the last frame is the final figure.
const growing = summariseUsage([
  frame('msg_2', { output_tokens: 50 }),
  frame('msg_2', { output_tokens: 500 }),
])
ok(growing.output === 500, `the last frame of a response wins (got ${growing.output})`)

// A frame with no id cannot be deduplicated against anything, so it counts once
// under a key of its own rather than overwriting the response before it.
const noIds = summariseUsage([
  { type: 'assistant', message: { model: 'claude-opus-5', usage: { output_tokens: 7 } } },
  { type: 'assistant', message: { model: 'claude-opus-5', usage: { output_tokens: 7 } } },
])
ok(noIds.responses === 2 && noIds.output === 14, 'id-less frames are not collapsed into each other')

// ---------------------------------------------------------------------------
// 2. Every token kind at its own rate, cache writes split by TTL.
const rate = MODEL_RATES['claude-opus-5']!
const full = costOfUsage('claude-opus-5', {
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  cache_read_input_tokens: 1_000_000,
  cache_creation_input_tokens: 2_000_000,
  cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
})!
const want = rate.input + rate.output + rate.input * CACHE_READ +
  rate.input * CACHE_WRITE_5M + rate.input * CACHE_WRITE_1H
ok(near(full, want), `a million of each kind costs $${full.toFixed(4)} (expected $${want.toFixed(4)})`)
ok(CACHE_WRITE_1H > CACHE_WRITE_5M && CACHE_READ < 1,
   'a 1h cache write costs more than a 5m one, and a read costs less than fresh input')

// The 1h TTL is what this extension's sessions actually use, and it is DOUBLE
// the input rate. Charging it at the 5m rate understates a cached agent run —
// where cache writes are most of the input — by a third.
const asWritten = costOfUsage('claude-opus-5', {
  cache_creation_input_tokens: 1_000_000,
  cache_creation: { ephemeral_1h_input_tokens: 1_000_000 },
})!
const asFlat = costOfUsage('claude-opus-5', { cache_creation_input_tokens: 1_000_000 })!
ok(near(asWritten, rate.input * CACHE_WRITE_1H), '1h cache writes are priced at 2x input')
ok(near(asFlat, rate.input * CACHE_WRITE_5M), 'an unsplit cache write falls back to the 5m rate')
ok(asWritten > asFlat, 'so the TTL split is not cosmetic — it changes the bill')

// Output tokens are the expensive ones; thinking tokens are already inside them
// and must not be added again.
const withThinking = costOfUsage('claude-opus-5', {
  output_tokens: 1000,
  output_tokens_details: { thinking_tokens: 800 },
} as Record<string, unknown>)!
ok(near(withThinking, (1000 * rate.output) / 1e6), 'thinking tokens are not double-counted on top of output')

// ---------------------------------------------------------------------------
// 3. Honesty about models with no rate. A guessed price is worse than none.
const unknown = summariseUsage([
  frame('a', { output_tokens: 1000 }),
  frame('b', { output_tokens: 1000 }, { model: 'claude-something-7' }),
])
ok(unknown.priced === false, 'an unpriced model marks the total as incomplete')
ok(unknown.unpriced.includes('claude-something-7'), 'and names it, so the rate table can be fixed')
ok(unknown.costUsd > 0, 'the known models still contribute — the total is a floor, not a blank')

// Synthetic messages never went to the API. They are free, not unpriced.
const synthetic = summariseUsage([frame('s', { output_tokens: 99 }, { model: '<synthetic>' })])
ok(synthetic.priced === true && synthetic.costUsd === 0,
   'a <synthetic> message costs nothing and does not mark the total incomplete')

// A dated snapshot is the same model at the same price as its undated alias.
ok(normaliseModel('claude-haiku-4-5-20251001') === 'claude-haiku-4-5', 'dated model ids normalise')
ok(costOfUsage('claude-haiku-4-5-20251001', { output_tokens: 1000 }) !== undefined,
   'so a dated id is priced, not reported as unknown')

// The same model, named the way each provider names it.
//
// These tables are keyed by Anthropic's ids and no other provider uses them, so
// without this a whole Bedrock or Vertex deployment reports `≥ $0.00` and a `?`
// context window — technically honest (`priced: false` IS "we do not know this
// model") and completely useless. Every form below is the same model at the same
// price as its bare id.
const SAME_MODEL: [string, string][] = [
  ['us.anthropic.claude-opus-5', 'claude-opus-5'],
  ['eu.anthropic.claude-opus-5', 'claude-opus-5'],
  ['apac.anthropic.claude-sonnet-5', 'claude-sonnet-5'],
  ['global.anthropic.claude-opus-5', 'claude-opus-5'],
  ['us-gov.anthropic.claude-opus-5', 'claude-opus-5'],
  ['anthropic.claude-sonnet-5', 'claude-sonnet-5'],
  ['us.anthropic.claude-haiku-4-5-20251001-v1:0', 'claude-haiku-4-5'],
  ['claude-sonnet-4-6@20260115', 'claude-sonnet-4-6'],
  ['claude-sonnet-4-6[1m]', 'claude-sonnet-4-6'],
  ['us.anthropic.claude-sonnet-4-6[1m]', 'claude-sonnet-4-6'],
]
for (const [provider, bare] of SAME_MODEL) {
  ok(normaliseModel(provider) === bare, `${provider} is ${bare}`)
  ok(costOfUsage(provider, { output_tokens: 1000 }) === costOfUsage(bare, { output_tokens: 1000 }),
     `and costs the same, so the provider's naming does not change the bill`)
  ok(!!MODEL_WINDOWS[normaliseModel(provider)],
     `and has a context window, so the meter has a denominator`)
}

// `us-gov` must be tried before `us`, or the GovCloud prefix half-strips to
// `-gov.anthropic.…` and stops matching anything. Alternation is first-match,
// so this is an ordering constraint in the regex rather than an accident.
ok(normaliseModel('us-gov.anthropic.claude-opus-5') === 'claude-opus-5',
   'the GovCloud prefix is stripped whole, not left as "-gov."')

// An inference-profile ARN names a profile, not a model, and the mapping lives
// in the user's AWS account. Staying unpriced is the truth; inventing a rate
// from a substring would be a confident wrong number.
const arn = 'arn:aws:bedrock:us-east-2:123456789012:application-inference-profile/opus-prod'
ok(costOfUsage(arn, { output_tokens: 1000 }) === undefined,
   'an inference-profile ARN stays unpriced rather than being guessed at')

// Every priced model needs a window, or the meter has no denominator.
for (const id of Object.keys(MODEL_RATES)) {
  ok(!!MODEL_WINDOWS[id], `${id} has a context window`)
}

// ---------------------------------------------------------------------------
// 4. Context fill: the main thread's, from its LAST response.
ok(contextOfUsage({ input_tokens: 2, cache_read_input_tokens: 80_000, cache_creation_input_tokens: 2_000, output_tokens: 500 })
   === 82_002, 'context fill is everything the model read, and excludes its output')

const threaded = summariseUsage([
  frame('m1', { input_tokens: 1, cache_read_input_tokens: 10_000, output_tokens: 10 }),
  // A subagent's own context is not the main thread's, however big it gets.
  frame('sub', { input_tokens: 1, cache_read_input_tokens: 900_000, output_tokens: 10 }, { parent: 'toolu_1' }),
  frame('m2', { input_tokens: 1, cache_read_input_tokens: 20_000, output_tokens: 10 }),
])
ok(threaded.contextTokens === 20_001,
   `context comes from the last MAIN-thread response, not the biggest subagent one (got ${threaded.contextTokens})`)
ok(threaded.responses === 3, 'but the subagent response is still counted — a Task costs real money')
ok(threaded.cacheRead === 930_000, 'and its tokens are in the totals')
ok(threaded.contextWindow === 1_000_000, 'the window comes from the model the main thread last ran on')

// Order in the file decides which response is last, not insertion into a map.
const reordered = summariseUsage([
  frame('m1', { cache_read_input_tokens: 50_000 }),
  frame('m2', { cache_read_input_tokens: 60_000 }),
  // A repeat frame of an EARLIER response must not make it the latest one.
  frame('m1', { cache_read_input_tokens: 50_000 }),
])
ok(reordered.contextTokens === 60_000,
   `a late repeat frame of an earlier response does not become the newest (got ${reordered.contextTokens})`)

// ---------------------------------------------------------------------------
// 5. Nothing to total is not an error.
const empty = summariseUsage([])
ok(empty.costUsd === 0 && empty.contextTokens === 0 && empty.priced === true, 'an empty session totals to zero')
const userOnly = summariseUsage([{ type: 'user', message: { content: 'hi' }, parent_tool_use_id: null }])
ok(userOnly.responses === 0, 'user messages carry no usage and are skipped')
const noUsage = summariseUsage([{ type: 'assistant', message: { id: 'x', model: 'claude-opus-5' } }])
ok(noUsage.responses === 0, 'an assistant frame without usage is skipped rather than counted as free')

console.log(fails ? `\n${fails} FAILED` : '\nall usage tests passed')
process.exit(fails ? 1 : 0)
