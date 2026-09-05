/* Does the agent's answer read as an answer?

   The assistant writes markdown, and the transcript showed it raw — `##`, `**`,
   pipes for tables, and code fences as literal backticks, all in proportional
   type. The board.js renderer builds real DOM from that text, and this test
   asserts on the tree: what became a heading, what became a code block, and —
   the part that matters most — what did NOT become an element. The text is
   another program's output, so raw HTML in it must land as characters, never
   as nodes. There is no innerHTML anywhere in the renderer, and this is where
   that is checked. */
import { boardSource, findByTag, renderBoardWith, walk } from '../../../test/dom.mjs'

let fails = 0
const ok = (c, m) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const src = await boardSource()
const base = {
  ready: true, mode: 'chat', selectedKey: 'a', running: 0, waiting: 0,
  columns: [{ id: 'implementing', name: 'Implementing', category: 'started' }],
  cards: [{ key: 'a', sessionId: 'a', title: 'A session', phase: 'implementing', tags: [], updated: 1 }],
  composer: { model: 'm', effort: 'high', thinking: 'enabled', models: [], efforts: [], contextTokens: 0 },
}
/** Render one assistant message and return the tree. */
const md = (text) => {
  const r = renderBoardWith(src, { ...base, transcript: [{ kind: 'text', at: 1, text }] }, { layout: 'board' })
  /** The text of the rendered message alone — the rail and composer have their own text. */
  r.body = () => findByTag(r.root, 'div', (n) => cls(n).includes('assistant-text'))?.textContent ?? ''
  return r
}
const all = (root, tag) => walk(root).filter((n) => n.tagName === tag)
const cls = (n) => String(n.className || '').split(' ')
const inside = (root, tag, ancestorTag) =>
  walk(root).some((n) => n.tagName === ancestorTag && all(n, tag).length > 0)

// --- code blocks --------------------------------------------------------------
{
  const r = md('Before\n\n```php\n$x = 1;\n$y = $x->foo();\n```\n\nAfter')
  const pre = findByTag(r.root, 'pre')
  ok(!!pre, 'a fenced block becomes a <pre>')
  ok(pre && pre.textContent === '$x = 1;\n$y = $x->foo();', `with the code verbatim and the fences gone: ${JSON.stringify(pre && pre.textContent)}`)
  ok(!r.body().includes('```'), 'no backtick fence survives as text')
  ok(!!findByTag(r.root, 'code', (n) => n.textContent.includes('$x = 1;')), 'the code sits in a <code> inside the <pre>')
  ok(walk(r.root).some((n) => n.textContent === 'php' && n.tagName === 'span'), 'the language is shown as a label')
  ok(!!findByTag(r.root, 'button', (n) => n.textContent === 'Copy'), 'and there is a Copy button')
  ok(r.text().includes('Before') && r.text().includes('After'), 'the prose around it is still there')
}

// --- headings -------------------------------------------------------------------
{
  const r = md('# Title\n\n## 1. Why 49\n\n### The arithmetic\n\nbody')
  ok(findByTag(r.root, 'h1')?.textContent === 'Title', 'a # line is an <h1>')
  ok(findByTag(r.root, 'h2')?.textContent === '1. Why 49', 'a ## line is an <h2>, without the hashes')
  ok(findByTag(r.root, 'h3')?.textContent === 'The arithmetic', 'a ### line is an <h3>')
  ok(!r.body().includes('#'), 'no heading marker survives as text')
}

// --- inline ---------------------------------------------------------------------
{
  const r = md('The **49** is `allSuppliers.length`, *really* — and ~~not 48~~.')
  ok(findByTag(r.root, 'strong')?.textContent === '49', 'bold becomes <strong>')
  ok(findByTag(r.root, 'em')?.textContent === 'really', 'italic becomes <em>')
  ok(findByTag(r.root, 'del')?.textContent === 'not 48', 'strikethrough becomes <del>')
  const code = findByTag(r.root, 'code')
  ok(code?.textContent === 'allSuppliers.length', 'a code span becomes <code>')
  ok(!inside(r.root, 'code', 'pre'), 'and it is inline, not a block')
  ok(!/\*\*|`|~~/.test(r.body()), `no inline marker survives as text: ${JSON.stringify(r.body())}`)
  const t = md('snake_case_name and __dunder__ stay put; a * alone stays too')
  ok(!findByTag(t.root, 'em') && t.text().includes('snake_case_name'), 'underscores inside a word are not emphasis')
  ok(t.text().includes('a * alone'), 'an unmatched * is literal')
  const e = md('\\*not emphasis\\* and \\`not code\\`')
  ok(!findByTag(e.root, 'em') && !findByTag(e.root, 'code') && e.text().includes('*not emphasis*'), 'a backslash escapes a marker')
}

// --- tables ---------------------------------------------------------------------
{
  const r = md('| | count |\n|---|---|\n| membership rows | 68 |\n| **pending** | **1** |')
  const table = findByTag(r.root, 'table')
  ok(!!table, 'a pipe table becomes a <table>')
  const ths = all(r.root, 'th').map((n) => n.textContent)
  ok(ths.length === 2 && ths[1] === 'count', `the first row is the header: ${JSON.stringify(ths)}`)
  const tds = all(r.root, 'td').map((n) => n.textContent)
  ok(tds.includes('membership rows') && tds.includes('68'), `body cells are <td>: ${JSON.stringify(tds)}`)
  ok(inside(r.root, 'strong', 'td'), 'cells carry inline markdown')
  ok(!r.body().includes('---') && !r.body().includes('|'), 'neither the separator row nor a pipe survives as text')
}

// --- lists -----------------------------------------------------------------------
{
  const r = md('- one\n- two **b**\n\n1. first\n2. second')
  const ul = findByTag(r.root, 'ul'), ol = findByTag(r.root, 'ol')
  ok(ul && all(ul, 'li').length === 2, 'a dash list is a <ul> with one <li> per line')
  ok(ol && all(ol, 'li').length === 2, 'a numbered list is an <ol>')
  ok(inside(r.root, 'strong', 'li'), 'items carry inline markdown')
  ok(!r.body().includes('- ') && !r.body().includes('1.'), 'no bullet or number survives as text')
  const n = md('- a\n  - a1\n  - a2\n- b')
  const outer = findByTag(n.root, 'ul')
  ok(outer && outer.children.length === 2, `indentation nests: the outer list has 2 items (${outer && outer.children.length})`)
  ok(inside(n.root, 'ul', 'li'), 'and the nested list sits inside its item')
}

// --- links, and what must never be a link ----------------------------------------
{
  const r = md('See [the docs](https://example.com/x) and [evil](javascript:alert(1)) or https://bare.example/path.')
  const good = findByTag(r.root, 'a', (n) => n.href === 'https://example.com/x')
  ok(good && good.textContent === 'the docs', 'an http link is an <a> with its text')
  ok(!findByTag(r.root, 'a', (n) => String(n.href).startsWith('javascript:')), 'a javascript: URL is never a link')
  ok(r.text().includes('evil'), 'its text is kept')
  ok(!!findByTag(r.root, 'a', (n) => n.href === 'https://bare.example/path'), 'a bare URL is linked, without the trailing full stop')
}

// --- a scheme the bare-URL matcher cannot finish ----------------------------------
//
// The guard was `startsWith('https://')` and the extraction was
// `/^https?:\/\/[^\s<>()[\]]+/` — two different predicates. Every string below
// satisfies the first and fails the second, so `exec()` returned null,
// `null[0]` threw a TypeError, and because `render()` calls
// `replaceChildren()` before it builds anything, the whole chat view went blank
// — no transcript, no rail, no composer, no error — and threw again on every
// frame, because the text was in Claude Code's on-disk transcript.
//
// The last two are the ones that matter: neither is malformed.
// `https://<your-gateway-host>/v1` is the placeholder this extension's own
// provider documentation uses, and `https://[::1]:8080` is a valid URL.
for (const [text, why] of [
  ['set it to https:// followed by your host', 'a bare scheme mid-sentence'],
  ['the endpoint is http://', 'a scheme at the end of a line'],
  ['see (http://) for the format', 'a scheme in brackets'],
  ['use https://<your-gateway-host>/v1', 'an angle-bracket placeholder host'],
  ['listening on https://[::1]:8080', 'a valid IPv6 literal'],
]) {
  let threw = null
  let r = null
  try { r = md(text) } catch (e) { threw = e instanceof Error ? e.message : String(e) }
  ok(threw === null, `${why} does not throw and blank the panel${threw ? `: ${threw}` : ''}`)
  ok(r !== null && r.root.children.length > 0, `${why} still renders a tree`)
  // The characters the agent wrote are shown, since there is no link to make.
  ok(r !== null && r.text().includes(text.split(' ').find((w) => w.includes('://')) ?? '!'),
     `${why} is shown as the text it is`)
}
// And the IPv6 one must not become a link to a truncated host, which would be
// worse than not linking it: a URL that goes somewhere else.
{
  const r = md('listening on https://[::1]:8080')
  ok(!findByTag(r.root, 'a', (n) => String(n.href) === 'https://'),
     'and never becomes a link to the scheme alone')
}

// --- raw HTML is text, full stop ---------------------------------------------------
{
  const r = md('<img src=x onerror=alert(1)> and <b>bold</b> and <script>alert(2)</script>')
  ok(!findByTag(r.root, 'img') && !findByTag(r.root, 'b') && !findByTag(r.root, 'script'), 'no element is created from HTML in the text')
  ok(r.text().includes('<img src=x onerror=alert(1)>'), 'the characters are shown as they were written')
}

// --- blocks ------------------------------------------------------------------------
{
  const r = md('a\n\n---\n\n> quoted **q**\n> more\n\nline one\nline two')
  ok(!!findByTag(r.root, 'hr'), 'a --- line is an <hr>')
  const bq = findByTag(r.root, 'blockquote')
  ok(bq && bq.textContent.includes('quoted') && bq.textContent.includes('more'), 'a > block is a <blockquote>')
  ok(bq && all(bq, 'strong').length === 1, 'with inline markdown inside')
  ok(!!findByTag(r.root, 'br'), 'a single newline inside a paragraph is a line break')
}

// --- streaming: a fence that has not closed yet ------------------------------------
{
  const r = renderBoardWith(src, { ...base, transcript: [], streaming: 'Here:\n```js\nconst a = 1\n' }, { layout: 'board' })
  const pre = findByTag(r.root, 'pre')
  ok(pre && pre.textContent.startsWith('const a = 1'), 'an unclosed fence mid-stream still renders as a code block')
  ok(!!findByTag(r.root, 'span', (n) => cls(n).includes('caret')), 'and the streaming caret is still there')
}

// --- what stays plain ---------------------------------------------------------------
{
  const r = renderBoardWith(src, { ...base, transcript: [{ kind: 'prompt', at: 1, text: '## not a heading `x`' }] }, { layout: 'board' })
  ok(!findByTag(r.root, 'h2') && r.text().includes('## not a heading `x`'), 'what YOU typed is shown exactly as typed')
}

console.log(fails ? `\n${fails} FAILURES` : '\nPASS — the answer renders as an answer, and nothing in it becomes an element')
process.exit(fails ? 1 : 0)
