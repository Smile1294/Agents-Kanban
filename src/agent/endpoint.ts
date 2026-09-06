/**
 * Ask a custom endpoint what it actually serves.
 *
 * This file exists because of a bug that reached a user's `settings.json` and
 * left them unable to select a single model their endpoint serves.
 *
 * The chain was: `probeProvider` asked `Query.supportedModels()` for the model
 * list, `testProvider()` offered to save it onto the profile, and
 * `mergeModels()` gives a profile's declared list top priority. All three steps
 * are individually reasonable and the composition is nonsense, because
 * **`supportedModels()` is the CLI's own list, not the endpoint's.** It comes
 * out of Claude Code's `initialize` response, which is assembled before any API
 * request is made — so pointing `ANTHROPIC_BASE_URL` at DeepSeek and asking the
 * CLI which models are available answers `default, opus[1m], sonnet, haiku`.
 * Those got written into the profile as though DeepSeek served them, and the
 * composer then offered six Claude aliases against an endpoint that serves
 * `deepseek-chat`. Every one of them fails at the first request, with an error
 * from somebody else's system, and there is no way to pick the right one.
 *
 * The fix is to ask the only program that knows. Every Anthropic-compatible
 * endpoint people actually point this at also serves a model list:
 *
 *     OpenRouter   GET https://openrouter.ai/api/v1/models     ids, windows, PRICES
 *     Anthropic    GET https://api.anthropic.com/v1/models     ids, display names
 *     DeepSeek     GET https://api.deepseek.com/v1/models      ids
 *     Ollama       GET http://localhost:11434/v1/models        ids
 *     vLLM/LiteLLM GET <base>/v1/models                        ids, sometimes prices
 *
 * Two shapes cover all of them (`{data:[…]}` and Ollama's native
 * `{models:[…]}`), and the richer ones carry exactly what the board otherwise
 * has to say `?` to: the context window the meter measures against, and the
 * per-token price the spend figure is computed from. See `MODEL_RATES` in
 * `sessions/usage.ts` — it is keyed by Anthropic's ids and knows nothing about
 * anyone else's, which is why an off-first-party session reports `≥ $0.00`.
 *
 * Rules this file is built around:
 *
 *  - **It reports, it does not throw.** The caller is a picker and a settings
 *    page. "I could not read the list" is an answer, and it travels back in
 *    `problem` rather than being swallowed — a silent fallback is how "why is
 *    my model missing?" becomes unanswerable.
 *  - **Zero is a price, `undefined` is not a price.** OpenRouter serves free
 *    models at `"0"`, and rendering those as "unknown" is as wrong as rendering
 *    an unknown one as `$0.00`.
 *  - **Everything here is another program's output**, so every field is checked
 *    rather than cast, and a junk entry is dropped rather than rendered blank.
 */

import type { ModelRate } from '../sessions/usage.ts'

/**
 * Money, as this project counts it everywhere else: USD per MILLION tokens.
 *
 * Endpoints publish USD per token; the conversion happens here, once, so the
 * rest of the extension only ever sees one unit.
 *
 * It is `ModelRate` itself rather than a matching shape, deliberately. These
 * numbers are handed to `costOfUsage`, and two structurally identical types
 * defined in two files agree right up until one of them gains a field — at
 * which point the mismatch is a silently dropped price rather than a compile
 * error. One type, one meaning.
 */
export type EndpointRate = ModelRate

/** One model, as its own endpoint describes it. */
export interface EndpointModel {
  /** The id to pass to `query()`. Verbatim — an OpenRouter slug has a slash in
   *  it and must not be tidied. */
  id: string
  /** A human name, when the endpoint gives one that is not just the id. */
  label?: string
  description?: string
  /** Tokens. The denominator the context meter needs, from the only party that
   *  knows it for a model this extension has never heard of. */
  contextWindow?: number
  rate?: EndpointRate
}

export interface EndpointCatalogue {
  models: EndpointModel[]
  /** Which URL answered. Shown, because "it read the list from somewhere" is
   *  not a claim anyone can check. */
  url?: string
  /** Why there is no list, when there is none. Never swallowed. */
  problem?: string
}

/**
 * Where to look for a model list, given a base URL.
 *
 * A base URL for the Messages API is not necessarily the root of the OpenAI
 * routes, and the four popular endpoints disagree about it:
 *
 *     https://openrouter.ai/api          -> /api/v1/models        (first)
 *     https://api.deepseek.com/anthropic -> /anthropic/v1/models  (first, answers)
 *     http://localhost:11434             -> /v1/models            (first)
 *     https://…/v1                       -> /v1/models            (second)
 *
 * So: the documented path first, then the "base already ends in /v1" case, then
 * the host root as a last resort for a base that is a sub-path of a gateway.
 * Same host every time — a credential is never sent anywhere the profile did
 * not already name.
 */
export function modelListUrls(baseUrl: string): string[] {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) return []
  const out: string[] = [`${base}/v1/models`, `${base}/models`]
  try {
    const root = new URL(base).origin
    // Both, because the two hosts that need this fallback document different
    // paths: DeepSeek's list is `https://api.deepseek.com/models` exactly, with
    // no version segment, while everyone else's is under `/v1`. Trying one is a
    // fallback that works for half the endpoints it exists for.
    out.push(`${root}/v1/models`, `${root}/models`)
  } catch {
    // Not a URL. `validateProfile` already refuses those; nothing to add here.
  }
  return [...new Set(out)]
}

/** A number from a field that may be a number, a numeric string, or rubbish.
 *  `0` survives; anything unusable becomes undefined. */
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** USD per token -> USD per million, keeping an honest zero. */
const perMillion = (perToken: number | undefined): number | undefined =>
  perToken === undefined ? undefined : perToken * 1_000_000

/**
 * The price of one model, in the several dialects endpoints publish it in.
 *
 * OpenRouter nests it under `pricing` as per-token strings; LiteLLM puts
 * `input_cost_per_token` flat on the entry. Both are per token, so both go
 * through the same conversion.
 *
 * Returns undefined unless BOTH sides are known: a rate with one half missing
 * would price half a session and silently under-report the rest, which is worse
 * than saying nothing — `priced: false` at least renders as `≥`.
 */
export function rateOf(entry: Record<string, unknown>): EndpointRate | undefined {
  const pricing = (entry.pricing && typeof entry.pricing === 'object' && !Array.isArray(entry.pricing)
    ? entry.pricing
    : {}) as Record<string, unknown>
  const input = perMillion(num(pricing.prompt) ?? num(pricing.input) ?? num(entry.input_cost_per_token))
  const output = perMillion(num(pricing.completion) ?? num(pricing.output) ?? num(entry.output_cost_per_token))
  if (input === undefined || output === undefined) return undefined
  // A NEGATIVE price is a sentinel, not a price. OpenRouter's auto-router
  // publishes `"-1"` for "depends which model this routes to", and taking it at
  // face value renders `$-1000000/Mtok` in the picker and subtracts from the
  // spend total. Unknown is the honest reading, and unknown is expressible.
  if (input < 0 || output < 0) return undefined
  const cacheRead = perMillion(num(pricing.input_cache_read) ?? num(entry.cache_read_input_token_cost))
  const cacheWrite = perMillion(num(pricing.input_cache_write) ?? num(entry.cache_creation_input_token_cost))
  return {
    input, output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  }
}

/** How much description to keep. The whole catalogue is cached in
 *  `globalState`, OpenRouter's is 431 models with a paragraph each, and this is
 *  read on the path that builds a picker. */
const DESCRIPTION_CHARS = 240
/** How many models to keep at all. A cap rather than no cap because this is
 *  serialised into extension storage and into a webview message. */
export const MAX_MODELS = 500

/**
 * Turn a model-list response into entries, whatever shape it arrived in.
 *
 * Pure, so the whole matrix of dialects is testable without a server — which is
 * the point, because the failure this guards is silent: an unrecognised shape
 * produces an empty list, and an empty list is indistinguishable from "this
 * endpoint has no models" unless somebody asserts on the difference.
 */
export function parseModelList(body: unknown): EndpointModel[] {
  const root = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  // `data` is the OpenAI/Anthropic/OpenRouter shape; `models` is Ollama's
  // native one. Reading only one gives a working list against one endpoint and
  // a silently empty one against the next.
  const rows = Array.isArray(root.data) ? root.data
    : Array.isArray(root.models) ? root.models
    : Array.isArray(body) ? body
    : []
  const out: EndpointModel[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const e = row as Record<string, unknown>
    // Ollama's `/api/tags` calls the id `name`; everyone else calls it `id`.
    const id = [e.id, e.model, e.name, e.value]
      .find((v): v is string => typeof v === 'string' && !!v.trim())?.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)

    const display = [e.display_name, e.displayName, e.name]
      .find((v): v is string => typeof v === 'string' && !!v.trim() && v.trim() !== id)?.trim()
    const description = typeof e.description === 'string' && e.description.trim()
      // Trimmed AFTER the slice as well as before it: a cut that lands on a
      // space leaves one, and the storage parser trims — so without this the
      // value read back differs from the value written, which is a round trip
      // that does not round trip.
      ? e.description.trim().slice(0, DESCRIPTION_CHARS).trim()
      : undefined
    // `top_provider.context_length` is OpenRouter's per-provider figure and is
    // the one a request actually gets, so it wins over the model's headline.
    const top = e.top_provider && typeof e.top_provider === 'object'
      ? e.top_provider as Record<string, unknown>
      : {}
    const contextWindow = num(top.context_length)
      ?? num(e.context_length) ?? num(e.context_window) ?? num(e.contextWindow)
      ?? num(e.max_input_tokens)
    const rate = rateOf(e)

    out.push({
      id,
      ...(display ? { label: display } : {}),
      ...(description ? { description } : {}),
      ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
      ...(rate ? { rate } : {}),
    })
    if (out.length >= MAX_MODELS) break
  }
  return out
}

export interface FetchModelsOptions {
  timeoutMs?: number
  /** Injectable so the whole dialect matrix — and every way this fails — is
   *  testable without a server. */
  fetchImpl?: typeof fetch
}

/**
 * Read a custom endpoint's model catalogue.
 *
 * Tries the candidate paths in order and takes the first that parses into a
 * non-empty list. Never rejects: the answer to "what does this serve?" can be
 * "I could not tell", and that has to be renderable.
 *
 * The credential is repeated from the environment patch rather than rebuilt
 * from the profile, for the same reason `probe.ts` does it: `envForProfile` is
 * the one place that decides which header a credential goes in, and a second
 * opinion here is how the check comes to disagree with the sessions it is
 * checking.
 */
export async function fetchEndpointModels(
  baseUrl: string,
  headers: Record<string, string>,
  opts: FetchModelsOptions = {},
): Promise<EndpointCatalogue> {
  const urls = modelListUrls(baseUrl)
  if (!urls.length) return { models: [], problem: `"${baseUrl}" is not a URL.` }
  const doFetch = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 10_000
  const tried: string[] = []

  for (const url of urls) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await doFetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'application/json', 'anthropic-version': '2023-06-01', ...headers },
      })
      if (!res.ok) {
        tried.push(`${url} answered ${res.status}`)
        // A credential problem is the same on every path, so there is nothing
        // to gain from asking twice — and saying "404" when the answer was 401
        // sends someone to fix the wrong thing.
        if (res.status === 401 || res.status === 403) {
          return {
            models: [],
            problem:
              `${url} answered ${res.status}. The credential is wrong, or it is in the header this ` +
              'endpoint does not read — try the other credential style (Authorization: Bearer vs x-api-key).',
          }
        }
        continue
      }
      const models = parseModelList(await res.json())
      if (models.length) return { models, url }
      tried.push(`${url} answered 200 with no models this version can read`)
    } catch (e) {
      tried.push(
        `${url} ${e instanceof Error && e.name === 'AbortError'
          ? `did not answer within ${Math.round(timeoutMs / 1000)}s`
          : `could not be read (${e instanceof Error ? e.message : String(e)})`}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    models: [],
    problem:
      'This endpoint did not return a model list, so the models have to be typed in by hand. ' +
      `Tried: ${tried.join('; ')}.`,
  }
}

/**
 * Read a catalogue back out of extension storage.
 *
 * A separate function from `parseModelList`, deliberately, and the difference
 * is the whole reason this project has a rule about persistence: `parseModelList`
 * reads an ENDPOINT's dialect, where a price arrives as `pricing.prompt` in USD
 * per token. What we store is our own shape, already converted. Round-tripping
 * a stored catalogue through the wire parser would find no `pricing` key and
 * silently drop every price — a value written on every refresh and lost on
 * every read, which is precisely how `contextWindow` was lost for its whole
 * life. Two shapes, two parsers, and a test that writes one and reads it back.
 *
 * Same discipline as `parseCachedChoices`: `globalState` outlives the version
 * that wrote it, so this is another program's output.
 */
export function parseEndpointModels(raw: unknown): EndpointModel[] {
  if (!Array.isArray(raw)) return []
  const out: EndpointModel[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== 'string' || !e.id.trim()) continue
    const n = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
    const raw_rate = e.rate && typeof e.rate === 'object' ? e.rate as Record<string, unknown> : undefined
    const input = raw_rate ? n(raw_rate.input) : undefined
    const output = raw_rate ? n(raw_rate.output) : undefined
    const cacheRead = raw_rate ? n(raw_rate.cacheRead) : undefined
    const cacheWrite = raw_rate ? n(raw_rate.cacheWrite) : undefined
    const window = n(e.contextWindow)
    out.push({
      id: e.id.trim(),
      ...(typeof e.label === 'string' && e.label.trim() ? { label: e.label.trim() } : {}),
      ...(typeof e.description === 'string' && e.description.trim()
        ? { description: e.description.trim() } : {}),
      ...(window && window > 0 ? { contextWindow: window } : {}),
      ...(input !== undefined && output !== undefined
        ? {
            rate: {
              input, output,
              ...(cacheRead !== undefined ? { cacheRead } : {}),
              ...(cacheWrite !== undefined ? { cacheWrite } : {}),
            },
          }
        : {}),
    })
    if (out.length >= MAX_MODELS) break
  }
  return out
}
