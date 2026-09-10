/**
 * The pure half of Remote Control: what leaves this machine and how it is
 * addressed. The engine that decides WHEN things leave lives in pusher.ts and
 * is tested there; this file pins the payload SHAPE — the split between the
 * frame and the model list, the remote mic, and the two things that must never
 * leave (the pairing code, provider credentials).
 *
 * Relay v2 is the FULL board: a frame is the same `UiState` the local webview
 * paints, so there is no redaction to enumerate field-by-field the way v1's
 * index was. The assertions that remain are the two boundaries that still
 * matter — `composer.models` is split out (not duplicated inside the state),
 * and the state carries no field a secret could ride in. The second is checked
 * on the SHAPE of the composer, not by scanning the payload for token-shaped
 * words: the board's own text is the user's and travels verbatim.
 */
import {
  boardIdOf,
  forRemote,
  relayBase,
  relayUrlProblem,
  remoteFrame,
  type RemoteFrame,
  type RemoteModel,
  type RemoteVoice, PAIRING_CODE_MIN, newPairingCode, pairingCodeProblem,
} from '../relay.ts'
import type { UiState } from '../../board/panel.ts'

let fails = 0
function ok(cond: unknown, what: string): void {
  if (cond) console.log(`ok: ${what}`)
  else { fails++; console.error(`FAIL: ${what}`) }
}

const VOICE_OK: RemoteVoice = { available: true }
const MODELS: RemoteModel[] = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5', context: '200K', price: '$3/$15' },
  { id: 'claude-opus-5', label: 'Opus 5', context: '200K', price: '$15/$75' },
]

/** A minimal but type-honest `UiState`. The remote frame is the full state, so
 *  the tests need a real one — but nothing here needs a transcript or a board. */
const state = (over: Partial<UiState> = {}): UiState => ({
  ready: true,
  mode: 'kanban',
  columns: [{ id: 'impl', name: 'Implementing', category: 'started' }],
  cards: [
    {
      key: 'abc', title: 'Fix the login bug', phase: 'implementing',
      tags: ['auth', 'bug-fix'], updated: 5000,
      runtime: 'claude-code',
      agent: { kind: 'working', tool: 'Bash', contextTokens: 12_000 },
    },
  ],
  composer: {
    model: 'claude-sonnet-5',
    effort: 'high',
    thinking: 'enabled',
    efforts: [{ key: 'low', label: 'Low' }, { key: 'high', label: 'High' }],
    permissionMode: 'default',
    permissionModes: [{ key: 'default', label: 'Default', detail: '' }],
    agent: 'claude|anthropic',
    agents: [{ key: 'claude|anthropic', label: 'Claude Code', detail: '', runtime: 'claude', provider: 'anthropic' }],
    runtime: 'claude',
    runtimes: [{ id: 'claude', label: 'Claude Code', providerProfiles: true }],
    provider: 'anthropic',
    providers: [{ id: 'anthropic', label: 'Anthropic', detail: '', support: 'official' }],
    contextTokens: 0,
  },
  running: 0,
  waiting: 0,
  ...over,
})

// --- boardIdOf ---------------------------------------------------------------

{
  const a = boardIdOf('hunter2'), b = boardIdOf('hunter3')
  ok(a.length === 24 && /^[0-9a-f]+$/.test(a), 'the board id is 24 hex chars of a sha-256')
  ok(a !== b, 'a different code is a different board')
  ok(boardIdOf('hunter2') === a, 'the same code is the same board, always')
  ok(a !== 'hunter2', 'the id is a hash, not the code — the code itself is never an address')
}

// --- forRemote: the mic is the phone's --------------------------------------

{
  const builtin = state({ composer: { voice: { mode: 'builtin', available: true } } as UiState['composer'] })
  const remote = forRemote(builtin, VOICE_OK)
  ok(remote.composer.voice?.mode === 'whisper' && remote.composer.voice.available === true,
    'a built-in mic is replaced by the whisper path — there is no built-in dictation on a phone')
  ok(builtin.composer.voice?.mode === 'builtin', 'the original state is not mutated')
}

{
  const whisper = state({ composer: { voice: { mode: 'whisper', available: false, why: 'no whisper-cli' } } as UiState['composer'] })
  const remote = forRemote(whisper, { available: false, why: 'no whisper-cli' })
  ok(remote.composer.voice?.mode === 'whisper' && remote.composer.voice.available === false
    && remote.composer.voice.why === 'no whisper-cli',
    'an unavailable whisper path carries its why — the page shows the fix')
}

// --- remoteFrame: the models split ------------------------------------------

{
  const frame = remoteFrame(state(), MODELS, '7', VOICE_OK)
  ok(frame.mv === '7', 'the frame carries the catalogue version key')
  ok(frame.state.composer.models === undefined, 'composer.models is split OUT of the state, not duplicated')
  ok(frame.models !== undefined && frame.models.length === 2 && frame.models[0]!.id === 'claude-sonnet-5',
    'the split-out list rides in `models`, ids labels and prices intact')
  ok(frame.state.composer.voice?.mode === 'whisper', 'the remote mic rides inside the frame state')
  ok(frame.state.cards[0]!.title === 'Fix the login bug', 'the full card travels — a frame is the whole board')
}

{
  const noModels = remoteFrame(state(), undefined, '7', VOICE_OK)
  ok(noModels.models === undefined, 'no models due means no `models` field at all — absent, not empty')
  const empty = remoteFrame(state(), [], '7', VOICE_OK)
  ok(empty.models === undefined, 'an empty list is also absent — the page keeps what it has')
}

// --- the two things that must never leave -----------------------------------

/**
 * v1 scanned the whole serialised frame for token-shaped WORDS. That check
 * cannot survive v2 and was self-contradictory the moment it landed: the frame
 * is the FULL board, so a card the user titled `Rotate the AUTH_TOKEN` puts
 * `AUTH_TOKEN` in the payload as USER CONTENT — and the block asserted both
 * that the text travels and that the word is absent. One of the two had to be
 * false. Redacting it was never the answer either: a filter that rewrites card
 * titles mangles the board to hide a word that is not a secret.
 *
 * The real guarantee is STRUCTURAL, so that is what is asserted. A credential
 * lives in `SecretStorage` and reaches only the CLI's environment; `UiState`
 * carries provider CHOICES (`id`/`label`/`detail`/`support`) and boolean flags,
 * never a secret value — so a frame built from it cannot carry one. The
 * key-set check is deliberately strict: any NEW field on a provider choice
 * fails it, because a field that travels to a phone is worth one deliberate
 * look before it is allowed through.
 */
{
  const pairCode = 'S9f3-qWx7.pairingCode!'
  const withSecretShape = state({
    cards: [{
      key: 'abc', title: 'Rotate the AUTH_TOKEN', phase: 'implementing',
      tags: [], updated: 1, runtime: 'claude-code',
      agent: { kind: 'working', tool: 'Bash', contextTokens: 0 },
    }],
  })
  const frame: RemoteFrame = remoteFrame(withSecretShape, MODELS, '7', VOICE_OK)
  const serial = JSON.stringify(frame)

  const ALLOWED = ['id', 'label', 'detail', 'support']
  const providers = frame.state.composer.providers
  ok(providers.length > 0 && providers.every(p => Object.keys(p).every(k => ALLOWED.includes(k))),
    `a provider choice carries only ${ALLOWED.join('/')} — no field a secret could ride in`)
  ok(providers.every(p => Object.entries(p).every(
    ([k, v]) => !/credential|key|token|secret|password/i.test(k) || typeof v === 'boolean')),
    'anything credential-shaped on a provider is a FLAG, never a string — a value never leaves')

  ok(!serial.includes(pairCode) && !serial.includes('S9f3-qWx7'),
    'the pairing code never appears in the frame — only its hash addresses the board')
  ok(serial.includes('Rotate the AUTH_TOKEN'),
    'user card text travels VERBATIM, token-shaped words and all — the frame is the FULL board')
  const round: RemoteFrame = JSON.parse(serial)
  ok(round.mv === '7' && round.state.cards[0]!.key === 'abc', 'the frame round-trips through JSON, as over the wire')
}

// --- relayBase ---------------------------------------------------------------

ok(relayBase('https://board.example.com') === 'https://board.example.com', 'a bare https URL passes')
ok(relayBase('board.example.com') === 'https://board.example.com', 'a missing scheme is https')
ok(relayBase('  https://board.example.com/  ') === 'https://board.example.com', 'whitespace and a slash trim')
ok(relayBase('https://board.example.com/.netlify/functions/board') === 'https://board.example.com',
  'a pasted function path normalises to the site root')
ok(relayBase('https://board.example.com/foo/.netlify/functions/board') === 'https://board.example.com/foo',
  'a subpath before the function path is kept')
ok(relayBase('https://board.example.com/board') === 'https://board.example.com',
  'the common /board API path normalises to the site root')
ok(relayBase('https://board.example.com/foo/board') === 'https://board.example.com/foo',
  'a subpath before /board is kept')
ok(relayBase('https://board.example.com/board/') === 'https://board.example.com',
  '…trailing slash and all')
ok(relayBase('') === undefined && relayBase('   ') === undefined, 'blank is undefined')
ok(relayBase('not a url') === undefined && relayBase('ftp://x.com') === undefined,
  'unparseable and non-http schemes are refused')

// --- http is not a scheme choice, it is the board in the clear ---------------
//
// The frame is the FULL board — every transcript, worktree path and branch
// name — and the board id it travels under is read AND write. On http both are
// readable by anything between here and the relay, and the id is a capability:
// reading it once is having it forever.

ok(relayBase('http://board.example.com') === undefined,
  'a cleartext relay host is refused, not quietly accepted')
ok(/https/.test(relayUrlProblem('http://board.example.com') ?? ''),
  'and the refusal names the fix')
ok(/clear|write/.test(relayUrlProblem('http://board.example.com') ?? ''),
  'and why — the board AND the key to it travel')
ok(relayBase('http://localhost:8787') === 'http://localhost:8787',
  'but a relay on this machine is fine on http — it crosses no network')
ok(relayBase('http://127.0.0.1:8787/board') === 'http://127.0.0.1:8787',
  '…by IP too, normalised like any other')
ok(relayBase('http://evil.example.com/?host=localhost') === undefined,
  'loopback is matched on the HOSTNAME, never on the URL text')
ok(relayUrlProblem('https://board.example.com') === undefined,
  'https has no problem to report')
ok(relayUrlProblem('') !== undefined && relayBase('') === undefined,
  'blank is refused by both faces of the same decision')
ok(relayUrlProblem('ftp://x.com') !== undefined,
  'and the two faces agree on the scheme case as well')

/* --- the pairing code IS the board -------------------------------------------
   The board's address on the relay is `sha256(code)` truncated, and that
   address is read AND write access: a GET returns every transcript, worktree
   path and branch name, and with writes on a POST drives the machine. The
   mapping is public, deterministic, unsalted and cheap, so the id's search
   space is not the digest's 96 bits — it is exactly the entropy of the code
   somebody typed, and the relay has no throttle to make guessing expensive.
   The header of board-core.mjs used to claim "~96 bits. Nobody guesses one". */
{
  ok(pairingCodeProblem('kanban2026') !== undefined,
     'a code a person would think of is REFUSED')
  ok(/at least/.test(pairingCodeProblem('short') ?? ''), 'and told how long it must be')
  ok(/offline/.test(pairingCodeProblem('short') ?? ''),
     'and WHY — a rule with no reason is a rule people work around')
  ok(pairingCodeProblem('') !== undefined, 'and a blank one is refused too')
  ok(pairingCodeProblem('a'.repeat(PAIRING_CODE_MIN)) === undefined,
     'a long enough one is accepted — this is a floor, not a strength meter')

  const made = newPairingCode()
  ok(pairingCodeProblem(made) === undefined, 'the generated code passes its own floor')
  ok(made.length >= 16, `and is long (${made.length} chars)`)
  ok(!/[^A-Za-z0-9_-]/.test(made), 'url-safe, so it survives being pasted into the relay page')
  const many = new Set(Array.from({ length: 200 }, () => newPairingCode()))
  ok(many.size === 200, 'and 200 of them are 200 different codes, not a counter')
  ok(new Set([...many].map((c) => boardIdOf(c))).size === 200,
     'each naming its own board')
}

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('relay: all ok')
