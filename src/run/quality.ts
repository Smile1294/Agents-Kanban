/**
 * The board's QUALITY checks of a change — independent of the agent that made
 * it.
 *
 * Asked for as "features that really prove the acceptance rate of code and
 * fewer bugs — proper testing". The research (September 2026, see
 * docs/HARNESS-REVIEW.md §4e) is unusually clear about what does and does not
 * move that:
 *
 *  - Tests the agent writes for its OWN fix barely help. Claude Opus 4.5 wrote
 *    a test in ~83% of SWE-bench tasks and resolved 2.6 points more than a
 *    model that almost never did; suppressing tests changed 16.8% of outcomes.
 *    When one trajectory writes both the patch and the test their errors
 *    AGREE ("ExecCritic"), and refining until the test passes INCREASES
 *    overfitting ("Investigating Test Overfitting on SWE-bench").
 *  - What helps is execution the agent does not steer: the project's EXISTING
 *    tests (+8–13% resolution, "Can Old Tests Do New Tricks"), CI (each
 *    failing check cuts merge odds ~15% on agentic PRs), static analysis fed
 *    back (security findings >40% → 13%), a reproduction test PROVEN to fail
 *    before the fix and pass after (+8 points, SWE-Doctor/SWT-Bench), and
 *    mutation-guided testing (Meta ACH: engineers accepted 73% of its tests).
 *
 * So this runs, host-side:
 *
 *  1. the project's own lint and typecheck, and the tests RELATED to the
 *     change (or the whole suite when it cannot tell) — a failure is re-run
 *     once (a pass then is `flaky`), and checked on the BASE branch, so one
 *     that fails there too is `preExisting` and not blamed on this change;
 *  2. the PROOF: every new or changed test file, run on the base branch with
 *     only the tests copied in, must FAIL there and PASS on the branch —
 *     computed by the board, never claimed by the agent;
 *  3. the MUTATION probe: the changed source lines, deliberately broken one at
 *     a time (`>`→`>=`, `&&`→`||`, `true`→`false`…) against the tests that
 *     cover them. A survivor is a behaviour no test pins down, named by file,
 *     line and edit — the concrete thing to test next;
 *  4. the diff's size, because larger agentic PRs are merged less.
 *
 * `ok` is (1) only. (2) and (3) are evidence about the tests, drawn with their
 * numbers: a refactor's tests correctly pass before and after, and a number an
 * agent is refused on is a number it learns to game.
 *
 * The base branch and the mutants run in SANDBOXES — throwaway `git worktree`s
 * under the OS temp directory with the card's dependency folders symlinked in
 * — so neither the agent's worktree nor the user's checkout is ever touched.
 *
 * Plain Node; no vscode.
 */
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { killTree } from './app.ts'
import type { QualityCheck, QualityReport } from '../sessions/meta.ts'

const exec = promisify(execFile)

// ---------------------------------------------------------------------------
// What the project runs
// ---------------------------------------------------------------------------

/** `agentsKanban.checks`: the user's own commands, which win over detection.
 *  `testFile` runs chosen test files: `{files}` is replaced with them. */
export interface ChecksConfig {
  lint?: string
  typecheck?: string
  test?: string
  testFile?: string
}

export interface ProjectChecks {
  lint?: string
  typecheck?: string
  /** The whole suite. */
  tests?: string
  /** How to run SOME test files, or undefined when this runner is unknown —
   *  and then there is no proof and no mutation probe, and the report says so. */
  testFiles?: (files: string[]) => string
  /** What was detected, one line each, for the report. */
  why: string[]
}

const q = (f: string) => (/^[\w@%+=:,./-]+$/.test(f) ? f : `'${f.replace(/'/g, `'\\''`)}'`)
const exists = (p: string) => fs.access(p).then(() => true, () => false)
async function readJson(p: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as Record<string, unknown> } catch { return undefined }
}

/** The npm placeholder `npm init` writes, which is not a test suite. */
const PLACEHOLDER_TEST = /no test specified/

export async function detectChecks(dir: string, cfg: ChecksConfig = {}): Promise<ProjectChecks> {
  const out: ProjectChecks = { why: [] }
  const pkg = await readJson(path.join(dir, 'package.json'))
  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    const deps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) } as Record<string, unknown>
    const pm = await exists(path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm run'
      : await exists(path.join(dir, 'yarn.lock')) ? 'yarn'
      : await exists(path.join(dir, 'bun.lockb')) || await exists(path.join(dir, 'bun.lock')) ? 'bun run' : 'npm run'
    const pick = (names: string[]) => names.find((n) => typeof scripts[n] === 'string' && scripts[n]!.trim())
    const lint = pick(['lint', 'lint:check', 'eslint'])
    const typecheck = pick(['typecheck', 'type-check', 'check-types', 'types', 'tsc'])
    const test = pick(['test:unit', 'test'])
    if (lint) out.lint = `${pm} ${lint}`
    if (typecheck) out.typecheck = `${pm} ${typecheck}`
    if (test && !PLACEHOLDER_TEST.test(scripts[test]!)) out.tests = `${pm} ${test}`
    const bin = async (name: string) => (await exists(path.join(dir, 'node_modules', '.bin', name)) ? `node_modules/.bin/${name}` : `npx --no-install ${name}`)
    const testScript = test ? scripts[test]! : ''
    if ('vitest' in deps || /\bvitest\b/.test(testScript)) {
      const b = await bin('vitest'); out.testFiles = (f) => `${b} run ${f.map(q).join(' ')}`; out.why.push('vitest')
    } else if ('jest' in deps || /\bjest\b/.test(testScript)) {
      const b = await bin('jest'); out.testFiles = (f) => `${b} ${f.map(q).join(' ')}`; out.why.push('jest')
    } else if ('mocha' in deps || /\bmocha\b/.test(testScript)) {
      const b = await bin('mocha'); out.testFiles = (f) => `${b} ${f.map(q).join(' ')}`; out.why.push('mocha')
    } else if (/\bnode\b[^&|;]*--test\b/.test(testScript)) {
      out.testFiles = (f) => `node ${f.some((x) => /\.[cm]?ts$/.test(x)) ? '--experimental-strip-types --no-warnings ' : ''}--test ${f.map(q).join(' ')}`
      out.why.push('node --test')
    }
  }
  const composer = await readJson(path.join(dir, 'composer.json'))
  if (composer) {
    const dev = { ...(composer.require as object ?? {}), ...(composer['require-dev'] as object ?? {}) } as Record<string, unknown>
    if (!out.lint && 'laravel/pint' in dev) out.lint = 'vendor/bin/pint --test'
    if (!out.typecheck && ('phpstan/phpstan' in dev || 'larastan/larastan' in dev || 'nunomaduro/larastan' in dev)) out.typecheck = 'vendor/bin/phpstan analyse --no-progress'
    const artisan = await exists(path.join(dir, 'artisan'))
    if (!out.tests) out.tests = artisan ? 'php artisan test' : 'pestphp/pest' in dev ? 'vendor/bin/pest' : 'phpunit/phpunit' in dev ? 'vendor/bin/phpunit' : undefined
    if (!out.testFiles && out.tests) {
      const runner = out.tests
      out.testFiles = (f) => `${runner} ${f.map(q).join(' ')}`
      out.why.push(runner.split(' ').slice(-1)[0] === 'test' ? 'artisan test' : runner)
    }
  }
  const pyproject = await fs.readFile(path.join(dir, 'pyproject.toml'), 'utf8').catch(() => '')
  const reqs = await fs.readFile(path.join(dir, 'requirements-dev.txt'), 'utf8').catch(() => '') +
    await fs.readFile(path.join(dir, 'requirements.txt'), 'utf8').catch(() => '')
  if (pyproject || reqs) {
    const py = pyproject + reqs
    if (!out.lint && /\bruff\b/.test(py)) out.lint = 'ruff check .'
    if (!out.typecheck && /\bmypy\b/.test(py)) out.typecheck = 'mypy .'
    if (!out.tests && /\bpytest\b/.test(py)) {
      out.tests = 'python -m pytest -q'
      out.testFiles = (f) => `python -m pytest -q ${f.map(q).join(' ')}`
      out.why.push('pytest')
    }
  }
  if (await exists(path.join(dir, 'go.mod'))) {
    out.lint ??= 'go vet ./...'
    out.tests ??= 'go test ./...'
    out.testFiles ??= (f) => `go test ${[...new Set(f.map((x) => `./${path.posix.dirname(x)}`))].join(' ')}`
    out.why.push('go test')
  }
  // The user's own commands last, so they win.
  if (cfg.lint) out.lint = cfg.lint
  if (cfg.typecheck) out.typecheck = cfg.typecheck
  if (cfg.test) out.tests = cfg.test
  if (cfg.testFile) {
    const t = cfg.testFile
    out.testFiles = (f) => t.replace('{files}', f.map(q).join(' '))
    out.why.push('agentsKanban.checks.testFile')
  }
  return out
}

// ---------------------------------------------------------------------------
// Which tests
// ---------------------------------------------------------------------------

export function isTestFile(f: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)\//.test(f) || /[._-](test|spec)\.[cm]?[jt]sx?$/.test(f) ||
    /(^|\/)test_[^/]+\.py$|_test\.(py|go)$|Test\.php$/.test(f)
}

/** A file's name with its extension and test affixes removed: `cart`. */
export function stemOf(f: string): string {
  return path.posix.basename(f).replace(/\.[^.]+$/, '').replace(/\.(test|spec)$/, '').replace(/[._-](test|spec)$/, '')
    .replace(/^test_/, '').replace(/_test$/, '').replace(/Test$/, '').toLowerCase()
}

/**
 * The tests the change is about: the test files it touched, plus every test
 * whose stem is a changed source file's stem (`cart.ts` → `cart.test.ts`,
 * `tests/test_cart.py`, `CartTest.php`). By name, deliberately: import graphs
 * are per language, and a wrong guess only costs running one more file.
 */
export function relatedTests(changed: readonly string[], all: readonly string[]): string[] {
  const tests = all.filter(isTestFile)
  const stems = new Set(changed.filter((f) => !isTestFile(f)).map(stemOf).filter((s) => s.length >= 3))
  const out = new Set(changed.filter(isTestFile).filter((f) => all.includes(f)))
  for (const t of tests) if (stems.has(stemOf(t))) out.add(t)
  return [...out].sort()
}

// ---------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------

export interface RunResult { ok: boolean; tail: string[]; durationMs: number; timedOut?: boolean }

export function runCommand(cwd: string, command: string, timeoutMs: number, tailLines = 30): Promise<RunResult> {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const lines: string[] = []
    const child = spawn(command, {
      cwd, shell: true, detached: process.platform !== 'win32',
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const push = (c: Buffer) => {
      for (const l of c.toString().split(/\r?\n/)) if (l.trim()) lines.push(l.replace(/\x1b\[[0-9;]*m/g, ''))
      if (lines.length > 600) lines.splice(0, lines.length - 600)
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; void killTree(child) }, timeoutMs)
    child.on('error', (e) => lines.push(e.message))
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && !timedOut, tail: lines.slice(-tailLines), durationMs: Date.now() - t0, ...(timedOut ? { timedOut: true } : {}) })
    })
  })
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout
}

/** Folders a checkout needs and git does not carry, linked from the card. */
const DEP_DIRS = ['node_modules', 'vendor', '.venv', 'venv']

/**
 * A throwaway checkout of `ref`, with `overlay` files copied in from the
 * card's worktree (deleted there = deleted here) and its dependency folders
 * linked, so it runs without an install. Under the OS temp directory, never
 * inside the user's repository.
 */
export async function sandbox(worktree: string, ref: string, overlay: readonly string[]): Promise<{ dir: string; dispose(): Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ak-check-'))
  await git(worktree, ['worktree', 'add', '--detach', '--force', dir, ref])
  const dispose = async () => {
    await git(worktree, ['worktree', 'remove', '--force', dir]).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    await git(worktree, ['worktree', 'prune']).catch(() => {})
  }
  try {
    for (const f of overlay) {
      const from = path.join(worktree, f), to = path.join(dir, f)
      if (await exists(from)) {
        await fs.mkdir(path.dirname(to), { recursive: true })
        await fs.copyFile(from, to)
      } else {
        await fs.rm(to, { force: true })
      }
    }
    for (const d of DEP_DIRS) {
      const from = path.join(worktree, d), to = path.join(dir, d)
      if (await exists(from) && !(await exists(to))) await fs.symlink(from, to, process.platform === 'win32' ? 'junction' : 'dir')
    }
    for (const env of ['.env', '.env.testing']) {
      const from = path.join(worktree, env), to = path.join(dir, env)
      if (await exists(from) && !(await exists(to))) await fs.copyFile(from, to)
    }
  } catch (e) {
    await dispose()
    throw e
  }
  return { dir, dispose }
}

/**
 * Failure output that is NEW on the branch and names a file this change
 * touched. The exit code alone cannot tell "the same lint error as on main"
 * from "a new one in the file you edited, beside an old one elsewhere" — both
 * are exit 1 on both sides — and calling the second pre-existing is blaming
 * main for the agent's bug. Lines are compared with numbers and checkout paths
 * blanked, so durations and line counts do not make every line look new.
 */
export function introducedLines(branch: readonly string[], base: readonly string[], changed: readonly string[], roots: readonly string[]): string[] {
  const norm = (l: string) => roots.reduce((x, r) => x.split(r).join('<root>'), l).replace(/\d+(\.\d+)?/g, '#').trim()
  const seen = new Set(base.map(norm))
  const names = changed.map((f) => path.posix.basename(f)).filter((n) => n.length >= 3)
  return branch.filter((l) => !seen.has(norm(l)) && names.some((n) => l.includes(n)))
}

// ---------------------------------------------------------------------------
// The mutation probe
// ---------------------------------------------------------------------------

export interface Mutant { file: string; line: number; from: string; to: string; mutated: string }

/** Operators, most informative first. Each needs spaces around it, which
 *  keeps `=>`, generics and `<div>` out of reach. */
const OPERATORS: Array<[RegExp, string, string]> = [
  [/ === /, ' === ', ' !== '], [/ !== /, ' !== ', ' === '],
  [/ == /, ' == ', ' != '], [/ != /, ' != ', ' == '],
  [/ <= /, ' <= ', ' < '], [/ >= /, ' >= ', ' > '],
  [/ < /, ' < ', ' <= '], [/ > /, ' > ', ' >= '],
  [/ && /, ' && ', ' || '], [/ \|\| /, ' || ', ' && '],
  [/ and /, ' and ', ' or '], [/ or /, ' or ', ' and '],
  [/\btrue\b/, 'true', 'false'], [/\bfalse\b/, 'false', 'true'],
  [/\bTrue\b/, 'True', 'False'], [/\bFalse\b/, 'False', 'True'],
  [/ \+ (?=\d)/, ' + ', ' - '], [/ - (?=\d)/, ' - ', ' + '],
]
const MUTABLE = /\.(m?[jt]sx?|cjs|py|php|go|rb)$/
/** Lines that are not behaviour: comments, imports, bare punctuation. */
const INERT = /^\s*(\/\/|#|\*|\/\*|import\b|from\b|use\b|require\(|export\s+(type|interface)\b|\}|\)|;|$)/

/** Every single-edit mutant of the given lines. Text in quotes is left alone. */
export function mutantsFor(file: string, source: string, lines: readonly number[]): Mutant[] {
  if (!MUTABLE.test(file)) return []
  const rows = source.split('\n')
  const out: Mutant[] = []
  for (const n of lines) {
    const text = rows[n - 1]
    if (text === undefined || INERT.test(text) || text.length > 300) continue
    // Blank out string literals when searching, so `"a > b"` is not mutated.
    const code = text.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => ' '.repeat(m.length))
    for (const [re, from, to] of OPERATORS) {
      const m = re.exec(code)
      if (!m) continue
      const next: string = text.slice(0, m.index) + text.slice(m.index).replace(from, to)
      if (next === text) continue
      out.push({ file, line: n, from: from.trim(), to: to.trim(), mutated: [...rows.slice(0, n - 1), next, ...rows.slice(n)].join('\n') })
    }
  }
  return out
}

/** Lines ADDED or changed in `file` relative to `base`, from a zero-context diff. */
export async function changedLines(worktree: string, base: string, file: string): Promise<number[]> {
  const diff = await git(worktree, ['diff', '-U0', base, '--', file]).catch(() => '')
  if (!diff) {
    // Untracked: every line is new.
    const text = await fs.readFile(path.join(worktree, file), 'utf8').catch(() => '')
    return text ? text.split('\n').map((_, i) => i + 1) : []
  }
  const out: number[] = []
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2])
    for (let i = 0; i < count; i++) out.push(start + i)
  }
  return out
}

/** Pick `max` mutants spread across files and lines rather than the first
 *  `max` of one line. */
export function spread(mutants: readonly Mutant[], max: number): Mutant[] {
  const byKey = new Map<string, Mutant[]>()
  for (const m of mutants) {
    const k = `${m.file}:${m.line}`
    byKey.set(k, [...(byKey.get(k) ?? []), m])
  }
  const queues = [...byKey.values()]
  const out: Mutant[] = []
  for (let round = 0; out.length < max && queues.some((qq) => qq.length > round); round++) {
    for (const qq of queues) if (qq[round] && out.length < max) out.push(qq[round]!)
  }
  return out
}

// ---------------------------------------------------------------------------
// The whole run
// ---------------------------------------------------------------------------

export interface QualityOptions {
  worktree: string
  /** What the change is measured against: the card's base branch. */
  base: string
  checks: ProjectChecks
  /** Skip the proof and the mutation probe — the fast half, for the review
   *  gate that an agent's tool call is waiting on. */
  fast?: boolean
  /** Per command. */
  timeoutMs?: number
  mutation?: { max?: number; budgetMs?: number }
  /** Diff size past which the report calls the change large. */
  largeLines?: number
  largeFiles?: number
}

/** Past these, the report says the change is large: review quality falls,
 *  and larger agentic PRs are merged less. */
export const LARGE_LINES = 400
export const LARGE_FILES = 15

/** Never throws: anything that could not be checked is in `skipped`. */
export async function runQuality(o: QualityOptions): Promise<QualityReport> {
  const t0 = Date.now()
  const timeout = o.timeoutMs ?? 5 * 60_000
  const skipped: string[] = []
  const report: QualityReport = { ok: true, at: t0, durationMs: 0, diff: { files: 0, added: 0, removed: 0, large: false }, checks: [] }

  // What changed: committed and not, against the merge base.
  const mergeBase = (await git(o.worktree, ['merge-base', 'HEAD', o.base]).catch(() => '')).trim() || o.base
  const committed = (await git(o.worktree, ['diff', '--name-only', mergeBase]).catch(() => '')).split('\n').filter(Boolean)
  const untracked = (await git(o.worktree, ['ls-files', '--others', '--exclude-standard']).catch(() => '')).split('\n').filter(Boolean)
  const changed = [...new Set([...committed, ...untracked])].sort()
  for (const l of (await git(o.worktree, ['diff', '--numstat', mergeBase]).catch(() => '')).split('\n')) {
    const [a, r] = l.split('\t')
    if (a && a !== '-') report.diff.added += Number(a) || 0
    if (r && r !== '-') report.diff.removed += Number(r) || 0
  }
  for (const f of untracked) {
    report.diff.added += (await fs.readFile(path.join(o.worktree, f), 'utf8').catch(() => '')).split('\n').length
  }
  report.diff.files = changed.length
  report.diff.large = report.diff.added + report.diff.removed > (o.largeLines ?? LARGE_LINES) || changed.length > (o.largeFiles ?? LARGE_FILES)
  if (!changed.length) {
    report.skipped = ['nothing changed against the base branch']
    report.durationMs = Date.now() - t0
    return report
  }

  const tracked = (await git(o.worktree, ['ls-files']).catch(() => '')).split('\n').filter(Boolean)
  const all = [...new Set([...tracked, ...untracked])]
  const related = relatedTests(changed, all)

  // A base sandbox, made at most once, for every "does it fail there too?".
  let baseBox: { dir: string; dispose(): Promise<void> } | undefined
  const onBase = async () => (baseBox ??= await sandbox(o.worktree, mergeBase, []))

  try {
    // 1. The project's own checks.
    const runCheck = async (name: QualityCheck['name'], command: string) => {
      let r = await runCommand(o.worktree, command, timeout)
      const check: QualityCheck = { name, command, ok: r.ok, tail: r.ok ? r.tail.slice(-3) : r.tail, durationMs: r.durationMs, ...(r.timedOut ? { timedOut: true } : {}) }
      if (!r.ok && name === 'tests' && !r.timedOut) {
        const again = await runCommand(o.worktree, command, timeout)
        if (again.ok) { check.ok = true; check.flaky = true; r = again }
      }
      if (!check.ok) {
        // Does it fail WITHOUT this change? Then it is not this change's.
        // A test file the change added does not exist on base; the command
        // for it is only re-run there over the files that do.
        let baseCommand: string | undefined = command
        if (name === 'tests' && o.checks.testFiles && command !== o.checks.tests) {
          const onBaseFiles = related.filter((f) => tracked.includes(f) && !changed.includes(f))
          baseCommand = onBaseFiles.length ? o.checks.testFiles(onBaseFiles) : undefined
        }
        if (baseCommand) {
          try {
            const box = await onBase()
            const b = await runCommand(box.dir, baseCommand, timeout, 80)
            if (!b.ok && !introducedLines(r.tail, b.tail, changed, [o.worktree, box.dir]).length) check.preExisting = true
          } catch (e) {
            skipped.push(`could not check ${name} on the base branch: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
          }
        }
      }
      report.checks.push(check)
    }
    if (o.checks.lint) await runCheck('lint', o.checks.lint)
    if (o.checks.typecheck) await runCheck('typecheck', o.checks.typecheck)
    const testCommand = related.length && o.checks.testFiles ? o.checks.testFiles(related) : o.checks.tests
    if (testCommand) await runCheck('tests', testCommand)
    else skipped.push('no test suite found (set agentsKanban.checks.test)')
    if (!o.checks.lint && !o.checks.typecheck) skipped.push('no lint or typecheck script found')

    if (!o.fast) {
      // 2. The proof: new or changed tests must fail without the change.
      const newTests = changed.filter((f) => isTestFile(f) && all.includes(f)).slice(0, 6)
      if (newTests.length && o.checks.testFiles) {
        const proof: NonNullable<QualityReport['proof']> = { tests: [] }
        try {
          const box = await sandbox(o.worktree, mergeBase, newTests)
          try {
            for (const f of newTests) {
              const before = await runCommand(box.dir, o.checks.testFiles([f]), timeout, 10)
              const after = await runCommand(o.worktree, o.checks.testFiles([f]), timeout, 10)
              proof.tests.push({ file: f, failsBefore: !before.ok, passesAfter: after.ok })
            }
          } finally {
            await box.dispose()
          }
        } catch (e) {
          proof.note = `could not run the tests on the base branch: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`
        }
        report.proof = proof
      } else if (!newTests.length) {
        report.proof = { tests: [], note: 'the change adds or edits no test file' }
      } else {
        report.proof = { tests: [], note: 'cannot run single test files with this runner (set agentsKanban.checks.testFile)' }
      }

      // 3. The mutation probe.
      if (o.checks.testFiles) report.mutation = await mutationProbe(o, mergeBase, changed, all, timeout)
      else report.mutation = { total: 0, killed: 0, survivors: [], note: 'cannot run single test files with this runner (set agentsKanban.checks.testFile)' }
    }
  } catch (e) {
    skipped.push(`the checks stopped early: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
  } finally {
    await baseBox?.dispose()
  }

  report.ok = report.checks.every((c) => c.ok || c.preExisting)
  if (skipped.length) report.skipped = skipped
  report.durationMs = Date.now() - t0
  return report
}

async function mutationProbe(
  o: QualityOptions, mergeBase: string, changed: readonly string[], all: readonly string[], timeout: number,
): Promise<NonNullable<QualityReport['mutation']>> {
  const max = o.mutation?.max ?? 8
  const budget = o.mutation?.budgetMs ?? 4 * 60_000
  const t0 = Date.now()
  const sources = changed.filter((f) => !isTestFile(f) && MUTABLE.test(f) && all.includes(f))
  const out: NonNullable<QualityReport['mutation']> = { total: 0, killed: 0, survivors: [] }
  if (!sources.length) return { ...out, note: 'no changed source lines to probe' }
  const uncovered: string[] = []
  const candidates: Array<Mutant & { tests: string[] }> = []
  for (const f of sources) {
    const tests = relatedTests([f], all).filter((t) => all.includes(t))
    if (!tests.length) { uncovered.push(f); continue }
    const source = await fs.readFile(path.join(o.worktree, f), 'utf8').catch(() => '')
    const lines = await changedLines(o.worktree, mergeBase, f)
    for (const m of mutantsFor(f, source, lines)) candidates.push({ ...m, tests })
  }
  if (uncovered.length) out.uncovered = uncovered.slice(0, 10)
  const chosen = spread(candidates, max) as Array<Mutant & { tests: string[] }>
  if (!chosen.length) return { ...out, note: uncovered.length ? 'no test covers the changed files' : 'no changed line has an operator to mutate' }
  // The branch as it stands, uncommitted edits included, in a box of its own.
  const box = await sandbox(o.worktree, 'HEAD', changed)
  try {
    // The covering tests must pass unmutated, or every mutant is "killed".
    const allTests = [...new Set(chosen.flatMap((m) => m.tests))]
    const clean = await runCommand(box.dir, o.checks.testFiles!(allTests), timeout, 10)
    if (!clean.ok) return { ...out, note: 'the covering tests do not pass on the branch, so mutants cannot be judged' }
    const perMutant = Math.min(timeout, Math.max(20_000, clean.durationMs * 3))
    for (const m of chosen) {
      if (Date.now() - t0 > budget) { out.note = `stopped after ${out.total} of ${chosen.length} mutants (time budget)`; break }
      const file = path.join(box.dir, m.file)
      const original = await fs.readFile(file, 'utf8')
      await fs.writeFile(file, m.mutated)
      try {
        const r = await runCommand(box.dir, o.checks.testFiles!(m.tests), perMutant, 5)
        out.total++
        if (!r.ok) out.killed++
        else out.survivors.push({ file: m.file, line: m.line, from: m.from, to: m.to })
      } finally {
        await fs.writeFile(file, original)
      }
    }
  } finally {
    await box.dispose()
  }
  return out
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The report as the agent reads it — `run_checks`'s answer, and what "Send
 *  to agent" sends. Concrete enough to act on, and it says what NOT to do. */
export function qualityText(r: QualityReport): string {
  const lines: string[] = []
  lines.push(r.ok ? 'Board checks: no failure this change is responsible for.' : 'Board checks FAILED — this change breaks something:')
  for (const c of r.checks) {
    const state = c.ok ? (c.flaky ? 'passed on a re-run (FLAKY)' : 'passed') : c.preExisting ? 'fails, but ALSO on the base branch (pre-existing, not yours)' : c.timedOut ? 'TIMED OUT' : 'FAILED'
    lines.push(`- ${c.name} (\`${c.command}\`): ${state}`)
    if (!c.ok && !c.preExisting && c.tail.length) lines.push('  ```', ...c.tail.slice(-15).map((l) => `  ${l}`), '  ```')
  }
  if (r.proof) {
    if (r.proof.tests.length) {
      lines.push('- Proof that the new tests test the change (run on the base branch WITHOUT your change, then with it):')
      for (const t of r.proof.tests) {
        lines.push(`  - ${t.file}: ${t.failsBefore ? 'fails without the change ✓' : 'PASSES without the change — it does not test what changed'}; ${t.passesAfter ? 'passes with it ✓' : 'FAILS with it'}`)
      }
    } else if (r.proof.note) lines.push(`- Proof: ${r.proof.note}`)
  }
  if (r.mutation) {
    const m = r.mutation
    if (m.total) {
      lines.push(`- Mutation probe: ${m.killed} of ${m.total} deliberate breaks to your changed lines were caught by a test.`)
      for (const s of m.survivors) lines.push(`  - NOT caught: ${s.file}:${s.line} \`${s.from}\` → \`${s.to}\` — no test notices this line's behaviour changing.`)
    }
    if (m.uncovered?.length) lines.push(`- No test file matches: ${m.uncovered.join(', ')}.`)
    if (m.note) lines.push(`- Mutation probe: ${m.note}.`)
  }
  lines.push(`- Size: ${r.diff.files} file(s), +${r.diff.added} −${r.diff.removed}${r.diff.large ? ' — LARGE; keep the change to what the task needs, or split it' : ''}.`)
  for (const s of r.skipped ?? []) lines.push(`- Not checked: ${s}.`)
  if (!r.ok || r.mutation?.survivors.length || r.proof?.tests.some((t) => !t.failsBefore || !t.passesAfter)) {
    lines.push('', 'Fix real failures in the code. Add tests for what the probe says is not pinned down. ' +
      'Do NOT weaken, skip or special-case a test to make it pass, and do not edit a test only to make a failing check go green.')
  }
  return lines.join('\n')
}

/** One line for the card and the status: the numbers, never a bare ✓. */
export function qualitySummary(r: QualityReport): string {
  const bits: string[] = []
  for (const c of r.checks) bits.push(`${c.name} ${c.ok ? (c.flaky ? '✓ (flaky)' : '✓') : c.preExisting ? '✖ pre-existing' : '✖'}`)
  const proven = r.proof?.tests.filter((t) => t.failsBefore && t.passesAfter).length
  if (r.proof?.tests.length) bits.push(`${proven}/${r.proof.tests.length} new tests proven`)
  if (r.mutation?.total) bits.push(`mutants ${r.mutation.killed}/${r.mutation.total} caught`)
  return bits.join(' · ')
}
