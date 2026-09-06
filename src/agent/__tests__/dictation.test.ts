/** The dictation module's pure half: command construction and the verdicts the
 *  controls are gated on. Nothing here spawns a binary — the real capture and
 *  transcription need hardware and two user-installed tools, which no hermetic
 *  test can supply; they are exercised by the real-agent run the card describes. */
import { captureArgs, whisperArgs, verdict, rowsFromChecks, defaultVoiceConfig } from '../dictation.ts'

let fails = 0
const ok = (c: boolean, m: string) => { if (!c) { console.log('FAIL:', m); fails++ } else console.log('  ok:', m) }

const cfg = () => ({ ...defaultVoiceConfig(), whisperModel: '/models/ggml-base.en.bin' })

// 1. Capture commands are per platform, and the device default is honest.
const linux = captureArgs('linux', '', '/tmp/v.wav')
ok(linux.includes('-f') && linux[linux.indexOf('-f') + 1] === 'alsa', 'linux captures via alsa')
ok(linux[linux.indexOf('-i') + 1] === 'default', 'linux defaults to the `default` ALSA device')
ok(linux[linux.length - 1] === '/tmp/v.wav' && linux.includes('-ar') && linux.includes('pcm_s16le'),
  'linux capture writes a 16 kHz mono PCM wav')
const linuxDev = captureArgs('linux', 'hw:2,0', '/tmp/v.wav')
ok(linuxDev[linuxDev.indexOf('-i') + 1] === 'hw:2,0', 'a configured device overrides the default')

const mac = captureArgs('darwin', '', '/tmp/v.wav')
ok(mac[mac.indexOf('-f') + 1] === 'avfoundation' && mac[mac.indexOf('-i') + 1] === ':0',
  'macOS captures via avfoundation, defaulting to :0')

// 2. Windows cannot guess a device name, and must say so rather than try.
let winErr = ''
try { captureArgs('win32', '', '/tmp/v.wav') } catch (e) { winErr = String(e) }
ok(!!winErr && winErr.includes('recordDevice'), 'windows without a device refuses and names the setting')
const win = captureArgs('win32', 'Microphone Array (Realtek)', '/tmp/v.wav')
ok(win[win.indexOf('-i') + 1] === 'audio="Microphone Array (Realtek)"',
  'windows quotes a device name with spaces inside the -i argument')
ok(captureArgs('win32', 'Mic', '/tmp/v.wav')[captureArgs('win32', 'Mic', '/tmp/v.wav').indexOf('-i') + 1] === 'audio=Mic',
  'windows leaves an unspaced device name unquoted')

let otherErr = ''
try { captureArgs('sunos', '', '/tmp/v.wav') } catch (e) { otherErr = String(e) }
ok(!!otherErr && otherErr.includes('not supported'), 'an unknown platform is refused, not guessed at')

// 3. The whisper invocation writes the transcript to a file next to the audio,
//    because the CLI's stdout spelling has drifted between releases.
const wa = whisperArgs('/m.bin', '/tmp/v.wav', '/tmp/out')
ok(wa[wa.indexOf('-m') + 1] === '/m.bin', 'whisper gets the configured model')
ok(wa.includes('-otxt') && wa[wa.indexOf('-of') + 1] === '/tmp/out', 'whisper writes <out>.txt rather than stdout')
ok(wa.includes('-nt'), 'whisper drops timestamps from the transcript file')

// 4. Verdicts: three missing pieces have three different named fixes, and the
//    gates only open when every piece answered.
const allOk = verdict({ whisper: { ok: true }, model: { ok: true }, ffmpeg: { ok: true } })
ok(allOk.ok === true && allOk.why === undefined, 'verdict is ok when every piece is')

const missingWhisper = verdict({
  whisper: { ok: false, hint: 'whisper-cli not found — install whisper.cpp or set agentsKanban.whisperPath' },
  model: { ok: true }, ffmpeg: { ok: true },
})
ok(!missingWhisper.ok && (missingWhisper.why ?? '').includes('whisperPath'), 'missing whisper names itself, not the model')
ok(!(missingWhisper.why ?? '').includes('whisperModel'), 'a working model is not blamed for a missing binary')

const allMissing = verdict({
  whisper: { ok: false, hint: 'a' }, model: { ok: false, hint: 'b' }, ffmpeg: { ok: false, hint: 'c' },
})
ok((allMissing.why ?? '').split('  ').length === 3, 'every missing piece gets its own fix, all in one line')

// 5. Settings rows: each piece is its own row with its own answer.
const rows = rowsFromChecks(cfg(), {
  whisper: { ok: true }, model: { ok: true }, ffmpeg: { ok: false, hint: 'ffmpeg not found — install it or set agentsKanban.ffmpegPath' },
})
ok(rows.length === 3 && rows[0]!.key === 'whisper' && rows[2]!.ok === false, 'rows carry per-piece state')
ok(rows[2]!.detail.includes('agentsKanban.ffmpegPath'), 'a missing row names its own setting')
const rowPath = rowsFromChecks({ ...cfg(), whisperPath: '/opt/whisper/whisper-cli' }, {
  whisper: { ok: true }, model: { ok: true }, ffmpeg: { ok: true },
})
ok(rowPath[0]!.detail === '/opt/whisper/whisper-cli', 'a configured path is reported, not the PATH fallback')

process.exit(fails ? 1 : 0)
