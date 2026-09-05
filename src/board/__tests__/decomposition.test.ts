/* The orchestration dial, and the two invariants it must not be able to break.
 *
 * The product principle is "use exactly as much orchestration as the task
 * justifies", which reduces to two claims a user can check:
 *
 *   - a trivial task stays ONE agent even at Maximum, and
 *   - a genuinely large one still splits at Minimal.
 *
 * Neither is enforced by arithmetic. They hold because the level may only ever
 * ASK FOR MORE and ALLOW LESS: `aim` is prose that no gate reads, and
 * `maxPieces` is a ceiling floored at 2. The test that matters most in this file
 * is the one asserting `checkProposal` returns IDENTICAL verdicts for two
 * policies differing only in `level` — the moment a refusal consults the level,
 * "a huge task still splits at Minimal" stops being true and nothing else here
 * would notice.
 */
import {
  aimSentence, checkProposal, decompositionLine, DEFAULT_ORCHESTRATION,
  ORCHESTRATION_CHOICES, ORCHESTRATION_LEVELS, parseOrchestrationLevel, policyFor,
  MAX_BRIEF, type OrchestrationLevel, type PieceProposal,
} from '../decomposition.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const piece = (n: string, over: Partial<PieceProposal> = {}): PieceProposal => ({
  title: n, prompt: `Do ${n}, in full, standalone.`, scope: [`src/${n}/`], ...over,
})
const two = [piece('auth'), piece('docs')]

// --- the levels themselves ---------------------------------------------------
//
// THREE, not four. A fourth would resolve to the same cap AND the same sentence
// as its neighbour, because MAX_SUBTASKS is 4 and the default concurrency is 3 —
// a named position whose entire observable effect is identical to the one beside
// it, which is a control that cannot say anything.
ok(ORCHESTRATION_LEVELS.length === 3, `three levels (${ORCHESTRATION_LEVELS.join(', ')})`)
ok(ORCHESTRATION_CHOICES.length === ORCHESTRATION_LEVELS.length, 'and one picker entry each')
for (const c of ORCHESTRATION_CHOICES) {
  ok(!!parseOrchestrationLevel(c.key), `${c.key} is a real level`)
  ok(!!c.detail && c.detail !== c.label, `${c.key} explains itself rather than repeating its name`)
}

// Every level must be observably different, or the dial has a dead position.
{
  const policies = ORCHESTRATION_LEVELS.map((l) => policyFor(l))
  const aims = new Set(policies.map((p) => p.aim))
  const caps = new Set(policies.map((p) => p.maxPieces))
  ok(aims.size === policies.length, `every level emits a DIFFERENT disposition (${[...aims].join(', ')})`)
  ok(caps.size === policies.length, `and allows a different number of pieces (${[...caps].join(', ')})`)
  const sentences = new Set(policies.map((p) => aimSentence(p)))
  ok(sentences.size === policies.length, 'and the sentences the agent actually reads are pairwise distinct')

  // Monotone: a higher level never allows FEWER pieces.
  for (let i = 1; i < policies.length; i++) {
    ok(policies[i]!.maxPieces >= policies[i - 1]!.maxPieces,
       `${policies[i]!.level} allows at least as many as ${policies[i - 1]!.level}`)
  }
  // Floored at 2 — a ceiling that could drop below two would FORBID splitting,
  // and no level is allowed to do that.
  for (const p of policies) {
    ok(p.maxPieces >= 2, `${p.level} can never forbid a split (cap ${p.maxPieces})`)
  }
}

// Parsed, never cast: this is read on the path that builds a brief.
for (const bad of [undefined, null, '', 'MINIMAL', 'aggressive', 4, {}]) {
  ok(parseOrchestrationLevel(bad) === undefined,
     `${JSON.stringify(bad) ?? 'undefined'} is not a level`)
}
ok(policyFor('nonsense' as OrchestrationLevel).level === 'balanced',
   'and an unknown level resolves to the default rather than throwing on the render path')
ok(parseOrchestrationLevel(DEFAULT_ORCHESTRATION) === DEFAULT_ORCHESTRATION, 'the default is itself a real level')

// --- THE INVARIANT ----------------------------------------------------------
//
// No gate reads `level`. It reaches `checkProposal` only as a ceiling, and this
// is what proves it: run the SAME proposal through two policies that differ only
// in their level, with the cap held constant, and the verdicts must be
// identical. An invariant enforced by a term the dial moves is not an invariant.
{
  const cases: PieceProposal[][] = [
    two,                                                   // fine
    [piece('auth')],                                       // one-piece
    [piece('auth'), { ...piece('docs'), scope: [] }],       // scope-missing
    [piece('auth'), { ...piece('docs'), prompt: 'Finish what the other task started.' }],
    [piece('auth'), { ...piece('docs'), prompt: 'x'.repeat(MAX_BRIEF + 1) }],
  ]
  for (const proposal of cases) {
    const verdicts = ORCHESTRATION_LEVELS.map((l) =>
      JSON.stringify(checkProposal(proposal, { ...policyFor(l), maxPieces: 4 }, 4)))
    ok(new Set(verdicts).size === 1,
       `the verdict does not depend on the level: ${JSON.parse(verdicts[0]!).rule ?? 'accepted'}`)
  }
}

// --- the two claims a user can check ----------------------------------------
//
// A ceiling cannot REQUIRE a split, so a one-piece proposal is refused at every
// level — including Maximum. This is "a trivial task stays one agent at
// Maximum", stated as the only thing code can state about it: nothing in the
// gate can turn one piece into several.
for (const level of ORCHESTRATION_LEVELS) {
  const v = checkProposal([piece('rename')], policyFor(level), 4)
  ok(v.ok === false && v.rule === 'one-piece',
     `at ${level}, one piece is still one piece — nothing here can manufacture a split`)
}
// A floor of 2 cannot FORBID one, so two genuinely separate pieces run at
// Minimal. This is "a huge task still decomposes at Minimal".
{
  const v = checkProposal(two, policyFor('minimal'), 4)
  ok(v.ok === true, `at minimal, two unrelated pieces still run (${v.ok ? 'yes' : v.message})`)
}
// And the floor lives in `checkProposal`, not only in `policyFor` — so a policy
// that somehow asked for fewer than two still cannot forbid a split. Tested
// with a deliberately broken policy, because the invariant has to survive a
// future level table as well as this one.
{
  const v = checkProposal(two, { level: 'minimal', aim: 'one', maxPieces: 1 }, 4)
  ok(v.ok === true,
     `even a cap of 1 cannot forbid a split — the floor is in the gate (${v.ok ? 'ran' : v.message})`)
  const zero = checkProposal(two, { level: 'minimal', aim: 'one', maxPieces: 0 }, 4)
  ok(zero.ok === true, 'and neither can a cap of 0')
}

// --- the gates ---------------------------------------------------------------
{
  // Over the cap is REFUSED, never truncated. Truncating would run agents
  // against briefs written on the assumption their siblings exist, and would
  // read to the user as "covered everything".
  const four = [piece('a'), piece('b'), piece('c'), piece('d')]
  const v = checkProposal(four, policyFor('minimal'), 4)
  ok(v.ok === false && v.rule === 'over-cap', 'four pieces at minimal is over the cap')
  ok(v.ok === false && /\b2\b/.test(v.message) && /\b4\b/.test(v.message),
     `and the refusal names BOTH numbers, so the gap is actionable (${v.ok ? '' : v.message})`)
  const accepted = checkProposal(four, policyFor('maximum'), 4)
  ok(accepted.ok === true, 'while the same four run at maximum')
  ok(accepted.ok === true && accepted.pieces.length === 4,
     'with all four kept — the cap refuses, it never silently drops any')
}
{
  // A brief is handed to an agent that has seen neither this conversation nor
  // its siblings, so a cross-reference is a brief it cannot follow.
  for (const prompt of [
    'Finish what the other task started.',
    'Implement the API as decided above.',
    'Task 2 will handle the migration; do the rest.',
  ]) {
    const v = checkProposal([piece('a'), { ...piece('b'), prompt }], policyFor('balanced'), 4)
    ok(v.ok === false && v.rule === 'brief-cross-reference',
       `a brief that leans on a sibling is refused: ${JSON.stringify(prompt.slice(0, 34))}`)
  }
  // …and an ordinary brief that merely uses the word "other" is not.
  const fine = checkProposal(
    [piece('a'), { ...piece('b'), prompt: 'Move the other helpers in this file into utils.ts.' }],
    policyFor('balanced'), 4,
  )
  ok(fine.ok === true, 'while an ordinary use of the word "other" is left alone')
}
{
  // Scope is required: a subtask with no files of its own is not a separate
  // subtask, and the declaration is the only thing that can later say the split
  // was wrong.
  const v = checkProposal([piece('a'), { ...piece('b'), scope: undefined }], policyFor('balanced'), 4)
  ok(v.ok === false && v.rule === 'scope-missing', 'a piece with no declared scope is refused')
  ok(v.ok === false && v.message.includes('b'), 'and the refusal names which one')
}
{
  // There is deliberately NO minimum brief length: a floor is a proxy for
  // completeness that can only reward padding.
  const terse = checkProposal(
    [{ title: 'a', prompt: 'Delete src/old.ts.', scope: ['src/old.ts'] },
     { title: 'b', prompt: 'Bump the lockfile.', scope: ['package-lock.json'] }],
    policyFor('balanced'), 4,
  )
  ok(terse.ok === true, 'a correct short brief is accepted — there is no length floor to game')
}

// --- overlap is a NOTE, never a refusal --------------------------------------
//
// Refusing on declared overlap treats a prediction as a contract. It would
// refuse two honest unrelated tasks that both add a dependency to package.json,
// and it would teach the model to under-declare — destroying the drift readout,
// which is the only signal in the whole feature that can say "bad".
{
  const v = checkProposal(
    [{ ...piece('auth'), scope: ['src/auth/', 'package.json'] },
     { ...piece('docs'), scope: ['docs/', 'package.json'] }],
    policyFor('balanced'), 4,
  )
  ok(v.ok === true, 'two pieces that share a file still RUN')
  ok(v.ok === true && v.notes.length === 1, 'and the overlap is recorded as a note')
  ok(v.ok === true && v.notes[0]!.paths.includes('package.json'),
     `naming the shared path (${v.ok === true ? v.notes[0]!.paths.join(', ') : ''})`)
  ok(v.ok === true && v.notes[0]!.pieces.length === 2, 'and both pieces that claim it')
  const clean = checkProposal(two, policyFor('balanced'), 4)
  ok(clean.ok === true && clean.notes.length === 0, 'while disjoint scopes produce no note at all')
}

// --- the sentence the agent actually reads ----------------------------------
for (const level of ORCHESTRATION_LEVELS) {
  const s = aimSentence(policyFor(level))
  ok(s.includes('split_task'), `${level}'s sentence names the tool`)
  ok(!/\bmust\b/i.test(s), `${level} asks rather than orders — it biases, it does not dictate`)
}
ok(/PREFER doing this yourself/i.test(aimSentence(policyFor('minimal'))),
   'minimal leans towards one agent')
ok(/readily/i.test(aimSentence(policyFor('maximum'))), 'maximum leans towards several')
// Every level still says the thing that is NOT a preference.
for (const level of ORCHESTRATION_LEVELS) {
  ok(/coherent change|know about each other|share nothing/i.test(aimSentence(policyFor(level))),
     `${level} still warns against splitting one coherent change`)
}

// --- what the card says ------------------------------------------------------
//
// A refused split used to reach the model and nothing else, so a session that
// tried to split and did the work alone was byte-identical on the board to one
// that correctly decided it was a single job.
{
  const split = decompositionLine(
    { at: 1, level: 'balanced', outcome: 'split', requested: 2 }, 2)
  ok(/Split into 2 subtasks/.test(split), `a split says so (${split})`)
  ok(/Balanced/.test(split), 'and which level it was made at')

  const refused = decompositionLine(
    { at: 1, level: 'minimal', outcome: 'refused', requested: 5, rule: 'over-cap' }, undefined)
  ok(/Kept as one agent/.test(refused), `a refusal is visible at all (${refused})`)
  ok(/5/.test(refused) && /Minimal/.test(refused),
     'and says how many were asked for and under what level')
  ok(refused !== split, 'the two outcomes never render the same')

  for (const rule of ['one-piece', 'scope-missing', 'brief-cross-reference', 'brief-too-long'] as const) {
    const line = decompositionLine({ at: 1, level: 'balanced', outcome: 'refused', requested: 2, rule }, undefined)
    ok(line.startsWith('Kept as one agent —') && line.length > 24,
       `${rule} has its own explanation (${line})`)
  }
  // The count shown is what actually STARTED, not what was asked for: a 4-way
  // split where one child never got going must not claim four.
  ok(/Split into 3 subtasks/.test(
    decompositionLine({ at: 1, level: 'maximum', outcome: 'split', requested: 4 }, 3)),
     'a split reports what started, not what was proposed')
}

console.log(fails === 0
  ? 'PASS — the dial biases, and cannot break either invariant'
  : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
