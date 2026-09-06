/* Asking a custom endpoint what it serves.
 *
 * The bug this file guards reached a real `settings.json` and left its owner
 * unable to select a single model their endpoint serves. The chain:
 *
 *   1. `probeProvider` read the model list from `Query.supportedModels()`.
 *   2. `testProvider` offered to save it onto the profile.
 *   3. `mergeModels` gives a profile's declared list top priority.
 *
 * Every step defensible, the composition nonsense — because `supportedModels()`
 * is CLAUDE CODE's list and stays Claude Code's list however
 * `ANTHROPIC_BASE_URL` is pointed. A DeepSeek profile ended up declaring
 * `default, opus[1m], claude-fable-5-1[1m], sonnet, sonnet[1m], haiku`, and the
 * composer offered exactly those six against an endpoint that serves
 * `deepseek-chat`.
 *
 * So the list has to come from the endpoint. The assertions below are the
 * dialects it comes back in — including a real 431-model OpenRouter payload's
 * awkward parts — and every way the ask can fail, because "I could not read it"
 * has to be an answer rather than an empty list nobody can explain.
 */
import {
  fetchEndpointModels, modelListUrls, parseEndpointModels, parseModelList, rateOf,
} from '../endpoint.ts'
import { costOfUsage } from '../../sessions/usage.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// --- where to look ----------------------------------------------------------
//
// A Messages-API base URL is not necessarily the root of the OpenAI routes, and
// the popular endpoints disagree about it. Reading one path gives a working
// list against one endpoint and a silently empty one against the next.
{
  ok(modelListUrls('https://openrouter.ai/api')[0] === 'https://openrouter.ai/api/v1/models',
     'OpenRouter: the documented path is tried first')
  ok(modelListUrls('https://api.deepseek.com/anthropic')[0] === 'https://api.deepseek.com/anthropic/v1/models',
     'DeepSeek: the Anthropic sub-path is tried first — it answers there')
  ok(modelListUrls('https://api.deepseek.com/anthropic').includes('https://api.deepseek.com/v1/models'),
     'and the host root is a fallback for a base that is a sub-path')
  ok(modelListUrls('https://api.deepseek.com/anthropic').includes('https://api.deepseek.com/models'),
     "including the root WITHOUT a version segment — DeepSeek's own documented list endpoint is exactly that, and trying only /v1 is a fallback that works for half the endpoints it exists for")
  ok(modelListUrls('https://openrouter.ai/api/').every((u) => !u.includes('//v1')),
     'a trailing slash does not double the separator')
  ok(new Set(modelListUrls('http://localhost:11434')).size === modelListUrls('http://localhost:11434').length,
     'no duplicates — a base that is already the root must not be asked twice')
  ok(modelListUrls('   ').length === 0, 'an empty base URL has nowhere to look')
  ok(modelListUrls('not a url').length > 0, 'and a malformed one still tries, rather than throwing')

  // The credential travels with these, so they must never leave the host the
  // profile named.
  const host = (u: string) => new URL(u).host
  ok(modelListUrls('https://api.deepseek.com/anthropic').every((u) => host(u) === 'api.deepseek.com'),
     'every candidate stays on the host the profile named — a credential goes nowhere else')
}

// --- the dialects -----------------------------------------------------------
{
  const anthropic = parseModelList({
    data: [{ type: 'model', id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-01-01' }],
  })
  ok(anthropic[0]?.id === 'claude-opus-5' && anthropic[0]?.label === 'Claude Opus 5',
     'Anthropic: `data[].display_name` is the label')

  const openai = parseModelList({
    object: 'list',
    data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' }],
  })
  ok(openai.length === 1 && openai[0]?.id === 'deepseek-chat', 'OpenAI/DeepSeek: ids only, and that is fine')
  ok(openai[0]?.label === undefined, 'no invented label — the id is shown when there is nothing better')

  const ollama = parseModelList({ models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }] })
  ok(ollama[0]?.id === 'qwen3:8b', "Ollama's native `models[].name` is read too — one shape is not enough")

  const litellm = parseModelList({
    data: [{ id: 'gpt-5.1', max_input_tokens: 400_000, input_cost_per_token: 0.00000125, output_cost_per_token: 0.00001 }],
  })
  ok(litellm[0]?.contextWindow === 400_000, 'LiteLLM: `max_input_tokens` is a window')
  ok(litellm[0]?.rate?.input === 1.25 && litellm[0]?.rate?.output === 10,
     'and its flat per-token costs become USD per million')
}

// --- prices, which are the part that is easy to get wrong --------------------
{
  // USD per TOKEN in, USD per MILLION out. One conversion, in one place.
  ok(rateOf({ pricing: { prompt: '0.00000055', completion: '0.00000165' } })?.input === 0.55,
     "a per-token string becomes a per-million number (OpenRouter's own format)")

  // Zero is a price. 22 of OpenRouter's 431 models are free.
  const free = rateOf({ pricing: { prompt: '0', completion: '0' } })
  ok(free !== undefined && free.input === 0 && free.output === 0,
     'a free model has a price of zero, not an unknown price')

  // And a negative is NOT a price. OpenRouter's auto-router publishes "-1" for
  // "depends where this routes", and taking it at face value renders
  // `$-1000000/Mtok` and SUBTRACTS from the session total.
  ok(rateOf({ pricing: { prompt: '-1', completion: '-1' } }) === undefined,
     'a negative price is a sentinel, not a price — unknown is the honest reading')

  // Half a price would price half a session and silently under-report the rest.
  ok(rateOf({ pricing: { prompt: '0.000001' } }) === undefined, 'a price with one side missing is no price')
  ok(rateOf({}) === undefined, 'and an entry with no pricing at all is no price')

  // Cache rates are per model on a router, not a fixed multiple of input.
  const cached = rateOf({ pricing: { prompt: '0.00001', completion: '0.00005', input_cache_read: '0.000001' } })
  ok(cached?.cacheRead === 1, 'an explicitly published cache-read rate is carried')

  // ...and it must actually reach the arithmetic, or carrying it is decoration.
  const million = { cache_read_input_tokens: 1_000_000 }
  ok(costOfUsage('x', million, { x: { rate: { input: 10, output: 50, cacheRead: 1 } } }) === 1,
     'a published cache rate is what a cache read costs')
  ok(costOfUsage('x', million, { x: { rate: { input: 10, output: 50 } } }) === 1,
     "and without one, Anthropic's fixed tenth is derived instead")
}

// --- junk in, usable list out ----------------------------------------------
// Every field here is another program's output.
{
  const junk = parseModelList({ data: [null, 3, {}, { id: '' }, { id: '  ' }, { id: 'ok' }, { id: 'ok' }] })
  ok(junk.length === 1 && junk[0]?.id === 'ok', 'unusable entries are dropped and duplicates collapse')
  ok(parseModelList(null).length === 0, 'a null body is an empty list, not a throw')
  ok(parseModelList({ data: 'nope' }).length === 0, 'and so is a body whose `data` is not a list')
  ok(parseModelList([{ id: 'bare' }]).length === 1, 'a bare array is read too — some servers return one')
  ok(parseModelList({ data: [{ id: 'x', context_length: -5 }] })[0]?.contextWindow === undefined,
     'a negative window is not a window')
  ok(parseModelList({ data: [{ id: 'x', name: 'x' }] })[0]?.label === undefined,
     'a "name" that just repeats the id is not a label')
}

// --- what is stored is what comes back --------------------------------------
//
// The rule this project has a postmortem for: a value written on every refresh
// and missing from the parse is lost for the life of the field. `contextWindow`
// was exactly that once. Two shapes need two parsers — the wire format prices
// in `pricing.prompt` per token, the stored one in `rate.input` per million —
// and reading one with the other's parser drops every price in silence.
{
  const wire = parseModelList({
    data: [{
      id: 'deepseek/deepseek-chat-v3.1', name: 'DeepSeek: DeepSeek V3.1',
      description: 'A large hybrid reasoning model.',
      context_length: 161_000,
      pricing: { prompt: '0.00000055', completion: '0.00000165', input_cache_read: '0.00000055' },
    }],
  })
  const stored = parseEndpointModels(JSON.parse(JSON.stringify(wire)))
  ok(JSON.stringify(stored) === JSON.stringify(wire), 'a catalogue written to storage reads back identical')
  ok(stored[0]?.rate?.input === 0.55, 'including the PRICE, which the wire parser would have dropped')
  ok(stored[0]?.contextWindow === 161_000, 'and the window')

  ok(parseEndpointModels('nonsense').length === 0, 'a cache this build cannot read is empty, never a throw')
  ok(parseEndpointModels([{ id: 'x', rate: { input: 1 } }])[0]?.rate === undefined,
     'a half-written rate from an older build is dropped rather than half-applied')
  ok(parseEndpointModels([{ id: 'x', rate: { input: 0, output: 0 } }])[0]?.rate?.input === 0,
     'while a genuine zero survives the round trip — free is not missing')
}

// --- asking, and every way it fails -----------------------------------------
{
  const reply = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300, status, json: async () => body,
  }) as unknown as Response

  {
    const seen: string[] = []
    const models = await fetchEndpointModels('https://openrouter.ai/api', {}, {
      fetchImpl: (async (url: string) => {
        seen.push(String(url))
        return reply({ data: [{ id: 'a/b' }] })
      }) as unknown as typeof fetch,
    })
    ok(models.models.length === 1, 'the first path that answers is the answer')
    ok(seen.length === 1, 'and nothing else is asked once one has')
    ok(models.url === 'https://openrouter.ai/api/v1/models', 'which URL answered is reported, not assumed')
  }

  {
    // The path that 404s is not the failure — the NEXT one may serve it.
    const models = await fetchEndpointModels('https://api.deepseek.com/anthropic', {}, {
      fetchImpl: (async (url: string) => (String(url).includes('/anthropic/')
        ? reply({}, 404)
        : reply({ data: [{ id: 'deepseek-chat' }] }))) as unknown as typeof fetch,
    })
    ok(models.models[0]?.id === 'deepseek-chat', 'a 404 moves on to the next candidate')
  }

  {
    // A credential problem is the same on every path, so asking twice only
    // wastes time — and reporting "404" when the answer was 401 sends someone
    // to fix the wrong thing.
    let calls = 0
    const out = await fetchEndpointModels('https://x.test', {}, {
      fetchImpl: (async () => { calls++; return reply({}, 401) }) as unknown as typeof fetch,
    })
    ok(calls === 1, 'a 401 stops immediately rather than retrying every path')
    ok(!out.models.length && /credential/i.test(out.problem ?? ''), 'and says the credential is the problem')
    ok(/Bearer|x-api-key/.test(out.problem ?? ''),
       'naming both header styles, because a right key in the wrong header is the usual cause')
  }

  {
    const out = await fetchEndpointModels('https://x.test', {}, {
      fetchImpl: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    })
    ok(!out.models.length, 'an unreachable endpoint yields no models')
    ok(/ECONNREFUSED/.test(out.problem ?? ''), 'and the reason survives — a silent fallback is the actual bug')
  }

  {
    const out = await fetchEndpointModels('https://x.test', {}, {
      fetchImpl: (async () => reply({ data: [] })) as unknown as typeof fetch,
    })
    ok(/did not return a model list/.test(out.problem ?? ''),
       'an endpoint that answers with nothing readable SAYS so, rather than looking like an endpoint with no models')
  }

  {
    // The credential is repeated verbatim, in whichever header the caller chose.
    let headers: Record<string, string> = {}
    await fetchEndpointModels('https://x.test', { authorization: 'Bearer sk-test' }, {
      fetchImpl: (async (_u: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>
        return reply({ data: [{ id: 'x' }] })
      }) as unknown as typeof fetch,
    })
    ok(headers.authorization === 'Bearer sk-test', 'the credential is sent as given')
    ok(headers['anthropic-version'] === '2023-06-01',
       'with the version header an Anthropic-format endpoint expects')
  }
}

console.log(fails ? `\n${fails} endpoint test(s) failed` : '\nall endpoint tests passed')
process.exit(fails ? 1 : 0)
