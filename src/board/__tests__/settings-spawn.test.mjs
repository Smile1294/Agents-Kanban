/* The spawn-allowlist tick on the settings catalogue rows.

   Same harness as `settings-view.test.mjs` (which owns the rest of the page):
   media/settings.js runs against a stub DOM, and a webview script has no type
   checking — a runtime throw in it is a silently blank tab. This file covers
   only the ONE control the spawn policy added: the per-model "allowed for
   spawned agents" tick. The tick must POST the message the host's
   `parseMessage` accepts (`setSpawnAllowed`), with the checkbox state itself
   derived from the state the host sent — and it must remain a SEPARATE
   control from the composer's "offered" tick, because the two are different
   choices and a row that conflated them would let one click change both. */
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

const state = (models) => ({
  defaultRuntime: 'claude',
  // The backend section renders under the runtime that can be configured —
  // a `runtimes: []` state has nowhere to put the provider cards.
  runtimes: [{
    id: 'claude', label: 'Claude Code', vendor: 'Anthropic',
    blurb: 'Runs the Claude Code CLI on this machine.',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    providerProfiles: true,
  }],
  providers: [{
    id: 'ds', label: 'DeepSeek', kind: 'gateway', detail: 'api.deepseek.com',
    active: true, hasCredential: true, endpointHost: 'api.deepseek.com',
    models,
  }],
})

{
  const v = await renderSettings(state([
    { id: 'deepseek-chat', label: 'DeepSeek Chat', context: '128K', offered: true, spawnAllowed: true },
    { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', context: '128K', offered: false, spawnAllowed: false },
  ]))
  findButton(v.root, 'models available').onclick()

  const spawnTicks = v.root.querySelectorAll('.model-spawn')
  const offerTicks = v.root.querySelectorAll('.model-tick')
  ok(spawnTicks.length === 2, `every model row carries a spawn tick (${spawnTicks.length})`)
  ok(offerTicks.length === 2, 'beside the offered tick, not replacing it')
  ok(spawnTicks[0].checked === true && spawnTicks[1].checked === false,
     'and the tick reflects the state the host sent — allowed by default, not assumed')
  ok(offerTicks[0].checked === true && offerTicks[1].checked === false,
     'while the offered tick still reflects the profile list — the two are separate choices')

  // Unticking the allowed one posts the message parseMessage accepts, with the
  // ids that identify the row.
  spawnTicks[0].checked = false
  spawnTicks[0].onchange()
  const spawnPosts = v.posted.filter((m) => m.type === 'setSpawnAllowed')
  ok(spawnPosts.length === 1 && spawnPosts[0].id === 'ds' && spawnPosts[0].modelId === 'deepseek-chat'
    && spawnPosts[0].allowed === false,
    `the tick posts setSpawnAllowed with the profile, the model and the new state (${JSON.stringify(spawnPosts[0])})`)

  // The offered tick's own wire is untouched by the second control.
  offerTicks[1].checked = true
  offerTicks[1].onchange()
  const offerPosts = v.posted.filter((m) => m.type === 'setProfileModels')
  ok(offerPosts.length === 1 && JSON.stringify(offerPosts[0].models) === JSON.stringify(['deepseek-chat', 'deepseek-reasoner']),
     'and the offered tick still posts the offered list alone')

  // A state from an older host has no spawnAllowed — the tick must DEFAULT to
  // allowed, because absence is the allowed state, not a reason to render
  // every spawned model unticked.
  const legacy = await renderSettings(state([
    { id: 'deepseek-chat', label: 'DeepSeek Chat', context: '128K', offered: true },
  ]))
  findButton(legacy.root, 'models available').onclick()
  ok(legacy.root.querySelectorAll('.model-spawn')[0]?.checked === true,
     'a model with no spawnAllowed field renders allowed, never unticked')
}

console.log(fails ? `\n${fails} FAILED` : '\nPASS — the spawn tick is its own control and posts what the host parses')
process.exit(fails ? 1 : 0)
