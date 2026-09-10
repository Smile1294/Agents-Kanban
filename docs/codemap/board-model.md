---
name: board-model
description: The board's own rules — columns and phases, the human-only approval gate, the AgentState union, stalled cards, the age bound on foreign sessions, the AskUserQuestion picker, and the knowledge-file gate on the review move
paths:
  - src/board/config.ts
  - src/board/questions.ts
  - src/board/codemap.ts
tests:
  - src/board/__tests__/config.test.ts
  - src/board/__tests__/questions.test.ts
  - src/board/__tests__/ask.test.mjs
  - src/board/__tests__/codemap.test.ts
  - src/board/__tests__/permission-detail.test.ts
last_verified: 2026-09-07
---
# The board model

## Owns

What a board IS, independent of any editor: the columns and which one is the
approval step, the states a running agent can be in, the derivations that let a
card say "nothing is running here", the bound on sessions adopted from another
agent's store, the parsing of a model-written question into something a person
can answer, and the rule that knowledge files move with the code.

## Files

**`src/board/config.ts`**. `DEFAULT_BOARD` — `backlog · planning · implementing
· validating · complete`, each `ColumnDef` with an `id`, `name`, `category`
(`todo` / `started` / `review` / `done`), an `agentHint` (prose baked into the
`set_phase` description — the hints are documentation for the agent, keep them
true) and `humanOnly` on `complete`. `AgentState` — `idle | queued | starting |
working | waiting | needsInput | done | error`, volatile, never persisted.
Helpers: `columnById`, `isHumanOnly`, `isReviewColumn`, `isStartedColumn`,
`isSettledColumn`, `stalledSince(card, agents, board, now)` (a started column
with no live agent → the time it stalled, never alongside `interrupted`),
`splitByAge(sessions, days, now)` (returns `shown` and a `hidden` COUNT). Test:
`config.test.ts`, which opens by asserting the approval boundary for every
column.

**`src/board/questions.ts`**. `ASK_TOOL = 'AskUserQuestion'`,
`parseAskQuestions(toolName, input)` → `AskQuestion[]` (each with `key` — the
question text EXACTLY as written, untrimmed — `question`, `header`, `options`,
`multiSelect`), `buildAskAnswers(questions, selections)` → the `answers` object
the tool reads out of `updatedInput`. Defensive throughout: the input is
model-written; anything unrenderable falls back to the plain Allow/Deny prompt.
Tests: `questions.test.ts` (malformed input at least as hard as good input),
`ask.test.mjs` (the picker through the real `board.js`).

**`src/board/codemap.ts`**. The knowledge-file gate, pure and plain Node.
`loadCodemap(root)` reads `docs/codemap/*.md` and keeps the files whose
frontmatter carries `paths:`; `parseAreaFile`, `parseFrontmatter`;
`matchesGlob` / `globToRegExp` (`**`, `*`, `?`, anchored); `isExempt` (tests
and markdown); `ownersOf(path, areas)`; `knowledgeCheck(changed, areas)` → `{ok,
areas}` or `{ok: false, missing, message}` — for every non-exempt changed path,
each owning area's file must also be in the change set. Test: `codemap.test.ts`
— the pure cases, and the integrity check over the real folder (every source
file owned by exactly one area, every `paths:` entry matching a real file, every
path named in the map existing).

## How it works

**Phase is the column.** There is no move operation; `SessionStore.setPhase`
writes the field and the card is drawn in that column. `isHumanOnly` is checked
in `set_phase` BEFORE any write; the guard constrains the agent, and the user
may still drag a card to Complete.

**Stalled vs interrupted.** `SessionMeta.running` still set at startup means the
host died mid-turn: "Interrupted 9m ago". A card in a started column with no
live agent and no `running` mark is stalled: the agent ended its turn without
handing the work back. `stalledSince` returns the time; the board OFFERS the
move (the stalled card's primary action resumes the session and asks for a test
plan) and never makes it, because moving by hand produces no `howToTest`.

**The age bound.** Codex keys its store by date, so `list(dir)` adopts every
rollout on the machine that matches the cwd. `splitByAge` hides foreign sessions
older than `hideSessionsOlderThanDays`; anything the board ever touched is
shown however old; the hidden count is drawn and clickable; the bound is applied
by the host and never inside `SessionStore.list()`, because search reads the
same list.

**Questions are not permissions.** `AskUserQuestion` arrives through
`canUseTool` like `Bash` does, but allowing it does not answer it — the tool
reads `updatedInput.answers`, keyed by question text. The picker's choices are
module-level in `board.js` (a half-finished answer in the DOM dies on the next
repaint) and travel back as `selections` on the `permission` message.

**The knowledge gate.** On the move into a review column, `AgentManager`'s
`knowledgeCheck` callback runs `changedFiles()` against the base, loads the
codemap from the agent's own worktree, and `knowledgeCheck()` maps each changed
source path to its owning area through the `paths:` globs. An area whose file is
not in the change set is a refusal naming that file. No codemap in the
repository → nothing is required, so the extension stays generic.

## Change recipes

- **A new column or a renamed phase.** `DEFAULT_BOARD`; `config.test.ts` (the
  boundary test iterates every column); the smoke gate "board policy holds,
  including on a renamed board" exercises a renamed one.
- **A new agent state.** `AgentState` here; the manager sets it; `board.js`
  draws it; the busy set (slot, status bar, Interrupt/Stop) in the manager and
  the host must include it if it means "running".
- **A new derived readout on a card** (like stalled). Derive it from what the
  board already has, return a TIME not a boolean, and normalise it to the minute
  in `chromeSig()`.
- **A new exemption or a new owner rule for the knowledge gate.** `isExempt` /
  `knowledgeCheck` here, and the README's rule paragraph.

## Invariants

- Safety boundaries go in code, not prompts. `isHumanOnly` is the fence; the
  tool description is the policy. Both, always.
- Never show a signal that cannot say "bad": the hidden count, the stalled time.
- One card, one story: `stalled` never fires alongside `interrupted`.
- The answer to a question is filed under the question text untrimmed.

## Open work

- Board configuration from a file, so columns are customisable — `DEFAULT_BOARD`
  is a constant.
- A `Fixes <id>` commit-message watcher to close a card (PLAN.md §9). The
  `set_phase` description no longer claims one exists.

## Recent changes

- 2026-09-10 · claude/frontend-sync-chat-freeze-wb6a2s · `summarise()`,
  `permissionDetail()` and `PERMISSION_DETAIL_MAX` moved here from `panel.ts`
  and stopped truncating silently. The Allow/Deny prompt is the security control
  in this extension and it could not say what it was authorising: the detail was
  cut at 200 characters with NO marker, so a `Bash` command whose payload sat
  past that point rendered as its innocuous beginning while Allow resolved
  `canUseTool` with the FULL input — and no other surface shows a tool input in
  full (the transcript row cuts at 180, the log line at 160). It now shows up to
  4000 characters and says how much is hidden when it has to cut. Every
  `ASKS_FIRST` tool also has a summary now: all four had none of the keys the
  generic branch reads, so `split_task` was approved with its subtask prompts,
  agents and models nowhere on screen. It lives in `questions.ts` because that
  is vscode-free — the silent cut survived precisely because it sat in a file no
  unit test could import. Gates: `permission-detail.test.ts` and
  `webview.test.mjs`, both shown to fail.

- 2026-09-10 · claude/frontend-sync-chat-freeze-wb6a2s · the `complete` column's
  `agentHint` stopped promising a commit-message watcher that does not exist.
  What the agent is told must be TRUE: an agent reads "a commit message closes
  it" as a fact it can act on — write "Fixes <id>" and the card will close — and
  it never does.

- 2026-09-07 · task/S5kc3 · area file created from the codebase audit; `codemap.ts` added with the knowledge-file gate.
- 2026-09-07 · task/S116g8 · dead-code sweep: `normalisePath` and `knowledgeMessage` de-exported — module-private helpers used only by exported functions' bodies.
