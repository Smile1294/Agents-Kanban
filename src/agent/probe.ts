/**
 * Check a provider profile before trusting it with a session.
 *
 * Why this exists: everything in `providers.ts` writes environment variables
 * and hopes. The first thing that can contradict it is the CLI, and the first
 * time that normally happens is three minutes into an agent run, as a 401 or a
 * 400 phrased by somebody else's gateway. By then a worktree exists, a card
 * exists, and the user has no way to connect the error to a field they typed.
 *
 * The CLI half costs nothing. `query()` spawns the CLI and completes an
 * `initialize` control request BEFORE any prompt is read — and that response
 * already carries the account (hence `apiProvider`) and the model list. So the
 * probe hands `query()` a prompt iterable that never yields, asks its two
 * questions, and aborts. No message is sent to any model, so there is no token
 * to bill and no rate limit to consume. Measured against a real CLI: ~460ms.
 *
 * But that half alone OVERCLAIMS, and this was found by running it rather than
 * by any test. Pointed at `http://127.0.0.1:1`, where nothing is listening, the
 * CLI initialised happily and reported `firstParty` — because at that moment it
 * has not made a single API request and has no idea the endpoint is dead. The
 * probe said "Connected", and every agent run afterwards would have failed. A
 * check that cannot come back bad is exactly what this project forbids.
 *
 * So a gateway profile — the only kind whose endpoint is ours to test — is
 * checked for real, in the two cheap steps that between them cover what goes
 * wrong:
 *
 *  1. **Is anything listening?** A TCP connect to the host and port. Free,
 *     instant, and it catches the overwhelmingly common failure: the proxy is
 *     not running, or is on a different port.
 *  2. **Does it speak the Anthropic Messages API, and does the credential
 *     work?** One `POST /v1/messages` with `max_tokens: 1`, which is the
 *     verification request the gateway documentation itself prescribes. The
 *     status is the answer: `401`/`403` means reachable but the credential (or
 *     the header it was put in) is wrong, `404` means reachable but not serving
 *     the Messages API at that path. Costs a single token, and only when the
 *     credential is accepted.
 *
 * For the cloud kinds the endpoint belongs to the provider and authentication
 * runs through their SDK chain, so the probe confirms which backend was
 * SELECTED and says so in exactly those words — it does not claim the
 * credential works, because it has not asked.
 *
 * It reports rather than throws. "Could not reach it" is the answer to the
 * question being asked, not an exceptional condition.
 */
import { withSilentQuery, ConnectError, type ConnectOptions } from './connect.ts'
import { reconcileProvider, resolvedLabel, type ProviderProfile, type ProviderEnv } from './providers.ts'

export interface ProbeResult {
  ok: boolean
  /** One line, ready to show. Always set. */
  message: string
  /** `AccountInfo.apiProvider` — the backend the CLI actually resolved. */
  resolved?: string
  /** Where the credential came from, as the CLI sees it. Worth showing: it is
   *  how "my key is ignored because I am still logged in" becomes visible. */
  apiKeySource?: string
  /** Model ids this backend offers, if it said. The honest source for a picker
   *  on a provider whose ids we cannot know. */
  models?: string[]
  /** True when the CLI answered but on a different backend than asked for. */
  mismatch?: boolean
  /** HTTP status from the endpoint check, when one ran. */
  status?: number
}

/**
 * The credential headers to repeat when testing a gateway ourselves.
 *
 * Read back out of the environment patch rather than taken from the profile, so
 * there is exactly one place that decides which header a credential goes in —
 * `envForProfile`. Doing it again here is how the probe would come to disagree
 * with the sessions it is meant to be testing.
 */
function credentialHeaders(set: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (set.ANTHROPIC_AUTH_TOKEN) out.authorization = `Bearer ${set.ANTHROPIC_AUTH_TOKEN}`
  if (set.ANTHROPIC_API_KEY) out['x-api-key'] = set.ANTHROPIC_API_KEY
  for (const line of (set.ANTHROPIC_CUSTOM_HEADERS ?? '').split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return out
}

/** What a gateway's endpoint said when asked. `reachable: false` means nothing
 *  answered on the port at all, which is a different fix from a 401. */
export interface EndpointCheck {
  reachable: boolean
  status?: number
  message: string
  ok: boolean
}

/**
 * Ask a gateway's base URL whether it is there and whether it will have us.
 *
 * Two steps, because they have different fixes and lumping them together is how
 * "it does not work" stays unactionable: nothing listening means start your
 * proxy or fix the port, a `401` means the credential is wrong or is in the
 * wrong header.
 *
 * `fetchImpl` and `connect` are injectable so the whole matrix of answers can be
 * tested without a server — this is the one part of the probe that has to
 * behave correctly on failures nobody can conveniently reproduce.
 */
export async function checkEndpoint(
  baseUrl: string,
  headers: Record<string, string>,
  opts: {
    timeoutMs?: number
    fetchImpl?: typeof fetch
    connect?: (port: number, host: string, timeoutMs: number) => Promise<boolean>
  } = {},
): Promise<EndpointCheck> {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return { reachable: false, ok: false, message: `"${baseUrl}" is not a URL.` }
  }
  const timeoutMs = opts.timeoutMs ?? 8_000

  // Step 1: is anything there? Free, and the common case.
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  const connect = opts.connect ?? (async (p, h, t) => {
    const { isListening } = await import('../run/recipe.ts')
    return isListening(p, h, t)
  })
  if (!(await connect(port, url.hostname, Math.min(timeoutMs, 2_000)))) {
    return {
      reachable: false, ok: false,
      message:
        `Nothing is listening on ${url.hostname}:${port}. ` +
        'Start the proxy or gateway first, or correct the port.',
    }
  }

  // Step 2: does it speak the Anthropic Messages API, and will it take this
  // credential? The request the gateway documentation itself prescribes.
  const doFetch = opts.fetchImpl ?? fetch
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/messages`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await doFetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', ...headers },
      // One token. `max_tokens: 1` and a single character, so a success costs
      // essentially nothing and a failure costs nothing at all.
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
      }),
    })
    const status = res.status
    if (status === 401 || status === 403) {
      return {
        reachable: true, ok: false, status,
        message:
          `${url.hostname}:${port} answered ${status}. The credential is wrong, or it is in the ` +
          'header this gateway does not read — try the other credential style ' +
          '(Authorization: Bearer vs x-api-key).',
      }
    }
    if (status === 404) {
      return {
        reachable: true, ok: false, status,
        message:
          `${url.hostname}:${port} is there but has no /v1/messages. The base URL is probably ` +
          'missing a path segment, or this is not an Anthropic-format endpoint.',
      }
    }
    if (status >= 500) {
      return {
        reachable: true, ok: false, status,
        message: `${url.hostname}:${port} answered ${status}. The gateway reached its upstream and it failed.`,
      }
    }
    // 400 counts as a pass: the endpoint understood the request well enough to
    // object to it, which usually means the model id is not one it serves — a
    // real answer from a real Anthropic-format endpoint.
    return {
      reachable: true, ok: true, status,
      message: status === 200
        ? `${url.hostname}:${port} answered and accepted the credential.`
        : `${url.hostname}:${port} is serving the Messages API (answered ${status}).`,
    }
  } catch (e) {
    const why = e instanceof Error && e.name === 'AbortError'
      ? `did not answer within ${Math.round(timeoutMs / 1000)}s`
      : `could not be reached (${e instanceof Error ? e.message : String(e)})`
    return { reachable: true, ok: false, message: `${url.hostname}:${port} ${why}.` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Connect with this profile's environment and report what the CLI resolved.
 *
 * `timeoutMs` is a real requirement rather than defensive habit: a base URL
 * pointing at a host that silently drops packets does not fail, it hangs, and a
 * "Test connection" button that never returns is worse than none.
 */
export async function probeProvider(
  profile: ProviderProfile,
  env: ProviderEnv,
  opts: ConnectOptions & {
    /** Injectable for tests; see `checkEndpoint`. */
    fetchImpl?: typeof fetch
    connect?: (port: number, host: string, timeoutMs: number) => Promise<boolean>
  } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000
  try {
    const { info, ids } = await withSilentQuery(env, { ...opts, timeoutMs }, async (q, race) => {
      const account = await race(q.accountInfo?.()) as
        { apiProvider?: string; apiKeySource?: string } | undefined
      // Best effort, and caught separately: an older CLI may answer the account
      // question and not this one, and losing the model list must not turn a
      // successful probe into a failure.
      const models = await race(q.supportedModels?.()).catch(() => undefined) as
        { value?: string }[] | undefined
      return {
        info: account,
        ids: Array.isArray(models)
          ? models.map((m) => m?.value).filter((v): v is string => typeof v === 'string' && !!v)
          : undefined,
      }
    })

    const resolved = info?.apiProvider

    // The CLI accepted the configuration. That is ALL it means at this point —
    // it has made no API request, so it cannot know whether the endpoint exists.
    // A gateway is therefore checked for real before anything is claimed.
    let endpoint: EndpointCheck | undefined
    if (profile.kind === 'gateway' && profile.baseUrl?.trim()) {
      endpoint = await checkEndpoint(profile.baseUrl.trim(), credentialHeaders(env.set), {
        timeoutMs: Math.min(timeoutMs, 8_000),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.connect ? { connect: opts.connect } : {}),
      })
      if (!endpoint.ok) {
        return {
          ok: false,
          message: endpoint.message,
          ...(resolved ? { resolved } : {}),
          ...(endpoint.status ? { status: endpoint.status } : {}),
        }
      }
    }

    const credential = info?.apiKeySource && info.apiKeySource !== 'none'
      ? ` Credential: ${info.apiKeySource}.` : ''
    const modelNote = ids?.length ? ` ${ids.length} models available.` : ''

    if (!resolved) {
      return {
        ok: true,
        message:
          (endpoint?.message ? endpoint.message + ' ' : '') +
          'Claude Code accepted the configuration. This CLI did not report which ' +
          'provider it is on, which older versions do not.' + credential + modelNote,
        ...(info?.apiKeySource ? { apiKeySource: info.apiKeySource } : {}),
        ...(ids?.length ? { models: ids } : {}),
        ...(endpoint?.status ? { status: endpoint.status } : {}),
      }
    }

    const { ok, message } = reconcileProvider(profile, resolved)
    return {
      ok,
      message: !ok
        ? message ?? `Claude Code is on ${resolvedLabel(resolved)}, which is not what this profile asked for.`
        : endpoint
          // The endpoint answered, so this is the one case where "it works" is
          // a claim we have actually tested.
          ? endpoint.message + credential + modelNote
          // For a cloud backend the endpoint and the credentials are the
          // provider's. We know which one was SELECTED; we have not asked it
          // anything, and saying "connected" would be inventing the part that
          // matters.
          : `Claude Code is configured for ${resolvedLabel(resolved)}.` + credential + modelNote +
            ' The first request will confirm the credentials.',
      resolved,
      ...(info?.apiKeySource ? { apiKeySource: info.apiKeySource } : {}),
      ...(ids?.length ? { models: ids } : {}),
      ...(endpoint?.status ? { status: endpoint.status } : {}),
      ...(ok ? {} : { mismatch: true }),
    }
  } catch (e) {
    // ConnectError already reads as an answer ("no claude on PATH", "no answer
    // within 20s"); anything else is passed through as-is.
    return { ok: false, message: e instanceof ConnectError || e instanceof Error ? e.message : String(e) }
  }
}
