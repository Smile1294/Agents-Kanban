/** The tools an agent uses to drive its own card on the board.
 *
 * These run IN-PROCESS in the extension host via `createSdkMcpServer`. Nimbalyst
 * needs a localhost HTTP+SSE server with a bearer token because Electron is
 * multi-process; a VS Code extension does not — which removes the port, the
 * token, and the whole transport layer.
 *
 * Two principles taken from Nimbalyst because they are load-bearing:
 *
 *  1. THE COLUMN IS THE PHASE. There is no move/reorder tool. Writing `phase`
 *     is the move.
 *
 *  2. POLICY LIVES IN THE TOOL DESCRIPTION; SAFETY LIVES IN CODE. The
 *     description tells the agent when to move. The `humanOnly` guard makes it
 *     impossible to reach an approval column whatever the prompt says. Never
 *     rely on prose for a boundary that matters.
 *
 * The agent acts on its OWN session — it never passes an id, so it cannot move
 * someone else's card by mistake.
 */
import { z } from 'zod'
import type { SessionStore } from '../sessions/store.ts'
import { isHumanOnly, isReviewColumn, isStartedColumn, type BoardConfig } from '../board/config.ts'
import { normaliseTestPlan, normaliseTitle } from '../sessions/meta.ts'
import { loadSdk } from './sdk.ts'

/** The MCP namespace these tools are mounted under; `mcpServers: { board: … }`. */
export const BOARD_SERVER = 'board'

/** The name the model sees for one of our tools. */
export function boardToolName(name: string): string {
  return `mcp__${BOARD_SERVER}__${name}`
}

/** An agent asking for the user's attention mid-run, as Nimbalyst's
 *  `notify_user` does. Distinct from a phase move: the work is not finished,
 *  the agent is stuck or needs a decision. */
export interface BoardNotice {
  key: string
  message: string
  urgency: 'info' | 'blocked'
}

export interface BoardChange {
  sessionId: string
  phase?: { from: string; to: string }
  /** The agent's one line about WHY it moved. Bounded here rather than in the
   *  description, because a length asked for in a schema is not a limit. */
  note?: string
  tagsAdded?: string[]
  tagsRemoved?: string[]
}

/** What `split_task` proposes: one subtask, ready to become its own session. */
export interface SubtaskProposal {
  title: string
  prompt: string
  /** Files this piece expects to touch. Checked host-side; see `checkProposal`. */
  scope?: string[]
  tags?: string[]
}

export type SplitOutcome =
  | { ok: true; started: { key: string; title: string; branch: string }[] }
  | { ok: false; message: string }

export interface BoardToolContext {
  store: SessionStore
  /**
   * What the board calls this run. Bound at construction, not passed in, so an
   * agent can only ever act on its own card.
   *
   * `sessionId ?? runId`, never undefined. It used to be the session id alone,
   * which meant an agent had no card at all until Claude Code assigned one —
   * and none ever, if that id was refused as a duplicate. Every board tool then
   * answered "this session is not on the board yet" and the agent silently gave
   * up on moving itself.
   */
  key: () => string
  onChanged: (change?: BoardChange) => void
  /** Raise the agent's message to the user, out of band from the transcript. */
  onNotice?: (notice: BoardNotice) => void
  /**
   * Turn a proposed split into running sessions, or explain why not.
   *
   * Every boundary that matters — how many, how deep, and whether this session
   * has already changed something it would strand — lives behind this callback,
   * in `AgentManager.split()`. The description below is policy; that is the
   * fence.
   */
  onSplit?: (subtasks: SubtaskProposal[], reason: string) => Promise<SplitOutcome>
  /**
   * Rename this session's card.
   *
   * A callback rather than a `store.rename()` from in here, because the title
   * lives in two places while a run is in flight: Claude Code's own session
   * record, and `RunningAgent.title`, which is what the board shows for a run
   * whose session id has not arrived yet. The manager owns both.
   */
  onRename?: (title: string) => Promise<{ renamed: boolean; reason?: string }> | { renamed: boolean; reason?: string }
  /**
   * The card's title while it is still the one GUESSED from the prompt, and
   * `undefined` once the agent has chosen one.
   *
   * Exists because of a real run: every unit test passed, the tool was
   * auto-allowed, the brief asked for it — and the agent moved its card twice
   * without ever renaming it. A paragraph in an appended system prompt is read
   * once, at the start, when the agent does not yet know what the work is. A
   * TOOL RESULT is read at the moment it acts. So the ask is attached to the
   * move into the started column, which every agent makes, at the point where
   * it has just learned enough to name the thing.
   */
  derivedTitle?: () => string | undefined
}

type Content = { content: Array<{ type: 'text'; text: string }>; isError?: boolean }
const ok = (text: string): Content => ({ content: [{ type: 'text', text }] })
const err = (text: string): Content => ({ content: [{ type: 'text', text }], isError: true })

function phaseDescription(board: BoardConfig): string {
  const movable = board.columns.filter((c) => !c.humanOnly)
  const blocked = board.columns.filter((c) => c.humanOnly)
  const lines = [
    'Move your session to a different column on the kanban board.',
    '',
    'A session\'s PHASE IS ITS COLUMN. Valid values:',
    ...board.columns.map((c) => `  - "${c.id}" (${c.name})${c.agentHint ? ` — ${c.agentHint}` : ''}`),
    '',
    'Keep the board honest as you work:',
    `  - Move to "${movable.find((c) => c.category === 'started')?.id ?? 'implementing'}" as soon as you start changing code.`,
    `  - Move to "${movable.find((c) => c.category === 'review')?.id ?? 'validating'}" when the work is written and you are checking it.`,
  ]
  if (blocked.length) {
    lines.push(
      `  - You cannot set ${blocked.map((c) => `"${c.id}"`).join(' or ')} — that is the user's approval, not yours.`,
    )
  }
  const review = board.columns.filter(isReviewOf(board))
  if (review.length) {
    lines.push(
      '',
      `When you move to ${review.map((c) => `"${c.id}"`).join(' or ')} you MUST pass \`howToTest\`.`,
      'That column means "I am done, your turn to check it" — so say how. The user',
      'has not read your code and does not know what you touched.',
      '',
      '  howToTest: {',
      '    summary: "One line: what changed and what to look at."',
      '    steps:   ["Numbered, concrete. \'Run npm test\', not \'verify it works\'."]',
      '    links:   [{ label: "...", target: "...", kind: "file" | "command" | "url" }]',
      '  }',
      '',
      'Links become buttons on the card, so make them do something:',
      '  - kind "file"    a path in this worktree — opens in their editor',
      '  - kind "command" a shell line — opens a terminal already in this worktree',
      '  - kind "url"     a running server, a PR, a doc page',
      'Include the files you changed and the exact command that checks them.',
    )
  }
  return lines.join('\n')
}

const isReviewOf = (board: BoardConfig) => (c: { id: string }) => isReviewColumn(board, c.id)

export function buildBoardTools(
  board: BoardConfig,
  ctx: BoardToolContext,
  tool: Awaited<ReturnType<typeof loadSdk>>['tool'],
) {
  const phases = board.columns.map((c) => c.id)

  const setPhase = tool(
    'set_phase',
    phaseDescription(board),
    {
      phase: z.string().describe(`The column to move to. One of: ${phases.join(', ')}`),
      note: z.string().optional().describe('A short line saying why, shown on the board.'),
      howToTest: z
        .object({
          summary: z.string().describe('One line: what changed and what to look at.'),
          steps: z.array(z.string()).describe('Concrete steps the user follows, in order.'),
          links: z
            .array(
              z.object({
                label: z.string().describe('What the button says.'),
                target: z.string().describe('A worktree-relative path, a shell command, or a URL.'),
                kind: z.enum(['file', 'command', 'url']).describe('Decides what clicking it does.'),
              }),
            )
            .optional()
            .describe('Buttons on the card: the files you changed, the command that checks them.'),
        })
        .optional()
        .describe('REQUIRED when moving to a review column. How the user tests this work.'),
    },
    async (args) => {
      const id = ctx.key()
      if (!phases.includes(args.phase)) {
        return err(`"${args.phase}" is not a column. Valid values: ${phases.join(', ')}.`)
      }
      // The approval boundary. Enforced here, not in the prompt.
      if (isHumanOnly(board, args.phase)) {
        return err(
          `You cannot move to "${args.phase}" — that column is the user's approval step. ` +
          `Move to a review column instead and let them decide.`,
        )
      }
      // Reaching a review column means handing the work back. Refuse to do that
      // silently: the user gets a card that says "ready" and no idea what to do
      // with it. The description asks; this makes it so.
      const plan = normaliseTestPlan(args.howToTest)
      // isHumanOnly already returned above, so the phase is one the agent may set.
      if (isReviewColumn(board, args.phase) && !plan) {
        return err(
          `Moving to "${args.phase}" hands this work back to the user, so it needs \`howToTest\`. ` +
          'Call set_phase again with howToTest: { summary, steps, links } — a one-line summary, ' +
          'the concrete steps to check it, and links to the files you changed and the command that ' +
          'verifies them (kind: "file" | "command" | "url").',
        )
      }

      const current = await ctx.store.card(id)
      const from = current.phase
      if (plan) await ctx.store.setTestPlan(id, plan)
      /* Leaving a review column retracts the plan that got it there.
         A test plan describes work as it stood when the agent handed it back.
         Once the card moves out of review — the agent picked it up again, or
         the user pushed it back — that description is about a state that no
         longer exists, and it had no way to be cleared: `stripUndefined()`
         drops `undefined` from a patch, so nothing could unset it, and
         `normaliseTestPlan` refuses to manufacture an empty plan, so an agent
         explicitly retracting one was ignored. The panel could say "here is how
         to test this" and never "that is out of date". */
      else if (isReviewColumn(board, from) && !isReviewColumn(board, args.phase) && current.testPlan) {
        await ctx.store.clearTestPlan(id)
      }
      if (from === args.phase) {
        return ok(plan ? `Already in "${args.phase}"; test plan updated.` : `Already in "${args.phase}".`)
      }
      await ctx.store.setPhase(id, args.phase)
      // The note goes WITH the move. Its own description promises the user
      // will see it ("A short line saying why, shown on the board"), and the
      // handler dropped it — so the model spent tokens explaining every move
      // into nothing. A field accepted and never written is the mirror of a
      // field written and never read.
      ctx.onChanged({
        sessionId: id, phase: { from, to: args.phase },
        ...(args.note?.trim() ? { note: args.note.trim().slice(0, 200) } : {}),
      })
      const guessed = isStartedColumn(board, args.phase) ? ctx.derivedTitle?.() : undefined
      return ok(
        `Moved: ${from} -> ${args.phase}.` +
        (plan ? ` Test plan recorded (${plan.steps.length} step(s), ${plan.links.length} link(s)).` : '') +
        (guessed && ctx.onRename
          ? `\n\nThis card is still called "${guessed}", which was taken from the first line of the ` +
            'request rather than from the work. You now know what the work is, so give it a name: ' +
            'call `set_title` with six words or fewer. If that title is already right, carry on.'
          : ''),
      )
    },
  )

  const setTags = tool(
    'set_tags',
    'Tag your session so it can be found on the board later — the area of the codebase, the kind of work, anything you would want to filter by. Replaces the existing tags.',
    { tags: z.array(z.string()).describe('The full tag list, e.g. ["auth", "bug-fix"].') },
    async (args) => {
      const id = ctx.key()
      const before = (await ctx.store.card(id)).tags
      const next = [...new Set(args.tags.map((t) => t.trim().replace(/^#/, '')).filter(Boolean))]
      await ctx.store.setTags(id, next)
      ctx.onChanged({
        sessionId: id,
        tagsAdded: next.filter((t) => !before.includes(t)),
        tagsRemoved: before.filter((t) => !next.includes(t)),
      })
      return ok(`Tags: ${next.join(', ') || '(none)'}`)
    },
  )

  const setTitle = tool(
    'set_title',
    [
      'Rename your own card.',
      '',
      'The card was named automatically from the first line of the request, and a',
      'request often opens with something that is not a description of the work —',
      '"Okay.", "So I want you to…". Once you know what this session is actually',
      'doing, say so here. This is the name the user reads when scanning a column,',
      'so it is worth one call.',
      '',
      'Six words or fewer, saying what the work IS: "Add SSO to the admin app",',
      '"Fix the flaky snapshot test". Not a restatement of the brief, not a status',
      '("working on auth"), and no trailing full stop.',
      '',
      'This renames the CARD ONLY. Your git branch and worktree directory keep the',
      'names they were given when the session started, because you are running',
      'inside that directory — so do not expect them to follow, and do not try to',
      'move them yourself.',
    ].join('\n'),
    {
      title: z.string().describe('What this session is doing, in a few words.'),
    },
    async (args) => {
      const title = normaliseTitle(args.title)
      if (!title) return err('A title needs at least one word.')
      if (!ctx.onRename) return err('This session cannot be renamed from here.')
      const renamed = await ctx.onRename(title)
      // Answered from what actually happened. This used to say "Card renamed"
      // unconditionally, and on a runtime that owns its own session names the
      // card visibly took the title and then reverted when the run ended — a
      // tool reporting a write nothing made.
      if (renamed && renamed.renamed === false) {
        return ok(
          `The card now reads "${title}" for this run, but ${renamed.reason ?? 'this agent owns its own session names'}, ` +
          'so it will go back to the name that agent gave it once the run ends. Rename it there if it matters.',
        )
      }
      return ok(`Card renamed to "${title}".`)
    },
  )

  const listBoard = tool(
    'list_board',
    'List the other sessions on this board and what phase each is in. Useful before starting work that might overlap with another agent.',
    { phase: z.string().optional().describe(`Only this column. One of: ${phases.join(', ')}`) },
    async (args) => {
      const all = (await ctx.store.list()).filter((s) => !args.phase || s.phase === args.phase)
      if (!all.length) return ok('No other sessions on the board.')
      const mine = ctx.key()
      const groups = board.columns
        .map((c) => {
          const inCol = all.filter((s) => s.phase === c.id)
          if (!inCol.length) return ''
          return `## ${c.name}\n` + inCol
            .map((s) => `  ${s.id === mine ? '* ' : '  '}${s.title}${s.tags.length ? `  [${s.tags.join(', ')}]` : ''}`)
            .join('\n')
        })
        .filter(Boolean)
      return ok(groups.join('\n\n') + '\n\n(* is you)')
    },
    { annotations: { readOnlyHint: true }, searchHint: 'kanban board sessions' },
  )

  const splitTask = tool(
    'split_task',
    [
      'Split this task into subtasks, each run by its own agent in its own git',
      'worktree, and each appearing on the board as a subtask of this card.',
      '',
      'USE THIS WHEN the request you were given is really two or more UNRELATED',
      'pieces of work — "add SSO and also fix the flaky snapshot test" — or when',
      'it is large enough that one session would lose the thread. Splitting means',
      'they run at once, in isolated checkouts, and the user tests and merges each',
      'one on its own instead of untangling a single enormous diff.',
      '',
      'DO NOT use it to parallelise ONE coherent change. Two agents editing two',
      'halves of the same feature cannot see each other\'s work and will merge into',
      'a mess. If the pieces have to know about each other, do them yourself, in',
      'order.',
      '',
      'SPLIT BEFORE YOU CHANGE ANYTHING. Subtasks fork from the branch this session',
      'started from, so anything you have already written here would be left behind',
      'on a branch nothing merges. This is refused outright once the worktree is',
      'dirty or has commits — read, plan, then split.',
      '',
      'Each subtask starts a FRESH agent that has never seen this conversation, so',
      'write `prompt` as a complete, standalone brief: what to do, where, what done',
      'looks like. "The other half of the ticket" means nothing to it.',
      '',
      'When this returns successfully your job is finished — say what you split and',
      'why, and STOP. Do not start doing one of the subtasks yourself; an agent is',
      'already on it.',
    ].join('\n'),
    {
      reason: z
        .string()
        .describe('One line for the user: why this is more than one task. Shown when they approve the split.'),
      subtasks: z
        .array(
          z.object({
            title: z.string().describe('The card title. Short, and specific enough to tell the subtasks apart.'),
            prompt: z
              .string()
              .describe('The full standalone brief for a fresh agent. It has no other context.'),
            scope: z
              .array(z.string())
              .describe(
                'The files or directories this subtask expects to touch, e.g. ["src/auth/", ' +
                '"tests/auth.test.ts"]. Required: a subtask with nothing of its own is not a ' +
                'separate subtask. It is a PREDICTION, not a fence — the board compares it ' +
                'against what actually changed, which is how you find out afterwards whether ' +
                'the split was right.',
              ),
            tags: z.array(z.string()).optional().describe('Tags for the subtask\'s card.'),
          }),
        )
        .describe('At least 2, at most 4 — and fewer if this card is set to a lower ' +
          'orchestration level, which the refusal will name. Each one has to be ' +
          'independently testable.'),
    },
    async (args) => {
      if (!ctx.onSplit) {
        return err('Subtasks cannot be started in this workspace — it is not a git repository.')
      }
      // `reason` is passed on, not dropped. Its own schema promises the user
      // will see it ("Shown when they approve the split") and the handler used
      // to call `onSplit(args.subtasks)` — so the one sentence explaining why a
      // card became four billed agents reached nothing at all, and the approval
      // prompt rendered the bare string `split_task`.
      const result = await ctx.onSplit(args.subtasks ?? [], args.reason ?? '')
      if (!result.ok) return err(result.message)
      const lines = result.started.map((s) => `  - ${s.title}  [${s.branch}]`)
      return ok(
        [
          `Started ${result.started.length} subtasks, each in its own worktree:`,
          ...lines,
          '',
          'They are on the board as subtasks of your card, and the user tests each one',
          'separately. Your work here is done — summarise the split and stop.',
        ].join('\n'),
      )
    },
  )

  const notifyUser = tool(
    'notify_user',
    [
      'Get the user\'s attention while you are still working.',
      '',
      'Use this when you are STUCK or need a decision only they can make — a',
      'missing credential, an ambiguous requirement, two designs that both work.',
      'They may not be looking at the board, so this reaches them directly.',
      '',
      'Do NOT use it to report progress, and do not use it when you have finished:',
      'moving your card to a review column already tells them, and it carries your',
      'test plan with it. This is for when you cannot continue without them.',
    ].join('\n'),
    {
      message: z.string().describe('One or two sentences. Say what you need, not what you did.'),
      urgency: z
        .enum(['info', 'blocked'])
        .optional()
        .describe('"blocked" means you have stopped and cannot continue. Default "info".'),
    },
    async (args) => {
      const message = args.message.trim()
      if (!message) return err('Say something — an empty notification is worse than none.')
      ctx.onNotice?.({ key: ctx.key(), message, urgency: args.urgency ?? 'info' })
      return ok('The user has been notified.')
    },
  )

  return [setPhase, setTitle, setTags, listBoard, splitTask, notifyUser]
}

/**
 * Board tools that are NOT auto-allowed — the user is asked first.
 *
 * `split_task` starts other agents, and an agent is a process with a bill. That
 * is a decision worth one click, and the existing permission prompt already
 * renders it ("Claude wants to run split_task: Add SSO + Fix the flaky test"),
 * so it needs no new surface. Everything else here only writes to our own
 * sidecar and is auto-allowed, because an agent that has to ask permission to
 * move its own card cannot keep the board honest.
 *
 * Under `dontAsk` or `bypassPermissions` this is not consulted, as with any
 * other tool — that is what those modes mean.
 */
export const ASKS_FIRST = new Set(['split_task'])

/**
 * The fully-qualified names of the board tools.
 *
 * Derived from the tool definitions themselves rather than written out again,
 * because the hand-maintained copy DID drift: the auto-allow list still held
 * v1's `task_update` and friends long after the tools were renamed, so every
 * attempt by an agent to move its own card stopped for a permission prompt —
 * the headline feature, silently gated behind a click.
 */
export function boardToolNames(
  board: BoardConfig,
  tool: Awaited<ReturnType<typeof loadSdk>>['tool'],
): string[] {
  const noop: BoardToolContext = { store: null as never, key: () => '', onChanged: () => {} }
  return buildBoardTools(board, noop, tool)
    .filter((t) => !ASKS_FIRST.has(t.name))
    .map((t) => boardToolName(t.name))
}

export async function createBoardServer(board: BoardConfig, ctx: BoardToolContext) {
  const { createSdkMcpServer, tool } = await loadSdk()
  return createSdkMcpServer({
    name: 'board',
    version: '0.2.0',
    instructions:
      'Tools for this workspace\'s kanban board. Keep your own card honest: move it ' +
      'into the implementing column when you start and the validating column when you finish.',
    tools: buildBoardTools(board, ctx, tool),
    // Keep these in the turn-1 prompt: the agent must know it can move its card
    // without first having to go looking for the tool.
    alwaysLoad: true,
  })
}
