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
/** Which backends have their model catalogue open, and what has been typed into
 *  each one's filter. Module-level for the same reason: this page re-renders on
 *  every host reply, and a filter kept in the DOM is destroyed between
 *  keystrokes. A catalogue is 431 models on OpenRouter — the filter is not a
 *  nicety, it is the only way to find one. */
const catalogueOpen = new Set()
const catalogueFilter = {}

/* The new-schedule form. Module-level for the standing reason: this page
   re-renders on every host reply, and a half-typed schedule held in the DOM
   is gone with the next frame — the exact state a quick-pick used to lose,
   which is the reason this page exists. `enabled` rides along so editing a
   paused schedule does not silently resume it. */
const schedDraft = { title: '', prompt: '', time: '09:00', days: [1, 2, 3, 4, 5], enabled: true }
/** Set while the form is editing an existing schedule; its row id. */
let schedEditingId = undefined

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
      const idle = card.backend && card.backend.usesLogin === false
      /* A login that pays for nothing is not a green tick.
         This card said "Signed in as david@… (subscription)" while every
         session went to api.deepseek.com on a key from the keychain. Both true,
         together a lie — and the visible symptom was "why is Claude Code
         offering me DeepSeek models?". The backend row below says what is
         actually used; this one steps down to grey when it is not it. */
      row.appendChild(el('span', 'dot ' + (idle ? 'idle' : 'ok')))
      const via = login.via === 'subscription' ? 'subscription'
        : login.via === 'apiKey' ? 'API key'
        : 'cloud credentials'
      const who = login.account ? ` as ${login.account}` : ''
      const plan = login.plan ? ` · ${login.plan}` : ''
      row.appendChild(el('span', 'status-text' + (idle ? ' muted' : ''), `Signed in${who} (${via})${plan}`))
      if (idle) row.appendChild(el('span', 'muted small', '· not used by this backend'))
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
  /* WHEN this was read.
     `RuntimeStatus.at` crossed the postMessage boundary and was rendered by
     nothing, so a "Signed in" tick from an hour ago — before the token expired,
     before `codex login` was run, before the CLI was uninstalled — looked
     exactly like one taken a second ago. A settings page is precisely where a
     green tick gets painted because a config file exists, and this page's own
     contract says a state it did not read must not be asserted. The AGE is the
     number the readout is derived from, which is the same rule the board's
     frame-age indicator follows.
     Past a minute it is marked stale rather than merely old: at that point the
     honest claim is "this is what it said", not "this is how it is". */
  if (st.at) {
    const ageMs = Date.now() - st.at
    const age = el('span', 'muted small' + (ageMs > 60_000 ? ' stale' : ''), 'checked ' + since(st.at))
    age.title = 'When this was last read from the agent. Press Check to ask again.'
    row.appendChild(age)
  }
  return row
}

/** "just now", "3m ago" — the age of a reading, so it can be judged. */
function since(at) {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (secs < 10) return 'just now'
  if (secs < 60) return secs + 's ago'
  const mins = Math.round(secs / 60)
  if (mins < 60) return mins + 'm ago'
  const hours = Math.round(mins / 60)
  return hours < 24 ? hours + 'h ago' : Math.round(hours / 24) + 'd ago'
}

/* WHICH SERVICE a session on this agent would talk to.
 *
 * One line, above the executable path, because it is the thing that decides
 * which models exist and who gets billed — and because without it the page
 * could show a subscription login beside a model list from somebody else's
 * endpoint and never connect the two. */
function backendRow(card) {
  const b = card.backend
  if (!b) return null
  const row = el('div', 'status-row')
  row.appendChild(el('span', 'dot ok'))
  row.appendChild(el('span', 'status-text', 'Backend: ' + b.label))
  if (b.detail && b.detail !== b.label) row.appendChild(el('span', 'muted small', b.detail))
  if (b.credential) row.appendChild(el('span', 'muted small', '· ' + b.credential))
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
  } else if (!card.status || card.status.login.kind !== 'notInstalled') {
    // Never offered for an agent that is not on the machine: pressing it would
    // set a default whose every session fails at the first step.
    actions.appendChild(button('Use for new sessions', 'primary',
      () => post({ type: 'setDefaultRuntime', runtime: card.id })))
  }
  head.appendChild(actions)
  box.appendChild(head)

  box.appendChild(el('p', 'blurb', card.blurb))
  const backend = backendRow(card)
  if (backend) box.appendChild(backend)
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

/** An agent this machine does not have: one line, with the way to get it. */
function missingRow(card) {
  const row = el('div', 'agent-missing')
  row.appendChild(el('span', 'muted', 'Not installed:'))
  row.appendChild(el('span', '', card.label))
  row.appendChild(el('code', 'fix', card.installHint))
  row.appendChild(button('Copy', 'link', () => post({ type: 'install', runtime: card.id })))
  row.appendChild(button('Check again', 'link', () => post({ type: 'refresh', runtime: card.id })))
  return row
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
    const models = providerModels(p)
    if (models) list.appendChild(models)
  }
  box.appendChild(list)
  return box
}

/* WHAT THIS BACKEND SERVES, and which of it the composer should offer.
 *
 * The whole reason this exists: the composer's model list used to come from
 * `Query.supportedModels()`, which answers for CLAUDE CODE however
 * `ANTHROPIC_BASE_URL` is pointed — so a DeepSeek endpoint reported `sonnet`,
 * `haiku` and `opus[1m]`, those got saved onto the profile, and the picker
 * offered six models that endpoint has never served with no way to choose one
 * that it does. The list here comes from the endpoint's own `/v1/models`.
 *
 * Two lists, and keeping them distinct is the point: what the endpoint SERVES
 * (this catalogue, cached, hundreds of entries) and what the composer OFFERS
 * (the ticks, saved on the profile, as few as you like). Nothing ticked means
 * "offer them all" — for OpenRouter that is 431, which is why the composer has
 * a filter box too.
 */
function providerModels(p) {
  if (p.kind !== 'gateway') return null
  const box = el('div', 'row-models')
  const head = el('div', 'row-models-head')

  const count = (p.models || []).length
  const chosen = (p.models || []).filter((m) => m.offered).length
  const open = catalogueOpen.has(p.id)
  head.appendChild(button(
    (open ? '▾ ' : '▸ ') + (count
      ? `${count} models available${chosen ? ` · ${chosen} offered in the composer` : ' · all offered'}`
      : 'Models'),
    'link',
    () => { if (open) catalogueOpen.delete(p.id); else catalogueOpen.add(p.id); render() },
  ))
  head.appendChild(button(count ? 'Refresh from the endpoint' : 'Ask what it serves', 'link',
    () => post({ type: 'refreshEndpoint', id: p.id })))
  box.appendChild(head)

  /* A page that cannot say "I could not ask" is a page that shows an empty list
     and lets it read as "there are none". */
  if (p.modelNote) box.appendChild(el('div', 'muted small', p.modelNote))
  if (!count || !open) return box

  const typed = catalogueFilter[p.id] || ''
  const needle = typed.trim().toLowerCase()
  const matches = p.models.filter((m) => !needle
    || (m.id + ' ' + m.label + ' ' + (m.price || '')).toLowerCase().includes(needle))

  const filter = el('input', 'model-filter')
  filter.type = 'text'
  filter.placeholder = 'Filter ' + count + ' models…'
  filter.value = typed
  filter.setAttribute('data-focus', 'catalogue::' + p.id)
  filter.addEventListener('input', (e) => {
    catalogueFilter[p.id] = (e && e.target ? e.target.value : filter.value) || ''
    render()
  })
  box.appendChild(filter)

  const SHOW = 60
  const table = el('div', 'model-rows')
  for (const m of matches.slice(0, SHOW)) {
    const r = el('label', 'model-row' + (m.offered ? ' on' : ''))
    const tick = el('input', 'model-tick')
    tick.type = 'checkbox'
    tick.checked = !!m.offered
    tick.addEventListener('change', () => {
      const next = p.models.filter((x) => (x.id === m.id ? !m.offered : x.offered)).map((x) => x.id)
      post({ type: 'setProfileModels', id: p.id, models: next })
    })
    r.appendChild(tick)
    const main = el('div', 'model-main')
    main.appendChild(el('div', 'model-name', m.label))
    /* The id, the window and the price on one line — the three facts that make
       a list of names into a choice. The price is a STRING from the host and is
       simply ABSENT when nobody published one: blank means "not stated", where
       `$0.00` would mean "free". */
    const meta = [m.id !== m.label ? m.id : '', m.context && m.context !== '?' ? m.context + ' context' : '', m.price || '']
      .filter(Boolean).join(' · ')
    if (meta) main.appendChild(el('div', 'muted small', meta))
    r.appendChild(main)
    table.appendChild(r)
  }
  box.appendChild(table)
  if (!matches.length) box.appendChild(el('div', 'muted small', 'Nothing matches “' + typed + '”.'))
  else if (matches.length > SHOW) {
    box.appendChild(el('div', 'muted small',
      `Showing ${SHOW} of ${matches.length} — type to narrow it.`))
  }
  if (chosen) {
    box.appendChild(button('Offer all ' + count + ' in the composer', 'link',
      () => post({ type: 'setProfileModels', id: p.id, models: [] })))
  }
  return box
}

/* --- scheduled runs: the board's time triggers -------------------------
 *
 * "Every morning, check the bug board and start fixing." A schedule is a
 * prompt plus a wall-clock time on chosen weekdays; at the moment, the host
 * starts a NEW session with that prompt — a new card, an ordinary run, the
 * same lifecycle as one started by hand.
 *
 * Two honesties the page must keep, and both are the board's own rules:
 *
 *  - Runs happen only while the extension is running, so this is NOT cron.
 *    A moment that passed while VS Code was closed starts at the next check
 *    — once, not once per missed day — and the blurb below says so.
 *  - A schedule that cannot fire is shown as DUE, never marked failed and
 *    never shown as silent. When no git repo is open the page says why.
 */
const DAY_TAGS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad2 = (n) => String(n).padStart(2, '0')

/** "09:00" (an `<input type="time">` value) -> {hour, minute}, or undefined
 *  when it is not a time the host could fire on. */
function schedTimeParts(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim())
  if (!m) return undefined
  const h = Number(m[1]); const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return undefined
  return { hour: h, minute: min }
}

function schedResetDraft() {
  schedEditingId = undefined
  schedDraft.title = ''
  schedDraft.prompt = ''
  schedDraft.time = '09:00'
  schedDraft.days = [1, 2, 3, 4, 5]
  schedDraft.enabled = true
}

function schedDayChips() {
  const chips = el('div', 'sched-days')
  for (let d = 0; d < 7; d++) {
    const on = schedDraft.days.includes(d)
    const c = el('button', 'sched-day' + (on ? ' on' : ''), DAY_TAGS[d])
    c.type = 'button'
    c.title = (on ? 'Remove ' : 'Fire on ') + DAY_FULL[d]
    c.addEventListener('click', () => {
      schedDraft.days = on
        ? schedDraft.days.filter((x) => x !== d)
        : [...schedDraft.days, d].sort((a, b) => a - b)
      render()
    })
    chips.appendChild(c)
  }
  return chips
}

function schedForm() {
  const form = el('div', 'sched-form')

  const line1 = el('div', 'sched-line')
  const title = el('input', 'sched-title')
  title.type = 'text'
  title.placeholder = 'Name — becomes the card title, e.g. Morning bug patrol'
  title.value = schedDraft.title
  title.setAttribute('data-focus', 'sched::title')
  const onInput = (field) => (e) => {
    schedDraft[field] = (e && e.target && e.target.value != null ? e.target.value : title.value) || ''
    render()
  }
  title.addEventListener('input', onInput('title'))
  line1.appendChild(title)

  const time = el('input', 'sched-time')
  time.type = 'time'
  time.value = schedDraft.time
  time.title = 'When the run starts — your local time'
  time.setAttribute('data-focus', 'sched::time')
  time.addEventListener('input', (e) => {
    const v = (e && e.target && e.target.value != null ? e.target.value : time.value) || ''
    schedDraft.time = v
    render()
  })
  line1.appendChild(time)
  form.appendChild(line1)

  const prompt = el('textarea', 'sched-prompt')
  prompt.rows = 2
  prompt.placeholder = 'What the session should do — e.g. check the bug board and start fixing what is broken'
  prompt.value = schedDraft.prompt
  prompt.setAttribute('data-focus', 'sched::prompt')
  prompt.addEventListener('input', onInput('prompt'))
  form.appendChild(prompt)

  form.appendChild(schedDayChips())

  const acts = el('div', 'sched-form-acts')
  const canSave = !!(schedDraft.title.trim() && schedDraft.prompt.trim()
    && schedTimeParts(schedDraft.time) && schedDraft.days.length)
  const save = button(schedEditingId ? 'Save changes' : 'Add schedule', 'primary', () => {
    const t = schedTimeParts(schedDraft.time)
    if (!t) return
    const draft = {
      title: schedDraft.title.trim(),
      prompt: schedDraft.prompt,
      hour: t.hour,
      minute: t.minute,
      days: schedDraft.days.slice(),
      enabled: schedDraft.enabled,
    }
    if (schedEditingId) draft.id = schedEditingId
    post({ type: 'saveSchedule', draft })
    schedResetDraft()
    render()
  }, {
    disabled: !canSave,
    title: 'A schedule needs a name, an instruction, a time and at least one day',
  })
  acts.appendChild(save)
  if (schedEditingId) {
    acts.appendChild(button('Cancel', 'link', () => { schedResetDraft(); render() }))
  }
  if (!canSave) {
    acts.appendChild(el('span', 'muted small', 'Needs a name, an instruction, a time and at least one day.'))
  }
  form.appendChild(acts)
  return form
}

/** The lines under a schedule row that tell the run's story: when it fires
 *  next (or that it is due), and what the last attempt did. A failed attempt
 *  is ALWAYS shown — it is the one signal that must not get lost under a
 *  row that still looks fine. */
function schedFacts(s) {
  const out = []
  if (s.enabled && s.nextAt !== undefined) {
    if (s.nextAt <= Date.now()) {
      out.push(el('div', 'small sched-due', 'Due now — starts at the next check'))
    } else {
      out.push(el('div', 'muted small', nextRunLabel(s.nextAt)))
    }
  }
  if (s.lastRun) {
    if (!s.lastRun.ok) {
      out.push(el('div', 'small row-fail',
        'Last run did not start' + (s.lastRun.note ? ' — ' + s.lastRun.note : '') + '.'))
    } else if (!s.enabled || s.nextAt === undefined || s.nextAt <= Date.now()) {
      // A healthy schedule with a next run ahead does not need this line; the
      // "Next: …" one above IS the story. When there is no next run (paused,
      // no days, due), the last one is what happened.
      out.push(el('div', 'muted small', 'Last run started ' + since(s.lastRun.at) + '.'))
    }
  }
  return out
}

function nextRunLabel(at) {
  const d = new Date(at)
  const now = new Date()
  const hh = pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  if (d.toDateString() === now.toDateString()) return 'Next: today at ' + hh
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  if (d.toDateString() === tomorrow.toDateString()) return 'Next: tomorrow at ' + hh
  return 'Next: ' + DAY_FULL[d.getDay()] + ' at ' + hh
}

function schedRow(s, canRun) {
  const row = el('div', 'row' + (schedEditingId === s.id ? ' active' : ''))
  const left = el('div', 'row-main sched-main')
  const title = el('div', 'row-title')
  title.appendChild(el('span', '', s.title))
  if (!s.enabled) title.appendChild(el('span', 'badge quiet', 'Paused'))
  left.appendChild(title)

  /* When + instruction on one ellipsising line: several schedules can share
     a title, and the instruction is what tells them apart. The full prompt
     is in the tooltip and in the Edit form. */
  const meta = el('div', 'sched-meta')
  meta.appendChild(el('span', 'muted', s.when))
  meta.appendChild(el('span', 'sched-sep', '·'))
  meta.appendChild(el('span', 'row-prompt', s.prompt))
  meta.title = s.prompt
  left.appendChild(meta)

  for (const line of schedFacts(s)) left.appendChild(line)
  row.appendChild(left)

  const acts = el('div', 'row-actions')
  const runNow = button('Run now', 'link', () => post({ type: 'runSchedule', id: s.id }))
  if (!canRun) {
    // A control that cannot succeed is disabled and says why — never a click
    // that fails with a toast the banner above already explained.
    runNow.disabled = true
    runNow.title = 'A git repository must be open for a session to start'
  }
  acts.appendChild(runNow)
  acts.appendChild(button('Edit', 'link', () => {
    schedEditingId = s.id
    schedDraft.title = s.title
    schedDraft.prompt = s.prompt
    schedDraft.time = pad2(s.hour) + ':' + pad2(s.minute)
    schedDraft.days = s.days.slice()
    schedDraft.enabled = s.enabled
    render()
  }))
  acts.appendChild(button(s.enabled ? 'Pause' : 'Resume', 'link',
    () => post({ type: 'toggleSchedule', id: s.id })))
  acts.appendChild(button('Remove', 'link danger',
    () => post({ type: 'removeSchedule', id: s.id })))
  row.appendChild(acts)
  return row
}

function scheduledSection() {
  const sch = state.schedules
  if (!sch) return null
  const sec = el('section', 'panel')
  const head = el('div', 'panel-head')
  head.appendChild(el('h2', '', 'Scheduled runs'))
  head.appendChild(el('span', 'muted small', 'start a session at set times'))
  sec.appendChild(head)
  sec.appendChild(el('p', 'blurb',
    'At a set time on set days, a NEW session starts with a fixed instruction — your morning ' +
    'bug-board patrol, an afternoon build check. Fires only while this window is open; a run ' +
    'due while it was closed starts once at the next check, never once per missed day.'))

  /* The one signal that would otherwise be silent: a schedule that cannot
     fire because no session could start. Shown as a banner, not hidden, and
     never painted as a failure of the schedule itself. */
  if (sch.problem) sec.appendChild(el('div', 'sched-problem', sch.problem))

  const list = el('div', 'rows')
  if (!sch.rows.length) {
    list.appendChild(el('div', 'muted small',
      'Nothing scheduled yet — the form below starts a session at a set time.'))
  } else {
    for (const s of sch.rows) list.appendChild(schedRow(s, sch.canRun))
  }
  sec.appendChild(list)

  sec.appendChild(el('div', 'sched-subhead', schedEditingId ? 'Edit schedule' : 'New schedule'))
  sec.appendChild(schedForm())
  return sec
}

/* --- the composer's mic ------------------------------------------------
 *
 * Dictation is two LOCAL tools — ffmpeg records, whisper-cli transcribes —
 * and the audio never leaves the machine, which is the entire point of it.
 * Each piece is checked by actually asking the binary, and each missing one
 * is its own row with its own fix, because "install the thing" is wallpaper
 * the moment a user has one of the two installed.
 */
const VOICE_SETTING_KEYS = { whisper: 'agentsKanban.whisperPath', model: 'agentsKanban.whisperModel', ffmpeg: 'agentsKanban.ffmpegPath' }

function dictationSection() {
  const sec = el('section', 'panel')
  const head = el('div', 'panel-head')
  head.appendChild(el('h2', '', 'Dictation'))
  head.appendChild(el('span', 'muted small', 'the composer mic — recorded and transcribed on this machine'))
  sec.appendChild(head)

  const intro = el('div', 'muted small')
  intro.appendChild(el('span', '', 'The composer’s 🎤 needs whisper-cli and ffmpeg, found on your PATH or pointed to by four settings. Nothing is uploaded: the recording and the transcription both happen here.'))
  sec.appendChild(intro)

  const v = state.voice
  if (!v) {
    const row = el('div', 'status-row')
    // NEVER "not installed" when we simply have not looked.
    row.appendChild(el('span', 'dot unknown'))
    row.appendChild(el('span', 'status-text', 'Not checked yet.'))
    row.appendChild(button('Check', 'link', () => post({ type: 'checkVoice' })))
    sec.appendChild(row)
  } else {
    for (const r of v.rows) {
      const row = el('div', 'status-row')
      row.appendChild(el('span', 'dot ' + (r.ok ? 'ok' : 'bad')))
      const label = el('span', 'status-text', r.label)
      row.appendChild(label)
      if (r.ok) {
        row.appendChild(el('span', 'muted small', r.detail))
      } else {
        // A missing piece opens the very setting that fixes it — a fix is a
        // place, not just a sentence.
        const fix = el('code', 'fix')
        fix.textContent = r.detail
        fix.style.cursor = 'pointer'
        fix.title = 'Open the setting for this'
        fix.addEventListener('click', () => {
          post({ type: 'openSetting', key: VOICE_SETTING_KEYS[r.key] || 'agentsKanban' })
        })
        row.appendChild(fix)
      }
      const age = el('span', 'muted small', 'checked ' + since(v.at))
      age.title = 'When the binaries were last asked. Press Check to ask again.'
      row.appendChild(age)
      sec.appendChild(row)
    }
    sec.appendChild(button('Check again', 'link', () => post({ type: 'checkVoice' })))
  }
  return sec
}

function render() {
  const root = document.getElementById('root')
  /* THE SAME RULE THE BOARD HAS: anything the user is typing into is destroyed
     by the rebuild below, so it has to be handed back afterwards.
     This page had nothing to type into until the model filter arrived, and
     without this the first character typed moves focus to the body and the rest
     of the word goes nowhere — the bug `board.js` has a postmortem about,
     arriving here the moment this page grew an input. Anything that must
     survive announces itself with `data-focus`. */
  const active = document.activeElement
  const focusKey = active && active.getAttribute ? active.getAttribute('data-focus') : null
  const caret = active && typeof active.selectionStart === 'number'
    ? { start: active.selectionStart, end: active.selectionEnd }
    : null
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
    /* An agent you do not have is not a peer of one you do.
       Codex used to get a full card — blurb, login row, model list, "Use for
       new sessions" — on a machine where it was never installed, above the
       backend that was actually running everything. It is still listed, because
       silently dropping it would make the board's second agent undiscoverable,
       but as one line at the end. */
    const here = state.runtimes.filter((r) => !r.status || r.status.login.kind !== 'notInstalled')
    const missing = state.runtimes.filter((r) => r.status && r.status.login.kind === 'notInstalled')
    for (const card of here) agents.appendChild(runtimeCard(card))
    for (const card of missing) agents.appendChild(missingRow(card))
  }
  page.appendChild(agents)

  // Only shown when at least one runtime actually takes provider profiles.
  // Offering a backend picker for a board whose agents all sign in as
  // themselves would be a setting that cannot take effect.
  if (state.runtimes.some((r) => r.providerProfiles)) page.appendChild(providerSection())

  // Always rendered when the host provides the section — an empty rows list
  // is a real state ("nothing scheduled yet"), not an absent feature. Old
  // hosts that never send `schedules` simply show no section.
  if (state.schedules) page.appendChild(scheduledSection())

  page.appendChild(dictationSection())

  const foot = el('footer', 'settings-footer')
  foot.appendChild(el('span', 'muted small',
    'Paths and advanced options live in VS Code settings under "Agents Kanban".'))
  foot.appendChild(button('Open VS Code settings', 'link',
    () => post({ type: 'openSetting', key: 'agentsKanban' })))
  page.appendChild(foot)

  root.appendChild(page)

  if (focusKey) {
    const back = root.querySelector('[data-focus="' + focusKey + '"]')
    if (back && back.focus) {
      back.focus()
      // The caret too, not just the focus. Clamped to the current value, which
      // can legitimately be shorter than it was.
      if (back.setSelectionRange && caret) {
        const n = (back.value || '').length
        const start = Math.min(caret.start, n)
        const end = Math.min(caret.end === undefined ? start : caret.end, n)
        try { back.setSelectionRange(start, end) } catch (e) { /* not a real input */ }
      }
    }
  }
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
