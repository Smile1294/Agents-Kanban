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
  /** The full question. Doubles as the key in the `answers` record, which is
   *  how the tool matches an answer to its question. */
  question: string
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
    answers[q.question] = q.multiSelect ? clean.join(', ') : clean[0]!
  }
  return answers
}

