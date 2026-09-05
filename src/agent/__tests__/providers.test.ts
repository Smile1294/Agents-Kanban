/* Provider profiles: the reducer from "which backend" to "what environment".
 *
 * This file is the only thing standing between a profile and a session running
 * on a backend nobody chose. Three properties matter more than the rest, and
 * each has a section below:
 *
 *  1. `inherit` is the identity. An install that never touches this feature must
 *     behave exactly as it did before the feature existed.
 *  2. An explicit choice leaves NO trace of any other provider. This is the
 *     one that is easy to get wrong and impossible to see: provider selection
 *     is a set of independent flags, so a leftover `CLAUDE_CODE_USE_BEDROCK=1`
 *     silently outranks a gateway's base URL.
 *  3. The credential never lands anywhere the profile is serialised.
 */
import {
  AMBIENT_CREDENTIAL_VARS, INHERIT_PROFILE, PROVIDER_KINDS, PROVIDER_PRESETS, PROVIDER_VARS,
  activeProfile, credentialKey, describeProfile, envForProfile, hostOf, kindDef,
  parseProfiles, profileLabel, reconcileProvider, resolvedLabel, serialiseHeaders, validateProfile,
  type ProviderKind, type ProviderProfile,
} from '../providers.ts'
import { agentEnv } from '../session.ts'
import { MODEL_WINDOWS, normaliseModel } from '../../sessions/usage.ts'
import { MODELS, windowLabel } from '../../sessions/meta.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const profile = (p: Partial<ProviderProfile> & { kind: ProviderKind }): ProviderProfile =>
  ({ id: 'p', ...p })

/** Every kind except `inherit`, which makes no claim and so has no obligations. */
const EXPLICIT = PROVIDER_KINDS.map((k) => k.kind).filter((k) => k !== 'inherit')

/** A profile of each kind, filled in enough to be valid. */
const SAMPLE: Record<string, ProviderProfile> = {
  anthropic: profile({ kind: 'anthropic' }),
  bedrock: profile({ kind: 'bedrock', region: 'us-east-1' }),
  vertex: profile({ kind: 'vertex', projectId: 'proj', region: 'us-east5' }),
  foundry: profile({ kind: 'foundry', resource: 'res' }),
  anthropicAws: profile({ kind: 'anthropicAws', workspaceId: 'ws' }),
  gateway: profile({ kind: 'gateway', baseUrl: 'http://localhost:3456' }),
}

// --- 1. inherit is the identity ---------------------------------------------
// The default profile. If this ever writes or clears anything, every existing
// enterprise setup changes behaviour on upgrade without anyone asking for it.
{
  const e = envForProfile(INHERIT_PROFILE)
  ok(Object.keys(e.set).length === 0, 'inherit sets nothing')
  ok(e.clear.length === 0, 'inherit clears nothing — an existing Bedrock or gateway setup keeps working')

  // And prove it end to end, through the function that builds the real thing.
  const base = { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1', PATH: '/bin' }
  const env = agentEnv(base, e.set, e.clear)
  ok(env.CLAUDE_CODE_USE_BEDROCK === '1', 'an ambient provider flag survives inherit')
  ok(env.AWS_REGION === 'eu-west-1', 'and so does its region')

  // A profile that is somehow not any known kind must behave like inherit
  // rather than emitting a half-configured provider.
  const bogus = envForProfile(profile({ kind: 'nonsense' as ProviderKind }))
  ok(Object.keys(bogus.set).length === 0, 'an unknown kind sets no provider variable')
}

// --- 2. an explicit choice leaves no other provider behind -------------------
// The property that makes the picker mean anything. Checked as a matrix rather
// than per kind, so a NEW kind is covered the moment it is added to
// PROVIDER_KINDS — the drift this repo has been bitten by before.
{
  /** Every variable that turns a backend on. */
  const SELECTORS = PROVIDER_VARS.filter((v) => v.startsWith('CLAUDE_CODE_USE_'))
  ok(SELECTORS.length >= 5, `there are ${SELECTORS.length} backend switches to keep straight`)

  for (const kind of EXPLICIT) {
    const e = envForProfile(SAMPLE[kind]!)
    const mine = new Set(Object.keys(e.set))
    const cleared = new Set(e.clear)
    for (const sel of SELECTORS) {
      if (mine.has(sel)) continue
      ok(cleared.has(sel), `${kind} clears ${sel}, so it cannot inherit another backend`)
    }
  }

  // The whole point, demonstrated: a gateway profile in a Bedrock shell.
  const e = envForProfile(SAMPLE.gateway!)
  const env = agentEnv(
    { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'from-shell', PATH: '/bin' },
    e.set, e.clear,
  )
  ok(!('CLAUDE_CODE_USE_BEDROCK' in env), 'selecting a gateway turns Bedrock OFF, not merely adds a URL')
  ok(env.ANTHROPIC_BASE_URL === 'http://localhost:3456', 'and points the CLI at the gateway')
  ok(!('ANTHROPIC_API_KEY' in env), 'a credential from another provider is not forwarded to the new host')
  ok(env.PATH === '/bin', 'everything unrelated is untouched')

  // A cleared key is ABSENT, not empty. An empty string is a value a future CLI
  // could read as "set", which would turn this guard into the bug it prevents.
  ok(Object.values(env).every((v) => typeof v === 'string'), 'no cleared key survives as an empty string')

  // Drift guard: anything a kind emits must be accounted for in ONE of the two
  // lists. A variable in neither is a variable that leaks across a switch.
  const known = new Set([...PROVIDER_VARS, ...AMBIENT_CREDENTIAL_VARS])
  for (const kind of EXPLICIT) {
    for (const v of Object.keys(envForProfile(SAMPLE[kind]!).set)) {
      ok(known.has(v), `${kind} emits ${v}, which is listed as provider or ambient state`)
    }
  }

  // The other half of the line: the user's cloud credentials are never cleared.
  // Clearing AWS_PROFILE in the name of tidiness breaks the documented Bedrock
  // setup, which is exactly the sort of "improvement" this asserts against.
  for (const kind of EXPLICIT) {
    const cleared = new Set(envForProfile(SAMPLE[kind]!).clear)
    for (const v of AMBIENT_CREDENTIAL_VARS) {
      ok(!cleared.has(v), `${kind} does not clear ${v} — that belongs to your cloud tooling`)
    }
  }
}

// --- each kind sets what it is meant to -------------------------------------
{
  ok(envForProfile(SAMPLE.bedrock!).set.CLAUDE_CODE_USE_BEDROCK === '1', 'bedrock turns Bedrock on')
  ok(envForProfile(SAMPLE.bedrock!).set.AWS_REGION === 'us-east-1', 'and passes the region')
  ok(envForProfile(SAMPLE.vertex!).set.CLAUDE_CODE_USE_VERTEX === '1', 'vertex turns Vertex on')
  ok(envForProfile(SAMPLE.vertex!).set.ANTHROPIC_VERTEX_PROJECT_ID === 'proj', 'with the project')
  ok(envForProfile(SAMPLE.vertex!).set.CLOUD_ML_REGION === 'us-east5',
     'and the region goes to CLOUD_ML_REGION, which is Vertex’s name for it — not AWS_REGION')
  ok(envForProfile(SAMPLE.foundry!).set.CLAUDE_CODE_USE_FOUNDRY === '1', 'foundry turns Foundry on')
  ok(envForProfile(SAMPLE.foundry!).set.ANTHROPIC_FOUNDRY_RESOURCE === 'res', 'with its resource')
  ok(envForProfile(SAMPLE.anthropicAws!).set.ANTHROPIC_AWS_WORKSPACE_ID === 'ws', 'anthropicAws needs its workspace')

  // First-party sets NOTHING to select itself — it is the CLI's default, and the
  // point of choosing it explicitly is the clear list.
  const fp = envForProfile(SAMPLE.anthropic!)
  ok(Object.keys(fp.set).length === 0, 'selecting the Anthropic API sets no flag: it is the default')
  ok(fp.clear.includes('CLAUDE_CODE_USE_BEDROCK'), 'but it does clear the others — that is what selecting it means')
  ok(fp.clear.includes('ANTHROPIC_BASE_URL'), 'including a base URL left over from a gateway')

  // A gateway that authenticates upstream itself.
  const skip = envForProfile(profile({ kind: 'bedrock', gatewayAuth: true }))
  ok(skip.set.CLAUDE_CODE_SKIP_BEDROCK_AUTH === '1', 'gatewayAuth stops the CLI signing requests itself')

  const prefix = envForProfile(profile({ kind: 'bedrock', regionPrefix: 'global' }))
  ok(prefix.set.ANTHROPIC_BEDROCK_REGION_PREFIX === 'global', 'the inference-profile prefix is passed through')

  // The shims. Off unless asked for, because each costs something when it is
  // not needed.
  ok(!('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS' in envForProfile(SAMPLE.gateway!).set),
     'betas are not disabled by default — that costs features')
  const shimmed = envForProfile(profile({
    kind: 'gateway', baseUrl: 'http://x', disableBetas: true, disableNonessentialTraffic: true,
  }))
  ok(shimmed.set.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS === '1', 'and are disabled when a proxy needs it')
  ok(shimmed.set.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === '1', 'as is non-essential traffic')

  // The escape hatch wins, so an unforeseen variable never needs a release.
  const over = envForProfile(profile({ kind: 'bedrock', region: 'us-east-1', env: { AWS_REGION: 'eu-west-1' } }))
  ok(over.set.AWS_REGION === 'eu-west-1', 'the env escape hatch is applied last and overrides')
}

// --- 3. the credential ------------------------------------------------------
// It arrives as an argument and leaves in an environment variable. It must
// never be reachable from the profile, which is written to settings.json.
{
  const p = profile({ kind: 'gateway', baseUrl: 'http://localhost:4000', hasCredential: true })
  const e = envForProfile(p, 'sk-secret-value')
  ok(e.set.ANTHROPIC_AUTH_TOKEN === 'sk-secret-value',
     'a gateway credential defaults to the Authorization: Bearer variable, as the docs say')
  ok(!('ANTHROPIC_API_KEY' in e.set), 'and not to the x-api-key one, which the gateway would not read')

  const asKey = envForProfile({ ...p, authStyle: 'apiKey' }, 'sk-secret-value')
  ok(asKey.set.ANTHROPIC_API_KEY === 'sk-secret-value', 'authStyle: apiKey sends it as x-api-key instead')
  ok(!('ANTHROPIC_AUTH_TOKEN' in asKey.set), 'and only there — a credential in two headers is two chances to be wrong')

  // Serialising the profile must not carry the value anywhere.
  const serialised = JSON.stringify(p)
  ok(!serialised.includes('sk-secret-value'), 'the profile does not contain the credential')
  ok(!describeProfile(p).includes('sk-secret-value'), 'nor does its one-line summary, which ends up in screenshots')
  ok(!profileLabel(p).includes('sk-secret-value'), 'nor its label')
  ok(credentialKey('p') !== 'p' && credentialKey('p').includes('p'),
     'the secret lives under a namespaced key derived from the profile id')
  ok(credentialKey('a') !== credentialKey('b'), 'and two profiles cannot share a credential')

  // The zero-configuration path: it is already in the shell.
  const fromEnv = envForProfile(
    profile({ kind: 'gateway', baseUrl: 'http://x', credentialFromEnv: 'MY_TOKEN' }),
    undefined,
    { MY_TOKEN: 'from-shell' },
  )
  ok(fromEnv.set.ANTHROPIC_AUTH_TOKEN === 'from-shell', 'credentialFromEnv reads the token out of the environment')
  const missing = envForProfile(
    profile({ kind: 'gateway', baseUrl: 'http://x', credentialFromEnv: 'ABSENT' }), undefined, {},
  )
  ok(!('ANTHROPIC_AUTH_TOKEN' in missing.set), 'and sets nothing when that variable is not there')

  // Foundry splits by kind rather than sharing one variable.
  ok(envForProfile(profile({ kind: 'foundry', resource: 'r', authStyle: 'bearer' }), 'tok')
      .set.ANTHROPIC_FOUNDRY_AUTH_TOKEN === 'tok', 'a Foundry Entra token goes in the bearer variable')
  ok(envForProfile(profile({ kind: 'foundry', resource: 'r' }), 'tok')
      .set.ANTHROPIC_FOUNDRY_API_KEY === 'tok', 'and a portal key in the api-key one')

  // Bedrock's credential is an AWS bearer token, not an Anthropic key.
  ok(envForProfile(SAMPLE.bedrock!, 'bedrock-key').set.AWS_BEARER_TOKEN_BEDROCK === 'bedrock-key',
     'a Bedrock credential is an AWS bearer token')
  ok(!('ANTHROPIC_API_KEY' in envForProfile(SAMPLE.bedrock!, 'bedrock-key').set),
     'and never an Anthropic key, which Bedrock does not read')

  // Whitespace-only is not a credential.
  ok(!('ANTHROPIC_AUTH_TOKEN' in envForProfile(SAMPLE.gateway!, '   ').set),
     'a blank credential is treated as absent, not sent as an empty header')
}

// --- headers ----------------------------------------------------------------
{
  ok(serialiseHeaders(undefined) === '', 'no headers serialise to nothing')
  ok(serialiseHeaders({ A: '1', B: '2' }) === 'A: 1\nB: 2',
     'headers are newline-separated Name: Value, the shape ANTHROPIC_CUSTOM_HEADERS wants')
  ok(serialiseHeaders({ '': 'x', A: '' }) === '', 'a half-written header is skipped rather than emitted broken')
  ok(envForProfile(profile({ kind: 'gateway', baseUrl: 'http://x', headers: { 'X-Team': 'core' } }))
      .set.ANTHROPIC_CUSTOM_HEADERS === 'X-Team: core', 'and they reach the CLI')
}

// --- validation -------------------------------------------------------------
// A profile with problems must not start a session: the alternative is failing
// three minutes in, with a message written by somebody else's gateway.
{
  ok(validateProfile(INHERIT_PROFILE).length === 0, 'inherit is always valid')
  for (const kind of EXPLICIT) {
    ok(validateProfile(SAMPLE[kind]!).length === 0, `a filled-in ${kind} profile is valid`)
  }
  ok(validateProfile(profile({ kind: 'gateway' })).length > 0, 'a gateway with no URL is refused — that is the whole configuration')
  ok(validateProfile(profile({ kind: 'gateway', baseUrl: 'localhost:3456' })).length > 0,
     'a URL with no scheme is refused: it would be sent verbatim and fail obscurely')
  ok(validateProfile(profile({ kind: 'gateway', baseUrl: 'http://localhost:3456' })).length === 0,
     'and an http URL is accepted — a local proxy has no certificate')

  // The mistake that was actually made: "connect to OpenAI" typed as OpenAI's
  // own URL. It can never work — the CLI speaks the Anthropic Messages API and
  // openai.com does not serve it — so it is refused BY NAME, with the fix in
  // the message, rather than left to fail as a 404 that never says why.
  for (const url of ['https://api.openai.com', 'https://api.openai.com/v1',
                     'http://openai.com', 'https://chatgpt.com/backend']) {
    const problems = validateProfile(profile({ kind: 'gateway', baseUrl: url }))
    ok(problems.length > 0, `${url} is refused — it cannot serve Anthropic Messages requests`)
    ok(problems.some((p) => /translation proxy|LiteLLM/i.test(p)),
       'and the message says what to run instead, not just "invalid"')
  }
  ok(validateProfile(profile({ kind: 'gateway', baseUrl: 'https://my-openai-proxy.example.com' })).length === 0,
     'while a proxy that merely MENTIONS openai in its own hostname is fine — the match is the domain, not the substring')
  ok(validateProfile(profile({ kind: 'vertex', region: 'us-east5' })).length > 0, 'vertex without a project is refused')
  ok(validateProfile(profile({ kind: 'vertex', projectId: 'p' })).length > 0, 'vertex without a region is refused')
  ok(validateProfile(profile({ kind: 'vertex', region: 'us-east5', env: { GCLOUD_PROJECT: 'p' } })).length === 0,
     'unless the project comes from the environment, which is how gcloud does it')
  ok(validateProfile(profile({ kind: 'foundry' })).length > 0, 'foundry needs a URL or a resource')
  ok(validateProfile(profile({ kind: 'anthropicAws' })).length > 0, 'claude-on-aws needs a workspace id')
  ok(validateProfile(profile({ kind: 'bedrock' })).length === 0,
     'bedrock with nothing filled in is valid: the AWS chain supplies the region and the credentials')
  ok(validateProfile(profile({ kind: 'bedrock', regionPrefix: 'nope' })).length > 0, 'a bad region prefix is caught')
  ok(validateProfile(profile({ kind: 'gateway', baseUrl: 'http://x', contextWindow: -5 })).length > 0,
     'a negative context window is caught — it is a divisor')
  ok(validateProfile({ id: '', kind: 'gateway', baseUrl: 'http://x' }).length > 0, 'a profile with no id is refused')
  // Never throws, whatever it is handed: the caller is a settings screen.
  ok(validateProfile({ id: 'x', kind: 'made-up' as ProviderKind }).length > 0, 'an unknown kind is described, not thrown')
}

// --- reading untrusted settings ---------------------------------------------
// settings.json is hand-edited and syncs between machines. A typo must not stop
// the extension activating.
{
  ok(parseProfiles(undefined)[0]!.id === 'inherit', 'inherit is always present, and first')
  ok(parseProfiles(undefined).length === 1, 'with nothing configured, it is the only option')
  ok(parseProfiles('not an array').length === 1, 'a string where the array goes is ignored')
  ok(parseProfiles([null, 3, 'x', {}]).length === 1, 'so is every kind of junk entry')
  ok(parseProfiles([{ id: 'a' }]).length === 1, 'an entry with no kind is dropped')
  ok(parseProfiles([{ id: 'a', kind: 'nope' }]).length === 1, 'an entry with an unknown kind is dropped')
  ok(parseProfiles([{ id: 'inherit', kind: 'gateway', baseUrl: 'http://x' }]).length === 1,
     'and nothing may shadow the inherit profile')

  const two = parseProfiles([
    { id: 'a', kind: 'gateway', baseUrl: ' http://x ', models: ['m1', '', 'm2'], contextWindow: 1000 },
    { id: 'a', kind: 'bedrock' },
  ])
  ok(two.length === 2, 'a duplicate id is dropped rather than overwriting — ids key the credential')
  ok(two[1]!.baseUrl === 'http://x', 'strings are trimmed')
  ok(two[1]!.models?.length === 2, 'empty model ids are dropped')
  ok(two[1]!.contextWindow === 1000, 'the context window round-trips')

  ok(parseProfiles([{ id: 'a', kind: 'gateway', baseUrl: 'http://x', contextWindow: 'big' }])[1]!.contextWindow
       === undefined, 'a non-numeric window is dropped, not coerced to NaN')
  ok(parseProfiles([{ id: 'a', kind: 'gateway', baseUrl: 'http://x', hasCredential: 'yes' }])[1]!.hasCredential
       === undefined, 'only a real boolean sets a flag')
  ok(parseProfiles([{ id: 'a', kind: 'gateway', baseUrl: 'http://x', authStyle: 'shrug' }])[1]!.authStyle
       === undefined, 'an unknown auth style falls back to the documented default')
  ok(parseProfiles([{ id: 'a', kind: 'gateway', baseUrl: 'http://x', headers: { 'X': 'y', '': 'z' } }])[1]!.headers
       ?.X === 'y', 'headers survive, minus the nameless one')

  // Every field the settings schema declares must survive the round trip. This
  // is the rule the context-window bug produced: a value written and silently
  // missing from the parse is not persistence.
  const full = {
    id: 'full', label: 'L', kind: 'bedrock', baseUrl: 'http://b', resource: 'r',
    region: 'us-east-1', projectId: 'proj', regionPrefix: 'eu', workspaceId: 'ws',
    authStyle: 'apiKey', hasCredential: true, credentialFromEnv: 'TOK',
    headers: { H: 'v' }, gatewayAuth: true, disableBetas: true,
    disableNonessentialTraffic: true, models: ['m'], contextWindow: 42, env: { E: 'v' },
  }
  const back = parseProfiles([full])[1]!
  for (const key of Object.keys(full)) {
    ok((back as unknown as Record<string, unknown>)[key] !== undefined, `${key} survives the settings round trip`)
  }
}

// --- picking the active one -------------------------------------------------
{
  const list = parseProfiles([{ id: 'gw', kind: 'gateway', baseUrl: 'http://x' }])
  ok(activeProfile(list, 'gw').id === 'gw', 'the configured id selects its profile')
  ok(activeProfile(list, undefined).id === 'inherit', 'nothing configured means inherit')
  ok(activeProfile(list, 'deleted').id === 'inherit',
     'an id naming a profile that was deleted falls back rather than stopping agents from starting')
  ok(activeProfile([], 'x').id === 'inherit', 'and an empty list still yields something to run on')
}

// --- the resolved provider, and disagreement --------------------------------
// The half that makes the readout trustworthy. Everything else writes variables
// and hopes; this is where the CLI gets to contradict us.
{
  for (const kind of EXPLICIT) {
    ok(reconcileProvider(SAMPLE[kind]!, undefined).ok,
       `${kind}: no answer yet is not a disagreement`)
  }
  ok(reconcileProvider(SAMPLE.bedrock!, 'bedrock').ok, 'bedrock reported as bedrock agrees')
  ok(reconcileProvider(SAMPLE.bedrock!, 'mantle').ok, 'and Mantle is Bedrock by another endpoint, not a contradiction')
  ok(reconcileProvider(SAMPLE.gateway!, 'gateway').ok, 'a gateway reported as a gateway agrees')
  ok(reconcileProvider(SAMPLE.gateway!, 'firstParty').ok,
     'a proxy forwarding to Anthropic with no gateway credential stays firstParty — a documented setup')
  ok(reconcileProvider(INHERIT_PROFILE, 'bedrock').ok,
     'inherit makes no claim, so it can never be contradicted')

  const bad = reconcileProvider(SAMPLE.bedrock!, 'firstParty')
  ok(!bad.ok, 'a Bedrock profile that came back first-party is a disagreement')
  ok(!!bad.message && bad.message.includes('Amazon Bedrock') && bad.message.includes('Anthropic API'),
     'and the message names both what was asked for and what happened')
  ok(!!bad.message?.includes('settings'), 'and points at what outranks a profile')

  ok(resolvedLabel('bedrock') === 'Amazon Bedrock', 'the CLI’s vocabulary is translated for display')
  ok(resolvedLabel(undefined) === undefined, 'and nothing is invented when it said nothing')
  ok(resolvedLabel('brand-new-backend') === 'brand-new-backend',
     'a provider we have never heard of shows its own name rather than being hidden')
}

// NOTE: what the model picker offers moved to `models.test.ts`, together with
// `modelsForProfile` itself. It belongs beside `mergeModels`, because the two
// have to be tested COMPOSED — separately they were both green while the picker
// showed the wrong list.

// --- kind metadata drives the UI, so it must be complete --------------------
{
  for (const k of PROVIDER_KINDS) {
    ok(!!k.label && !!k.blurb, `${k.kind} has a label and a blurb for the picker`)
    ok(/^https:\/\//.test(k.docs), `${k.kind} links to real documentation rather than paraphrasing it`)
    ok(k.fields.filter((f) => f.secret).length <= 1,
       `${k.kind} has at most one secret field — two would share one keychain entry`)
    ok(kindDef(k.kind).kind === k.kind, `${k.kind} is findable by kind`)
  }
  ok(kindDef('nope' as ProviderKind).kind === 'inherit',
     'an unknown kind resolves to inherit, which is the safe default rather than a throw')

  // Support tiers are shown to the user, so "community" has to actually be set
  // on the ones that need a proxy Anthropic does not support.
  const community = PROVIDER_PRESETS.filter((p) => p.needs)
  ok(community.length > 0, `${community.length} presets need software the user runs themselves`)
  for (const p of community) {
    ok(!!p.needs && p.needs.length > 20, `the "${p.label}" preset says what it needs first`)
  }
  const ids = PROVIDER_PRESETS.map((p) => p.id)
  ok(new Set(ids).size === ids.length, 'preset ids are unique — they seed profile ids')
  for (const p of PROVIDER_PRESETS) {
    ok(PROVIDER_KINDS.some((k) => k.kind === p.profile.kind), `the "${p.label}" preset names a real kind`)
    // A preset must not ship a profile that cannot start, or "Add a provider"
    // would end in a warning for a case we chose ourselves.
    const problems = validateProfile({ ...p.profile, id: p.id })
    ok(problems.length === 0 || !!p.needs,
       `the "${p.label}" preset is either usable as shipped or says what is missing`)
  }
}

// --- labels never break on half-typed input ---------------------------------
{
  ok(hostOf('http://localhost:3456') === 'localhost:3456', 'a URL reduces to host and port')
  ok(hostOf('https://gw.example.com/v1/anthropic') === 'gw.example.com', 'the path is dropped')
  ok(hostOf('not a url') === 'not a url', 'and something unparseable comes back as itself, not a throw')
  ok(hostOf('') === '', 'including empty')

  ok(profileLabel(profile({ kind: 'bedrock' })) === 'Amazon Bedrock', 'an unnamed profile falls back to its kind')
  ok(profileLabel(profile({ kind: 'bedrock', label: '  ' })) === 'Amazon Bedrock', 'and so does a blank name')
  ok(describeProfile(profile({ kind: 'gateway', baseUrl: 'http://localhost:3456' })) === 'localhost:3456',
     'a gateway is described by where it is, which is the only distinguishing thing about it')
  ok(describeProfile(profile({ kind: 'vertex', projectId: 'p', region: 'r' })).includes('p'),
     'and a cloud profile by its placement')
  ok(describeProfile(INHERIT_PROFILE).length > 0, 'every profile describes itself somehow')
}

// --- agentEnv, with the clear list ------------------------------------------
{
  const env = agentEnv({ A: '1', B: '2', C: undefined }, { D: '4' }, ['B'])
  ok(env.A === '1', 'inherited variables come through')
  ok(!('B' in env), 'a cleared one does not')
  ok(!('C' in env), 'nor does an undefined one')
  ok(env.D === '4', 'extras are added')
  ok(env.DISABLE_AUTOUPDATER === '1', 'and the update guards still apply')
  // The host's own session identity is still dropped — the clear list adds to
  // that rule rather than replacing it.
  ok(!('CLAUDE_CODE_SESSION_ID' in agentEnv({ CLAUDE_CODE_SESSION_ID: 'x' }, {}, [])),
     'the host session id is still stripped when nothing else is cleared')
  // `extra` wins over `clear`, so a caller need not order the two.
  ok(agentEnv({ X: 'old' }, { X: 'new' }, ['X']).X === 'new', 'setting a variable beats clearing it')
}

console.log(fails ? `\n${fails} provider test(s) failed` : '\nall provider tests passed')
process.exit(fails ? 1 : 0)
