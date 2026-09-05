/* The AskUserQuestion picker.

   The bug these guard: allowing the tool is not the same as answering it. The
   board used to resolve an AskUserQuestion with its input untouched, so the
   tool reported "The user did not answer the questions" and the agent invented
   a decision it had deliberately stopped to ask about. The user saw an
   Allow/Deny prompt with no question in it.

   Everything parsed here is written by a model, so the parser is tested on
   malformed input at least as hard as on good input. */
import {
  ASK_TOOL,
  buildAskAnswers,
  parseAskQuestions,
  type AskQuestion,
} from '../questions.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const good = {
  questions: [
    {
      question: 'Which database?',
      header: 'Database',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'Relational, what we know' },
        { label: 'SQLite', description: 'No server to run' },
      ],
    },
    {
      question: 'Which features?',
      header: 'Features',
      multiSelect: true,
      options: [{ label: 'Auth' }, { label: 'Billing' }, { label: 'Search' }],
    },
  ],
}

// --- parsing -----------------------------------------------------------------
const parsed = parseAskQuestions(ASK_TOOL, good)
ok(!!parsed && parsed.length === 2, 'both questions are parsed')
ok(parsed?.[0]?.header === 'Database', 'the header chip survives')
ok(parsed?.[0]?.options[1]?.label === 'SQLite', 'option labels survive')
ok(parsed?.[0]?.options[0]?.description === 'Relational, what we know', 'option descriptions survive')
ok(parsed?.[0]?.multiSelect === false && parsed?.[1]?.multiSelect === true, 'multiSelect is carried per question')

// Only this tool. Every other tool keeps the ordinary Allow/Deny prompt.
ok(parseAskQuestions('Bash', good) === undefined, 'a different tool is not treated as a question')
ok(parseAskQuestions('Write', { questions: [] }) === undefined, 'Write is not hijacked by a questions key')

// --- model-written input is not to be trusted --------------------------------
ok(parseAskQuestions(ASK_TOOL, undefined) === undefined, 'undefined input falls back to Allow/Deny')
ok(parseAskQuestions(ASK_TOOL, null) === undefined, 'null input falls back to Allow/Deny')
ok(parseAskQuestions(ASK_TOOL, {}) === undefined, 'no questions key falls back to Allow/Deny')
ok(parseAskQuestions(ASK_TOOL, { questions: 'nope' }) === undefined, 'a non-array questions key falls back')
ok(parseAskQuestions(ASK_TOOL, { questions: [] }) === undefined, 'an empty list falls back')
ok(
  parseAskQuestions(ASK_TOOL, { questions: [{ question: 'Q?', options: [] }] }) === undefined,
  'a question with no options falls back rather than rendering a dead end',
)
ok(
  parseAskQuestions(ASK_TOOL, { questions: [{ question: '   ', options: [{ label: 'a' }] }] }) === undefined,
  'a blank question is dropped',
)
ok(
  parseAskQuestions(ASK_TOOL, { questions: [{ question: 'Q?', options: [{ label: '  ' }, { label: 'ok' }] }] })
    ?.[0]?.options.length === 1,
  'a blank option label is dropped but its siblings survive',
)
ok(
  parseAskQuestions(ASK_TOOL, { questions: [null, 7, 'x', { question: 'Q?', options: [{ label: 'a' }] }] })
    ?.length === 1,
  'junk entries are skipped without losing the good one',
)
ok(
  parseAskQuestions(ASK_TOOL, { questions: [{ question: 'Q?', options: [{ label: 'a' }] }] })?.[0]?.header === 'Question',
  'a missing header gets a usable default rather than an empty chip',
)

// --- building the answers record ---------------------------------------------
const qs = parsed as AskQuestion[]
const one = buildAskAnswers(qs, { 'Which database?': ['Postgres'], 'Which features?': ['Auth', 'Search'] })
ok(one['Which database?'] === 'Postgres', 'a single-select answer is the bare label')
ok(one['Which features?'] === 'Auth, Search', 'a multi-select answer joins into one string')
ok(Object.keys(one).length === 2, 'the record is keyed by question text, which is what the tool matches on')

// Free text is the "Other" box, which the tool always offers. It must not be
// filtered out for failing to match a declared option.
const other = buildAskAnswers(qs, { 'Which database?': ['DuckDB, actually'], 'Which features?': ['Auth'] })
ok(other['Which database?'] === 'DuckDB, actually', 'a free-text answer is kept verbatim')

// The picker offers a free-text box beside the declared options, so the same
// string can arrive twice. It must not reach the model as "Auth, Auth".
const dup = buildAskAnswers(qs, { 'Which features?': ['Auth', 'Auth', 'Billing'] })
ok(dup['Which features?'] === 'Auth, Billing', 'a repeated selection is sent once')
const dupTrim = buildAskAnswers(qs, { 'Which features?': ['Auth', '  Auth  '] })
ok(dupTrim['Which features?'] === 'Auth', 'and deduplication happens after trimming')

ok(Object.keys(buildAskAnswers(qs, {})).length === 0, 'no selections produce no answers')
ok(Object.keys(buildAskAnswers(qs, { 'Which database?': [] })).length === 0, 'an empty selection is not an answer')
ok(
  Object.keys(buildAskAnswers(qs, { 'Which database?': ['  '] })).length === 0,
  'a whitespace-only answer is not an answer',
)
ok(
  Object.keys(buildAskAnswers(qs, { 'Not a question': ['x'] })).length === 0,
  'a selection for a question that was not asked is ignored',
)


// --- the answer KEY is the model's own string, not the trimmed one ----------
//
// The SDK's contract is "question text -> answer string", and the tool matches
// on the string it sent. `question` is trimmed for display, and that trimmed
// value was used as the key — so a model that wrote trailing whitespace (which
// is ordinary in generated JSON) got its answer filed under a key that did not
// match, the tool reported nobody had answered, and the agent invented the
// decision it had deliberately stopped to ask about. That is the exact failure
// this module exists to prevent, reintroduced by a `.trim()`.
{
  const raw = 'Which library should we use?\n'
  const qs = parseAskQuestions('AskUserQuestion', {
    questions: [{ question: raw, header: 'Library', multiSelect: false, options: [{ label: 'date-fns' }, { label: 'luxon' }] }],
  })
  ok(qs?.length === 1, 'the question parses')
  ok(qs![0]!.question === 'Which library should we use?', 'the DISPLAYED text is trimmed')
  ok(qs![0]!.key === raw, `and the KEY is the model's own string, untouched (${JSON.stringify(qs![0]!.key)})`)

  // The webview posts back the displayed text — it never sees the raw one — so
  // the lookup uses that and the answer is filed under the raw key.
  const answers = buildAskAnswers(qs!, { 'Which library should we use?': ['luxon'] })
  ok(answers[raw] === 'luxon',
     `the answer is filed under the key the tool matches on (${JSON.stringify(Object.keys(answers))})`)
  ok(answers['Which library should we use?'] === undefined,
     'and NOT under the trimmed one, which the tool would never look up')
}

console.log(fails === 0 ? 'PASS — questions parse, answers build, and junk input degrades to Allow/Deny' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
