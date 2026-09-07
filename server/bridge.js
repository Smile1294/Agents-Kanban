/** The browser half of the headless board.
 *
 * The page loads the REAL board (media/board.js) and the REAL settings page
 * (media/settings.js). Those two expect to be inside a VS Code webview:
 * `acquireVsCodeApi()` and host messages arriving as `window` message events.
 * This file is the webview. postMessage becomes a POST, host→view frames
 * arrive over an EventSource and are re-dispatched as window messages, and the
 * dialogs a webview never has to draw (quick picks, input boxes, modal
 * confirmations) are drawn here as overlays.
 *
 * One more job: the pairing code gate. The CODE is the long-lived secret and
 * it is used ONCE — to exchange for a short-lived TOKEN (POST /api/session).
 * sessionStorage then holds the token (`x-rc-token` on every request; `?token=`
 * on the EventSource, which cannot set headers) and keeps the code ONLY so a
 * dead token — expired, revoked, or a server restart — can be re-exchanged
 * once without asking the user again. When even that fails, the gate returns
 * with an explanation. Neither the code nor the token is ever printed to the
 * console or put in the URL bar.
 */
;(function () {
  'use strict'
  const surface = document.currentScript.dataset.surface === 'settings' ? 'settings' : 'board'
  const CODE_KEY = 'ak-code'
  const TOKEN_KEY = 'ak-token'

  const code = () => sessionStorage.getItem(CODE_KEY) ?? ''
  const token = () => sessionStorage.getItem(TOKEN_KEY) ?? ''
  const setToken = (t) => sessionStorage.setItem(TOKEN_KEY, t)
  const forget = () => { sessionStorage.removeItem(CODE_KEY); sessionStorage.removeItem(TOKEN_KEY) }

  /** Exchange the stored code for a fresh token. Returns the token, or
   *  { status, body } when the server refused it, or null when there is no
   *  code to exchange or the board did not answer. */
  async function exchange() {
    const c = code()
    if (!c) return null
    let res
    try {
      res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: c }),
      })
    } catch { return null }
    if (res.status === 200) {
      let parsed = null
      try { parsed = await res.json() } catch { /* fall through */ }
      if (parsed && typeof parsed.token === 'string' && parsed.token) {
        setToken(parsed.token)
        return parsed.token
      }
      return null
    }
    let body = ''
    try { body = await res.text() } catch { /* keep '' */ }
    return { status: res.status, body }
  }

  // The code is kept only to re-exchange — and only ONCE per page life, or a
  // loop of dead tokens and re-exchanges would chase its own tail.
  let reexchanged = false
  let stream = null

  /** One 401 recovery: kill the dead stream, re-exchange the code once, tell
   *  the caller whether a fresh token is now stored. Shows the gate — with an
   *  honest note — when the session cannot be recovered. */
  async function recoverAuth() {
    if (reexchanged) return false
    reexchanged = true
    const expired = !code() // a token died and there is nothing left to re-exchange it with
    closeStream()
    const ex = await exchange()
    if (typeof ex === 'string') return true
    showGate(noteFor(ex, expired))
    return false
  }

  function closeStream() {
    if (stream) { stream.close(); stream = null }
  }

  const GATE_DEFAULT = 'This board is locked with a pairing code. The server printed it when it started.'
  function noteFor(ex, expired) {
    if (ex === null) {
      return expired ? 'The session expired — enter the pairing code again.' : 'The board did not answer — is the server still running?'
    }
    if (ex.status === 429 || ex.status === 403) return ex.body || 'Too many failed attempts — wait a while, then try again.'
    return 'That code was not accepted — it may have changed. Check the one the server printed.'
  }

  /** fetch with the session token. On a 401 — a token the server no longer
   *  accepts — re-exchange once and retry the request; when that fails the
   *  gate is up and the response is returned as it stood. */
  async function api(path, body, method) {
    let res
    try {
      res = await fetch(path, {
        method: method ?? (body ? 'POST' : 'GET'),
        headers: { 'content-type': 'application/json', 'x-rc-token': token() },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch (e) {
      // Network: surface it as a toast so the user knows the board is
      // unreachable rather than pretending nothing happened, and return a
      // response that cannot be mistaken for a server answer.
      toast({ level: 'error', text: 'The board did not answer — is the server still running?' })
      return { status: 0, ok: false }
    }
    if (res.status === 401 && (await recoverAuth())) return api(path, body, method)
    return res
  }

  // --- the webview API the app scripts expect --------------------------------
  const state = {}
  window.acquireVsCodeApi = () => ({
    postMessage: async (msg) => {
      // The app script posts its boot `ready` the moment it loads — while the
      // gate is still up and no token exists yet. That message is the very
      // thing `ready` after the stream connects repeats, so drop it here
      // instead of sending an unauthenticated request (and its wrong-note 401).
      if (!code() && !token()) return true
      let res = await api('/api/msg?surface=' + surface, msg)
      if (res.status === 409) {
        // The surface does not exist yet — the extension creates its panel
        // lazily, and a page load is the first click in this room.
        await api('/api/open', { surface })
        res = await api('/api/msg?surface=' + surface, msg)
      }
      return true
    },
    getState: () => state,
    setState: (s) => Object.assign(state, s),
  })

  // Host frames arrive here, then get re-dispatched exactly as the webview's
  // window message event would carry them. Control frames are ours, not the
  // app's: `remote` is not a case in either app script, and dialogs/toasts
  // must not fall through to them.
  function onFrame(frame) {
    if (frame && frame.type === 'remote') return onControl(frame)
    window.postMessage(frame, '*')
  }

  function onControl(frame) {
    if (frame.kind === 'toast') return toast(frame.spec)
    if (frame.kind === 'dialog') return dialog(frame.id, frame.spec)
    if (frame.kind === 'settings-opened') {
      // Not window.open() here: this handler runs off an EventSource frame, so
      // it carries no user activation and every real browser would block the
      // popup. The toast's Open button is a click — a real gesture — and only
      // then does a new tab open.
      toast({ level: 'info', text: 'The settings page is ready on this board.', url: '/settings' })
    }
  }

  // --- the gate ----------------------------------------------------------------
  function gateEl() { return document.getElementById('ak-gate') }
  function showGate(note) {
    if (gateEl()) { const p = gateEl().querySelector('p'); if (p && note) p.textContent = note; return }
    const div = document.createElement('div')
    div.id = 'ak-gate'
    div.innerHTML = ''
    const box = document.createElement('div')
    box.className = 'ak-gate-box'
    const h = document.createElement('h1')
    h.textContent = 'Agents Kanban'
    const p = document.createElement('p')
    p.textContent = note ?? GATE_DEFAULT
    const input = document.createElement('input')
    input.type = 'password'
    input.placeholder = 'Pairing code'
    input.autocomplete = 'off'
    const go = document.createElement('button')
    go.textContent = 'Open board'
    const enter = () => { if (input.value.trim()) { forget(); sessionStorage.setItem(CODE_KEY, input.value.trim()); reexchanged = false; start() } }
    go.addEventListener('click', enter)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter() })
    const wrong = document.createElement('button')
    wrong.className = 'ak-link'
    wrong.textContent = 'Forget this board'
    wrong.addEventListener('click', () => { closeStream(); forget(); gateEl()?.remove(); showGate() })
    box.append(h, p, input, go, wrong)
    div.append(box)
    document.body.append(div)
    input.focus()
  }

  // --- dialogs: what the webview never had to draw ---------------------------
  function dialog(id, spec) {
    const overlay = document.createElement('div')
    overlay.className = 'ak-overlay'
    const box = document.createElement('div')
    box.className = 'ak-dialog'
    const title = document.createElement('h2')
    title.textContent = spec.title ?? 'Agents Kanban'
    box.append(title)
    if (spec.text) {
      const body = document.createElement('p')
      body.className = 'ak-dialog-text'
      body.textContent = spec.text
      box.append(body)
    }
    const answer = (value) => { overlay.remove(); void api('/api/dialog', { id, answer: value }) }
    overlay.addEventListener('click', (e) => { if (e.target === overlay && !spec.input) answer(undefined) })

    if (spec.input) {
      const input = document.createElement('input')
      input.type = spec.input.password ? 'password' : 'text'
      input.value = spec.input.value ?? ''
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') answer(input.value) })
      box.append(input)
      addButtons(box, [['OK', () => answer(input.value)], ['Cancel', () => answer(undefined)]])
      setTimeout(() => input.focus(), 0)
    } else if (spec.quickpick) {
      const list = document.createElement('div')
      list.className = 'ak-pick'
      let picked = new Set()
      for (const it of spec.quickpick.items) {
        if (it.kind === -1) { // Separator: label only, never selectable
          const sep = document.createElement('div')
          sep.className = 'ak-pick-sep'
          sep.textContent = it.label
          list.append(sep)
          continue
        }
        const row = document.createElement('button')
        row.className = 'ak-pick-row'
        const lab = document.createElement('span')
        lab.textContent = it.label
        row.append(lab)
        if (it.detail) {
          const det = document.createElement('span')
          det.className = 'ak-pick-detail'
          det.textContent = it.detail
          row.append(det)
        }
        if (!spec.quickpick.many) {
          row.addEventListener('click', () => answer(it.item))
        } else {
          row.addEventListener('click', () => {
            if (picked.has(it)) picked.delete(it)
            else picked.add(it)
            row.classList.toggle('ak-picked', picked.has(it))
          })
        }
        list.append(row)
      }
      box.append(list)
      if (spec.quickpick.many) {
        addButtons(box, [['OK', () => answer([...picked].map((x) => x.item))], ['Cancel', () => answer(undefined)]])
      }
    } else {
      addButtons(box, [
        ...(spec.choices ?? []).map((c, i) => [c, () => answer(c)]),
        ['Cancel', () => answer(undefined)],
      ])
    }
    overlay.append(box)
    document.body.append(overlay)
  }

  function addButtons(box, defs) {
    const row = document.createElement('div')
    row.className = 'ak-dialog-buttons'
    for (const [label, fn] of defs) {
      const b = document.createElement('button')
      b.textContent = label
      b.addEventListener('click', fn)
      row.append(b)
    }
    box.append(row)
  }

  function toast(spec) {
    const t = document.createElement('div')
    t.className = 'ak-toast ak-toast-' + (spec.level ?? 'info')
    const text = document.createElement('span')
    text.textContent = spec.text
    t.append(text)
    if (spec.url) {
      const open = document.createElement('button')
      open.textContent = 'Open'
      open.addEventListener('click', () => { const w = window.open(spec.url, '_blank'); if (w) w.opener = null })
      t.append(open)
    }
    document.body.append(t)
    setTimeout(() => t.remove(), 7000)
  }

  // --- connect -----------------------------------------------------------------
  function start() {
    const g = gateEl()
    if (g) g.remove()
    void (async () => {
      closeStream()
      // A reload with a live token skips the exchange; the code is only spent
      // when a token is missing or dead.
      if (!token()) {
        const ex = await exchange()
        if (typeof ex !== 'string') {
          showGate(noteFor(ex, false))
          return
        }
      }
      // Make sure the surface exists before the stream attaches: the page is
      // the click that opens the board. A 401 here means the token died
      // between the exchange and now — api() already recovered or gated.
      const opened = await api('/api/open', { surface })
      if (opened.status === 401) return
      connect()
    })()
  }

  /** Open the event stream with the CURRENT token — the token is read at
   *  connect time and cannot change on a live EventSource, so a re-exchange
   *  always comes back through here with a fresh URL. */
  function connect() {
    const t = token()
    if (!t) { showGate(GATE_DEFAULT); return }
    closeStream()
    // The token rides in the query because EventSource cannot set headers.
    // It is the credential that expires (server/README.md: TLS section), never
    // the code.
    const events = new EventSource('/api/events?surface=' + surface + '&token=' + encodeURIComponent(t))
    stream = events
    events.onopen = () => {
      // A freshly (re)connected view holds no cached state — exactly the
      // `ready` the real webview posts on load, which paints the board.
      window.acquireVsCodeApi().postMessage({ type: 'ready' })
    }
    events.onmessage = (e) => {
      try { onFrame(JSON.parse(e.data)) } catch { /* a frame we cannot read is dropped, not crashed on */ }
    }
    events.onerror = () => {
      if (events !== stream) return // a replaced stream must not fight its successor
      void (async () => {
        // A dead token (401) and a network blip look identical here — the
        // EventSource retries on its own timer either way. Ask the server
        // which one it was: /api/ping answers 401 exactly when the token is
        // gone, and recoverAuth() closes this stream and reconnects with a
        // fresh token, or shows the gate with the reason.
        let ping = null
        try {
          ping = await fetch('/api/ping', { headers: { 'x-rc-token': token() } })
        } catch { return } // network down — the EventSource keeps retrying
        if (ping.status === 401 && (await recoverAuth())) connect()
      })()
    }
  }

  // First paint: gate first, so nothing runs without a credential. A stored
  // token (this tab logged in before, or the popup sharing its sessionStorage)
  // goes straight to the board; the code alone is enough to start — start()
  // exchanges it.
  if (!code() && !token()) showGate()
  else start()
})()
