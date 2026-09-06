/* Runs media/settings.js against a stub DOM to prove it renders.
 *
 * Same reason as `webview.test.mjs`: a webview script has no type checking, so
 * a runtime throw in it is a silently blank tab and nothing else. The settings
 * page is worse than the board in one respect — it is the page you open when
 * something is already wrong, so it is the page least able to afford being
 * blank.
 *
 * The assertions are about HONESTY, not layout. This page's job is to say what
 * is true about four things that can each be false, and the failure mode it is
 * most at risk of is a green tick painted because a config file exists. So:
 *
 *   - the four login states render as four DIFFERENT things
 *   - "could not tell" is never rendered as "signed out"
 *   - a runtime with no backend to choose SAYS there is nothing to configure,
 *     rather than showing an empty provider section
 *   - the buttons post the messages the host actually handles
 */
import { renderSettings } from '../../../test/dom.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

function findButton(node, label) {
  if (node.tagName === 'button' && node.textContent.includes(label)) return node
  for (const c of node.children ?? []) {
    const hit = findButton(c, label)
    if (hit) return hit
  }
  return null
}

const CLAUDE = {
  id: 'claude', label: 'Claude Code', vendor: 'Anthropic',
  blurb: 'Runs the Claude Code CLI on this machine.',
  installHint: 'npm install -g @anthropic-ai/claude-code',
  providerProfiles: true,
}
const CODEX = {
  id: 'codex', label: 'Codex', vendor: 'OpenAI',
  blurb: 'Runs on the Codex login already on this machine.',
  installHint: 'npm install -g @openai/codex',
  providerProfiles: false,
}

const state = (over = {}) => ({
  defaultRuntime: 'claude',
  runtimes: [CLAUDE, CODEX],
  providers: [
    { id: 'inherit', label: 'Inherit from environment', kind: 'inherit', detail: 'Whatever the CLI resolves', active: true, hasCredential: false },
    { id: 'gw', label: 'Work gateway', kind: 'gateway', detail: 'llm.corp:4000', active: false, hasCredential: true },
  ],
  ...over,
})

// --- it renders at all ------------------------------------------------------
{
  const v = await renderSettings(state())
  ok(v.text().includes('Claude Code'), 'the page renders and names Claude Code')
  ok(v.text().includes('Codex'), 'and Codex')
  ok(v.text().includes('OpenAI'), 'with the vendor, so "Codex" is not mistaken for a model')
  ok(v.posted.some((m) => m.type === 'ready'), 'and asks the host for a state on load')
}

// --- the four login states are four different things ------------------------
{
  const signedIn = await renderSettings(state({
    runtimes: [{ ...CODEX, status: { id: 'codex', label: 'Codex', at: Date.now(), login: { kind: 'signedIn', via: 'subscription', account: 'a@b.com', plan: 'plus' } } }],
  }))
  ok(signedIn.text().includes('a@b.com'), 'a signed-in runtime names the account')
  ok(signedIn.text().includes('subscription'), 'and says it is a subscription, which is a different bill from an API key')

  const signedOut = await renderSettings(state({
    runtimes: [{ ...CODEX, status: { id: 'codex', label: 'Codex', at: Date.now(), login: { kind: 'signedOut', fix: 'Run `codex login`' } } }],
  }))
  ok(signedOut.text().includes('Not signed in'), 'a signed-out runtime says so')
  ok(signedOut.text().includes('codex login'), 'and names the command that fixes it')

  const missing = await renderSettings(state({
    runtimes: [{ ...CODEX, status: { id: 'codex', label: 'Codex', at: Date.now(), login: { kind: 'notInstalled', fix: 'npm install -g @openai/codex' } } }],
  }))
  ok(missing.text().includes('Not installed'), 'a missing runtime is distinguished from a signed-out one')
  ok(missing.text().includes('npm install -g @openai/codex'), 'and names the install command')

  // The load-bearing one. We failed to ASK; claiming "signed out" would be
  // reporting a state we did not read.
  const unknown = await renderSettings(state({
    runtimes: [{ ...CODEX, status: { id: 'codex', label: 'Codex', at: Date.now(), login: { kind: 'unknown', reason: 'timed out' } } }],
  }))
  ok(unknown.text().includes('Could not tell'), 'a failed check says it could not tell')
  ok(!unknown.text().includes('Not signed in'), 'and never claims the user is signed out')
  ok(unknown.text().includes('timed out'), 'and shows why')
}

// --- a runtime with nothing to configure says so ----------------------------
{
  const v = await renderSettings(state({ runtimes: [CODEX] }))
  ok(v.text().includes('signs in as itself'),
    'a runtime with no selectable backend explains the absence rather than leaving a gap')
  ok(!v.text().includes('Backends for Claude Code'),
    'and the backend section is not shown at all when nothing takes one')
}
{
  const v = await renderSettings(state())
  ok(v.text().includes('Backends for Claude Code'), 'the backend section appears when a runtime takes one')
  ok(v.text().includes('Work gateway'), 'and lists the profiles')
  ok(v.text().includes('Key in keychain'),
    'marking which profiles hold a credential — in SecretStorage, never in settings.json')
}

// --- the model list discloses where it came from ----------------------------
{
  const builtin = await renderSettings(state({
    runtimes: [{ ...CODEX, models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], modelSource: 'builtin' }],
  }))
  ok(builtin.text().includes('GPT-5.5'), 'models are listed')
  ok(builtin.text().includes('Built-in list'),
    '"why is the model I use missing?" is answerable: the fallback SAYS it is a fallback')

  const live = await renderSettings(state({
    runtimes: [{ ...CODEX, models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], modelSource: 'runtime' }],
  }))
  ok(live.text().includes('Listed by the agent itself'), 'and a real answer says it is a real answer')
}

// --- the buttons post what the host handles ---------------------------------
{
  const v = await renderSettings(state())
  findButton(v.root, 'Use for new sessions').onclick({})
  const sent = v.posted.find((m) => m.type === 'setDefaultRuntime')
  ok(sent?.runtime === 'codex', `choosing an agent posts setDefaultRuntime (${JSON.stringify(sent)})`)

  findButton(v.root, 'Check all again').onclick({})
  ok(v.posted.some((m) => m.type === 'refresh' && !m.runtime), 'and "check all" posts a whole-board refresh')
}

// --- another program's output is TEXT, never markup -------------------------
// Every string on this page comes from somewhere else — an account name, a CLI
// version, an error. Same rule as the transcript: nodes and text, no innerHTML.
{
  const v = await renderSettings(state({
    runtimes: [{ ...CODEX, status: { id: 'codex', label: 'Codex', at: Date.now(), login: { kind: 'unknown', reason: '<img src=x onerror=alert(1)>' } } }],
  }))
  const found = []
  const walk = (n) => { found.push(n.tagName); for (const c of n.children ?? []) walk(c) }
  walk(v.root)
  ok(!found.includes('img'), 'markup in another program\'s output creates no element')
  ok(v.text().includes('<img src=x onerror=alert(1)>'), 'it is shown as characters instead')
}

// --- an error from the host is shown, not swallowed -------------------------
{
  const v = await renderSettings(state(), { error: 'the keychain refused' })
  ok(v.text().includes('the keychain refused'), 'a host error reaches the page rather than only the log')
}

// --- a login readout must say WHEN it was read ------------------------------
//
// `RuntimeStatus.at` crossed the postMessage boundary and was rendered by
// nothing, so a "Signed in" tick from an hour ago — before the token expired,
// before the CLI was uninstalled — looked exactly like one taken a second ago.
// A settings page is precisely where a green tick gets painted because a config
// file exists.
{
  const fresh = await renderSettings(state({
    runtimes: [{
      ...CLAUDE,
      status: { id: 'claude', at: Date.now() - 3000, login: { kind: 'signedIn', via: 'subscription', account: 'a@b.c' } },
    }],
  }))
  ok(/checked just now|checked \ds ago/.test(fresh.text()),
     `a fresh reading says so (${/checked [^A-Z]*/.exec(fresh.text())?.[0]?.trim() ?? 'nothing'})`)

  const old = await renderSettings(state({
    runtimes: [{
      ...CLAUDE,
      status: { id: 'claude', at: Date.now() - 3 * 3600_000, login: { kind: 'signedIn', via: 'subscription' } },
    }],
  }))
  ok(/checked 3h ago/.test(old.text()),
     `and an old one says how old (${/checked [^A-Z]*/.exec(old.text())?.[0]?.trim() ?? 'nothing'})`)
  ok(old.text().includes('Signed in'), 'while still reporting what it read')
}

// --- WHAT A BACKEND SERVES, and which of it the composer offers -------------
//
// This section is the bug this page failed to show. A gateway profile whose
// declared models were Claude Code's own aliases — saved there by the provider
// test, which asked the CLI instead of the endpoint — left the composer
// offering `sonnet` and `haiku` against DeepSeek. The page showed nothing about
// it, so there was nowhere to see it and nowhere to fix it.
{
  const CATALOGUE = [
    { id: 'deepseek-chat', label: 'DeepSeek Chat', context: '128K', price: '$0.28/$0.42 per Mtok', offered: true },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', context: '128K', price: '$0.55/$2.19 per Mtok', offered: false },
  ]
  const withCatalogue = (over = {}) => state({
    providers: [{
      id: 'ds', label: 'DeepSeek', kind: 'gateway', detail: 'api.deepseek.com',
      active: true, hasCredential: true, endpointHost: 'api.deepseek.com',
      models: CATALOGUE, ...over,
    }],
  })

  const v = await renderSettings(withCatalogue())
  ok(v.text().includes('2 models available'), 'the page says how many models the endpoint serves')
  ok(v.text().includes('1 offered in the composer'), 'and how many of them the composer is offering')

  // Collapsed by default: a catalogue is 431 rows on OpenRouter.
  ok(!v.text().includes('DeepSeek Reasoner'), 'the catalogue starts collapsed rather than filling the page')
  const open = findButton(v.root, 'models available')
  ok(!!open, 'there is a control to open it')
  // Clicked on THIS view, which re-renders itself. A second `renderSettings`
  // would be a fresh module with a fresh set of expanded rows — the state under
  // test lives at module level precisely because render() would destroy it.
  open.onclick()
  const opened = v
  ok(opened.text().includes('DeepSeek Reasoner'), 'opening it lists the models')
  ok(opened.text().includes('$0.28/$0.42 per Mtok'), 'with the price the endpoint published')
  ok(opened.text().includes('128K context'), 'and the context window')

  // The tick is the small human list — what to OFFER — as opposed to the big
  // machine list of what exists.
  const ticks = opened.root.querySelectorAll('.model-tick')
  ok(ticks.length === 2, 'every model is tickable')
  ok(ticks[0].checked === true && ticks[1].checked === false, 'and the ticks reflect what is offered')
  ticks[1].onchange()
  const posted = opened.posted.filter((m) => m.type === 'setProfileModels')
  ok(posted.length === 1, 'ticking one posts the new list to the host')
  ok(JSON.stringify(posted[0].models) === JSON.stringify(['deepseek-chat', 'deepseek-reasoner']),
     'as the ids to offer, added to the ones already there')

  // Asking costs an HTTP GET, so it is a button rather than something that
  // happens on every repaint.
  ok(!!findButton(opened.root, 'Refresh from the endpoint'), 'and the list can be re-read from the endpoint')

  // The state the user was actually left in. A page that showed the list
  // without saying this would be the page that hid the bug.
  const stale = await renderSettings(withCatalogue({
    modelNote: 'None of the 6 models this profile lists are served here, so they are ignored.',
  }))
  ok(stale.text().includes('None of the 6 models'), 'a declared list the endpoint does not serve is called out')

  // Never asked is not the same as "serves nothing".
  const unasked = await renderSettings(state({
    providers: [{ id: 'ds', label: 'DeepSeek', kind: 'gateway', detail: 'api.deepseek.com', active: true, hasCredential: false, modelNote: 'Not asked yet.' }],
  }))
  ok(unasked.text().includes('Not asked yet.'),
     '"I have not asked" is rendered as itself, never as an endpoint with no models')
  ok(!!findButton(unasked.root, 'Ask what it serves'), 'with the way to ask right there')

  // A cloud backend has no endpoint of ours to ask, so it gets no control that
  // cannot do anything — the same rule that hides the backend picker on Codex.
  const cloud = await renderSettings(state({
    providers: [{ id: 'br', label: 'Bedrock', kind: 'bedrock', detail: 'us-east-1', active: true, hasCredential: false }],
  }))
  ok(!findButton(cloud.root, 'Ask what it serves'), 'a cloud backend is offered no endpoint to interrogate')
}

// --- the agent card must not contradict the backend under it ---------------
//
// The report this section comes from: "it renders the DeepSeek as Claude Code,
// that makes no sense — I am logged in to a Claude subscription separately and
// the OpenRouter is separate from that one."
//
// Both halves of the page were true and they were saying opposite things. The
// Claude Code card read "Signed in as david@… (subscription) · firstParty",
// which is what `claude` resolves ON ITS OWN; the active backend sent every
// session to api.deepseek.com with a key from the keychain. The subscription
// was real and paid for nothing.
{
  const withBackend = (backend) => state({
    runtimes: [{
      ...CLAUDE,
      status: {
        id: 'claude', label: 'Claude Code', at: Date.now(),
        login: { kind: 'signedIn', via: 'subscription', account: 'david@prduct.com' },
      },
      backend,
    }],
  })

  const gateway = await renderSettings(withBackend({
    label: 'OpenRouter', detail: 'api.deepseek.com', usesLogin: false, credential: 'key in keychain',
  }))
  ok(gateway.text().includes('Backend: OpenRouter'), 'the agent card names the backend a session would use')
  ok(gateway.text().includes('api.deepseek.com'),
     'and where that is — which is the whole explanation for the model list')
  ok(gateway.text().includes('not used by this backend'),
     'and says the subscription is not what pays, instead of showing it as a green tick')
  ok(!gateway.root.querySelectorAll('.dot.ok').length
     || [...gateway.root.querySelectorAll('.status-row')].some((r) => r.textContent.includes('Backend')),
     'the only green dot left belongs to the thing that is actually in use')

  // The ordinary case must not be made to look wrong by the fix.
  const inherit = await renderSettings(withBackend({
    label: 'Inherit from environment', detail: 'Inherit from environment', usesLogin: true,
  }))
  ok(!inherit.text().includes('not used by this backend'),
     'a backend that DOES use the login says nothing extra about it')

  // `firstParty` is somebody else's vocabulary and was being printed raw.
  ok(!gateway.text().includes('firstParty') && !inherit.text().includes('firstParty'),
     'no raw provider jargon reaches the page')

  // Codex has no backend to name, so it is offered none.
  const codex = await renderSettings(state({ runtimes: [{ ...CODEX, status: { id: 'codex', label: 'Codex', at: Date.now(), login: { kind: 'signedIn', via: 'subscription' } } }] }))
  ok(!codex.text().includes('Backend:'), 'an agent that signs in as itself gets no backend row it cannot honour')
}

// --- an agent you do not have is not a peer of one you do -------------------
{
  const v = await renderSettings(state({
    runtimes: [
      { ...CLAUDE, status: { id: 'claude', label: 'Claude Code', at: Date.now(), login: { kind: 'signedIn', via: 'subscription' } } },
      { ...CODEX, status: { id: 'codex', label: 'Codex', at: Date.now(), login: { kind: 'notInstalled', fix: 'npm install -g @openai/codex' } } },
    ],
  }))
  ok(v.text().includes('Not installed:') && v.text().includes('Codex'),
     'an agent that is not on the machine is still listed — dropping it would make it undiscoverable')
  ok(!v.root.querySelectorAll('.agent-card').length
     || [...v.root.querySelectorAll('.agent-card')].every((c) => !c.textContent.includes('Codex')),
     'but as a line, not as a card beside the agent that is actually running things')
  ok(!findButton(v.root, 'Use for new sessions'),
     'and it is never offered as the default — pressing that would make every session fail at the first step')
  ok(!!findButton(v.root, 'Check again'), 'while still offering the way to re-check it')
}

console.log(fails ? `\n${fails} failed` : '\nall settings-view tests passed')
process.exit(fails ? 1 : 0)
