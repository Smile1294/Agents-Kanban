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

console.log(fails ? `\n${fails} failed` : '\nall settings-view tests passed')
process.exit(fails ? 1 : 0)
