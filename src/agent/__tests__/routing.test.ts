/* Per-piece routing: which AGENT PROGRAM, which BACKEND and which MODEL each
   subtask of a split runs on.

   All of it is pure, and that is the point. The gate lives host-side in
   `AgentManager.split()`, but the arithmetic lives here so the whole policy can
   be exercised without an editor, a CLI or a credential — and so there is
   exactly ONE place that knows how to compose it. Two functions that both know
   how to fall back is one bug; this file is the postmortem applied in advance.

   The failure this module exists to prevent is not subtle: `split()` used to
   pass the parent's RUNTIME to every child and say nothing about its BACKEND,
   so a session running on DeepSeek all morning fanned out into children on
   whatever profile happened to be active — a different bill, different model
   ids, and nothing on the board saying so. */
import {
  agentKeyOf, parseAgentKey, spawnKeyFor, slugFor, findSpawnAgent,
  describeSpawnAgents, resolveRoute, ALL_ROUTE_RULES,
  type SpawnAgent, type SpawnCatalogue,
} from '../routing.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// --- the key, and reading it back -------------------------------------------
//
// `<runtime>|<profile>` is the composer's key for "what does this run on", and
// it is deliberately the SAME string here: the picker the user clicks and the
// value an agent names must not be two vocabularies that can drift apart.
ok(agentKeyOf('claude', 'p1') === 'claude|p1', 'an agent key is runtime|profile')
ok(agentKeyOf('codex', '') === 'codex|', 'a runtime with no backend concept has an empty profile half')

ok(parseAgentKey('claude|p1')?.runtime === 'claude', 'a key parses back to its runtime')
ok(parseAgentKey('claude|p1')?.provider === 'p1', 'and to its profile')
ok(parseAgentKey('codex|')?.provider === '', 'an empty profile half survives the round trip')
// Parsed, never cast. This value reaches us from a webview message and from
// storage written by an older build.
ok(parseAgentKey('banana|p1') === undefined, 'an unknown runtime is refused rather than cast')
ok(parseAgentKey('claude') === undefined, 'a key with no separator is refused')
ok(parseAgentKey(42) === undefined, 'a non-string is refused')
ok(parseAgentKey(undefined) === undefined, 'so is nothing at all')

// --- which tick-list an agent's models are under -----------------------------
//
// `SpawnPolicy` is keyed by BACKEND, and for a runtime that signs in as itself
// the backend IS the runtime. The `runtime:` prefix keeps that out of the space
// of profile ids, which are user data.
ok(spawnKeyFor('claude', 'p1') === 'p1', 'a backend-bearing runtime keys on the profile')
ok(spawnKeyFor('claude', 'inherit') === 'inherit',
   'including the inherit profile — so policies written before routing existed still apply')
ok(spawnKeyFor('codex', '') === 'runtime:codex', 'a runtime with no backend keys on itself, namespaced')

// --- the short name an agent is called by ------------------------------------
//
// A profile id is a uuid. Asking a model to emit one is asking for a
// transcription error, so every agent gets a slug derived from its label.
ok(slugFor('DeepSeek', new Set()) === 'deepseek', 'a label becomes a lowercase slug')
ok(slugFor('Claude on AWS', new Set()) === 'claude-on-aws', 'spaces become dashes')
ok(slugFor('Kimi 3 (Moonshot)', new Set()) === 'kimi-3-moonshot', 'punctuation is dropped')
ok(slugFor('DeepSeek', new Set(['deepseek'])) === 'deepseek-2', 'a collision is numbered, never silently reused')
ok(slugFor('  ', new Set()) === 'agent', 'a label with nothing in it still gets a name')
ok(slugFor('  ', new Set(['agent'])) === 'agent-2', 'and that fallback is deduped too')

// --- finding the agent a piece asked for ------------------------------------
const agents: SpawnAgent[] = [
  {
    slug: 'claude', key: 'claude|inherit', label: 'Claude Code',
    runtime: 'claude', provider: 'inherit', known: true,
    models: [
      { id: 'claude-fable-5-1', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-opus-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-4-5-20251001', efforts: [] },
    ],
  },
  {
    slug: 'deepseek', key: 'claude|dsk', label: 'DeepSeek',
    runtime: 'claude', provider: 'dsk', known: true,
    models: [{ id: 'deepseek-chat', efforts: [] }, { id: 'deepseek-reasoner', efforts: [] }],
  },
  {
    slug: 'codex', key: 'codex|', label: 'Codex',
    runtime: 'codex', provider: '', known: true,
    models: [{ id: 'gpt-5.5-codex', efforts: ['low', 'medium', 'high'] }],
  },
  {
    slug: 'kimi', key: 'claude|kmi', label: 'Kimi 3',
    runtime: 'claude', provider: 'kmi', known: false,
    models: [{ id: 'claude-opus-5', efforts: [] }],
  },
]
const catalogue: SpawnCatalogue = { agents }

ok(findSpawnAgent('deepseek', agents)?.key === 'claude|dsk', 'an agent is found by its slug')
ok(findSpawnAgent('claude|dsk', agents)?.key === 'claude|dsk', 'and by its full key')
ok(findSpawnAgent('DeepSeek', agents)?.key === 'claude|dsk', 'and by its label, case-insensitively')
ok(findSpawnAgent('Deep Seek', agents)?.key === 'claude|dsk',
   'and through whatever separators a model puts in — the input is model-written')
ok(findSpawnAgent('kimi 3', agents)?.key === 'claude|kmi', 'a label with a number in it matches too')
ok(findSpawnAgent('gemini', agents) === undefined, 'an agent that is not offered is not found')
ok(findSpawnAgent('', agents) === undefined, 'and neither is nothing')

// --- what the tool description says ------------------------------------------
//
// Bounded, deliberately: OpenRouter reports 431 models, and a tool description
// that lists them all is 160KB of prompt an agent reads before every split.
{
  const text = describeSpawnAgents(agents, 2)
  ok(text.includes('deepseek'), 'the description names each agent by the slug the model must emit')
  ok(text.includes('DeepSeek'), 'and by the label the user recognises')
  ok(text.includes('claude-fable-5-1'), 'and names models it may ask for')
  ok(/\+1 more/.test(text), `a long model list is truncated with a count, never silently (${text})`)
  ok(!text.includes('claude-haiku-4-5-20251001'),
     'the truncated ids are genuinely absent, so the count is the honest half')
  const wide = describeSpawnAgents(agents, 99)
  ok(wide.includes('claude-haiku-4-5-20251001') && !/\+\d+ more/.test(wide),
     'and a list that fits carries no count')
  ok(describeSpawnAgents([], 2) === '', 'no agents is an empty string, not a sentence about none')
}

// --- resolving one piece's route --------------------------------------------
const parent = { runtime: 'claude' as const, provider: 'dsk' }

// The BUG this feature exists to fix. A piece that names nothing inherits the
// parent's WHOLE agent — runtime and backend. `split()` used to pass the runtime
// and nothing else, so the children of a DeepSeek objective launched on the
// active profile: a different backend, a different bill, silently.
{
  const v = resolveRoute({}, parent, catalogue, 'deepseek-chat')
  ok(v.ok === true, 'a piece that asks for nothing is routed')
  ok(v.ok && v.route.runtime === 'claude', 'it inherits the parent runtime')
  ok(v.ok && v.route.provider === 'dsk',
     `and the parent BACKEND — the half that was being dropped (${v.ok ? v.route.provider : ''})`)
  ok(v.ok && v.route.model === undefined,
     'and names no model, so the launch resolves the default exactly as it did before')
}

// Routing to another backend, which is the feature.
{
  const v = resolveRoute({ agent: 'codex', model: 'gpt-5.5-codex' }, parent, catalogue, 'deepseek-chat')
  ok(v.ok === true, 'a piece may name a different agent program')
  ok(v.ok && v.route.runtime === 'codex' && v.route.provider === '',
     'and is routed to that runtime, with no backend of its own')
  ok(v.ok && v.route.model === 'gpt-5.5-codex', 'with the model it named')
}
{
  const v = resolveRoute({ agent: 'deepseek', model: 'deepseek-reasoner' }, parent, catalogue, 'claude-opus-5')
  ok(v.ok === true && v.route.provider === 'dsk' && v.route.model === 'deepseek-reasoner',
     'and a piece may name a different BACKEND on the same runtime')
}

// An agent that is not on offer. Refused, never substituted: a session keeps
// the runtime it started on for life, so a wrong guess here cannot be undone.
{
  const v = resolveRoute({ agent: 'gemini' }, parent, catalogue, 'deepseek-chat')
  ok(v.ok === false && v.rule === 'spawn-agent', 'an agent that is not configured is refused')
  ok(v.ok === false && /deepseek/.test(v.message) && /codex/.test(v.message),
     `and the refusal names what IS available (${v.ok === false ? v.message : ''})`)
}

// The cross-catalogue bug, stated as a test. `deepseek-reasoner` is a real id
// and `claude|inherit` does not serve it — a gate that checked the model against
// the ACTIVE catalogue instead of the TARGET one would let this through, and the
// child would 404 on its first request with somebody else's error message.
{
  const v = resolveRoute({ agent: 'claude', model: 'deepseek-reasoner' }, parent, catalogue, 'claude-opus-5')
  ok(v.ok === false && v.rule === 'spawn-model',
     'a model is checked against the agent it would run on, not against the active one')
  ok(v.ok === false && /claude-fable-5-1/.test(v.message),
     `and the refusal names what that agent does serve (${v.ok === false ? v.message : ''})`)
}

// Routing elsewhere without naming a model. The workspace default belongs to
// another backend, so there is nothing honest to fall back to — and launching
// on an id the target does not serve is the exact failure above.
{
  const v = resolveRoute({ agent: 'codex' }, parent, catalogue, 'claude-opus-5')
  ok(v.ok === false && v.rule === 'spawn-model',
     'naming another agent without a model is refused rather than defaulted')
  ok(v.ok === false && /gpt-5\.5-codex/.test(v.message),
     'and the refusal names the models that agent serves')
}

// The parent's own agent keeps today's behaviour exactly: no model named means
// the launch resolves the default, and the default is gated as the EFFECTIVE
// model — unticking it means "not even on my default".
{
  const v = resolveRoute({}, parent, catalogue, 'claude-opus-5')
  ok(v.ok === false && v.rule === 'spawn-model',
     'inheriting a default the parent backend does not serve is still refused')
}

// A backend nobody has asked anything. Its "model list" is the built-in
// Anthropic table standing in, so refusing on it as though it were fact would
// be a router fabricating — the refusal has to say which of the two it is,
// because the fixes are different: untick vs. go and read the backend.
{
  const v = resolveRoute({ agent: 'kimi', model: 'kimi-k3' }, parent, catalogue, 'claude-opus-5')
  ok(v.ok === false && v.rule === 'spawn-catalogue',
     'a model named on a backend we have never read is a DIFFERENT refusal')
  ok(v.ok === false && /Kimi 3/.test(v.message) && /settings/i.test(v.message),
     `and it names the backend and the fix (${v.ok === false ? v.message : ''})`)
}

// --- the seventh gate: an effort the model cannot take -----------------------
//
// Named as a gap by the orchestration research and left open: a piece
// proposing `xhigh` on a model with no such level was ACCEPTED, silently
// dropped at launch, and nothing on the card said the request was discarded.
// That is "a flag the CLI never refuses" in a new place.
{
  const v = resolveRoute(
    { agent: 'codex', model: 'gpt-5.5-codex', effort: 'xhigh' }, parent, catalogue, 'claude-opus-5',
  )
  ok(v.ok === false && v.rule === 'spawn-effort', 'an effort the model does not take is refused')
  ok(v.ok === false && /low, medium, high/.test(v.message),
     `and the refusal names the levels it does take (${v.ok === false ? v.message : ''})`)
}
{
  const v = resolveRoute(
    { agent: 'codex', model: 'gpt-5.5-codex', effort: 'high' }, parent, catalogue, 'claude-opus-5',
  )
  ok(v.ok === true && v.route.effort === 'high', 'an effort the model does take is carried through')
}
// ONE-SIDED, like `ultracodeWarning()`. An empty `efforts` list means nobody
// asked, and refusing on an absence would make every gateway session unable to
// choose an effort it may well support.
{
  const v = resolveRoute(
    { agent: 'deepseek', model: 'deepseek-chat', effort: 'max' }, parent, catalogue, 'claude-opus-5',
  )
  ok(v.ok === true && v.route.effort === 'max',
     'a model whose levels are unknown is not refused — an absence is not a "no"')
}
// Junk is refused, not dropped. Dropping it is what made `ultracode: 'banana'`
// resolve cleanly and change nothing.
{
  const v = resolveRoute(
    { agent: 'codex', model: 'gpt-5.5-codex', effort: 'banana' }, parent, catalogue, 'claude-opus-5',
  )
  ok(v.ok === false && v.rule === 'spawn-effort',
     'an effort that is not a level at all is refused rather than silently dropped')
}

// --- absent facts mean no gate, which is the pre-existing behaviour ----------
{
  const v = resolveRoute({ model: 'anything-at-all' }, parent, undefined, 'claude-opus-5')
  ok(v.ok === true && v.route.model === 'anything-at-all',
     'with no catalogue there is no gate — a host too old to supply one, and every unit test')
  ok(v.ok === true && v.route.provider === 'dsk', 'and the parent backend is still inherited')
}
// An EMPTY catalogue is the opposite claim: the user unticked everything. The
// rule is `spawn-model` and not `spawn-agent`, because the rules are told apart
// by their FIX — the host omits an agent with no allowed model, so an empty
// catalogue is "re-tick something", never "configure a backend".
{
  const v = resolveRoute({}, parent, { agents: [] }, 'claude-opus-5')
  ok(v.ok === false && v.rule === 'spawn-model',
     'an empty catalogue refuses every split, rather than reading as no policy')
  ok(v.ok === false && /unticked/.test(v.message),
     `and says so, because that is the fix (${v.ok === false ? v.message : ''})`)
}

// --- every rule can be rendered ---------------------------------------------
//
// `decompositionLine()` turns a refusal into the sentence on the parent's card.
// A rule with no case there falls through to "the split was declined", which is
// the feature working and the feature broken rendering the same.
ok(ALL_ROUTE_RULES.length === 4, `every route rule is enumerated (${ALL_ROUTE_RULES.join(', ')})`)

console.log(fails ? `\n${fails} FAILED` : '\nall ok')
process.exit(fails ? 1 : 0)
