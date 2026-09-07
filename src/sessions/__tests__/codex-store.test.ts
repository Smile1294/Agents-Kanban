/* Reading Codex's session store back off disk.
 *
 * The rule under test is the one every runtime has to satisfy: **a number the
 * board shows must not depend on a process being alive.** A VS Code restart
 * kills every agent at once, and what the board shows afterwards — the
 * transcript, the context meter, the rate-limit meter — has to come from the
 * runtime's own files.
 *
 * The fixture is a real rollout in Codex's real format, byte for byte the
 * shapes taken from an actual `~/.codex/sessions/**\/rollout-*.jsonl` on a
 * machine that uses Codex: `{timestamp, type, payload}` records, `session_meta`
 * first, `event_msg`/`response_item` after, `custom_tool_call_output` carrying
 * its metadata as a JSON string inside a JSON string. It is written into a
 * throwaway `CODEX_HOME` rather than read from the machine, so the numbers
 * asserted below are KNOWN — the same standard `smoke.mjs` holds itself to, and
 * for the same reason: a test that reads whatever happens to be on this laptop
 * asserts nothing anyone else can reproduce.
 *
 * The two assertions that matter most are at the end. Both are about what the
 * page must NOT say: a session that was cut off must not leave a tool row
 * ticking forever, and a subscription session must not produce a dollar figure.
 */
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { codexHistory, codexHome, parseRollout, _resetCodexCaches } from '../codex-store.ts'
import { MetaStore } from '../meta.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const rec = (type: string, payload: unknown, at = '2026-09-05T10:00:00.000Z') =>
  JSON.stringify({ timestamp: at, type, payload })

/** A rollout with known contents. Every shape here is one observed in a real file. */
function rollout(cwd: string): string {
  return [
    // `instructions` is the part the fixture used to leave out, and leaving it
    // out is why a critical bug survived every green run of this file.
    //
    // A real `session_meta` embeds the WHOLE Codex system prompt. Measured
    // against every rollout in a real `~/.codex`: the first line is 22,168 to
    // 22,385 bytes. `firstLine()` read a single fixed 8,192-byte buffer, found
    // no newline in it, and returned undefined — so `list()` skipped every
    // rollout Codex has ever written and returned an EMPTY LIST. Since
    // `SessionStore.foreign()` is the only source of a card for a non-Claude
    // session, every Codex card vanished from the board the moment the manager
    // stopped holding it in memory. Verified against the real files: 0 of 5
    // readable before the fix, 5 of 5 after.
    //
    // So the fixture is now honest about its own claim to be "byte for byte the
    // shapes taken from an actual rollout": the padding is what makes this file
    // able to fail.
    rec('session_meta', {
      id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd,
      originator: 'codex_vscode', cli_version: '0.151.0', model_provider: 'openai',
      instructions: 'You are Codex. ' + 'Follow the user instructions carefully. '.repeat(600),
    }),
    rec('turn_context', { model: 'gpt-5.5', cwd, approval_policy: 'never' }),
    // The system preamble Codex replays into every session. It must NOT appear
    // in the transcript, or every card opens with several thousand words the
    // user did not write.
    rec('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>…</permissions instructions>' }] }),
    rec('event_msg', { type: 'user_message', message: 'add a health check', images: [] }),
    rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Looking at the routes now.' }], phase: 'commentary' }),
    rec('response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"npm test"}', call_id: 'call_1' }),
    rec('response_item', { type: 'function_call_output', call_id: 'call_1', output: '{"output":"ok","metadata":{"exit_code":0,"duration_seconds":2.5}}' }),
    rec('response_item', { type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch', call_id: 'call_2', status: 'completed' }),
    rec('response_item', { type: 'custom_tool_call_output', call_id: 'call_2', output: '{"output":"Success.","metadata":{"exit_code":1,"duration_seconds":0.1}}' }),
    rec('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 99999, output_tokens: 8888, total_tokens: 108887 },
        last_token_usage: { input_tokens: 14041, cached_input_tokens: 12160, output_tokens: 229, total_tokens: 14270 },
        model_context_window: 258400,
      },
      rate_limits: {
        plan_type: 'plus',
        primary: { used_percent: 13, window_minutes: 300, resets_at: 1778984752 },
        secondary: { used_percent: 2, window_minutes: 10080 },
      },
    }),
    // A call with no output: the turn was cut off.
    rec('response_item', { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"sleep 900"}', call_id: 'call_3' }),
    rec('event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
    '',
  ].join('\n')
}

async function main(): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), 'ak-codexhome-'))
  const repo = await mkdtemp(path.join(tmpdir(), 'ak-repo-'))
  const worktree = path.join(repo, '.agentskanban', 'worktrees', 'S1-thing')
  const prevHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = home

  ok(codexHome() === home, 'CODEX_HOME is honoured, so this test never reads the real store')

  const day = path.join(home, 'sessions', '2026', '09', '05')
  await mkdir(day, { recursive: true })
  await writeFile(
    path.join(day, 'rollout-2026-09-05T10-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
    rollout(worktree),
    'utf8',
  )
  await writeFile(
    path.join(home, 'session_index.jsonl'),
    `${JSON.stringify({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', thread_name: 'Add a health check', updated_at: '2026-09-05T10:05:00.000Z' })}\n`,
    'utf8',
  )
  _resetCodexCaches()

  // --- listing --------------------------------------------------------------
  // The cwd is a WORKTREE, not the repo root. An equality test would drop every
  // agent session from the board the moment it started — the exact bug
  // `includeWorktrees: true` exists to prevent on the Claude side.
  const listed = await codexHistory.list(repo)
  ok(listed.length === 1, `a session in a worktree is listed against the repo root (${listed.length})`)
  ok(listed[0]?.title === 'Add a health check', `the title comes from Codex's own index (${listed[0]?.title ?? '-'})`)
  ok(listed[0]?.cwd === worktree, 'and it remembers which worktree it belongs to')

  const elsewhere = await codexHistory.list(`${repo}-backup`)
  ok(elsewhere.length === 0, 'and a repo whose path is a PREFIX of this one is not matched')

  // --- the transcript -------------------------------------------------------
  const entries = await codexHistory.transcript('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  const kinds = entries.map((e) => (e as { kind: string }).kind)
  ok(kinds.includes('prompt'), `the user's message is there (${kinds.join(', ')})`)
  const prompts = entries.filter((e) => (e as { kind: string }).kind === 'prompt')
  ok(prompts.length === 1, `and ONLY the user's — the developer preamble stays out (${prompts.length})`)
  ok((prompts[0] as { text: string }).text === 'add a health check', 'and it is what they actually typed')

  const text = entries.filter((e) => (e as { kind: string }).kind === 'text')
  ok(text.length === 1 && (text[0] as { text: string }).text === 'Looking at the routes now.',
    `the assistant's reply is rendered once (${text.length})`)

  const tools = entries.filter((e) => (e as { kind: string }).kind === 'tool') as Array<{ name: string; status: string; durationMs?: number }>
  ok(tools.length === 3, `every tool call has a row (${tools.length})`)
  ok(tools[0]?.name === 'Bash', `Codex's exec_command reads as Bash (${tools[0]?.name})`)
  ok(tools[0]?.status === 'ok' && tools[0]?.durationMs === 2500,
    `a zero exit resolves to a tick, with its duration (${tools[0]?.status}, ${tools[0]?.durationMs}ms)`)
  ok(tools[1]?.name === 'Edit', `apply_patch reads as Edit (${tools[1]?.name})`)
  ok(tools[1]?.status === 'error', 'and a non-zero exit inside the nested output is a cross')

  // The one that matters. A row left `running` on a session with no process
  // would tick a timer forever; marked `ok` it would claim a result nobody saw.
  ok(tools[2]?.status === 'error', `a call whose output never arrived is not left running (${tools[2]?.status})`)

  const notices = entries.filter((e) => (e as { kind: string }).kind === 'notice')
  ok(notices.length === 1 && /interrupt/i.test((notices[0] as { message: string }).message),
    'the abort is recorded as a notice rather than vanishing')

  // --- usage ----------------------------------------------------------------
  const usage = await codexHistory.usage('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
  // `last_token_usage`, never `total_token_usage`: the cumulative figure would
  // read 108,887 against a 258,400 window on a session holding 14,270 — the
  // same trap the Claude meter documents.
  ok(usage.contextTokens === 14270, `context fill is the LAST turn, not the session total (${usage.contextTokens})`)
  ok(usage.contextWindow === 258400, `the window survives the process that reported it (${usage.contextWindow})`)

  // A ChatGPT subscription bills nothing per request. `$0.00` here would be a
  // number that cannot say "bad"; a percentage of a rolling window is the
  // number the indicator is actually derived from.
  ok(usage.meter.kind === 'plan', `spend is a plan meter, not dollars (${usage.meter.kind})`)
  if (usage.meter.kind === 'plan') {
    ok(usage.meter.usedPercent === 13 && usage.meter.windowMinutes === 300,
      `with the window it belongs to (${usage.meter.usedPercent}% of ${usage.meter.windowMinutes}m)`)
    ok(usage.meter.secondary?.windowMinutes === 10080, 'and the weekly window beside it')
    ok(usage.meter.plan === 'plus', 'and the plan it is measured against')
  }

  // --- a session that is not there -----------------------------------------
  const missing = await codexHistory.usage('ffffffff-0000-0000-0000-000000000000')
  ok(missing.meter.kind === 'unknown' && missing.contextTokens === 0,
    'an unknown session reads as unknown rather than as zero spend')

  // --- garbage in ----------------------------------------------------------
  // Another program's output. One bad line must not lose the file.
  const damaged = parseRollout(['{not json', rec('event_msg', { type: 'user_message', message: 'still here' }), '{"type":'].join('\n'))
  ok(damaged.entries.length === 1, `an unparseable line is skipped, not fatal (${damaged.entries.length} kept)`)

  // --- the sidecar round trip ----------------------------------------------
  // "Anything persisted must be READ BACK by a test, not just written."
  // `contextWindow` was written by every run and missing from the parse for its
  // whole life; a runtime id lost the same way would bring a card back on the
  // wrong agent, with an empty transcript, after every restart.
  {
    const store = await mkdtemp(path.join(tmpdir(), 'ak-meta-'))
    const meta = new MetaStore(store, repo)
    await meta.update('sess-1', { runtime: 'codex' })
    const fresh = new MetaStore(store, repo)
    const back = await fresh.get('sess-1')
    ok(back.runtime === 'codex', `a session's runtime survives a reload (${back.runtime ?? 'lost'})`)

    await fresh.update('sess-2', { runtime: 'a-runtime-from-the-future' as never })
    const bogus = await new MetaStore(store, repo).get('sess-2')
    ok(bogus.runtime === undefined,
      `an id this build cannot serve is parsed away, not handed to the render path (${String(bogus.runtime)})`)
    await rm(store, { recursive: true, force: true })
  }

  // --- the filesystem walk must not repeat per repaint ----------------------
  //
  // `rolloutFiles()` readdirs `sessions/` and every year/month/day directory
  // under it, and the store is global to the MACHINE, not per project.
  // `list()` caps and caches; `load()` did neither — and `getState()` calls it
  // TWICE per repaint for a selected Codex card, on the path `refreshAll()`
  // drives per streamed token. That is the cost the coalescer exists to bound,
  // reintroduced underneath it.
  {
    const started = Date.now()
    // Two concurrent readers must share ONE walk, which is exactly the shape
    // `getState()` produces.
    const [entries, usage] = await Promise.all([
      codexHistory.transcript('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
      codexHistory.usage('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    ])
    ok(entries.length > 0, 'two concurrent reads of one session both get the transcript')
    ok(usage.contextTokens > 0, 'and both get the usage')
    for (let k = 0; k < 40; k++) await codexHistory.transcript('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    ok(Date.now() - started < 2000, `40 further reads stay cheap (${Date.now() - started}ms)`)
    // An id the cached walk has never seen must still resolve to "nothing"
    // rather than throwing, and must not poison the cache for real ids.
    ok((await codexHistory.transcript('ffffffff-ffff-ffff-ffff-ffffffffffff')).length === 0,
       'an id that does not exist is empty, not an error')
    ok((await codexHistory.transcript('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).length > 0,
       'and the real session is still readable afterwards')
  }

  // --- deleting a session, which the board could not do at all ---------------
  //
  // `SessionStore.delete()` calls Claude Code's `deleteSession` on ANY id, then
  // verifies with Claude Code's `getSessionInfo` — which of course reports a
  // Codex uuid as gone. So the board reported a successful delete, dropped the
  // sidecar entry, and the card came straight back on the next scan because the
  // rollout was untouched. Measured on a real machine: 51 Codex sessions, every
  // one older than 30 days, none of them removable.
  //
  // A runtime that owns its own history has to own deleting from it.
  {
    const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    ok(typeof codexHistory.delete === 'function', 'the Codex runtime can delete from its own store')
    ok((await codexHistory.list(repo)).length === 1, 'the session is there to begin with')
    ok((await codexHistory.delete!(id)) === true, 'deleting it reports success')
    _resetCodexCaches()
    ok((await codexHistory.list(repo)).length === 0, 'and it is GONE from the listing, not just from our sidecar')
    ok((await codexHistory.transcript(id)).length === 0, 'its transcript is gone too')
    // The index is Codex's own resume list. Leaving the entry behind would put
    // a dangling row in `codex resume` pointing at a file that no longer exists.
    const index = await readFile(path.join(home, 'session_index.jsonl'), 'utf8').catch(() => '')
    ok(!index.includes(id), `the session_index entry is pruned as well: ${JSON.stringify(index.trim().slice(0, 60))}`)
    // Deleting what is not there is not an error — two board windows, or a
    // double click on a batch, must not produce a failure dialog.
    ok((await codexHistory.delete!('ffffffff-ffff-ffff-ffff-ffffffffffff')) === false,
       'deleting an id that does not exist answers false rather than throwing')
  }

  if (prevHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = prevHome
  await rm(home, { recursive: true, force: true })
  await rm(repo, { recursive: true, force: true })

  console.log(fails ? `\n${fails} failed` : '\nall passed')
  process.exit(fails ? 1 : 0)
}

void main()
