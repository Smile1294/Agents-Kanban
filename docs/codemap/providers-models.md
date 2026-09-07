---
name: providers-models
description: Which backend Claude Code talks to and which models the picker offers — provider profiles as environment patches, credentials in SecretStorage, the connection probe, endpoint catalogues with prices and windows, the model list's single fallback chain
paths:
  - src/agent/providers.ts
  - src/agent/models.ts
  - src/agent/endpoint.ts
  - src/agent/probe.ts
tests:
  - src/agent/__tests__/providers.test.ts
  - src/agent/__tests__/models.test.ts
  - src/agent/__tests__/endpoint.test.ts
  - src/agent/__tests__/probe.test.ts
last_verified: 2026-09-07
---
# Providers and models

## Owns

The backend behind Claude Code (Anthropic, Bedrock, Vertex, Foundry, Claude on
AWS, any gateway serving the Messages API) and everything downstream of that
choice: the environment the CLI child gets, whether the endpoint is really
there, which models it serves, what they cost and how big their windows are,
and which of them the composer offers. Full narrative in
[PROVIDERS.md](../PROVIDERS.md). This extension never talks to a model API;
it spawns the CLI and the CLI does.

## Files

**`src/agent/providers.ts`** (~1030 lines). A pure reducer: `envForProfile(profile,
credential?)` → `{set, clear}` — the ONLY file that knows a variable name.
`ProviderProfile` (`id`, `label`, `kind`, `baseUrl`, `resource`, `region`,
`projectId`, `regionPrefix`, `workspaceId`, `authStyle` (`bearer` →
`ANTHROPIC_AUTH_TOKEN`, `apiKey` → `ANTHROPIC_API_KEY` — the wrong one is a
correct key that 401s), `hasCredential`, `credentialFromEnv`, `headers`,
`gatewayAuth`, `disableBetas`, `disableNonessentialTraffic`, `models`,
`smallModel`, `contextWindow`, `env`); `ProviderKind` / `PROVIDER_KINDS` /
`PROVIDER_PRESETS` (OpenRouter, DeepSeek, Ollama, LiteLLM …); `INHERIT_PROFILE`
(writes nothing); `PROVIDER_VARS` (what an explicit profile clears);
`AMBIENT_CREDENTIAL_VARS` (`AWS_PROFILE`, `GOOGLE_APPLICATION_CREDENTIALS`,
`HTTPS_PROXY` — deliberately NOT cleared); `validateProfile`;
`reconcileProvider(profile, actual)` + `resolvedLabel` (what the CLI's
`accountInfo()` said it resolved to, against what we asked for → an amber note);
`parseProfiles` (settings are parsed, not cast); `activeProfile`;
`credentialKey(profile)` (the SecretStorage key); `usesRuntimeLogin`. Test:
`providers.test.ts` — `inherit` is the identity, an explicit choice leaves no
trace of any other provider, the credential never lands beside the profile.

**`src/agent/models.ts`** (~580 lines). `catalogueFor(...)` — the SINGLE entry
point; `mergeModels` decides which list is in force and reports the source:
`endpoint` → `cli` → `profile` → `builtin`. `discoverModels` asks
`Query.supportedModels()` through `withSilentQuery`, once per provider, cached
in `globalState`, never on the render or activation path; the result is applied
only if the active profile is still the one captured before the `await`.
`endpointChoices`, `modelsForProfile`; `effortsFor` / `thinkingFor` /
`ultracodeFor` / `fastModeFor` — per-model capability gates (`supportsEffort ===
true`; Haiku 4.5 has NEITHER field); `parseCachedChoices` — rejects the whole
cache on one bad entry (a cached shape from an older build is another program's
output, read on the render path); `parseRate`, `priceLabel` (zero is `Free`;
`-1` is unknown). Test: `models.test.ts` — a real CLI answer as the fixture; the
pieces run TOGETHER in the host's order, because two functions that both knew
how to fall back once discarded the CLI's answer on every refresh.

**`src/agent/endpoint.ts`**. `fetchEndpointModels(profile, credential, fetch?)` —
`GET <base>/v1/models` (and Ollama's `/api/tags`), reporting problems rather
than throwing; `parseModelList` (OpenAI `{data}`, Ollama `{models}`, a bare
array; OpenRouter's and LiteLLM's window/price fields); `rateOf` — USD per
token → per million, once; `EndpointModel` (`id`, `label`, `context`, `rate`),
`EndpointCatalogue`, `modelListUrls`, `MAX_MODELS = 500`. `EndpointRate` IS
`ModelRate`, so a field added to one is a compile error, not a dropped price.
Test: `endpoint.test.ts`, with a real 431-model OpenRouter payload.

**`src/agent/probe.ts`**. `probeProvider` / `checkEndpoint` — TCP connect, then
the `max_tokens: 1` request the gateway docs prescribe, then the model list.
FOUR failure cases because they have four fixes: start the proxy, correct the
path, fix the credential, move it to the other header — the 401 message names
`Bearer` vs `x-api-key` explicitly. Cloud kinds say "configured for X, the
first request will confirm", never "connected". `fetch` and the TCP connect are
injected. Test: `probe.test.ts`.

## How it works

A profile lives in `agentsKanban.providers` (settings, which sync and get
committed) with `hasCredential: true` only; the credential is in
`SecretStorage` under `credentialKey`. At launch, `envForProfile` produces
`{set, clear}`; `agentEnv()` in `session.ts` spreads `process.env`, applies
`set`, and DELETES the `clear` keys — never sets them to `''`. `inherit` writes
nothing, so a shell already on Bedrock stays on Bedrock. Every run asks
`accountInfo()` once, fire-and-forget, and `reconcileProvider` turns a
disagreement into an amber note. The model list for a gateway profile comes
from the endpoint (ids, windows, prices), ranked above the CLI's list (which is
about Claude Code however `ANTHROPIC_BASE_URL` points); a declared `models` list
that matches nothing the endpoint serves is reported and overridden. Prices and
windows reach both meters through `ModelBook`. A started session's backend can
change for its NEXT launch (`SessionMeta.provider`, `switchedFrom` and the
re-read cost warning); its runtime cannot.

## Change recipes

- **A new provider kind.** A row in `PROVIDER_KINDS` and a case in
  `envForProfile`; the variables it sets go into `PROVIDER_VARS` so other
  profiles clear them; `package.json`'s `kind` enum and `enumDescriptions`;
  PROVIDERS.md's variables table. `providers.test.ts` asserts an explicit choice
  clears everything it does not set.
- **A new preset for a gateway.** `PROVIDER_PRESETS`; the settings page offers it.
- **A new endpoint dialect for `/v1/models`.** `parseModelList` + a fixture in
  `endpoint.test.ts`; keep zero-vs-unknown pricing straight.
- **A new per-model capability.** Read it from `supportedModels()` in
  `models.ts`, gate on `=== true`, hide the control when absent (never grey),
  enforce host-side after the assignment (the CLI validates nothing).

## Invariants

- An explicit profile CLEARS what it does not set; keys are dropped, never `''`.
- The default is `inherit`, and it writes nothing.
- A credential goes to `SecretStorage`, never to settings; `smoke.mjs` checks
  both stores in both directions.
- A provider readout comes from the CLI, not from our config.
- A provider check must be able to say "bad"; `accountInfo()` cannot, so the
  probe hits the URL.
- A custom endpoint's model list comes from the ENDPOINT; the CLI's list is
  about the CLI.
- Fallback logic lives in exactly ONE place (`catalogueFor`).
- Anything read from `globalState` is parsed, not cast.
- A value captured before an `await` is re-checked after it.
- Switching provider applies to the NEXT session only.
- Off first-party a model id is not one of ours: `normaliseModel` strips the
  Bedrock/Vertex decoration; an inference-profile ARN stays unpriced.

## Open work

- A routed subtask's gateway catalogue must be READ once (a click on the
  settings page) before `spawn-catalogue` accepts a model on it.

## Recent changes

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
- 2026-09-07 · task/S116g8 · dead-code sweep: `ResolvedProvider` type de-exported — module-private, used only by the private `EXPECTED` table.
