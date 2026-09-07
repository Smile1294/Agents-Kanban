/**
 * The knowledge-file gate, and the integrity of the knowledge base it reads.
 *
 * Two halves. The pure half: globs, frontmatter, and `knowledgeCheck` on made-up
 * change sets — including the refusal, because a gate that has never been seen
 * to refuse has not been tested. The integrity half runs over the REAL
 * `docs/codemap/`: every source file in the repository is owned by exactly one
 * area, every `paths:` entry matches at least one tracked file, every
 * repo-relative path a knowledge file names exists on disk, and the README
 * links every area. That is what keeps the map from rotting while every other
 * test stays green.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  CODEMAP_DIR, globToRegExp, isExempt, knowledgeCheck, loadCodemap, matchesGlob,
  ownersOf, parseAreaFile, parseFrontmatter, type CodemapArea,
} from '../codemap.ts'

let fails = 0
const ok = (cond: unknown, msg: string): void => {
  if (cond) console.log(`  ok: ${msg}`)
  else { fails++; console.log(`FAIL: ${msg}`) }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// --- globs -----------------------------------------------------------------

console.log('\n— globs')
ok(matchesGlob('src/board/*.ts', 'src/board/config.ts'), '`*` matches inside one segment')
ok(!matchesGlob('src/board/*.ts', 'src/board/__tests__/config.test.ts'), 'and not across a slash')
ok(matchesGlob('remote/**', 'remote/functions/board-core.mjs'), '`**` spans directories')
ok(matchesGlob('remote/**', 'remote/server.js'), 'including a single level')
ok(matchesGlob('src/**/index.ts', 'src/agent/runtimes/index.ts'), '`**/` in the middle spans')
ok(matchesGlob('src/**/index.ts', 'src/index.ts'), 'and may span nothing at all')
ok(matchesGlob('media/*.js', 'media/board.js') && !matchesGlob('media/*.js', 'media/board.css'), 'the extension is literal')
ok(matchesGlob('package.json', 'package.json') && !matchesGlob('package.json', 'remote/package.json'), 'a bare filename is anchored')
ok(matchesGlob('.vscode/**', '.vscode/tasks.json'), 'a dot directory is fine')
ok(globToRegExp('a.b').test('a.b') && !globToRegExp('a.b').test('axb'), 'a dot is a dot, not any character')
ok(matchesGlob('src\\git\\*.ts', 'src/git/lock.ts'), 'backslashes are normalised on both sides')

// --- exemptions --------------------------------------------------------------

console.log('\n— exemptions')
ok(isExempt('src/board/__tests__/config.test.ts'), 'a test under __tests__ is exempt')
ok(isExempt('test/package.test.mjs'), 'a *.test.mjs anywhere is exempt')
ok(isExempt('docs/codemap/board-model.md'), 'markdown is exempt — that is what lets a docs-only change through')
ok(isExempt('README.md') && isExempt('package-lock.json') && isExempt('LICENSE'), 'so are the lockfile, the licence, the readme')
ok(!isExempt('test/harness.mjs'), 'a test HELPER is not a test: harness.mjs is owned')
ok(!isExempt('smoke.mjs'), 'and neither is the launch gate')

// --- frontmatter -------------------------------------------------------------

console.log('\n— frontmatter')
const good = `---
name: board-model
description: Columns, phases and the gate
paths:
  - src/board/config.ts
  - "src/board/questions.ts"
tests:
  - src/board/__tests__/config.test.ts
last_verified: 2026-09-07
---
# Title
`
const fm = parseFrontmatter(good)
ok(fm?.name === 'board-model', 'a scalar is read')
ok(Array.isArray(fm?.paths) && fm!.paths.length === 2 && fm!.paths[1] === 'src/board/questions.ts', 'a list is read, quotes stripped')
ok(fm?.last_verified === '2026-09-07', 'a date stays a string')
ok(parseFrontmatter('# No frontmatter\n') === undefined, 'no leading --- means no frontmatter')
ok(parseFrontmatter('---\nname: x\n') === undefined, 'an unclosed block is not frontmatter')
const area = parseAreaFile('docs/codemap/board-model.md', good)
ok(area?.name === 'board-model' && area.paths.length === 2 && area.tests.length === 1, 'an area is built from it')
ok(parseAreaFile('docs/codemap/flows.md', '---\nname: flows\ndescription: d\n---\n') === undefined,
   'a file without paths: is prose, not an area')
ok(parseAreaFile('docs/codemap/x.md', '---\nname: x\npaths:\n---\n') === undefined,
   'and so is one whose paths: is empty')
const commented = parseAreaFile('docs/codemap/y.md', '---\npaths:   # the files\n  - src/a.ts  # main\n---\n')
ok(commented?.paths[0] === 'src/a.ts' && commented.name === 'y', 'trailing comments are dropped; the name falls back to the file')

// --- the check -----------------------------------------------------------------

console.log('\n— knowledgeCheck')
const areas: CodemapArea[] = [
  { file: 'docs/codemap/board-model.md', name: 'board-model', description: '', paths: ['src/board/config.ts', 'src/board/questions.ts'], tests: [] },
  { file: 'docs/codemap/webview.md', name: 'webview', description: '', paths: ['media/*.js', 'media/*.css'], tests: [] },
  { file: 'docs/codemap/remote.md', name: 'remote', description: '', paths: ['remote/**', 'src/remote/*.ts'], tests: [] },
]

{
  const v = knowledgeCheck(['src/board/config.ts'], areas)
  ok(!v.ok, 'a changed source file with an untouched area file is REFUSED')
  if (!v.ok) {
    ok(v.missing.length === 1 && v.missing[0]!.file === 'docs/codemap/board-model.md', 'the refusal names the area file')
    ok(v.missing[0]!.changed.join() === 'src/board/config.ts', 'and the source file that made it required')
    ok(v.message.includes('docs/codemap/board-model.md') && v.message.includes('Recent changes'),
       'the message says which file and what to write')
    ok(v.message.includes(`${CODEMAP_DIR}/README.md`), 'and where the rule is')
  }
}
{
  const v = knowledgeCheck(['src/board/config.ts', 'docs/codemap/board-model.md'], areas)
  ok(v.ok && v.areas.join() === 'board-model', 'the same change WITH the area file passes, naming the area')
}
{
  const v = knowledgeCheck(['media/board.js', 'src/board/config.ts', 'docs/codemap/webview.md'], areas)
  ok(!v.ok && v.missing.length === 1 && v.missing[0]!.area === 'board-model',
     'two areas changed, one file updated: only the other is missing')
}
{
  const v = knowledgeCheck(['docs/codemap/webview.md', 'README.md', 'PLAN.md'], areas)
  ok(v.ok && v.areas.length === 0, 'a docs-only change requires nothing')
}
{
  const v = knowledgeCheck(['src/board/__tests__/config.test.ts', 'test/package.test.mjs'], areas)
  ok(v.ok, 'a tests-only change requires nothing')
}
{
  const v = knowledgeCheck(['package-lock.json', 'some/unowned/file.ts'], areas)
  ok(v.ok, 'an unowned file requires nothing — the check is only as wide as the map')
}
{
  const v = knowledgeCheck(['src/board/config.ts'], [])
  ok(v.ok, 'no codemap at all means nothing is required — the extension stays generic')
}
{
  const v = knowledgeCheck(['remote\\functions\\board.mjs', './src/remote/relay.ts'], areas)
  ok(!v.ok && v.missing[0]!.changed.join(', ') === 'remote/functions/board.mjs, src/remote/relay.ts',
     'paths are normalised before matching')
}
ok(ownersOf('src/board/questions.ts', areas).length === 1, 'ownersOf finds the one owner')
ok(ownersOf('docs/codemap/board-model.md', areas).length === 0, 'and an exempt file has none')

// --- the real folder -------------------------------------------------------------

console.log('\n— docs/codemap integrity')
const real = await loadCodemap(repoRoot)
ok(real.length >= 10, `the repository's own codemap loads (${real.length} areas)`)
ok(!real.some((a) => a.file.endsWith('/README.md') || a.file.endsWith('/flows.md') || a.file.endsWith('/glossary.md')),
   'the index, the flows and the glossary are prose, not areas')

// Every tracked source file has exactly one owner. The universe is what git
// tracks under the source-bearing roots, minus the exempt, minus assets.
// Tracked AND untracked-but-not-ignored: a source file the agent just created
// must be claimable before it is `git add`ed, or the gate reads red on every
// new file until the commit.
const tracked = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' })
ok(tracked.status === 0, 'git ls-files answers (this test runs inside a checkout)')
ok(tracked.stdout.includes('src/board/codemap.ts'), 'and the universe includes files not yet committed')
const SOURCE_EXT = /\.(ts|mjs|cjs|js|css|json|toml|html|sh)$/
const universe = tracked.stdout.split('\n').map((s) => s.trim()).filter((p) =>
  p && !isExempt(p) && (SOURCE_EXT.test(p) || p === '.vscodeignore') &&
  !p.startsWith('docs/') && p !== 'package-lock.json')
ok(universe.length > 60, `the universe of owned files is real (${universe.length} files)`)
const unowned = universe.filter((p) => ownersOf(p, real).length === 0)
ok(unowned.length === 0, `every source file is owned by an area${unowned.length ? ` — unowned: ${unowned.join(', ')}` : ''}`)
const multi = universe.filter((p) => ownersOf(p, real).length > 1)
ok(multi.length === 0, `no source file has two owners${multi.length ? ` — ${multi.map((p) => `${p} (${ownersOf(p, real).map((a) => a.name).join('+')})`).join(', ')}` : ''}`)

// Every glob matches something tracked — a dead glob is a rename nobody followed.
const dead: string[] = []
for (const a of real) for (const g of a.paths) if (!universe.some((p) => matchesGlob(g, p))) dead.push(`${a.name}: ${g}`)
ok(dead.length === 0, `every paths: entry matches a tracked file${dead.length ? ` — dead: ${dead.join(', ')}` : ''}`)

// Every repo-relative path a knowledge file names exists. Backticked tokens
// that look like a path under a known root and carry an extension; globs and
// placeholders are skipped.
const stale: string[] = []
const known = /^(src|media|server|scripts|test|remote|docs)\/[\w./-]+\.[a-z]+$/
for (const name of fs.readdirSync(path.join(repoRoot, CODEMAP_DIR))) {
  if (!name.endsWith('.md')) continue
  const md = fs.readFileSync(path.join(repoRoot, CODEMAP_DIR, name), 'utf8')
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1]!.trim()
    if (!known.test(token) || /[*<>{}]/.test(token)) continue
    if (!fs.existsSync(path.join(repoRoot, token))) stale.push(`${name}: ${token}`)
  }
}
ok(stale.length === 0, `every path the map names exists${stale.length ? ` — stale: ${stale.join(', ')}` : ''}`)

// Every named test exists too.
const missingTests = real.flatMap((a) => a.tests.filter((t) => !fs.existsSync(path.join(repoRoot, t))).map((t) => `${a.name}: ${t}`))
ok(missingTests.length === 0, `every tests: entry exists${missingTests.length ? ` — ${missingTests.join(', ')}` : ''}`)

// The README indexes every area, and every area carries the sections agents
// are told to write into.
const readme = fs.readFileSync(path.join(repoRoot, CODEMAP_DIR, 'README.md'), 'utf8')
const unindexed = real.filter((a) => !readme.includes(`(${path.basename(a.file)})`)).map((a) => a.file)
ok(unindexed.length === 0, `the README links every area${unindexed.length ? ` — missing: ${unindexed.join(', ')}` : ''}`)
const REQUIRED_SECTIONS = ['## Owns', '## Files', '## How it works', '## Change recipes', '## Invariants', '## Open work', '## Recent changes']
const short = real.flatMap((a) => {
  const md = fs.readFileSync(path.join(repoRoot, a.file), 'utf8')
  return REQUIRED_SECTIONS.filter((s) => !md.includes(`\n${s}\n`)).map((s) => `${a.name} lacks ${s}`)
})
ok(short.length === 0, `every area carries the required sections${short.length ? ` — ${short.join('; ')}` : ''}`)

console.log(fails ? `\n${fails} FAILURES` : '\nPASS — the knowledge gate refuses what it should, and the map matches the tree')
process.exit(fails ? 1 : 0)
