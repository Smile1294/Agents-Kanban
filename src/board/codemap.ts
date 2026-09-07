/**
 * The codemap gate: knowledge files move with the code.
 *
 * `docs/codemap/` is this repository's knowledge base for agents — one markdown
 * file per area, each with YAML frontmatter whose `paths:` list says which
 * source files that area OWNS. The rule is that a change to an owned file is
 * accompanied by a change to its area file, in the same branch: fix what the
 * change made false, append a line under "Recent changes".
 *
 * The rule is enforced, not requested. A brief that asks is present for the
 * whole session and being present is not outranking — this project has a
 * postmortem about exactly that. So `AgentManager` calls `knowledgeCheck()` on
 * the move into a review column, over `git diff` against the base, and the
 * move is refused with the file names when an area's file did not move.
 *
 * Three things are deliberate:
 *
 *  - **Generic.** The extension runs on any repository. No `docs/codemap/`
 *    with `paths:` frontmatter means no areas, and no areas means nothing is
 *    required — the check passes and the brief says nothing about it.
 *  - **Read from the agent's worktree**, not from the main checkout, so an
 *    agent can claim a new source file by editing (or adding) an area file in
 *    its own branch.
 *  - **Tests and documentation are exempt.** A change to a test alone modifies
 *    no feature; requiring a knowledge-file line for it would teach agents
 *    that the line is a formality.
 *
 * Pure and plain Node — no `vscode` — so the whole policy is unit-tested,
 * including an integrity pass over the real folder (`codemap.test.ts`): every
 * source file owned by exactly one area, every glob matching a real file,
 * every path the map names existing. The map cannot rot silently.
 */
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

/** Where the knowledge base lives, repo-relative. */
export const CODEMAP_DIR = 'docs/codemap'

export interface CodemapArea {
  /** Repo-relative path of the area file, e.g. `docs/codemap/board-model.md`. */
  file: string
  name: string
  description: string
  /** Globs of the source files this area owns. Repo-relative, `/`-separated. */
  paths: string[]
  /** The gates the area names as covering it. Informational. */
  tests: string[]
}

export type KnowledgeVerdict =
  | { ok: true; areas: string[] }
  | { ok: false; missing: KnowledgeGap[]; message: string }

export interface KnowledgeGap {
  /** The area whose file did not move. */
  area: string
  /** Its file, repo-relative — what the agent has to edit. */
  file: string
  /** The changed source files that made it required. */
  changed: string[]
}

/** Forward slashes, no leading `./`, no trailing slash. */
export function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * Files the gate never asks about: tests, and documentation of any kind.
 * The area files themselves are `.md`, so they are exempt by the same rule —
 * which is what lets a docs-only change reach review with nothing else.
 */
export function isExempt(p: string): boolean {
  const n = normalisePath(p)
  return (
    /(^|\/)__tests__\//.test(n) ||
    /\.test\.(ts|mjs|js|cjs)$/.test(n) ||
    /\.(md|markdown|txt)$/i.test(n) ||
    /(^|\/)LICENSE$/.test(n) ||
    /(^|\/)\.gitignore$/.test(n) ||
    /(^|\/)package-lock\.json$/.test(n)
  )
}

/**
 * A glob to an anchored RegExp. `**` spans directories, `*` and `?` stay inside
 * one segment. Only these three — a matcher for model-written paths does not
 * need brace expansion, and every extra feature is a way to match by accident.
 */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  const g = normalisePath(glob)
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!
    if (c === '*') {
      if (g[i + 1] === '*') {
        // `**/` may match nothing at all, so `a/**/b` matches `a/b`.
        if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else {
      re += /[.+^${}()|[\]\\]/.test(c) ? `\\${c}` : c
    }
  }
  return new RegExp(`^${re}$`)
}

export function matchesGlob(glob: string, p: string): boolean {
  return globToRegExp(glob).test(normalisePath(p))
}

/**
 * The frontmatter between the leading `---` lines, read as the small subset of
 * YAML these files use: `key: scalar` and `key:` followed by `  - item` lines.
 * Anything else is ignored rather than guessed at. `undefined` when there is no
 * frontmatter at all.
 */
export function parseFrontmatter(md: string): Record<string, string | string[]> | undefined {
  const lines = md.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return undefined
  const out: Record<string, string | string[]> = {}
  let key: string | undefined
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '---') return out
    const item = /^\s+-\s+(.*)$/.exec(line)
    if (item && key) {
      const prev = out[key]
      const list = Array.isArray(prev) ? prev : []
      list.push(unquote(item[1]!))
      out[key] = list
      continue
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (kv) {
      key = kv[1]!
      const value = kv[2]!.trim()
      // A trailing comment on a list header ("paths:  # …") is not a value.
      out[key] = value && !value.startsWith('#') ? unquote(value) : []
      if (value && !value.startsWith('#')) key = undefined
      continue
    }
    // A blank or unrecognised line ends any list in progress.
    if (!line.trim()) key = undefined
  }
  return undefined // never closed
}

function unquote(v: string): string {
  const s = v.replace(/\s+#.*$/, '').trim()
  return /^(['"]).*\1$/.test(s) ? s.slice(1, -1) : s
}

/**
 * An area, or `undefined` for a file that is not one — the README, the flows,
 * the glossary — which carry no `paths:`. That is the whole test: a file with
 * ownership is an area, a file without is prose.
 */
export function parseAreaFile(file: string, md: string): CodemapArea | undefined {
  const fm = parseFrontmatter(md)
  if (!fm) return undefined
  const paths = Array.isArray(fm.paths) ? fm.paths.map(normalisePath).filter(Boolean) : []
  if (!paths.length) return undefined
  const name = typeof fm.name === 'string' && fm.name ? fm.name : path.basename(file, '.md')
  return {
    file: normalisePath(file),
    name,
    description: typeof fm.description === 'string' ? fm.description : '',
    paths,
    tests: Array.isArray(fm.tests) ? fm.tests.map(normalisePath) : [],
  }
}

/** Every area whose `paths:` claim this file. Exempt files have no owner. */
export function ownersOf(p: string, areas: readonly CodemapArea[]): CodemapArea[] {
  if (isExempt(p)) return []
  return areas.filter((a) => a.paths.some((g) => matchesGlob(g, p)))
}

/**
 * The verdict for a change set. `changed` is every path that differs from the
 * base — committed or not, untracked included — as `WorktreeService.changedFiles`
 * reports it.
 */
export function knowledgeCheck(changed: readonly string[], areas: readonly CodemapArea[]): KnowledgeVerdict {
  const set = new Set(changed.map(normalisePath))
  const touched = new Map<string, { area: CodemapArea; changed: string[] }>()
  for (const p of set) {
    for (const area of ownersOf(p, areas)) {
      const entry = touched.get(area.file) ?? { area, changed: [] }
      entry.changed.push(p)
      touched.set(area.file, entry)
    }
  }
  const missing: KnowledgeGap[] = []
  for (const { area, changed: files } of touched.values()) {
    if (!set.has(area.file)) missing.push({ area: area.name, file: area.file, changed: files.sort() })
  }
  if (!missing.length) return { ok: true, areas: [...touched.values()].map((t) => t.area.name).sort() }
  missing.sort((a, b) => a.file.localeCompare(b.file))
  return { ok: false, missing, message: knowledgeMessage(missing) }
}

/** The refusal, written for the agent that has to act on it. */
export function knowledgeMessage(missing: readonly KnowledgeGap[]): string {
  const rows = missing.map((m) => `  - ${m.file} — owns ${m.changed.join(', ')}`)
  return [
    'the knowledge files for what you changed have not moved with it. Update, in this worktree:',
    ...rows,
    'For each: fix any statement your change made false, and append one line under',
    '"## Recent changes" (- YYYY-MM-DD · <branch> · what changed). Then call set_phase',
    `again. The rule and the format are in ${CODEMAP_DIR}/README.md.`,
  ].join('\n')
}

/**
 * The areas in a checkout, or `[]` when it has no codemap. Reads the agent's
 * own worktree, so a file the agent added or edited counts.
 */
export async function loadCodemap(root: string): Promise<CodemapArea[]> {
  const dir = path.join(root, CODEMAP_DIR)
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const areas: CodemapArea[] = []
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue
    const md = await fs.readFile(path.join(dir, name), 'utf8').catch(() => '')
    const area = parseAreaFile(`${CODEMAP_DIR}/${name}`, md)
    if (area) areas.push(area)
  }
  return areas
}
