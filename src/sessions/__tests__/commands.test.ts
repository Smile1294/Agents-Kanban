/* Slash-command discovery. Executing them was always the SDK's job — submitting
   `/name args` runs the file — but nothing listed them, and an interaction
   surface you cannot discover may as well not exist. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describeCommand, listSlashCommands } from '../commands.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// --- descriptions ------------------------------------------------------------
ok(describeCommand('---\ndescription: Review the diff\n---\nbody') === 'Review the diff', 'frontmatter description wins')
ok(describeCommand('---\ndescription: "Quoted here"\n---\n') === 'Quoted here', 'quotes are stripped')
ok(describeCommand('# Ship it\n\nmore') === 'Ship it', 'falls back to the first heading')
ok(describeCommand('just a line\n') === 'just a line', 'or the first line')
ok(describeCommand('---\nmodel: opus\n---\n\n## Deploy\n') === 'Deploy', 'frontmatter without a description skips to the body')
ok(describeCommand('') === '', 'an empty file has no description')
ok(describeCommand('\n\n\n') === '', 'and neither does a blank one')

// --- discovery ---------------------------------------------------------------
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-cmd-'))
const proj = path.join(tmp, 'proj')
await fs.mkdir(path.join(proj, '.claude', 'commands', 'git'), { recursive: true })
await fs.writeFile(path.join(proj, '.claude', 'commands', 'review.md'), '---\ndescription: Review the diff\n---\nDo it.')
await fs.writeFile(path.join(proj, '.claude', 'commands', 'ship.md'), '# Ship the branch\n')
await fs.writeFile(path.join(proj, '.claude', 'commands', 'git', 'commit.md'), '# Commit everything\n')
await fs.writeFile(path.join(proj, '.claude', 'commands', 'notes.txt'), 'not a command')

const cmds = await listSlashCommands(proj)
const byName = new Map(cmds.map((c) => [c.name, c]))
ok(byName.has('review') && byName.has('ship'), 'project commands are found')
ok(byName.get('review')!.description === 'Review the diff', 'with their descriptions')
ok(byName.get('review')!.scope === 'project', 'and their scope')
ok(byName.has('git:commit'), 'a subdirectory namespaces its commands as parent:child')
ok(!cmds.some((c) => c.name === 'notes'), 'non-markdown files are ignored')
ok(cmds.every((c, i) => i === 0 || cmds[i - 1]!.name <= c.name), 'the list is sorted')

// A workspace with no commands directory is the normal case, not an error.
const bare = path.join(tmp, 'bare')
await fs.mkdir(bare)
ok(Array.isArray(await listSlashCommands(bare)), 'a workspace with no commands returns a list, not a throw')
ok(Array.isArray(await listSlashCommands(undefined)), 'and so does no workspace at all')

await fs.rm(tmp, { recursive: true, force: true })
console.log(fails === 0 ? 'PASS — slash commands are discoverable' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
