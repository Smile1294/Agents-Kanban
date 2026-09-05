// Board webview: two modes over one set of sessions.
//   kanban — every session as a card, grouped by phase
//   chat   — one session's transcript, close up
// Sessions and transcripts come from Claude Code itself; we add phase and tags.
// No framework, no drag-and-drop library — native HTML5 DnD.
;(function () {
  const vscode = acquireVsCodeApi()
  const root = document.getElementById('root')
  /** The side bar gets a CONTROL, not a board: five columns cannot be read in
   *  300px, and drawing them there beside the real board was the same thing
   *  twice. Its job is to say what is going on and to toggle. */
  const control = document.documentElement.dataset.layout === 'control'

  let s = {
    ready: false, mode: 'kanban', columns: [], cards: [], running: 0, waiting: 0,
    composer: { model: '', effort: 'high', thinking: 'enabled', models: [], efforts: [], contextTokens: 0 },
  }
  let dragKey = null
  let filter = ''
  let draft = ''
  let stick = true
  let openMenu = null
  /** Index into the slash-command suggestions, or -1 when the list is closed. */
  let slashPick = -1
  /** The live composer textarea, so a repaint can hand focus back to it. */
  let composerInput = null
  /**
   * Images attached to the message being composed.
   *
   * Held out here for the same reason as `draft`: render() rebuilds the
   * composer on every frame, and an agent at work produces several a second —
   * a pasted screenshot living in the DOM would be gone before it could be
   * sent. Each is `{ id, name, mediaType, data, dataUrl, w, h }`, where `data`
   * is base64 with no prefix (what the host sends on) and `dataUrl` is the same
   * bytes for the thumbnail.
   */
  let attachments = []
  let attachSeq = 0
  /**
   * Choices made in an AskUserQuestion picker but not yet sent, keyed by
   * request id and then by question text.
   *
   * Module-level for the same reason as `draft` and `attachments`: render()
   * rebuilds the whole tree and an agent at work triggers one several times a
   * second, so a half-finished answer held in the DOM would be wiped before it
   * could be submitted.
   */
  const askChoices = {}
  /** The free-text box that had focus before the current rebuild, and the node
   *  that replaced it. Same problem and same fix as `composerInput`: the input
   *  the user is typing in is destroyed by every repaint. */
  let askFocusKey = null
  let askFocusNode = null
  /**
   * Which disclosures the user has opened or closed, by key.
   *
   * A `<details>` keeps its open state in the DOM, and render() replaces the
   * whole tree — several times a second while an agent streams. So "Changes"
   * and "How to test this" were rebuilt with `open = true` on every frame, and
   * collapsing them did nothing you could see for more than a moment. Reported
   * as: "it keeps reopening the Changes and how to test, I want it to be
   * toggled by me only".
   *
   * Same shape of problem as scroll position, and the same shape of fix: a key
   * that survives the rebuild, harvested before it and applied after. Held out
   * here rather than inside render() so it also survives switching to the board
   * and back, which is what "I closed it" means to a person.
   */
  const disclosed = {}
  /** Whether the host's remembered disclosures have been folded in yet. Seeded
   *  ONCE, from the first state message: after that the clicks in this window
   *  are the truth, and re-applying the host's copy on every frame would race
   *  the very click it came from. */
  let disclosuresSeeded = false

  window.addEventListener('message', (e) => {
    if (e.data.type === 'state') {
      s = e.data.state
      if (!disclosuresSeeded) {
        disclosuresSeeded = true
        for (const k in s.disclosures || {}) disclosed[k] = !!s.disclosures[k]
      }
      render()
    }
  })
  document.addEventListener('click', () => { if (openMenu) { openMenu = null; render() } })

  const post = (type, payload) => vscode.postMessage({ type, ...payload })
  const el = (tag, cls, text) => {
    const n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  const card = (k) => s.cards.find((c) => c.key === k)
  const selected = () => (s.selectedKey ? card(s.selectedKey) : undefined)
  const stop = (e) => e.stopPropagation()

  function render() {
    const sc = root.querySelector('.transcript-scroll')
    if (sc) stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60
    // Every scroll container is destroyed by the rebuild below, and an agent at
    // work triggers one every few hundred milliseconds. Scrolling down a busy
    // column, or up a transcript to read something, snapped back to the top on
    // the next frame. So: remember where each one was, by a key that survives
    // the rebuild (the column's id, not its position), and put it back.
    const scrolled = {}
    forEachScroll((n) => { if (n.scrollTop) scrolled[n.getAttribute('data-scroll')] = n.scrollTop })
    // Whatever the user has opened or closed since the last frame. Read from
    // the live DOM because a `<details>` is toggled by the browser itself —
    // there is no event we asked for and no state we were told about.
    forEachDisclosure((n) => { disclosed[n.getAttribute('data-open')] = !!n.open })
    // render() replaces every child, so the focused textarea is destroyed. The
    // slash menu repaints on keystrokes, which meant typing "/" moved focus to
    // the body and the rest of the command went nowhere.
    // A real DOM reports tagName uppercase; compare case-insensitively rather
    // than depending on which.
    const active = document.activeElement
    const hadFocus = !!active && String(active.tagName || '').toLowerCase() === 'textarea'
    /* Where the caret was, not just that there was one.
       `render()` never read `selectionStart`/`selectionEnd` off the outgoing
       node, so the only positions available at restore time were 0 and the end
       — and the author picked the end, which is better than 0 and still wrong.
       Clicking into the middle of a long draft to fix a word, or drag-selecting
       a phrase to replace it, was undone by the next frame from ANY card's
       agent, because repaints are panel-wide. The text was always safe; the
       position never was. */
    const caret = active && typeof active.selectionStart === 'number'
      ? { start: active.selectionStart, end: active.selectionEnd }
      : null
    // The composer is not the only thing the user types into. An
    // AskUserQuestion picker's "something else" box is destroyed by the same
    // rebuild, and losing it mid-word is worse there, because the agent is
    // blocked waiting for that answer. Anything that must survive announces
    // itself with `data-focus="<key>"`; the key is remembered, and the node
    // that carries it in the new tree takes the focus back.
    askFocusKey = !hadFocus && active && active.getAttribute ? active.getAttribute('data-focus') : null
    askFocusNode = null
    // Forget choices for questions that are no longer pending — the turn was
    // interrupted, the session ended, or it was answered elsewhere. They are
    // keyed by request id, which is never reused, so without this the map only
    // ever grows for as long as the panel is open.
    const livePermissions = {}
    ;(s.cards || []).forEach((c) => {
      if (c.agent && c.agent.pendingPermission) livePermissions[c.agent.pendingPermission.id] = true
    })
    Object.keys(askChoices).forEach((k) => { if (!livePermissions[k]) delete askChoices[k] })

    root.replaceChildren()
    if (s.noWorkspace) return renderNoWorkspace()
    if (!s.ready) return renderSetup()

    if (control) return renderControl()

    const shell = el('div', 'shell')
    shell.append(renderRail())
    shell.append(s.mode === 'chat' ? renderChat() : renderKanban())
    root.append(shell)

    forEachScroll((n) => { const k = n.getAttribute('data-scroll'); if (scrolled[k]) n.scrollTop = scrolled[k] })
    // The transcript alone has a second rule: at the bottom, it follows the
    // tail. That wins over "where you were", because where you were was the end.
    const sc2 = root.querySelector('.transcript-scroll')
    if (sc2 && stick) sc2.scrollTop = sc2.scrollHeight
    if (askFocusKey && askFocusNode && askFocusNode.focus) restoreFocus(askFocusNode, caret)
    if (hadFocus && composerInput && composerInput.focus) restoreFocus(composerInput, caret)
  }

  /* Give a rebuilt input its focus AND its caret back.
     Clamped to the current value, because the draft can legitimately be shorter
     than it was — the host can replace it, and a selection that ran past the
     end would throw. Falling back to the end preserves the old behaviour for
     anything that reported no position. */
  function restoreFocus(node, caret) {
    node.focus()
    if (!node.setSelectionRange) return
    const n = (node.value || '').length
    const start = caret && Number.isFinite(caret.start) ? Math.min(caret.start, n) : n
    const end = caret && Number.isFinite(caret.end) ? Math.min(caret.end, n) : start
    try { node.setSelectionRange(start, end) } catch (e) { /* not a real input */ }
  }

  /** Every scroll container currently on screen. They announce themselves with
   *  `data-scroll="<key>"`; anything that scrolls and is rebuilt by render()
   *  must carry one, or it forgets its position on every frame. */
  function forEachScroll(fn) {
    if (typeof root.querySelectorAll !== 'function') return
    const nodes = root.querySelectorAll('[data-scroll]')
    for (let i = 0; i < nodes.length; i++) fn(nodes[i])
  }

  /** Every disclosure currently on screen. They announce themselves with
   *  `data-open="<key>"`; a `<details>` that render() rebuilds and does not
   *  carry one goes back to its default state on every frame, which is a
   *  section that will not stay shut. */
  function forEachDisclosure(fn) {
    if (typeof root.querySelectorAll !== 'function') return
    const nodes = root.querySelectorAll('[data-open]')
    for (let i = 0; i < nodes.length; i++) fn(nodes[i])
  }

  /**
   * Make a `<details>` remember whether the user had it open.
   *
   * `defaultOpen` applies only until they say otherwise — after that their
   * choice wins, for the rest of the window's life. Deliberately NOT keyed by
   * session: "I don't want to see the diff panel" is a statement about the
   * panel, not about one card, and re-expanding it every time you switch
   * session is the same annoyance in a smaller form.
   */
  /* A key for a transcript disclosure that is stable ACROSS READS.
     Not `e.at`: a transcript rehydrated from disk is stamped with the time it
     was PARSED (a documented open issue), so a timestamp key changes on every
     reload and the open state would be forgotten anyway. The content does not
     change, so its length plus a short prefix identifies the block for as long
     as it exists. */
  function thinkKey(e) {
    const s = String(e.text || '')
    return 'think:' + s.length + ':' + s.slice(0, 24)
  }

  function disclosure(box, key, defaultOpen) {
    box.open = key in disclosed ? disclosed[key] : !!defaultOpen
    if (box.setAttribute) box.setAttribute('data-open', key)
    // A real `<details>` fires this when the user clicks the summary. Recording
    // it here as well as harvesting in render() means a toggle is remembered
    // even if no repaint follows it.
    box.ontoggle = () => {
      if (disclosed[key] === !!box.open) return
      disclosed[key] = !!box.open
      // Told to the host so it outlives this panel. One-way: the host stores it
      // and seeds a future window with it, and never applies it back over a
      // click that has already happened.
      post('disclosure', { key, open: box.open })
    }
    return box
  }

  // A blank panel tells the user nothing. Every non-ready state says what is
  // wrong and offers the action that fixes it.
  function renderNoWorkspace() {
    const box = el('div', 'setup')
    box.append(el('h2', null, 'No folder open'))
    box.append(el('p', null, 'Agents Kanban works on a folder in your workspace. Open one, and the board appears here — no reload needed.'))
    const b = el('button', 'primary', 'Open folder…')
    b.onclick = () => post('openFolder')
    box.append(b)
    root.append(box)
  }

  function renderSetup() {
    const box = el('div', 'setup')
    box.append(el('h2', null, 'Loading sessions…'))
    box.append(el('p', null, 'Sessions come from Claude Code itself. Nothing is written to your repository.'))
    if (s.noRepo) box.append(el('p', 'warn-note', 'This folder is not a git repository. Agents cannot run until it is one, because each session needs its own git worktree.'))
    root.append(box)
  }

  /** The side bar panel: status, a way in and out, and nothing else. */
  function renderControl() {
    const box = el('div', 'control')

    const open = s.focused || s.boardOpen
    const title = el('div', 'control-title', open ? 'Board is open' : 'Agents Kanban')
    box.append(title)

    const counts = []
    if (s.running) counts.push(s.running + ' running')
    if (s.waiting) counts.push(s.waiting + ' waiting on you')
    box.append(el('div', 'control-sub',
      counts.join(' · ') || (s.cards.length ? s.cards.length + ' sessions' : 'No sessions yet')))

    const b = el('button', 'primary control-btn', open ? 'Close board' : 'Open board')
    b.title = open
      ? 'Close the board and put your panels back'
      : 'Open the board in the editor'
    b.onclick = () => post(open ? 'closeBoard' : 'openBoard')
    box.append(b)

    const nw = el('button', 'control-btn', '+ New session')
    nw.onclick = () => post('newSessionPrompt')
    box.append(nw)

    // The sessions, as a list you can jump from — never as columns.
    if (s.cards.length) {
      const list = el('div', 'control-list')
      for (const c of s.cards.slice().sort((a, b) => b.updated - a.updated).slice(0, 30)) {
        const row = el('button', 'control-item')
        row.append(el('span', 'ai', '✦'))
        row.append(el('span', 'nm', c.title))
        row.append(phaseChip(c.phase))
        row.onclick = () => post('openSession', { id: c.key })
        list.append(row)
      }
      box.append(list)
    }

    box.append(el('div', 'control-hint', 'The board opens in the editor — five columns need the room.'))
    root.append(box)
  }

  // ------------------------------------------------------------------ rail

  function renderRail() {
    const rail = el('aside', 'rail')
    const head = el('div', 'rail-head')
    head.append(el('div', 'rail-title', 'Agent Sessions'))
    const t = el('button', 'pill' + (s.mode === 'kanban' ? ' on' : ''), '▤ Kanban')
    t.onclick = () => post('setMode', { mode: s.mode === 'kanban' ? 'chat' : 'kanban' })
    head.append(t)
    rail.append(head)

    const search = el('input', 'search')
    // Announces itself to the focus-restore, like the ask picker's free-text
    // box. `render()` only ever restored a <textarea>, and this is an <input> —
    // so typing "auth" while three agents streamed produced "a" in the box and
    // "uth" nowhere, because `replaceChildren()` moves focus to the body. The
    // filter TEXT survived (it is module-level); only the focus did not, which
    // is the same half-fix the composer had.
    if (search.setAttribute) search.setAttribute('data-focus', 'rail-search')
    search.placeholder = 'Search or type # to filter by tag'
    search.value = filter
    search.oninput = (e) => { filter = e.target.value; renderRailList(list) }
    rail.append(search)

    const nw = el('button', 'primary new-session', '+ New session')
    nw.onclick = () => { post('select', { id: '' }); post('setMode', { mode: 'chat' }) }
    rail.append(nw)

    const list = el('div', 'rail-list')
    list.setAttribute('data-scroll', 'rail')
    renderRailList(list)
    rail.append(list)

    const foot = el('div', 'rail-foot')
    const arch = el('button', s.showArchived ? 'on' : '', s.showArchived ? '✓ Showing archived' : 'Show archived')
    arch.onclick = () => post('toggleArchived')
    foot.append(arch)
    rail.append(foot)
    return rail
  }

  function matches(c) {
    const q = filter.trim().toLowerCase()
    if (!q) return true
    if (q.startsWith('#')) return c.tags.some((l) => l.toLowerCase().includes(q.slice(1)))
    return c.title.toLowerCase().includes(q) || c.tags.some((l) => l.toLowerCase().includes(q))
  }

  /* One formatter, built once, and a cache keyed by local day.
     `toLocaleDateString` constructs a fresh `Intl.DateTimeFormat` on every call,
     and this ran once per card PLUS once per card per group header — `n + n×g`
     — with no cap on the list. Measured: 31ms at 30 sessions, 124ms at 60,
     533ms at 120, 1.65s at 200, on EVERY repaint, and repaints fire per streamed
     frame. DECISIONS.md already treats 60 sessions as a realistic board, and
     124ms of date formatting per frame is the same order as the session scan
     that has its own postmortem. */
  let dayFmt = null
  const dayCache = new Map()
  function dayLabel(ms) {
    if (!Number.isFinite(ms)) return 'Earlier'
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) return 'Earlier'
    // The local calendar day is the cache key: every timestamp inside one day
    // produces the same label, so a 200-session board formats at most once per
    // distinct day rather than 200 times.
    const key = d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate()
    const hit = dayCache.get(key)
    if (hit !== undefined) return hit
    const today = new Date(); today.setHours(0, 0, 0, 0)
    const that = new Date(d); that.setHours(0, 0, 0, 0)
    const days = Math.round((today - that) / 86400000)
    let label
    if (days <= 0) label = 'Today'
    else if (days === 1) label = 'Yesterday'
    else {
      if (!dayFmt) {
        try { dayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }) }
        catch (e) { dayFmt = null }
      }
      label = dayFmt ? dayFmt.format(d) : d.toDateString().slice(4, 10)
    }
    // Bounded: "Today" moves at midnight, and an unbounded map in a panel that
    // stays open for days is a leak. Cleared when it grows past a year's worth.
    if (dayCache.size > 400) dayCache.clear()
    dayCache.set(key, label)
    return label
  }

  function renderRailList(list) {
    list.replaceChildren()
    const shown = s.cards.filter(matches).slice().sort((a, b) => b.updated - a.updated)
    if (!shown.length) { list.append(el('div', 'empty', filter ? 'Nothing matches' : 'No sessions yet')); return }
    // Group labels and their counts in ONE pass. The count used to re-scan the
    // whole list for every header, which is what made this `n + n×g`.
    const labels = shown.map((c) => dayLabel(c.updated))
    const counts = new Map()
    for (const g of labels) counts.set(g, (counts.get(g) ?? 0) + 1)
    let group = null
    for (let k = 0; k < shown.length; k++) {
      const g = labels[k]
      if (g !== group) {
        group = g
        const h = el('div', 'rail-group')
        h.append(el('span', null, g))
        h.append(el('span', 'n', String(counts.get(g))))
        list.append(h)
      }
      list.append(renderRailItem(shown[k]))
    }
  }

  function renderRailItem(c) {
    const row = el('div', 'rail-item' + (c.key === s.selectedKey ? ' active' : '') + (c.archived ? ' archived' : ''))
    row.onclick = () => { post('select', { id: c.key }); post('setMode', { mode: 'chat' }) }
    const top = el('div', 'rail-item-top')
    top.append(el('span', 'ai', '✦'))
    top.append(el('span', 'nm', c.title))
    row.append(top)
    const sub = el('div', 'rail-item-sub')
    sub.append(el('span', null, ago(c.updated)))
    sub.append(phaseChip(c.phase))
    if (c.archived) sub.append(el('span', 'chip', 'archived'))
    row.append(sub)
    return row
  }

  function phaseChip(phase) {
    const col = s.columns.find((x) => x.id === phase)
    return el('span', 'chip cat-' + (col ? col.category : 'unknown'), col ? col.name : phase)
  }

  /* Seconds-resolution age, for the liveness readout. `ago()` bottoms out at
     "just now" for anything under a minute, which is exactly the range that
     matters when the question is "has this stopped?". */
  function since(ms) {
    const secs = Math.max(0, Math.round((Date.now() - ms) / 1000))
    if (secs < 60) return secs + 's'
    const mins = Math.floor(secs / 60)
    if (mins < 60) return mins + 'm ' + (secs % 60) + 's'
    return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm'
  }

  /* The age has to CLIMB, or it is a lie in the other direction: the view only
     repaints when a message arrives, so a wedged run would sit on the number it
     last rendered and read as freshly updated. This ticks the text in place,
     without a re-render — a re-render here would fight the composer for focus. */
  function tickAges() {
    if (typeof document.querySelectorAll !== 'function') return
    const nodes = document.querySelectorAll('[data-since]')
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      const at = Number(n.getAttribute('data-since'))
      if (!at) continue
      n.textContent = since(at)
      if (Date.now() - at > 60000) n.classList.add('stale')
    }
  }
  if (typeof setInterval === 'function') setInterval(tickAges, 1000)

  function ago(ms) {
    if (!ms) return ''
    const mins = Math.max(0, Math.round((Date.now() - ms) / 60000))
    if (mins < 1) return 'just now'
    if (mins < 60) return mins + 'm ago'
    const h = Math.round(mins / 60)
    if (h < 24) return h + 'h ago'
    return Math.round(h / 24) + 'd ago'
  }

  // ---------------------------------------------------------------- kanban

  function renderKanban() {
    const main = el('main', 'main')
    main.append(renderToolbar())
    const board = el('div', 'board')
    const visible = s.cards.filter(matches)
    for (const col of s.columns) board.append(renderColumn(col, visible.filter((c) => c.phase === col.id)))
    const orphans = visible.filter((c) => !s.columns.some((x) => x.id === c.phase))
    if (orphans.length) board.append(renderColumn({ id: '__orphan', name: 'Unknown phase', locked: true }, orphans))
    main.append(board)
    return main
  }

  function renderToolbar() {
    const bar = el('div', 'toolbar')
    const add = el('button', 'primary', '+ New session')
    add.onclick = () => { post('select', { id: '' }); post('setMode', { mode: 'chat' }) }
    bar.append(add)
    bar.append(el('div', 'spacer'))
    const parts = []
    if (s.running) parts.push(s.running + ' running')
    if (s.waiting) parts.push(s.waiting + ' waiting on you')
    bar.append(el('div', 'count', parts.join(' · ') || s.cards.length + ' sessions'))
    bar.append(focusButton())
    return bar
  }

  /** Give the board the whole window, or hand it back. Five columns and a rail
   *  beside a file explorer is not enough room to read a card. */
  function focusButton() {
    const b = el('button', 'focus-btn' + (s.focused ? ' on' : ''), s.focused ? '⤡' : '⤢')
    b.title = s.focused
      ? 'Give the window back (show the side bar and panels)'
      : 'Take the whole window'
    b.onclick = () => post('focus')
    return b
  }

  function renderColumn(col, cards) {
    const locked = col.humanOnly || col.locked
    const c = el('section', 'column' + (locked ? ' locked' : ''))
    const head = el('div', 'column-head')
    head.append(el('span', 'dot cat-' + (col.category || 'unknown')))
    head.append(el('span', null, col.name))
    if (col.humanOnly) {
      const lock = el('span', 'lock', '🔒')
      lock.title = 'Agents cannot move a session here — only you can.'
      head.append(lock)
    }
    head.append(el('span', 'n', String(cards.length)))
    c.append(head)

    const list = el('div', 'cards')
    list.setAttribute('data-scroll', 'col:' + col.id)
    if (!cards.length) list.append(el('div', 'empty', locked ? '—' : 'No sessions'))
    for (const x of cards) list.append(renderCard(x))

    if (col.id !== '__orphan') {
      list.addEventListener('dragover', (e) => {
        if (!dragKey) return
        e.preventDefault(); e.dataTransfer.dropEffect = 'move'; c.classList.add('drag-over')
      })
      list.addEventListener('dragleave', () => c.classList.remove('drag-over'))
      list.addEventListener('drop', (e) => {
        e.preventDefault(); c.classList.remove('drag-over')
        if (dragKey) post('move', { id: dragKey, phase: col.id })
        dragKey = null
      })
    }
    c.append(list)
    return c
  }

  function renderCard(c) {
    const a = c.agent
    const kind = a ? a.kind : 'idle'
    const cls = kind === 'working' || kind === 'starting' ? ' running'
      : kind === 'needsInput' ? ' needs-input'
      : kind === 'error' ? ' failed' : ''
    const n = el('article', 'card' + cls + (c.archived ? ' archived' : '') + (c.pinned ? ' pinned' : ''))
    n.draggable = true
    n.addEventListener('dragstart', (e) => {
      dragKey = c.key; n.classList.add('dragging')
      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.key)
    })
    n.addEventListener('dragend', () => { n.classList.remove('dragging'); dragKey = null })
    n.onclick = () => { post('select', { id: c.key }); post('setMode', { mode: 'chat' }) }

    /* A subtask says where it came from, at the top, before its own title.
       Without it the board just grows two extra cards after a split and nothing
       on screen says why they appeared or what they belong to. */
    if (c.parentTitle) {
      const up = el('button', 'subtask-of', '↳ ' + c.parentTitle)
      up.title = 'Part of "' + c.parentTitle + '" — open it'
      up.onclick = (e) => { stop(e); post('select', { id: c.parent }); post('setMode', { mode: 'chat' }) }
      n.append(up)
    }

    const t = el('div', 'title')
    t.append(el('span', 'ai', '✦'), document.createTextNode(c.title))
    n.append(t)

    /* How the work was divided, or why it was not.
       A refused split used to be invisible — the message went to the model and
       nowhere else — so a session that wanted four agents and was refused
       looked exactly like one that correctly decided it was a single job. The
       agent's own sentence is quoted and attributed rather than merged into
       ours, because it is a claim it made, not a fact we established. */
    if (c.decomposition) {
      const d = el('div', 'decomp' + (c.decomposition.refused ? ' refused' : ''))
      d.append(el('span', 'decomp-line', c.decomposition.line))
      if (c.decomposition.stated) {
        const q = el('span', 'decomp-said', '\u201C' + c.decomposition.stated + '\u201D')
        q.title = "The agent's own reason, as it gave it at the time."
        d.append(q)
      }
      n.append(d)
    }
    if (c.subtasks && c.subtasks.length) n.append(renderSubtasks(c))

    if (c.tags.length) {
      const l = el('div', 'labels')
      for (const name of c.tags) l.append(el('span', 'label', '#' + name))
      n.append(l)
    }

    const meta = el('div', 'meta')
    if (c.branch) meta.append(el('span', 'branch', '⎇ ' + c.branch.replace(/^task\//, '')))
    meta.append(el('span', 'spacer'))
    meta.append(el('span', null, ago(c.updated)))
    meta.append(kebab(c))
    n.append(meta)

    if (a) n.append(renderAgentStrip(c, a))
    else if (c.interrupted) n.append(renderInterrupted(c, false))
    return n
  }

  /* A run the editor killed on its way out — a reload, a reinstall, a crash.
     Nothing can re-attach to it: the process died with the old extension host.
     But saying nothing is worse than saying that, because a cut-off run and a
     finished one look identical on a board, and the difference is whether the
     work was ever done.

     The TIME is shown, not a badge, for the reason every other indicator here
     shows its number: "cut off 2m ago" and "cut off 3 days ago" are different
     situations and a bare word cannot tell them apart. */
  function renderInterrupted(c, full) {
    const box = el('div', 'interrupted')
    const head = el('div', 'interrupted-head')
    head.append(el('span', 'interrupted-icon', '⚠'))
    head.append(el('span', 'interrupted-title', 'Interrupted ' + ago(c.interrupted)))
    box.append(head)
    if (!full) return box

    box.append(el('div', 'interrupted-body',
      'The editor restarted while this was running, so the turn was cut off part-way. ' +
      'The process is gone, but the session can be picked up where it left off.'))
    const actions = el('div', 'interrupted-actions')
    const go = el('button', 'primary', 'Resume')
    go.title = 'Start a new turn on this session, telling the agent it was cut off'
    go.onclick = (e) => { stop(e); post('resume', { id: c.key }) }
    actions.append(go)
    const no = el('button', null, 'Dismiss')
    no.title = 'Leave it stopped and clear this notice'
    no.onclick = (e) => { stop(e); post('dismissInterrupted', { id: c.key }) }
    actions.append(no)
    box.append(actions)
    return box
  }

  /* The parent's half of a split: what it was broken into, and how much of it
     is done. This is the answer to "when do I test what" — each subtask is
     tested on its own card as it lands, and the parent is ready only when the
     count reads full. The phases are shown per subtask rather than as a bare
     fraction, so "1/2 ready" can be checked rather than believed. */
  function renderSubtasks(c) {
    const done = c.subtasks.filter((t) => t.ready).length
    const box = el('div', 'subtasks' + (done === c.subtasks.length ? ' all-ready' : ''))
    const head = el('div', 'subtasks-head')
    head.append(el('span', null, c.subtasks.length + ' subtasks'))
    head.append(el('span', 'spacer'))
    head.append(el('span', 'subtasks-count', done + '/' + c.subtasks.length + ' ready'))
    box.append(head)
    for (const t of c.subtasks) {
      const row = el('button', 'subtask' + (t.ready ? ' ready' : ''))
      row.append(el('span', 'subtask-mark', t.ready ? '✓' : '·'))
      row.append(el('span', 'subtask-name', t.title))
      row.append(phaseChip(t.phase))
      row.title = 'Open "' + t.title + '"'
      row.onclick = (e) => { stop(e); post('select', { id: t.key }); post('setMode', { mode: 'chat' }) }
      box.append(row)
    }
    return box
  }

  /** Per-card menu: the archive and delete affordance. */
  function kebab(c) {
    const wrap = el('span', 'kebab-wrap')
    const b = el('button', 'kebab', '⋯')
    b.title = 'Session actions'
    b.onclick = (e) => { stop(e); openMenu = openMenu === c.key ? null : c.key; render() }
    wrap.append(b)
    if (openMenu === c.key) {
      const menu = el('div', 'menu')
      menu.onclick = stop
      const item = (label, fn, cls) => {
        const i = el('button', 'menu-item' + (cls ? ' ' + cls : ''), label)
        i.onclick = (e) => { stop(e); openMenu = null; fn() }
        menu.append(i)
      }
      if (c.worktree) item('▶ Run app', () => post('run', { id: c.key }))
      if (c.worktree) item('Open worktree', () => post('openWorktree', { id: c.key }))
      item('Rename…', () => {
        const title = prompt('Session name', c.title)
        if (title && title.trim()) post('rename', { id: c.key, title })
      })
      if (c.agent && ['working', 'starting', 'needsInput'].includes(c.agent.kind)) {
        item('Stop agent', () => post('stop', { id: c.key }))
      }
      // `pinned` was the board's primary sort key with nothing able to set it.
    item(c.pinned ? 'Unpin' : 'Pin to top', () => post('pin', { id: c.key, pinned: !c.pinned }))
    item(c.archived ? 'Unarchive' : 'Archive', () => post('archive', { id: c.key, archived: !c.archived }))
      item('Delete permanently…', () => post('remove', { id: c.key }), 'danger')
      wrap.append(menu)
    }
    return wrap
  }

  /* "Is it still going?" answered at the bottom of the transcript: a spinner
     that only exists while a turn is running, the tool it is on, and a counter
     that ticks up every second. The spinner alone would be another thing that
     spins forever over a wedged process; the counter is the part you can check. */
  function renderActivity(a) {
    if (a.kind !== 'working' && a.kind !== 'starting') return el('div', 'activity-idle', '')
    const box = el('div', 'activity')
    box.append(el('span', 'spinner'))
    const what = a.kind === 'starting' ? 'Starting…'
      : a.subagent ? (a.tool || 'Task') + ' → ' + a.subagent
      : a.tool ? a.tool
      : 'Working'
    box.append(el('span', 'activity-what', what))
    if (a.lastEventAt) {
      const age = el('span', 'activity-age', since(a.lastEventAt))
      if (age.setAttribute) age.setAttribute('data-since', String(a.lastEventAt))
      if (Date.now() - a.lastEventAt > 60000) age.classList.add('stale')
      age.title = 'Time since Claude Code last sent anything'
      box.append(el('span', 'activity-sep', '·'), age)
    }
    return box
  }

  function renderAgentStrip(c, a) {
    const wrap = el('div', 'agent')
    const row = el('div', 'agent-row')
    const dot = el('span', 'dot')
    let text = ''
    // Accepted, waiting for a slot. It has no process yet, so it gets no
    // pulse — a pulse over something that is not running is the signal this
    // board has a rule about. The age is the number it is derived from.
    if (a.kind === 'queued') { dot.classList.add('queued'); text = 'queued' }
    else if (a.kind === 'starting') { dot.classList.add('pulse'); text = 'starting…' }
    else if (a.kind === 'working') {
      dot.classList.add('pulse')
      // A Task can run for minutes. Naming the tool its subagent is on is the
      // difference between a row that looks hung and one that is visibly busy.
      text = a.subagent ? (a.tool || 'Task') + ' → ' + a.subagent + '…'
        : a.tool ? a.tool + '…'
        : 'working…'
    }
    else if (a.kind === 'needsInput') { dot.classList.add('warn'); text = 'needs you' }
    else if (a.kind === 'done') { dot.classList.add('ok'); text = 'done' + (a.costUsd ? ' · $' + a.costUsd.toFixed(2) : '') }
    else if (a.kind === 'error') { dot.classList.add('bad'); text = 'failed' }
    else text = 'idle'
    row.append(dot, el('span', null, text))
    // The honest half of the liveness claim. The dot pulses on a CSS timer and
    // would keep pulsing over a wedged process; this is the age of the last
    // thing the CLI actually said, so a stuck run shows a number that climbs.
    if (a.kind === 'queued' && a.since) {
      const age = el('span', 'age', ago(a.since))
      age.title = 'Waiting for a free agent slot. Raise agentsKanban.maxConcurrentAgents to run more at once.'
      row.append(age)
    }
    if ((a.kind === 'working' || a.kind === 'starting') && a.lastEventAt) {
      const age = el('span', 'age', since(a.lastEventAt))
      // Read by tickAges() so the number keeps climbing between messages.
      if (age.setAttribute) age.setAttribute('data-since', String(a.lastEventAt))
      if (Date.now() - a.lastEventAt > 60000) age.classList.add('stale')
      age.title = 'Time since Claude Code last sent anything'
      row.append(age)
    }
    if (a.contextWindow && a.contextTokens) {
      row.append(el('span', 'spacer'))
      row.append(el('span', 'ctx', pct(a.contextTokens, a.contextWindow)))
    }
    wrap.append(row)
    if (a.pendingPermission) wrap.append(renderAsk(c, a))
    return wrap
  }

  /* An agent stops for two different reasons, and they used to look identical.
     "May I run this?" is a permission request, answered by Allow or Deny.
     "Which of these do you want?" is an AskUserQuestion, and Allow does not
     answer it — the tool needs the choice itself. Rendering both as one
     Allow/Deny pair meant a question showed up as `AskUserQuestion` with no
     question in it, and allowing it returned no answer at all, so the agent
     carried on and guessed. The host parses the options out (board/questions.ts)
     and sets `questions` when there are any. */
  function renderAsk(c, a) {
    const p = a.pendingPermission
    return p.questions && p.questions.length ? renderAskQuestions(c, p) : renderAskPermission(c, p)
  }

  function renderAskPermission(c, p) {
    const ask = el('div', 'ask')
    /* The RUNTIME's own sentence when it gave one, and only then our own.
       This said "Claude wants to run" unconditionally — so a Codex approval,
       which is the commonest event on Codex's shipped default policy, named the
       wrong vendor. Codex computes "Codex wants to change 3 files in your
       worktree" and it was dropped at this boundary, so the dialog that
       authorises a write to the user's worktree withheld the file count, the
       file names and the reason all at once. */
    ask.append(el('div', 'ask-h', p.prompt || 'Claude wants to run'))
    if (!p.prompt) { const code = el('code'); code.textContent = p.summary; ask.append(code) }
    // A second request is WAITING, not gone. One slot used to hold them all, so
    // answering the visible one left the agent blocked on an invisible one
    // while the card went back to saying "working".
    if (p.waiting > 1) {
      ask.append(el('div', 'ask-more', (p.waiting - 1) + ' more waiting after this one'))
    }
    const actions = el('div', 'row-actions')
    const allow = el('button', 'primary', 'Allow')
    allow.onclick = (e) => { stop(e); post('permission', { id: c.key, requestId: p.id, allow: true }) }
    const deny = el('button', null, 'Deny')
    deny.onclick = (e) => { stop(e); post('permission', { id: c.key, requestId: p.id, allow: false }) }
    actions.append(allow, deny)
    ask.append(actions)
    return ask
  }

  function askPicked(id) {
    if (!askChoices[id]) askChoices[id] = {}
    return askChoices[id]
  }

  /* One question's working state: the options ticked, and whatever was typed
     into the free-text box, kept APART.

     They used to share one array, with anything not matching a declared label
     inferred to be the free text. Two bugs came straight out of that. Ticking
     "Auth" and also typing "Auth" produced the answer "Auth, Auth" and then
     emptied the box, because nothing in the array looked undeclared any more.
     And the typed text was trimmed on the way IN, so a repaint — which any
     other running agent triggers, on a card you are not even looking at —
     rewrote the box from state and swallowed the trailing space: "hello world"
     was typed and "helloworld" came out. Two slots, no inference, trim only on
     the way out. */
  function askEntry(id, q) {
    const picked = askPicked(id)
    if (!picked[q.question]) picked[q.question] = { opts: [], other: '' }
    return picked[q.question]
  }

  function askToggle(id, q, label) {
    const e = askEntry(id, q)
    if (q.multiSelect) {
      e.opts = e.opts.indexOf(label) >= 0 ? e.opts.filter((x) => x !== label) : e.opts.concat(label)
      return
    }
    // Single-select replaces, and clears any free text — otherwise the box goes
    // on showing an answer that is no longer being sent.
    const had = e.opts.indexOf(label) >= 0
    e.opts = had ? [] : [label]
    if (!had) e.other = ''
  }

  function askSetFreeText(id, q, value) {
    const e = askEntry(id, q)
    // Stored raw. See askEntry.
    e.other = value == null ? '' : String(value)
    if (!q.multiSelect && e.other.trim()) e.opts = []
  }

  /** What the user picked for one question: ticked options plus free text, in
   *  order, trimmed and deduplicated. The host turns this into the answer
   *  string — see buildAskAnswers() in src/board/questions.ts. */
  function askSelection(e) {
    const out = []
    const add = (v) => {
      const t = String(v == null ? '' : v).trim()
      if (t && out.indexOf(t) < 0) out.push(t)
    }
    e.opts.forEach(add)
    add(e.other)
    return out
  }

  function askSelections(questions, picked) {
    const out = {}
    questions.forEach((q) => {
      const e = picked[q.question]
      if (!e) return
      const sel = askSelection(e)
      if (sel.length) out[q.question] = sel
    })
    return out
  }

  function renderAskQuestions(c, p) {
    const picked = askPicked(p.id)
    const ask = el('div', 'ask ask-questions')
    ask.append(el('div', 'ask-h', p.questions.length > 1
      ? 'The agent is asking ' + p.questions.length + ' questions'
      : 'The agent is asking'))

    p.questions.forEach((q, qi) => {
      const block = el('div', 'ask-q')
      const head = el('div', 'ask-q-head')
      head.append(el('span', 'ask-chip', q.header))
      if (q.multiSelect) head.append(el('span', 'ask-hint', 'choose any'))
      block.append(head)
      block.append(el('div', 'ask-q-text', q.question))

      const entry = picked[q.question] || { opts: [], other: '' }
      const opts = el('div', 'ask-options')
      q.options.forEach((o) => {
        const on = entry.opts.indexOf(o.label) >= 0
        const b = el('button', 'ask-opt' + (on ? ' on' : ''))
        b.append(el('span', 'ask-opt-label', o.label))
        if (o.description) b.append(el('span', 'ask-opt-desc', o.description))
        b.onclick = (e) => { stop(e); askToggle(p.id, q, o.label); render() }
        opts.append(b)
      })
      block.append(opts)

      // The tool documents "Other" as always available, so never force the
      // user into one of the agent's guesses.
      const key = p.id + '::' + qi
      const other = el('input', 'ask-other' + (entry.other.trim() ? ' on' : ''))
      other.type = 'text'
      other.placeholder = 'Something else…'
      other.value = entry.other
      other.setAttribute('data-focus', key)
      if (askFocusKey === key) askFocusNode = other
      other.oninput = (ev) => {
        const e2 = askEntry(p.id, q)
        const wasAnswered = askSelection(e2).length > 0
        const hadOpts = e2.opts.length
        askSetFreeText(p.id, q, ev.target.value)
        other.className = 'ask-other' + (e2.other.trim() ? ' on' : '')
        // Repaint only when something OTHER than the text itself changed: the
        // question became answered or unanswered, or a single-select's ticked
        // option was cleared by typing. Repainting per keystroke is what the
        // composer goes out of its way to avoid.
        if (wasAnswered !== (askSelection(e2).length > 0) || hadOpts !== e2.opts.length) render()
      }
      other.onclick = stop
      block.append(other)

      ask.append(block)
    })

    const selections = askSelections(p.questions, picked)
    const missing = p.questions.filter((q) => !selections[q.question]).length

    const actions = el('div', 'row-actions')
    const send = el('button', 'primary', missing ? missing + ' still to answer' : 'Send answer')
    send.disabled = missing > 0
    send.onclick = (e) => {
      stop(e)
      if (missing) return
      delete askChoices[p.id]
      post('permission', { id: c.key, requestId: p.id, allow: true, selections: selections })
    }
    // Declining is still allowed — but it is a deny, so the agent is told the
    // question went unanswered rather than being handed a made-up choice.
    const skip = el('button', null, 'Skip')
    skip.title = 'Decline to answer. The agent is told you skipped the question.'
    skip.onclick = (e) => {
      stop(e)
      delete askChoices[p.id]
      post('permission', { id: c.key, requestId: p.id, allow: false })
    }
    actions.append(send, skip)
    ask.append(actions)
    return ask
  }

  // ------------------------------------------------------------------ chat

  function renderChat() {
    const main = el('main', 'main chat')
    const c = selected()

    const head = el('div', 'chat-head')
    const titles = el('div', 'chat-titles')
    // The thread back to the task this was split out of, above its own title —
    // the transcript below is one subtask's, and reading it without knowing
    // that is how a split looks like an agent going off on its own.
    if (c && c.parentTitle) {
      const up = el('button', 'subtask-of', '↳ ' + c.parentTitle)
      up.title = 'Part of "' + c.parentTitle + '" — open it'
      up.onclick = () => post('select', { id: c.parent })
      titles.append(up)
    }
    titles.append(el('div', 'chat-title', c ? c.title : 'New session'))
    if (c) {
      const tags = el('div', 'labels')
      tags.append(phaseChip(c.phase))
      for (const l of c.tags) tags.append(el('span', 'label', '#' + l))
      titles.append(tags)
    }
    head.append(titles)
    head.append(el('div', 'spacer'))
    const toKanban = el('button', 'pill', '▤ Kanban')
    toKanban.onclick = () => post('setMode', { mode: 'kanban' })
    head.append(toKanban)
    head.append(focusButton())
    if (c) {
      const busy = c.agent && ['working', 'starting', 'needsInput'].includes(c.agent.kind)
      if (busy) {
        // Interrupt ends the TURN and leaves the session alive to take another
        // message. Stop ends the run. Nine times out of ten you want the first,
        // which is why it is the button and Stop is in the menu.
        const i = el('button', null, '⎋ Interrupt')
        i.title = 'Stop what the agent is doing now, but keep the session'
        i.onclick = () => post('interrupt', { id: c.key })
        head.append(i)
        const b = el('button', 'danger', 'Stop')
        b.title = 'End this run entirely'
        b.onclick = () => post('stop', { id: c.key })
        head.append(b)
      }
      // Starting the app is the next thing you do after reading a test plan,
      // so it lives where you are already looking rather than in a menu. Only
      // for a session that HAS a worktree: there is nothing to serve otherwise.
      if (c.worktree) {
        const run = el('button', 'run-app', '▶ Run app')
        run.title = 'Start this worktree\'s app and open it in your browser'
        run.onclick = () => post('run', { id: c.key })
        head.append(run)
      }
      const arch = el('button', null, c.archived ? 'Unarchive' : 'Archive')
      arch.onclick = () => post('archive', { id: c.key, archived: !c.archived })
      head.append(arch)
      const del = el('button', 'danger', 'Delete')
      del.onclick = () => post('remove', { id: c.key })
      head.append(del)
    }
    main.append(head)

    // A parent's own transcript is short — it read, decided, and split. What
    // matters on its page is the subtasks, so they go first, where the test
    // plan would be on an ordinary card. They ARE its test plan.
    if (c && c.interrupted && !c.agent) main.append(renderInterrupted(c, true))
    if (c && c.subtasks && c.subtasks.length) main.append(renderSubtasks(c))
    if (c && c.testPlan) main.append(renderTestPlan(c))
    if (c && c.worktree) main.append(renderReview(c))

    const scroll = el('div', 'transcript-scroll')
    scroll.setAttribute('data-scroll', 'transcript')
    if (!c) scroll.append(renderNewSessionHint())
    else if (!s.transcript || !s.transcript.length) scroll.append(el('div', 'empty', 'No transcript yet.'))
    else for (const e of s.transcript) scroll.append(renderEntry(e, c))
    if (s.streaming) scroll.append(renderStreaming(s.streaming))
    // The running indicator belongs HERE, at the foot of the transcript, where
    // new output appears and where the eye already is. It used to exist only on
    // the kanban cards — so the chat view, which is where you actually sit and
    // watch, showed nothing at all between tool calls and looked stopped.
    if (c && c.agent) scroll.append(renderActivity(c.agent))
    if (c && c.queued && c.queued.length) scroll.append(renderQueued(c))
    if (c && c.agent && c.agent.pendingPermission) scroll.append(renderAsk(c, c.agent))
    main.append(scroll)

    main.append(renderComposer(c))
    return main
  }

  /** How to test what the agent built.
   *
   * A card that says "ready for review" and nothing else is a puzzle: which
   * files, run what, look where. The agent has to answer that to reach a review
   * column at all, and this turns the answer into things you can click — files
   * open in the editor, commands open a terminal already in the worktree, URLs
   * open in the browser. All of it against the AGENT's checkout, not yours.
   */
  function renderTestPlan(c) {
    const p = c.testPlan
    const box = disclosure(el('details', 'testplan'), 'testplan', true)
    const sum = el('summary', 'testplan-head')
    sum.append(el('span', 'testplan-icon', '🧪'))
    sum.append(el('span', 'testplan-title', 'How to test this'))
    box.append(sum)

    const body = el('div', 'testplan-body')
    if (p.summary) body.append(el('div', 'testplan-summary', p.summary))

    if (p.steps && p.steps.length) {
      const ol = el('ol', 'testplan-steps')
      for (const st of p.steps) ol.append(el('li', null, st))
      body.append(ol)
    }

    if (p.links && p.links.length) {
      const row = el('div', 'testplan-links')
      for (const l of p.links) {
        const b = el('button', 'testlink kind-' + l.kind)
        b.append(el('span', 'testlink-icon', l.kind === 'file' ? '📄' : l.kind === 'url' ? '🔗' : '▶'))
        b.append(el('span', 'testlink-label', l.label))
        b.title =
          l.kind === 'file' ? 'Open ' + l.target + ' from the agent\'s worktree'
          : l.kind === 'command' ? 'Open a terminal in the worktree with: ' + l.target
          : 'Open ' + l.target
        b.onclick = () => post('testLink', { id: c.key, kind: l.kind, target: l.target })
        row.append(b)
      }
      body.append(row)
    }
    box.append(body)
    return box
  }

  /** What the agent changed, and the two ways to get it back: commit, then merge.
   *
   * This is the half of the loop the board exists for. A session parks itself in
   * a review column and stops; without this the user has to leave the editor,
   * find the worktree, and diff it by hand.
   */
  function renderReview(c) {
    const r = s.review
    const box = disclosure(el('details', 'review'), 'review', true)
    const sum = el('summary', 'review-head')
    sum.append(el('span', 'review-title', 'Changes'))
    if (r) {
      const bits = []
      if (r.ahead) bits.push(r.ahead + ' commit' + (r.ahead === 1 ? '' : 's'))
      if (r.dirty) bits.push(r.dirty + ' uncommitted')
      if (!bits.length) bits.push('nothing yet')
      sum.append(el('span', 'review-sub', bits.join(' · ')))
    } else {
      sum.append(el('span', 'review-sub', 'not loaded'))
    }
    box.append(sum)

    const body = el('div', 'review-body')
    if (!r) {
      const b = el('button', null, 'Show changes')
      b.onclick = () => post('review', { id: c.key })
      body.append(b)
      box.append(body)
      return box
    }

    body.append(el('div', 'review-meta', '⎇ ' + (c.branch || '') + '  →  ' + r.base))

    if (!r.files.length) {
      body.append(el('div', 'empty', 'No changes in this worktree yet.'))
    } else {
      const files = el('div', 'review-files')
      for (const f of r.files.slice(0, 200)) {
        const row = el('button', 'review-file' + (f.committed ? '' : ' uncommitted'))
        row.append(el('span', 'st st-' + f.status, f.status))
        row.append(el('span', 'fp', f.path))
        if (!f.committed) row.append(el('span', 'chip', 'uncommitted'))
        row.onclick = () => post('diff', { id: c.key, file: f.path })
        files.append(row)
      }
      body.append(files)
    }

    if (r.lastCommit) {
      body.append(el('div', 'review-commit', '● ' + r.lastCommit.sha + '  ' + r.lastCommit.message.split('\n')[0]))
    }

    const actions = el('div', 'row-actions')
    const refresh = el('button', null, 'Refresh')
    refresh.onclick = () => post('review', { id: c.key })
    actions.append(refresh)

    // Agents are told to stop before committing, so this is the usual next step.
    if (r.dirty) {
      const commit = el('button', null, 'Commit ' + r.dirty + ' file' + (r.dirty === 1 ? '' : 's') + '…')
      commit.onclick = () => post('commit', { id: c.key })
      actions.append(commit)
    }

    const merge = el('button', r.ahead ? 'primary' : null, 'Merge into ' + r.base + '…')
    merge.disabled = !r.ahead || s.busy === c.key
    merge.title = r.ahead
      ? 'Merge this branch into ' + r.base
      : 'Nothing committed to merge yet — commit the worktree first.'
    merge.onclick = () => post('merge', { id: c.key })
    actions.append(merge)

    body.append(actions)
    box.append(body)
    return box
  }

  function renderNewSessionHint() {
    const box = el('div', 'setup')
    box.append(el('h2', null, 'Start a session'))
    box.append(el('p', null, 'Describe what you want done. A card appears on the board, a git worktree is made for it, and the agent works there — so several sessions can run at once without colliding.'))
    if (s.noRepo) box.append(el('p', 'warn-note', 'This folder is not a git repository, so sessions cannot start yet.'))
    return box
  }

  /** Messages typed while the agent was still working.
   *
   * They are held until the turn ends, so without this they simply vanish from
   * the screen after you press Enter and reappear minutes later. */
  function renderQueued(c) {
    const box = el('div', 'queued')
    const head = el('div', 'queued-head')
    head.append(el('span', null, c.queued.length + ' queued for when this turn ends'))
    head.append(el('span', 'spacer'))
    const clear = el('button', null, 'Discard')
    clear.title = 'Drop the queued messages'
    clear.onclick = () => post('clearQueue', { id: c.key })
    head.append(clear)
    box.append(head)
    for (const q of c.queued) box.append(el('div', 'queued-item', q))
    return box
  }

  /** The live block: text as it arrives, with a caret. */
  function renderStreaming(text) {
    const b = el('div', 'block streaming')
    const h = el('div', 'block-head')
    h.append(el('span', 'who', 'Claude Agent'))
    b.append(h)
    const d = renderMarkdown(text)
    // The caret goes on the line being written, when there is one.
    const last = d.children && d.children[d.children.length - 1]
    ;(last && String(last.tagName).toLowerCase() === 'p' ? last : d).append(el('span', 'caret'))
    b.append(d)
    return b
  }

  function renderComposer(c) {
    const wrap = el('div', 'composer-wrap')

    const bar = el('div', 'composer-bar')
    bar.append(el('span', 'agent-badge', 'AGENT'))
    /* The menu carries the CLI's own one-liner for each model. That is what
       makes "Default (recommended) — Opus 5 with 1M context" a choice rather
       than a list of ids, and it costs nothing: the description arrived with
       the model list. */
    bar.append(picker('model', modelLabel(s.composer.model), s.composer.models.map((m) => ({
      value: m.id,
      label: `${m.label} (${m.context})` + (m.detail ? ' — ' + m.detail : ''),
    })), undefined, modelSourceNote()))
    /* WHICH AGENT PROGRAM the next session runs on — Claude Code, Codex.
       This replaced the backend picker that used to sit here, because the two
       are different questions and only one of them belongs on a composer bar:
       the agent is chosen per session, beside the prompt, like the model; the
       backend is configuration, and configuration in a menu that closes when
       you look away is configuration you lose halfway through typing.

       For a runtime whose backend IS selectable, the chip still says which one
       is active, because that is a statement about the run you are about to
       start rather than a control. The menu's last entry opens the settings
       page, which is now the only place a backend is edited. */
    bar.append(picker('runtime', '🤖 ' + agentName(), (s.composer.runtimes || []).map((r) => ({
      value: r.id,
      label: r.label + (r.detail ? ' — ' + r.detail : ''),
    })).concat([{ command: 'openSettings', label: '⚙  Agents, backends and logins…' }])))
    /* HOW EAGERLY this card should break its work into subtasks.
       Per card, beside the model, because it is a judgement about THIS piece of
       work: someone with one huge objective and five trivial ones must not have
       to change a workspace setting and remember to change it back.
       It biases the agent and does not dictate a number. The only thing it
       changes is which sentence the agent's brief carries, so a trivial task
       stays one agent at Maximum and a genuinely unrelated pair still splits at
       Minimal — neither of those is a rule the dial can move.
       HIDDEN, never greyed, where it cannot take effect: a workspace with no
       git repository has no `split_task` at all, and a control that is visible
       and inert is the thing this board has a rule about. */
    if (s.composer.orchestrationLevels && s.composer.orchestrationLevels.length) {
      bar.append(picker(
        'orchestration',
        '⑂ ' + orchestrationLabel(),
        (s.composer.orchestrationLevels || []).map((o) => ({
          value: o.key,
          label: o.label + ' — ' + o.detail,
        })),
        s.selectedKey,
        s.composer.orchestrationNote,
      ))
    }
    /* Both of these are per MODEL, and both DISAPPEAR when the selected model
       does not have them. Haiku 4.5 accepts no effort levels and has no
       adaptive thinking, and it was being shown the full five-level picker and
       an On/Off toggle — two controls that could not say no, which is the same
       class of bug as a spinner over a wedged process. Hidden rather than
       greyed out: "why is this disabled" has no answer worth reading. */
    if (s.composer.efforts.length) {
      bar.append(picker('effort', effortLabel(), s.composer.efforts.map((e) => ({ value: e.key, label: e.label }))))
    }
    if (s.composer.thinkingSupported !== false) {
      bar.append(picker('thinking', 'Extended: ' + (s.composer.thinking === 'disabled' ? 'Off' : 'On'), [
        { value: 'enabled', label: 'Extended: On' },
        { value: 'disabled', label: 'Extended: Off' },
      ]))
    }
    /* Ultracode: xhigh effort plus standing workflow orchestration. Offered
       ONLY on a model the CLI says can run it, because the flag itself is
       accepted without validation — `applyFlagSettings` resolves for a made-up
       key — so the capability gate is the only check available before the run.
       It replaces the effort picker rather than sitting beside it: ultracode
       IS xhigh, and two controls arguing over one value is worse than one. */
    if (s.composer.ultracodeSupported) {
      bar.append(picker('ultracode', '⚡ Ultracode: ' + (s.composer.ultracode ? 'On' : 'Off'), [
        { value: 'off', label: 'Ultracode: Off' },
        { value: 'on', label: 'Ultracode: On — xhigh effort, and it orchestrates workflows' },
      ], undefined, undefined, s.composer.ultracode ? 'on' : 'off'))
    }
    if (s.composer.fastModeSupported) {
      bar.append(picker('fastMode', '🚀 Fast: ' + (s.composer.fastMode ? 'On' : 'Off'), [
        { value: 'off', label: 'Fast mode: Off' },
        { value: 'on', label: 'Fast mode: On — same model, faster output' },
      ], undefined, undefined, s.composer.fastMode ? 'on' : 'off'))
    }
    // Changeable mid-run: the SDK applies it to a live session, not just the next.
    const modes = s.composer.permissionModes || []
    const cur = modes.find((m) => m.key === s.composer.permissionMode)
    bar.append(picker(
      'permissionMode',
      '🔑 ' + (cur ? cur.label : 'Ask'),
      modes.map((m) => ({ value: m.key, label: m.label + ' — ' + m.detail })),
      c ? c.key : undefined,
    ))
    /* The provider warning, and the reason this feature is trustworthy rather
       than decorative. Two cases reach here: a profile missing a required field
       (no session can start on it), and a LIVE RUN whose CLI reported a
       different backend than the profile asked for. The second is the one that
       matters — a managed settings file or an apiKeyHelper outranks anything we
       put in the environment, and without this the bar would keep naming the
       provider we requested while somebody else's account was billed. */
    if (s.composer.providerNote) {
      const note = el('span', 'provider-note', '⚠ ' + s.composer.providerNote)
      note.title = s.composer.providerNote
      bar.append(note)
    }
    bar.append(el('div', 'spacer'))
    /* Context fill and spend, and they STAY. Both used to come only from a
       live run, so restarting VS Code — or opening a session that finished
       before the window did — left this corner of the bar empty, which reads
       as "nobody is counting". They are now totalled from the transcript when
       nothing is running, so what is drawn here does not depend on whether the
       agent happens to be alive. */
    /* One GROUP, so the two readouts cannot be separated. The bar is
       `flex-wrap: wrap`, and appending the spend figure as a sibling put it at
       the far LEFT of a second row the moment the pickers filled the first —
       the opposite of "next to the context", with its separator rule dangling
       at the start of a line. Grouped, they wrap together or not at all. */
    const readouts = el('div', 'readouts')
    // Counted rather than read back off the node: the stub DOM the view tests
    // run against has no `childNodes`, and that is the point of it — a view
    // that only works against a real browser cannot be unit-tested at all.
    let readoutCount = 0
    if (s.composer.contextWindow) {
      const meter = el('span', 'ctx-meter')
      const fill = el('span', 'ctx-fill')
      const ratio = Math.min(1, s.composer.contextTokens / s.composer.contextWindow)
      fill.style.width = (ratio * 100).toFixed(1) + '%'
      if (ratio > 0.85) fill.classList.add('hot')
      meter.append(fill)
      readouts.append(meter)
      const ctx = el('span', 'ctx', pct(s.composer.contextTokens, s.composer.contextWindow))
      ctx.title = 'Context used by the last response, of this session’s window'
      readouts.append(ctx)
      readoutCount += 2
    } else if (s.composer.contextTokens) {
      // Tokens without a window. Showing the count alone beats showing nothing:
      // it is the number the percentage would have been derived from.
      const ctx = el('span', 'ctx', fmtTokens(s.composer.contextTokens))
      ctx.title = 'Context used by the last response. The window this session ran with is unknown.'
      readouts.append(ctx)
      readoutCount++
    }
    const spend = renderMeter(s.composer.meter)
    if (spend) { readouts.append(spend); readoutCount++ }
    if (readoutCount) bar.append(readouts)
    wrap.append(bar)

    // `/name args` is executed by the Agent SDK as the matching
    // .claude/commands/*.md — that always worked, but nothing listed them, so
    // nobody knew they were there.
    const matches = slashMatches(draft)
    if (matches.length) wrap.append(renderSlashMenu(matches))

    const row = el('div', 'composer')
    const ta = el('textarea')
    composerInput = ta
    ta.placeholder = c ? 'Reply… (Enter to send, Shift+Enter for a new line)' : 'What should the agent do? (Enter to start)'
    ta.value = draft
    ta.rows = 1
    ta.oninput = (e) => {
      const had = slashKey(draft)
      draft = e.target.value
      e.target.style.height = 'auto'
      e.target.style.height = Math.min(160, e.target.scrollHeight) + 'px'
      const now = slashKey(draft)
      // Compare the actual match SET, not its size. Comparing counts left the
      // menu showing the old commands whenever a different query happened to
      // match the same number — and clicking a row inserted the stale one.
      if (had !== now) { slashPick = now ? 0 : -1; render() }
    }
    ta.onkeydown = (e) => {
      const list = slashMatches(draft)
      if (list.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          slashPick = (slashPick + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length
          render()
          return
        }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
          e.preventDefault()
          chooseSlash(list[Math.max(0, slashPick)])
          return
        }
        if (e.key === 'Escape') { e.preventDefault(); slashPick = -1; draft = draft + ' '; render(); return }
      }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    }
    // Paste is the way people actually attach a screenshot: ⌘⇧4 then ⌘V. The
    // clipboard also carries a text/plain flavour for a copied image on some
    // platforms, so the image items are taken and the default is prevented
    // only when there was one — otherwise pasting text would stop working.
    ta.onpaste = (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || []
      const files = []
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && String(items[i].type || '').indexOf('image/') === 0) {
          const f = items[i].getAsFile()
          if (f) files.push(f)
        }
      }
      if (!files.length) return
      e.preventDefault()
      addImageFiles(files)
    }
    // Dragging a file in from Finder is the other half. `dragover` must be
    // prevented or the browser navigates the webview to the file instead.
    ta.ondragover = (e) => { e.preventDefault() }
    ta.ondrop = (e) => {
      const files = e.dataTransfer && e.dataTransfer.files
      if (!files || !files.length) return
      e.preventDefault()
      addImageFiles(Array.prototype.slice.call(files))
    }

    const clip = el('button', 'attach', '📎')
    clip.title = 'Attach an image'
    clip.onclick = () => {
      const picker = el('input')
      picker.type = 'file'
      picker.accept = 'image/png,image/jpeg,image/gif,image/webp'
      picker.multiple = true
      picker.onchange = () => addImageFiles(Array.prototype.slice.call(picker.files || []))
      picker.click()
    }

    const send = el('button', 'primary send', '➤')
    send.title = c ? 'Send' : 'Start session'
    send.onclick = submit
    function submit() {
      const text = draft.trim()
      // An images-only message is a real message — "look at this" is the whole
      // point of attaching a screenshot.
      if (!text && !attachments.length) return
      const images = attachments.map((a) => ({ name: a.name, mediaType: a.mediaType, data: a.data }))
      draft = ''; ta.value = ''; ta.style.height = 'auto'; stick = true
      attachments = []
      if (c) post('send', { id: c.key, text, images })
      else post('newSession', { text, images })
      render()
    }
    row.append(ta, clip, send)
    if (attachments.length) wrap.append(renderAttachments())
    wrap.append(row)
    return wrap
  }

  /** Suggestions for the `/` the user is part-way through typing. */
  function slashMatches(text) {
    if (!/^\/[\w:-]*$/.test(text)) return []
    const q = text.slice(1).toLowerCase()
    return (s.commands || []).filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8)
  }

  /** Identity of the current suggestion set, for deciding whether to repaint. */
  function slashKey(text) {
    return slashMatches(text).map((c) => c.name).join('\u0000')
  }

  function chooseSlash(cmd) {
    if (!cmd) return
    // A space, not a send: most commands take arguments, and sending on Tab
    // would fire the bare command before the user typed them.
    draft = '/' + cmd.name + ' '
    slashPick = -1
    render()
  }

  function renderSlashMenu(list) {
    const box = el('div', 'slash-menu')
    list.forEach((cmd, i) => {
      const row = el('button', 'slash-item' + (i === Math.max(0, slashPick) ? ' on' : ''))
      row.append(el('span', 'slash-name', '/' + cmd.name))
      if (cmd.description) row.append(el('span', 'slash-desc', cmd.description))
      row.append(el('span', 'spacer'))
      row.append(el('span', 'slash-scope', cmd.scope))
      row.onclick = (e) => { stop(e); chooseSlash(cmd) }
      box.append(row)
    })
    box.append(el('div', 'slash-hint', 'Tab or Enter to pick · ↑↓ to move · Esc to dismiss'))
    return box
  }

  /** `note` is a non-clickable footer under the menu — used to say where a list
   *  came from, which is the only way "why is my model missing?" is answerable.
   *
   *  `selected` overrides how the tick is decided. The default — "the composer
   *  field named `key` holds the chosen value" — holds for model, effort and
   *  thinking, but not for a BOOLEAN field offered as on/off options: comparing
   *  `true` to `'on'` is never equal, so the menu would open with nothing
   *  ticked and no way to tell which way the switch is set. */
  function picker(key, label, options, forKey, note, selected) {
    const chosen = selected === undefined ? s.composer[key] : selected
    const wrap = el('span', 'picker-wrap')
    const b = el('button', 'picker', label + ' ▾')
    // The label may be ellipsised on a narrow bar, so the full one is always
    // reachable. A control whose text is cut off and unexplained is the same
    // failure as one that is cut off and wrapped.
    b.title = label
    b.onclick = (e) => { stop(e); openMenu = openMenu === 'composer:' + key ? null : 'composer:' + key; render() }
    wrap.append(b)
    if (openMenu === 'composer:' + key) {
      const menu = el('div', 'menu up')
      menu.onclick = stop
      for (const o of options) {
        const i = el('button', 'menu-item' + (chosen === o.value ? ' on' : ''), o.label)
        /* An option may be an ACTION rather than a value — "Configure
           providers…" opens a quick pick host-side. Without this the provider
           picker could only ever choose between profiles that already exist,
           so the first one would have to be created from the command palette
           by somebody who already knew it was there. */
        i.onclick = o.command
          ? (e) => { stop(e); openMenu = null; post(o.command) }
          : (e) => {
              stop(e); openMenu = null
              post('composer', forKey ? { [key]: o.value, id: forKey } : { [key]: o.value })
            }
        menu.append(i)
      }
      if (note) menu.append(el('div', 'menu-note', note))
      wrap.append(menu)
    }
    return wrap
  }

  /* The prefix used to be the literal string "Claude Agent". That is no longer
     something we know: the session may be running on Bedrock, on a gateway, or
     through a proxy in front of a local model, and a bar that says "Claude"
     over a Qwen session is simply wrong. So the prefix is the ACTIVE PROVIDER —
     and when a run has told us what it actually resolved, that wins over the
     profile we asked for, because the CLI is the only witness that counts. */
  /* The chip on the agent picker.
     Names the runtime, and — only where a backend is a real choice — the
     backend beside it. A Codex session gets no second half rather than an
     invented one: it signs in as itself and there is nothing behind it to
     name. */
  function agentName() {
    const id = s.composer.runtime || 'claude'
    const r = (s.composer.runtimes || []).find((x) => x.id === id)
    const label = r ? r.label : id
    if (r && r.providerProfiles === false) return label
    const backend = providerName()
    return backend && backend !== 'Provider' ? label + ' · ' + backend : label
  }

  function providerName() {
    /* The RUNNING agent's answer wins over the profile we asked for.
       `resolvedProvider` and `providerLabel` are what the CLI reported it is
       ACTUALLY on — a managed settings file, an `apiKeyHelper` or an env block
       in `~/.claude/settings.json` all outrank our request. The host has
       computed both onto every card since the feature was written and the view
       read neither, so the chip could only ever repeat our own configuration
       back, which is the decorative readout the rule about this names. */
    const live = selected() && selected().agent
    if (live && (live.providerLabel || live.resolvedProvider)) {
      return live.providerLabel || live.resolvedProvider
    }
    const id = s.composer.provider
    const p = (s.composer.providers || []).find((x) => x.id === id)
    if (!p) return 'Provider'
    /* The inherit profile makes no claim about the backend, so its chip must
       not make one either: it says where the answer comes FROM rather than
       naming a provider we have not been told about. */
    return p.id === 'inherit' ? 'Inherited' : p.label
  }
  /* The level's own label. Falls back to the raw key rather than to a guess:
     a build that stored a level this one does not serve should say so, not
     silently show "Balanced". */
  function orchestrationLabel() {
    const key = s.composer.orchestration
    const found = (s.composer.orchestrationLevels || []).find((o) => o.key === key)
    return found ? found.label : (key || 'Split')
  }

  function modelLabel(id) {
    const m = s.composer.models.find((x) => x.id === id)
    return m ? m.label : 'Model'
  }
  /* Where the model list came from. Only shown when it is NOT the CLI's, because
     that is the only case with a question attached: "why is the model I use in
     Claude Code missing from this picker?" is unanswerable unless you can see
     that we fell back. */
  function modelSourceNote() {
    const src = s.composer.modelSource
    if (!src || src === 'cli') return undefined
    if (src === 'profile') return 'Models listed by this provider profile'
    return 'Built-in list' + (s.composer.modelNote ? ' — ' + s.composer.modelNote : '') +
      '. Refresh from the provider menu.'
  }
  function effortLabel() {
    const e = s.composer.efforts.find((x) => x.key === s.composer.effort)
    // Falling back to the literal "High" would name a level that may not be
    // selected. The first offered level is at least one this model has.
    return e ? e.label : (s.composer.efforts[0] ? s.composer.efforts[0].label : 'Effort')
  }
  // Matches how the CLI reads: 82k/1M (8%). A million-token window shown as
  // "1000k" is technically right and reads wrong.
  /** What is attached to the message being composed, with a way to take each
   *  one off again. Shown ABOVE the input: it is part of the message, and a
   *  strip below the send button reads as something already sent. */
  function renderAttachments() {
    const strip = el('div', 'attachments')
    for (const a of attachments) {
      const chip = el('div', 'attachment')
      const img = el('img', 'attachment-thumb')
      img.src = a.dataUrl
      img.alt = a.name
      img.title = a.name + (a.w ? '  ' + a.w + '×' + a.h : '')
      chip.append(img)
      const x = el('button', 'attachment-x', '×')
      x.title = 'Remove ' + a.name
      x.onclick = () => { attachments = attachments.filter((o) => o.id !== a.id); render() }
      chip.append(x)
      strip.append(chip)
    }
    const note = el('span', 'attachments-note',
      attachments.length + (attachments.length === 1 ? ' image' : ' images') + ' will be sent with this message')
    strip.append(note)
    return strip
  }

  /**
   * Read image files into `attachments`, downscaled.
   *
   * The downscale is not cosmetic: an image costs roughly width×height/750
   * tokens, so a retina screen grab is ~5k tokens of context before anybody
   * has said anything about it, and past 1568px on the long edge the service
   * scales it down anyway — so those tokens buy detail the model never sees.
   * Doing it here, where the bitmap already is, keeps the host out of image
   * decoding entirely.
   */
  function addImageFiles(files) {
    const MAX_EDGE = 1568
    const MAX_AT_ONCE = 8
    /* The room is worked out ONCE, before anything is read.
       It used to be `attachments.length + queued >= MAX`, which double-counts:
       each file's decode appends to `attachments`, so once decoding completes
       before the loop moves on — a cached image, or a fast small one — every
       file counted twice and twelve pasted images became four. The limit then
       depended on decode timing, which is the worst kind of limit. */
    const room = Math.max(0, MAX_AT_ONCE - attachments.length)
    const take = []
    for (const f of files) {
      if (String(f.type || '').indexOf('image/') !== 0) continue
      if (take.length >= room) break
      take.push(f)
    }
    for (const file of take) {
      const reader = new FileReader()
      reader.onload = () => {
        const img = new Image()
        img.onload = () => {
          const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height))
          let dataUrl = String(reader.result)
          let w = img.width, h = img.height
          if (scale < 1) {
            w = Math.round(img.width * scale)
            h = Math.round(img.height * scale)
            const canvas = document.createElement('canvas')
            canvas.width = w; canvas.height = h
            const ctx = canvas.getContext('2d')
            ctx.drawImage(img, 0, 0, w, h)
            // PNG for a screenshot: text and UI edges are what these are FOR,
            // and JPEG at any quality smears exactly those.
            dataUrl = canvas.toDataURL('image/png')
          }
          const comma = dataUrl.indexOf(',')
          const header = dataUrl.slice(0, comma)
          attachments = attachments.concat([{
            id: 'att-' + (++attachSeq),
            name: file.name || 'pasted-image.png',
            mediaType: (/data:([^;]+)/.exec(header) || [])[1] || 'image/png',
            data: dataUrl.slice(comma + 1),
            dataUrl: dataUrl,
            w: w, h: h,
          }])
          render()
        }
        // A file that is not decodable is not an image, whatever it claims.
        img.onerror = () => {}
        img.src = String(reader.result)
      }
      reader.onerror = () => {}
      reader.readAsDataURL(file)
    }
  }

  function fmtTokens(n) {
    if (n >= 1_000_000) {
      const m = n / 1_000_000
      return (m >= 10 || Number.isInteger(m) ? Math.round(m) : m.toFixed(1)) + 'M'
    }
    if (n >= 1000) return Math.round(n / 1000) + 'k'
    return String(n)
  }

  /* Floored, not rounded: 998k of 1M is 99.8% full, and rounding it to "100%"
     says the window is gone when there is a megabyte-fifth of it left. The
     number may only claim 100% when there is genuinely nothing left. */
  function pct(used, total) {
    return `${fmtTokens(used)}/${fmtTokens(total)} (${Math.floor((used / total) * 100)}%)`
  }

  /* Dollars, and never a rounded-away zero: a session that has spent four
     tenths of a cent must not report `$0.00`, because that is the one thing
     the number is there to disprove. Mirrors formatUsd's rules in
     sessions/usage.ts; the webview has no imports, so it cannot share it. */
  function fmtUsd(usd) {
    if (!Number.isFinite(usd) || usd <= 0) return '$0.00'
    if (usd < 0.01) return '$' + usd.toFixed(3)
    if (usd < 100) return '$' + usd.toFixed(2)
    return '$' + Math.round(usd)
  }

  /* What this session has consumed, in the unit its runtime can actually
     justify — three cases, because there are three different claims.

     This used to be `if (Number.isFinite(spentUsd))` over a dollar figure, and
     only ONE runtime emits dollars: every Codex session arrived with a zero and
     the bar read `$0.00` over a card that had spent 13% of a five-hour window.
     A `Meter` is a union for exactly that reason, and `unknown` renders as an
     em dash and NEVER as zero — "we could not read it" is not "nothing was
     spent". Returns null when there is no reading at all, so the chip is absent
     rather than empty.

     Every branch shows the number the indicator is derived from, and says in
     its tooltip where that number came from, so it can be checked rather than
     believed. */
  function renderMeter(m) {
    if (!m || typeof m !== 'object') return null
    if (m.kind === 'usd') {
      // `Number.isFinite`, not `typeof`: NaN and Infinity are both numbers, and
      // "$NaN" on the composer bar is worse than no figure at all.
      if (!Number.isFinite(m.spentUsd)) return null
      const priced = m.priced !== false
      const chip = el('span', 'spend' + (priced ? '' : ' partial'),
        (priced ? '' : '≥ ') + fmtUsd(m.spentUsd))
      /* It is arithmetic on the token counts in the transcript, not a figure
         handed to us: input, output, cache writes and cache reads, each at its
         model's published rate. A live run checks itself against the CLI's own
         `total_cost_usd` at the end of every turn and warns in the output
         channel if the two disagree. */
      chip.title = priced
        ? 'Total spend this session, priced from the token counts in its transcript'
        : 'At least this much: a model in this session has no published rate here, so its tokens are uncounted'
      return chip
    }
    if (m.kind === 'plan') {
      if (!Number.isFinite(m.usedPercent)) return null
      const bits = [Math.round(m.usedPercent) + '% of ' + fmtWindow(m.windowMinutes)]
      if (m.plan) bits.push(String(m.plan))
      const chip = el('span', 'spend plan', bits.join(' · '))
      /* The reset time is the actionable half: a percentage with no reset
         cannot be planned around. */
      const resets = Number.isFinite(m.resetsAt) ? fmtResets(m.resetsAt) : '';
      chip.title = 'This session is billed by subscription, so it has no per-request price. '
        + 'This is how much of the rate-limit window it has used'
        + (resets ? ', resetting ' + resets : '')
        + (m.secondary && Number.isFinite(m.secondary.usedPercent)
            ? ' — and ' + Math.round(m.secondary.usedPercent) + '% of '
              + fmtWindow(m.secondary.windowMinutes)
            : '')
        + '.'
      return chip
    }
    if (m.kind === 'unknown') {
      const chip = el('span', 'spend unknown', '—')
      chip.title = 'This session\'s runtime did not report what it has consumed. '
        + 'Not zero — unknown.'
      return chip
    }
    return null
  }

  /* A rate-limit window as the service states it: minutes in, "5h" or "7d" out. */
  function fmtWindow(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return '?'
    if (minutes % 1440 === 0) return (minutes / 1440) + 'd'
    if (minutes % 60 === 0) return (minutes / 60) + 'h'
    return minutes + 'm'
  }

  /* Unix SECONDS — what the services report — never milliseconds.
     Its own arithmetic rather than fmtDuration, which is built for a tool call
     and would render a two-hour window as "120m 0s". */
  function fmtResets(atSeconds) {
    const mins = Math.round((atSeconds * 1000 - Date.now()) / 60000)
    if (!Number.isFinite(mins)) return ''
    if (mins <= 0) return 'now'
    if (mins < 60) return 'in ' + mins + 'm'
    const h = Math.floor(mins / 60)
    return 'in ' + h + 'h' + (mins % 60 ? ' ' + (mins % 60) + 'm' : '')
  }

  // ------------------------------------------------------- transcript rows

  // ------------------------------------------------------------------ markdown
  /* The agent writes markdown, and the transcript used to show it raw: `##` and
     `**` as characters, a table as a wall of pipes, a code fence as three
     literal backticks with the code in proportional type. Nimbalyst renders
     through Lexical with Shiki; that is a React editor framework, and this view
     has no framework by design. So: a small renderer that BUILDS NODES. There is
     no innerHTML here and there must never be — the text is another program's
     output, so anything in it that looks like HTML is shown as the characters
     it is, never parsed. `markdown.test.mjs` checks exactly that.

     Covered: headings, paragraphs (a single newline is a line break, as in
     every chat surface), fenced code with a language label and a Copy button,
     inline code, bold, italic, strikethrough, links (http/https/mailto only —
     anything else is rendered as its text), bare URLs, bullet and numbered
     lists with nesting by indentation, pipe tables, block quotes, rules.
     Not covered, on purpose: raw HTML, footnotes, images. A fence that has not
     closed yet renders as a code block, because that is what streaming
     produces most of the time. */
  const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/
  const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
  const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
  const QUOTE = /^\s{0,3}>\s?(.*)$/
  const ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/
  const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/
  const SAFE_HREF = /^(https?:|mailto:)/i
  const BARE_URL = /^https?:\/\/[^\s<>()[\]]+/

  function renderMarkdown(text) {
    const box = el('div', 'assistant-text md')
    for (const n of mdBlocks(String(text == null ? '' : text))) box.append(n)
    return box
  }

  const isTableStart = (line, next) =>
    line.includes('|') && next != null && next.includes('|') && TABLE_SEP.test(next)
  const isBlockStart = (line, next) =>
    FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line) || isTableStart(line, next)

  /** Block structure. `tight` is for list items: a lone paragraph comes back as
   *  a <span> so "- one" is an <li> with text in it, not an <li> with a <p>. */
  function mdBlocks(src, tight) {
    const lines = src.replace(/\r\n?/g, '\n').split('\n')
    const out = []
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim()) { i++; continue }
      let m
      if ((m = FENCE.exec(line))) {
        const close = new RegExp('^\\s{0,3}' + m[1][0] + '{' + m[1].length + ',}\\s*$')
        const body = []
        i++
        while (i < lines.length && !close.test(lines[i])) body.push(lines[i++])
        i++ // the closing fence — or one past the end, which is the streaming case
        out.push(codeBlock(m[2], body.join('\n')))
        continue
      }
      if ((m = HEADING.exec(line))) {
        const h = el('h' + m[1].length)
        h.append(...inline(m[2]))
        out.push(h); i++; continue
      }
      if (HR.test(line)) { out.push(el('hr')); i++; continue }
      if (QUOTE.test(line)) {
        const q = []
        while (i < lines.length && (m = QUOTE.exec(lines[i]))) { q.push(m[1]); i++ }
        const bq = el('blockquote')
        for (const n of mdBlocks(q.join('\n'))) bq.append(n)
        out.push(bq); continue
      }
      if (isTableStart(line, lines[i + 1])) {
        const rows = [line]
        i += 2
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(lines[i++])
        out.push(table(rows)); continue
      }
      if ((m = ITEM.exec(line))) {
        // One list runs until a blank line that is not followed by more of it —
        // or until a bullet gives way to a number (or back) at the same level,
        // which is a NEW list, not a fourth item of the old one.
        const base = m[1].length
        const ordered = /\d/.test(m[2])
        const block = []
        while (i < lines.length) {
          const l = lines[i]
          const it = ITEM.exec(l)
          if (it && it[1].length <= base && /\d/.test(it[2]) !== ordered) break
          const cont = (x) => ITEM.test(x) || /^\s+\S/.test(x)
          if (cont(l)) { block.push(l); i++; continue }
          if (!l.trim() && i + 1 < lines.length && cont(lines[i + 1])) { block.push(l); i++; continue }
          break
        }
        out.push(list(block)); continue
      }
      const para = [line]
      i++
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++])
      const p = el(tight ? 'span' : 'p')
      para.forEach((l, k) => { if (k) p.append(el('br')); p.append(...inline(l)) })
      out.push(p)
    }
    return out
  }

  function codeBlock(lang, code) {
    const box = el('div', 'codeblock')
    const head = el('div', 'codeblock-head')
    head.append(el('span', 'codeblock-lang', lang || ''))
    const copy = el('button', 'codeblock-copy', 'Copy')
    copy.title = 'Copy the code'
    copy.onclick = (e) => { stop(e); copyText(code, copy) }
    head.append(copy)
    const pre = el('pre')
    const c = el('code', lang ? 'lang-' + lang : null, code)
    pre.append(c)
    box.append(head, pre)
    return box
  }

  function copyText(text, btn) {
    const done = () => {
      btn.textContent = 'Copied'
      if (typeof setTimeout === 'function') setTimeout(() => { btn.textContent = 'Copy' }, 1500)
    }
    // A webview is a secure context, so the async clipboard is normally there.
    // The textarea dance is for when it is not.
    const fallback = () => {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.append(ta)
      ta.select()
      try { document.execCommand('copy'); done() } catch (e) { /* nothing to copy with */ }
      ta.remove()
    }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback)
        return
      }
    } catch (e) { /* fall through */ }
    fallback()
  }

  function list(block) {
    const first = ITEM.exec(block[0])
    const ordered = /\d/.test(first[2])
    const root = el(ordered ? 'ol' : 'ul')
    if (ordered && parseInt(first[2], 10) > 1) root.setAttribute('start', String(parseInt(first[2], 10)))
    const base = first[1].length
    const width = base + first[2].length + 1
    const items = []
    let cur = null
    for (const l of block) {
      const m = ITEM.exec(l)
      if (m && m[1].length <= base) { cur = [m[3]]; items.push(cur) }
      else if (cur) {
        const lead = /^\s*/.exec(l)[0].length
        cur.push(l.trim() ? l.slice(Math.min(width, lead)) : '')
      }
    }
    for (const lines of items) {
      const li = el('li')
      for (const n of mdBlocks(lines.join('\n'), true)) li.append(n)
      root.append(li)
    }
    return root
  }

  function table(rows) {
    const cells = (r) => {
      let t = r.trim()
      if (t.startsWith('|')) t = t.slice(1)
      if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1)
      return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim())
    }
    const wrap = el('div', 'table-wrap')
    const tb = el('table')
    const thead = el('thead'), hr = el('tr')
    for (const c of cells(rows[0])) { const th = el('th'); th.append(...inline(c)); hr.append(th) }
    thead.append(hr)
    const tbody = el('tbody')
    for (const r of rows.slice(1)) {
      const tr = el('tr')
      for (const c of cells(r)) { const td = el('td'); td.append(...inline(c)); tr.append(td) }
      tbody.append(tr)
    }
    tb.append(thead, tbody)
    wrap.append(tb)
    return wrap
  }

  /** Inline markdown → an array of nodes. Text is accumulated and emitted as
   *  text nodes; only the markers below ever become elements. */
  function inline(str) {
    const out = []
    let buf = ''
    const flush = () => { if (buf) { out.push(document.createTextNode(buf)); buf = '' } }
    const MARKS = [['**', 'strong'], ['__', 'strong'], ['~~', 'del'], ['*', 'em'], ['_', 'em']]
    let i = 0
    const n = str.length
    while (i < n) {
      const ch = str[i]
      if (ch === '\\' && i + 1 < n && /[\\`*_{}[\]()#+\-.!~|>]/.test(str[i + 1])) { buf += str[i + 1]; i += 2; continue }
      if (ch === '`') {
        const run = /^`+/.exec(str.slice(i))[0]
        let end = str.indexOf(run, i + run.length)
        while (end !== -1 && str[end + run.length] === '`') end = str.indexOf(run, end + 1)
        if (end !== -1) {
          flush()
          out.push(el('code', null, str.slice(i + run.length, end).replace(/^ (.*[^ ].*) $/, '$1')))
          i = end + run.length
          continue
        }
        buf += run; i += run.length; continue
      }
      if (ch === '[') {
        const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(str.slice(i))
        if (m) {
          flush()
          if (SAFE_HREF.test(m[2])) { const a = el('a'); a.href = m[2]; a.append(...inline(m[1])); out.push(a) }
          else out.push(...inline(m[1]))
          i += m[0].length
          continue
        }
      }
      if (ch === 'h' && (str.startsWith('http://', i) || str.startsWith('https://', i)) && (i === 0 || /[\s(\["'<]/.test(str[i - 1]))) {
        /* The guard and the extraction were two DIFFERENT predicates, and the
           gap between them was a blank panel.

           `startsWith('https://')` is satisfied by the scheme alone; BARE_URL
           needs `[^\s<>()[\]]+` — at least one character after it, and not one
           of those. So `exec` returned null and `null[0]` threw a TypeError,
           which unwound through inline() → mdBlocks() → renderMarkdown() →
           renderChat() → render() — and render() calls replaceChildren() before
           it builds anything, so the tree was already empty. Nothing catches it:
           the whole chat view went blank with no transcript, no rail, no
           composer and no error, and it re-threw on every subsequent frame
           because the text was in Claude Code's on-disk transcript.

           Five real strings did it, not just a bare scheme — verified against
           the real board.js: "https:// followed by a host", a line ending in
           "http://", "(http://)", `https://<your-gateway-host>/v1` (the
           placeholder this extension's own provider documentation uses), and
           `https://[::1]:8080`, which is a perfectly valid IPv6 URL.

           So: match first, and fall through to the literal-text path when there
           is nothing to link. `continue` is deliberately NOT taken here — the
           tail of the loop emits the character as text and advances, which is
           what makes an unlinkable scheme render as the characters the agent
           actually wrote. */
        const um = BARE_URL.exec(str.slice(i))
        if (um) {
          const url = um[0].replace(/[.,;:!?'"]+$/, '')
          flush()
          const a = el('a', null, url); a.href = url
          out.push(a)
          i += url.length
          continue
        }
      }
      let matched = false
      for (const [mark, tag] of MARKS) {
        if (!str.startsWith(mark, i)) continue
        const prev = i ? str[i - 1] : ''
        const next = str[i + mark.length]
        if (!next || /\s/.test(next)) break
        if (mark[0] === '_' && /\w/.test(prev)) break
        let j = str.indexOf(mark, i + mark.length)
        while (j !== -1) {
          const before = str[j - 1], after = str[j + mark.length]
          if (!/\s/.test(before) && !(mark[0] === '_' && after && /\w/.test(after))) break
          j = str.indexOf(mark, j + 1)
        }
        if (j !== -1) {
          flush()
          const e = el(tag)
          e.append(...inline(str.slice(i + mark.length, j)))
          out.push(e)
          i = j + mark.length
          matched = true
        }
        break
      }
      if (matched) continue
      buf += ch; i++
    }
    flush()
    return out
  }

  function renderEntry(e, c) {
    switch (e.kind) {
      case 'prompt': {
        const body = el('div', 'prompt', e.text)
        // The bytes are not kept in the board's state — see Entry.images — so
        // the row says how many went with the message rather than showing them.
        // Without this an images-only message renders as an empty bubble.
        if (e.images) {
          const note = el('div', 'prompt-images',
            '🖼 ' + e.images + (e.images === 1 ? ' image' : ' images') + ' attached')
          const wrap2 = el('div', 'prompt-wrap')
          wrap2.append(body, note)
          return block('You', e.at, wrap2)
        }
        return block('You', e.at, body)
      }
      case 'text': return block('Claude Agent', e.at, renderMarkdown(e.text))
      case 'thinking': {
        /* Through disclosure(), like every other <details>. These two were the
           only ones that were not, so `forEachDisclosure()` — which selects
           `[data-open]` — never harvested them and never restored them. Opening
           one lasted until the next streamed frame, which is the documented
           "it keeps reopening, I want it toggled by me only" postmortem in the
           two places its fix was never applied. It bites harder here than it
           did on Changes and the test plan, because the panel whose content the
           user is trying to read is the one being streamed into.
           Keyed by entry, so two thinking blocks are independent. */
        const d = disclosure(el('details', 'thinking'), thinkKey(e), false)
        const sum = el('summary', null, 'Thought for a moment')
        d.append(sum, el('div', 'thinking-body', e.text))
        return d
      }
      case 'tool': {
        const row = el('div', 'tool status-' + e.status)
        row.append(el('span', 'tool-mark', e.name.startsWith('mcp__') ? '⚒' : '>_'))
        row.append(el('span', 'tool-text', e.summary))
        /* How long this call took, on the row it took it on.
           "It worked for four and a half minutes" is only actionable if the
           transcript says WHICH call spent them — an MCP round trip to a
           tracker looks exactly like a fast one until it is timed. A call
           still outstanding ticks up (`data-since`, ticked by tickAges);
           a finished one keeps its duration, but only past a couple of
           seconds, so a page of instant Reads does not carry a column of
           "0s". Both come from the live run: a row rehydrated from disk has
           no honest start time, so it shows none. */
        if (e.status === 'running' && e.runningSince) {
          const t = el('span', 'tool-time', since(e.runningSince))
          if (t.setAttribute) t.setAttribute('data-since', String(e.runningSince))
          t.title = 'How long this call has been running'
          row.append(t)
        } else if (typeof e.durationMs === 'number' && e.durationMs >= 2000) {
          const t = el('span', 'tool-time' + (e.durationMs >= 30000 ? ' slow' : ''), fmtDuration(e.durationMs))
          t.title = 'How long this call took'
          row.append(t)
        }
        row.append(el('span', 'tool-status', e.status === 'ok' ? '✓' : e.status === 'error' ? '✕' : '·'))
        // A Task carries its subagent's whole transcript. Nested and collapsed:
        // the main thread stays readable, and "what is it actually doing in
        // there" is one click away instead of unanswerable.
        if (e.children && e.children.length) {
          const d = disclosure(el('details', 'subagent'), 'subagent:' + (e.id || thinkKey(e)), false)
          const n = e.children.length
          const tools = e.children.filter((k) => k.kind === 'tool').length
          d.append(el('summary', null,
            'Subagent · ' + n + (n === 1 ? ' step' : ' steps') +
            (tools ? ' · ' + tools + (tools === 1 ? ' tool call' : ' tool calls') : '')))
          const body = el('div', 'subagent-body')
          for (const kid of e.children) body.append(renderEntry(kid, c))
          d.append(body)
          const wrap = el('div', 'tool-group')
          wrap.append(row, d)
          return wrap
        }
        return row
      }
      case 'phase': {
        const box = el('div', 'session-meta')
        box.append(el('div', 'session-meta-h', 'Session Meta'))
        const t = el('div', 'kv')
        if (c) t.append(el('span', 'k', 'Name'), el('span', 'v', c.title))
        const v = el('span', 'v')
        v.append(phaseChip(e.from), el('span', 'arrow', '→'), phaseChip(e.to))
        t.append(el('span', 'k', 'Phase'), v)
        // The agent's own line about why. `set_phase` has always asked for one
        // and the handler dropped it, so every move was explained into nothing.
        if (e.note) box.append(el('div', 'phase-note', e.note))
        box.append(t)
        return box
      }
      case 'result': {
        const d = el('div', 'result')
        const bits = ['Finished']
        if (e.durationMs) bits.push('in ' + fmtDuration(e.durationMs))
        if (e.costUsd) bits.push('· $' + e.costUsd.toFixed(2))
        d.append(el('span', null, bits.join(' ')))
        return d
      }
      case 'notice': {
        const d = el('div', 'notice' + (e.urgency === 'blocked' ? ' blocked' : ''))
        d.append(el('span', 'notice-icon', e.urgency === 'blocked' ? '🚫' : '🔔'))
        d.append(el('span', null, e.message))
        return d
      }
      case 'error': {
        const d = el('div', 'err')
        d.append(el('strong', null, 'Failed '), el('span', null, e.message))
        return d
      }
      default: return el('div')
    }
  }

  function block(who, at, body) {
    const b = el('div', 'block')
    const h = el('div', 'block-head')
    h.append(el('span', 'who', who))
    if (at) h.append(el('span', 'at', new Date(at).toLocaleTimeString()))
    b.append(h, body)
    return b
  }

  function fmtDuration(ms) {
    const sec = Math.round(ms / 1000)
    return sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + (sec % 60) + 's'
  }

  render()
  post('ready')
})()
