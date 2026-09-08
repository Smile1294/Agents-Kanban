/* Exercises the store against Claude Code's REAL session format — and against a
   SEEDED one, not against whatever happens to be on this laptop.

   It used to read the developer's own `~/.claude` and wrap two thirds of itself
   in `if (list.length)`. Both halves were wrong in the same direction. On a
   machine with no Claude Code sessions for this directory — CI, a fresh clone,
   a colleague — twenty-five assertions silently did not run and the file still
   printed a pass; CLAUDE.md's own rule says "a gate that skips is not a gate".
   And on a machine that HAS them it mutated them: it set a phase, added tags
   and archived the developer's real first session.

   So it seeds a transcript into a throwaway `CLAUDE_CONFIG_DIR`, exactly as
   `smoke.mjs` does, and the guard becomes an assertion. The encoding of the
   project directory is the fiddly part and is the reason this is worth copying
   rather than inventing: the session's cwd with every character that is not a
   letter or a digit replaced by `-`, applied to the REALPATH. */
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const claudeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-store-claude-'))
const prevConfig = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = claudeHome

// Registers the runtimes. Without it `allRuntimes()` is empty, `foreign()`
// contributes nothing, and every assertion about an adopted Codex session would
// pass vacuously against a board that simply has no such card.
await import('../../agent/runtimes/index.ts')
const { MetaStore } = await import('../meta.ts')
const { SessionStore, interruptedSessions, summariseTool } = await import('../store.ts')
const { costOfUsage } = await import('../usage.ts')
type BoardSession = import('../store.ts').BoardSession

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-sess-'))
const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ck-sess-repo-')))

// One real session, in Claude Code's real on-disk format, with KNOWN contents.
const SEEDED_ID = '99999999-8888-7777-6666-555555555555'
{
  const projectDir = path.join(claudeHome, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'))
  await fs.mkdir(projectDir, { recursive: true })
  const common = {
    sessionId: SEEDED_ID, cwd: repo,
    isSidechain: false, userType: 'external', version: '2.0.0', gitBranch: 'main',
  }
  await fs.writeFile(path.join(projectDir, `${SEEDED_ID}.jsonl`), [
    { ...common, type: 'user', uuid: 'u1', parentUuid: null,
      timestamp: new Date(1e12).toISOString(),
      message: { role: 'user', content: 'add a health check' } },
    { ...common, type: 'assistant', uuid: 'a1', parentUuid: 'u1',
      timestamp: new Date(1e12 + 1000).toISOString(),
      message: {
        id: 'msg_store', model: 'claude-opus-5', role: 'assistant', type: 'message',
        content: [{ type: 'text', text: 'Looking at the routes.' }],
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
}

// A second Claude session in the same project: the SAME seed after an
// auto-compaction, in the real on-disk shape. Every pre-compaction message is
// STILL IN THE FILE; the CLI then appends a `compact_boundary` system record
// whose `parentUuid` is null — the severing of the ancestry chain that makes
// everything before it invisible to the SDK's reader — and the compact summary
// as a user message carrying `isCompactSummary: true`. Verified against a real
// compacted session on this machine.
const COMPACTED_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
{
  const projectDir = path.join(claudeHome, 'projects', repo.replace(/[^a-zA-Z0-9]/g, '-'))
  const common = {
    sessionId: COMPACTED_ID, cwd: repo,
    isSidechain: false, userType: 'external', version: '2.0.0', gitBranch: 'main',
  }
  const boundary = 'bbbbbbbb-0000-0000-0000-000000000002'
  const summary = 'cccccccc-0000-0000-0000-000000000003'
  const t = (n: number) => new Date(2e12 + n * 1000).toISOString()
  await fs.writeFile(path.join(projectDir, `${COMPACTED_ID}.jsonl`), [
    { ...common, type: 'user', uuid: 'cu1', parentUuid: null, timestamp: t(1),
      message: { role: 'user', content: 'the original brief: build a thing' } },
    { ...common, type: 'assistant', uuid: 'ca1', parentUuid: 'cu1', timestamp: t(2),
      message: {
        id: 'msg_pre_compaction', model: 'claude-opus-5', role: 'assistant', type: 'message',
        content: [{ type: 'text', text: 'Early design notes.' }],
        usage: { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } },
    { ...common, type: 'system', uuid: boundary, subtype: 'compact_boundary',
      parentUuid: null, timestamp: t(3), compactMetadata: { pre_tokens: 40 }, content: '' },
    { ...common, type: 'user', uuid: summary, parentUuid: boundary, timestamp: t(4),
      isCompactSummary: true, isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: 'This session is being continued from a previous conversation that ran out of context.\n\nSummary: 1. Build a thing.' } },
    { ...common, type: 'assistant', uuid: 'ca2', parentUuid: summary, timestamp: t(5),
      message: {
        id: 'msg_post_compaction', model: 'claude-opus-5', role: 'assistant', type: 'message',
        content: [{ type: 'text', text: 'Continuing the work.' }],
        usage: { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n')
}

// A Codex rollout for the SAME repo, with NO sidecar entry — which is exactly
// the state of every adopted session on a real board: the runtime is known only
// from the foreign scan, never from metadata we wrote.
const CODEX_ID = '11111111-2222-3333-4444-555555555555'
const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ck-store-codex-'))
const prevCodex = process.env.CODEX_HOME
process.env.CODEX_HOME = codexHome
{
  const day = path.join(codexHome, 'sessions', '2026', '05', '06')
  await fs.mkdir(day, { recursive: true })
  const rec = (type: string, payload: unknown) =>
    JSON.stringify({ timestamp: '2026-05-06T10:00:00.000Z', type, payload })
  await fs.writeFile(
    path.join(day, `rollout-2026-05-06T10-00-00-${CODEX_ID}.jsonl`),
    [
      rec('session_meta', {
        id: CODEX_ID, cwd: repo, timestamp: '2026-05-06T10:00:00.000Z',
        model: 'gpt-5-codex', instructions: 'x'.repeat(64),
      }),
      rec('event_msg', { type: 'user_message', message: 'update the screening tabs' }),
      rec('event_msg', { type: 'agent_message', message: 'Done.' }),
    ].join('\n') + '\n',
    'utf8',
  )
  await fs.writeFile(
    path.join(codexHome, 'session_index.jsonl'),
    `${JSON.stringify({ id: CODEX_ID, thread_name: 'Update screening tabs', updated_at: '2026-05-06T10:05:00.000Z' })}\n`,
    'utf8',
  )
}

const store = new SessionStore(repo, new MetaStore(tmp, repo))

const list = await store.list()
ok(Array.isArray(list), 'list() returns sessions from Claude Code without throwing')
// An ASSERTION, not a guard. If the SDK ever changes where it looks, this goes
// red and names it rather than skipping the rest of the file.
ok(list.filter((s) => !s.runtime || s.runtime === 'claude').length === 2,
   `the seeded Claude sessions are found — the SDK's project-directory encoding still holds (${list.length})`)
ok(list.some((s) => s.id === SEEDED_ID), 'and it is the one that was seeded')

{
  const first = list.find((s) => s.id === SEEDED_ID)!
  ok(typeof first.id === 'string' && first.id.length > 8, 'session has a real id')
  ok(typeof first.title === 'string' && first.title.length > 0, `title resolved: ${JSON.stringify(first.title.slice(0, 40))}`)
  ok(first.phase === 'planning', 'a session with no metadata gets the default phase')
  ok(first.tags.length === 0, 'and no tags until we add some')

  // our metadata attaches to Claude Code's session without touching it
  await store.setPhase(first.id, 'implementing')
  await store.setTags(first.id, ['auth', 'ui'])
  const after = await store.get(first.id)
  ok(after?.phase === 'implementing', 'phase attaches to a real session')
  ok(after?.tags.join(',') === 'auth,ui', 'multiple tags attach to a real session')

  // archive hides from the board but keeps the session
  await store.archive(first.id, true)
  ok(!(await store.list()).some((x) => x.id === first.id), 'archived session leaves the board')
  ok((await store.list({ includeArchived: true })).some((x) => x.id === first.id), 'but is still there when asked for')
  await store.archive(first.id, false)
  ok((await store.list()).some((x) => x.id === first.id), 'unarchive brings it straight back')

  // transcript comes from Claude Code's JSONL
  const t = await store.transcript(first.id, 40)
  ok(Array.isArray(t), 'transcript reads from Claude Code without throwing')
  console.log(`      (${t.length} entries; kinds: ${[...new Set(t.map((e) => e.kind))].join(', ') || 'none'})`)
  if (t.length) {
    ok(t.every((e) => typeof e.kind === 'string'), 'every entry is a tagged union member')
    const tools = t.filter((e) => e.kind === 'tool')
    ok(tools.every((e) => e.kind === 'tool' && ['running', 'ok', 'error'].includes(e.status)),
       `tool entries carry a resolved status (${tools.length} tool rows)`)
  }
}

// --- what it cost, and how full its context was ------------------------------
//
// The numbers that used to exist ONLY inside a live run. Against real session
// data, because the whole point is that they are read back off disk after the
// process that produced them is gone.
if (list.length) {
  // Pinned to the UNcompacted seed, not list[0]: a compacted session's usage
  // deliberately totals MORE than the SDK returns (the recovery below), so the
  // frame sanity check would compare two different populations on it.
  const id = list.find((s) => s.id === SEEDED_ID)!.id
  const u = await store.usage(id)
  ok(u.responses > 0, `usage() finds API responses in a real transcript (${u.responses})`)
  ok(u.costUsd > 0, `and prices them: $${u.costUsd.toFixed(4)} over ${u.responses} responses`)
  ok(u.priced, `every model in a real session has a published rate${u.priced ? '' : ' — MISSING: ' + u.unpriced.join(', ')}`)
  ok(u.contextTokens > 0, `context fill read back from disk: ${u.contextTokens} tokens`)
  ok(!!u.contextWindow && u.contextTokens < u.contextWindow,
     `and it fits in the window it is measured against (${u.contextTokens}/${u.contextWindow})`)
  console.log(`      (model ${u.model}; in ${u.input} out ${u.output} cache w${u.cacheWrite} r${u.cacheRead})`)

  // Deduplication, on real data, against the RAW frames rather than the
  // rendered transcript: the transcript is windowed to the newest messages
  // while usage totals the whole file, so counting entries compares two
  // different populations — which is exactly how the first version of this
  // assertion passed for months and then went red as the session grew.
  const { getSessionMessages } = await import('../../agent/sdk.ts').then((m) => m.loadSdk())
  const raw = await getSessionMessages(id)
  const frames = raw.filter((m) => m.type === 'assistant' &&
    !!(m.message as { usage?: unknown } | undefined)?.usage)
  const ids = new Set(frames.map((m) => (m.message as { id?: string }).id).filter(Boolean))
  ok(u.responses <= frames.length,
     `responses (${u.responses}) never exceed the frames that carried them (${frames.length})`)
  ok(u.responses === ids.size,
     `and equal the number of distinct response ids (${u.responses} vs ${ids.size})`)
  if (frames.length > ids.size) {
    ok(u.responses < frames.length,
       `a real streamed session has repeat frames, and they are NOT billed twice ` +
       `(${frames.length} frames, ${ids.size} responses — ${(frames.length / ids.size).toFixed(1)}x)`)
  }

  // Usage is totalled over the whole file, so it cannot depend on the window
  // the chat view renders.
  ok((await store.usage(id)).responses === u.responses,
     'usage is unchanged by the transcript window — it totals the whole session')
}

// --- the transcript window keeps the NEWEST messages -------------------------
//
// The SDK's own `limit` takes the FIRST n, not the last — verified against a
// 425-message session, where `{limit: 400}` returned the first 400 and silently
// dropped the 25 most recent: the ones anyone opening a transcript came for. So
// the read is unbounded and the window is applied to the tail.
//
// Deliberately NOT on list[0]. That is the most recently touched session, which
// on a machine running Claude Code is very often being written to right now —
// two reads of a growing file legitimately disagree, and the assertion would
// flake for a reason that has nothing to do with what it tests.
const settled = list.filter((x) => Date.now() - x.updated > 120_000)
if (settled.length) {
  const id = settled[0]!.id
  const full = await store.transcript(id)
  const tail = await store.transcript(id, 3)
  ok(tail.length <= 3, `a limit bounds the transcript (${tail.length} of ${full.length} entries)`)
  if (full.length > 3) {
    // Compared on CONTENT, not by deep equality: a rehydrated entry's `at` is
    // stamped when it was parsed, so two reads of the same message differ by
    // however many milliseconds apart they happened.
    const shape = (es: typeof full) => es.map((e) =>
      e.kind + '|' + ('text' in e ? e.text : 'summary' in e ? e.summary : '')).join('\n')
    ok(shape(tail) === shape(full.slice(full.length - tail.length)),
       'and it keeps the LAST entries, not the first — the newest work is what is shown')
  }
} else {
  console.log('      (no settled session to check the transcript window against)')
}

// --- how much is above the loaded window? -------------------------------------
//
// `transcriptTotal` is the upward-pagination answer: the whole file's message
// count, whatever window `transcript()` renders. A window shorter than it is
// how the host decides the "load earlier" pill exists at all.
if (settled.length) {
  const id = settled[0]!.id
  const total = await store.transcriptTotal(id)
  const fullLen = (await store.transcript(id)).length
  ok(total === fullLen, `the total matches the whole file (${total} vs ${fullLen})`)
  const bounded = await store.transcript(id, 3)
  ok((bounded.length < total) === (fullLen > 3),
     'a bounded window reports "more above" exactly when older messages exist')
}
ok((await store.transcriptTotal('00000000-0000-0000-0000-000000000000')) === 0,
   'an unknown session totals zero rather than throwing')

// an unknown session must return empty, not throw
ok((await store.transcript('00000000-0000-0000-0000-000000000000')).length === 0, 'unknown session yields an empty transcript')
const noUsage = await store.usage('00000000-0000-0000-0000-000000000000')
ok(noUsage.costUsd === 0 && noUsage.responses === 0, 'and an unknown session costs nothing rather than throwing')
ok((await store.get('nope')) === undefined, 'unknown session id returns undefined')

// --- a compacted session keeps its older messages, hides the summary ---------
//
// The SDK's reader keeps only the ancestry chain of the newest message, and
// the CLI severs that chain at a compaction — so a session that auto-compacted
// used to show NOTHING from before the boundary while the compact summary
// itself ("This session is being continued…") rendered as a giant user prompt.
// Both halves were reported against the real board, and each gate here goes
// red when its half is reverted: the first three when the recovery is skipped,
// the fourth when the summary renders as a message.
{
  const t = await store.transcript(COMPACTED_ID)
  const texts = t.filter((e) => e.kind === 'prompt' || e.kind === 'text')
    .map((e) => (e as { text: string }).text).join('\n')
  ok(texts.includes('the original brief: build a thing'),
     'messages from before the compaction are still shown')
  ok(texts.includes('Early design notes.'),
     'including the assistant answers the SDK\'s reader drops')
  ok(!texts.includes('being continued from a previous conversation'),
     'the compact summary never renders as a message')
  const notices = t.filter((e) => e.kind === 'notice')
  ok(notices.length === 1
     && notices[0]!.kind === 'notice'
     && notices[0]!.message === 'Claude compacted the conversation here.',
     `one muted divider marks the compaction, not the summary text (${notices.length} notice)`)
  ok((await store.transcriptTotal(COMPACTED_ID)) === 5,
     'and the total counts the older messages, so upward pagination can reach them')
  const u = await store.usage(COMPACTED_ID)
  const pre = costOfUsage('claude-opus-5',
    { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  const post = costOfUsage('claude-opus-5',
    { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  ok(u.costUsd === (pre! + post!),
     `spend includes the pre-compaction turns ($${u.costUsd.toFixed(4)})`)
  ok(u.contextTokens === 5,
     `and the context fill is the POST-compaction figure (${u.contextTokens} tokens)`)
}

// --- what a tool row actually says -------------------------------------------
//
// Reported as "I literally can't tell from the UI what the agent is doing",
// with a screenshot of four rows: a raw `mcp__claude_ai_Atlassian__getJiraIssue`
// with no arguments, a bare `ToolSearch`, and a `Read` whose 70-character
// worktree prefix pushed the filename off the end of the row.
ok(summariseTool('Bash', { command: 'git status' }) === 'Bash  git status', 'tool summary shows the command')

// The old prefix strip was `^mcp__[^_]+__`, which requires a server name with
// no underscore in it — so every real MCP server defeated it and the whole
// mangled identifier was printed.
const jira = summariseTool('mcp__claude_ai_Atlassian__getJiraIssue', { issueIdOrKey: 'ACME-184' })
ok(!jira.includes('mcp__'), `an MCP server with underscores still gets stripped: ${jira}`)
ok(jira.includes('getJiraIssue'), 'the tool name survives')
ok(jira.includes('Atlassian'), 'and says which server it is')
ok(jira.includes('ACME-184'), 'and WHICH ISSUE — the point of the row')

// A tool whose argument key is not one we listed must still say something.
const unknown = summariseTool('mcp__thing__do_it', { somethingNew: 'the-target' })
ok(unknown.includes('the-target'), `an unlisted argument key still yields a detail: ${unknown}`)

// A server name with no capitalised segment is its own name, not its last word.
ok(summariseTool('mcp__some_server__go', {}).startsWith('some_server · go'),
   'a lowercase server name is not truncated to its last segment')
ok(summariseTool('mcp__board__set_phase', { phase: 'implementing' }).includes('set_phase'),
   'the board tools still read as themselves')

// Absolute paths lose the part that is identical on every row.
const read = summariseTool('Read', {
  file_path: '/home/dev/Projects/app/.agentskanban/worktrees/S1abc123-add-search/.claude/knowledge/_domain-map.md',
})
ok(!read.includes('/home/dev'), `an absolute path loses its worktree prefix: ${read}`)
ok(read.includes('_domain-map.md'), 'and keeps the filename')
ok(summariseTool('Read', { file_path: 'src/a.ts' }) === 'Read  src/a.ts',
   'a short relative path is left exactly as it is')

// --- rename survives the session-file race -----------------------------------
//
// The id arrives on the `init` message; the file it names is written a moment
// later. Renaming immediately reported "Session <id> not found in any project
// directory" as a popup, on every single new session.
const { retryWhileMissing } = await import('../store.ts')
let calls = 0
const slept: number[] = []
const eventually = await retryWhileMissing(async () => {
  calls++
  if (calls < 3) throw new Error(`Session abc not found in any project directory`)
  return 'renamed'
}, { sleep: async (ms) => { slept.push(ms) } })
ok(eventually === 'renamed', `a "not found" is waited out, not reported (${calls} attempts)`)
ok(slept.length === 2 && slept[0] === 100 && slept[1] === 200, `it backs off: ${slept.join(', ')}ms`)

let otherCalls = 0
const other = await retryWhileMissing(async () => {
  otherCalls++
  throw new Error('permission denied')
}, { sleep: async () => {} }).then(() => 'resolved', (e: Error) => e.message)
ok(other === 'permission denied', 'any OTHER error is reported at once')
ok(otherCalls === 1, `and not retried (${otherCalls} attempt)`)

const givesUp = await retryWhileMissing(
  async () => { throw new Error('not found') },
  { attempts: 3, sleep: async () => {} },
).then(() => 'resolved', (e: Error) => e.message)
ok(givesUp === 'not found', 'a session that never appears is still reported in the end')

await fs.rm(tmp, { recursive: true, force: true })
// An agent's session is filed under its WORKTREE, not under the workspace root,
// because that is the cwd it runs with. Reading it back must therefore not be
// scoped to the workspace directory — a session id is globally unique and the
// SDK searches every project when `dir` is omitted.
//
// This was wrong: transcript() passed `dir: workspaceRoot`, so it returned an
// empty transcript for exactly the agent sessions the board exists to show, and
// the chat view looked like a session that had never said anything.
if (list.length) {
  const id = list[0]!.id
  const fromHere = await store.transcript(id)
  // A store rooted somewhere with no sessions of its own must still find it.
  const elsewhere = new SessionStore(
    path.join(tmp, 'a-directory-with-no-sessions'),
    new MetaStore(tmp, 'other'),
  )
  const fromElsewhere = await elsewhere.transcript(id)
  ok(fromElsewhere.length === fromHere.length,
     `a session reads back the same from any workspace root (${fromElsewhere.length} vs ${fromHere.length} entries)`)
  if (fromHere.length) ok(fromElsewhere.length > 0, 'and is not silently empty — the bug this guards')
}

// --- delete reports whether it actually deleted -------------------------------
//
// This used to be `catch {}` returning void, so "Delete permanently" claimed the
// transcript was gone from Claude Code with no way of knowing. It can genuinely
// fail: delete a session another Claude Code window has OPEN and that window
// writes its state back out afterwards, leaving a stub that still shows in its
// history. The card left the board, the dialog said done, the session was there.
//
// Deleting a real session here would destroy the user's data, so this checks the
// contract on an id that does not exist — which is enough to catch a return to
// `Promise<void>` or a swallowed result.
const ghost = `ck-no-such-session-${Date.now()}`
const outcome = await store.delete(ghost)
ok(outcome !== undefined && typeof outcome === 'object',
   'delete() reports an outcome rather than returning void')
ok(typeof outcome.deleted === 'boolean', 'the outcome says whether it deleted')
ok(outcome.deleted === true, 'an id that is not there counts as deleted, with no reason attached')
ok(outcome.reason === undefined, 'and no spurious warning to show the user')

// --- a run the extension host never got to finish ----------------------------
//
// Reinstalling the extension, reloading the window or a crash kills every agent
// process mid-turn. Nothing can re-attach to them — they are gone — but the
// board must not go on showing those cards as ordinary idle sessions, because
// "it just stopped and said nothing" is indistinguishable from "it finished".
{
  const card = (id: string, extra: Partial<BoardSession> = {}): BoardSession => ({
    id, title: id, phase: 'implementing', tags: [], archived: false, pinned: false,
    updated: 0, ...extra,
  })

  const cut = interruptedSessions([
    card('was-running', { running: 1_700_000_000_000 }),
    card('finished-cleanly'),
    card('still-running-now', { running: 1_700_000_000_001 }),
  ], ['still-running-now'])

  ok(cut.get('was-running') === 1_700_000_000_000, 'a mark with no live agent is an interrupted run')
  ok(cut.has('finished-cleanly') === false, 'a run that ended cleared its mark, so it is not interrupted')
  // The one that would put an "interrupted" banner on a card working in front
  // of you. The live agent IS the run the mark refers to.
  ok(cut.has('still-running-now') === false, 'a session with a live agent is never interrupted')
  ok(cut.size === 1, `and nothing else is (${cut.size})`)

  ok(interruptedSessions([], []).size === 0, 'no sessions, nothing to report')
  ok(interruptedSessions([card('x', { running: 0 })], []).size === 0,
     'zero is how the mark is CLEARED, so it must not read as running')
}

// Put the environment back and take the throwaway trees with us. A test that
// leaves CLAUDE_CONFIG_DIR pointing at a deleted directory poisons whatever
// runs next in the same process.
if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
else process.env.CLAUDE_CONFIG_DIR = prevConfig
// --- an ADOPTED session from another runtime ---------------------------------
//
// The state every pre-existing Codex session on a real board is in: it appears
// because `foreign()` found it on disk, and there is NO sidecar entry, so
// `meta.runtime` is undefined. Everything that routed on `meta.runtime` alone
// therefore treated it as a Claude Code session. Measured on a real machine: 51
// of them, every one older than 30 days, none removable and none readable.
{
  const all = await store.list()
  const adopted = all.find((s) => s.id === CODEX_ID)
  ok(!!adopted, `an adopted Codex session is on the board (${all.length} sessions)`)
  ok(adopted?.runtime === 'codex', `and the board knows which runtime it belongs to (${adopted?.runtime})`)
  ok((await store.allMeta())[CODEX_ID] === undefined,
     'while having no sidecar entry at all — which is the whole difficulty')

  // Reading it. This routed through Claude Code's parser and came back empty,
  // so every one of those cards opened as a blank chat.
  const entries = await store.transcript(CODEX_ID)
  ok(entries.length > 0, `its transcript reads through the runtime that owns it (${entries.length} entries)`)
  ok(entries.some((e) => (e as { text?: string }).text === 'update the screening tabs'),
     'and it is the real conversation, not an empty list')

  // Deleting it. `deleteSession` is Claude Code's and knows only Claude Code's
  // store, so it reported success, dropped our sidecar row, and the card came
  // back on the next scan. A delete that cannot be seen to have happened is
  // worse than a refusal.
  const result = await store.delete(CODEX_ID)
  ok(result.deleted, `deleting it reports success: ${JSON.stringify(result)}`)
  const after = await store.list()
  ok(!after.some((s) => s.id === CODEX_ID),
     `and it STAYS gone — the card does not come back on the next scan (${after.length} left)`)
}

if (prevCodex === undefined) delete process.env.CODEX_HOME
else process.env.CODEX_HOME = prevCodex
await fs.rm(codexHome, { recursive: true, force: true })
await fs.rm(claudeHome, { recursive: true, force: true })
await fs.rm(repo, { recursive: true, force: true })
await fs.rm(tmp, { recursive: true, force: true })

console.log(fails === 0 ? 'PASS — the board reads Claude Code\'s real sessions' : `${fails} FAILURES`)
process.exit(fails === 0 ? 0 : 1)
