/* Which `claude` do we actually spawn?

   This file exists because of a crash that looked like the extension's fault and
   was not. `resolveClaudeExecutable` preferred the Agent SDK's bundled
   per-platform binary over the Claude Code on the machine — the exact opposite
   of the design, which excludes that ~190MB binary from the .vsix precisely so
   the user's own CLI is what runs.

   The bundled binary is a Bun executable, and on a stock Linux 6.8 / glibc 2.39
   box it died on startup:

       panic(main thread): Bus error at address 0xD097FD5
       oh no: Bun has crashed.

   Every agent run failed instantly with that, while `claude` on PATH — the same
   product, installed normally — worked. And whether the platform package existed
   at all depended on how `npm install` had gone, so identical source crashed on
   one checkout and ran on another. Nothing in the suite crossed this seam. */
import { resolveClaudeExecutable } from '../sdk.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const path = await import('node:path')
const { promises: fs } = await import('node:fs')

// --- the order that matters --------------------------------------------------

const resolved = await resolveClaudeExecutable()
ok(!!resolved, `a claude executable is found: ${resolved ?? '(none)'}`)

if (resolved) {
  // THE gate. Not "is something found" — the broken version found something
  // too, and it was the thing that crashed.
  ok(!resolved.includes('node_modules'),
     'the resolved claude is NOT the SDK\'s bundled binary inside node_modules')
  ok(!/claude-agent-sdk-[a-z0-9]+-[a-z0-9]+/.test(resolved),
     'and not a per-platform SDK package by any name')
}

// The gate that would have caught it, and the reason it is written this way.
//
// The old lookup ran through `createRequire(__filename)`. `__filename` does not
// exist in ESM, so under this test runner it threw and the branch was skipped —
// a unit test calling resolveClaudeExecutable() could not observe the bug at
// all. esbuild emits the extension as CJS, where `__filename` is real, so the
// branch fired in the only place that ships. So: assert on the BUILT BUNDLE,
// which is the artefact whose behaviour differed.
const dist = path.join(
  path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..'),
  'dist', 'extension.js',
)
const bundle = await fs.readFile(dist, 'utf8').catch(() => '')
ok(bundle.length > 0, 'the built bundle is there to inspect (run `npm run build` first)')
if (bundle) {
  ok(!bundle.includes('claude-agent-sdk-'),
     'the shipped bundle never names a per-platform SDK package — it cannot reach the bundled binary')
}

// And the source says the same thing, so the rule is visible where it is edited.
const src = await fs.readFile(
  path.join(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'), 'sdk.ts'),
  'utf8',
)
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
ok(!code.includes('createRequire'),
   'resolveClaudeExecutable does not resolve anything out of node_modules')

// --- the explicit setting still overrides everything -------------------------

const configured = await resolveClaudeExecutable('/definitely/not/a/real/path/claude')
ok(configured === undefined, 'an unusable configured path resolves to nothing, not a silent fallback')

if (resolved) {
  const kept = await resolveClaudeExecutable(resolved)
  ok(kept === resolved, 'a usable configured path is honoured verbatim')
}

console.log(fails ? `\n${fails} FAILURES` : '\nPASS — the CLI on the machine is what runs, not the bundled binary')
process.exit(fails ? 1 : 0)
