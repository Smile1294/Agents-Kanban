/* Account usage limits, read from every vendor's signal. What it guards: a
   reset time read in the wrong unit (seconds as ms is 1970, and the card
   resumes at once into the same limit), a context-window error mistaken for
   an account limit (a card parked that needed fixing), a guess drawn as a
   stated time, and a back-off that never grows. */
import {
  accountKey, BACKOFF_MS, durationMs, limitFromErrorText, limitFromPlanMeter, limitFromRetry,
  LimitTracker, nextClockTime, parseClaudeRateLimit, parseLimitMode, parseParked, resetTimeIn,
  RESUME_PROMPT, resumePrompt, isOfflineError, offlineReading, OFFLINE_RETRY_MS,
} from '../limits.ts'
import { parseSavedQueue } from '../manager.ts'
import { AgentSession } from '../session.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

// --- 1. Claude Code, the REAL frame (probed against a 2.1 CLI) ----------------
const nowS = 1790425412
const now = nowS * 1000
const real = {
  status: 'allowed', resetsAt: 1790439600, rateLimitType: 'five_hour', overageStatus: 'rejected',
  overageResetsAt: 1790812800, overageDisabledReason: 'org_level_disabled_until', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.33, resetsAt: 1790439600 }, seven_day: { utilization: 0.44, resetsAt: 1790452800 } },
}
const c = parseClaudeRateLimit(real, now)!
ok(c.status === 'ok', 'an allowed frame is ok')
ok(c.windows.length === 2 && c.windows[0]!.name === 'five_hour' && c.windows[0]!.used === 0.33,
   'the undeclared unifiedWindows are read, with their utilisation')
ok(c.windows[0]!.resetsAt === 1790439600 * 1000, 'resetsAt is SECONDS and becomes milliseconds')
ok(!c.resetsAt, 'an account that is not limited has no wake time')

const rej = parseClaudeRateLimit({ ...real, status: 'rejected' }, now)!
ok(rej.status === 'limited' && rej.resetsAt === 1790439600 * 1000 && /5-hour/.test(rej.detail ?? ''),
   'a rejected frame is limited until the window resets, and names the window')
ok(parseClaudeRateLimit({ ...real, status: 'rejected', isUsingOverage: true }, now)!.status === 'ok',
   'paying for overage is not being limited')
ok(parseClaudeRateLimit({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.91 }, now)!.windows[0]!.used === 0.91,
   'a warning without unifiedWindows still carries its one window')
ok(parseClaudeRateLimit({ status: 'banana' }, now) === undefined && parseClaudeRateLimit(null, now) === undefined,
   'a shape it cannot read is no reading, not a zero')

// --- 2. A plan meter (Codex) ------------------------------------------------
const plan = limitFromPlanMeter({ kind: 'plan', usedPercent: 100, windowMinutes: 300, resetsAt: nowS + 3600, secondary: { usedPercent: 40, windowMinutes: 10080, resetsAt: nowS + 86400 } }, now)!
ok(plan.status === 'limited' && plan.resetsAt === (nowS + 3600) * 1000, 'a full window is limited until it resets')
ok(plan.windows.map((w) => w.name).join() === '5h,7d', 'windows are named by their length')
ok(limitFromPlanMeter({ kind: 'plan', usedPercent: 85, windowMinutes: 300 }, now)!.status === 'warning', '85% is a warning')
ok(limitFromPlanMeter({ kind: 'usd', spentUsd: 3 }, now) === undefined, 'a dollar meter is not a limit reading')

// --- 3. Error text, from anyone --------------------------------------------
const d = new Date(now)
const cases: Array<[string, number | 'none' | 'estimate']> = [
  ['Claude AI usage limit reached|1790439600', 1790439600 * 1000],
  ["You've hit your usage limit. Upgrade to Pro or try again in 1 hour 23 minutes.", now + (83 * 60_000)],
  ['Rate limit reached for gpt-5 in organization org-x on tokens per min. Please try again in 20s.', now + 20_000],
  ['429 RESOURCE_EXHAUSTED: Quota exceeded for metric generate_content. Please retry in 32.5s.', now + 32_500],
  ['429 Too Many Requests', 'estimate'],
  ['Retry-After: 30 — too many requests', now + 30_000],
]
for (const [text, want] of cases) {
  const r = limitFromErrorText(text, now)
  if (want === 'estimate') ok(!!r && r.status === 'limited' && !r.resetsAt, `"${text}" is a limit with no stated reset`)
  else ok(!!r && r.resetsAt === want, `"${text}" → reset ${r?.resetsAt ? new Date(r.resetsAt).toISOString() : 'none'}`)
}
ok(!/\|1790439600/.test(limitFromErrorText('Claude AI usage limit reached|1790439600', now)!.detail ?? ''), 'the epoch is not shown to the user')
for (const text of ['prompt is too long: 250000 tokens > 200000 maximum', 'API Error: 529 overloaded_error', 'ENOENT: no such file', 'context window exceeded (rate limit of context)']) {
  ok(limitFromErrorText(text, now) === undefined, `"${text}" is NOT an account limit`)
}

// A clock time, in the zone the vendor named — independent of this machine's.
{
  const t = resetTimeIn("You've hit your limit · resets 3pm (Europe/Prague)", now)!
  const wall = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t))
  ok(wall === '15:00' && t > now && t - now <= 86_400_000, `"resets 3pm (Europe/Prague)" is the next 15:00 in Prague (${wall}, in ${Math.round((t - now) / 60000)}m)`)
  const t2 = resetTimeIn('Usage limit reached. Try again at 3:05 PM.', now)!
  const local = new Date(t2)
  ok(local.getHours() === 15 && local.getMinutes() === 5 && t2 > now, 'a clock time with no zone is this machine\'s')
  ok(nextClockTime(d.getHours(), d.getMinutes(), now) > now, 'a clock time equal to now is TOMORROW, never the past')
  ok(!!resetTimeIn('limit reached, resets at 2026-09-26T18:00:00Z', now), 'an ISO time is read')
}
ok(durationMs('2h5m') === 2 * 3_600_000 + 5 * 60_000 && durationMs('soon') === undefined, 'durations sum; nonsense is nothing')

// --- the CLI retrying on a 429 is a warning, never a park --------------------
ok(limitFromRetry({ error_status: 429, retry_delay_ms: 8000, attempt: 2, max_retries: 10 }, now)!.status === 'warning', 'a 429 retry is a warning')
ok(limitFromRetry({ error_status: 500 }, now) === undefined, 'a 500 retry is not about the account')

// --- the tracker -------------------------------------------------------------
{
  const t = new LimitTracker()
  const key = accountKey('claude', '')
  ok(key === 'claude|', 'an account is runtime and backend')
  const a = t.record(key, limitFromErrorText('429 Too Many Requests', now)!)
  ok(a.estimated === true && a.resetsAt === now + BACKOFF_MS, 'no stated reset: a back-off, marked as an estimate')
  const b = t.record(key, limitFromErrorText('429 Too Many Requests', now + 1)!)
  ok(b.resetsAt === now + 1 + 2 * BACKOFF_MS, 'and it DOUBLES when it happens again')
  ok(t.limitedUntil(key, now + 10) === b.resetsAt && t.limitedUntil(key, b.resetsAt! + 1) === undefined, 'limited until the reset, then not')
  t.record(key, c)
  ok(t.get(key)!.status === 'ok' && t.limitedUntil(key, now) === undefined, 'a request that went through clears the limit')
  const again = t.record(key, limitFromErrorText('429', now + 5)!)
  ok(again.resetsAt === now + 5 + BACKOFF_MS, '…and the back-off starts over')
  ok(t.get(key)!.windows.length === 2, 'a reading with no windows keeps the ones we knew')
  const stated = t.record(key, rej)
  t.record(key, limitFromErrorText('usage limit reached', now + 10)!)
  ok(t.get(key)!.resetsAt === stated.resetsAt && !t.get(key)!.estimated, 'a vaguer report does not replace a stated reset')
  t.lift(key, now + 99)
  ok(t.limitedUntil(key, now) === undefined && t.get(key)!.status === 'ok', 'lifting ends the limit and keeps the windows')
}

// --- the sidecar record --------------------------------------------------------
{
  const p = { until: now, account: 'claude|', reason: 'x', attempts: 2, auto: false, estimated: true }
  ok(JSON.stringify(parseParked(JSON.parse(JSON.stringify(p)))) === JSON.stringify(p), 'a parked record round-trips')
  ok(parseParked({ until: 'soon', account: 'x' }) === undefined && parseParked({ until: 5 }) === undefined, 'a bad one is rejected whole')
  ok(parseParked({ until: 5, account: 'a' })!.auto === true, 'auto-resume is the default')
  const withTasks = parseParked({ until: 5, account: 'a', stoppedTasks: ['Research X', 42, '', 'Audit Y'] })!
  ok(withTasks.stoppedTasks?.join('|') === 'Research X|Audit Y', 'stopped background agents are read back, junk dropped')
}

// --- offline at a resume: the network, not the account --------------------------
// The two strings are what a real Claude Code 2.1.283 printed with its API URL
// pointed at a dead port, and through a proxy that refused the tunnel.
for (const t of ['API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
  "API Error: Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused the tunnel: check its credentials and that it allows this host",
  'getaddrinfo ENOTFOUND api.anthropic.com', 'TypeError: fetch failed']) {
  ok(isOfflineError(t), `"${t.slice(0, 50)}…" is the network being down`)
}
ok(!isOfflineError('Claude AI usage limit reached|1790439600') && !isOfflineError('TypeError: x is undefined') && !isOfflineError(''),
   'a limit, or an ordinary error, is not "offline"')
{
  const o = offlineReading('API Error: Connection refused (ECONNREFUSED)\nmore', now)
  ok(o.status === 'limited' && o.source === 'offline' && o.estimated === true && o.resetsAt === now + OFFLINE_RETRY_MS && o.detail!.endsWith('Connection refused (ECONNREFUSED)'),
     'an offline resume holds the account for the retry interval, marked as a guess, with the error\'s first line')
}

// --- the saved queue ----------------------------------------------------------------
{
  const back = parseSavedQueue([
    { prompt: 'Fix login', queuedAt: 5, title: 'Fix login', runtime: 'codex', provider: 'dsk', orchestration: 'maximum',
      chosen: { model: 'm', effort: 'max', thinking: 'disabled', ultracode: true, bogus: 1 }, images: 2, resume: 'sess-1' },
    { prompt: '' }, { title: 'no prompt' }, 'junk', null,
    { prompt: 'Other', runtime: 'gemini', orchestration: 'banana', chosen: { effort: 'ludicrous' } },
  ])
  ok(back.length === 2, 'entries without a prompt, and junk, are dropped')
  ok(back[0]!.runtime === 'codex' && back[0]!.provider === 'dsk' && back[0]!.chosen?.effort === 'max' && back[0]!.chosen?.ultracode === true
     && !('bogus' in back[0]!.chosen!) && back[0]!.images === 2 && back[0]!.resume === 'sess-1' && back[0]!.queuedAt === 5,
     'a saved entry is read back field by field')
  ok(back[1]!.runtime === undefined && back[1]!.orchestration === undefined && back[1]!.chosen === undefined,
     'an unknown runtime, level or effort from another build is dropped, not cast')
  ok(parseSavedQueue(undefined).length === 0 && parseSavedQueue({}).length === 0, 'no saved queue is an empty one')
}

// --- the resume message, and the setting ----------------------------------------
ok(resumePrompt(undefined) === RESUME_PROMPT && resumePrompt({}) === RESUME_PROMPT, 'nothing stopped: the plain resume')
{
  const t = resumePrompt({ stoppedTasks: ['Research the payments API'] })
  ok(t.startsWith(RESUME_PROMPT) && t.includes('this background agent was') && t.includes('- Research the payments API')
     && /will not report back/.test(t) && /Launch again/.test(t), 'one stopped agent is named, with "do not wait for it"')
  ok(resumePrompt({ stoppedTasks: ['a', 'b'] }).includes('these 2 background agents were'), 'several are counted')
}
ok(parseLimitMode('pause') === 'pause' && parseLimitMode('off') === 'off' && parseLimitMode(undefined) === 'resume' && parseLimitMode('banana') === 'resume',
   'usageLimits: pause and off are read; anything else is the default, resume')

// --- the session hands both frames to the host, raw ------------------------------
{
  const session = new AgentSession({
    taskId: 'run-1', cwd: '/tmp/nowhere', permissionMode: 'acceptEdits',
    boardServer: { type: 'sdk', name: 'board', instance: {} } as never,
  })
  session.on('error', () => {})
  const seen: Array<{ raw: unknown; retry?: boolean }> = []
  session.on('limit', (raw: unknown, retry?: boolean) => seen.push({ raw, ...(retry ? { retry } : {}) }))
  const feed = (msg: unknown) => (session as unknown as { handle: (m: unknown) => void }).handle(msg)
  feed({ type: 'rate_limit_event', rate_limit_info: real, uuid: 'u', session_id: 's' })
  feed({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 5000, error_status: 429, error: 'rate_limit', uuid: 'u', session_id: 's' })
  ok(seen.length === 2 && seen[0]!.raw === real && !seen[0]!.retry, 'a rate_limit_event reaches the host with its info untouched')
  ok(seen[1]!.retry === true && limitFromRetry(seen[1]!.raw, now)!.status === 'warning', 'an api_retry reaches it marked as a retry')
  // A SUBAGENT spends the same account: its retry must reach the host too,
  // not vanish into the subagent routing (which returns early).
  feed({ type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 9000, error_status: 429, error: 'rate_limit', parent_tool_use_id: 'toolu_task', uuid: 'u', session_id: 's' })
  ok(seen.length === 3 && seen[2]!.retry === true, 'a subagent\'s 429 retry reaches the host as well')
}

if (fails) { console.log(`${fails} failure(s)`); process.exit(1) }
console.log('PASS — usage limits are read from every vendor\'s signal')
