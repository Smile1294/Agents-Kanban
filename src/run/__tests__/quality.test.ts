/* The board's quality checks, against REAL git repositories and a REAL test
   runner (`node --test`). What it guards: a failure that exists on the base
   branch blamed on the change; a change that breaks a check passed as fine; a
   new test that passes WITHOUT the change counted as proof; a boundary no test
   pins down reported as covered; a flaky test failed or silently passed; and
   the agent's worktree or the user's checkout touched by any of it. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  detectChecks, isTestFile, mutantsFor, qualitySummary, qualityText, relatedTests, runQuality, spread, stemOf,
} from '../quality.ts'
import { parseQuality } from '../../sessions/meta.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// --- pure pieces --------------------------------------------------------------
ok(isTestFile('test/cart.test.mjs') && isTestFile('src/__tests__/a.ts') && isTestFile('tests/test_cart.py') && isTestFile('tests/Feature/CartTest.php')
   && isTestFile('pkg/cart_test.go') && !isTestFile('src/cart.ts') && !isTestFile('src/contest.ts'), 'test files are told from source')
ok(stemOf('src/cart.ts') === 'cart' && stemOf('test/cart.test.mjs') === 'cart' && stemOf('tests/test_cart.py') === 'cart' && stemOf('CartTest.php') === 'cart',
   'a test and its source share a stem across conventions')
ok(relatedTests(['src/cart.mjs'], ['src/cart.mjs', 'test/cart.test.mjs', 'test/user.test.mjs']).join() === 'test/cart.test.mjs', 'the tests for a changed file are found by name')
{
  const src = 'const a = 1\nif (x > 3 && y) return "a > b"\n// if (a === b)\nreturn true'
  const ms = mutantsFor('f.ts', src, [1, 2, 3, 4])
  ok(ms.some((m) => m.line === 2 && m.from === '>' && m.to === '>=') && ms.some((m) => m.line === 2 && m.from === '&&'), 'operators on a changed line become mutants')
  ok(ms.every((m) => !m.mutated.includes('"a >= b"')), 'text inside quotes is never mutated')
  ok(!ms.some((m) => m.line === 3), 'a comment is not behaviour')
  ok(ms.some((m) => m.line === 4 && m.to === 'false'), 'a boolean is flipped')
  ok(mutantsFor('README.md', src, [2]).length === 0, 'only source files are mutated')
  ok(spread(ms, 2).map((m) => m.line).join() === '2,4', 'mutants are spread across lines, not taken from the first one')
}

// --- a real project ---------------------------------------------------------------
const sh = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
async function project(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-quality-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 't@e.com'); sh(root, 'config', 'user.name', 'T')
  for (const [f, t] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, f)), { recursive: true })
    await fs.writeFile(path.join(root, f), t)
  }
  sh(root, 'add', '-A'); sh(root, 'commit', '-qm', 'base')
  const wt = path.join(root, '.wt')
  sh(root, 'worktree', 'add', '-q', wt, '-b', 'task')
  return { root, wt, write: async (f: string, t: string) => { await fs.mkdir(path.dirname(path.join(wt, f)), { recursive: true }); await fs.writeFile(path.join(wt, f), t) } }
}
const PKG = JSON.stringify({ name: 'p', type: 'module', scripts: { lint: 'node lint.mjs', test: 'node --test' } })
const LINT = "import fs from 'node:fs'; const bad = fs.readdirSync('src').filter((f) => fs.readFileSync('src/' + f, 'utf8').includes('debugger')); if (bad.length) { console.log('lint: debugger in ' + bad.join(', ')); process.exit(1) } console.log('lint ok')\n"

// 1. A real fix with a real test, one boundary left untested, and a weak test.
{
  const p = await project({ 'package.json': PKG, 'lint.mjs': LINT, 'src/cart.mjs': 'export const free = (t) => false\nexport const valid = (a, b) => true\n' })
  await p.write('src/cart.mjs', 'export const free = (t) => t >= 50\nexport const valid = (a, b) => a > 0 && b > 0\n')
  await p.write('test/cart.test.mjs', "import test from 'node:test'; import assert from 'node:assert'; import { free, valid } from '../src/cart.mjs'\n" +
    "test('free', () => { assert.equal(free(60), true); assert.equal(free(10), false) })\n" +
    "test('valid', () => { assert.equal(valid(1, 1), true); assert.equal(valid(0, 1), false); assert.equal(valid(1, 0), false) })\n")
  await p.write('test/weak.test.mjs', "import test from 'node:test'; import assert from 'node:assert'; test('weak', () => assert.equal(1, 1))\n")
  const checks = await detectChecks(p.wt)
  ok(checks.lint === 'npm run lint' && checks.tests === 'npm run test' && !!checks.testFiles && checks.why.includes('node --test'),
     `the project's own lint and test scripts, and its runner, are detected (${JSON.stringify({ lint: checks.lint, tests: checks.tests, why: checks.why })})`)
  const before = sh(p.wt, 'status', '--porcelain')
  const r = await runQuality({ worktree: p.wt, base: 'main', checks })
  ok(r.ok && r.checks.every((c) => c.ok) && r.checks.map((c) => c.name).join() === 'lint,tests', `lint and the related tests pass (${qualitySummary(r)})`)
  const cart = r.proof?.tests.find((t) => t.file === 'test/cart.test.mjs')
  const weak = r.proof?.tests.find((t) => t.file === 'test/weak.test.mjs')
  ok(cart?.failsBefore === true && cart.passesAfter === true, 'the real test is PROVEN: it fails on the base branch and passes on the change')
  ok(weak?.failsBefore === false, 'a test that passes WITHOUT the change is shown as not testing it')
  ok(!!r.mutation && r.mutation.total >= 3, `the changed lines are mutated (${r.mutation?.total})`)
  ok(r.mutation!.survivors.some((s) => s.line === 1 && s.from === '>=' && s.to === '>'), `the untested boundary (>= 50 vs > 50) SURVIVES and is named (${JSON.stringify(r.mutation!.survivors)})`)
  ok(!r.mutation!.survivors.some((s) => s.line === 2 && s.from === '&&'), 'a behaviour the tests do pin down is caught')
  ok(sh(p.wt, 'status', '--porcelain') === before && (await fs.readFile(path.join(p.wt, 'src/cart.mjs'), 'utf8')).includes('t >= 50'),
     'the agent\'s worktree is exactly as it was — mutants ran in a sandbox')
  ok(!sh(p.root, 'worktree', 'list').includes('ak-check-'), 'and every sandbox was removed')
  const text = qualityText(r)
  ok(/NOT caught: src\/cart\.mjs:1 `>=` → `>`/.test(text) && /PASSES without the change/.test(text) && /Do NOT weaken/.test(text),
     'the text for the agent names the survivor and the weak test, and says not to game the tests')
  const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
  ok(canon(parseQuality(JSON.parse(JSON.stringify(r)))) === canon(r), 'the report survives a store round trip unchanged')
}

// 2. Pre-existing vs introduced.
{
  const p = await project({ 'package.json': PKG, 'lint.mjs': LINT, 'src/old.mjs': 'debugger\n', 'src/a.mjs': 'export const a = 1\n' })
  await p.write('src/a.mjs', 'export const a = 2\n')
  const r = await runQuality({ worktree: p.wt, base: 'main', checks: await detectChecks(p.wt), fast: true })
  const lint = r.checks.find((c) => c.name === 'lint')
  ok(lint?.ok === false && lint.preExisting === true && r.ok, 'a lint failure that is ALSO on the base branch is pre-existing, and not this change\'s failure')
  await p.write('src/a.mjs', 'debugger\nexport const a = 2\n')
  await fs.rm(path.join(p.wt, 'src/old.mjs'))
  const r2 = await runQuality({ worktree: p.wt, base: 'main', checks: await detectChecks(p.wt), fast: true })
  const lint2 = r2.checks.find((c) => c.name === 'lint')
  ok(lint2?.ok === false && !lint2.preExisting && !r2.ok && lint2.tail.some((l) => /debugger in a\.mjs/.test(l)), 'a failure the change INTRODUCED fails the report, with its output')
  ok(!r2.proof && !r2.mutation, 'the fast half skips the proof and the probe')
}

// 3. An existing test the change breaks, and a flaky one.
{
  const p = await project({
    'package.json': PKG, 'lint.mjs': LINT, 'src/sum.mjs': 'export const sum = (a, b) => a + b\n',
    'test/sum.test.mjs': "import test from 'node:test'; import assert from 'node:assert'; import { sum } from '../src/sum.mjs'; test('sum', () => assert.equal(sum(2, 2), 4))\n",
  })
  await p.write('src/sum.mjs', 'export const sum = (a, b) => a - b\n')
  const r = await runQuality({ worktree: p.wt, base: 'main', checks: await detectChecks(p.wt), fast: true })
  const t = r.checks.find((c) => c.name === 'tests')
  ok(t?.ok === false && !t.preExisting && !r.ok && t.command.includes('test/sum.test.mjs'), 'breaking an EXISTING related test fails the report — the regression signal')

  const marker = path.join(os.tmpdir(), `ak-flaky-${Date.now()}`)
  await p.write('src/sum.mjs', 'export const sum = (a, b) => a + b + 0\n')
  await p.write('test/sum.test.mjs', `import test from 'node:test'; import assert from 'node:assert'; import fs from 'node:fs'\n` +
    `test('flaky', () => { if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); assert.fail('first run') } })\n`)
  const r2 = await runQuality({ worktree: p.wt, base: 'main', checks: await detectChecks(p.wt), fast: true })
  const t2 = r2.checks.find((c) => c.name === 'tests')
  ok(t2?.ok === true && t2.flaky === true && r2.ok, 'a test that fails and then passes unchanged is FLAKY — not a failure, and not silently a pass')
  await fs.rm(marker, { force: true })
}

// 4. Nothing it can run: said, not passed.
{
  const p = await project({ 'README.md': '# x\n' })
  await p.write('README.md', '# y\n')
  const r = await runQuality({ worktree: p.wt, base: 'main', checks: await detectChecks(p.wt) })
  ok(r.ok && (r.skipped ?? []).some((s) => /no test suite/.test(s)) && (r.skipped ?? []).some((s) => /no lint or typecheck/.test(s)),
     'a project with no checks says what it could not check')
  const cfg = await detectChecks(p.wt, { lint: 'echo custom-lint', testFile: 'node --test {files}' })
  ok(cfg.lint === 'echo custom-lint' && cfg.testFiles!(['a b.mjs']) === "node --test 'a b.mjs'", 'the user\'s own commands win, and file names are quoted')
}

if (fails) { console.log(`${fails} failure(s)`); process.exit(1) }
console.log('PASS — the board checks the change itself: its own checks, proof of the tests, and a mutation probe')
