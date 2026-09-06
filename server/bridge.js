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
 * One more job: the pairing code gate. The code lives in sessionStorage —
 * never in the URL after entry — and rides as a header on every request and as
 * a query parameter on the EventSource (which cannot set headers).
 */
;(function () {
  'use strict'
  const surface = document.currentScript.dataset.surface === 'settings' ? 'settings' : 'board'
  const CODE_KEY = 'ak-code'

  const code = () => sessionStorage.getItem(CODE_KEY) ?? ''
  const setCode = (c) => { sessionStorage.setItem(CODE_KEY, c); start() }
  const clearCode = () => sessionStorage.removeItem(CODE_KEY)

  async function api(path, body, method) {
    const res = await fetch(path, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', 'x-rc-code': code() },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401) console.error('bridge 401 on', path, 'code present:', !!code(), 'stored:', sessionStorage.getItem(CODE_KEY))
    return res
  }

  // --- the webview API the app scripts expect --------------------------------
  const state = {}
  window.acquireVsCodeApi = () => ({
    postMessage: async (msg) => {
      // The app script posts its boot `ready` the moment it loads — while the
      // gate is still up and no code exists yet. That message is the very
      // thing `ready` after the stream connects repeats, so drop it here
      // instead of sending an unauthenticated request (and its wrong-note 401).
      if (!code()) return true
      let res = await api('/api/msg?surface=' + surface, msg)
      if (res.status === 409) {
        // The surface does not exist yet — the extension creates its panel
        // lazily, and a page load is the first click in this room.
        await api('/api/open', { surface })
        res = await api('/api/msg?surface=' + surface, msg)
      }
      if (res.status === 401) showGate('The pairing code was not accepted.')
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
    p.textContent = note ?? 'This board is locked with a pairing code. The server printed it when it started.'
    const input = document.createElement('input')
    input.type = 'password'
    input.placeholder = 'Pairing code'
    input.autocomplete = 'off'
    const go = document.createElement('button')
    go.textContent = 'Open board'
    const enter = () => { if (input.value.trim()) setCode(input.value.trim()) }
    go.addEventListener('click', enter)
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') enter() })
    const wrong = document.createElement('button')
    wrong.className = 'ak-link'
    wrong.textContent = 'Forget this board'
    wrong.addEventListener('click', () => { clearCode(); input.value = ''; input.focus() })
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
      // Make sure the surface exists before the stream attaches: the page is
      // the click that opens the board.
      const opened = await api('/api/open', { surface })
      if (opened.status === 401) {
        clearCode()
        showGate('That code was not accepted. Check the one the server printed.')
        return
      }
      const events = new EventSource('/api/events?surface=' + surface + '&code=' + encodeURIComponent(code()))
      events.onopen = () => {
        // A freshly (re)connected view holds no cached state — exactly the
        // `ready` the real webview posts on load, which paints the board.
        window.acquireVsCodeApi().postMessage({ type: 'ready' })
      }
      events.onmessage = (e) => {
        try { onFrame(JSON.parse(e.data)) } catch { /* a frame we cannot read is dropped, not crashed on */ }
      }
      events.onerror = () => { /* EventSource reconnects on its own */ }
    })()
  }

  // First paint: gate first, so nothing runs without the code.
  if (!code()) showGate()
  else start()
})()
