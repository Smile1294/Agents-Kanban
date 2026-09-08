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
 * and no secret is anywhere in the serialised frame.
 */
import {
  boardIdOf,
  forRemote,
  relayBase,
  remoteFrame,
  type RemoteFrame,
  type RemoteModel,
  type RemoteVoice,
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
  ok(!serial.includes('credential') && !serial.includes('apiKey')
    && !serial.includes('ANTHROPIC_API_KEY') && !serial.includes('AUTH_TOKEN'),
    'no credential or key token is anywhere in the serialised frame')
  ok(!serial.includes(pairCode) && !serial.includes('S9f3-qWx7'),
    'the pairing code never appears in the frame — only its hash addresses the board')
  ok(serial.includes('Rotate the'), 'tool-adjacent card text still travels — the frame is the FULL board')
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

if (fails) {
  console.error(`\n${fails} failure(s)`)
  process.exit(1)
}
console.log('relay: all ok')
