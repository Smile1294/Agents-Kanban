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

// --- dictation: the composer mic's two local binaries -----------------------
{
  // Not checked yet is a real state, and is not painted as "not installed".
  const notAsked = await renderSettings(state())
  ok(notAsked.text().includes('Dictation'), 'the page has a dictation section')
  ok(notAsked.text().includes('Not checked yet.'), 'an unasked pipeline says it was not asked')
  const section = [...notAsked.root.querySelectorAll('section')].find((s) => s.textContent.includes('Dictation'))
  const check = section && findButton(section, 'Check')
  ok(!!check, 'and offers the way to ask')
  check.onclick()
  ok(notAsked.posted.some((m) => m.type === 'checkVoice'), 'pressing Check asks the host to probe the binaries')
}

{
  // Every piece green: the rows say where each binary was found, and when.
  const v = await renderSettings(state({
    voice: {
      at: Date.now() - 70_000,
      rows: [
        { key: 'whisper', label: 'whisper-cli', ok: true, detail: '/opt/whisper/whisper-cli' },
        { key: 'model', label: 'whisper model', ok: true, detail: '/models/ggml-base.en.bin' },
        { key: 'ffmpeg', label: 'ffmpeg', ok: true, detail: 'on PATH (ffmpeg)' },
      ],
    },
  }))
  const t = v.text()
  ok(t.includes('whisper-cli') && t.includes('whisper model') && t.includes('ffmpeg'),
     'each piece of the pipeline is its own row')
  ok(t.includes('/opt/whisper/whisper-cli'), 'a green row says where the binary was found')
  ok(t.includes('checked 1m ago'), 'a stale check is dated, so a green tick from an hour ago does not look fresh')
}

{
  // One piece missing: the row names THAT piece's fix, and the fix opens the
  // very setting that repairs it — a fix is a place, not just a sentence.
  const v = await renderSettings(state({
    voice: {
      at: Date.now(),
      rows: [
        { key: 'whisper', label: 'whisper-cli', ok: true, detail: '/opt/whisper/whisper-cli' },
        { key: 'model', label: 'whisper model', ok: false, detail: 'no whisper model — set agentsKanban.whisperModel to a ggml-*.bin file' },
        { key: 'ffmpeg', label: 'ffmpeg', ok: true, detail: 'on PATH (ffmpeg)' },
      ],
    },
  }))
  ok(v.text().includes('whisperModel'), 'a missing piece names the setting that fixes it')
  const fix = [...v.root.querySelectorAll('.fix')].find((n) => n.textContent.includes('whisperModel'))
  ok(!!fix, 'the fix is rendered as a chip')
  fix.onclick()
  ok(v.posted.some((m) => m.type === 'openSetting' && m.key === 'agentsKanban.whisperModel'),
     'clicking the fix opens that exact setting')
  const modelRow = [...v.root.querySelectorAll('.status-row')].find((r) => r.textContent.includes('whisper model'))
  ok(!!modelRow && modelRow.textContent.includes('whisperModel'),
     'the fix sits on the row of the piece it fixes — a working whisper row is not blamed for the missing model')
}

// --- scheduled runs: the board's time triggers ------------------------------
// The rows tell the run's story honestly: next fire (or "due now"), and what
// the last attempt did — a failed attempt is always visible, never lost under
// a row that still looks fine.
{
  const secOf = (v) => [...v.root.querySelectorAll('section')]
    .find((s) => s.textContent.includes('Scheduled runs'))
  const rowOf = (sec, title) => [...sec.querySelectorAll('.row')]
    .find((r) => r.textContent.includes(title))

  // The host always sends `schedules`; a state without the key (an old host)
  // must simply not offer the section.
  const none = await renderSettings(state())
  ok(!none.text().includes('Scheduled runs'),
     'a state without schedules renders no section — the page does not depend on the new field')

  const row = (over) => ({
    id: 's1', title: 'Morning bug patrol', prompt: 'Check the bug board\nand start fixing.',
    hour: 9, minute: 0, days: [1, 2, 3, 4, 5], enabled: true, when: 'Mon–Fri at 09:00',
    ...over,
  })
  const v = await renderSettings(state({
    schedules: { canRun: true, rows: [
      row({ nextAt: Date.now() + 3_600_000, lastRun: { at: Date.now() - 3_600_000, ok: true } }),
      row({ id: 's2', title: 'Nightly', prompt: 'Run the full build', days: [0, 1, 2, 3, 4, 5, 6],
        when: 'Daily at 23:00', enabled: false, nextAt: undefined, lastRun: { at: Date.now() - 3_600_000, ok: true } }),
      row({ id: 's3', title: 'Due one', days: [0, 1, 2, 3, 4, 5, 6], when: 'Daily at 06:00',
        nextAt: Date.now() - 60_000 }),
      row({ id: 's4', title: 'Broken run', prompt: 'Wake the db', days: [0], when: 'Sun at 09:00',
        nextAt: Date.now() + 86_400_000, lastRun: { at: Date.now() - 3_600_000, ok: false, note: 'no provider' } }),
    ] },
  }))
  const t = v.text()
  const sec = secOf(v)
  ok(!!sec, 'the section renders when the host provides schedules')
  ok(t.includes('Morning bug patrol') && t.includes('Mon–Fri at 09:00'),
     'a schedule row names itself and its shape')
  ok(t.includes('Check the bug board') && t.includes('Run the full build'),
     'the instruction is on the row — two schedules can share a name, and the prompt tells them apart')
  ok(/Next: (today|tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) at \d\d:\d\d/.test(t),
     'a schedule with a next run says when')
  ok(t.includes('Paused') && t.includes('Resume'),
     'a paused schedule says Paused and offers Resume, not Pause')
  ok(t.includes('Due now — starts at the next check'),
     'a moment that has passed is DUE — it reads as waiting, not as fine')
  ok(t.includes('Last run did not start — no provider.'),
     'a failed attempt is always shown, with its reason')
  ok(!rowOf(sec, 'Morning bug patrol').textContent.includes('Last run started'),
     'a healthy run with a next fire ahead does not also carry a stale "last run" line')

  // The row actions post what the host handles.
  findButton(rowOf(sec, 'Morning bug patrol'), 'Run now').onclick()
  ok(v.posted.some((m) => m.type === 'runSchedule' && m.id === 's1'),
     '"Run now" asks the host to start that schedule right now')
  findButton(rowOf(sec, 'Nightly'), 'Resume').onclick()
  ok(v.posted.some((m) => m.type === 'toggleSchedule' && m.id === 's2'),
     'Resume re-arms a paused schedule')
  findButton(rowOf(sec, 'Due one'), 'Pause').onclick()
  ok(v.posted.some((m) => m.type === 'toggleSchedule' && m.id === 's3'),
     'and Pause silences one that is due')
  findButton(rowOf(sec, 'Broken run'), 'Remove').onclick()
  ok(v.posted.some((m) => m.type === 'removeSchedule' && m.id === 's4'),
     'Remove posts the deletion')
}

{
  // No git repo open: the runs cannot fire, and the page says why instead of
  // showing a countdown that can never reach zero. Run now is disabled — never
  // a click that fails with a toast the banner above already explained.
  const v = await renderSettings(state({
    schedules: {
      canRun: false,
      problem: 'This folder is not a git repository, so no session can start in a worktree.',
      rows: [{ id: 's1', title: 'Morning patrol', prompt: 'Go', hour: 9, minute: 0,
        days: [1, 2, 3, 4, 5], enabled: true, when: 'Mon–Fri at 09:00',
        nextAt: Date.now() + 3_600_000 }],
    },
  }))
  ok(v.text().includes('not a git repository'),
     'a schedule that cannot fire is explained, not silently waiting')
  const runNow = findButton(v.root, 'Run now')
  ok(!!runNow && runNow.disabled === true, 'and Run now is disabled while it could not succeed')
  ok(runNow.title.includes('git repository'), 'the disabled button says why')
}

{
  // The form: add a schedule with a name, a time, picked days and an
  // instruction. Fields live module-level, so typing survives the re-render —
  // the model-filter test above proves the same machinery for its input.
  const sched = (v) => [...v.root.querySelectorAll('section')]
    .find((s) => s.textContent.includes('Scheduled runs'))
  const fresh = await renderSettings(state({ schedules: { canRun: true, rows: [] } }))
  ok(fresh.text().includes('Nothing scheduled yet'), 'an empty list says so')
  ok(fresh.text().includes('New schedule'), 'and the form to fix that is right there')

  const add = findButton(sched(fresh), 'Add schedule')
  ok(!!add && add.disabled === true, 'the save button starts disabled')
  ok(fresh.text().includes('Needs a name, an instruction, a time and at least one day.'),
     'and the page says what a schedule needs instead of silently disabling the button')

  // Type into the three fields, one render between each keystroke.
  const title = sched(fresh).querySelector('.sched-title')
  title.value = '  Morning bug patrol  '
  title.oninput({ target: title })
  let sec = sched(fresh)
  let prompt = sec.querySelector('.sched-prompt')
  prompt.value = 'Check the bug board and start fixing.'
  prompt.oninput({ target: prompt })
  sec = sched(fresh)
  const time = sec.querySelector('.sched-time')
  time.value = '07:45'
  time.oninput({ target: time })
  sec = sched(fresh)
  ok(sec.querySelector('.sched-title').value === '  Morning bug patrol  ',
     'the typed title survives the re-renders — nothing was lost to the rebuild (trim happens on save)')
  ok(!findButton(sec, 'Add schedule').disabled, 'once complete the save button enables')

  // Days are chips; Su is off by default (Mon–Fri), so click it on.
  const chips = sec.querySelectorAll('.sched-day')
  ok(chips.length === 7 && chips[0].textContent === 'Su' && !chips[0].className.includes('on'),
     'seven day chips, Sunday first (JS numbering), weekday default picked')
  chips[0].onclick()
  sec = sched(fresh)
  ok([...sec.querySelectorAll('.sched-day')][0].className.includes('on'),
     'clicking a chip picks the day')

  findButton(sec, 'Add schedule').onclick()
  const saved = fresh.posted.find((m) => m.type === 'saveSchedule')
  ok(!!saved, 'Save posts a saveSchedule')
  ok(saved.draft.title === 'Morning bug patrol'
     && saved.draft.prompt === 'Check the bug board and start fixing.'
     && saved.draft.hour === 7 && saved.draft.minute === 45
     && JSON.stringify(saved.draft.days) === JSON.stringify([0, 1, 2, 3, 4, 5])
     && saved.draft.enabled === true && !saved.draft.id,
     'the draft carries the typed schedule — trimmed title, full instruction, local time, the picked days')
  ok(findButton(sched(fresh), 'Add schedule').disabled === true,
     'and the form is reset for the next schedule')
}

{
  // Editing loads the schedule into the form; saving sends it back with its
  // id — and a PAUSED schedule stays paused, because editing a run is not
  // the same as re-arming one.
  const stateWith = (over) => state({
    schedules: { canRun: true, rows: [
      { id: 's1', title: 'Morning bug patrol', prompt: 'Check the bug board.',
        hour: 9, minute: 0, days: [1, 2, 3, 4, 5], enabled: true, when: 'Mon–Fri at 09:00',
        nextAt: Date.now() + 86_400_000 },
      { id: 's2', title: 'Nightly', prompt: 'Run the full build.',
        hour: 23, minute: 30, days: [0], enabled: false, when: 'Sun at 23:30', ...over },
    ] },
  })
  const secOf = (v) => [...v.root.querySelectorAll('section')]
    .find((s) => s.textContent.includes('Scheduled runs'))
  const rowOf = (sec, title) => [...sec.querySelectorAll('.row')]
    .find((r) => r.textContent.includes(title))

  const v = await renderSettings(stateWith())
  const sec0 = secOf(v)
  findButton(rowOf(sec0, 'Morning bug patrol'), 'Edit').onclick()
  let sec = secOf(v)
  ok(sec.textContent.includes('Edit schedule'), 'editing announces itself')
  ok(findButton(sec, 'Save changes') && !findButton(sec, 'Add schedule'),
     'the save button says what it will do')
  ok(sec.querySelector('.sched-title').value === 'Morning bug patrol'
     && sec.querySelector('.sched-time').value === '09:00'
     && sec.querySelector('.sched-prompt').value === 'Check the bug board.',
     'the form is filled from the schedule — nothing has to be retyped')
  const daysOn = [...sec.querySelectorAll('.sched-day')].filter((c) => c.className.includes('on'))
  ok(daysOn.length === 5 && daysOn[0].textContent === 'Mo', 'and its days are picked')

  // Change the time and save.
  const time = sec.querySelector('.sched-time')
  time.value = '08:30'
  time.oninput({ target: time })
  sec = secOf(v)
  findButton(sec, 'Save changes').onclick()
  const saved = v.posted.find((m) => m.type === 'saveSchedule')
  ok(saved?.draft.id === 's1' && saved.draft.hour === 8 && saved.draft.minute === 30,
     'saving an edit posts the id and the changed time')

  // Editing a PAUSED schedule and saving must not resume it — Pause is the
  // row's own button, and the edit must not be a second path to re-arming.
  const p = await renderSettings(stateWith())
  const secp = secOf(p)
  findButton(rowOf(secp, 'Nightly'), 'Edit').onclick()
  const secp2 = secOf(p)
  ok(secp2.querySelector('.sched-time').value === '23:30', 'a paused row edits with its own time')
  findButton(secp2, 'Save changes').onclick()
  const savedP = p.posted.find((m) => m.type === 'saveSchedule')
  ok(savedP?.draft.id === 's2' && savedP.draft.enabled === false,
     'a paused schedule saved from Edit stays paused')

  const c = await renderSettings(stateWith())
  const secc = secOf(c)
  findButton(rowOf(secc, 'Nightly'), 'Edit').onclick()
  findButton(secOf(c), 'Cancel').onclick()
  ok(findButton(secOf(c), 'Add schedule') !== null, 'Cancel leaves editing and returns to Add')
}

// --- Remote Control: the board streamed to a page the user deploys -----------
// The section's honesty rules: the status line renders the relay's actual
// answers (or "not asked yet" before the first one), and the pairing code
// NEVER appears on the page — the host sends only `hasCode`, and the field is
// change-only, blank meaning "keep the stored one".
{
  const secOf = (v) => [...v.root.querySelectorAll('section')]
    .find((s) => s.textContent.includes('Remote Control'))
  const remote = (over = {}) => state({
    remote: { enabled: true, url: 'https://board.example.com', hasCode: true, ...over },
  })
  const typed = { url: 'https://board.example.com' }

  // The host always sends `remote`; a state without the key (an old host) must
  // simply not offer the section — the same rule as `schedules`.
  const none = await renderSettings(state())
  ok(!none.text().includes('Remote Control'),
     'a state without remote renders no section — the page does not depend on the new field')

  // The status row has four states, four texts. Paused first.
  const paused = await renderSettings(remote({ enabled: false, status: undefined }))
  ok(paused.text().includes('Paused'), 'a disabled relay says Paused')
  const sec0 = secOf(paused)
  findButton(sec0, 'Resume').onclick()
  ok(paused.posted.some((m) => m.type === 'setRemote' && m.enabled === true),
     'Resume asks the host to start pushing')

  // Enabled but never answered: NOT a green tick. Nothing has been attempted.
  const fresh = await renderSettings(remote({ status: undefined }))
  ok(fresh.text().includes('has not answered yet'),
     'enabled before the first answer says so — a tick that no attempt produced is the page’s one forbidden signal')

  // A push that went out says what went out, and when.
  const okStatus = await renderSettings(remote({ status: { at: Date.now() - 2000, ok: true, note: 'pushed the board and 2 chat tails' } }))
  ok(okStatus.text().includes('pushed the board and 2 chat tails'), 'a good status says what went out')
  ok(okStatus.text().includes('just now'), 'and when — the age of the last push')
  findButton(secOf(okStatus), 'Pause').onclick()
  ok(okStatus.posted.some((m) => m.type === 'setRemote' && m.enabled === false),
     'Pause asks the host to stop pushing')

  // A push that failed stays visible, with the relay’s reason, and offers Retry.
  const bad = await renderSettings(remote({
    status: { at: Date.now() - 30_000, ok: false, error: 'relay answered 401' },
  }))
  ok(bad.text().includes('Last push failed.'), 'a failed push says it failed')
  ok(bad.text().includes('relay answered 401'), 'and shows the relay’s reason')
  findButton(secOf(bad), 'Retry').onclick()
  ok(bad.posted.some((m) => m.type === 'setRemote' && m.enabled === true),
     'Retry re-arms the push after a failure')

  // The form. URL prefilled ONCE from the host; the code is change-only.
  const v = await renderSettings(remote())
  const sec = secOf(v)
  const inputs = [...sec.querySelectorAll('.remote-input')]
  ok(inputs[0].value === 'https://board.example.com', 'the relay URL is prefilled from the host')
  const codeField = sec.querySelector('.remote-code')
  ok(codeField && codeField.value === '',
     'the stored code is never rendered — the field is change-only, blank meaning keep')
  ok(codeField.placeholder.includes('A code is stored'), 'and the placeholder says so instead')

  // Blank code + stored code: Save posts the URL alone — blank must NOT clear.
  findButton(sec, 'Save and connect').onclick()
  const kept = v.posted.find((m) => m.type === 'saveRemote')
  ok(!!kept && kept.url === 'https://board.example.com' && kept.code === undefined,
     'Save with a stored code posts the URL and no code — blank means keep the stored one')

  findButton(secOf(v), 'Remove the stored code').onclick()
  ok(v.posted.some((m) => m.type === 'clearRemoteCode'),
     'wiping the code is its own button — emptying the field is never what clears the keychain')

  // First connect: no code stored yet, so Save stays disabled until one is
  // typed — and the page says what is missing instead of a silent dead button.
  const noCode = await renderSettings(state({
    remote: { enabled: false, url: 'https://board.example.com', hasCode: false },
  }))
  const secN = secOf(noCode)
  ok(secN.querySelector('.remote-code').placeholder.includes('you choose'),
     'with no code stored the field says a code must be chosen')
  ok(findButton(secN, 'Save and connect').disabled === true,
     'Save stays disabled while no code is typed')
  ok(noCode.text().includes('A pairing code is needed once'),
     'and the page says what is missing')

  // Type a code; Save enables; the message carries it and the draft clears.
  const freshConnect = await renderSettings(state({
    remote: { enabled: false, url: '', hasCode: false },
  }))
  const secF = secOf(freshConnect)
  ok(findButton(secF, 'Save and connect').disabled === true,
     'with no URL either, Save is disabled')
  ok(freshConnect.text().includes('Deploy the relay first'),
     'and the page says the deploy comes first, not just that the button is dead')
  const urlF = secF.querySelectorAll('.remote-input')[0]
  urlF.value = 'https://board.example.com'
  urlF.oninput({ target: urlF })
  const secF2 = secOf(freshConnect)
  const codeF = secF2.querySelector('.remote-code')
  ok(codeF && codeF.placeholder.includes('you choose'), 'the URL survives the re-render')
  codeF.value = 'my-secret-code'
  codeF.oninput({ target: codeF })
  const secF3 = secOf(freshConnect)
  ok(!findButton(secF3, 'Save and connect').disabled,
     'typing URL and code enables Save')
  findButton(secF3, 'Save and connect').onclick()
  const sent = freshConnect.posted.find((m) => m.type === 'saveRemote')
  ok(sent?.url === 'https://board.example.com' && sent.code === 'my-secret-code',
     'Save posts the URL and the new code')
  const afterSave = secOf(freshConnect)
  ok(afterSave.querySelector('.remote-code').value === '',
     'the typed code is cleared after saving — it lives in the keychain, not in the page')
  ok(!freshConnect.text().includes('my-secret-code'),
     'and the code never appears in the page text')
}

// --- Remote Control: the write-channel toggle ---------------------------------
// A second capability, separately enabled: prompts sent from the remote page
// run on THIS machine. The toggle is drawn only when it could take effect (a
// URL and a pairing code exist), and its description names the risk.
{
  const secOf = (v) => [...v.root.querySelectorAll('section')]
    .find((s) => s.textContent.includes('Remote Control'))
  const remote = (over = {}) => state({
    remote: { enabled: true, url: 'https://board.example.com', hasCode: true, ...over },
  })

  const off = await renderSettings(remote())
  const wrow = secOf(off).querySelector('.remote-writes')
  const tick = wrow && wrow.querySelector('.model-tick')
  ok(!!tick && tick.checked === false,
     'with a relay configured, the writes toggle renders — OFF, because it is opt-in')
  ok(off.text().includes('Allow prompts from the remote page')
       && off.text().includes('can start sessions'),
     'and the description names what ON means: prompts run HERE, and can start sessions')
  tick.checked = true // a real click flips the box, then fires change
  tick.onchange()
  ok(off.posted.some((m) => m.type === 'setRemoteWrites' && m.enabled === true),
     'checking it posts setRemoteWrites(true)')

  const on = await renderSettings(remote({ writesEnabled: true }))
  const onTick = secOf(on).querySelector('.remote-writes').querySelector('.model-tick')
  ok(onTick.checked === true,
     'the host’s ON state renders checked')
  ok(on.text().includes('Remote prompts are ON'), 'and the row says so outright')
  onTick.checked = false
  onTick.onchange()
  ok(on.posted.some((m) => m.type === 'setRemoteWrites' && m.enabled === false),
     'unchecking it posts setRemoteWrites(false)')

  const noUrl = await renderSettings(state({
    remote: { enabled: true, url: '', hasCode: true, writesEnabled: true },
  }))
  ok(!secOf(noUrl).querySelector('.remote-writes'),
     'no relay URL, no toggle — a control that cannot take effect is not drawn')
  const noCode = await renderSettings(state({
    remote: { enabled: true, url: 'https://board.example.com', hasCode: false, writesEnabled: true },
  }))
  ok(!secOf(noCode).querySelector('.remote-writes'),
     'no pairing code, no toggle either — without a board id no command could ever arrive')
}

// --- the table of contents ----------------------------------------------------
//
// Five panels is a page nobody holds in their head; the nav at the top anchors
// them. It is assembled from the sections that EXIST — a link to a section the
// host never sent would be a control that cannot do anything.
{
  const links = (n) => [...(n ? n.children : [])]
    .filter((c) => c.tagName === 'button').map((c) => c.textContent)

  const v = await renderSettings(state())
  const nav = v.root.querySelector('.settings-nav')
  ok(!!nav, 'the page grows a table of contents')
  const all = links(nav)
  ok(all.includes('Agents') && all.includes('Backends') && all.includes('Voice'),
     `sections that always exist are linked (${JSON.stringify(all)})`)
  ok(!all.includes('Schedules') && !all.includes('Remote'),
     'sections the host did not send get no link — an anchor to nothing is a button that lies')

  const full = await renderSettings(state({
    schedules: { canRun: true, rows: [] },
    remote: { enabled: false, url: 'https://board.example.com', hasCode: true },
  }))
  const fullLinks = links(full.root.querySelector('.settings-nav'))
  ok(fullLinks.includes('Schedules') && fullLinks.includes('Remote'),
     'the conditional sections appear in the nav once they exist')

  // A nav link must scroll its section — a link that does nothing is the page
  // lying about itself. The stub DOM records `scrollIntoView`.
  const remoteBtn = findButton(full.root, 'Remote')
  ok(!!remoteBtn, 'the Remote link is there to click')
  remoteBtn.onclick({})
  const target = [...full.root.querySelectorAll('section')].find((s) => s.id === 'sec-remote')
  ok(!!target && !!target._scrollIntoView,
     'clicking a nav link scrolls its section into view')
}

// --- Remote Control: the viewer URL ------------------------------------------
// "How do I even access the Remote board?" — the section that set the relay up
// never said where the remote IS. The host derives the URL; the page shows it
// with the two ways to use it: open it, or copy it to a phone or a chat.
{
  const secOf = (v) => [...v.root.querySelectorAll('section')]
    .find((s) => s.textContent.includes('Remote Control'))

  const withViewer = await renderSettings(state({
    remote: {
      enabled: true, url: 'https://board.example.com', hasCode: true,
      viewerUrl: 'https://board.example.com/board',
    },
  }))
  const sec = secOf(withViewer)
  ok(sec.textContent.includes('https://board.example.com/board'),
     'the viewer URL a phone opens is shown on the page that sets the relay up')
  ok(sec.textContent.includes('Watch it from any browser'),
     'labelled as the way to watch, not as another config field')
  findButton(sec, 'Open').onclick({})
  ok(withViewer.posted.some((m) => m.type === 'openUrl'
       && m.url === 'https://board.example.com/board'),
     'Open asks the host to open the viewer in the default browser')
  findButton(sec, 'Copy').onclick({})
  ok(withViewer.posted.some((m) => m.type === 'copyText'
       && m.text === 'https://board.example.com/board'),
     'Copy posts the URL to the host clipboard — the webview has none of its own')

  const without = await renderSettings(state({
    remote: { enabled: true, url: 'https://board.example.com', hasCode: true },
  }))
  ok(!secOf(without).querySelector('.remote-viewer'),
     'no URL saved, no viewer row — a URL to nothing would be a button that lies')
}

// --- the model table's two ticks are explained -------------------------------
// "I can't select which models the AIs should be able to use" — the spawn tick
// arrived as an unlabeled box at each row's end. A legend above the list says
// what the two ticks mean, and it lives with the ticks, not on a closed row.
{
  const withCatalogue = state({
    providers: [{
      id: 'ds', label: 'DeepSeek', kind: 'gateway', detail: 'api.deepseek.com',
      active: true, hasCredential: true,
      models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', context: '128K', offered: true }],
    }],
  })
  const v = await renderSettings(withCatalogue)
  ok(!v.root.querySelector('.model-legend'),
     'the legend stays hidden while the catalogue is collapsed — it explains ticks that are not yet shown')
  findButton(v.root, 'models available').onclick()
  const legend = v.root.querySelector('.model-legend')
  ok(!!legend && legend.textContent.includes('allowed for spawned agents (split_task)'),
     'once the list is open, the legend says what the spawn tick means')
  ok(legend.textContent.includes('offered in the composer'),
     'and what the offer tick means — two ticks, two choices, both explained')
}

console.log(fails ? `\n${fails} failed` : '\nall settings-view tests passed')
process.exit(fails ? 1 : 0)
