/**
 * Which model backend an agent session talks to.
 *
 * The thing to understand first: **this extension does not talk to a model API
 * at all.** It spawns the Claude Code CLI and the CLI talks to the provider. So
 * "provider support" here is not an API client per vendor, the way it is in
 * Cline or Continue — every backend Claude Code can reach is selected by
 * ENVIRONMENT VARIABLES on that child process, and `AgentSession` already has
 * exactly one seam for those: `AgentSessionOptions.env`.
 *
 * That makes this file a pure reducer — a profile in, an environment patch out —
 * and it is deliberately the only place that knows a variable name. Everything
 * else (settings, the picker, the commands) moves `ProviderProfile` objects
 * around and never assembles an environment itself.
 *
 * Two things are load-bearing and neither is visible to the type system.
 *
 * **`inherit` is the default, and it writes nothing.** `agentEnv()` spreads
 * `process.env`, so somebody whose shell already exports
 * `CLAUDE_CODE_USE_BEDROCK=1` is *already* running agents on Bedrock today,
 * before this file existed. A default that forced first-party Anthropic would
 * silently break every working enterprise setup the moment they updated — so
 * the default profile is "whatever the environment already says", and only an
 * explicit choice overrides it.
 *
 * **An explicit choice CLEARS the variables it does not set.** This is the
 * non-obvious half. Provider selection is a set of independent flags, not one
 * field: with `CLAUDE_CODE_USE_BEDROCK=1` in the ambient environment, selecting
 * a gateway profile and setting `ANTHROPIC_BASE_URL` produces a session that is
 * *still on Bedrock*, because nothing turned the flag off. The board would then
 * name a provider the CLI is not using, which is the failure this whole feature
 * has to avoid. So `envForProfile()` returns `clear` alongside `set`, listing
 * every provider-steering variable this profile does not own, and `agentEnv()`
 * drops them from the child's environment entirely. `undefined` is expressible
 * in the SDK's `Options.env`, so a dropped key is genuinely absent rather than
 * set to an empty string a future CLI might read as true.
 *
 * What `clear` deliberately does NOT cover is the ambient credential chain —
 * `AWS_PROFILE`, `AWS_REGION`, `GOOGLE_APPLICATION_CREDENTIALS` and friends.
 * Those are inputs to the provider's own SDK, they are how Bedrock and Vertex
 * are *meant* to authenticate, and clearing them would break the documented
 * setup. The line is: this file owns which backend and where it is, not who you
 * are to your cloud.
 *
 * Support tiers are stated rather than implied, because they are not equal.
 * Anthropic supports Claude Code on first-party, Bedrock, Vertex, Foundry and
 * Claude Platform on AWS, and supports pointing it at a gateway that speaks the
 * Anthropic Messages format. It explicitly does **not** support routing Claude
 * Code to non-Claude models through any gateway. That path works — a community
 * translation proxy in front of Ollama, OpenRouter or vLLM is a real thing
 * people run — but it is nobody's supported configuration, and a picker that
 * listed it beside Bedrock with no distinction would be lying by omission.
 */

/** How a profile decides which backend to use. */
export type ProviderKind =
  /** Change nothing: the CLI reads the environment the editor was started in. */
  | 'inherit'
  /** Anthropic's own API — a subscription login, or a Console key. */
  | 'anthropic'
  /** Amazon Bedrock, through the AWS SDK credential chain. */
  | 'bedrock'
  /** Google Cloud's Agent Platform (formerly Vertex AI). */
  | 'vertex'
  /** Microsoft Foundry. */
  | 'foundry'
  /** Claude Platform on AWS — Anthropic's API, billed through AWS Marketplace. */
  | 'anthropicAws'
  /** Anything serving the Anthropic Messages API at a URL: an enterprise LLM
   *  gateway, a self-hosted proxy, or a community translation proxy in front of
   *  a local model. One kind, because to the CLI they are one thing. */
  | 'gateway'

/**
 * How well supported a kind is, said out loud.
 *
 * Not decoration. `community` means "this works, and if it breaks that is
 * between you and your proxy" — the UI shows it, so the choice is informed
 * rather than discovered later from a 400.
 */
export type SupportTier = 'first-party' | 'cloud' | 'gateway' | 'community'

/** One field a kind needs from the user. `secret: true` never reaches settings. */
export interface ProviderField {
  key: keyof ProviderProfile & string
  label: string
  placeholder?: string
  /** Refuse to start a session without it. */
  required?: boolean
  /** Held in VS Code's SecretStorage, keyed by profile id — never in settings. */
  secret?: boolean
  detail?: string
}

export interface ProviderKindDef {
  kind: ProviderKind
  label: string
  /** One line, shown under the name in the picker. */
  blurb: string
  support: SupportTier
  /** Where the real documentation is, so the UI never has to paraphrase it. */
  docs: string
  fields: ProviderField[]
}

/**
 * A named backend the user can switch to.
 *
 * Flat on purpose: it is stored verbatim in `agentsKanban.providers`, and a flat
 * record is what a person can reasonably hand-edit in `settings.json` and what
 * a schema can describe. The credential is the one thing NOT here — see
 * `credentialKey()`.
 */
export interface ProviderProfile {
  /** Stable, referenced by `agentsKanban.provider` and by the secret's key. */
  id: string
  /** What the picker shows. Falls back to the kind's label when empty. */
  label?: string
  kind: ProviderKind

  // --- endpoint -------------------------------------------------------------
  /** `ANTHROPIC_BASE_URL` for a gateway; the per-provider override otherwise. */
  baseUrl?: string
  /** Microsoft Foundry resource name, when `baseUrl` is not given. */
  resource?: string

  // --- cloud placement ------------------------------------------------------
  /** `AWS_REGION` (Bedrock) or `CLOUD_ML_REGION` (Vertex). */
  region?: string
  /** `ANTHROPIC_VERTEX_PROJECT_ID`. */
  projectId?: string
  /** `ANTHROPIC_BEDROCK_REGION_PREFIX` — `us`, `eu`, `apac`, `jp`, `au`, `global`. */
  regionPrefix?: string
  /** `ANTHROPIC_AWS_WORKSPACE_ID`, for Claude Platform on AWS. */
  workspaceId?: string

  // --- credential -----------------------------------------------------------
  /**
   * Which header the credential goes in, for a gateway.
   *
   * Not cosmetic: `ANTHROPIC_AUTH_TOKEN` sends `Authorization: Bearer`,
   * `ANTHROPIC_API_KEY` sends `x-api-key`. A credential in the wrong one reaches
   * the gateway in a header it does not read and comes back 401, which is the
   * single most common way a correct key looks like a wrong key.
   */
  authStyle?: 'bearer' | 'apiKey'
  /**
   * True when the credential lives in SecretStorage under `credentialKey(id)`.
   *
   * A flag rather than the value, so the profile stays safe to serialise. It
   * exists at all so the UI can say "no credential set" without unlocking the
   * keychain on every repaint.
   */
  hasCredential?: boolean
  /** Read the credential from this environment variable instead of the keychain.
   *  The zero-configuration path for anyone whose shell already has it. */
  credentialFromEnv?: string

  // --- pass-through ---------------------------------------------------------
  /** Extra headers, as `ANTHROPIC_CUSTOM_HEADERS`. */
  headers?: Record<string, string>
  /**
   * The gateway signs and authenticates upstream itself, so the CLI should send
   * no SigV4 signature or key of its own.
   */
  gatewayAuth?: boolean
  /**
   * Stop sending Anthropic's experimental `anthropic-beta` header values.
   *
   * The documented fix for `Unexpected value(s) for the anthropic-beta header`,
   * which is what most translation proxies return on a stock Claude Code
   * request. Off by default because it costs features when it is not needed.
   */
  disableBetas?: boolean
  /** Turn off the CLI's non-essential traffic, as the gateway docs advise. */
  disableNonessentialTraffic?: boolean

  // --- what the board should believe ---------------------------------------
  /**
   * Model ids to offer in the picker instead of the built-in Claude ones.
   *
   * Needed because the built-in list is wrong off first-party: Bedrock wants
   * `us.anthropic.claude-opus-5`, and behind a router serving Qwen the Claude
   * ids mean nothing at all.
   */
  models?: string[]
  /**
   * Context window for this profile's models, when we cannot know it.
   *
   * The context meter needs a denominator. `MODEL_WINDOWS` only knows Claude's,
   * so without this a self-hosted model shows a fill with nothing to measure it
   * against. Last resort: a live run's reported window still wins.
   */
  contextWindow?: number
  /** Anything else, verbatim. The escape hatch, so an unforeseen variable never
   *  requires a new release. */
  env?: Record<string, string>
}

/**
 * Every variable that can steer which backend the CLI uses, or where it is, or
 * what credential it presents to it.
 *
 * One list, because it is the *clear* set: an explicit profile drops everything
 * here that it does not itself set. Adding a variable to a kind without adding
 * it here is the drift that produces a hybrid session — Bedrock's flag still on
 * behind a gateway's URL — so the test asserts every value any kind emits is
 * either in this list or deliberately exempt.
 *
 * Exempt on purpose, and this is the whole subtlety: the ambient credential
 * chain. `AWS_PROFILE`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SESSION_TOKEN`,
 * `GOOGLE_APPLICATION_CREDENTIALS`, `GCLOUD_PROJECT` and the rest are how
 * Bedrock and Vertex are *documented* to authenticate. They belong to the
 * user's cloud tooling, not to us, and clearing them would break the supported
 * setup in the name of tidiness.
 *
 * The line that decides membership: a variable is here if it changes WHICH
 * BACKEND is used, WHERE it is, or WHAT CREDENTIAL TRAVELS TO IT. That last
 * clause is why `ANTHROPIC_API_KEY` is cleared — left set, it is a live key
 * sent to a gateway it was not issued for — and why `ANTHROPIC_PROFILE` and
 * `CLAUDE_CODE_OAUTH_TOKEN` are not: they select a LOCAL credential store for
 * first-party auth, nothing leaves the machine because of them, and clearing
 * them would log someone out of a working setup for no gain — an explicit
 * profile's own flags already outrank a first-party login.
 */
export const PROVIDER_VARS: readonly string[] = [
  // Which backend.
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_MANTLE',
  // Where it is.
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_BEDROCK_MANTLE_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_RESOURCE',
  'ANTHROPIC_AWS_BASE_URL',
  // Who we are to it. Cleared WITH the endpoint: a token left over from another
  // provider is worse than no token, because it is a live credential sent to a
  // host it was not issued for.
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN',
  'ANTHROPIC_AWS_API_KEY',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'AWS_BEARER_TOKEN_BEDROCK',
  // "The gateway authenticates upstream, not me."
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH',
  'CLAUDE_CODE_SKIP_MANTLE_AUTH',
  // Placement that means nothing outside one backend.
  'CLOUD_ML_REGION',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'ANTHROPIC_BEDROCK_REGION_PREFIX',
  // Headers can carry a provider's auth, so they are provider state too.
  'ANTHROPIC_CUSTOM_HEADERS',
  // Protocol shims. Left set from a previous profile, these quietly cost
  // features on a backend that did not need them.
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
]

/** Variables that belong to the user's cloud tooling and are never cleared.
 *  Documentation, and the thing `providers.test.ts` checks the clear set
 *  against, so "tidying up" one of these fails a test instead of a deployment. */
export const AMBIENT_CREDENTIAL_VARS: readonly string[] = [
  'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CONFIG_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
]

const CRED_FIELD_BEARER: ProviderField = {
  key: 'hasCredential',
  label: 'Credential',
  secret: true,
  detail: 'Sent as Authorization: Bearer, or as x-api-key if you pick that style.',
}

/**
 * The kinds, with the questions each one actually needs answered.
 *
 * `fields` drives both the quick-input flow and the settings documentation, so a
 * new kind cannot ship with a form that forgets one of its own variables.
 */
export const PROVIDER_KINDS: ProviderKindDef[] = [
  {
    kind: 'inherit',
    label: 'Inherit from environment',
    blurb: 'Whatever the CLI already resolves. Changes nothing.',
    support: 'first-party',
    docs: 'https://code.claude.com/docs/en/env-vars',
    fields: [],
  },
  {
    kind: 'anthropic',
    label: 'Anthropic API',
    blurb: 'Your Claude subscription, or a Console API key.',
    support: 'first-party',
    docs: 'https://code.claude.com/docs/en/authentication',
    fields: [
      { ...CRED_FIELD_BEARER, label: 'API key', detail: 'Leave empty to use the login `claude` already has.' },
    ],
  },
  {
    kind: 'bedrock',
    label: 'Amazon Bedrock',
    blurb: 'Claude on AWS, through your AWS credentials.',
    support: 'cloud',
    docs: 'https://code.claude.com/docs/en/amazon-bedrock',
    fields: [
      { key: 'region', label: 'AWS region', placeholder: 'us-east-1', detail: 'Leave empty to use your AWS profile’s region.' },
      { key: 'regionPrefix', label: 'Inference profile prefix', placeholder: 'us, eu, apac, jp, au, global' },
      { key: 'baseUrl', label: 'Bedrock endpoint override', placeholder: 'https://bedrock-runtime.us-east-1.amazonaws.com' },
      { ...CRED_FIELD_BEARER, label: 'Bedrock API key', detail: 'Optional. Leave empty to use the AWS SDK credential chain (profile, SSO, instance role).' },
    ],
  },
  {
    kind: 'vertex',
    label: 'Google Cloud Agent Platform',
    blurb: 'Claude on GCP (formerly Vertex AI), through your gcloud credentials.',
    support: 'cloud',
    docs: 'https://code.claude.com/docs/en/google-vertex-ai',
    fields: [
      { key: 'projectId', label: 'GCP project id', required: true, placeholder: 'my-project' },
      { key: 'region', label: 'Region', required: true, placeholder: 'us-east5, or global' },
      { key: 'baseUrl', label: 'Endpoint override', placeholder: 'https://…' },
    ],
  },
  {
    kind: 'foundry',
    label: 'Microsoft Foundry',
    blurb: 'Claude on Azure.',
    support: 'cloud',
    docs: 'https://code.claude.com/docs/en/microsoft-foundry',
    fields: [
      { key: 'baseUrl', label: 'Foundry base URL', placeholder: 'https://my-resource.services.ai.azure.com/anthropic' },
      { key: 'resource', label: 'Resource name', placeholder: 'my-resource', detail: 'Required if you leave the base URL empty.' },
      { ...CRED_FIELD_BEARER, label: 'API key or Entra token' },
    ],
  },
  {
    kind: 'anthropicAws',
    label: 'Claude Platform on AWS',
    blurb: 'Anthropic’s API, billed through AWS Marketplace.',
    support: 'cloud',
    docs: 'https://code.claude.com/docs/en/claude-platform-on-aws',
    fields: [
      { key: 'workspaceId', label: 'Workspace id', required: true },
      { key: 'region', label: 'AWS region', placeholder: 'us-east-1' },
      { key: 'baseUrl', label: 'Endpoint override', placeholder: 'https://aws-external-anthropic.us-east-1.api.aws' },
      { ...CRED_FIELD_BEARER, label: 'Workspace API key' },
    ],
  },
  {
    kind: 'gateway',
    label: 'Custom endpoint or gateway',
    blurb: 'Anything serving the Anthropic Messages API: OpenRouter, Ollama, llama.cpp, vLLM, an enterprise gateway, or a translation proxy in front of something that only speaks OpenAI.',
    support: 'gateway',
    docs: 'https://code.claude.com/docs/en/llm-gateway-connect',
    fields: [
      { key: 'baseUrl', label: 'Base URL', required: true, placeholder: 'http://localhost:3456' },
      CRED_FIELD_BEARER,
      { key: 'models', label: 'Model ids', detail: 'Comma separated. What this endpoint actually serves.' },
      { key: 'contextWindow', label: 'Context window', placeholder: '200000', detail: 'So the context meter has a denominator.' },
    ],
  },
]

export function kindDef(kind: ProviderKind): ProviderKindDef {
  return PROVIDER_KINDS.find((k) => k.kind === kind) ?? PROVIDER_KINDS[0]!
}

/** The profile every install starts on: change nothing, break nothing. */
export const INHERIT_PROFILE: ProviderProfile = {
  id: 'inherit',
  label: 'Inherit from environment',
  kind: 'inherit',
}

/** SecretStorage key for a profile's credential. Namespaced, because the store
 *  is shared with every other thing this extension might ever keep. */
export function credentialKey(profileId: string): string {
  return `agentsKanban.provider.${profileId}.credential`
}

/**
 * Popular setups, pre-filled.
 *
 * A preset is only a factory for a `ProviderProfile` — it adds no code path, so
 * it cannot behave differently from a profile you typed yourself. That is the
 * point: the list can name what people actually run without the honesty of the
 * `support` tier depending on which entry they picked.
 *
 * The `community` ones all need a translation proxy running separately, because
 * Claude Code speaks the Anthropic Messages API and these models do not. That is
 * stated in `needs`, and shown.
 */
export interface ProviderPreset {
  id: string
  label: string
  /** What the user has to have running or installed first, if anything. */
  needs?: string
  profile: Omit<ProviderProfile, 'id'>
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic API',
    profile: { label: 'Anthropic', kind: 'anthropic' },
  },
  {
    id: 'bedrock',
    label: 'Amazon Bedrock',
    profile: { label: 'Bedrock', kind: 'bedrock', region: 'us-east-1' },
  },
  {
    id: 'vertex',
    label: 'Google Cloud Agent Platform',
    needs: 'A GCP project with Claude models enabled, and gcloud credentials on this machine (`gcloud auth application-default login`).',
    profile: { label: 'Vertex', kind: 'vertex', region: 'us-east5' },
  },
  {
    id: 'foundry',
    label: 'Microsoft Foundry',
    needs: 'A Microsoft Foundry resource serving Claude, and either its base URL or its resource name.',
    profile: { label: 'Foundry', kind: 'foundry' },
  },
  {
    id: 'anthropic-aws',
    label: 'Claude Platform on AWS',
    needs: 'A Claude Platform workspace subscribed through AWS Marketplace, and its workspace id.',
    profile: { label: 'Claude on AWS', kind: 'anthropicAws' },
  },
  // ---------------------------------------------------------------------
  // Direct — these serve the Anthropic Messages API themselves
  //
  // This group used to say "(via proxy)" and point at localhost:3456. That was
  // true when it was written and is not any more: OpenRouter, Ollama,
  // llama.cpp and vLLM have all added a native `/v1/messages` endpoint, so
  // Claude Code talks to them directly. Telling someone to install and run a
  // translation proxy they no longer need is worse than saying nothing — it is
  // an afternoon of setup for a problem that was fixed upstream.
  //
  // `disableBetas` stays on for all of them. They RE-IMPLEMENT the Anthropic
  // API rather than being it, so the `anthropic-beta` header is the thing they
  // are most likely to reject, and that failure (`Unexpected value(s) for the
  // anthropic-beta header`) is the single most common way one of these looks
  // broken. Off by default is recoverable; on by default is a support thread.
  // ---------------------------------------------------------------------
  {
    id: 'openrouter',
    label: 'OpenRouter',
    needs:
      'An OpenRouter API key. No proxy: OpenRouter serves an Anthropic-compatible ' +
      '/v1/messages endpoint, so Claude Code talks to it directly. Set the model ids to the ' +
      'OpenRouter slugs you want (`anthropic/claude-sonnet-4.5`, `openai/gpt-5.1`, …).',
    profile: {
      label: 'OpenRouter', kind: 'gateway',
      // `/api`, not `/api/v1`. Claude Code's SDK appends `/v1/messages` itself,
      // so the `/v1` that OpenRouter's OpenAI-compatible base URL carries would
      // be doubled — a 404 that reads as "OpenRouter is down".
      baseUrl: 'https://openrouter.ai/api',
      // Bearer, and this is not a preference: OpenRouter authenticates with
      // `Authorization: Bearer`, which is what ANTHROPIC_AUTH_TOKEN sends.
      // ANTHROPIC_API_KEY sends `x-api-key`, so a correct key in that variable
      // is a 401 that looks like a bad key. `envForProfile` drops the other
      // variable entirely, which is what OpenRouter's own docs ask for when
      // they say to blank ANTHROPIC_API_KEY out.
      authStyle: 'bearer',
      disableBetas: true, disableNonessentialTraffic: true,
    },
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    needs:
      'Ollama running locally. No proxy — recent Ollama serves the Anthropic Messages API ' +
      'itself. The credential is ignored but must not be empty; `ollama` is what their docs use.',
    profile: {
      label: 'Ollama', kind: 'gateway',
      baseUrl: 'http://localhost:11434',
      authStyle: 'bearer',
      disableBetas: true, disableNonessentialTraffic: true,
      contextWindow: 128_000,
    },
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp (local)',
    needs:
      '`llama-server` running locally. No proxy — llama.cpp serves /v1/messages natively, ' +
      'converting to its own pipeline internally. Any non-empty credential will do.',
    profile: {
      label: 'llama.cpp', kind: 'gateway',
      baseUrl: 'http://127.0.0.1:8080',
      authStyle: 'bearer',
      disableBetas: true, disableNonessentialTraffic: true,
      contextWindow: 128_000,
    },
  },
  {
    id: 'vllm',
    label: 'vLLM / self-hosted',
    needs:
      'Your own vLLM server. No proxy — vLLM serves /v1/messages alongside its OpenAI routes. ' +
      'One caveat worth knowing: the RUST frontend (VLLM_USE_RUST_FRONTEND=1) does not serve ' +
      'that route, so this needs the Python one.',
    profile: {
      label: 'Self-hosted', kind: 'gateway',
      baseUrl: 'http://localhost:8000',
      authStyle: 'bearer',
      disableBetas: true, disableNonessentialTraffic: true,
      contextWindow: 128_000,
    },
  },
  {
    id: 'cloudflare-ai-gateway',
    label: 'Cloudflare AI Gateway',
    needs: 'A Cloudflare AI Gateway with an Anthropic provider configured.',
    profile: {
      label: 'Cloudflare AI Gateway', kind: 'gateway',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic',
      authStyle: 'apiKey',
    },
  },

  // ---------------------------------------------------------------------
  // Translators — for a server that only speaks the OpenAI format
  //
  // Still needed, but for a much narrower case than before: an endpoint with
  // no Anthropic route of its own. If yours is in the group above, you do not
  // want these.
  // ---------------------------------------------------------------------
  {
    id: 'litellm',
    label: 'LiteLLM proxy (translator)',
    needs:
      'A LiteLLM proxy you run, with its Anthropic-format endpoint enabled. Only needed for a ' +
      'backend that serves no /v1/messages route of its own.',
    profile: {
      label: 'LiteLLM', kind: 'gateway',
      baseUrl: 'http://localhost:4000', authStyle: 'bearer',
      disableNonessentialTraffic: true,
    },
  },
  {
    id: 'claude-code-router',
    label: 'claude-code-router (translator)',
    needs:
      'claude-code-router running locally. Translates Anthropic requests to the OpenAI format, ' +
      'with per-task routing. Only needed for a backend with no Anthropic route of its own.',
    profile: {
      label: 'Router', kind: 'gateway',
      baseUrl: 'http://localhost:3456', authStyle: 'bearer',
      disableBetas: true, disableNonessentialTraffic: true,
    },
  },
]

/** The environment patch a profile amounts to. */
export interface ProviderEnv {
  /** Variables to set on the child. */
  set: Record<string, string>
  /** Variables to DROP from the inherited environment. See the file header:
   *  without this, an ambient provider flag survives the switch. */
  clear: string[]
}

/** `Name: Value` pairs, newline separated — the shape `ANTHROPIC_CUSTOM_HEADERS`
 *  wants. Empty names and values are skipped rather than emitted broken. */
export function serialiseHeaders(headers: Record<string, string> | undefined): string {
  if (!headers) return ''
  return Object.entries(headers)
    .filter(([k, v]) => k.trim() && typeof v === 'string' && v.trim())
    .map(([k, v]) => `${k.trim()}: ${v.trim()}`)
    .join('\n')
}

/**
 * Turn a profile into an environment patch.
 *
 * Pure and total: it never throws and never reads the real environment, so it
 * can be tested exhaustively and so the same profile always produces the same
 * patch. `secret` is passed in rather than looked up, which is what lets the
 * profile itself stay safe to write into `settings.json`.
 *
 * `base` is only consulted for `credentialFromEnv` — the "my shell already has
 * the token" path — and is optional so tests need not fake an environment.
 */
export function envForProfile(
  profile: ProviderProfile,
  secret?: string,
  base: Record<string, string | undefined> = {},
): ProviderEnv {
  // Inherit is the identity. Not a special case bolted on: it is the whole
  // reason the default install behaves exactly as it did before this file.
  if (profile.kind === 'inherit') return { set: {}, clear: [] }

  const set: Record<string, string> = {}
  const credential = (secret?.trim() || (profile.credentialFromEnv ? base[profile.credentialFromEnv]?.trim() : '') || '')

  switch (profile.kind) {
    case 'anthropic': {
      // Nothing identifies first-party — it is the CLI's default, and the point
      // of selecting it explicitly is to CLEAR another provider's flags.
      if (credential) set.ANTHROPIC_API_KEY = credential
      break
    }
    case 'bedrock': {
      set.CLAUDE_CODE_USE_BEDROCK = '1'
      if (profile.region?.trim()) set.AWS_REGION = profile.region.trim()
      if (profile.regionPrefix?.trim()) set.ANTHROPIC_BEDROCK_REGION_PREFIX = profile.regionPrefix.trim()
      if (profile.baseUrl?.trim()) set.ANTHROPIC_BEDROCK_BASE_URL = profile.baseUrl.trim()
      if (credential) set.AWS_BEARER_TOKEN_BEDROCK = credential
      if (profile.gatewayAuth) set.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
      break
    }
    case 'vertex': {
      set.CLAUDE_CODE_USE_VERTEX = '1'
      if (profile.projectId?.trim()) set.ANTHROPIC_VERTEX_PROJECT_ID = profile.projectId.trim()
      if (profile.region?.trim()) set.CLOUD_ML_REGION = profile.region.trim()
      if (profile.baseUrl?.trim()) set.ANTHROPIC_VERTEX_BASE_URL = profile.baseUrl.trim()
      if (profile.gatewayAuth) set.CLAUDE_CODE_SKIP_VERTEX_AUTH = '1'
      break
    }
    case 'foundry': {
      set.CLAUDE_CODE_USE_FOUNDRY = '1'
      if (profile.baseUrl?.trim()) set.ANTHROPIC_FOUNDRY_BASE_URL = profile.baseUrl.trim()
      if (profile.resource?.trim()) set.ANTHROPIC_FOUNDRY_RESOURCE = profile.resource.trim()
      if (credential) {
        // Foundry splits these by kind: an Entra access token is a bearer, a
        // portal key is an api key. `authStyle` is the user's answer to which.
        if (profile.authStyle === 'bearer') set.ANTHROPIC_FOUNDRY_AUTH_TOKEN = credential
        else set.ANTHROPIC_FOUNDRY_API_KEY = credential
      }
      if (profile.gatewayAuth) set.CLAUDE_CODE_SKIP_FOUNDRY_AUTH = '1'
      break
    }
    case 'anthropicAws': {
      set.CLAUDE_CODE_USE_ANTHROPIC_AWS = '1'
      if (profile.workspaceId?.trim()) set.ANTHROPIC_AWS_WORKSPACE_ID = profile.workspaceId.trim()
      if (profile.region?.trim()) set.AWS_REGION = profile.region.trim()
      if (profile.baseUrl?.trim()) set.ANTHROPIC_AWS_BASE_URL = profile.baseUrl.trim()
      if (credential) set.ANTHROPIC_AWS_API_KEY = credential
      if (profile.gatewayAuth) set.CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH = '1'
      break
    }
    case 'gateway': {
      if (profile.baseUrl?.trim()) set.ANTHROPIC_BASE_URL = profile.baseUrl.trim()
      if (credential) {
        // Default to bearer. The docs say so, and it is the recoverable
        // mistake of the two: a bearer sent to an x-api-key gateway 401s
        // immediately, which is diagnosable, where the reverse can be accepted
        // and then behave oddly further in.
        if (profile.authStyle === 'apiKey') set.ANTHROPIC_API_KEY = credential
        else set.ANTHROPIC_AUTH_TOKEN = credential
      }
      break
    }
  }

  const headers = serialiseHeaders(profile.headers)
  if (headers) set.ANTHROPIC_CUSTOM_HEADERS = headers
  if (profile.disableBetas) set.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1'
  if (profile.disableNonessentialTraffic) set.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1'

  // The escape hatch, applied last so it can correct anything above. An
  // unforeseen variable should not need a release.
  for (const [k, v] of Object.entries(profile.env ?? {})) {
    if (k.trim() && typeof v === 'string') set[k.trim()] = v
  }

  // Everything this profile does not own, dropped. See the file header: this is
  // what stops a leftover flag from making the session a provider the board is
  // not naming.
  const clear = PROVIDER_VARS.filter((v) => !(v in set))
  return { set, clear }
}

/**
 * What is wrong with this profile, in sentences.
 *
 * Returns a list rather than throwing, because the caller is a settings screen
 * and a start-up path, and both want to show every problem at once. A profile
 * with problems must not start a session: a half-configured provider fails at
 * the first API call with a message from someone else's system.
 */
export function validateProfile(profile: ProviderProfile): string[] {
  const out: string[] = []
  if (!profile.id?.trim()) out.push('This profile has no id.')
  if (!PROVIDER_KINDS.some((k) => k.kind === profile.kind)) {
    out.push(`"${String(profile.kind)}" is not a provider kind. Expected one of: ${PROVIDER_KINDS.map((k) => k.kind).join(', ')}.`)
    return out
  }

  const url = profile.baseUrl?.trim()
  if (url && !/^https?:\/\/./i.test(url)) {
    out.push(`The base URL "${url}" is not an http(s) URL.`)
  }

  switch (profile.kind) {
    case 'gateway':
      if (!url) out.push('A custom endpoint needs a base URL — that is the whole configuration.')
      // Refused by NAME, not left to the probe's 404, because this exact
      // mistake has been made: "connect to OpenAI" reads as "point it at
      // OpenAI". The CLI speaks the Anthropic Messages API and these hosts do
      // not serve it, so the profile cannot work no matter what else is typed —
      // and the failure it produces otherwise (a 404 mid-setup, or an agent
      // dying three minutes in) never mentions the actual problem. The message
      // carries the fix because "invalid URL" alone would send the user back
      // to retyping the same URL.
      if (url && /^https?:\/\/([^/]*\.)?(openai\.com|chatgpt\.com)([/:]|$)/i.test(url)) {
        // Three fixes, in the order they are worth trying, because "invalid
        // URL" alone sends the user back to retyping the same URL. Two of the
        // three did not exist when this check was written: Codex is now a
        // runtime on this board, and OpenRouter serves an Anthropic-compatible
        // endpoint directly.
        out.push(
          'That is OpenAI\u2019s own API, which speaks a different protocol — Claude Code sends ' +
          'Anthropic Messages requests, and openai.com does not serve them. Three ways round it, ' +
          'best first: (1) run the session on the CODEX agent instead — pick it from the composer ' +
          'bar; it is OpenAI\u2019s own coding agent and takes your ChatGPT subscription or your ' +
          'API key, with no endpoint to configure. (2) Use OpenRouter, which does serve ' +
          '/v1/messages — base URL https://openrouter.ai/api, with GPT models by their OpenRouter ' +
          'slug. (3) With an OpenAI API KEY only, run a translation proxy (LiteLLM or ' +
          'claude-code-router) with the key in ITS config and point this at the proxy.',
        )
      }
      break
    case 'vertex':
      if (!profile.projectId?.trim() && !profile.env?.GCLOUD_PROJECT && !profile.env?.GOOGLE_CLOUD_PROJECT) {
        out.push('Vertex needs a GCP project id, or GCLOUD_PROJECT in the environment.')
      }
      if (!profile.region?.trim()) out.push('Vertex needs a region, for example us-east5 or global.')
      break
    case 'foundry':
      if (!url && !profile.resource?.trim()) {
        out.push('Foundry needs either a base URL or a resource name.')
      }
      break
    case 'anthropicAws':
      if (!profile.workspaceId?.trim()) out.push('Claude Platform on AWS needs a workspace id.')
      break
    case 'bedrock':
    case 'anthropic':
    case 'inherit':
      break
  }

  if (profile.regionPrefix?.trim() &&
      !['us', 'eu', 'apac', 'jp', 'au', 'global'].includes(profile.regionPrefix.trim())) {
    out.push(`"${profile.regionPrefix}" is not a Bedrock region prefix. Expected us, eu, apac, jp, au or global.`)
  }
  if (profile.contextWindow !== undefined &&
      (!Number.isFinite(profile.contextWindow) || profile.contextWindow <= 0)) {
    out.push('The context window must be a positive number of tokens.')
  }
  return out
}

/** What the picker and the board call this profile. */
export function profileLabel(profile: ProviderProfile): string {
  return profile.label?.trim() || kindDef(profile.kind).label
}

/**
 * One line describing where a session's tokens are going.
 *
 * Shown on the board, so it names the host rather than the credential — a
 * summary that quotes a key is a summary that ends up in a screenshot in a bug
 * report.
 */
export function describeProfile(profile: ProviderProfile): string {
  const bits: string[] = [kindDef(profile.kind).label]
  switch (profile.kind) {
    case 'gateway':
      if (profile.baseUrl?.trim()) bits[0] = hostOf(profile.baseUrl)
      break
    case 'bedrock':
    case 'anthropicAws':
      if (profile.region?.trim()) bits.push(profile.region.trim())
      break
    case 'vertex':
      if (profile.projectId?.trim()) bits.push(profile.projectId.trim())
      if (profile.region?.trim()) bits.push(profile.region.trim())
      break
    case 'foundry':
      if (profile.resource?.trim()) bits.push(profile.resource.trim())
      else if (profile.baseUrl?.trim()) bits.push(hostOf(profile.baseUrl))
      break
    case 'anthropic':
    case 'inherit':
      break
  }
  return bits.join(' · ')
}

/** Host and port of a URL, or the string itself when it will not parse. Used in
 *  labels, so it must never throw on a half-typed URL from a settings file. */
export function hostOf(url: string): string {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || url
  }
}

/**
 * The provider the CLI reports it is actually on, as `AccountInfo.apiProvider`.
 *
 * A separate type from `ProviderKind` because it is somebody else's vocabulary
 * and will grow without asking us.
 */
export type ResolvedProvider =
  | 'firstParty' | 'bedrock' | 'vertex' | 'foundry'
  | 'anthropicAws' | 'anthropicGoogleCloud' | 'mantle' | 'gateway'

const RESOLVED_LABELS: Record<string, string> = {
  firstParty: 'Anthropic API',
  bedrock: 'Amazon Bedrock',
  vertex: 'Google Cloud Agent Platform',
  foundry: 'Microsoft Foundry',
  anthropicAws: 'Claude Platform on AWS',
  anthropicGoogleCloud: 'Claude Platform on Google Cloud',
  mantle: 'Amazon Bedrock (Mantle)',
  gateway: 'Gateway',
}

export function resolvedLabel(p: string | undefined): string | undefined {
  if (!p) return undefined
  return RESOLVED_LABELS[p] ?? p
}

/** Which `apiProvider` value each kind should come back as. `inherit` maps to
 *  nothing, because it makes no claim and so cannot be contradicted. */
const EXPECTED: Partial<Record<ProviderKind, ResolvedProvider>> = {
  anthropic: 'firstParty',
  bedrock: 'bedrock',
  vertex: 'vertex',
  foundry: 'foundry',
  anthropicAws: 'anthropicAws',
  gateway: 'gateway',
}

/**
 * Did the CLI end up where we sent it?
 *
 * This is the half that makes the feature trustworthy rather than decorative.
 * Everything above writes environment variables and hopes; `accountInfo()` says
 * what actually happened, and a mismatch is the signal that a managed settings
 * file, an `apiKeyHelper` or a stale shell export outranked the profile. Without
 * this the board would confidently name a provider that is not billing the
 * tokens — which is the "never show a signal that cannot say bad" rule applied
 * to provider selection.
 *
 * `firstParty` is accepted for a `gateway` profile: pointing `ANTHROPIC_BASE_URL`
 * at a proxy that forwards to Anthropic, with no gateway credential, leaves the
 * CLI authenticated as first-party and is a documented, working setup.
 */
export function reconcileProvider(
  profile: ProviderProfile,
  actual: string | undefined,
): { ok: boolean; message?: string } {
  if (!actual) return { ok: true }
  const want = EXPECTED[profile.kind]
  if (!want) return { ok: true }
  if (want === actual) return { ok: true }
  if (profile.kind === 'gateway' && actual === 'firstParty') return { ok: true }
  // Mantle is Bedrock by another endpoint, so it is not a contradiction.
  if (profile.kind === 'bedrock' && actual === 'mantle') return { ok: true }
  return {
    ok: false,
    message:
      `Provider "${profileLabel(profile)}" asked for ${resolvedLabel(want)}, ` +
      `but the CLI is on ${resolvedLabel(actual)}. ` +
      'Something outranks this profile — a managed settings file, an apiKeyHelper, ' +
      'or an env block in ~/.claude/settings.json.',
  }
}

/**
 * Read the profile list out of untrusted configuration.
 *
 * `settings.json` is hand-editable and syncs between machines, so this has to
 * survive anything: a string where an object goes, a duplicate id, a missing
 * kind. It drops what it cannot read rather than throwing, because the
 * alternative is an extension that will not activate because of a typo in a
 * setting. The `inherit` profile is always present and always first, so there is
 * never a state with nothing to select.
 */
export function parseProfiles(raw: unknown): ProviderProfile[] {
  const out: ProviderProfile[] = [INHERIT_PROFILE]
  const seen = new Set([INHERIT_PROFILE.id])
  if (!Array.isArray(raw)) return out
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    const kind = r.kind as ProviderKind
    if (!id || seen.has(id)) continue
    if (!PROVIDER_KINDS.some((k) => k.kind === kind)) continue
    seen.add(id)
    const p: ProviderProfile = { id, kind }
    const str = (k: keyof ProviderProfile & string) => {
      const v = r[k]
      if (typeof v === 'string' && v.trim()) (p as unknown as Record<string, unknown>)[k] = v.trim()
    }
    for (const k of ['label', 'baseUrl', 'resource', 'region', 'projectId',
                     'regionPrefix', 'workspaceId', 'credentialFromEnv'] as const) str(k)
    if (r.authStyle === 'bearer' || r.authStyle === 'apiKey') p.authStyle = r.authStyle
    for (const k of ['hasCredential', 'gatewayAuth', 'disableBetas',
                     'disableNonessentialTraffic'] as const) {
      if (r[k] === true) p[k] = true
    }
    if (typeof r.contextWindow === 'number' && Number.isFinite(r.contextWindow) && r.contextWindow > 0) {
      p.contextWindow = r.contextWindow
    }
    if (Array.isArray(r.models)) {
      const models = r.models.filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim())
      if (models.length) p.models = models
    }
    for (const k of ['headers', 'env'] as const) {
      if (r[k] && typeof r[k] === 'object' && !Array.isArray(r[k])) {
        const rec: Record<string, string> = {}
        for (const [hk, hv] of Object.entries(r[k] as Record<string, unknown>)) {
          if (hk.trim() && typeof hv === 'string') rec[hk.trim()] = hv
        }
        if (Object.keys(rec).length) p[k] = rec
      }
    }
    out.push(p)
  }
  return out
}

/** The active profile, or the inherit one. Never undefined: there is always
 *  something to run on, and "the id in settings names a profile that was
 *  deleted" must not stop agents from starting. */
export function activeProfile(profiles: readonly ProviderProfile[], id: string | undefined): ProviderProfile {
  return profiles.find((p) => p.id === id) ?? profiles[0] ?? INHERIT_PROFILE
}
