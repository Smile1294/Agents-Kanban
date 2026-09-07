/* The board outside VS Code: does anything supply the theme?
 *
 * Every colour in `media/board.css` is `var(--vscode-*)`. Inside the editor VS
 * Code sets each of those variables inline on `<html>`, so the stylesheet never
 * has to know a single hex value. Outside the editor nothing does — and the
 * headless board (`server/server.mjs`) served exactly that: `var()` after `var()`
 * resolving to nothing, which a browser paints as a WHITE page with black text.
 * Reported as "the remote is fully white".
 *
 * `media/theme.css` is the fallback: the Dark Modern palette, one declaration
 * per variable, loaded before the app stylesheets on every page the server
 * renders and by the screenshot renderer. It is inert in the editor, because
 * an inline style outranks a stylesheet. This gate keeps it COMPLETE — a
 * variable used by a stylesheet and missing from the fallback is one control
 * that renders unthemed in the browser, and nothing else would notice.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..')
let fails = 0
const ok = (c, m) => { console.log(c ? '  ok:' : 'FAIL:', m); if (!c) fails++ }
const read = (rel) => fs.readFile(path.join(repoRoot, rel), 'utf8').catch(() => '')

const theme = await read('media/theme.css')
ok(theme.length > 0, 'media/theme.css exists — the fallback palette for the browser')

// Every variable any stylesheet or view script reaches for. The scripts count
// because board.js sets a few colours inline.
const sources = ['media/board.css', 'media/settings.css', 'media/board.js', 'media/settings.js', 'server/bridge.css']
const used = new Set()
for (const rel of sources) {
  for (const m of (await read(rel)).matchAll(/var\(\s*(--vscode-[A-Za-z0-9-]+)/g)) used.add(m[1])
}
ok(used.size > 30, `the stylesheets use a real number of theme variables (${used.size})`)

const defined = new Set([...theme.matchAll(/(--vscode-[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]))
const missing = [...used].filter((v) => !defined.has(v)).sort()
ok(missing.length === 0,
   `every variable the stylesheets use is defined by the fallback (missing: ${missing.join(', ') || 'none'})`)

// The declarations live on `:root`, where the editor's inline values outrank
// them — anywhere else (say, `html.dark`) the fallback would need the page to
// know to opt in, and the bug was precisely a page that supplied nothing.
ok(/:root\s*\{/.test(theme), 'the palette is declared on :root, so it needs no opt-in and loses to the editor\'s inline values')
ok(/color-scheme\s*:\s*dark/.test(theme), 'and it declares color-scheme: dark, so native controls and scrollbars follow')

// The two places that render the board outside the editor must load it, in
// front of the app stylesheets. A palette nobody loads fixes nothing. Asserted
// on the DOCUMENT the server actually sends, not on the server's source.
const { pageHtml } = await import(new URL('../../../server/page.mjs', import.meta.url))
for (const which of ['board', 'settings']) {
  const html = pageHtml(which)
  const themeAt = html.indexOf('/media/theme.css')
  ok(themeAt >= 0, `the headless ${which} page loads theme.css`)
  ok(themeAt >= 0 && themeAt < html.indexOf('/media/board.css'),
     `and loads it BEFORE board.css, so the variables exist when board.css reads them (${which})`)
  ok(/<meta name="color-scheme" content="dark">/.test(html),
     `and tells the browser the ${which} page is dark before the first paint`)
}
const shots = await read('test/screenshots.mjs')
ok(shots.includes('theme.css'), 'the screenshot renderer uses the same palette rather than a private copy')

console.log(fails ? `\n${fails} FAILURES` : '\nPASS — the board carries its own dark theme outside the editor')
process.exit(fails ? 1 : 0)
