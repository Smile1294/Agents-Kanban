/** The AskUserQuestion picker.
 *
 * `AskUserQuestion` is a built-in Claude Code tool: the agent calls it to put a
 * multiple-choice question to the user and waits for the answer. It arrives
 * through the SAME channel as `Bash` or `Write` — `canUseTool` is handed a tool
 * name and its input — but it is NOT a permission question. Allowing it does
 * not answer it.
 *
 * That distinction is the bug this module exists to fix. The board rendered
 * every `canUseTool` call as one Allow/Deny pair, so a question arrived as
 * `Claude wants to run AskUserQuestion`, the user pressed Allow, and the tool
 * was resolved with its input UNCHANGED — no `answers` key. The tool then
 * reported "The user did not answer the questions" and the agent carried on
 * without the decision it had stopped to ask for. The options never reached the
 * webview and there was no channel to send a choice back, so every question an
 * agent asked was silently discarded, and from the user's side a prompt
 * appeared with nothing in it.
 *
 * So: parse the questions out of the tool input, let the view render real
 * options, and hand the selections back as `answers` in `updatedInput`.
 *
 * Everything here is defensive. The input is written by a model, so no field is
 * guaranteed to exist, to be the right type, or to be non-empty. Anything we
 * cannot render falls back to the ordinary Allow/Deny prompt, which still works
 * — better a plain prompt than an empty picker.
 */

/** The tool name Claude Code uses. Matched exactly. */
export const ASK_TOOL = 'AskUserQuestion'

export interface AskOption {
  label: string
  /** What choosing this means. Shown under the label; often absent. */
  description?: string
}

export interface AskQuestion {
  /** The full question, as shown. Trimmed for display. */
  question: string
  /**
   * The question text EXACTLY as the model wrote it, and the key the answer is
   * filed under.
   *
   * The SDK's contract is "question text -> answer string", and the tool
   * matches on the string it sent. `question` is trimmed for display, so a
   * model that wrote `"Which library?\n"` — trailing whitespace is ordinary in
   * generated JSON — got an answer filed under a key that did not match, the
   * tool reported that nobody had answered, and the agent invented the decision
   * it had deliberately stopped to ask about. That is precisely the failure
   * this module exists to prevent, reintroduced by a `.trim()`.
   */
  key: string
  /** Short chip shown beside the question, e.g. "Auth method". */
  header: string
  multiSelect: boolean
  options: AskOption[]
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Pull a renderable question list out of an AskUserQuestion tool input.
 *
 * Returns `undefined` for any other tool, and for input we cannot make sense of
 * — the caller then shows the ordinary Allow/Deny prompt. A question with no
 * usable options is dropped rather than rendered as a dead end; if that leaves
 * nothing, the whole thing is treated as unparseable.
 */
export function parseAskQuestions(toolName: string, input: unknown): AskQuestion[] | undefined {
  if (toolName !== ASK_TOOL) return undefined
  const raw = (input as { questions?: unknown } | null | undefined)?.questions
  if (!Array.isArray(raw)) return undefined

  const out: AskQuestion[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const r = entry as Record<string, unknown>
    const question = text(r.question)
    if (!question) continue
    // The RAW string is the identity; the trimmed one is only for display.
    const key = typeof r.question === 'string' ? r.question : question

    const options: AskOption[] = []
    for (const o of Array.isArray(r.options) ? r.options : []) {
      if (!o || typeof o !== 'object') continue
      const label = text((o as Record<string, unknown>).label)
      if (!label) continue
      const description = text((o as Record<string, unknown>).description)
      options.push(description ? { label, description } : { label })
    }
    if (!options.length) continue

    out.push({
      question,
      key,
      header: text(r.header) || 'Question',
      multiSelect: r.multiSelect === true,
      options,
    })
  }
  return out.length ? out : undefined
}

/** Turn the view's selections into the `answers` record the tool reads.
 *
 * Keyed by the question text, because that is what the tool matches on. A
 * multi-select answer is joined with ", " into the single string the schema
 * allows. Free text is kept as-is: the picker offers an "Other" box because the
 * tool documents that choice as always available, so a selection that matches
 * no declared option is legitimate and must not be filtered out.
 */
export function buildAskAnswers(
  questions: AskQuestion[],
  selections: Record<string, string[] | undefined>,
): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const q of questions) {
    // Keyed on the DISPLAYED text, because that is what the webview posts back
    // — it never sees the raw one.
    const picked = selections[q.question]
    if (!Array.isArray(picked)) continue
    // Deduplicated, because the picker offers a free-text box *as well as* the
    // declared options: typing "Auth" while "Auth" is already ticked must not
    // reach the model as "Auth, Auth".
    const clean: string[] = []
    for (const raw of picked) {
      const v = text(raw)
      if (v && !clean.includes(v)) clean.push(v)
    }
    if (!clean.length) continue
    // Filed under the RAW text, because that is what the tool matches on.
    answers[q.key] = q.multiSelect ? clean.join(', ') : clean[0]!
  }
  return answers
}

/**
 * How much of a permission detail is shown.
 *
 * Generous on purpose. This is the text an Allow/Deny decision is made on, and
 * it used to be cut at 200 characters with NO marker: a `Bash` command whose
 * first line is innocuous and whose payload is past that point rendered as the
 * innocuous part alone, and the click authorised the whole thing. Nothing else
 * in the extension shows a tool input in full either, so there was no surface
 * on which the command could be read before approving it.
 *
 * Anything beyond this is still cut — a runaway input must not become the
 * frame — but it is cut LOUDLY, naming how much is hidden, because "I could
 * not show you all of this" is an answer and silence is not.
 */
export const PERMISSION_DETAIL_MAX = 4000

/** The one-line label plus, for a tool whose input is a command or a path, the
 *  thing itself. See `PERMISSION_DETAIL_MAX`. */
export function summarise(toolName: string, input: Record<string, unknown>): string {
  const name = toolName.replace(/^mcp__[^_]+__/, '')
  const detail = permissionDetail(name, input)
  if (!detail) return name
  if (detail.length <= PERMISSION_DETAIL_MAX) return `${name} — ${detail}`
  const hidden = detail.length - PERMISSION_DETAIL_MAX
  return `${name} — ${detail.slice(0, PERMISSION_DETAIL_MAX)}\n\n` +
    `⚠ ${hidden} more character${hidden === 1 ? '' : 's'} NOT SHOWN. Deny unless you know what the rest is.`
}

/**
 * WHAT this tool is being allowed to do, as text.
 *
 * The generic branch reads the keys a built-in tool puts its subject under.
 * The named branches exist because the tools in `ASKS_FIRST` have none of
 * those keys and fell through to the bare tool name — so the user was asked to
 * approve `split_task` with the subtask prompts, their target agents and their
 * models nowhere on screen, and `schedule_create` with the prompt, the time and
 * the recurrence nowhere on screen. Those are the four tools that start billed
 * work or write a durable record; they are the LAST ones that should be
 * approved blind.
 *
 * Defensive throughout: this is model-written input, and a shape it cannot read
 * degrades to naming the tool rather than throwing on the render path.
 */
export function permissionDetail(name: string, input: Record<string, unknown>): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')
  const num = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '')
  if (name === 'split_task') {
    const pieces = Array.isArray(input.subtasks) ? input.subtasks : []
    if (!pieces.length) return ''
    return pieces.map((raw, i) => {
      const p = (raw ?? {}) as Record<string, unknown>
      const route = [str(p.agent), str(p.model), str(p.effort)].filter(Boolean).join(' · ')
      return `${i + 1}. ${str(p.title) || '(untitled)'}${route ? `  [${route}]` : ''}\n   ${str(p.prompt)}`
    }).join('\n\n')
  }
  if (name === 'schedule_create') {
    const at = num(input.hour) && `${num(input.hour)}:${num(input.minute).padStart(2, '0')}`
    const days = Array.isArray(input.days) && input.days.length ? ` on days ${input.days.join(',')}` : ' every day'
    return `${str(input.title) || '(untitled)'} — ${at || 'no time given'}${days}\n\n${str(input.prompt)}`
  }
  if (name === 'schedule_delete' || name === 'schedule_run') {
    return str(input.id) || str(input.title)
  }
  return str(input.command) || str(input.file_path) || str(input.path) || str(input.url)
}
