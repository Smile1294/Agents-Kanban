/* Review comments: the drafts a user leaves on an agent's diff, and the ONE
   message they become. What it guards: a comment that lands on the wrong card,
   and a prompt the agent cannot map back to a line after it has edited the file. */
import { MAX_DRAFTS, ReviewDrafts, reviewPrompt } from '../review-comments.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const r = new ReviewDrafts()
ok(r.add('card-a', { file: 'src\\b.ts', line: 40, text: '  this throws on empty input  ', quote: '  return list[0].id   ' })?.file === 'src/b.ts',
   'a Windows path is stored with forward slashes')
r.add('card-a', { file: 'src/a.ts', line: 12, endLine: 14, text: 'rename this', quote: 'const x = 1\nconst y = 2' })
r.add('card-b', { file: 'README.md', line: 1, text: 'other card' })
ok(r.add('card-a', { file: 'x', line: 1, text: '   ' }) === undefined, 'an empty comment is not a draft')
ok(r.count('card-a') === 2 && r.count('card-b') === 1, 'drafts are kept per card')

const prompt = reviewPrompt(r.list('card-a'))
ok(prompt.startsWith('Review comments on your changes — 2 of them'), 'the prompt says how many')
ok(prompt.indexOf('src/a.ts:12-14') < prompt.indexOf('src/b.ts:40'), 'ordered by file then line, like the diff')
ok(/1\. `src\/a\.ts:12-14`\n   > const x = 1\n   > const y = 2\n   rename this/.test(prompt), 'each comment is numbered, with the lines it was written on quoted')
ok(/> {3}return list\[0\]\.id\n {3}this throws on empty input/.test(prompt), 'the quote keeps its indentation, the comment is trimmed')
ok(/move back to "validating" with a howToTest/.test(prompt), 'and it says how to hand the work back')

const first = r.list('card-a')[0]!
ok(r.remove('card-a', first.id) && r.count('card-a') === 1, 'a draft can be deleted')
r.rekey('card-a', 'card-a2')
ok(r.count('card-a') === 0 && r.count('card-a2') === 1, 'drafts follow a card whose key changed')
ok(r.take('card-a2').length === 1 && r.count('card-a2') === 0, 'taking them for a send empties the card')
for (let i = 0; i < MAX_DRAFTS + 3; i++) r.add('many', { file: 'f', line: i + 1, text: 'c' })
ok(r.count('many') === MAX_DRAFTS, 'the number of drafts is bounded')

if (fails) { console.log(`${fails} failure(s)`); process.exit(1) }
console.log('PASS — review comments become one numbered, quoted message')
