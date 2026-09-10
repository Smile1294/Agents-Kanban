---
name: webview
description: Everything drawn — media/board.js (kanban, chat, search, side-bar control), the streaming fast path, scroll/caret survival, markdown, the composer; media/settings.js; the stylesheets and the browser theme
paths:
  - media/*.js
  - media/*.css
tests:
  - src/board/__tests__/webview.test.mjs
  - src/board/__tests__/layout.test.mjs
  - src/board/__tests__/scroll.test.mjs
  - src/board/__tests__/markdown.test.mjs
  - src/board/__tests__/ask.test.mjs
  - src/board/__tests__/attach.test.mjs
  - src/board/__tests__/settings-view.test.mjs
  - src/board/__tests__/settings-spawn.test.mjs
  - src/board/__tests__/settings-schedule.test.mjs
  - src/board/__tests__/theme.test.mjs
  - smoke.mjs
---
# The webview

## Owns

The two pages the extension draws: the board (`board.js` + `board.css`) and the
settings page (`settings.js` + `settings.css`), plus `theme.css`, which supplies
the editor's palette when the board runs in a plain browser. Vanilla JS, no
framework, no drag-and-drop library, **no `innerHTML` anywhere** — the
transcript is another program's output.

## Files

**`media/board.js`** (~3850 lines), one IIFE. `acquireVsCodeApi()` is the only
way out; `control = document.documentElement.dataset.layout === 'control'`
makes the same file behave as the side bar. Module-level state — `draft`,
`disclosed`, `searchQ` / `searchRows` / `searchAsked`, `askChoices`,
`mentionFiles`, `menuFilter`, `jump` (with `JUMP_TTL`) — because `render()`
replaces the whole tree several times a second while an agent streams and
anything held in the DOM dies with it. Main functions:

- `render()` — rebuilds the tree. Harvests first: scroll offsets per
  `data-scroll` key, `<details>` open state, textarea focus AND caret
  (`selectionStart`/`selectionEnd`), the `data-focus` key of the question box;
  prunes `askChoices` for questions no longer pending; restores all of it after.
  Records `lastChrome = chromeSig()` on EVERY path out, early returns included.
- `chromeSig()` — `JSON.stringify` of the state minus the volatile fields the
  fast path patches: `transcript`, `streaming`, `agent.tool` / `subagent` /
  `lastEventAt` / `contextTokens`, `composer.contextTokens` / `contextWindow` /
  `meter`. `updated` and `stalled` enter at MINUTE resolution because `ago()`'s
  finest step is a minute. A field is deleted explicitly; an unlisted new field
  forces a full rebuild, which is slow but never wrong.
- `syncFrame()` — the streaming fast path, one branch per screen: chat →
  `syncApply()` (rows patched by `rowSig()`, text compared by LENGTH because live
  rows only grow, readouts by `syncReadouts()`); kanban / search / control →
  `syncCards()`. Returns true = frame dealt with.
- Screens, dispatched by `render()`: `renderNoWorkspace()`, `renderSetup()`,
  `renderControl()` (the side bar: counts, titles, a toggle — five columns
  cannot be read in 300 px), then `renderRail()` beside ONE of `renderSearch()`,
  `renderChat()`, `renderKanban()` (`renderToolbar`, `renderColumn`,
  `renderCard`).
- `disclosure(box, key, defaultOpen)` — every `<details>` goes through it: seeds
  from `disclosed[key]`, sets `data-open`, posts `disclosure` to the host one-way
  and re-renders, because a closed panel's body is not built at all.
  `thinkKey(e)` keys a thinking block by length + first 24 chars, not by `e.at`.
- `renderMarkdown(text)` + `mdBlocks`, `codeBlock`, `list`, `table`, `inline` —
  a from-scratch renderer that BUILDS NODES. Headings, paragraphs, fenced code
  with language label and Copy, inline code, bold/italic/strike, links
  restricted by `SAFE_HREF = /^(https?:|mailto:)/i`, bare URLs, nested lists,
  pipe tables, quotes, rules. Raw HTML renders as characters. An unclosed fence
  is a code block, because that is what streaming produces.
- `renderComposer(c)` — pickers via `picker()` (model, effort, thinking, agent,
  orchestration), `@`-mentions (`mentionAt`, `mentionMatches`,
  `renderMentionMenu`, `chooseMention`), slash commands (`slashMatches`,
  `renderSlashMenu`), dictation (`insertDictation`), attachments
  (`renderAttachments`, `addImageFiles` — downscaled to 1568 px on the long edge
  before sending), the meter (`renderMeter`).
- Panels: `renderAskQuestions` / `renderAskPermission`, `renderReview`,
  `renderTestPlan`, `renderPendingMerge`, `renderStalled`, `renderInterrupted`,
  `renderSubtasks`, `renderBackgroundAgents`, `renderQueued`, `renderStreaming`,
  `renderSelectionBar`, `kebab(c)` (the card menu: rename, pin, archive, remove,
  run, open worktree).
- Host → view messages it listens for: `state` (runs `chromeSig() ===
  lastChrome && syncFrame()` before falling back to `render()`), `mentions`,
  `searchResults` (dropped unless `q` matches both `searchQ` and `searchAsked`),
  `voice`.
- View → host: `post(type, payload)`. The full list and what each means is in
  [extension-host.md](extension-host.md); the smoke gate sweeps them.

**`media/board.css`** (~1430 lines). Tokens first: `--ctl-h` 24 px, `--ctl-h-lg`
32 px (the input row), `--ctl-h-xs` 20 px (actions inside a card) are the ONLY
control heights; the base `button` rule IS the standard control, `.ctl` is the
same geometry for chips that are spans, a glyph goes in `.ctl-ico`, never in
the label. Every colour is `var(--vscode-*)`. Sections in order: rail, toolbar,
kanban, chat, subtasks, composer bar and controls, menus, background agents,
multi-select, stalled runs, uncommitted merge, review, how-to-test,
notices/queue/slash, dictation mic, @-mention picker, taking the window, side
bar control, transcript search.

**`media/settings.js`** (~1070 lines), a top-level script. State: `expanded`,
`catalogueOpen` / `catalogueFilter` (431 models on OpenRouter — the filter is
the only way to find one), `schedDraft` / `schedEditingId`, `state`, `error`.
`runtimeCard` with `loginRow` (FOUR login states, four different rows),
`backendRow`, `modelsRow`, `missingRow`; `providerSection` + `providerModels`
(the "offered" tick and the separate "allowed for spawned agents" tick);
`schedForm` / `schedRow` / `scheduledSection`; `dictationSection`;
`remoteSection`. Posts exactly the names the host's settings switch handles.

**`media/settings.css`**. Layered over `board.css`. Every flex item that holds
text carries `min-width: 0` — the default `min-width: auto` defeats
`text-overflow: ellipsis`, found twice by the Chromium gate.

**`media/theme.css`**. VS Code's Dark Modern palette on `:root` for every
`--vscode-*` variable the sheets use. Loaded FIRST by `server/page.mjs` and by
`test/screenshots.mjs`; not loaded in the editor (an inline value outranks it).
Dark only, by design.

## How it works

The host posts a whole `UiState` per frame. If nothing in `chromeSig()` changed,
`syncFrame()` patches in place; otherwise the tree is rebuilt and the harvested
UI state restored. This is why every scroll container carries `data-scroll`,
every `<details>` goes through `disclosure()`, and every draft lives at module
level: a node destroyed mid-gesture takes the gesture with it (a card replaced
between mousedown and mouseup never clicks). The view keeps the last
`composer.models` it saw because the host omits the list when unchanged.

## Change recipes

- **A new element on a card or in the transcript.** Add to the renderer; if its
  data changes per frame, either patch it in `syncFrame()`/`syncRow()` or delete
  it from `chromeSig()`. Then `webview.test.mjs` for the render, `scroll.test.mjs`
  if it scrolls, `layout.test.mjs` if it has a size.
- **A new control on the bar.** Use the base `button` or `.ctl`; glyph in
  `.ctl-ico`. `layout.test.mjs` measures every `.ctl` and fails if two differ.
- **A new colour.** `var(--vscode-…)` in the sheet AND a value in `theme.css`;
  `theme.test.mjs` fails otherwise and the headless board paints white.
- **A new collapsible.** Through `disclosure()` with a stable key, never a raw
  `<details>` with `open = true`.
- **A new host message.** `post('name', {...})` here; the `case` in
  `panel.ts wire()`; the smoke sweep asserts the pair.
- **Anything that looks like HTML in an answer.** Must land as characters;
  `markdown.test.mjs` asserts a `<script>` or `<img onerror>` creates no element.

## Invariants

- No `innerHTML`, ever. Links are `http(s)` and `mailto` only.
- Nothing volatile enters `chromeSig()` at a finer resolution than it is drawn.
  One `Date.now()` in the signature killed the fast path outright and produced
  "I can't scroll / can't switch chats / can't reach the board".
- Anything the user typed or opened carries a key or lives at module level.
- One control height, from tokens. An emoji in a label raised a chip by 5 px.
- The side bar is a control, not a board.
- `render()` records its own signature on every path out.

## Open work

- No syntax highlighting in code blocks (language label and monospace only).
- Annotating an attached image is not implemented; an attachment is not kept
  after it is sent (the transcript records only the count).

## Recent changes

- 2026-09-10 · claude/frontend-sync-chat-freeze-wb6a2s · `.ask code` is
  `pre-wrap` and scrollable (`max-height: 40vh`). It was one `word-break: break-all`
  line, which is what a permission detail had to fit into — and the detail was
  being cut to 200 characters to make it fit. The text an Allow/Deny decision is
  made on has to be reachable in full.

- 2026-09-09 · claude/frontend-sync-chat-freeze-wb6a2s · a card that goes away
  under this surface is drawn as such: `adoptView()` holds the view on a key the
  host announced as `vanished` instead of sliding to the new-session screen, the
  transcript area says "no longer on the board" naming the three things it could
  be, and the title falls back to the last one this view drew for that session
  (cached beside its rows) rather than to "New session", which would be a lie
  about a conversation that exists. Without the announcement the same frame is
  read as cards that have not arrived and claims nothing. Gates in
  `webview.test.mjs`, shown to fail.

- 2026-09-09 · claude/frontend-sync-chat-freeze-wb6a2s · the view keeps the last
  THREE conversations it drew (`cachedTranscripts`, `TRANSCRIPT_CACHE`,
  `rememberTranscript()`), so switching back to a chat you were just in draws
  immediately instead of showing "Loading this conversation…" about a
  conversation that was on screen ten seconds ago. `ourTranscript()` answers
  from it while the host's own slice is in flight, and the slice replaces it the
  moment it lands. Only the ROWS are cached: they are append-only and carry
  their own timestamps, so an old copy is an old copy of something true.
  `streaming`, `review` and `backgroundAgents` are readings — a half-written
  line, a file list, an age — and are now gated on `sliceIsOurs()` rather than
  drawn under whichever session the view has moved to. A search jump is
  translated by `transcriptHead` only against the HOST's rows, never a cached
  copy: another session's head lands the flash on the wrong row and spends it.
  Gates in `webview.test.mjs`, all shown to fail.

- 2026-09-09 · claude/frontend-sync-chat-freeze-wb6a2s · step 1 of
  docs/REMOTE-REWORK.md §9: **the view owns `mode` and `selectedKey`**. They
  were two variables in the HOST shared by the side bar, the panel and every
  remote page at once, so no two surfaces could show different sessions and a
  click could not draw anything until a whole state came back. Now `view` is
  module-level beside `draft` and `disclosed`, `setView()` renders FIRST and
  tells the host after, and `adoptView()` folds a fresh state in: seed once,
  then adopt only what the host changed on its OWN — `viewPending` drops the
  stale frame naming the session we just left, which is precisely the frame the
  old code waited for. Step 4 replaces the host's redirects (a run getting its
  id, a fork, an archive) with something it announces; until then that bridge
  keeps every one working.
  The trap found while building it: moving first means the state's
  SESSION-SCOPED half — transcript, streaming, review, backgroundAgents, the
  composer meters — still describes the session we LEFT. Drawing it under the
  new title is not a slower board, it is a wrong one, and a search jump proved
  it (the flash landed on the old transcript's row and was spent before the
  right rows arrived). `sliceIsOurs()` gates every use of it, `syncApply`
  refuses to patch from a foreign slice, and it is IN `chromeSig()` or the fast
  path would hold "Loading this conversation…" over rows that had arrived.

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit.
