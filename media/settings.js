/* The settings page.
 *
 * Same rules as board.js, and for the same reasons:
 *
 *  - **No innerHTML, ever.** Every string here — an account name, a CLI version,
 *    a gateway URL, an error from another program — is somebody else's output.
 *    Everything is built as nodes and set as text.
 *  - **Anything the user put into a state carries a key**, because render()
 *    replaces the whole tree. There are no scroll containers rebuilt mid-typing
 *    on this page, but the same discipline applies to the one piece of state it
 *    does hold: which runtime card is expanded, kept module-level rather than in
 *    the DOM.
 *
 * The page's job is to say what is TRUE, including when that is "I could not
 * tell". Four login states render as four different rows with four different
 * actions; none of them is a green tick that means "a config file exists".
 */
// @ts-nocheck
const vscode = acquireVsCodeApi()

/** Which runtime cards are expanded. Module-level: a render() would destroy it
 *  if it lived in the DOM, exactly as with the board's disclosures. */
const expanded = new Set()

let state = { runtimes: [], providers: [], defaultRuntime: 'claude' }
let error = ''

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined && text !== null) n.textContent = String(text)
  return n
}

function button(label, cls, onClick, opts) {
  const b = el('button', cls, label)
  b.type = 'button'
  if (opts && opts.title) b.title = opts.title
  if (opts && opts.disabled) b.disabled = true
  b.addEventListener('click', onClick)
  return b
}

function post(msg) { vscode.postMessage(msg) }

/* --- login state, rendered honestly ---------------------------------------
 *
 * The four cases have four different fixes, so they get four different rows.
 * Collapsing them into "connected / not connected" is what makes a settings
 * page useless: "not installed" and "installed but signed out" look identical
 * and neither tells you what to type.
 */
function loginRow(card) {
  const st = card.status
  const row = el('div', 'status-row')
  if (!st) {
    row.appendChild(el('span', 'dot unknown'))
    row.appendChild(el('span', 'status-text', 'Not checked yet.'))
    row.appendChild(button('Check', 'link', () => post({ type: 'refresh', runtime: card.id })))
    return row
  }

  const login = st.login
  switch (login.kind) {
    case 'signedIn': {
      row.appendChild(el('span', 'dot ok'))
      const via = login.via === 'subscription' ? 'subscription'
        : login.via === 'apiKey' ? 'API key'
        : 'cloud credentials'
      const who = login.account ? ` as ${login.account}` : ''
      const plan = login.plan ? ` · ${login.plan}` : ''
      row.appendChild(el('span', 'status-text', `Signed in${who} (${via})${plan}`))
      break
    }
    case 'signedOut':
      row.appendChild(el('span', 'dot bad'))
      row.appendChild(el('span', 'status-text', 'Not signed in.'))
      row.appendChild(el('code', 'fix', login.fix))
      break
    case 'notInstalled':
      row.appendChild(el('span', 'dot bad'))
      row.appendChild(el('span', 'status-text', 'Not installed on this machine.'))
      row.appendChild(el('code', 'fix', login.fix))
      break
    case 'unknown':
    default:
      // Deliberately NOT shown as signed out. We failed to ask; saying "no"
      // would be claiming a state we did not read.
      row.appendChild(el('span', 'dot unknown'))
      row.appendChild(el('span', 'status-text', 'Could not tell — the agent did not answer.'))
      row.appendChild(el('span', 'muted', login.reason || ''))
      break
  }
  return row
}

function whereRow(card) {
  const st = card.status
  if (!st || !st.location) return null
  const row = el('div', 'where')
  const source = st.location.source === 'setting' ? 'from your settings'
    : st.location.source === 'path' ? 'on your PATH'
    : 'in a standard location'
  row.appendChild(el('code', '', st.location.command))
  row.appendChild(el('span', 'muted', ` ${source}`))
  if (st.location.version) row.appendChild(el('span', 'muted', ` · ${st.location.version}`))
  return row
}

function modelsRow(card) {
  const wrap = el('div', 'models')
  if (!card.models || !card.models.length) {
    wrap.appendChild(button('List the models this agent can run', 'link',
      () => post({ type: 'refreshModels', runtime: card.id })))
    return wrap
  }
  const list = el('div', 'chips')
  for (const m of card.models) list.appendChild(el('span', 'chip', m.label || m.id))
  wrap.appendChild(list)
  // Where the list came from is not decoration. "Why is the model I use missing
  // here?" has to be answerable from this page.
  if (card.modelSource) {
    const note = card.modelSource === 'runtime' ? 'Listed by the agent itself.'
      : card.modelSource === 'cache' ? "From the agent's own cache."
      : card.modelSource === 'profile' ? 'Listed by this provider profile.'
      : 'Built-in list — the agent did not answer, so this may be missing models your account has.'
    wrap.appendChild(el('div', 'muted small', note))
  }
  if (card.modelNote) wrap.appendChild(el('div', 'muted small', card.modelNote))
  wrap.appendChild(button('Refresh', 'link', () => post({ type: 'refreshModels', runtime: card.id })))
  return wrap
}

function runtimeCard(card) {
  const box = el('section', 'agent-card')
  if (card.id === state.defaultRuntime) box.classList.add('is-default')

  const head = el('div', 'agent-head')
  const titles = el('div', 'agent-titles')
  titles.appendChild(el('h3', '', card.label))
  titles.appendChild(el('span', 'muted', card.vendor))
  head.appendChild(titles)

  const actions = el('div', 'agent-actions')
  if (card.id === state.defaultRuntime) {
    actions.appendChild(el('span', 'badge', 'New sessions use this'))
  } else {
    actions.appendChild(button('Use for new sessions', 'primary',
      () => post({ type: 'setDefaultRuntime', runtime: card.id })))
  }
  head.appendChild(actions)
  box.appendChild(head)

  box.appendChild(el('p', 'blurb', card.blurb))
  box.appendChild(loginRow(card))
  const where = whereRow(card)
  if (where) box.appendChild(where)

  const tools = el('div', 'agent-tools')
  const st = card.status
  if (st && st.login.kind === 'notInstalled') {
    tools.appendChild(button('Copy the install command', 'link',
      () => post({ type: 'install', runtime: card.id })))
  } else if (st && st.login.kind === 'signedOut') {
    tools.appendChild(button('Open a terminal to sign in', 'link',
      () => post({ type: 'signIn', runtime: card.id })))
  }
  tools.appendChild(button('Check again', 'link', () => post({ type: 'refresh', runtime: card.id })))
  box.appendChild(tools)

  box.appendChild(modelsRow(card))

  if (!card.providerProfiles) {
    // Saying WHY there is nothing to configure is the point. Otherwise the
    // absence of provider settings reads as a missing feature.
    box.appendChild(el('div', 'muted small',
      'This agent signs in as itself, so there is no backend to point at and nothing to configure. ' +
      'No proxy, no API key, no endpoint.'))
  }
  return box
}

function providerSection() {
  const box = el('section', 'panel')
  const head = el('div', 'panel-head')
  head.appendChild(el('h2', '', 'Backends for Claude Code'))
  head.appendChild(button('Add a backend…', 'primary', () => post({ type: 'addProvider' })))
  box.appendChild(head)
  box.appendChild(el('p', 'blurb',
    'Which service Claude Code talks to: Anthropic directly, a cloud that resells it, or a gateway ' +
    'you run. This applies to Claude Code sessions only — it is environment on the CLI process, ' +
    'and it takes effect on the NEXT session rather than one already running.'))

  if (!state.providers.length) {
    box.appendChild(el('div', 'muted', 'No profiles yet. The default inherits whatever your shell already sets.'))
    return box
  }

  const list = el('div', 'rows')
  for (const p of state.providers) {
    const row = el('div', 'row' + (p.active ? ' active' : ''))
    const left = el('div', 'row-main')
    const name = el('div', 'row-title')
    name.appendChild(el('span', '', p.label))
    if (p.active) name.appendChild(el('span', 'badge', 'Active'))
    if (p.hasCredential) name.appendChild(el('span', 'badge quiet', 'Key in keychain'))
    left.appendChild(name)
    left.appendChild(el('div', 'muted small', p.detail || p.kind))
    row.appendChild(left)

    const acts = el('div', 'row-actions')
    if (!p.active) acts.appendChild(button('Use', 'link', () => post({ type: 'selectProvider', id: p.id })))
    acts.appendChild(button('Test', 'link', () => post({ type: 'testProvider', id: p.id })))
    acts.appendChild(button('Edit', 'link', () => post({ type: 'editProvider', id: p.id })))
    acts.appendChild(button('Remove', 'link danger', () => post({ type: 'removeProvider', id: p.id })))
    row.appendChild(acts)
    list.appendChild(row)
  }
  box.appendChild(list)
  return box
}

function render() {
  const root = document.getElementById('root')
  root.textContent = ''

  const page = el('div', 'settings-page')

  const header = el('header', 'settings-header')
  header.appendChild(el('h1', '', 'Agents Kanban'))
  header.appendChild(el('p', 'blurb',
    'Which agent programs this board can run, and what they are signed into. ' +
    'Model, effort and thinking stay on the composer, because those are per session.'))
  page.appendChild(header)

  if (error) {
    const e = el('div', 'error-banner')
    e.appendChild(el('strong', '', 'Something went wrong: '))
    e.appendChild(el('span', '', error))
    page.appendChild(e)
  }

  if (state.busy) page.appendChild(el('div', 'busy', state.busy))

  const agents = el('section', 'panel')
  const ahead = el('div', 'panel-head')
  ahead.appendChild(el('h2', '', 'Agents'))
  ahead.appendChild(button('Check all again', 'link', () => post({ type: 'refresh' })))
  agents.appendChild(ahead)
  if (!state.runtimes.length) {
    agents.appendChild(el('div', 'muted', 'Checking…'))
  } else {
    for (const card of state.runtimes) agents.appendChild(runtimeCard(card))
  }
  page.appendChild(agents)

  // Only shown when at least one runtime actually takes provider profiles.
  // Offering a backend picker for a board whose agents all sign in as
  // themselves would be a setting that cannot take effect.
  if (state.runtimes.some((r) => r.providerProfiles)) page.appendChild(providerSection())

  const foot = el('footer', 'settings-footer')
  foot.appendChild(el('span', 'muted small',
    'Paths and advanced options live in VS Code settings under "Agents Kanban".'))
  foot.appendChild(button('Open VS Code settings', 'link',
    () => post({ type: 'openSetting', key: 'agentsKanban' })))
  page.appendChild(foot)

  root.appendChild(page)
}

window.addEventListener('message', (e) => {
  const msg = e.data
  if (!msg || msg.type !== 'state') return
  state = msg.state || { runtimes: [], providers: [], defaultRuntime: 'claude' }
  error = msg.error || ''
  render()
})

render()
post({ type: 'ready' })
