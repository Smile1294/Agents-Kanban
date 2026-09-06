/* The remote board viewer: what the relay page shows.
 *
 * Reads the board the Agents Kanban extension pushes (see the remote/ README).
 * Same hygiene rule as the extension's own webviews: everything on this page —
 * chat rows especially — is another program's output, so nodes and text only,
 * no innerHTML, ever.
 *
 * Privacy without a login: the board's address is sha-256(pairing code) hex,
 * cut to 24 chars, and the relay keeps no secret of its own. The code is typed
 * once per browser, and only the derived id is kept (localStorage) — so the
 * page never holds anything the relay could be robbed for, and forgetting the
 * board is one button.
 *
 * Polling is adaptive so the free Netlify tier lasts: fast (12s) while the
 * board is moving, slow (60s) once it has been quiet — a quiet board does not
 * need watching every few seconds, and every poll is a function invocation.
 */
const root = document.getElementById('root')
const API = '/.netlify/functions/board'
const STORAGE = 'agents-kanban.remote'
const ACTIVE_MS = 30_000 // "moving" while the last push is fresher than this
const POLL_FAST = 12_000
const POLL_SLOW = 60_000
const POLL_ERROR = 15_000
const TICK_MS = 10_000 // age repaint cadence — not a network call

const saved = (() => {
  try { return JSON.parse(localStorage.getItem(STORAGE) || 'null') } catch { return null }
})()
let id = (saved && /^[0-9a-f]{24}$/i.test(saved.id || '')) ? saved.id : ''
let tvs = (saved && saved.tvs && typeof saved.tvs === 'object') ? saved.tvs : {}

let index = null // { at, columns, sessions }
let tails = {} // session key -> { at, entries }
let openKey = '' // the session whose chat is open
let error = ''
let waiting = false // the relay answered, but has no board yet
let polling = false // the poll chain runs once, however it started

const el = (tag, cls, text) => {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined && text !== null) n.textContent = String(text)
  return n
}

const since = (at) => {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (secs < 10) return 'just now'
  if (secs < 60) return secs + 's ago'
  const mins = Math.round(secs / 60)
  if (mins < 60) return mins + 'm ago'
  const hours = Math.round(mins / 60)
  return hours < 24 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago'
}

const saveState = () => {
  try { localStorage.setItem(STORAGE, JSON.stringify({ id, tvs })) } catch { /* private mode */ }
}

/* --- pairing ---------------------------------------------------------------- */

async function boardIdOf(code) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24)
}

function pairScreen() {
  const box = el('section', 'panel pair')
  box.appendChild(el('h1', '', 'Remote board'))
  box.appendChild(el('p', 'muted',
    'This page mirrors a board that the Agents Kanban extension pushes. Enter the ' +
    'pairing code you chose when you connected the relay (extension settings → ' +
    'Remote Control) to watch this board from here.'))
  const input = el('input', 'code')
  input.type = 'text'
  input.placeholder = 'The pairing code'
  input.autocomplete = 'off'
  input.spellcheck = false
  const err = el('p', 'error hidden', '')
  const go = el('button', 'primary', 'Watch the board')
  const watch = async () => {
    const code = input.value.trim()
    if (!code) { err.textContent = 'A pairing code is needed.'; err.classList.remove('hidden'); return }
    err.classList.add('hidden')
    try {
      id = await boardIdOf(code)
    } catch (e) {
      err.textContent = 'This browser cannot derive a board address: ' + String(e)
      err.classList.remove('hidden')
      return
    }
    tvs = {}
    openKey = ''
    saveState()
    render()
    ensurePolling()
  }
  go.addEventListener('click', watch)
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') watch() })
  box.append(input, go, err)
  // The board address is the id; a link to it skips the code on a new device.
  const m = /^#([0-9a-f]{24})$/.exec(location.hash)
  if (m) { id = m[1].toLowerCase(); saveState() }
  return box
}

/* --- the board -------------------------------------------------------------- */

function agentText(c) {
  const a = c.agent || {}
  if (a.kind === 'interrupted') return 'Interrupted — the machine went away'
  if (a.kind === 'queued') return 'Queued — waiting to start'
  return (a.kind || 'working') + (a.tool ? ' — ' + a.tool : '')
}

function statusRow() {
  const row = el('div', 'status')
  if (!index) {
    row.appendChild(el('span', 'dot idle'))
    row.appendChild(el('span', '', waiting
      ? 'Waiting for the first push from the extension.'
      : 'Checking the relay…'))
    return row
  }
  const dot = el('span', 'dot ok')
  dot.setAttribute('data-live-dot', String(index.at))
  row.appendChild(dot)
  const t = el('span', 'age', 'Last push ' + since(index.at))
  t.dataset.kind = 'push'
  t.setAttribute('data-at', String(index.at))
  row.appendChild(t)
  return row
}

function cardNode(key, s) {
  const n = el('button', 'card')
  n.type = 'button'
  n.title = 'Open the chat for ' + s.title
  n.appendChild(el('strong', 'card-title', s.title))
  if (s.agent) {
    const a = el('span', 'agent-line')
    a.appendChild(el('span', 'dot small ' + (s.agent.kind === 'interrupted' ? 'bad' : 'live')))
    a.appendChild(el('span', '', agentText(s)))
    n.appendChild(a)
  }
  if (s.tags && s.tags.length) n.appendChild(el('span', 'tags', s.tags.join(' · ')))
  const meta = el('span', 'muted small age', 'updated ' + since(s.updated))
  meta.dataset.kind = 'updated'
  meta.setAttribute('data-at', String(s.updated))
  n.appendChild(meta)
  n.addEventListener('click', () => { openKey = key; render() })
  return n
}

function boardScreen() {
  const head = el('header', 'head')
  head.appendChild(el('h1', '', 'Remote board'))
  const forget = el('button', 'link danger', 'Forget this board')
  forget.title = 'Stops this browser watching. The board stays on the relay until the extension pauses or repoints it.'
  forget.addEventListener('click', () => {
    localStorage.removeItem(STORAGE)
    location.reload()
  })
  head.appendChild(forget)
  const wrap = el('main', 'board-wrap')
  wrap.appendChild(statusRow())
  if (error) wrap.appendChild(el('p', 'error', error))

  if (!index) {
    wrap.appendChild(el('p', 'muted', waiting
      ? 'Nothing has arrived yet. Open Agents Kanban → settings → Remote Control and press "Save and connect". This page updates by itself.'
      : 'The relay did not answer. Check that the site is deployed.'))
    root.replaceChildren(head, wrap)
    return
  }

  const board = el('div', 'board')
  const cols = index.columns || []
  const keys = Object.keys(index.sessions || {})
  const columnFor = (cid, name, placed) => {
    const col = el('section', 'column')
    col.appendChild(el('h2', '', name))
    const list = el('div', 'cards')
    for (const key of placed) list.appendChild(cardNode(key, index.sessions[key]))
    if (!placed.length) list.appendChild(el('p', 'muted empty', 'Nothing here'))
    col.appendChild(list)
    return col
  }
  for (const c of cols) {
    board.appendChild(columnFor(c.id, c.name || c.id, keys.filter((k) => index.sessions[k].phase === c.id)))
  }
  // Cards whose phase matches no column still get a home — a phase the board
  // used to have must not make its sessions vanish from the page.
  const unplaced = keys.filter((k) => !cols.some((c) => c.id === index.sessions[k].phase))
  if (unplaced.length) board.appendChild(columnFor(null, 'Elsewhere', unplaced))
  wrap.appendChild(board)
  if (openKey) wrap.appendChild(chatPanel(openKey))
  root.replaceChildren(head, wrap)
}

/* --- the chat --------------------------------------------------------------- */

function chatPanel(key) {
  const s = index.sessions[key]
  const panel = el('section', 'chat')
  const head = el('div', 'chat-head')
  const back = el('button', 'link', '← Board')
  back.addEventListener('click', () => { openKey = ''; render() })
  head.appendChild(back)
  if (s) head.appendChild(el('strong', 'chat-title', s.title))
  panel.appendChild(head)

  const tail = tails[key]
  if (!tail || !tail.entries || !tail.entries.length) {
    panel.appendChild(el('p', 'muted', 'No chat has arrived for this session yet.'))
    return panel
  }
  for (const e of tail.entries) panel.appendChild(entryNode(e))
  return panel
}

function entryNode(e) {
  const row = el('div', 'entry e-' + e.kind)
  const when = el('span', 'when', timeOf(e.at))
  when.title = new Date(e.at).toLocaleString()
  const done = () => { row.prepend(when); return row }
  switch (e.kind) {
    case 'prompt': {
      row.appendChild(el('span', 'who you', 'You'))
      const body = el('div', 'prompt-body')
      if (e.text) body.appendChild(el('div', 'text', e.text))
      if (e.images) body.appendChild(el('div', 'muted small',
        '🖼 attached ' + e.images + (e.images === 1 ? ' image' : ' images')))
      row.appendChild(body)
      return done()
    }
    case 'text':
      row.appendChild(el('span', 'who', 'Agent'))
      row.appendChild(el('div', 'text', e.text))
      return done()
    case 'thinking': {
      const det = el('details', 'thinking')
      const sum = el('summary', '', 'Thinking')
      det.appendChild(sum)
      det.appendChild(el('div', 'text muted', e.text))
      row.appendChild(det)
      return done()
    }
    case 'tool': {
      const line = el('div', 'tool-line')
      line.appendChild(el('code', '', e.name))
      line.appendChild(el('span', 'muted small',
        (e.status === 'running' ? 'running' : e.status === 'error' ? 'failed' : 'ok')
        + (e.durationMs !== undefined ? ' · ' + humanMs(e.durationMs) : '')))
      row.append(when, line)
      if (e.children && e.children.length) {
        const nest = el('div', 'subagent')
        nest.appendChild(el('div', 'muted small', 'subagent:'))
        for (const c of e.children) nest.appendChild(entryNode(c))
        row.appendChild(nest)
      }
      return row
    }
    case 'phase': {
      const line = el('span', '', '→ ' + e.to + (e.note ? ' — ' + e.note : ''))
      row.append(when, line)
      return row
    }
    case 'result':
      row.append(when, el('span', 'done',
        'Done' + (e.summary ? ': ' + e.summary : '') + (e.durationMs !== undefined ? ' (' + humanMs(e.durationMs) + ')' : '')))
      return row
    case 'notice':
      row.append(when, el('span', e.urgency === 'blocked' ? 'blocked' : 'muted', e.message))
      return row
    case 'error':
      row.append(when, el('span', 'error', e.message))
      return row
    default:
      row.append(when, el('span', 'muted', '(a row this viewer does not know)'))
      return row
  }
}

const timeOf = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const humanMs = (ms) => (ms < 60_000 ? Math.round(ms / 1000) + 's' : Math.round(ms / 60000) + 'm')

/* --- polling ---------------------------------------------------------------- */

async function poll() {
  if (!id) return
  let next = POLL_ERROR
  error = ''
  try {
    const res = await fetch(API + '?id=' + encodeURIComponent(id))
    if (res.status === 404) {
      waiting = true
      index = null
      render()
      next = POLL_ERROR
    } else if (!res.ok) {
      error = 'The relay answered ' + res.status + '.'
      render()
    } else {
      const { index: fresh } = await res.json()
      waiting = false
      index = fresh
      // Fetch the tails the index says changed since this browser last looked.
      const freshTvs = {}
      for (const key of Object.keys(fresh.sessions)) {
        const tv = fresh.sessions[key].tv
        freshTvs[key] = tv
        if ((tvs[key] || 0) !== tv) await fetchTail(key)
      }
      // Sessions that left the board leave with their chats.
      for (const key of Object.keys(tails)) {
        if (!(key in fresh.sessions)) delete tails[key]
      }
      tvs = freshTvs
      saveState()
      next = Date.now() - fresh.at < ACTIVE_MS ? POLL_FAST : POLL_SLOW
      render()
    }
  } catch (e) {
    error = 'Could not reach the relay: ' + (e && e.message ? e.message : e)
    render()
  }
  setTimeout(poll, next)
}

/** Start the poll chain exactly once. Pairing happens after boot, so the
 *  first `poll()` may have returned before an id existed. */
function ensurePolling() {
  if (polling) return
  polling = true
  poll()
}

async function fetchTail(key) {
  try {
    const res = await fetch(API + '?id=' + encodeURIComponent(id) + '&tail=' + encodeURIComponent(key))
    if (!res.ok) return
    const { tail } = await res.json()
    if (tail && Array.isArray(tail.entries)) tails[key] = tail
  } catch {
    // A tail that fails to load is retried on the next poll: the index still
    // says its tv is newer than what this browser holds.
  }
}

/* --- render + the age tick -------------------------------------------------- */

function render() {
  root.replaceChildren(id ? boardScreen() : pairScreen())
}

// Between polls the ages would lie still. "Never show a signal that cannot say
// bad": a machine that stopped pushing must read as stopped, not frozen mid-
// "live". These repaints touch only the age text and the live dot — never the
// chat scroll position.
function tick() {
  const now = Date.now()
  for (const n of root.querySelectorAll('.age')) {
    const at = Number(n.getAttribute('data-at'))
    if (!Number.isFinite(at)) continue
    const age = now - at
    n.textContent = (n.dataset.kind === 'push' ? 'Last push ' : 'updated ') + since(at)
    if (n.dataset.kind === 'push') {
      const dot = root.querySelector('[data-live-dot]')
      if (dot) dot.className = 'dot ' + (age < 120_000 ? 'ok' : age < 600_000 ? 'warn' : 'bad')
    }
  }
}

render()
setInterval(tick, TICK_MS)
ensurePolling()
