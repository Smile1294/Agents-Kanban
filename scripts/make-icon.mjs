/** Render the Marketplace icon.
 *
 * Two icons, two jobs, and they cannot be the same file:
 *
 *  - `media/board.svg` is the ACTIVITY BAR icon. VS Code recolours it to match
 *    the theme, so it must stay a monochrome `currentColor` glyph.
 *  - `media/icon.png` is the MARKETPLACE icon. It is shown on its own, on a
 *    page we do not control, so it needs its own background and colour — and
 *    the Marketplace rejects SVG outright, so it has to be a PNG.
 *
 * Generated rather than committed by hand so the colours can be changed by
 * editing this file instead of a binary. Chromium is already a dev dependency
 * for the screenshot gate, so this costs nothing extra.
 *
 * Run: node scripts/make-icon.mjs
 */
import { chromium } from 'playwright'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(root, 'media', 'icon.png')

// The three bars of the activity-bar glyph, at descending heights: work moving
// left to right and thinning out as it goes. The last one is the accent,
// because the last column is the one only a human can reach.
const html = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; width: 128px; height: 128px; }
  .bg {
    width: 128px; height: 128px; box-sizing: border-box;
    background: linear-gradient(150deg, #1f2430 0%, #131720 100%);
    display: flex; align-items: flex-start; justify-content: center; gap: 9px;
    padding: 26px 0 0;
  }
  .bar { width: 24px; border-radius: 6px; }
  .a { height: 76px; background: #6aa9ff; }
  .b { height: 54px; background: #4d7fd6; }
  .c { height: 32px; background: #46d39a; }
</style>
<div class="bg"><div class="bar a"></div><div class="bar b"></div><div class="bar c"></div></div>`

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 128, height: 128 } })
await page.setContent(html, { waitUntil: 'load' })
await page.screenshot({ path: out })
await browser.close()
console.log(`wrote ${path.relative(root, out)}  128x128`)
