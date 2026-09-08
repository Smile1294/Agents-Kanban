/** Voice dictation: two local tools, and the audio never leaves the machine.
 *
 * ffmpeg captures the machine's default microphone to a WAV in the OS temp
 * directory, and a whisper.cpp build (`whisper-cli`) transcribes it. There is no
 * cloud service in the path and no webview microphone permission: the capture
 * happens in the extension host, so the feature does not depend on whether a
 * sandboxed webview can reach `getUserMedia` (it generally cannot, and there is
 * no error the extension can show for that — only a mic that silently does
 * nothing, which is the exact failure this file exists to avoid).
 *
 * The two binaries are capabilities with the same standing as `claude` or
 * `codex`: the user installs them, and every control that depends on them is
 * gated on an actual check — never on a guess. The three pieces are checked
 * separately because they have three different fixes:
 *
 *   - whisper-cli missing     → install whisper.cpp, or set agentsKanban.whisperPath
 *   - model file missing      → download a ggml-*.bin and set agentsKanban.whisperModel
 *   - ffmpeg missing          → install ffmpeg, or set agentsKanban.ffmpegPath
 *
 * A check that cannot distinguish these would tell somebody with a working
 * whisper to go and reinstall it, which is how "install the thing" becomes
 * wallpaper.
 *
 * Capture is the one piece that cannot be verified up front: the binary can
 * exist while the device is busy or has no default. So a failed capture reports
 * ffmpeg's own last words rather than inventing a diagnosis.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { MSG_MAX_BYTES } from '../remote/messages.ts'

/** How the pieces of the dictation pipeline are configured. Every field is a
 *  settings.json key under `agentsKanban.`; an empty string means "search PATH
 *  for the binary" / "the platform default device". */
export interface VoiceConfig {
  whisperPath: string
  whisperModel: string
  ffmpegPath: string
  recordDevice: string
}

const WHISPER_BIN = 'whisper-cli'
const FFMPEG_BIN = 'ffmpeg'

export function defaultVoiceConfig(): VoiceConfig {
  return { whisperPath: '', whisperModel: '', ffmpegPath: '', recordDevice: '' }
}

/** One piece of the pipeline, after asking. `hint` is the fix for THIS piece —
 *  verdict() joins the hints of everything that is missing. */
export type PieceCheck =
  | { ok: true }
  | { ok: false; hint: string }

export interface VoiceChecks {
  whisper: PieceCheck
  model: PieceCheck
  ffmpeg: PieceCheck
}

export interface VoiceStatus {
  ok: boolean
  /** Absent when ok. Present as one line per missing piece, so the composer's
   *  tooltip and the settings page say what to install rather than just that
   *  dictation is off. */
  why?: string
}

/** The capture command for a platform, as one argv array.
 *
 * Exposed for tests and for the settings page's device help: the Windows case
 * in particular cannot be guessed — dshow needs a device NAME, and nobody can
 * know it but the user. */
export function captureArgs(platform: string, device: string, outWav: string): string[] {
  const tail = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    outWav,
  ]
  if (platform === 'linux') {
    // PipeWire ships a compatibility `default` ALSA device; plain ALSA has one
    // too. Either way this is the thing a user actually has, most of the time.
    return ['-f', 'alsa', '-i', device.trim() || 'default', ...tail]
  }
  if (platform === 'darwin') {
    return ['-f', 'avfoundation', '-i', device.trim() || ':0', ...tail]
  }
  if (platform === 'win32') {
    // DirectShow wants `audio=<name>`. With a shell ffmpeg would quote it; we
    // spawn without a shell, so the quoting has to be in the string — and a
    // device with no spaces needs no quotes. There is no sensible default name.
    const name = device.trim()
    if (!name) {
      throw new Error(
        'Windows needs a microphone name for dictation — set agentsKanban.recordDevice ' +
        '(list them with: ffmpeg -f dshow -list_devices true -i dummy)',
      )
    }
    return ['-f', 'dshow', '-i', name.includes(' ') ? `audio="${name}"` : `audio=${name}`, ...tail]
  }
  throw new Error(`Dictation capture is not supported on ${platform}`)
}

export function whisperArgs(model: string, wavPath: string, outBase: string): string[] {
  // -otxt/-of write the transcript to `<outBase>.txt` rather than stdout: the
  // CLI's stdout carries progress and result lines that have changed spelling
  // between releases, while the file has been stable. -nt drops the timestamps.
  return ['-m', model, '-f', wavPath, '-otxt', '-of', outBase, '-nt']
}

/* ——— VS Code's OWN built-in dictation: the zero-install front path ———————
 *
 * VS Code 1.131 (July 2026) shipped experimental built-in dictation — an
 * offline on-device model, no Speech extension, nothing to install. It types
 * into whichever control has focus (which includes webview inputs in
 * principle — the claim the mic's howToTest must verify by hand), driven by
 * `workbench.action.editorDictation.*` commands. Those commands are INTERNAL
 * and undocumented; there is no public API, which is why the mic still shows
 * the keybinding (Ctrl+Alt+V / ⌥⌘V) in its tooltip and every call is guarded.
 *
 * What DOES exist to gate on is a version, a setting and a platform, and the
 * function below is exactly that gate, kept pure so a test can hold it up
 * against the platform matrix the research produced:
 *
 *   - Windows x64 / Arm64, macOS on Apple Silicon, Linux x64 / Arm64
 *     (Linux also needs glibc >= 2.34 — not checkable from Node, not checked)
 *   - NOT VS Code for the Web, Intel Macs, 32-bit
 *
 * When the gate opens, the mic triggers VS Code's dictation and the whisper
 * pipeline is left for every other case: it stays the explicit fallback,
 * unchanged. */

export const VSCODE_DICTATION_START = 'workbench.action.editorDictation.start'
export const VSCODE_DICTATION_STOP = 'workbench.action.editorDictation.stop'

/** The smallest VS Code version whose release notes promise built-in dictation. */
const DICTATION_MIN_VERSION = [1, 131, 0]

export interface BuiltinGate {
  /** `vscode.version`, e.g. '1.131.0' — may carry an `-insider` suffix. */
  version: string
  platform: string
  arch: string
  /** The `dictation.enabled` setting, whatever it says. */
  enabled: unknown
}

/** `version >= want`, tolerating an `-insider`/`-dev` suffix. A whole semver
 *  parser is more than a three-field compare needs. */
export function atLeast(version: string, want: number[]): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version))
  if (!m) return false
  const have = [Number(m[1]), Number(m[2]), Number(m[3])]
  for (let i = 0; i < want.length; i++) {
    if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0)
  }
  return true
}

export function builtinDictationAvailable(g: BuiltinGate): VoiceStatus {
  if (g.enabled !== true) {
    return {
      ok: false,
      why: 'VS Code built-in dictation is off — enable "Dictation: Enabled" (experimental, VS Code 1.131+)',
    }
  }
  if (!atLeast(g.version, DICTATION_MIN_VERSION)) {
    return { ok: false, why: 'Built-in dictation needs VS Code 1.131+' }
  }
  const supported =
    (g.platform === 'win32' && (g.arch === 'x64' || g.arch === 'arm64')) ||
    (g.platform === 'darwin' && g.arch === 'arm64') ||
    (g.platform === 'linux' && (g.arch === 'x64' || g.arch === 'arm64'))
  if (!supported) {
    return {
      ok: false,
      why: 'Built-in dictation does not support this platform — it covers Windows x64/Arm64, macOS on Apple Silicon and Linux x64/Arm64',
    }
  }
  return { ok: true }
}

/** Ask the three pieces where they are. Spawns each binary once with --version;
 *  spawnSync returns an error object rather than throwing when the binary is
 *  not on PATH, and every spawn is bounded by a timeout so a broken binary
 *  cannot hang the settings page. */
export function checkVoice(cfg: VoiceConfig): VoiceChecks {
  const bin = (configured: string, fallback: string): boolean => {
    try {
      const r = spawnSync(configured.trim() || fallback, ['--version'], {
        encoding: 'utf8', timeout: 3000, windowsHide: true,
      })
      return !r.error && r.status === 0
    } catch {
      return false
    }
  }
  const whisper = bin(cfg.whisperPath, WHISPER_BIN)
    ? { ok: true as const }
    : {
        ok: false as const,
        hint: cfg.whisperPath.trim()
          ? `whisper-cli not found at ${cfg.whisperPath}`
          : 'whisper-cli not found — install whisper.cpp or set agentsKanban.whisperPath',
      }
  const modelPath = cfg.whisperModel.trim()
  const model = modelPath && existsSync(modelPath)
    ? { ok: true as const }
    : {
        ok: false as const,
        hint: modelPath
          ? `whisper model not found at ${modelPath}`
          : 'no whisper model — set agentsKanban.whisperModel to a ggml-*.bin file',
      }
  const ffmpeg = bin(cfg.ffmpegPath, FFMPEG_BIN)
    ? { ok: true as const }
    : {
        ok: false as const,
        hint: cfg.ffmpegPath.trim()
          ? `ffmpeg not found at ${cfg.ffmpegPath}`
          : 'ffmpeg not found — install it or set agentsKanban.ffmpegPath',
      }
  return { whisper, model, ffmpeg }
}

/** The one-line verdict the controls are gated on. Pure so the tests can run it
 *  against every combination without spawning anything. */
export function verdict(checks: VoiceChecks): VoiceStatus {
  const bad = [checks.whisper, checks.model, checks.ffmpeg].filter(
    (c): c is Extract<PieceCheck, { ok: false }> => !c.ok,
  )
  if (!bad.length) return { ok: true }
  return { ok: false, why: bad.map((c) => c.hint).join('  ') }
}

/** Rows for the settings page: each piece, its state, and the fix when it is
 *  missing. Pure — the caller already ran checkVoice — so tests can run it
 *  against every combination without spawning anything. */
export function rowsFromChecks(cfg: VoiceConfig, checks: VoiceChecks): { key: string; label: string; ok: boolean; detail: string }[] {
  const where = (configured: string, fallback: string) =>
    configured.trim() ? configured.trim() : `on PATH (${fallback})`
  const detail = (c: PieceCheck, whenOk: string) =>
    c.ok ? whenOk : (c as { hint: string }).hint
  return [
    { key: 'whisper', label: 'whisper-cli', ok: checks.whisper.ok, detail: detail(checks.whisper, where(cfg.whisperPath, WHISPER_BIN)) },
    { key: 'model', label: 'whisper model', ok: checks.model.ok, detail: detail(checks.model, cfg.whisperModel.trim()) },
    { key: 'ffmpeg', label: 'ffmpeg', ok: checks.ffmpeg.ok, detail: detail(checks.ffmpeg, where(cfg.ffmpegPath, FFMPEG_BIN)) },
  ]
}

export type VoiceOutcome = { ok: true; text: string } | { ok: false; error: string }

/* ——— Remote upload: the phone records, this machine transcribes ———————————
 *
 * The remote page has no built-in dictation (it is not VS Code), so its mic is
 * the whisper path with the CAPTURE on the phone: the phone records to a webm
 * (or whatever its browser produces), the bytes ride a `voiceAudio` message,
 * and whisper on this machine transcribes them. The capture never touches this
 * machine's microphone; only the transcription does.
 *
 * The upload is a file, not a stream: the bytes are base64 in the message, so
 * they are written to a temp file, converted to the 16 kHz mono WAV the whisper
 * path already expects, and handed to `transcribeWav` — the SAME pipeline the
 * local mic uses, so there is one transcription path to trust. */

/** The file extension for an uploaded media type, or undefined when the type is
 *  refused. The page's browser decides what it records (WebM on Chrome, MP4 on
 *  Safari, Ogg on Firefox); only the types ffmpeg can certainly read are
 *  accepted, and everything else is refused with a named reason rather than fed
 *  to a converter that would fail less helpfully. */
export function uploadExtension(mediaType: string): string | undefined {
  const t = mediaType.toLowerCase()
  if (t === 'audio/webm') return 'webm'
  if (t === 'audio/ogg' || t === 'application/ogg') return 'ogg'
  if (t === 'audio/oga') return 'oga'
  if (t === 'audio/mp4' || t === 'video/mp4') return 'mp4'
  if (t === 'audio/m4a' || t === 'audio/x-m4a') return 'm4a'
  if (t === 'audio/wav' || t === 'audio/x-wav' || t === 'audio/wave' || t === 'audio/x-wave') return 'wav'
  return undefined
}

/** The ffmpeg argv that turns an uploaded recording into the 16 kHz mono WAV
 *  the whisper path expects. Same tail as `captureArgs` — the two inputs (mic
 *  device, uploaded file) meet at the same output format. */
export function convertArgs(inPath: string, outWav: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', inPath,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    outWav,
  ]
}

/** Transcribe an uploaded recording. The bytes are base64 in the message, so
 *  this decodes, writes, converts and transcribes — the local pipeline with a
 *  file instead of a live capture. Bounded by the message cap (the relay would
 *  have refused anything larger), and every failure reports the piece that
 *  failed rather than inventing a diagnosis. */
export function transcribeUpload(cfg: VoiceConfig, mediaType: string, base64: string): Promise<VoiceOutcome> {
  const ext = uploadExtension(mediaType)
  if (!ext) {
    return Promise.resolve({
      ok: false,
      error: `unsupported audio format "${mediaType || '(none)'}" — record webm, ogg, mp4, m4a or wav`,
    })
  }
  if (base64.length > MSG_MAX_BYTES) {
    return Promise.resolve({ ok: false, error: 'recording is too large to transcribe' })
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentskanban-voice-'))
  const inPath = path.join(dir, `upload.${ext}`)
  const wav = path.join(dir, 'upload.wav')
  let buf: Buffer
  try {
    buf = Buffer.from(base64, 'base64')
  } catch {
    rmSync(dir, { recursive: true, force: true })
    return Promise.resolve({ ok: false, error: 'recording data was not valid base64' })
  }
  if (buf.length === 0) {
    rmSync(dir, { recursive: true, force: true })
    return Promise.resolve({ ok: false, error: 'no audio was received' })
  }
  try {
    writeFileSync(inPath, buf)
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    return Promise.resolve({ ok: false, error: e instanceof Error ? e.message : String(e) })
  }
  return new Promise<VoiceOutcome>((resolve) => {
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }
    let proc: ChildProcess
    try {
      proc = spawn(cfg.ffmpegPath.trim() || FFMPEG_BIN, convertArgs(inPath, wav), { windowsHide: true })
    } catch (e) {
      cleanup()
      resolve({ ok: false, error: `ffmpeg: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    const err: Buffer[] = []
    proc.stderr?.on('data', (c: Buffer) => err.push(c))
    proc.on('error', (e) => {
      cleanup()
      resolve({ ok: false, error: `ffmpeg: ${e.message}` })
    })
    proc.on('exit', (code) => {
      if (code !== 0) {
        const detail = stderrTail(err)
        cleanup()
        resolve({ ok: false, error: `ffmpeg failed (exit ${code})${detail ? ' — ' + detail.slice(0, 300) : ''}` })
        return
      }
      // transcribeWav owns the temp dir from here — it cleans it up.
      void transcribeWav(cfg, wav, dir).then(resolve)
    })
  })
}

/** A running capture. `stopped` resolves once per capture: with the transcript
 *  when the user stopped it, or with ffmpeg's own complaint when the process
 *  died on its own (device busy, no default device). */
export interface Capture {
  readonly stopped: Promise<VoiceOutcome>
  stop(): void
}

const stderrTail = (chunks: Buffer[]): string =>
  Buffer.concat(chunks).toString('utf8').trim().split('\n').slice(-3).join('\n')

/** Start capturing the microphone.
 *
 * The WAV's header is only completed when ffmpeg closes the file, so stopping
 * is SIGINT — ffmpeg handles it by writing the trailer — never SIGTERM or kill.
 * (Windows terminates instead; capture there is best-effort, and the settings
 * page says so.) */
export function startCapture(cfg: VoiceConfig): Capture {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agentskanban-voice-'))
  const wav = path.join(dir, 'capture.wav')
  let ffmpeg: ChildProcess
  try {
    ffmpeg = spawn(
      cfg.ffmpegPath.trim() || FFMPEG_BIN,
      captureArgs(process.platform, cfg.recordDevice, wav),
      { windowsHide: true },
    )
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    return alreadyDone(e instanceof Error ? e.message : String(e))
  }
  const err: Buffer[] = []
  ffmpeg.stderr?.on('data', (c: Buffer) => err.push(c))

  let userStopped = false
  let done = false
  let settle: (o: VoiceOutcome) => void = () => {}
  const stopped = new Promise<VoiceOutcome>((res) => { settle = res })
    .then((o) => (o.ok ? transcribeWav(cfg, wav, dir) : o))
  const once = (o: VoiceOutcome) => {
    if (done) return
    done = true
    settle(o)
  }
  const tidy = () => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ } }

  ffmpeg.on('error', (e) => {
    tidy()
    once({ ok: false, error: `ffmpeg: ${e.message}` })
  })
  ffmpeg.on('exit', (code) => {
    if (userStopped) {
      // The user stopped it: the WAV is complete, and transcription takes over
      // (and owns the temp dir from here — transcribeWav cleans it up).
      once({ ok: true, text: '' })
      return
    }
    tidy()
    const tail = stderrTail(err)
    once({
      ok: false,
      error: 'Recording stopped itself — ' + (code !== 0 ? (tail || `ffmpeg exited ${code}`) : 'ffmpeg exited'),
    })
  })

  return {
    stopped,
    stop() {
      if (userStopped || done) return
      userStopped = true
      ffmpeg.kill('SIGINT')
    },
  }
}

function alreadyDone(error: string): Capture {
  return { stopped: Promise.resolve({ ok: false, error }), stop() {} }
}

/** Transcribe a 16 kHz mono WAV with whisper-cli. Bounded — a slow CPU model
 *  over a long recording can take minutes, and a runaway process must not own
 *  the extension host. */
export function transcribeWav(cfg: VoiceConfig, wavPath: string, workDir: string): Promise<VoiceOutcome> {
  const bin = cfg.whisperPath.trim() || WHISPER_BIN
  const model = cfg.whisperModel.trim()
  return new Promise<VoiceOutcome>((resolve) => {
    const cleanup = () => { try { rmSync(workDir, { recursive: true, force: true }) } catch { /* best effort */ } }
    if (!existsSync(wavPath)) {
      cleanup()
      resolve({ ok: false, error: 'No audio was captured' })
      return
    }
    if (!existsSync(model)) {
      cleanup()
      resolve({ ok: false, error: 'whisper model not found at ' + model + ' — set agentsKanban.whisperModel' })
      return
    }
    const outBase = path.join(workDir, 'transcript')
    let proc: ChildProcess
    try {
      proc = spawn(bin, whisperArgs(model, wavPath, outBase), { windowsHide: true })
    } catch (e) {
      cleanup()
      resolve({ ok: false, error: `${bin}: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    const err: Buffer[] = []
    proc.stderr?.on('data', (c: Buffer) => err.push(c))
    const timer = setTimeout(() => proc.kill('SIGKILL'), 600_000)
    proc.on('error', (e) => {
      clearTimeout(timer)
      cleanup()
      resolve({ ok: false, error: `${bin}: ${e.message}` })
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = stderrTail(err)
        cleanup()
        resolve({ ok: false, error: `${bin} failed (exit ${code})${detail ? ' — ' + detail.slice(0, 300) : ''}` })
        return
      }
      let text = ''
      try {
        const txt = outBase + '.txt'
        if (existsSync(txt)) {
          text = readFileSync(txt, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).join(' ')
        }
      } catch {
        // Fall through with whatever we have — an empty dictation is still an
        // honest answer, and the composer says "nothing recognised".
      }
      cleanup()
      resolve({ ok: true, text: text.trim() })
    })
  })
}
