/* Renders the REAL webview in a real browser and writes PNGs.
 *
 * The view is HTML, CSS and vanilla JS with no type checking, so "it renders"
 * and "it looks right" are different questions. The unit test answers the first
 * by asserting on text; this answers the second by drawing it.
 *
 * It loads media/board.js and media/board.css unmodified — the same files the
 * extension ships — with VS Code's own theme variables supplied, because every
 * colour in the stylesheet is a var(--vscode-*) that resolves to nothing outside
 * the editor.
 *
 *   node test/screenshots.mjs [outDir]
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { chromium } from 'playwright'
import { repoRoot } from './harness.mjs'

const outDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'docs', 'screenshots'))
await fs.mkdir(outDir, { recursive: true })

const css = await fs.readFile(path.join(repoRoot, 'media', 'board.css'), 'utf8')
const js = await fs.readFile(path.join(repoRoot, 'media', 'board.js'), 'utf8')

/** VS Code's Dark Modern, the default theme. Only the variables board.css uses. */
const DARK = {
  'font-family': '-apple-system, "Segoe UI", Ubuntu, "Droid Sans", sans-serif',
  'font-size': '13px',
  foreground: '#cccccc',
  'editor-background': '#1f1f1f',
  'editorWidget-background': '#202020',
  'widget-border': '#313131',
  'focusBorder': '#0078d4',
  'list-hoverBackground': '#2a2d2e',
  'menu-selectionBackground': '#04395e',
  'button-background': '#0078d4',
  'button-foreground': '#ffffff',
  'button-hoverBackground': '#026ec1',
  'input-background': '#313131',
  'input-foreground': '#cccccc',
  'input-border': '#3c3c3c',
  'charts-green': '#89d185',
  'charts-blue': '#3794ff',
  'charts-yellow': '#cca700',
  'charts-red': '#f14c4c',
  'charts-purple': '#b180d7',
  'editor-font-family': 'ui-monospace, "SF Mono", Menlo, monospace',
  'scrollbarSlider-background': '#4f4f4f66',
}
const vars = Object.entries(DARK).map(([k, v]) => `--vscode-${k}: ${v};`).join('\n  ')

const page_ = (layout, state) => `<!DOCTYPE html>
<html lang="en" data-layout="${layout}">
<head><meta charset="utf-8">
<style>:root { ${vars} }</style>
<style>${css}</style>
</head>
<body><div id="root"></div>
<script>
  window.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} })
</script>
<script>${js}</script>
<script>
  window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state: ${JSON.stringify(state)} } }))
</script>
</body></html>`

// ---------------------------------------------------------------- the states

const COLUMNS = [
  { id: 'backlog', name: 'Backlog', category: 'backlog' },
  { id: 'planning', name: 'Planning', category: 'unstarted' },
  { id: 'implementing', name: 'Implementing', category: 'started' },
  { id: 'validating', name: 'Validating', category: 'review' },
  { id: 'complete', name: 'Complete', category: 'done', humanOnly: true },
]
const COMPOSER = {
  model: 'claude-opus-5', effort: 'high', thinking: 'enabled',
  models: [
    { id: 'claude-opus-5', label: 'Opus 5', context: '1M' },
    { id: 'claude-sonnet-5', label: 'Sonnet 5', context: '1M' },
  ],
  efforts: [{ key: 'low', label: 'Low' }, { key: 'medium', label: 'Medium' }, { key: 'high', label: 'High' }, { key: 'max', label: 'Max' }],
  // The two readouts on the right of the bar. Both are shown because both are
  // now properties of the SESSION rather than of a running process — a
  // screenshot with an empty corner there documents the bug, not the feature.
  contextTokens: 223_000, contextWindow: 1_000_000,
  meter: { kind: 'usd', spentUsd: 8.11, priced: true },
  // The host's dictation gate answered: built-in available. The mic is drawn,
  // and a screenshot without it would document an absent feature.
  voice: { available: true, mode: 'builtin', recording: false },
}
const now = Date.now()
const mins = (n) => now - n * 60_000

const PLAN = {
  summary: 'Adds subtract() and multiply() to calc.js, both exported.',
  steps: [
    'Run the unit tests — they cover both new functions.',
    'Open calc.js and check the exports at the bottom.',
    'Start the dev server and try /calc?op=subtract&a=5&b=3.',
  ],
  links: [
    { label: 'calc.js', target: 'calc.js', kind: 'file' },
    { label: 'calc.test.js', target: 'test/calc.test.js', kind: 'file' },
    { label: 'Run the tests', target: 'npm test -- calc', kind: 'command' },
    { label: 'Dev server', target: 'http://localhost:3000/calc', kind: 'url' },
  ],
  at: mins(2),
}

const CARDS = [
  { key: 's-1', sessionId: 's-1', title: 'Rate-limit the public API', phase: 'backlog', tags: ['api'], updated: mins(180) },
  {
    key: 's-2', sessionId: 's-2', title: 'Work out the caching strategy', phase: 'planning',
    tags: ['perf'], updated: mins(12), branch: 'task/S4-caching', worktree: '/w/s4',
    agent: { kind: 'working', tool: 'Grep', contextTokens: 41_000, contextWindow: 1_000_000 },
  },
  {
    key: 's-3', sessionId: 's-3', title: 'Add subtract and multiply to calc.js', phase: 'implementing',
    tags: ['math', 'api'], updated: mins(1), branch: 'task/S1-add-subtract', worktree: '/w/s1',
    agent: { kind: 'working', tool: 'Edit', contextTokens: 82_000, contextWindow: 1_000_000, costUsd: 0.03 },
  },
  {
    key: 's-4', sessionId: 's-4', title: 'Fix the login redirect loop', phase: 'implementing',
    tags: ['auth', 'bug'], updated: mins(3), branch: 'task/S2-login', worktree: '/w/s2',
    agent: {
      kind: 'needsInput', contextTokens: 55_000, contextWindow: 1_000_000,
      pendingPermission: { id: 'p1', summary: 'Bash — npm install jsonwebtoken' },
    },
  },
  {
    key: 's-5', sessionId: 's-5', title: 'Migrate the session store to SQLite', phase: 'validating',
    tags: ['db'], updated: mins(6), branch: 'task/S3-sqlite', worktree: '/w/s3', testPlan: PLAN,
    agent: { kind: 'done', contextTokens: 120_000, contextWindow: 1_000_000, costUsd: 0.42 },
  },
  {
    key: 's-6', sessionId: 's-6', title: 'Upgrade the build to esbuild 0.24', phase: 'validating',
    tags: ['build'], updated: mins(9), branch: 'task/S5-esbuild', worktree: '/w/s5', testPlan: PLAN,
    agent: { kind: 'done', contextTokens: 60_000, contextWindow: 1_000_000, costUsd: 0.11 },
  },
  { key: 's-7', sessionId: 's-7', title: 'Document the worktree lifecycle', phase: 'complete', tags: ['docs'], updated: mins(600) },
]

const REVIEW = {
  base: 'main', ahead: 2, dirty: 1,
  files: [
    { path: 'calc.js', status: 'M', committed: true },
    { path: 'test/calc.test.js', status: 'A', committed: true },
    { path: 'README.md', status: 'M', committed: false },
  ],
  lastCommit: { sha: 'fb90500', message: 'Add subtract and multiply' },
}

const kanban = { ready: true, mode: 'kanban', columns: COLUMNS, cards: CARDS, composer: COMPOSER, running: 2, waiting: 1 }
const chatCard = CARDS[4]
const chat = {
  ...kanban, mode: 'chat', selectedKey: chatCard.key, review: REVIEW,
  transcript: [
    { kind: 'prompt', at: mins(9), text: 'Add subtract and multiply to calc.js, with tests. Move to validating when done.' },
    { kind: 'thinking', at: mins(9), text: 'calc.js exports a single add(). I will follow the same shape.' },
    { kind: 'text', at: mins(8), text: "I'll add both functions alongside `add`, keeping the same export style." },
    { kind: 'tool', at: mins(8), id: '1', name: 'Read', summary: 'Read  calc.js', status: 'ok' },
    { kind: 'tool', at: mins(8), id: '2', name: 'Edit', summary: 'Edit  calc.js', status: 'ok' },
    { kind: 'tool', at: mins(7), id: '3', name: 'Bash', summary: 'Bash  npm test -- calc', status: 'ok' },
    { kind: 'phase', at: mins(6), from: 'implementing', to: 'validating' },
    { kind: 'text', at: mins(6), text: 'Both functions are in and the tests pass. Moved to validating for you to check.' },
    { kind: 'result', at: mins(6), summary: 'done', durationMs: 143_000, costUsd: 0.42 },
  ],
}
const permission = {
  ...kanban, mode: 'chat', selectedKey: 's-4',
  transcript: [
    { kind: 'prompt', at: mins(4), text: 'Fix the login redirect loop.' },
    { kind: 'text', at: mins(3), text: 'The redirect loops because the JWT is never verified. I need the jsonwebtoken package.' },
    { kind: 'tool', at: mins(3), id: '1', name: 'Read', summary: 'Read  src/auth/session.ts', status: 'ok' },
  ],
}
const empty = { ready: true, mode: 'kanban', columns: COLUMNS, cards: [], composer: COMPOSER, running: 0, waiting: 0 }

// The interaction surface: a notice from notify_user, follow-ups still pending
// behind the current turn, and Interrupt alongside Stop.
const interacting = {
  ...kanban, mode: 'chat', selectedKey: 's-4',
  cards: CARDS.map((c) => c.key === 's-4'
    ? { ...c, queued: ['also add a test for the expired-token case', 'then update the README'],
        agent: { kind: 'working', tool: 'Edit', contextTokens: 55_000, contextWindow: 1_000_000 } }
    : c),
  transcript: [
    { kind: 'prompt', at: mins(5), text: 'Fix the login redirect loop.' },
    { kind: 'text', at: mins(4), text: 'The redirect loops because the JWT is never verified.' },
    { kind: 'tool', at: mins(4), id: '1', name: 'Read', summary: 'Read  src/auth/session.ts', status: 'ok' },
    { kind: 'notice', at: mins(3), urgency: 'blocked', message: 'Which auth provider should I verify against — Auth0 or the in-house issuer?' },
    { kind: 'tool', at: mins(2), id: '2', name: 'Edit', summary: 'Edit  src/auth/session.ts', status: 'running' },
  ],
}

// An AskUserQuestion, which is a different thing from a permission request: the
// agent is not asking to DO something, it is asking the user to decide
// something. Worth its own shot, because for a long time it rendered as an
// Allow/Deny prompt with the question missing entirely.
const asking = {
  ...kanban, mode: 'chat', selectedKey: 's-4',
  cards: CARDS.map((c) => c.key === 's-4'
    ? {
        ...c,
        agent: {
          kind: 'needsInput', contextTokens: 55_000, contextWindow: 1_000_000,
          pendingPermission: {
            id: 'q1', summary: 'AskUserQuestion',
            questions: [
              {
                question: 'The redirect loop is in the token refresh. Which way should I fix it?',
                header: 'Approach', multiSelect: false,
                options: [
                  { label: 'Verify the JWT signature', description: 'Correct fix. Needs the jsonwebtoken package.' },
                  { label: 'Cap the redirects at 3', description: 'Stops the loop without addressing why it happens.' },
                  { label: 'Drop the refresh entirely', description: 'Users get logged out every hour.' },
                ],
              },
              {
                question: 'Which cases should the tests cover?',
                header: 'Tests', multiSelect: true,
                options: [
                  { label: 'Expired token' },
                  { label: 'Tampered signature' },
                  { label: 'Missing cookie' },
                ],
              },
            ],
          },
        },
      }
    : c),
  transcript: [
    { kind: 'prompt', at: mins(5), text: 'Fix the login redirect loop.' },
    { kind: 'tool', at: mins(4), id: '1', name: 'Read', summary: 'Read  src/auth/session.ts', status: 'ok' },
    { kind: 'text', at: mins(4), text: 'The loop is in the token refresh — it redirects on every failed verify. There are a few ways to go about this.' },
  ],
}

const SHOTS = [
  ['01-kanban-board', 'full', kanban, { width: 1440, height: 900 }],
  ['02-chat-with-test-plan', 'full', chat, { width: 1440, height: 980 }],
  ['03-permission-prompt', 'full', permission, { width: 1440, height: 900 }],
  ['05-empty-board', 'full', empty, { width: 1440, height: 700 }],
  ['06-no-folder', 'full', { ...empty, ready: false, noWorkspace: true }, { width: 1440, height: 500 }],
  ['04-narrow-board', 'full', kanban, { width: 1100, height: 760 }],
  ['07-notice-and-queue', 'full', interacting, { width: 1440, height: 820 }],
  // What "focus mode" buys: the same board with the bottom and right panels gone.
  ['08-full-window', 'full', { ...kanban, focused: true }, { width: 1920, height: 1000 }],
  // The side bar control: status and a toggle, deliberately not a board.
  ['09-sidebar-control', 'control', { ...kanban, boardOpen: true }, { width: 360, height: 620 }],
  ['10-asking-a-question', 'full', asking, { width: 1440, height: 900 }],
]

// Prefer the environment's pre-installed Chromium; fall back to whatever
// Playwright resolves. Never download one — the sandbox blocks it.
async function launch() {
  const { promises: fsp } = await import('node:fs')
  const { homedir } = await import('node:os')
  // The same cache scan layout.test.mjs uses: playwright's own cache may hold
  // a NEWER Chromium than the version this checkout's playwright wants, and
  // refusing to use it would mean `npm run screenshots` fails until a fresh
  // ~170MB download — when any Chromium can take a screenshot.
  const cacheRoots = [
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? [process.env.PLAYWRIGHT_BROWSERS_PATH] : []),
    path.join(homedir(), '.cache', 'ms-playwright'),
  ]
  const cached = []
  for (const cache of cacheRoots) {
    const dirs = await fsp.readdir(cache).catch(() => [])
    const builds = dirs
      .filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
      .sort((a, b) => Number(b.match(/\d+$/)[0]) - Number(a.match(/\d+$/)[0]))
    for (const d of builds) {
      for (const rel of [['chrome-linux', 'headless_shell'], ['chrome-linux', 'chrome'],
                         ['chrome-linux64', 'chrome']]) {
        cached.push(path.join(cache, d, ...rel))
      }
    }
  }
  for (const p of [
    process.env.CHROMIUM_PATH,
    ...cached,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ].filter(Boolean)) {
    if (await fsp.access(p).then(() => true, () => false)) {
      return chromium.launch({ executablePath: p, args: ['--no-sandbox'] })
    }
  }
  return chromium.launch({ args: ['--no-sandbox'] })
}
const browser = await launch()
let failed = 0
for (const [name, layout, state, viewport] of SHOTS) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2, colorScheme: 'dark' })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.setContent(page_(layout, state), { waitUntil: 'load' })
  await page.waitForTimeout(120)
  const file = path.join(outDir, `${name}.png`)
  await page.screenshot({ path: file })
  // A blank page is the failure this whole project keeps hitting, so check.
  const text = (await page.locator('#root').innerText()).trim()
  const status = errors.length ? `FAIL (${errors[0].slice(0, 90)})` : text.length < 20 ? 'FAIL (blank)' : 'ok'
  if (status !== 'ok') failed++
  console.log(`  ${status.padEnd(6)} ${name}.png  ${viewport.width}x${viewport.height}  ${text.length} chars of text`)
  await page.close()
}
await browser.close()
console.log(failed ? `\n${failed} screenshot(s) failed` : `\nPASS — ${SHOTS.length} screenshots written to ${outDir}`)
process.exit(failed ? 1 : 0)
