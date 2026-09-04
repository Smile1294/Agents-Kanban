/** Slash commands — Claude Code's `.claude/commands/*.md`.
 *
 * Nimbalyst calls these "workflows" and they are just markdown files: submitting
 * the raw text `/name args` makes the Agent SDK execute the file's contents.
 * That already worked here — you could type `/review` and it would run — but
 * nothing ever *said* so, and an interaction surface you cannot discover may as
 * well not exist.
 *
 * So this only reads the list. Execution stays where it was: the composer sends
 * the raw text and the SDK does the rest.
 *
 * Two scopes, matching the CLI: the project's own `.claude/commands` and the
 * user's `~/.claude/commands`. A project command shadows a user command of the
 * same name, which is the CLI's precedence too. Nested directories namespace a
 * command as `parent:child`.
 */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export interface SlashCommand {
  /** What you type, without the leading slash. */
  name: string
  /** One line from the file's frontmatter or its first heading. */
  description: string
  scope: 'project' | 'user'
  path: string
}

/** Pull `description:` out of YAML frontmatter, else the first meaningful line. */
export function describeCommand(source: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (fm) {
    const line = /^description:\s*(.+)$/m.exec(fm[1]!)
    if (line) return line[1]!.trim().replace(/^["']|["']$/g, '')
  }
  const body = fm ? source.slice(fm[0].length) : source
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/^#+\s*/, '')
    if (line && !line.startsWith('---')) return line.slice(0, 120)
  }
  return ''
}

async function readDir(dir: string, scope: SlashCommand['scope']): Promise<SlashCommand[]> {
  const out: SlashCommand[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      const full = path.join(current, e.name)
      // A subdirectory namespaces its commands, as the CLI does: git/commit.md
      // is /git:commit.
      if (e.isDirectory()) { await walk(full, `${prefix}${e.name}:`); continue }
      if (!e.name.endsWith('.md')) continue
      const source = await fs.readFile(full, 'utf8').catch(() => '')
      out.push({
        name: prefix + e.name.replace(/\.md$/, ''),
        description: describeCommand(source),
        scope,
        path: full,
      })
    }
  }
  await walk(dir, '')
  return out
}

/**
 * Every command available in this workspace, project scope first.
 * Never throws: a missing directory is the normal case, not an error.
 */
export async function listSlashCommands(workspaceRoot: string | undefined): Promise<SlashCommand[]> {
  const dirs: Array<[string, SlashCommand['scope']]> = [
    ...(workspaceRoot
      ? [[path.join(workspaceRoot, '.claude', 'commands'), 'project'] as [string, SlashCommand['scope']]]
      : []),
    [path.join(os.homedir(), '.claude', 'commands'), 'user'],
  ]
  const found = new Map<string, SlashCommand>()
  for (const [dir, scope] of dirs) {
    for (const c of await readDir(dir, scope)) {
      // Project shadows user, matching the CLI's precedence.
      if (!found.has(c.name)) found.set(c.name, c)
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}
