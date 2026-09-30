/* "Run in the cloud" in the real media/board.js, against the stub DOM.
 *
 * The view has no type checking, so everything the feature promises on screen
 * is asserted here: the box appears only when the host OFFERS it, a tick
 * survives the repaints an agent at work produces, it changes what is sent and
 * which pickers are drawn, and a card in the cloud never pretends to be a
 * local run — no spinner it cannot justify, no Run app or Merge over a
 * worktree its work is not in, no model picker it would ignore.
 */
import { boardSource, findByTag, renderBoardWith, walk } from '../../../test/dom.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const src = await boardSource()
const COLUMNS = [
  { id: 'planning', name: 'Planning', category: 'unstarted' },
  { id: 'implementing', name: 'Implementing', category: 'started' },
  { id: 'validating', name: 'Validating', category: 'review' },
  { id: 'complete', name: 'Complete', category: 'done', humanOnly: true },
]
const COMPOSER = {
  model: 'claude-opus-5', effort: 'high', thinking: 'enabled',
  models: [{ id: 'claude-opus-5', label: 'Opus 5', context: '200K' }],
  efforts: [{ key: 'low', label: 'Low' }, { key: 'high', label: 'High' }],
  contextTokens: 0, permissionMode: 'acceptEdits',
  permissionModes: [{ key: 'acceptEdits', label: 'Auto-accept edits', detail: 'File edits go through' }],
  agent: 'claude|inherit', agents: [{ key: 'claude|inherit', label: 'Claude Code', detail: 'Anthropic', runtime: 'claude', provider: 'inherit' }],
  runtimes: [{ id: 'claude', label: 'Claude Code' }],
  orchestrationLevels: [{ key: 'balanced', label: 'Balanced', detail: 'd' }],
}
const base = { ready: true, mode: 'chat', columns: COLUMNS, cards: [], composer: COMPOSER, running: 0, waiting: 0 }

const byClass = (root, cls) => walk(root).filter((n) => String(n.className || '').split(/\s+/).includes(cls))
const input = (root) => findByTag(root, 'input', (n) => n.type === 'checkbox')
const textarea = (root) => findByTag(root, 'textarea')
const sendButton = (root) => walk(root).find((n) => n.tagName === 'button' && String(n.className).includes('send'))
function type(v, text) {
  const ta = textarea(v.root)
  ta.value = text
  ta.oninput({ target: ta })
}

console.log('\n— the box, on the new-session screen')
{
  const none = renderBoardWith(src, base)
  ok(!byClass(none.root, 'cloud-pick').length, 'not drawn when the host does not offer it — never greyed out')

  const v = renderBoardWith(src, { ...base, composer: { ...COMPOSER, cloud: { state: 'ok', plan: 'max' } } })
  const pick = byClass(v.root, 'cloud-pick')[0]
  ok(!!pick, 'drawn when the host offers it')
  ok(pick?.tagName === 'label' && !!input(v.root), 'as a real checkbox inside a label, so the whole chip is the target')
  ok(String(pick?.className).includes('ctl'), 'in the bar\'s one control geometry')
  ok(/max plan/.test(pick?.title || '') && /no GitHub is needed/.test(pick?.title || ''), 'its title says the plan and that no GitHub is needed')
  ok(v.text().includes('Opus 5'), 'unticked, the model picker is there')

  const box = input(v.root)
  box.checked = true
  box.onchange()
  ok(input(v.root)?.checked === true, 'the tick survives the repaint it causes')
  v.deliver({ ...base, composer: { ...COMPOSER, cloud: { state: 'ok', plan: 'max' } } })
  ok(input(v.root)?.checked === true, 'and the next state frame — it lives outside the DOM')
  ok(!v.text().includes('Opus 5'), 'ticked, the model picker steps aside: the CLI drops the model on the way to the cloud')
  ok(!v.text().includes('Balanced'), 'so does the split dial: a cloud session has no board tools to split with')
  ok(v.text().includes('Auto-accept edits'), 'the permission picker stays — the CLI does forward that')
  ok(/in the cloud/.test(textarea(v.root)?.placeholder || ''), 'the prompt says where it will run')

  type(v, 'Fix the flaky auth test')
  sendButton(v.root).onclick()
  const sent = v.posted.filter((m) => m.type === 'newSession').pop()
  ok(sent?.cloud === true && sent?.text === 'Fix the flaky auth test', 'starting it asks the host for a cloud session')

  // The host withdrew the offer (a backend switch, a login change) while the
  // tick was still set: nothing may ride along.
  v.deliver({ ...base, composer: { ...COMPOSER } })
  ok(!byClass(v.root, 'cloud-pick').length, 'the box goes when the offer does')
  type(v, 'second')
  sendButton(v.root).onclick()
  const again = v.posted.filter((m) => m.type === 'newSession').pop()
  ok(again && again.cloud === undefined, 'and a leftover tick does not send the session to the cloud')
  ok(v.text().includes('Opus 5'), 'with the model picker back')
}

console.log('\n— the box is there before the login answers, and when it says no')
{
  const checking = renderBoardWith(src, { ...base, composer: { ...COMPOSER, cloud: { state: 'checking' } } })
  ok(byClass(checking.root, 'cloud-pick').length === 1, 'drawn while the login is still being checked — never a missing button')
  ok(/Checking/.test(byClass(checking.root, 'cloud-pick')[0]?.title || ''), 'and its title says it is checking')

  const reason = 'Claude Code is using an API key (ANTHROPIC_API_KEY).'
  const no = renderBoardWith(src, { ...base, composer: { ...COMPOSER, cloud: { state: 'no', reason } } })
  const pick = byClass(no.root, 'cloud-pick')[0]
  ok(!!pick && String(pick.className).includes('unavailable'), 'drawn on a login that cannot go, marked as not ready')
  ok(!no.text().includes(reason), 'the reason is not shouted at someone who never asked')
  const box = input(no.root)
  box.checked = true
  box.onchange()
  ok(no.text().includes(reason), 'ticked, the bar says why it cannot go')
  type(no, 'try it')
  sendButton(no.root).onclick()
  ok(no.posted.filter((m) => m.type === 'newSession').pop()?.cloud === true,
    'and starting still asks the host, which refuses in a modal with the same reason')
}

console.log('\n— the side bar offers a cloud session too')
{
  const side = renderBoardWith(src, { ...base, mode: 'kanban', composer: { ...COMPOSER, cloud: { state: 'ok' } } }, { layout: 'control' })
  const btn = walk(side.root).find((n) => n.tagName === 'button' && /New cloud session/.test(n.textContent))
  ok(!!btn, 'a "☁ New cloud session" button next to "+ New session"')
  btn?.onclick?.()
  ok(side.posted.some((m) => m.type === 'newSessionPrompt' && m.cloud === true), 'which asks the host for a task to run in the cloud')
  const none = renderBoardWith(src, { ...base, mode: 'kanban', composer: { ...COMPOSER } }, { layout: 'control' })
  ok(!walk(none.root).some((n) => n.tagName === 'button' && /New cloud session/.test(n.textContent)), 'and is absent where the agent cannot go at all')
}

console.log('\n— a card in the cloud, detached')
{
  const card = {
    key: 'session_01ViewTest000000001', sessionId: 'session_01ViewTest000000001', title: 'Auth test',
    phase: 'implementing', tags: [], updated: Date.now(), branch: 'task/x', worktree: '/r/.agentskanban/worktrees/x',
    cloud: { via: 'detached' },
  }
  const v = renderBoardWith(src, {
    ...base, cards: [card], selectedKey: card.key,
    composer: { ...COMPOSER, cloud: { state: 'ok', plan: 'max' }, cloudCard: { via: 'detached' } },
    transcript: [
      { kind: 'prompt', at: Date.now(), text: 'Fix the flaky auth test' },
      { kind: 'notice', at: Date.now(), urgency: 'info', message: "Running on Anthropic's cloud (https://claude.ai/code/x). The board cannot read its replies." },
    ],
  })
  ok(!byClass(v.root, 'cloud-pick').length, 'the new-session box is not on an existing card')
  ok(!v.text().includes('Opus 5'), 'no model picker for a session that runs whatever its environment picks')
  ok(!v.text().includes('Auto-accept edits'), 'nor a permission picker')
  const chip = byClass(v.root, 'cloud-chip')[0]
  ok(!!chip && /replies on claude\.ai/.test(chip.textContent), 'the bar says where it is and where the replies are')
  ok(/Message the cloud session/.test(textarea(v.root)?.placeholder || ''), 'and the prompt says the reply is elsewhere')
  const banner = byClass(v.root, 'cloud-banner')[0]
  ok(!!banner && /cannot read its replies/.test(banner.textContent), 'the chat says how much the board can see')
  ok(!walk(v.root).some((n) => n.tagName === 'button' && /Run app|Merge|Browser/.test(n.textContent)),
    'no Run app, Merge or Browser over a worktree its work is not in')
  ok(!v.text().includes('Changes'), 'nor a Changes panel that would say "nothing changed"')
  const open = walk(v.root).find((n) => n.tagName === 'button' && n.textContent === 'Open on claude.ai')
  ok(!!open, 'one click to the session')
  open.onclick({ stopPropagation() {}, preventDefault() {} })
  const post = v.posted.filter((m) => m.type === 'openCloud').pop()
  ok(post?.id === card.key && post.url === undefined, 'which asks the host by KEY — the page never hands it a URL to open')
}

console.log('\n— on the board')
{
  const cloud = { key: 'session_01KanbanTest00000001', title: 'In the cloud', phase: 'implementing', tags: [], updated: Date.now() - 5 * 60_000, worktree: '/w', cloud: { via: 'detached' } }
  const local = { key: 'l1', title: 'Stopped here', phase: 'implementing', tags: [], updated: Date.now(), worktree: '/w2', stalled: Date.now() - 60_000 }
  const v = renderBoardWith(src, { ...base, mode: 'kanban', cards: [cloud, local] })
  const cards = walk(v.root).filter((n) => n.tagName === 'article')
  const cc = cards.find((n) => n.textContent.includes('In the cloud'))
  ok(!!cc && cc.textContent.includes('☁ cloud'), 'a cloud card wears the tag')
  ok(!!cc && byClass(cc, 'cloud-strip').length === 1, 'and says where its work is')
  ok(!!cc && !byClass(cc, 'running').length && !String(cc.className).includes('running'), 'with no spinner — nothing here can say it is running')
  ok(!!cc && !cc.textContent.includes('Stopped'), 'and is never "stopped" — nothing was going to run here')
}

console.log(fails ? `\ncloud-view: ${fails} FAILED` : '\ncloud-view: all ok')
process.exit(fails ? 1 : 0)
