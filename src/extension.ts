/** Agents Kanban — activation and wiring.
 *
 * The board is plain markdown in the repo, agents run through the Claude Agent
 * SDK in isolated git worktrees, and the agent moves its own cards through
 * in-process MCP tools. This file owns the VS Code surface; everything else is
 * plain Node and unit-tested without VS Code.
 */
import * as path from 'node:path'
import * as fs from 'node:fs/promises'
import * as vscode from 'vscode'
import { AgentManager, followKey, type RunningAgent } from './agent/manager.ts'
import { loadSdk, type Options as AgentOptions } from './agent/sdk.ts'
import {
  applyRestore, checkpointMapFor, claudeHome, historyDirFor, planRestore,
  sessionFileFor, waitForQuiescent, type CheckpointMap,
} from './sessions/checkpoints.ts'
import {
  BoardPanel, BoardViewProvider, _resetBoardFocus, applyBoardFocus, boardFocusApplied,
  setBoardFocusMode, showSideBarView, toUiAgent,
  type BoardHost, type FocusMode, type Mode, type SearchAnswer, type SearchRow,
  type UiCard, type UiState,
} from './board/panel.ts'
import { WorktreeService, findRepoRoot, realResolveInWorktree, type WorktreeReview } from './git/worktree.ts'
import { MetaStore, EFFORT_LEVELS, MODELS, resolveEffort, resolveOrchestration, resolveThinking, targetIsClean, windowLabel, type EffortLevel, type ThinkingMode } from './sessions/meta.ts'
import { MODEL_WINDOWS, normaliseModel, type ModelBook, type ModelFacts } from './sessions/usage.ts'
import { SessionStore, interruptedSessions, type Entry } from './sessions/store.ts'
import { searchEntries } from './sessions/search.ts'
import { listSlashCommands, type SlashCommand } from './sessions/commands.ts'
import { DEFAULT_BOARD, isReviewColumn, isSettledColumn, type BoardConfig } from './board/config.ts'
import { linkSubtasks, rollUpState } from './board/subtasks.ts'
import {
  DEFAULT_ORCHESTRATION, ORCHESTRATION_CHOICES, decompositionLine,
  parseOrchestrationLevel, type OrchestrationLevel,
} from './board/decomposition.ts'
import { coalesce } from './board/coalesce.ts'
import { describeImages, sanitiseImages } from './agent/images.ts'
import {
  COMMON_DEV_PORTS, detect as detectRun, isListening, readWtRegistry, waitForPort,
} from './run/recipe.ts'
import {
  INHERIT_PROFILE, PROVIDER_KINDS, PROVIDER_PRESETS, activeProfile, credentialKey,
  describeProfile, envForProfile, hostOf, kindDef, parseProfiles, profileLabel,
  reconcileProvider, resolvedLabel, usesRuntimeLogin, validateProfile,
  type ProviderEnv, type ProviderProfile,
} from './agent/providers.ts'
import { probeProvider } from './agent/probe.ts'
import {
  fetchEndpointModels, parseEndpointModels, type EndpointModel,
} from './agent/endpoint.ts'
import {
  collectRuntimeStatus, SettingsPanel,
  type RemoteState, type ScheduleRowState, type SettingsHost, type SettingsMessage,
  type SettingsState,
} from './board/settings.ts'
import {
  describeWhen, nextFireAt, parseSchedules,
  type Schedule,
} from './board/schedules.ts'
import {
  checkVoice, rowsFromChecks, startCapture, verdict,
  type Capture, type VoiceChecks, type VoiceConfig,
} from './agent/dictation.ts'
import { RemoteFeed, type TailSource } from './remote/feed.ts'
import { RemotePusher, type PushSnapshot } from './remote/pusher.ts'
import { boardIdOf, projectTail, relayBase, type RemoteTail } from './remote/relay.ts'
import { toRemoteCard } from './remote/cards.ts'
// Imported for effect: this is what puts Claude Code and Codex in the registry.
// See agent/runtimes/index.ts for why registration is explicit rather than
// happening wherever an implementation happens to be imported first.
import './agent/runtimes/index.ts'
import {
  allRuntimes, DEFAULT_RUNTIME, getRuntime, parseRuntimeId,
  type LoginState, type Meter, type RuntimeId, type RuntimeStatus,
} from './agent/runtime.ts'
import {
  ALL_EFFORTS, catalogueFor, discoverModels, effortsFor, fastModeFor, parseCachedChoices,
  priceLabel, thinkingFor, ultracodeFor,
  type ModelCatalogue, type ModelChoice,
} from './agent/models.ts'

type AgentPermissionMode = AgentOptions['permissionMode']

/** How often the board may repaint while an agent streams. Ten times a second
 *  is smoother than the eye asks for and ~50x less work than once per token. */
const REPAINT_INTERVAL_MS = 100

let log: vscode.LogOutputChannel

/** Everything that depends on having a folder open. Rebuilt when folders change. */
interface Workspace {
  root: string
  store: SessionStore
  repoRoot?: string
  worktrees?: WorktreeService
  board: BoardConfig
  manager?: AgentManager
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  _resetBoardFocus()
  log = vscode.window.createOutputChannel('Agents Kanban', { log: true })
  context.subscriptions.push(log)

  const cfg = () => vscode.workspace.getConfiguration('agentsKanban')
  const state = context.workspaceState
  let ws: Workspace | undefined
  let mode: Mode = 'kanban'
  let selectedKey: string | undefined
  let showArchived = false
  /** Review data is four git calls, and refreshAll() fires on every streamed
   *  token — so it is computed on demand and cached against its own card. */
  let review: { key: string; data: WorktreeReview } | undefined
  let busy: string | undefined
  let commands: SlashCommand[] = []

  /** The six the SDK actually accepts; the manifest enum mirrors this list. */
  const PERMISSION_MODES = [
    { key: 'default', label: 'Ask', detail: 'Prompt before anything that writes or runs' },
    // "commands still ask" was true for Claude Code and false for Codex, whose
    // nearest policy runs commands inside the sandbox without asking. A detail
    // that is right on one agent and wrong on the other is a control label that
    // cannot be trusted on either.
    { key: 'acceptEdits', label: 'Auto-accept edits', detail: 'File edits go through, inside this session\'s worktree' },
    { key: 'plan', label: 'Plan only', detail: 'Think it through, change nothing' },
    // Deny-by-default, which is what the SDK defines it as: "Don't prompt for
    // permissions, deny if not pre-approved". It used to share a row with
    // `bypassPermissions` on the Codex side and silently removed the sandbox.
    { key: 'dontAsk', label: "Don't ask", detail: 'Stop prompting; anything not pre-approved is refused' },
    { key: 'auto', label: 'Auto', detail: 'Let Claude Code choose per tool' },
    { key: 'bypassPermissions', label: 'Bypass all', detail: 'No checks at all — the agent is in a worktree, but still' },
  ]
  let permissionMode: NonNullable<AgentPermissionMode> =
    (state.get<string>('permissionMode') as NonNullable<AgentPermissionMode>) ??
    (cfg().get<string>('permissionMode') as NonNullable<AgentPermissionMode>) ??
    'acceptEdits'

  // Composer defaults, remembered per workspace.
  /**
   * Which agent program NEW sessions run on.
   *
   * Parsed rather than cast, like every other value read back out of storage:
   * a build that served a runtime this one does not would otherwise put an id
   * nothing can start onto the render path. Falls back to Claude Code, which is
   * what every session written before this existed is.
   */
  let runtime: RuntimeId = parseRuntimeId(state.get<string>('runtime'))
    ?? parseRuntimeId(cfg().get<string>('runtime'))
    ?? DEFAULT_RUNTIME
  /** How eagerly a NEW session should split. Parsed, never cast: it is read on
   *  the path that builds a brief, and a value from an older build is another
   *  program's output. */
  let orchestration: OrchestrationLevel =
    parseOrchestrationLevel(state.get<string>('orchestration'))
    ?? parseOrchestrationLevel(cfg().get<string>('orchestration'))
    ?? DEFAULT_ORCHESTRATION
  let model = state.get<string>('model') ?? cfg().get<string>('model') ?? MODELS[0]!.id
  let effort: EffortLevel = (state.get<string>('effort') as EffortLevel) ?? 'high'
  let thinking: ThinkingMode = (state.get<string>('thinking') as ThinkingMode) ?? 'enabled'
  /** Session flags. Default OFF: ultracode is xhigh effort plus a standing
   *  instruction to fan out into workflows, which is a real bill nobody asked
   *  for if it arrives by default. */
  let ultracode = state.get<boolean>('ultracode') === true
  let fastMode = state.get<boolean>('fastMode') === true
  /** Sections the user has collapsed. Persisted because "I closed that" should
   *  outlive the panel — closing the board and opening it again is not a
   *  request to be shown the diff panel afresh. */
  const disclosures: Record<string, boolean> = state.get<Record<string, boolean>>('disclosures') ?? {}

  // --- which backend agents run on ------------------------------------------
  // Profiles come from settings (hand-editable, syncable, no secrets in them);
  // the credential comes from SecretStorage, keyed by profile id. That split is
  // the reason `ProviderProfile` carries `hasCredential` rather than the value:
  // `settings.json` syncs between machines and can end up committed in a
  // `.vscode/` directory, and an API key is not configuration.
  let providers: ProviderProfile[] = parseProfiles(cfg().get<unknown[]>('providers'))
  let providerId: string =
    state.get<string>('provider') ?? cfg().get<string>('provider') ?? INHERIT_PROFILE.id
  /**
   * The active profile compiled to an environment patch, cached.
   *
   * Cached because resolving it reads the keychain, which is async, and the
   * manager is built synchronously. Every path that could change the answer —
   * activation, a settings edit, the picker, setting a credential — refreshes
   * this and hands it to the manager; and `newSession` awaits a refresh before
   * starting, so a run can never begin on a stale patch. Starting an agent on
   * the wrong backend is not a cosmetic bug: it bills someone else's account.
   */
  let providerEnv: ProviderEnv = { set: {}, clear: [] }
  /** Set when the live run's CLI reported a backend this profile did not ask
   *  for. The one signal that makes an outranked profile visible. */
  let providerMismatch: string | undefined

  const currentProvider = (): ProviderProfile => activeProfile(providers, providerId)

  async function refreshProviderEnv(): Promise<void> {
    const p = currentProvider()
    const secret = p.hasCredential
      ? await context.secrets.get(credentialKey(p.id)).then((v) => v ?? undefined, () => undefined)
      : undefined
    providerEnv = envForProfile(p, secret, process.env)
    ws?.manager?.setProvider(p, providerEnv)
  }

  /**
   * Which models the picker offers.
   *
   * Three sources, in `mergeModels`' order: a list the profile declares, what
   * the CLI reported when we asked, and the built-in table as the floor. The
   * catalogue is CACHED rather than recomputed, because asking costs a CLI
   * round trip and `getState()` runs on the render path — ten times a second
   * while an agent streams.
   */
  const builtinChoices = (): ModelChoice[] =>
    MODELS.map((m) => ({
      ...m, efforts: [...ALL_EFFORTS], thinking: true,
      // The built-in list is a fallback, and it has NOT asked. Ultracode costs
      // real money — xhigh effort plus a standing instruction to fan out into
      // workflows — so it is offered only when the CLI has confirmed the model
      // can run it, never on a guess.
      ultracode: false, fastMode: false,
    }))

  let catalogue: ModelCatalogue = { choices: builtinChoices(), source: 'builtin' }
  /** In-flight discovery, so opening the picker twice does not spawn two CLIs. */
  let discovering: Promise<void> | undefined

  /**
   * Where a model list is cached.
   *
   * Keyed by RUNTIME as well as provider profile. The models are per agent
   * program *and* per backend, and keying on the profile alone would file
   * Codex's `gpt-5.5` under `inherit` and hand it back the next time a Claude
   * session asked — a picker offering ids the running agent does not serve,
   * which fails at the first request with somebody else's error message.
   *
   * The `claude:` prefix is written out rather than interpolated for the
   * default so that entries cached by builds before runtimes existed are simply
   * missed and re-asked, instead of being read as another runtime's.
   */
  const catalogueKey = (id: string, rt: RuntimeId = runtime) => `models:${rt}:${id}`

  /** Rebuild the catalogue from whatever is already known — no CLI round trip.
   *  Called whenever the profile changes, so the picker is never showing the
   *  previous provider's models while discovery runs. */
  /** The cache for a profile, or empty when it is missing OR was written by a
   *  build whose `ModelChoice` had a different shape. Parsed rather than cast:
   *  `globalState` outlives the version that wrote it, and a stale entry reaches
   *  the composer as `undefined.includes(...)` — a blank panel, not an error. */
  const cachedChoices = (id: string): ModelChoice[] =>
    parseCachedChoices(context.globalState.get(catalogueKey(id)))

  /**
   * Where a CUSTOM ENDPOINT's own catalogue is cached.
   *
   * Not keyed by runtime, unlike `catalogueKey`: this is what the endpoint at a
   * URL serves, and that answer does not change depending on which agent
   * program is asking. Not in `settings.json` either — OpenRouter reports 431
   * models with a paragraph each, which is not something a person should find
   * in a file they hand-edit and sync between machines. `profile.models` stays
   * the small, human list of what to OFFER; this is the big machine list of
   * what EXISTS.
   */
  const endpointKey = (id: string) => `endpointModels:${id}`
  const cachedEndpoint = (id: string): EndpointModel[] =>
    parseEndpointModels(context.globalState.get(endpointKey(id)))

  /** What the active profile's endpoint says it serves, and what to call it.
   *  Only a `gateway` has one: no other kind's endpoint is ours to ask. */
  function endpointFor(p: ProviderProfile): { models: EndpointModel[]; host?: string } | undefined {
    if (p.kind !== 'gateway' || !p.baseUrl?.trim()) return undefined
    return { models: cachedEndpoint(p.id), host: hostOf(p.baseUrl) }
  }

  /**
   * What every configured endpoint said its models cost and how big their
   * windows are, in one map.
   *
   * Handed to BOTH meters — `SessionStore`, which totals a session from its
   * transcript, and `AgentManager`, which prices a run as it happens — because
   * a figure that changes when a run ends is the failure this project has a
   * rule about. Without it, `MODEL_RATES` knows Anthropic's models and nobody
   * else's, so every session on a custom endpoint reads `≥ $0.00` against a
   * meter with no denominator.
   *
   * Built from EVERY profile, not just the active one, because a card is
   * priced long after the run that produced it: the board shows finished
   * sessions from several backends at once, and "the provider selected right
   * now" is not the one that billed them. Two profiles serving the same id at
   * different prices is possible and the last one wins — an ambiguity worth
   * having, because the alternative is no price at all.
   */
  function modelBook(): ModelBook {
    const out: Record<string, ModelFacts> = {}
    for (const p of providers) {
      if (p.kind !== 'gateway') continue
      for (const m of cachedEndpoint(p.id)) {
        if (!m.rate && !m.contextWindow) continue
        out[m.id] = {
          ...(m.rate ? { rate: m.rate } : {}),
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        }
      }
    }
    return out
  }

  /** Push the book at both meters. Called wherever a catalogue can change. */
  function applyModelBook(): void {
    const book = modelBook()
    ws?.store.setModelBook(book)
    ws?.manager?.setModelBook(book)
  }

  /**
   * The catalogue for a profile that is NOT the active one.
   *
   * Needed because the composer follows the SELECTED SESSION, and a session may
   * be running on a backend nobody is pointed at right now — open yesterday's
   * DeepSeek card while the active profile is first-party and the picker would
   * list Anthropic's models under a `deepseek-v4-pro` session.
   *
   * Memoised because `getState()` is the render path: it runs ten times a
   * second while an agent streams, and building this means parsing a cached
   * catalogue of up to 500 entries. Cleared wherever a catalogue can change —
   * which is `recomputeCatalogue`, the one function every such path already
   * calls.
   */
  const perProfileCatalogue = new Map<string, ModelCatalogue>()
  /**
   * Bumped whenever any catalogue changes. The whole point is that it changes
   * RARELY — a backend switch, a refresh — while `getState()` runs ten times a
   * second, so this is what lets the state omit a 431-entry model list that is
   * identical to the one the webview already has.
   */
  let catalogueVersion = 0
  /** The list this webview was last sent, as `<version>:<profile>`. Reset on
   *  `ready`, which is a webview saying it has just loaded and has nothing. */
  let sentCatalogue: string | undefined

  const forgetSentCatalogue = (): void => { sentCatalogue = undefined }

  /**
   * The model list for a state message, or `undefined` when the view already
   * has it.
   *
   * ONE place that maps a catalogue into the wire shape, called once per state.
   * It was inlined twice — the default branch and the selected-session branch —
   * so a 431-model catalogue was formatted twice per repaint and posted in full
   * ten times a second. Measured: 161KB of a 326KB state.
   */
  function sendModels(cat: ModelCatalogue, profileId: string):
      { id: string; label: string; context: string; detail?: string; contextTokens?: number; price?: string }[] | undefined {
    const key = `${catalogueVersion}:${profileId}:${cat.source}`
    if (key === sentCatalogue) return undefined
    sentCatalogue = key
    return cat.choices.map((m) => {
      // Formatted once, here, so the composer and the settings page cannot
      // disagree about how a price reads. Absent when nothing published one —
      // a blank is "not stated", `$0.00` would be "free".
      const price = priceLabel(m.rate)
      return {
        id: m.id, label: m.label, context: m.context,
        ...(m.detail ? { detail: m.detail } : {}),
        ...(m.contextTokens ? { contextTokens: m.contextTokens } : {}),
        ...(price ? { price } : {}),
      }
    })
  }

  function catalogueForProfile(p: ProviderProfile): ModelCatalogue {
    const hit = perProfileCatalogue.get(p.id)
    if (hit) return hit
    const built = catalogueFor(p, cachedChoices(p.id), builtinChoices(),
      { normaliseModel, windows: MODEL_WINDOWS, windowLabel }, undefined, endpointFor(p))
    perProfileCatalogue.set(p.id, built)
    return built
  }

  function recomputeCatalogue(discovered?: readonly ModelChoice[], problem?: string): void {
    perProfileCatalogue.clear()
    catalogueVersion++
    const p = currentProvider()
    const cached = discovered ?? cachedChoices(p.id)
    catalogue = catalogueFor(p, cached, builtinChoices(),
      { normaliseModel, windows: MODEL_WINDOWS, windowLabel }, problem, endpointFor(p))
  }

  /**
   * Ask a custom endpoint what it serves, and remember the answer.
   *
   * Separate from `refreshModels` because it asks a different program a
   * different question: `refreshModels` asks the CLI what CLAUDE CODE can run,
   * which is the wrong question the moment `ANTHROPIC_BASE_URL` points
   * somewhere else. It is a plain HTTP GET, so it costs no CLI process and no
   * token.
   *
   * Never rejects, and never clears a good list on a bad answer: an endpoint
   * that is briefly down must not empty a picker that was working a minute ago.
   */
  async function refreshEndpointModels(p: ProviderProfile, force = false): Promise<string | undefined> {
    if (p.kind !== 'gateway' || !p.baseUrl?.trim()) return undefined
    if (!force && cachedEndpoint(p.id).length) return undefined
    const secret = p.hasCredential
      ? await context.secrets.get(credentialKey(p.id)).then((v) => v ?? undefined, () => undefined)
      : undefined
    const env = envForProfile(p, secret, process.env)
    // The credential goes in whichever header `envForProfile` chose, read back
    // out of the patch rather than decided again here — one place decides, or
    // this check comes to disagree with the sessions it is checking.
    const headers: Record<string, string> = {}
    if (env.set.ANTHROPIC_AUTH_TOKEN) headers.authorization = `Bearer ${env.set.ANTHROPIC_AUTH_TOKEN}`
    if (env.set.ANTHROPIC_API_KEY) headers['x-api-key'] = env.set.ANTHROPIC_API_KEY
    const { models, url, problem } = await fetchEndpointModels(p.baseUrl.trim(), headers)
    if (models.length) {
      await context.globalState.update(endpointKey(p.id), models)
      endpointNotes.delete(p.id)
      // The prices arrived with the list. Both meters learn them here, or the
      // number on every card stays a floor.
      applyModelBook()
      log.info(`${hostOf(p.baseUrl)} serves ${models.length} models (read from ${url}).`)
      return undefined
    }
    log.warn(`Could not read the model list from ${hostOf(p.baseUrl)}: ${problem}`)
    if (problem) endpointNotes.set(p.id, problem)
    return problem
  }

  /**
   * The model list for a runtime that is not Claude Code.
   *
   * Same three-source rule as the Claude path and in the same order — the
   * runtime's own answer, then a cache, then a built-in list that the picker
   * DISCLOSES as a fallback. It is a separate function only because the
   * transport differs; the fallback logic still lives in one place per runtime,
   * inside `rt.models()`, because two functions that both know how to fall back
   * is the bug that made the picker discard the CLI's answer for a whole
   * release.
   *
   * Never rejects. The caller is a picker, and an empty picker reads as a broken
   * extension when the cause is being offline.
   */
  async function refreshRuntimeModels(force = false): Promise<void> {
    const rt = getRuntime(runtime)
    if (!rt) { recomputeCatalogue(); return }
    const key = catalogueKey(runtime, runtime)
    if (!force) {
      const cached = parseCachedChoices(context.globalState.get(key))
      // `cli`, not a fourth source: a remembered answer is still the answer the
      // runtime gave, and that is how the Claude path already reports its own
      // cache. A `cache` label would suggest a fallback the user should worry
      // about.
      if (cached.length) { catalogue = { choices: cached, source: 'cli' }; return }
    }
    try {
      const loc = await rt.detect(configuredPathFor(runtime))
      const cat = loc ? await rt.models(loc) : { models: rt.builtinModels(), source: 'builtin' as const, note: `${rt.label} is not installed.` }
      const choices: ModelChoice[] = cat.models.map((m) => ({
        id: m.id,
        label: m.label,
        // Derived from the window the runtime declared, so the label under the
        // picker and the denominator the meter measures against cannot
        // disagree — the rule `MODELS` already exists to enforce.
        context: windowLabel(m.contextWindow),
        ...(m.description ? { detail: m.description } : {}),
        efforts: m.supportedEffort ?? [],
        // Extended thinking is Claude's switch. A runtime without it must not
        // show a toggle that does nothing.
        thinking: rt.capabilities.thinkingToggle,
        ultracode: false,
        fastMode: m.supportsFastMode === true,
      }))
      if (choices.length && cat.source !== 'builtin') await context.globalState.update(key, choices)
      catalogue = {
        choices: choices.length ? choices : builtinChoices(),
        // `runtime` and `cache` both mean "the agent told us" — the second is
        // the agent's OWN cache on disk, not a table of ours. Only `builtin` is
        // a fallback, and only that one makes the picker say so.
        source: cat.source === 'builtin' ? 'builtin' : 'cli',
        ...(cat.note ? { problem: cat.note } : {}),
      }
      log.info(`Models for ${rt.label}: ${choices.map((c) => c.id).join(', ') || '(none)'}`)
      alignModelToProvider()
    } catch (e) {
      catalogue = {
        choices: rt.builtinModels().map((m) => ({
          id: m.id, label: m.label, context: windowLabel(m.contextWindow),
          efforts: m.supportedEffort ?? [], thinking: false, ultracode: false, fastMode: false,
        })),
        source: 'builtin',
        problem: `Could not ask ${rt.label} for its models: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  /**
   * Ask the CLI which models it can run.
   *
   * Deliberately NOT on the activation path. It spawns a CLI process, and the
   * launch gate seeds a throwaway `CLAUDE_CONFIG_DIR` precisely so it does not
   * depend on the machine — so this is driven by the events that can actually
   * change the answer (a provider switch, an explicit refresh) and is skipped
   * entirely when `agentsKanban.discoverModels` is off.
   *
   * Never rejects: the caller is a picker, and "we could not ask" has to end in
   * a usable list. The reason is kept and shown, because a silent fallback is
   * how "why is Fable missing?" becomes unanswerable.
   */
  async function refreshModels(force = false): Promise<void> {
    // A runtime other than Claude Code answers for itself, and this test comes
    // FIRST. Below it, `recomputeCatalogue()` falls back to the CLAUDE built-in
    // table — so with discovery off, or at activation, a workspace whose
    // remembered agent is Codex opened with Anthropic ids in the picker and
    // `model` stuck on `claude-opus-5`, which is passed unchanged into
    // `thread/start` and fails the run. Two functions that both know how to
    // fall back, and the wrong one was winning.
    if (runtime !== 'claude') { await refreshRuntimeModels(force); return }
    if (cfg().get<boolean>('discoverModels') === false) { recomputeCatalogue(); return }
    const p = currentProvider()
    /* A CUSTOM ENDPOINT ANSWERS FOR ITSELF, and it is asked first.
       `supportedModels()` below reports what CLAUDE CODE can run, and it keeps
       reporting exactly that — `sonnet`, `haiku`, `opus[1m]` — however
       `ANTHROPIC_BASE_URL` is pointed, because it is assembled from the CLI's
       `initialize` response before any request leaves the machine. Asking it
       about DeepSeek and saving the answer is what left a user with six Claude
       aliases in the picker and no way to select the one model their endpoint
       actually serves.
       A plain GET, so it costs no CLI process and no token; and when it
       answers, the CLI is not asked at all, because its answer could only rank
       below this one. */
    const endpointProblem = await refreshEndpointModels(p, force)
    if (p.kind === 'gateway' && cachedEndpoint(p.id).length) {
      recomputeCatalogue()
      alignModelToProvider()
      return
    }
    // The runtime is captured for exactly the same reason as the profile: this
    // spends ~400ms in the CLI, and a switch inside that window would file one
    // agent's models under the other's key. `catalogueKey`'s own doc says what
    // that costs — "a picker offering ids the running agent does not serve,
    // which fails at the first request with somebody else's error message."
    const rt = runtime
    // Through the same parse, so a cache this build cannot read counts as a
    // MISS and is re-asked, rather than counting as a hit and never being fixed.
    if (!force && cachedChoices(p.id).length) {
      recomputeCatalogue()
      return
    }
    if (discovering) return discovering
    discovering = (async () => {
      const { choices, problem } = await discoverModels(p, providerEnv, {
        normaliseModel, windows: MODEL_WINDOWS, windowLabel,
      }, {
        ...(cfg().get<string>('claudeExecutable') ? { claudeExecutable: cfg().get<string>('claudeExecutable')! } : {}),
        ...(ws?.root ? { cwd: ws.root } : {}),
      })
      if (choices.length) {
        // Keyed by the runtime the answer BELONGS to, not by whichever is
        // selected when the round trip lands.
        await context.globalState.update(catalogueKey(p.id, rt), choices)
        log.info(`Models for ${profileLabel(p)}: ${choices.map((c) => c.id).join(', ')}`)
      } else if (problem) {
        log.warn(`Could not read the model list for ${profileLabel(p)}: ${problem}`)
      }
      // `p` was captured BEFORE the round trip, and switching provider during it
      // is a few hundred milliseconds of exposure. The result still belongs in
      // `p`'s cache — that is why the write above is unconditional — but applying
      // it to the catalogue now would put one provider's models under another's
      // name. The switch did its own `recomputeCatalogue()`, so the right move
      // is to leave it alone.
      if (currentProvider().id !== p.id || runtime !== rt) {
        log.info(
          `${runtime !== rt ? 'Agent' : 'Provider'} changed while reading models for ` +
          `${profileLabel(p)}; keeping the current list.`,
        )
        return
      }
      /* An endpoint that would not list its models is the reason a picker can
         still be showing Claude ids against a DeepSeek URL, so its complaint
         outranks the CLI's. Without this the fallback is silent, and a silent
         fallback is how "why is my model missing?" becomes unanswerable — the
         same rule `problem` exists for on the CLI path. */
      recomputeCatalogue(choices, endpointProblem ?? problem)
      alignModelToProvider()
    })().finally(() => { discovering = undefined })
    return discovering
  }

  /**
   * Drop any session flag the SELECTED MODEL cannot take.
   *
   * ONE place, called after every assignment to `model` — which is the whole
   * point, and was the thing that was wrong. The gate lived inside
   * `setComposer` and therefore ran only on a message from the webview, while
   * `alignModelToProvider()` reassigns the model from three other paths: a
   * provider switch, a discovery result landing, and activation. A flag that
   * was legitimately on for Opus survived onto a model whose capability had
   * never been confirmed — and the control is HIDDEN when unsupported, so the
   * board showed no way to turn off a flag it was still sending.
   *
   * The request path validates nothing (measured: `applyFlagSettings()`
   * resolves for `ultracode: true` on a model with no xhigh, for
   * `ultracode: 'banana'`, and for a key that does not exist), so this host-side
   * check is the only gate there is.
   */
  function regateFlags(): void {
    if (ultracode && !ultracodeFor(catalogue.choices, model)) {
      ultracode = false
      log.info(`Ultracode is not available on ${model}, which is not xhigh-capable.`)
    }
    if (fastMode && !fastModeFor(catalogue.choices, model)) {
      fastMode = false
      log.info(`Fast mode is not available on ${model}.`)
    }
  }

  /**
   * Keep the selected model on something the active provider actually serves.
   *
   * The model list is per-provider, so any change of provider can strand the
   * selection on an id the new backend does not know — a Bedrock inference
   * profile still selected after switching to first-party, or the built-in
   * `claude-opus-5` under a profile that only declares `us.anthropic.*` ids.
   * Left alone that shows a nameless model in the picker and then fails at the
   * first API call with somebody else's error message.
   *
   * Called from all three places the pairing can break: the picker, activation,
   * and a profile edited by hand in settings.json. Returns true when it moved
   * the selection, so the caller can log it rather than silently re-pointing
   * something the user chose.
   */
  const alignModelToProvider = (): boolean => {
    const allowed = catalogue.choices
    if (!allowed.length || allowed.some((m) => m.id === model)) return false
    const from = model
    model = allowed[0]!.id
    void state.update('model', model)
    // Through the SAME gate every other model change goes through. This is a
    // model switch, and it never reached the flag check — so `ultracode` or
    // `fastMode` could survive onto a model whose capability was never
    // confirmed, with the control hidden because the new model does not support
    // it. Persisted, because the gate's decision has to outlive this window.
    const hadUltracode = ultracode
    const hadFastMode = fastMode
    regateFlags()
    if (hadUltracode !== ultracode) void state.update('ultracode', ultracode)
    if (hadFastMode !== fastMode) void state.update('fastMode', fastMode)
    log.info(`Model ${from} is not served by ${profileLabel(currentProvider())}; using ${model}.`)
    return true
  }

  /**
   * Make a profile the active one.
   *
   * The single switch site, because the four steps have to happen in this
   * order and getting it wrong is invisible. `addProvider` originally saved the
   * profile (which aligned the model) and only then set `providerId`, so the
   * alignment ran against the profile being replaced and the selection stayed
   * on `claude-opus-5` under a gateway that had never heard of it. The smoke
   * gate caught it; nothing else would have.
   */
  async function setActiveProvider(id: string): Promise<void> {
    providerId = id
    await state.update('provider', providerId)
    // The mismatch was a statement about the profile just replaced. Leaving it
    // up would warn about a configuration nobody is on any more.
    providerMismatch = undefined
    await refreshProviderEnv()
    // Recompute from what is already cached BEFORE the round trip, so the
    // picker never shows the previous provider's models while we ask. The
    // refresh then fills in anything we have not asked this profile about.
    recomputeCatalogue()
    alignModelToProvider()
    ws?.manager?.setDefaults({ model, effort, thinking, ultracode, fastMode })
    refreshModels()
      .then(() => refreshAll())
      .catch((e: unknown) => log.error(`Could not read the model list: ${String(e)}`))
  }

  /** Why this profile cannot start a session, or undefined. */
  const providerProblem = (): string | undefined => {
    const p = currentProvider()
    const problems = validateProfile(p)
    if (!problems.length) return undefined
    return `${profileLabel(p)}: ${problems.join(' ')}`
  }

  /**
   * Persist the profile list.
   *
   * `inherit` is dropped on the way out: it is synthesised by `parseProfiles`
   * and always present, so writing it would grow a duplicate entry in
   * `settings.json` on every save. Global rather than workspace by default,
   * because a gateway URL and a region are properties of the machine, not of
   * one checkout — and because a workspace-scoped provider would land in a
   * `.vscode/settings.json` that people commit.
   */
  async function saveProfiles(list: readonly ProviderProfile[]): Promise<void> {
    const out = list.filter((p) => p.id !== INHERIT_PROFILE.id)
    await cfg().update('providers', out, vscode.ConfigurationTarget.Global)
    providers = parseProfiles(out)
    await refreshProviderEnv()
    /* Rebuilt BEFORE the model is re-checked against it, and that order is the
       whole point of doing it here.
       A saved profile can change which models are on offer — that is what
       `profile.models` IS — and `alignModelToProvider()` decides whether the
       current selection still exists. Run against the catalogue built from the
       PREVIOUS profile it answers about a list nobody is on any more: ticking
       a model in settings left the composer on the old one, and unticking the
       selected one left it selected. One place recomputes, and it is the place
       that just changed the input. */
    recomputeCatalogue()
    alignModelToProvider()
    applyModelBook()
    refreshAll()
  }

  /** Ask for one field of a profile. Returns undefined only when cancelled, so
   *  an empty answer stays distinguishable from a dismissed box — the
   *  difference between "no region, use my AWS profile's" and "never mind". */
  async function askField(
    profile: ProviderProfile,
    field: (typeof PROVIDER_KINDS)[number]['fields'][number],
  ): Promise<string | undefined> {
    const current = (() => {
      const v = (profile as unknown as Record<string, unknown>)[field.key]
      if (Array.isArray(v)) return v.join(', ')
      return v === undefined || typeof v === 'boolean' ? '' : String(v)
    })()
    return vscode.window.showInputBox({
      title: `${profileLabel(profile)} — ${field.label}`,
      prompt: field.detail ?? `${field.label} for ${kindDef(profile.kind).label}`,
      ...(field.placeholder ? { placeHolder: field.placeholder } : {}),
      ...(field.secret
        // A secret is never pre-filled — that is the point of `password: true`.
        // So the box opens EMPTY, and the placeholder has to say what leaving
        // it empty now means, or the user cannot know.
        ? {
            password: true,
            placeHolder: hasSecret(profile)
              ? 'Leave blank to keep the credential you already saved'
              : (field.placeholder ?? ''),
          }
        : { value: current }),
      ignoreFocusOut: true,
    })
  }

  /** Does this profile claim a stored credential? Read off the profile, not the
   *  keychain: `hasCredential` exists precisely so the UI need not unlock the
   *  keychain on every repaint. */
  const hasSecret = (p: ProviderProfile): boolean => p.hasCredential === true

  /**
   * Walk a profile's fields and write the answers onto it.
   *
   * Driven by `kindDef().fields` rather than a form per kind, which is what
   * makes a new provider one entry in `PROVIDER_KINDS` instead of a new dialog.
   * The secret never lands on the profile: it goes to SecretStorage and only
   * `hasCredential` is recorded.
   */
  async function fillProfile(profile: ProviderProfile): Promise<boolean> {
    /* The credential is decided during the walk and written AFTER it, and both
       halves of that were bugs.

       An empty answer used to DELETE the secret. The box is never pre-filled —
       it is a password field — and for the gateway kind the credential comes
       before `models` and `contextWindow` in the field order, so there was no
       way to edit a model list without passing through the credential prompt.
       Pressing Enter through it, which is the obvious thing to do, silently
       wiped a working key. Blank now means KEEP, and the placeholder says so.
       Replacing a credential is typing a new one; getting RID of one is
       removing the provider, which deletes it and says so in the dialog. There
       is deliberately no blank-to-clear: a destructive default reachable by
       pressing Enter is what this was.

       And the keychain was written INSIDE the loop, so cancelling a later field
       returned false — discarding the profile edits but not the keychain
       mutation that had already run. That left `hasCredential: true` in
       settings with nothing behind it, and `hasCredential` exists so the UI can
       say "no credential set" without unlocking the keychain: a flag that lies
       is worse than no flag. Deferred, so a cancel changes nothing at all. */
    let secret: { set: string } | undefined
    for (const field of kindDef(profile.kind).fields) {
      const answer = await askField(profile, field)
      if (answer === undefined) return false
      const value = answer.trim()
      if (field.secret) {
        if (value) secret = { set: value }
        continue
      }
      const rec = profile as unknown as Record<string, unknown>
      if (!value) { delete rec[field.key]; continue }
      if (field.key === 'models') {
        rec.models = value.split(',').map((m) => m.trim()).filter(Boolean)
      } else if (field.key === 'contextWindow') {
        const n = Number(value.replace(/[_,\s]/g, ''))
        if (Number.isFinite(n) && n > 0) rec.contextWindow = n
        else delete rec.contextWindow
      } else {
        rec[field.key] = value
      }
    }
    // Only now that every field was answered. A cancel above returns false and
    // touches neither the profile nor the keychain.
    if (secret) {
      await context.secrets.store(credentialKey(profile.id), secret.set)
      profile.hasCredential = true
    }
    return true
  }

  /** Add a provider, starting from a preset so the common cases need no typing.
   *  A preset is only a pre-filled profile — it adds no code path, so it cannot
   *  behave differently from one configured by hand. */
  async function addProvider(): Promise<void> {
    const pick = await vscode.window.showQuickPick(
      PROVIDER_PRESETS.map((preset) => ({
        label: preset.label,
        description: kindDef(preset.profile.kind).support === 'community' ? 'community proxy' : '',
        detail: preset.needs ?? kindDef(preset.profile.kind).blurb,
        preset,
      })),
      {
        title: 'Add a provider',
        placeHolder: 'Which backend should agents run on?',
        ignoreFocusOut: true,
      },
    )
    if (!pick) return

    // Ids must be unique and are used as the SecretStorage key, so a second
    // "Ollama" cannot be allowed to share the first one's credential.
    const taken = new Set(providers.map((p) => p.id))
    let id = pick.preset.id
    for (let n = 2; taken.has(id); n++) id = `${pick.preset.id}-${n}`

    const profile: ProviderProfile = { ...pick.preset.profile, id }
    if (!(await fillProfile(profile))) return

    const problems = validateProfile(profile)
    if (problems.length) {
      const choice = await vscode.window.showWarningMessage(
        `That provider is not usable yet: ${problems.join(' ')}`,
        'Save anyway', 'Discard',
      )
      if (choice !== 'Save anyway') return
    }

    await saveProfiles([...providers, profile])
    await setActiveProvider(id)
    refreshAll()
    log.info(`Provider added: ${profileLabel(profile)} (${describeProfile(profile)})`)
    // Offered, not run. A probe spawns a CLI process and can wait 20 seconds on
    // an unreachable host, so doing it unasked after every add is a surprise —
    // and this way the prerequisite and the way to check it arrive together,
    // which is the moment they are both relevant.
    const next = await vscode.window.showInformationMessage(
      `Provider "${profileLabel(profile)}" added.` +
      (pick.preset.needs ? ` It needs: ${pick.preset.needs}` : ''),
      'Test connection',
    )
    if (next === 'Test connection') await testProvider()
  }

  /** Connect with the active profile and report what the CLI resolved. Costs
   *  nothing — see `probeProvider`, which never sends a prompt. */
  async function testProvider(): Promise<void> {
    const profile = currentProvider()
    const problems = validateProfile(profile)
    if (problems.length) {
      vscode.window.showErrorMessage(`${profileLabel(profile)}: ${problems.join(' ')}`)
      return
    }
    await refreshProviderEnv()
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Testing ${profileLabel(profile)}…` },
      () => probeProvider(profile, providerEnv, {
        ...(cfg().get<string>('claudeExecutable') ? { claudeExecutable: cfg().get<string>('claudeExecutable')! } : {}),
        ...(ws?.root ? { cwd: ws.root } : {}),
      }),
    )
    log.info(`Provider test — ${profileLabel(profile)}: ${result.message}`)

    /* A catalogue the ENDPOINT gave us is kept, and kept in extension storage
       rather than in `settings.json`.
       This used to write `result.models` onto the profile, and `result.models`
       came from `Query.supportedModels()` — Claude Code's own list, which is
       about Claude Code no matter where the base URL points. A DeepSeek profile
       therefore ended up declaring `sonnet`, `haiku` and `opus[1m]`, and since
       a profile's declared list outranks everything else, the composer offered
       exactly those and nothing that endpoint serves. That is the bug this
       whole path exists to have fixed. `catalogue` is the endpoint's answer;
       `models` on a gateway result is now derived from it. */
    if (result.catalogue?.length) {
      await context.globalState.update(endpointKey(profile.id), result.catalogue)
      applyModelBook()
      recomputeCatalogue()
      alignModelToProvider()
      refreshAll()
      const priced = result.catalogue.filter((m) => m.rate).length
      const choice = await vscode.window.showInformationMessage(
        `${result.message} ${priced ? `${priced} of them come with a published price.` : ''}`.trim(),
        'Choose which to offer…',
      )
      if (choice === 'Choose which to offer…') openSettings()
      return
    }
    // Everything that is NOT a custom endpoint: the CLI is the right thing to
    // have asked, because the backend serves Claude's models and the CLI
    // resolves the ids for it — `us.anthropic.claude-opus-5` on Bedrock.
    if (result.ok && result.models?.length && profile.kind !== 'inherit'
        && profile.kind !== 'gateway' && !profile.models?.length) {
      const choice = await vscode.window.showInformationMessage(
        `${result.message} Use these ${result.models.length} models in the picker?`,
        'Use them', 'No thanks',
      )
      if (choice === 'Use them') {
        const updated = providers.map((p) => (p.id === profile.id ? { ...p, models: result.models } : p))
        await saveProfiles(updated)
      }
      return
    }
    if (result.ok) vscode.window.showInformationMessage(result.message)
    else vscode.window.showErrorMessage(`${profileLabel(profile)}: ${result.message}`)
  }

  /** Remove a profile, and its credential with it. Leaving an orphaned secret
   *  in the keychain is invisible and outlives the thing that explained it. */
  async function removeProvider(profile: ProviderProfile): Promise<void> {
    if (profile.id === INHERIT_PROFILE.id) {
      vscode.window.showInformationMessage('"Inherit from environment" is always available and cannot be removed.')
      return
    }
    const choice = await vscode.window.showWarningMessage(
      `Remove the provider "${profileLabel(profile)}"?`,
      { modal: true, detail: 'Its stored credential is deleted too.' },
      'Remove',
    )
    if (choice !== 'Remove') return
    await context.secrets.delete(credentialKey(profile.id))
    // And its model cache. Both are keyed by the profile ID, and ids are
    // REUSED: delete "ollama", add "ollama" again, and the new profile would
    // inherit the old one's model list — a picker offering models the new
    // endpoint has never heard of, with nothing on screen to explain it.
    // Every runtime's entry. `catalogueKey` defaults its runtime argument to
    // whichever is SELECTED, and provider management is reachable from the
    // settings page whatever that is — so the stale entry this means to evict
    // survived whenever another runtime had written it, and a re-added profile
    // with the same id inherited a picker full of the old endpoint's models.
    for (const r of allRuntimes()) {
      await context.globalState.update(catalogueKey(profile.id, r.id), undefined)
    }
    // And what its endpoint said it served. Same reason, same reused ids: an
    // "openrouter" profile removed and re-added against a different URL would
    // otherwise come back offering the old host's 431 models.
    await context.globalState.update(endpointKey(profile.id), undefined)
    await saveProfiles(providers.filter((p) => p.id !== profile.id))
    if (providerId === profile.id) await setActiveProvider(INHERIT_PROFILE.id)
    refreshAll()
  }

  /** The one entry point: choose a provider, or manage the list. */
  // --- the settings page ----------------------------------------------------
  //
  // A real editor tab rather than a quick pick, because a quick pick closes
  // when focus moves and takes a half-typed gateway URL with it. See
  // board/settings.ts for the rest of that argument.
  //
  // Statuses are CACHED, because collecting them spawns one process per
  // runtime: the page asks for a refresh explicitly, and a stale readout is
  // shown with the time it was taken rather than silently re-fetched on every
  // repaint.

  let runtimeStatuses: RuntimeStatus[] = []
  /**
   * Which agent programs are actually on this machine.
   *
   * Kept apart from `runtimeStatuses` because it is answered by a much cheaper
   * question: `detect()` looks for an executable, where `login()` starts the
   * CLI and asks it who it is. The composer only needs the first, and it needs
   * it at activation — an agent that is not installed must not be offered as
   * something to run a session on, because every session started on it fails at
   * its first step.
   *
   * Absent means NOT CHECKED, and is rendered as available. Hiding something we
   * have not looked for is the same mistake as showing a state we did not read.
   */
  const installedRuntimes = new Map<RuntimeId, boolean>()

  /** Look for each agent's executable. Backgrounded at activation, never
   *  awaited: it shells out to `which` and, for Codex, a `--version`. */
  async function detectRuntimes(): Promise<void> {
    await Promise.all(allRuntimes().map(async (rt) => {
      try {
        installedRuntimes.set(rt.id, !!(await rt.detect(configuredPathFor(rt.id))))
      } catch {
        // Could not look. Left ABSENT rather than recorded as false: "the
        // lookup failed" is not "you do not have it".
        installedRuntimes.delete(rt.id)
      }
    }))
    for (const rt of allRuntimes()) {
      if (installedRuntimes.get(rt.id) === false) log.info(`${rt.label} is not installed; not offered on the composer.`)
    }
  }

  /**
   * Every (agent × backend) pair this machine can actually run, as one list.
   *
   * The composer used to offer these as two separate pickers, which made the
   * user do the cross product in their head — and got the answer wrong on
   * screen: the bar said "Claude Code" while the model list came from DeepSeek,
   * because the backend lived on a different page. One list, one click, and the
   * model picker follows.
   *
   * A runtime with no backend concept contributes ONE entry, not one per
   * profile: Codex signs in as itself, and pairing it with a gateway would
   * offer a combination that cannot exist.
   */
  const agentKey = (rt: RuntimeId, profileId: string): string =>
    `${rt}|${getRuntime(rt)?.capabilities.providerProfiles ? profileId : ''}`

  function agentChoices(): { key: string; label: string; detail: string; runtime: string; provider: string }[] {
    const out: { key: string; label: string; detail: string; runtime: string; provider: string }[] = []
    for (const rt of allRuntimes()) {
      // Not offered when we KNOW it is missing; offered when we have not looked.
      if (installedRuntimes.get(rt.id) === false) continue
      if (!rt.capabilities.providerProfiles) {
        out.push({ key: agentKey(rt.id, ''), label: rt.label, detail: rt.vendor, runtime: rt.id, provider: '' })
        continue
      }
      for (const p of providers) {
        const inherit = p.id === INHERIT_PROFILE.id
        out.push({
          key: agentKey(rt.id, p.id),
          // The BACKEND is what distinguishes two entries on the same runtime,
          // so it is the name; the inherit profile makes no claim about a
          // backend, so that entry is named by the agent instead.
          label: inherit ? rt.label : profileLabel(p),
          detail: inherit ? `${rt.vendor} · default backend` : `${rt.label} · ${describeProfile(p)}`,
          runtime: rt.id,
          provider: p.id,
        })
      }
    }
    return out
  }
  /** Why a backend's endpoint would not list its models, keyed by profile id.
   *  Kept so the settings page can say "I asked and this is what happened"
   *  rather than showing an empty list, which reads as "there are none". */
  const endpointNotes = new Map<string, string>()
  const runtimeModels = new Map<RuntimeId, { models: { id: string; label: string }[]; source: string; note?: string }>()
  let settingsBusy: string | undefined

  // ——— Voice dictation (the composer's mic) ———
  //
  // The mic is gated on an actual check of two user-installed binaries, and a
  // check SPAWNS THEM, so it is never on the render path and never at
  // activation: the board's first paint does not wait for two `--version`
  // probes. `voiceResult` is written once per real check and invalidated when
  // the config it describes changes; `liveCapture` is live state, cleared when
  // the capture ends however it ends.

  /** The four settings that describe the pipeline, read together so the cached
   *  result always knows which config it was an answer to. Spelled `cfg().get`
   *  (not a saved `const c`) because the smoke gate counts declared settings by
   *  that exact spelling — a read through a local variable is a setting that
   *  looks unread. */
  const voiceConfig = (): VoiceConfig => {
    return {
      whisperPath: cfg().get<string>('whisperPath') ?? '',
      whisperModel: cfg().get<string>('whisperModel') ?? '',
      ffmpegPath: cfg().get<string>('ffmpegPath') ?? '',
      recordDevice: cfg().get<string>('recordDevice') ?? '',
    }
  }

  /** The config keys the voice cache depends on — one invalidation list for the
   *  config listener, so a new key cannot be forgotten there. */
  const VOICE_KEYS = ['whisperPath', 'whisperModel', 'ffmpegPath', 'recordDevice']

  interface VoiceResult { checks: VoiceChecks; cfg: VoiceConfig; at: number }
  let voiceResult: VoiceResult | undefined
  let voiceChecking: Promise<VoiceResult> | undefined
  /** A recording in progress, if there is one. */
  let liveCapture: Capture | undefined

  /** Ask the two binaries where they are — once, never twice at once. */
  function voiceCheckNow(): Promise<VoiceResult> {
    if (voiceResult) return Promise.resolve(voiceResult)
    voiceChecking ??= Promise.resolve().then(() => {
      const cfg = voiceConfig()
      const checks = checkVoice(cfg)
      voiceResult = { checks, cfg, at: Date.now() }
      return voiceResult
    }).finally(() => { voiceChecking = undefined })
    return voiceChecking
  }

  /** The composer's mic facts from the last check. Runs on every repaint, so
   *  it is pure — the check it summarises never does. */
  const voiceState = (r: VoiceResult) => {
    const v = verdict(r.checks)
    return {
      voice: {
        available: v.ok,
        ...(v.why ? { why: v.why } : {}),
        recording: !!liveCapture,
      },
    }
  }

  /** The first check, after the window has had a second to paint. */
  let voiceKicked = false
  const kickVoiceCheck = (): void => {
    if (voiceKicked) return
    voiceKicked = true
    setTimeout(() => {
      voiceCheckNow()
        .then(() => { refreshAll(); void SettingsPanel.refreshIfOpen() })
        .catch((e: unknown) => log.error(`Voice check failed: ${String(e)}`))
    }, 2000)
  }

  const configuredPathFor = (id: RuntimeId): string | undefined =>
    id === 'claude' ? (cfg().get<string>('claudeExecutable') || undefined)
      : id === 'codex' ? (cfg().get<string>('codexExecutable') || undefined)
      : undefined

  // ——— Scheduled runs (time triggers) ———
  //
  // A schedule says "at HH:MM on these days, start a session with this
  // prompt". It lives in workspace state, fires only while the extension is
  // running, and catches up when the due moment passed with no window open —
  // once, because `nextFireAt` is anchored to `lastFiredAt`. The rules of a
  // fire (when, whether a draft parses) live in schedules.ts and are tested
  // there; everything here is the act of firing — creating the session — which
  // only the host can do.

  /** Read back once, at activation: storage outlives the version that wrote it,
   *  so this is a parse, never a cast. Every later write goes through
   *  `saveSchedules`, which keeps the in-memory list and the store in step. */
  let schedules: Schedule[] = parseSchedules(state.get<unknown>('schedules'))

  const saveSchedules = async (next: Schedule[]): Promise<void> => {
    schedules = next
    await state.update('schedules', schedules)
  }

  /** Whether a scheduled run could start a session right now. A schedule that
   *  cannot fire is left DUE rather than marked failed — opening a repo later
   *  the same day should still catch today's run up. */
  const canRunScheduled = (): boolean => !!ws?.worktrees

  /** The rows the settings page shows, derived. */
  const scheduleView = (): { rows: ScheduleRowState[]; canRun: boolean; problem?: string } => {
    const canRun = canRunScheduled()
    return {
      canRun,
      ...(!canRun
        ? { problem: !ws
            ? 'A scheduled run needs a folder open. Open one and the runs catch up.'
            : 'This folder is not a git repository, so no session can start in a worktree.' }
        : {}),
      rows: schedules.map((s): ScheduleRowState => {
        const after = s.lastFiredAt ?? s.createdAt
        const nextAt = s.enabled && s.days.length ? nextFireAt(s, after) : undefined
        return {
          id: s.id,
          title: s.title,
          prompt: s.prompt,
          hour: s.hour,
          minute: s.minute,
          days: s.days,
          enabled: s.enabled,
          when: describeWhen(s),
          ...(nextAt !== undefined ? { nextAt } : {}),
          ...(s.lastRun ? { lastRun: s.lastRun } : {}),
        }
      }),
    }
  }

  /** Fire one schedule's session NOW. Shared by the due-check, "Run now" and
   *  the catch-up after a resume — one path, so a session that starts from any
   *  of the three behaves the same.
   *
   *  The attempt is recorded BEFORE the session is asked for: `lastFiredAt` is
   *  the anchor that stops the next tick firing the same schedule again, so it
   *  must be in place before any await that could fail. A crash between the
   *  record and the start costs one day's run (the catch-up semantics), never a
   *  double fire. `lastRun` records whether the session actually STARTED; a
   *  session that starts and then fails is a failed session on the board, which
   *  is its own card's story. */
  async function fireScheduleNow(s: Schedule, manual: boolean): Promise<void> {
    if (!canRunScheduled()) {
      if (manual) {
        void vscode.window.showWarningMessage(
          'A scheduled run needs a folder with a git repo open. Open one and press Run again.')
      }
      return
    }
    const stamp = Date.now()
    // Synchronous in-memory first: the next tick (or a concurrent Run now) must
    // already see this schedule as fired, no matter what the persist does.
    schedules = schedules.map((x) => (x.id === s.id ? { ...x, lastFiredAt: stamp } : x))
    const title = s.title
    settingsBusy = `Starting scheduled run "${title}"…`
    void SettingsPanel.refreshIfOpen()
    try {
      // The same pre-flight as a composer send: a half-configured provider does
      // not fail here at first contact — it fails at the first API call after a
      // card has appeared, and nobody connects the two.
      const problem = providerProblem()
      if (problem) throw new Error(problem)
      await refreshProviderEnv()
      const mgr = ensureManager()
      mgr.setProvider(currentProvider(), providerEnv)
      const runId = await mgr.start(s.prompt, { title })
      const queued = ws?.manager?.byKey(runId)?.state.kind === 'queued'
      await saveSchedules(schedules.map((x) =>
        x.id === s.id ? { ...x, lastRun: { at: Date.now(), ok: true } } : x))
      log.info(`Scheduled run "${title}" started (${runId})`)
      refreshAll()
      void SettingsPanel.refreshIfOpen()
      void vscode.window.showInformationMessage(
        queued
          ? `Scheduled run "${title}" is queued behind running sessions and will start when one finishes.`
          : `Scheduled run "${title}" started.`)
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e)
      await saveSchedules(schedules.map((x) =>
        x.id === s.id ? { ...x, lastRun: { at: Date.now(), ok: false, note } } : x))
      void SettingsPanel.refreshIfOpen()
      void vscode.window.showWarningMessage(`Scheduled run "${title}" did not start: ${note}`)
    } finally {
      settingsBusy = undefined
      void SettingsPanel.refreshIfOpen()
    }
  }

  /** Fire every enabled schedule whose moment has passed. Runs at most one pass
   *  at a time — a fire awaits the CLI setup, and a second pass starting inside
   *  that window must not fire the same schedule twice. */
  let schedulePassInFlight = false
  async function fireDueSchedules(): Promise<void> {
    if (schedulePassInFlight || !canRunScheduled()) return
    schedulePassInFlight = true
    try {
      for (const s of schedules) {
        if (!s.enabled) continue
        const next = nextFireAt(s, s.lastFiredAt ?? s.createdAt)
        if (next === undefined || next > Date.now()) continue
        await fireScheduleNow(s, false)
      }
    } finally {
      schedulePassInFlight = false
    }
  }

  // The heartbeat. Sixty seconds because a fire needs nothing faster, and a
  // one-minute delay on a schedule whose hour has passed is invisible next to
  // the catch-up that already happened at activation.
  const scheduleTimer = setInterval(
    () => { void fireDueSchedules().catch((e) => log.error(`Schedule check failed: ${String(e)}`)) },
    60_000,
  )
  context.subscriptions.push({ dispose: () => clearInterval(scheduleTimer) })
  // Catch-up for a morning that passed while the window was closed: activation
  // IS the moment the extension can run again, so it is the check. Never a bare
  // `void`: a rejection here is a schedule that silently did not fire.
  void fireDueSchedules().catch((e) => log.error(`Schedule catch-up failed: ${String(e)}`))

  /* --- Remote Control: the half on this machine ------------------------------
   *
   * The board can be watched from anywhere through a small site the user
   * deploys (see remote/README.md — that folder lifts into its own repo). This
   * machine is the only writer; the site only stores and serves. The tested
   * decisions live in src/remote/: relay.ts is the SHAPE of what may leave
   * (its tests pin the redaction field by field), pusher.ts is WHEN (cadence,
   * heartbeat, backoff), feed.ts is WHAT changed (a transcript tail travels
   * only when it grew). Left for the host is the act itself: where the pieces
   * are stored, what a snapshot is built from, and the settings-page buttons.
   *
   * Storage follows the house rules: the URL and the on/off flag are plain
   * workspace state, parsed on the way back; the pairing code is a credential,
   * so it lives in SecretStorage and never crosses the postMessage boundary in
   * either direction — the page sees only `hasCode`, a boolean from the one
   * read at activation.
   */
  const remoteCodeKey = 'remote.code'
  const storedRemoteUrl = String(state.get<unknown>('remote.url') ?? '')
  let remoteUrl = storedRemoteUrl ? (relayBase(storedRemoteUrl) ?? '') : ''
  let remoteEnabled = state.get<unknown>('remote.enabled') === true
  let remoteHasCode = false
  let remoteBoardId = ''
  let remoteStatus: { at: number; ok: boolean; note?: string; error?: string } | undefined
  let remotePusher: RemotePusher | undefined
  const remoteFeed = new RemoteFeed()

  /** How fresh a stored session's last update must be to ride the one-time
   *  backfill, and how big one backfill POST may be (a tail is at most
   *  TAIL_MAX rows; bytes are what actually bounds a POST). */
  const REMOTE_FRESH_MS = 14 * 24 * 60 * 60 * 1000
  const REMOTE_CHUNK_BYTES = 150_000

  /** The snapshot one push carries: the CURRENT board from the host's own
   *  getState — the same state the window paints — with each card mapped
   *  through `toRemoteCard`, the one place a card is filtered. Tails come from
   *  live runs only: a run that is not live cannot grow, so it has nothing new
   *  to send; sessions that ended while the relay was unreachable are
   *  re-synced by `remoteBackfill` at enable time. With no folder open the
   *  board IS empty, so an empty snapshot is the truth, not a bug. */
  async function buildRemoteSnapshot(): Promise<PushSnapshot> {
    const ui = await host.getState()
    const columns = ui.columns.map((c) => ({ id: c.id, name: c.name }))
    const cards = ui.cards.map((c) => toRemoteCard(c))
    const tails: TailSource[] = (ws?.manager?.list() ?? []).map((a) => ({
      key: a.sessionId ?? a.runId,
      history: a.history,
      live: a.live,
    }))
    return remoteFeed.build(Date.now(), columns, cards, tails)
  }

  /** (Re)build the engine from the CURRENT settings. Called at activation and
   *  after every change from the settings page, so enabling, repointing or
   *  clearing the code takes effect immediately. Cadence state is dropped on
   *  purpose: a fresh engine's first tick compares against nothing and pushes,
   *  which is exactly what a config change should do. `remoteFeed` is NOT
   *  dropped — what the relay already holds is still true until the code
   *  changes, and the reset for that lives in the saveRemote case. */
  function syncRemoteEngine(): void {
    const baseUrl = remoteUrl ? relayBase(remoteUrl) : undefined
    remotePusher = new RemotePusher({
      now: Date.now,
      baseUrl,
      boardId: remoteBoardId,
      enabled: remoteEnabled && remoteHasCode && !!baseUrl,
      fetch,
      build: buildRemoteSnapshot,
      onStatus: (s) => {
        remoteStatus = s
        // The settings page's status line must move on success too — a green
        // tick that no attempt ever produced is the page's own forbidden
        // signal, and so is a red one that a later success never clears.
        void SettingsPanel.refreshIfOpen()
      },
    })
  }

  /** Push the recent board to the relay in one bounded pass: the sync when a
   *  relay is first configured, and again at activation, because counts live
   *  only in memory and the relay may hold a board from days ago. Sessions the
   *  board shows whose last update is fresh enough each send their transcript
   *  tail; chunks keep one POST bounded, and every chunk carries its own
   *  freshly built index, so the relay is never left claiming a tail it does
   *  not have. A chunk that did not go out rolls its sessions' counts back, so
   *  the next backfill sends them again. */
  async function remoteBackfill(): Promise<void> {
    if (!remotePusher || !ws) return
    const live = new Set((ws.manager?.list() ?? []).map((a) => a.sessionId ?? a.runId))
    const stored = await ws.store.list({ includeArchived: false })
    const fresh = stored.filter((s) =>
      !live.has(s.id) && Date.now() - s.updated < REMOTE_FRESH_MS && remoteFeed.tvOf(s.id) === 0)
    let chunk: RemoteTail[] = []
    let bytes = 0
    const flush = async (): Promise<void> => {
      if (!chunk.length) return
      const ui = await host.getState()
      const index = remoteFeed.build(
        Date.now(),
        ui.columns.map((c) => ({ id: c.id, name: c.name })),
        ui.cards.map((c) => toRemoteCard(c)),
        [],
      ).index
      const pushed = remotePusher ? await remotePusher.pushRaw(index, chunk) : false
      if (!pushed) {
        for (const t of chunk) remoteFeed.setCount(t.key, 0)
      }
      chunk = []
      bytes = 0
    }
    for (const s of fresh) {
      const hist = await ws.store.transcript(s.id)
      if (!hist.length) continue
      const tail = projectTail(Date.now(), s.id, hist, [])
      if (!tail) continue
      // Marked BEFORE the index is built: the chunk's own index must claim the
      // tail it carries, or the page would never fetch it.
      remoteFeed.setCount(s.id, hist.length)
      bytes += JSON.stringify(tail).length
      chunk.push(tail)
      if (bytes >= REMOTE_CHUNK_BYTES) await flush()
    }
    await flush()
  }

  // The pairing code is read ONCE, here: `hasCode` for the settings page is
  // this boolean, and the code itself is never kept anywhere but the keychain.
  // One SecretStorage IPC before the rest of activation is cheaper than a page
  // that can show the wrong half of "is this connected".
  const storedCode = await context.secrets.get(remoteCodeKey)
  if (storedCode) {
    remoteHasCode = true
    remoteBoardId = boardIdOf(storedCode)
  }
  syncRemoteEngine()
  if (remoteEnabled && remoteHasCode && remoteUrl) {
    log.info('Remote Control is on — syncing the board to the relay site')
    void remoteBackfill().catch((e) => log.error(`Remote backfill failed: ${String(e)}`))
  }

  // The engine's own ticker. Repaints nudge it too (see `paint`), but a board
  // with no agent running produces no repaints, so this is what keeps the
  // idle heartbeat honest. Cheap when there is nothing to do: tick() checks
  // its gates before building anything.
  const remoteTimer = setInterval(() => {
    void remotePusher?.tick().catch((e) => log.error(`Remote tick failed: ${String(e)}`))
  }, 30_000)
  context.subscriptions.push({ dispose: () => clearInterval(remoteTimer) })

  async function refreshRuntimeStatus(only?: RuntimeId): Promise<void> {
    settingsBusy = only ? `Checking ${only}…` : 'Checking which agents are installed…'
    void SettingsPanel.refreshIfOpen()
    try {
      const configured: Partial<Record<RuntimeId, string | undefined>> = {}
      for (const rt of allRuntimes()) configured[rt.id] = configuredPathFor(rt.id)
      // The ACTIVE backend's environment, so `login()` answers about the
      // sessions this board starts rather than about `claude` on its own.
      await refreshProviderEnv()
      const fresh = await collectRuntimeStatus(configured, providerEnv)
      runtimeStatuses = only
        // A single-runtime refresh must not blank the others' readouts — the
        // page would then show "not checked yet" for something it checked a
        // second ago, which reads as the check having failed.
        ? runtimeStatuses.filter((r) => r.id !== only).concat(fresh.filter((r) => r.id === only))
        : fresh
      for (const r of runtimeStatuses) {
        // The full check outranks the cheap one: same question, better answer.
        installedRuntimes.set(r.id, r.login.kind !== 'notInstalled')
        if (r.login.kind === 'notInstalled') log.info(`${r.label} is not installed.`)
        else if (r.login.kind === 'signedOut') log.warn(`${r.label} is installed but signed out.`)
      }
    } finally {
      settingsBusy = undefined
    }
  }

  const settingsHost: SettingsHost = {
    async getState(): Promise<SettingsState> {
      const active = currentProvider()
      return {
        defaultRuntime: runtime,
        ...(settingsBusy ? { busy: settingsBusy } : {}),
        runtimes: allRuntimes().map((rt) => {
          const models = runtimeModels.get(rt.id)
          const status = runtimeStatuses.find((r) => r.id === rt.id)
          return {
            id: rt.id,
            label: rt.label,
            vendor: rt.vendor,
            blurb: rt.blurb,
            installHint: rt.installHint,
            providerProfiles: rt.capabilities.providerProfiles,
            ...(status ? { status } : {}),
            // What a session on this agent would actually talk to. Only where
            // a backend is a real choice — Codex signs in as itself, and a
            // backend row over it would be naming something that does not
            // exist.
            ...(rt.capabilities.providerProfiles
              ? {
                  backend: {
                    label: profileLabel(active),
                    detail: describeProfile(active),
                    usesLogin: usesRuntimeLogin(active),
                    ...(active.hasCredential
                      ? { credential: 'key in keychain' }
                      : active.credentialFromEnv
                        ? { credential: `$${active.credentialFromEnv}` }
                        : {}),
                  },
                }
              : {}),
            ...(models ? { models: models.models, modelSource: models.source } : {}),
            ...(models?.note ? { modelNote: models.note } : {}),
          }
        }),
        activeProvider: providerId,
        providers: providers.map((p) => {
          const served = p.kind === 'gateway' ? cachedEndpoint(p.id) : []
          const offered = new Set(p.models ?? [])
          return {
            id: p.id,
            label: profileLabel(p),
            kind: p.kind,
            detail: describeProfile(p),
            active: p.id === providerId,
            hasCredential: p.hasCredential === true,
            ...(p.baseUrl?.trim() ? { endpointHost: hostOf(p.baseUrl) } : {}),
            ...(served.length
              ? {
                  models: served.map((m) => ({
                    id: m.id,
                    label: m.label ?? m.id,
                    context: windowLabel(m.contextWindow ?? p.contextWindow),
                    ...(priceLabel(m.rate) ? { price: priceLabel(m.rate)! } : {}),
                    offered: offered.has(m.id),
                  })),
                }
              : {}),
            // The ids a profile declares that its endpoint does not serve. This
            // is the state a user was actually left in — six Claude aliases on
            // a DeepSeek profile — and a settings page that showed the list
            // without saying that would be the page that hid the bug.
            ...(served.length && p.models?.length
              && !p.models.some((id) => served.some((m) => m.id === id))
              ? {
                  modelNote:
                    `Not served here: ${p.models.join(', ')}. ` +
                    'Those are ignored — tick what you want instead.',
                }
              : {}),
            ...(!served.length && p.kind === 'gateway' && p.baseUrl?.trim()
              ? { modelNote: endpointNotes.get(p.id) ?? 'Not asked yet.' }
              : {}),
          }
        }),
        // One row per piece of the dictation pipeline. Absent until the user
        // presses "Check" (or the config changed and the host re-checked) —
        // checking spawns the binaries, which is never something a page paint
        // does, so the section says "not checked yet" when this is missing.
        ...(voiceResult
          ? {
              voice: {
                at: voiceResult.at,
                rows: rowsFromChecks(voiceResult.cfg, voiceResult.checks),
              },
            }
          : {}),
        // Always present — empty is a real state ("no schedules yet"), not an
        // absence the page has to guess about. `canRun: false` with its reason
        // travels here so a schedule that cannot fire is never shown with a
        // countdown that can never reach zero.
        schedules: scheduleView(),
        // Always present, same reasoning. `status` is absent until the first
        // push attempt, which the page renders as "not asked yet" rather than
        // as a green tick — the code never travels, only `hasCode`.
        remote: {
          enabled: remoteEnabled,
          url: remoteUrl,
          hasCode: remoteHasCode,
          ...(remoteStatus ? { status: remoteStatus } : {}),
        },
      }
    },

    async handle(msg: SettingsMessage): Promise<void> {
      switch (msg.type) {
        case 'ready':
          // The first render must not block on spawning two CLIs, so the page
          // paints with "not checked yet" and this fills it in.
          if (!runtimeStatuses.length) await refreshRuntimeStatus()
          return
        case 'refresh':
          await refreshRuntimeStatus(msg.runtime)
          return
        case 'setDefaultRuntime': {
          runtime = msg.runtime
          await state.update('runtime', runtime)
          // The model list is PER RUNTIME, so a switch here strands the picker
          // on an id the new agent does not serve — `claude-opus-5` selected,
          // then a move to Codex, which fails at the first request with somebody
          // else's error message. The composer's own runtime switch has done
          // this since it was written; this path was the documented way to
          // change agent and did not.
          void refreshModels(true).then(() => { void SettingsPanel.refreshIfOpen(); refreshAll() })
          // Next session only, exactly like the provider: the runtime IS the
          // process, so there is no honest way to move a live run onto another
          // agent program — its transcript belongs to the one it started on.
          ws?.manager?.setDefaults({ model, effort, thinking, ultracode, fastMode, runtime })
          const rt = getRuntime(runtime)
          void vscode.window.showInformationMessage(
            `New sessions will run on ${rt?.label ?? runtime}. Sessions already running keep the agent they started on.`,
          )
          refreshAll()
          return
        }
        case 'install': {
          const rt = getRuntime(msg.runtime)
          if (!rt) return
          await vscode.env.clipboard.writeText(rt.installHint)
          void vscode.window.showInformationMessage(
            `Copied: ${rt.installHint} — run it in a terminal, then press "Check again".`,
          )
          return
        }
        case 'signIn': {
          const rt = getRuntime(msg.runtime)
          if (!rt) return
          // A terminal rather than running it for them: these commands open a
          // browser and want an interactive TTY, and a login we drove invisibly
          // is a credential the user did not watch being created.
          const term = vscode.window.createTerminal(`${rt.label} sign-in`)
          term.show()
          term.sendText(msg.runtime === 'codex' ? 'codex login' : 'claude /login', false)
          void vscode.window.showInformationMessage(
            `Press Enter in the terminal to sign in to ${rt.label}, then press "Check again" here.`,
          )
          return
        }
        case 'refreshModels': {
          const rt = getRuntime(msg.runtime)
          if (!rt) return
          settingsBusy = `Asking ${rt.label} which models it can run…`
          void SettingsPanel.refreshIfOpen()
          try {
            /* Claude Code answers through `agent/models.ts`, not through
               `claudeRuntime.models()`.
               That method is a deliberate stub — it ignores its argument and
               always returns the built-in list, and its own doc comment says
               "the settings page asks `models.ts`". The settings page did not:
               it took this path for EVERY runtime, so the page always reported
               the built-in three and blamed the CLI for not answering, on the
               one screen whose job is to explain why a model is missing. Two
               functions that both know how to fall back, and the wrong one was
               being asked. */
            if (msg.runtime === 'claude') {
              await refreshModels(true)
              runtimeModels.set(msg.runtime, {
                models: catalogue.choices.map((m) => ({ id: m.id, label: m.label })),
                source: catalogue.source === 'cli' ? 'runtime' : catalogue.source,
                ...(catalogue.problem ? { note: catalogue.problem } : {}),
              })
              return
            }
            const loc = await rt.detect(configuredPathFor(msg.runtime))
            if (!loc) {
              runtimeModels.set(msg.runtime, {
                models: rt.builtinModels().map((m) => ({ id: m.id, label: m.label })),
                source: 'builtin',
                note: `${rt.label} is not installed, so this is the built-in list.`,
              })
              return
            }
            const cat = await rt.models(loc)
            runtimeModels.set(msg.runtime, {
              models: cat.models.map((m) => ({ id: m.id, label: m.label })),
              source: cat.source,
              ...(cat.note ? { note: cat.note } : {}),
            })
          } finally {
            settingsBusy = undefined
          }
          return
        }
        case 'selectProvider':
          await setActiveProvider(msg.id)
          return
        case 'addProvider':
          await addProvider()
          return
        case 'editProvider': {
          const p = providers.find((x) => x.id === msg.id)
          if (!p) return
          const copy = { ...p }
          if (await fillProfile(copy)) await saveProfiles(providers.map((x) => (x.id === copy.id ? copy : x)))
          return
        }
        case 'removeProvider': {
          const p = providers.find((x) => x.id === msg.id)
          if (p) await removeProvider(p)
          return
        }
        case 'testProvider':
          if (msg.id !== providerId) await setActiveProvider(msg.id)
          await testProvider()
          return
        case 'refreshEndpoint': {
          const p = providers.find((x) => x.id === msg.id)
          if (!p) return
          settingsBusy = `Asking ${p.baseUrl ? hostOf(p.baseUrl) : profileLabel(p)} which models it serves…`
          void SettingsPanel.refreshIfOpen()
          try {
            const problem = await refreshEndpointModels(p, true)
            // Only the ACTIVE profile's list is the one on the composer, so
            // only that one changes what the board is showing.
            if (p.id === providerId) { recomputeCatalogue(); alignModelToProvider(); refreshAll() }
            if (problem) vscode.window.showWarningMessage(`${profileLabel(p)}: ${problem}`)
          } finally {
            settingsBusy = undefined
          }
          return
        }
        case 'setProfileModels': {
          const p = providers.find((x) => x.id === msg.id)
          if (!p) return
          /* An EMPTY list is written as "no list", not as an empty one.
             `parseProfiles` drops an empty `models` array on the way back in,
             and `mergeModels` reads "declares nothing" as "offer everything the
             endpoint serves" — so the two agree only if untick-everything
             REMOVES the key. Left as `[]` it would round-trip to undefined
             anyway; writing it explicitly is what makes that intentional rather
             than incidental. */
          const next: ProviderProfile = { ...p }
          if (msg.models.length) next.models = msg.models
          else delete next.models
          await saveProfiles(providers.map((x) => (x.id === next.id ? next : x)))
          return
        }
        case 'openSetting':
          await vscode.commands.executeCommand('workbench.action.openSettings', msg.key)
          return
        case 'checkVoice':
          // The settings page's own probe: always ask again, cache or no cache
          // — that is what a Check button is for.
          settingsBusy = 'Checking whisper-cli and ffmpeg…'
          void SettingsPanel.refreshIfOpen()
          try {
            voiceResult = undefined
            await voiceCheckNow()
          } finally {
            settingsBusy = undefined
          }
          return
        case 'saveSchedule': {
          const d = msg.draft
          const now = Date.now()
          const hit = schedules.find((s) => s.id === d.id)
          const list: Schedule[] = hit
            ? schedules.map((s) => s.id === d.id
                ? {
                    ...s, title: d.title, prompt: d.prompt, hour: d.hour,
                    minute: d.minute, days: d.days, enabled: d.enabled,
                  }
                : s)
            : [...schedules, {
                id: crypto.randomUUID(), title: d.title, prompt: d.prompt,
                hour: d.hour, minute: d.minute, days: d.days,
                enabled: d.enabled, createdAt: now,
              }]
          await saveSchedules(list)
          // A schedule whose time has already passed today starts TOMORROW, not
          // in the next sixty seconds — the user set up tomorrow's run. So no
          // catch-up here; the 60s tick handles a schedule that is due because
          // it was RESUME-enabled (that one is an explicit re-arm).
          void SettingsPanel.refreshIfOpen()
          refreshAll()
          return
        }
        case 'removeSchedule':
          await saveSchedules(schedules.filter((s) => s.id !== msg.id))
          void SettingsPanel.refreshIfOpen()
          refreshAll()
          return
        case 'toggleSchedule': {
          const hit = schedules.find((s) => s.id === msg.id)
          if (!hit) return
          await saveSchedules(schedules.map((s) =>
            s.id === msg.id ? { ...s, enabled: !s.enabled } : s))
          void SettingsPanel.refreshIfOpen()
          refreshAll()
          // Re-arming may mean a due moment passed while it was off: fire the
          // catch-up check now rather than waiting for the next heartbeat.
          if (!hit.enabled) {
            await fireDueSchedules().catch((e) =>
              log.error(`Schedule catch-up after resume failed: ${String(e)}`))
          }
          return
        }
        case 'runSchedule': {
          const hit = schedules.find((s) => s.id === msg.id)
          if (!hit) return
          await fireScheduleNow(hit, true)
          return
        }
        case 'setRemote': {
          remoteEnabled = msg.enabled
          await state.update('remote.enabled', remoteEnabled)
          syncRemoteEngine()
          if (remoteEnabled) {
            log.info(remoteHasCode && remoteUrl
              ? 'Remote Control enabled — pushing to the relay'
              : 'Remote Control cannot connect yet: ' +
                (remoteHasCode ? 'no relay URL set' : 'no pairing code set'))
            void SettingsPanel.refreshIfOpen()
            // A fresh engine compares against nothing, so the first tick
            // pushes the current board — re-enabling after a pause needs no
            // backfill, because the relay still holds everything the feed
            // counts describe.
            void remotePusher?.tick().catch((e) => log.error(`Remote push failed: ${String(e)}`))
          }
          return
        }
        case 'saveRemote': {
          // Saving a valid URL and (optionally) a code IS the connect action.
          // The pairing code is change-only: saving without one keeps the
          // stored code, and clearing it is its own message.
          const url = relayBase(msg.url)
          if (!url) throw new Error(`"${msg.url}" is not an http(s) address the relay can live at.`)
          const codeChanged = !!msg.code
          const relayChanged = url !== remoteUrl || codeChanged
          remoteUrl = url
          remoteEnabled = true
          await state.update('remote.url', url)
          await state.update('remote.enabled', true)
          if (codeChanged) {
            await context.secrets.store(remoteCodeKey, msg.code!)
            remoteHasCode = true
            remoteBoardId = boardIdOf(msg.code!)
          }
          syncRemoteEngine()
          if (relayChanged) {
            // A new code names a NEW board on the relay: counts describe what
            // the old board held, so they must not claim the new one.
            remoteFeed.reset()
            settingsBusy = 'Copying recent sessions to the relay…'
            try {
              await remoteBackfill()
              void vscode.window.showInformationMessage(
                'Remote Control connected. Open the relay page on another device and enter the code.')
            } catch (e) {
              log.error(`Remote backfill failed: ${e instanceof Error ? e.message : String(e)}`)
            } finally {
              settingsBusy = undefined
              void SettingsPanel.refreshIfOpen()
            }
          }
          return
        }
        case 'clearRemoteCode': {
          await context.secrets.delete(remoteCodeKey)
          remoteHasCode = false
          remoteBoardId = ''
          // Without a code nothing can connect, so the toggle steps down with
          // it rather than sitting "on" while every attempt is refused.
          if (remoteEnabled) {
            remoteEnabled = false
            await state.update('remote.enabled', false)
          }
          syncRemoteEngine()
          return
        }
      }
    },
  }

  const openSettings = (): void => {
    SettingsPanel.show(context.extensionUri, settingsHost)
    // Fire and forget, but never a bare void: a failure here is an empty page.
    refreshRuntimeStatus()
      .then(() => SettingsPanel.refreshIfOpen())
      .catch((e: unknown) => log.error(`Could not check the installed agents: ${String(e)}`))
  }

  async function selectProvider(): Promise<void> {
    type Item = vscode.QuickPickItem & { profile?: ProviderProfile; action?: string }
    const items: Item[] = providers.map((p) => ({
      label: (p.id === providerId ? '$(check) ' : '$(blank) ') + profileLabel(p),
      description: describeProfile(p),
      detail:
        kindDef(p.kind).support === 'community'
          ? 'Community proxy — not a configuration Anthropic supports.'
          : validateProfile(p).join(' ') || kindDef(p.kind).blurb,
      profile: p,
    }))
    const active = currentProvider()
    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator })
    items.push({ label: '$(add) Add a provider…', action: 'add' })
    if (active.id !== INHERIT_PROFILE.id) {
      items.push({ label: `$(pencil) Edit "${profileLabel(active)}"…`, action: 'edit' })
      items.push({ label: `$(beaker) Test "${profileLabel(active)}"`, action: 'test' })
    }
    if (cfg().get<boolean>('discoverModels') !== false) {
      items.push({
        label: '$(sync) Refresh the model list',
        description: catalogue.source === 'cli' ? 'from the CLI' : `currently: ${catalogue.source}`,
        action: 'models',
      })
    }
    if (active.id !== INHERIT_PROFILE.id) {
      items.push({ label: `$(trash) Remove "${profileLabel(active)}"…`, action: 'remove' })
    }
    items.push({ label: '$(link-external) Provider documentation', action: 'docs' })

    const pick = await vscode.window.showQuickPick(items, {
      title: 'Which backend should agents run on?',
      placeHolder: providerMismatch ?? providerProblem() ?? describeProfile(active),
      ignoreFocusOut: true,
    })
    if (!pick) return
    switch (pick.action) {
      case 'add': return addProvider()
      case 'test': return testProvider()
      case 'models': {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Asking Claude Code which models it can run…' },
          () => refreshModels(true),
        )
        refreshAll()
        const note = catalogue.problem
        if (note) vscode.window.showWarningMessage(`Using the built-in model list: ${note}`)
        else vscode.window.showInformationMessage(
          `${catalogue.choices.length} models: ${catalogue.choices.map((c) => c.label).join(', ')}`,
        )
        return
      }
      case 'remove': return removeProvider(active)
      case 'edit': {
        const edited: ProviderProfile = { ...active }
        if (!(await fillProfile(edited))) return
        await saveProfiles(providers.map((p) => (p.id === edited.id ? edited : p)))
        providerMismatch = undefined
        return
      }
      case 'docs':
        await vscode.env.openExternal(vscode.Uri.parse(kindDef(active.kind).docs))
        return
    }
    if (!pick.profile) return
    host.setComposer({ provider: pick.profile.id })
    refreshAll()
  }

  /**
   * Repaint both surfaces from ONE state, at most ten times a second.
   *
   * This is called on every event an agent produces — including every streamed
   * token, which is what makes the transcript type out live. It used to do the
   * full job each time, twice: the side bar and the panel each called
   * `getState()`, which reads Claude Code's session index (~40ms on a
   * 20-session store, ~104ms on 60) and serialises the whole transcript.
   *
   * At any real streaming rate the extension host cannot keep up, and the work
   * queues without bound. That is not only a laggy board — the CLI is a child
   * process whose stdout is drained on this same event loop, and `canUseTool`
   * answers travel back over it, so a saturated host is a visibly slower agent.
   *
   * `coalesce` keeps the leading edge (the first repaint after a quiet moment
   * is immediate) and guarantees the trailing one (the last state always
   * paints), and never lets two repaints overlap. See board/coalesce.ts.
   */
  const paint = coalesce(async () => {
    const state = await host.getState()
    await provider.post(state).catch((e) => log.error(`Side bar refresh failed: ${String(e)}`))
    await BoardPanel.postCurrent(state).catch((e) => log.error(`Panel refresh failed: ${String(e)}`))
    refreshStatus()
    // Something changed or the board would not be repainting — let the relay
    // cadence know without waiting for its own timer, which exists for the
    // idle case where nothing repaints. tick() gates itself: this fires on
    // every frame an agent streams, and at most one push per MIN_INTERVAL
    // ever leaves.
    if (remotePusher) {
      remotePusher.nudge().catch((e) => log.error(`Remote push failed: ${String(e)}`))
    }
  }, REPAINT_INTERVAL_MS, { onError: (e) => log.error(`Repaint failed: ${String(e)}`) })

  const refreshAll = () => paint.schedule()

  async function rebuild(): Promise<void> {
    ws?.manager?.stopAll()
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (!folder) {
      ws = undefined
      log.info('No folder open. Open one to use Agents Kanban.')
      refreshAll()
      return
    }
    const root = folder.uri.fsPath
    const repoRoot = await findRepoRoot(root)
    if (!repoRoot) log.warn(`${root} is not a git repository — agents cannot run in worktrees.`)

    setBoardFocusMode(cfg().get<FocusMode>('focusMode') ?? 'wide')
    const board = DEFAULT_BOARD
    // Board metadata lives in extension storage, never in the repository:
    // board state is not source code, and writing it into the working tree made
    // every agent turn produce a git diff.
    const meta = new MetaStore(context.globalStorageUri.fsPath, root, (m) => log.info(m))
    const planning = board.columns.find((c) => c.category === 'unstarted')?.id ?? 'planning'

    ws = {
      root, board,
      store: new SessionStore(root, meta, planning),
      ...(repoRoot ? { repoRoot, worktrees: new WorktreeService(repoRoot, cfg().get<string>('worktreeRoot') || undefined) } : {}),
    }
    // A NEW store, so a new empty book. Everything the endpoints have already
    // told us is in `globalState` and costs nothing to read back, and without
    // this every card reads `≥ $0.00` until something happens to refresh a
    // catalogue — which for someone who configured their backend last week is
    // never.
    applyModelBook()
    commands = await listSlashCommands(root).catch(() => [])
    log.info(
      `Agents Kanban ready. Folder: ${root}  Repo: ${repoRoot ?? '(none)'}  ` +
      `Slash commands: ${commands.length}`,
    )
    refreshAll()
  }

  /** An attachment that could not be sent must SAY so. Dropped quietly, it is
   *  indistinguishable from one the model looked at and ignored. */
  const reportDroppedImages = (dropped: string[]): void => {
    for (const d of dropped) log.warn(`Attachment not sent: ${d}`)
    vscode.window.showWarningMessage(
      dropped.length === 1
        ? `Attachment not sent — ${dropped[0]}`
        : `${dropped.length} attachments were not sent. See the Agents Kanban output for why.`,
    )
  }

  const requireWs = (): Workspace => {
    if (!ws) throw new Error('Open a folder before using Agents Kanban.')
    return ws
  }

  const ensureManager = (): AgentManager => {
    const w = requireWs()
    if (!w.worktrees) {
      throw new Error(`${w.root} is not a git repository, so agents cannot be isolated in worktrees.`)
    }
    if (!w.manager) {
      w.manager = new AgentManager({
        store: w.store,
        worktrees: w.worktrees,
        board: w.board,
        defaults: { model, effort, thinking, ultracode, fastMode, runtime },
        permissionMode,
        maxConcurrent: cfg().get<number>('maxConcurrentAgents') ?? 3,
        claudeExecutable: cfg().get<string>('claudeExecutable') || undefined,
        codexExecutable: cfg().get<string>('codexExecutable') || undefined,
        // Where a runtime that spawns MCP servers gets the board's tools from.
        // `dist/board-mcp.js` ships in the .vsix beside `dist/extension.js`;
        // `test/package.test.mjs` asserts it is actually in there, because a
        // package built without it installs fine and leaves every Codex agent
        // unable to move its own card.
        boardBridge: {
          dir: context.globalStorageUri.fsPath,
          script: vscode.Uri.joinPath(context.extensionUri, 'dist', 'board-mcp.js').fsPath,
        },
        provider: currentProvider(),
        providerEnv,
        modelBook: modelBook(),
        // The boundary in CODE for fanning one card out into N billed agents.
        //
        // `split_task` is excluded from the auto-allow list, and that exclusion
        // is not a boundary: on Claude it routes through `canUseTool`, which is
        // skipped under `dontAsk` and `bypassPermissions`, and on Codex the
        // list is never read at all. A modal here is consulted on every path,
        // whatever permission mode the session is in and whichever runtime it
        // is on. Rule 7 is "both, always" — the exclusion stays as the soft
        // half.
        //
        // Modal rather than a notification: a notification can be missed, and
        // this starts processes that cost money. Dismissing it is a refusal —
        // `showWarningMessage` resolves undefined, which is not the button.
        confirmSplit: async (parent, subtasks, reason) => {
          const titles = subtasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')
          const choice = await vscode.window.showWarningMessage(
            `"${parent.title}" wants to split into ${subtasks.length} subtasks, each its own agent in its own worktree.`,
            {
              modal: true,
              detail: (reason ? `${reason}\n\n` : '')
                + titles
                + `\n\nEach one is a real agent with a real bill. At most `
                + `${cfg().get<number>('maxConcurrentAgents') ?? 3} run at once; the rest queue.`,
            },
            'Start subtasks',
          )
          const allowed = choice === 'Start subtasks'
          log.info(
            allowed
              ? `Approved a ${subtasks.length}-way split of "${parent.title}".`
              : `Declined a ${subtasks.length}-way split of "${parent.title}".`,
          )
          return allowed
        },
        log: (m: string) => log.warn(m),
      })
      w.manager.on('change', () => refreshAll())
      // Where the tokens actually went. Checked once per run against the
      // profile that was requested: a disagreement means something outranked
      // the profile — a managed settings file, an apiKeyHelper, an env block in
      // ~/.claude/settings.json — and the board must say so rather than keep
      // naming the provider we asked for. See providers.ts.
      w.manager.on('provider', (agent: RunningAgent, resolved: string | undefined) => {
        const p = currentProvider()
        const { ok, message } = reconcileProvider(p, resolved)
        providerMismatch = ok ? undefined : message
        if (message) log.warn(`${agent.title}: ${message}`)
        else log.info(`${agent.title} is running on ${resolvedLabel(resolved) ?? 'an unknown provider'}.`)
        refreshAll()
      })
      // An agent asking for attention mid-run, via notify_user. Distinct from
      // the phase move: the work is NOT done, it is stuck or needs a decision.
      w.manager.on('notice', (agent: RunningAgent, notice: { message: string; urgency: string }) => {
        const key = agent.sessionId ?? agent.runId
        const show = notice.urgency === 'blocked'
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage
        // Promise.resolve, because vscode's Thenable has no .catch — and a bare
        // `void` here would swallow the rejection, which this project has a
        // postmortem for.
        Promise.resolve(show(`${agent.title}: ${notice.message}`, 'Open session'))
          .then((choice) => {
            if (choice !== 'Open session') return
            BoardPanel.show(context.extensionUri, host)
            mode = 'chat'
            host.select(key)
            refreshAll()
          })
          .catch((e: unknown) => log.error(`Notice action failed: ${String(e)}`))
      })

      w.manager.on('warning', (message: string) => {
        log.warn(message)
        vscode.window.showWarningMessage(`Agents Kanban: ${message}`)
      })

      // An agent moving itself into a review column is it saying "this is ready
      // for you to test". That is the whole point of the board, and it is worth
      // more than a badge the user has to be looking at to notice.
      w.manager.on('phase', (agent: RunningAgent, _from: string, to: string) => {
        if (!isReviewColumn(w.board, to)) return
        const movedKey = agent.sessionId ?? agent.runId
        // A subtask landing may complete the set. If it does, the thing worth
        // saying is not "one of four is ready" but "all four are" — so the
        // parent is moved to review and gets the notification instead. Fired
        // before the notifyOnReview check so the board is kept honest even for
        // someone who has turned the toasts off.
        void rollUpToParent(movedKey).then((rolled) => {
          if (cfg().get<boolean>('notifyOnReview') === false) return
          if (rolled) return
          notifyReady(movedKey, agent.title)
        }).catch((e: unknown) => log.error(`Subtask roll-up failed: ${String(e)}`))
      })

      // A commit changes what the review panel and the Merge button should say,
      // and the event was emitted by both runtimes and heard by nobody.
      w.manager.on('committed', (agent: RunningAgent) => {
        const key = agent.sessionId ?? agent.runId
        if (key !== selectedKey && agent.sessionId !== selectedKey) return
        loadReview(selectedKey).then(() => refreshAll())
          .catch((e) => log.error(`Review reload after a commit failed: ${String(e)}`))
      })
      // Keep the review panel truthful without paying for it on every token.
      w.manager.on('finished', (agent: RunningAgent) => {
        const key = agent.sessionId ?? agent.runId
        if (key !== selectedKey && agent.sessionId !== selectedKey) return
        loadReview(selectedKey).then(() => refreshAll())
          .catch((e) => log.error(`Review reload failed: ${String(e)}`))
      })
    }
    // Picker changes apply to the next run without rebuilding the manager.
    w.manager.setDefaults({ model, effort, thinking, ultracode, fastMode })
    return w.manager
  }

  /** Where a session's work lives, or undefined if it has no worktree. */
  async function worktreeOf(key: string): Promise<{ dir: string; branch: string; base: string } | undefined> {
    const w = requireWs()
    const live = w.manager?.byKey(key)
    // The sidecar is the only writer of these three, and it is keyed by
    // whatever the board calls the run — so it answers for a session Claude
    // Code has not indexed yet, where a store lookup would say "no worktree".
    const stored = await w.store.worktreeMeta(live?.sessionId ?? key)
    const dir = live?.worktreePath ?? stored.worktree
    const branch = live?.branch ?? stored.branch
    // Sessions from before base was recorded fall back to the repo's current
    // branch, which is what they were almost certainly forked from.
    const base = live?.base ?? stored.base ?? (await w.worktrees?.currentBranch().catch(() => undefined))
    return dir && branch && base ? { dir, branch, base } : undefined
  }

  async function loadReview(key: string | undefined): Promise<void> {
    review = undefined
    if (!key || !ws?.worktrees) return
    const wt = await worktreeOf(key).catch(() => undefined)
    if (!wt) return
    try {
      review = { key, data: await ws.worktrees.review(wt.dir, wt.base) }
    } catch (e) {
      log.warn(`Could not read the worktree for ${key}: ${String(e)}`)
    }
  }

  /** A finished session's worktree is dead weight, but it may still hold
   *  uncommitted work — so this asks, and says exactly what would be lost. */
  async function offerWorktreeCleanup(key: string): Promise<void> {
    const w = ws
    if (!w?.worktrees) return
    const wt = await worktreeOf(key).catch(() => undefined)
    if (!wt) return
    const clean = await w.worktrees.isClean(wt.dir).catch(() => false)
    const ahead = await w.worktrees.aheadOf(wt.dir, wt.base).catch(() => 0)
    const choice = await vscode.window.showInformationMessage(
      `Remove the worktree for this session?`,
      {
        modal: true,
        detail: [
          `${wt.dir}`,
          clean ? 'The worktree is clean.' : 'It still has UNCOMMITTED changes, which would be lost.',
          ahead ? `Branch ${wt.branch} has ${ahead} commit${ahead === 1 ? '' : 's'} not in ${wt.base}; the branch is kept.` : '',
        ].filter(Boolean).join('\n'),
      },
      'Remove worktree',
    )
    if (choice !== 'Remove worktree') return
    try {
      // Keep the branch: the commits are the work, and a merge may still be wanted.
      await w.worktrees.remove(wt.dir, { force: true, keepBranch: true })
      // '' and not undefined: stripUndefined() would drop the key and leave the
      // card pointing at a directory that no longer exists.
      await w.store.patch(w.manager?.byKey(key)?.sessionId ?? key, { worktree: '' })
      vscode.window.showInformationMessage(`Worktree removed. Branch ${wt.branch} kept.`)
    } catch (e) {
      vscode.window.showErrorMessage(`Could not remove the worktree: ${e instanceof Error ? e.message : String(e)}`)
    }
    refreshAll()
  }

  /**
   * A subtask reached a review column. If every sibling has too, the whole task
   * is ready: move the parent card there and say so once.
   *
   * Returns whether it handled the notification, so the per-card one does not
   * also fire and stack two toasts about the same moment. A parent whose
   * subtasks the user has already approved one by one still counts as full —
   * "ready" is review OR done, or the roll-up never fires for the person who
   * merges as they go.
   */
  async function rollUpToParent(childKey: string): Promise<boolean> {
    const w = ws
    if (!w) return false
    const parentKey = (await w.store.card(childKey)).parent
    if (!parentKey) return false
    const siblings = await w.store.childrenOf(parentKey)
    if (!siblings.length) return false
    const parentCard = await w.store.card(parentKey)
    const phases = await Promise.all(siblings.map((k) => w.store.card(k).then((c) => c.phase)))
    // The decision itself is pure and lives in `board/subtasks.ts`, because the
    // wrong answer here is a NOTIFICATION and it shipped as one — see
    // `rollUpState`. `pending` is the case that was missing: fewer children on
    // the board than the user approved, because the rest are still queued
    // behind `maxConcurrentAgents` with no sidecar entry to count.
    const state = rollUpState(phases, parentCard.fanout, w.board)
    if (state.kind !== 'ready') return false

    const review = w.board.columns.find((c) => c.category === 'review')?.id
    if (review && parentCard.phase !== review) await w.store.setPhase(parentKey, review)
    refreshAll()

    if (cfg().get<boolean>('notifyOnReview') === false) return true
    const title = w.manager?.byKey(parentKey)?.title
      ?? (await w.store.get(parentKey))?.title
      ?? 'The parent task'
    // `state.total`, not `siblings.length`: they agree here by construction, and
    // saying the number the DECISION was made on keeps them from drifting apart
    // again — the whole bug was a count that came from somewhere else.
    notifyReady(parentKey, title, `All ${state.total} subtasks of "${title}" are ready for you to test.`)
    return true
  }

  /** Fire-and-forget roll-up, never bare: a swallowed rejection here is a parent
   *  card that silently never completes. */
  const rollUpFor = (childKey: string): void => {
    void rollUpToParent(childKey).catch((e: unknown) => log.error(`Subtask roll-up failed: ${String(e)}`))
  }

  function notifyReady(key: string, title: string, message?: string): void {
    Promise.resolve(vscode.window
      .showInformationMessage(message ?? `"${title}" is ready for you to test.`, 'How do I test it?', 'Open worktree'))
      .then(async (choice) => {
        if (choice === 'How do I test it?') {
          BoardPanel.show(context.extensionUri, host)
          mode = 'chat'
          host.select(key)
          await loadReview(key)
          refreshAll()
        } else if (choice === 'Open worktree') {
          await host.openWorktree(key)
        }
      })
      // requireWs() throws once the folder is closed, and a bare `void` would
      // swallow it — the rule this project already has a postmortem for.
      .catch((e: unknown) => {
        log.error(`Ready-to-test action failed: ${String(e)}`)
        vscode.window.showErrorMessage(`Agents Kanban: ${e instanceof Error ? e.message : String(e)}`)
      })
  }

  const host: BoardHost = {
    // A webview has reloaded and holds nothing, so the next state must carry
    // the model catalogue in full again.
    onReady: forgetSentCatalogue,
    async getState(): Promise<UiState> {
      const active = currentProvider()
      // The effort levels are the SELECTED MODEL's, not a global list. Haiku 4.5
      // accepts none, and was being offered all five — a control that could not
      // say no, which is the same class of bug as a spinner over a wedged
      // process.
      const levels = effortsFor(catalogue.choices, model)
      /* Built by `sendModels` below, ONCE per state and only when the list has
         actually changed. It used to be mapped inline here — and then AGAIN in
         the selected-session branch, so a 431-model catalogue was formatted
         twice and serialised in full on every repaint. */
      const composer = {
        model, effort, thinking,
        // Filled in once, at the end: which catalogue is in force depends on
        // whether a session is selected, and asking twice would send the list
        // on every repaint — the exact cost this is here to avoid.
        models: undefined as undefined | ReturnType<typeof sendModels>,
        // Ultracode owns effort — it IS xhigh — so the effort picker steps aside
        // rather than showing a level that is being overridden.
        efforts: ultracode ? [] : EFFORT_LEVELS.filter((e) => levels.includes(e.key)),
        thinkingSupported: thinkingFor(catalogue.choices, model),
        ultracode, fastMode,
        ultracodeSupported: ultracodeFor(catalogue.choices, model),
        fastModeSupported: fastModeFor(catalogue.choices, model),
        modelSource: catalogue.source,
        ...(catalogue.problem ? { modelNote: catalogue.problem } : {}),
        agent: agentKey(runtime, active.id),
        agents: agentChoices(),
        agentLocked: false,
        runtime,
        runtimes: allRuntimes().map((rt) => ({
          id: rt.id,
          label: rt.label,
          detail: rt.vendor,
          providerProfiles: rt.capabilities.providerProfiles,
        })),
        provider: active.id,
        providers: providers.map((p) => ({
          id: p.id,
          label: profileLabel(p),
          detail: describeProfile(p),
          support: kindDef(p.kind).support,
        })),
        // The mismatch wins over the configuration problem: a profile that
        // cannot start is a warning about the future, a profile the CLI already
        // overrode is a statement about the run on screen.
        ...(() => {
          const note = providerMismatch ?? providerProblem()
          return note ? { providerNote: note } : {}
        })(),
        contextTokens: 0 as number,
        contextWindow: undefined as number | undefined,
        meter: undefined as Meter | undefined,
        permissionMode: permissionMode as string,
        permissionModes: PERMISSION_MODES,
        orchestration: orchestration as string,
        /* ABSENT, not empty, where the control cannot take effect. A workspace
           with no git repository has no worktrees and therefore no
           `split_task` at all, so offering a dial over it would be a control
           that cannot say no — the same rule that hides the backend picker on a
           runtime with no provider concept. The view draws nothing when this is
           missing. */
        orchestrationLevels: undefined as { key: string; label: string; detail: string }[] | undefined,
        orchestrationNote: undefined as string | undefined,
        // The mic's gate: absent until the lazy probe answered, so the first
        // paint of the board never waits on two `--version` spawns.
        ...(voiceResult ? voiceState(voiceResult) : {}),
      }
      if (!ws) {
        composer.models = sendModels(catalogue, active.id)
        return { ready: false, noWorkspace: true, mode, columns: [], cards: [], composer, running: 0, waiting: 0 }
      }

      const stored = await ws.store.list({ includeArchived: showArchived })
      // A run has no Claude Code session for its first moment, and may never get
      // one if its id collided. Its board state lives in the sidecar under the
      // run id, so read that too or the card renders as a default with whatever
      // the agent recorded — phase, tags, test plan — invisible.
      const metas = await ws.store.allMeta()
      const live = ws.manager?.list() ?? []
      const cards: UiCard[] = []
      const seen = new Set<string>()

      for (const a of live) {
        const key = a.sessionId ?? a.runId
        seen.add(key)
        const s = a.sessionId ? stored.find((x) => x.id === a.sessionId) : undefined
        const m = metas[key]
        const phase = s?.phase ?? m?.phase
        const testPlan = s?.testPlan ?? m?.testPlan
        cards.push({
          key,
          ...(a.sessionId ? { sessionId: a.sessionId } : {}),
          runtime: m?.runtime ?? a.runtime,
          title: s?.title ?? a.title,
          phase: phase ?? ws.board.columns.find((c) => c.category === 'started')?.id ?? 'implementing',
          tags: s?.tags ?? m?.tags ?? [],
          updated: Date.now(),
          branch: a.branch,
          worktree: a.worktreePath,
          ...(a.parent ?? m?.parent ? { parent: (a.parent ?? m?.parent)! } : {}),
          ...(testPlan ? { testPlan } : {}),
          ...(a.queued?.length ? { queued: a.queued } : {}),
          agent: toUiAgent(a),
        })
      }
      // Runs that were still marked running with no agent to account for them:
      // the host went away mid-turn and killed them. Their processes cannot be
      // re-attached, so the honest thing is to say so on the card rather than
      // let a cut-off run look exactly like a finished one.
      const cutOff = interruptedSessions(stored, seen)
      for (const s of stored) {
        if (seen.has(s.id)) continue
        cards.push({
          key: s.id, sessionId: s.id,
          ...(s.runtime ? { runtime: s.runtime } : {}),
          title: s.title, phase: s.phase, tags: s.tags,
          updated: s.updated, archived: s.archived, pinned: s.pinned,
        ...(() => {
          const d = metas[s.id]?.decomposition
          if (!d) return {}
          return {
            decomposition: {
              line: decompositionLine(d, metas[s.id]?.fanout),
              ...(d.stated ? { stated: d.stated } : {}),
              refused: d.outcome === 'refused',
            },
          }
        })(),
          ...(s.branch ? { branch: s.branch } : {}),
          ...(s.worktree ? { worktree: s.worktree } : {}),
          ...(s.parent ? { parent: s.parent } : {}),
          ...(s.testPlan ? { testPlan: s.testPlan } : {}),
          ...(cutOff.has(s.id) ? { interrupted: cutOff.get(s.id)! } : {}),
        })
      }

      // Join the subtasks to the card they were split out of, both ways. Stored
      // on the child alone — see SessionMeta.parent — so the parent's half is
      // derived here rather than kept as a second copy that can disagree.
      linkSubtasks(cards, ws.board)

      // Follow the selection across the run-id -> session-id swap rather than
      // dropping it. Losing it here sent the open chat back to the new-session
      // screen a few seconds into every first turn.
      const manager = ws.manager
      selectedKey = followKey(
        selectedKey,
        cards.map((c) => c.key),
        (k) => manager?.byKey(k)?.sessionId,
      )

      let transcript: Entry[] | undefined
      let streaming: string | undefined
      if (selectedKey) {
        const a = ws.manager?.byKey(selectedKey)
        if (a) {
          // Claude Code writes this run into the same transcript as it goes, so
          // reading it back would contain this run too — and `a.live` is the
          // same run as this extension observed it, with streaming text,
          // resolved tool statuses and per-call timings. `a.history` is the
          // transcript as it stood when the run began, captured once, so
          // everything before it is genuine history and everything after it is
          // the copy we already have. That boundary is what stops the whole
          // conversation being rendered twice — and holding it rather than
          // re-reading it is what stops a full transcript parse per token.
          transcript = [...a.history, ...a.live]
          streaming = a.streaming
          composer.contextTokens = a.contextTokens
          // The window the run reported, then the one this session reported
          // last time. Without the fallback a resumed session shows no meter at
          // all until its first frame arrives, which can be a minute in.
          composer.contextWindow = a.contextWindow ?? metas[selectedKey]?.contextWindow
          // The meter the run has published, already including anything the
          // session spent before this run started (`settleMeter`). A run whose
          // runtime has not reported yet has no reading, and that must stay
          // undefined rather than becoming a zero.
          composer.meter = a.meter
        } else {
          // Not running — so both numbers come from the transcript, off one
          // parse that is cached on the session file's identity. This is the
          // path a restart lands on, and the reason the context meter and the
          // spend readout are still there afterwards: they used to exist only
          // inside the live run, and died with the extension host.
          transcript = await ws.store.transcript(selectedKey)
          const totals = await ws.store.usage(selectedKey)
          composer.contextTokens = totals.contextTokens
          composer.contextWindow = metas[selectedKey]?.contextWindow ?? totals.contextWindow
          // `store.meter()` rather than `totals.costUsd`, and this is the only
          // caller it has ever had. It routes on the session's own recorded
          // runtime, so a finished Codex session reports the rate-limit window
          // it actually spent instead of the `$0.00` that `usage()` correctly
          // returns for a runtime that bills nothing per request. For a Claude
          // session it comes off the same cached parse as `totals`, so it costs
          // nothing extra — and there is one place that knows how spend is
          // derived, not two.
          composer.meter = await ws.store.meter(selectedKey)
        }
      }

      /* The level for the card in front of you, resolved the same way effort is:
         the session's own choice, then the workspace default. A card that has
         already launched keeps the level its BRIEF was written with, so the
         note says what a change would actually do rather than letting the
         picker imply it takes effect now. */
      /* THE COMPOSER FOLLOWS THE SELECTED SESSION.
       *
       * Everything above is the workspace DEFAULT — what the next new session
       * would run on. For a session that already exists, that is somebody
       * else's setting: open a card that has been on `deepseek-v4-pro` all
       * morning and the bar said "Claude Code · Opus 5", because the composer
       * had never read what the session was launched with. Reported as
       * "it shows as if Claude was working on it, not deepseek", and it is
       * exactly that.
       *
       * The fields were on `SessionMeta` and were parsed on the way back in.
       * Nothing wrote them and nothing read them — a whole feature that existed
       * only as types. `durablePatch` now records them at launch; this reads
       * them back.
       */
      /* Which model list this state is about. The ACTIVE backend's by default;
         the SELECTED SESSION's when there is one, because a card that ran on a
         gateway must not be shown the models of whatever is selected now. Sent
         once, below, and only when it differs from what the view already has. */
      let effectiveCatalogue = catalogue
      let effectiveProfile = active.id
      const sessionMeta = selectedKey ? metas[selectedKey] : undefined
      if (sessionMeta) {
        const ranOn = sessionMeta.provider
          ? providers.find((p) => p.id === sessionMeta.provider)
          : undefined
        // A profile that has since been deleted still names itself, because the
        // session did run on it. Silently showing the ACTIVE one instead is the
        // bug this whole block is about, in a smaller place.
        const cat = ranOn ? catalogueForProfile(ranOn) : catalogue
        effectiveCatalogue = cat
        effectiveProfile = ranOn?.id ?? active.id
        composer.modelSource = cat.source
        if (cat.problem) composer.modelNote = cat.problem
        if (sessionMeta.model) composer.model = sessionMeta.model
        if (sessionMeta.effort) composer.effort = sessionMeta.effort
        if (sessionMeta.thinking) composer.thinking = sessionMeta.thinking
        if (sessionMeta.runtime) composer.runtime = sessionMeta.runtime
        if (ranOn) composer.provider = ranOn.id
        composer.agent = agentKey(
          (sessionMeta.runtime ?? runtime) as RuntimeId,
          ranOn?.id ?? ((sessionMeta.provider ?? active.id)),
        )
        /* A session cannot change agent OR backend, and the picker must not
           pretend otherwise. Its transcript lives in that runtime's own store
           and its backend is environment on a process that is already running,
           so both are decided and gone. The chip still SAYS which — that is a
           statement about the run in front of you, not a control. */
        composer.agentLocked = true
        // Everything derived from "which model", recomputed against the list
        // this session actually has.
        const levels = effortsFor(cat.choices, composer.model)
        composer.efforts = composer.ultracode ? [] : EFFORT_LEVELS.filter((e) => levels.includes(e.key))
        composer.thinkingSupported = thinkingFor(cat.choices, composer.model)
        composer.ultracodeSupported = ultracodeFor(cat.choices, composer.model)
        composer.fastModeSupported = fastModeFor(cat.choices, composer.model)
      }

      if (ws.repoRoot) {
        composer.orchestrationLevels = ORCHESTRATION_CHOICES.map((c) => ({ ...c }))
        const meta = sessionMeta
        composer.orchestration = resolveOrchestration(meta?.orchestration, orchestration)
        const live = selectedKey ? ws.manager?.byKey(selectedKey) : undefined
        if (live?.orchestration && live.orchestration !== composer.orchestration) {
          composer.orchestrationNote =
            `This session started at "${live.orchestration}". Its brief is already written, so a ` +
            'change here applies to the next session.'
        }
      }

      // ONE call, after everything that can decide which list is in force.
      composer.models = sendModels(effectiveCatalogue, effectiveProfile)

      const kind = (k: string) => live.filter((a) => a.state.kind === k).length
      return {
        ready: true, mode, columns: ws.board.columns, cards, composer, showArchived,
        ...(ws.repoRoot ? {} : { noRepo: true }),
        ...(selectedKey ? { selectedKey } : {}),
        ...(transcript ? { transcript } : {}),
        ...(streaming ? { streaming } : {}),
        ...(commands.length ? { commands } : {}),
        ...(Object.keys(disclosures).length ? { disclosures } : {}),
        ...(review && review.key === selectedKey ? { review: review.data } : {}),
        ...(busy ? { busy } : {}),
        ...(boardFocusApplied() ? { focused: true } : {}),
        ...(BoardPanel.isOpen ? { boardOpen: true } : {}),
        running: kind('working') + kind('starting'),
        waiting: kind('needsInput'),
      }
    },

    async openFolder() { await vscode.commands.executeCommand('vscode.openFolder') },

    async init() {
      // Claude Code owns the session store, so there is nothing to scaffold —
      // except the one thing that DOES live in the repository: the ignore rule
      // for the worktree directory. Worktree creation writes it too, so this is
      // the way to get it in place (and committed alongside the rest of the
      // project's config) before the first agent ever runs.
      // Rebuild first: the service that knows where worktrees go is built there,
      // from the current folder and the current setting.
      await rebuild()
      const added = await ws?.worktrees?.ensureIgnored()
      if (added) {
        log.info(`Added "${added}" to .gitignore — agent worktrees live there.`)
        void vscode.window.showInformationMessage(
          `Agents Kanban: added "${added}" to .gitignore. Agent worktrees live there; commit the line to share it.`,
        )
      }
    },

    setMode(next) { mode = next },
    select(id) {
      selectedKey = id || undefined
      // Fire and forget, but never bare: a swallowed rejection here is how the
      // panel ends up showing stale changes with no clue why.
      loadReview(selectedKey).catch((e) => log.error(`Review load failed: ${String(e)}`))
    },
    toggleArchived() { showArchived = !showArchived },

    /** Flip the layout by hand, whatever the setting says. Useful when the
     *  setting is "off" but you want the board wide just this once. */
    async openBoard() { enterBoard() },

    async closeBoard() { leaveBoard() },

    async openSession(key) {
      selectedKey = key || undefined
      mode = 'chat'
      loadReview(selectedKey).catch((e) => log.error(`Review load failed: ${String(e)}`))
      enterBoard()
    },

    async selectProvider() { await selectProvider() },
    openSettings() { openSettings() },

    /** Workspace-relative paths for the @-mention picker.
     *
     * This is the one payload too big to ride the state channel on every
     * repaint, so the view asks for it once, lazily, and keeps it. The first
     * workspace folder is the board's folder — `ws.root` is built from it — so
     * a multi-root workspace does not mix two projects' paths into one list.
     */
    async mentionFiles(): Promise<string[]> {
      const folder = vscode.workspace.workspaceFolders?.[0]
      if (!folder) return []
      try {
        // What a mention could plausibly name: source and documents, not the
        // vendored, the generated or the binary. 2000 is a picker, not a disk
        // sweep — the view only ever shows the first handful of matches.
        const uris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, '**/*'),
          '{**/.git/**,**/node_modules/**,**/.agentskanban/**,**/.vscode/**,**/out/**,**/dist/**,**/build/**,**/coverage/**,**/.next/**,**/vendor/**,**/bin/**,**/obj/**,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.webp,**/*.svg,**/*.ico,**/*.woff,**/*.woff2,**/*.wasm,**/*.zip,**/*.tar,**/*.gz,**/*.mp3,**/*.mp4,**/*.mov,**/*.wav}',
          2000,
        )
        return uris
          .map((u) => vscode.workspace.asRelativePath(u, false))
          .filter((p): p is string => !!p)
          .sort()
      } catch (e) {
        // A closed folder races any async ask. An empty list is honest — the
        // picker says "nothing to mention" instead of pretending.
        log.warn(`Mention file search failed: ${String(e)}`)
        return []
      }
    },

    /** Search what the conversations actually were.
     *
     * Answered on its own channel, never through `refresh`: it reads every
     * session's transcript, which is never something a repaint does. The
     * filter is deliberate and tested elsewhere — prompts and agent answers
     * only; no tool rows, no thinking, no subagent frames. And each session
     * is searched through the SAME array its chat view renders — a live
     * run's own history plus its streaming tail, a finished one's store
     * parse — so a hit's `entryIndex` is the row the chat will show when
     * the hit is opened, not an index into a differently-cut file.
     */
    async searchTranscript(qRaw: string): Promise<SearchAnswer> {
      const q = qRaw.trim().slice(0, 200)
      if (!ws || !q) return { q, matches: [], more: 0 }
      const stored = await ws.store.list({ includeArchived: true })
      const live = ws.manager?.list() ?? []
      const rows: SearchRow[] = []
      const push = (key: string, title: string | undefined, entries: readonly Entry[]): void => {
        for (const h of searchEntries(entries, q)) {
          rows.push({ key, ...(title ? { title } : {}), ...h })
        }
      }
      for (const a of live) {
        const key = a.sessionId ?? a.runId
        // The chat renders the run's own history + live tail, NOT the session
        // file: the file is a message behind, and reading both would double
        // every row that has already flushed.
        push(key, a.title, [...a.history, ...a.live])
      }
      const liveKeys = new Set(live.map((a) => a.sessionId ?? a.runId))
      for (const s of stored) {
        if (liveKeys.has(s.id)) continue
        try {
          // The store's parse cache (keyed on the file's identity) makes this
          // cheap once each session has been read; the entry indices line up
          // with the chat because both are the store's own tail parse.
          push(s.id, s.title, await ws.store.transcript(s.id))
        } catch {
          // A session whose file vanished mid-search contributes nothing.
          // `transcript()` already returns [] for a read failure; this guard
          // is for anything its own catch does not cover.
        }
      }
      rows.sort((a, b) => b.at - a.at)
      const cap = 200
      return { q, matches: rows.slice(0, cap), more: Math.max(0, rows.length - cap) }
    },

    /** Start dictating: check the pipeline, then record the microphone.
     *  Idempotent — a second press while recording is a no-op that returns ok.
     */
    async voiceStart(): Promise<{ ok: true } | { ok: false; error: string }> {
      if (liveCapture) return { ok: true }
      const r = await voiceCheckNow()
      const v = verdict(r.checks)
      if (!v.ok) return { ok: false, error: v.why ?? 'Dictation is unavailable' }
      const cap = startCapture(voiceConfig())
      liveCapture = cap
      // However the capture ends — user stop, device busy, ffmpeg dying — the
      // mic must stop reading as recording. Live state, picked up by the next
      // repaint through composer.voice.recording.
      void cap.stopped.then((o) => {
        if (liveCapture === cap) liveCapture = undefined
        if (!o.ok) log.warn(`Dictation stopped itself: ${o.error}`)
      })
      // ffmpeg fails fast when the device is busy or there is no default, so
      // give it a moment before telling the mic "recording": a capture that is
      // already dead must come back as the error it is, not as one frame of
      // pulsing that ends on its own.
      const early = await Promise.race([
        cap.stopped,
        new Promise<null>((res) => setTimeout(() => res(null), 500)),
      ])
      if (early && !early.ok) return { ok: false, error: early.error }
      return { ok: true }
    },

    /** Stop dictating and transcribe what was captured, locally. */
    async voiceStop(): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
      const cap = liveCapture
      if (!cap) return { ok: false, error: 'Not recording' }
      liveCapture = undefined
      cap.stop()
      const outcome = await cap.stopped
      return outcome.ok
        ? { ok: true, text: outcome.text }
        : { ok: false, error: outcome.error }
    },

    async newSessionPrompt() {
      const text = await vscode.window.showInputBox({
        prompt: 'What should the agent do?', ignoreFocusOut: true,
      })
      if (!text?.trim()) return
      enterBoard()
      await this.newSession(text)
    },

    async toggleFocus() {
      const configured = cfg().get<FocusMode>('focusMode') ?? 'wide'
      // With focus off, the button still works — it just has to pick a mode.
      await applyBoardFocus(!boardFocusApplied(), configured === 'off' ? 'wide' : configured)
    },

    setDisclosure(key, open) {
      if (!key) return
      disclosures[key] = open
      void state.update('disclosures', disclosures)
    },

    setComposer(patch) {
      if (patch.model) {
        /* Per SESSION when one is selected, exactly as the split level already
           is. Without this, changing the model while looking at a card edited
           the WORKSPACE DEFAULT: the bar appeared to change that session and
           changed the next one instead, and reopening the card put the old
           value back. */
        if (patch.forKey) {
          void ws?.store.patch(patch.forKey, { model: patch.model }).catch(() => {})
        }
        model = patch.model
        void state.update('model', model)
        // Effort is per model, so a switch can strand it on a level the new one
        // does not accept — `max` selected, then a move to Haiku, which has no
        // levels at all. The picker would then show a value the run ignores.
        const levels = effortsFor(catalogue.choices, model)
        if (levels.length && !levels.includes(effort)) {
          effort = levels.includes('high') ? 'high' : levels[levels.length - 1]!
          void state.update('effort', effort)
        }
      }
      /* The split level, PER CARD.
         Written to the selected card's own metadata when there is one, and to
         the workspace default otherwise — the same resolution order effort has,
         and for the same reason: a picker that shows one thing while the run
         uses another is the bug this order exists to prevent.
         A card that has already launched keeps the level its BRIEF was written
         with; `RunningAgent.orchestration` is captured at launch and the split
         gate reads that. So changing this on a running card changes what the
         next session does, and the note below says so rather than letting the
         user believe otherwise. */
      const level = parseOrchestrationLevel(patch.orchestration)
      if (level) {
        if (patch.forKey) {
          void ws?.store.patch(patch.forKey, { orchestration: level }).catch(() => {})
        }
        orchestration = level
        void state.update('orchestration', level)
        ws?.manager?.setDefaults({ orchestration: level })
      }
      if (patch.effort) {
        if (patch.forKey) void ws?.store.patch(patch.forKey, { effort: patch.effort as EffortLevel }).catch(() => {})
        effort = patch.effort as EffortLevel
        void state.update('effort', effort)
      }
      if (patch.thinking) {
        if (patch.forKey) void ws?.store.patch(patch.forKey, { thinking: patch.thinking as ThinkingMode }).catch(() => {})
        thinking = patch.thinking as ThinkingMode
        void state.update('thinking', thinking)
      }
      if (patch.permissionMode && PERMISSION_MODES.some((m) => m.key === patch.permissionMode)) {
        permissionMode = patch.permissionMode as typeof permissionMode
        void state.update('permissionMode', permissionMode)
        // Always tell the manager, even with no session selected: it captured
        // the mode when it was built, and setDefaults() does not carry it. With
        // this behind `if (forKey)`, tightening the mode from the new-session
        // screen showed "Plan only" while the next agent ran on acceptEdits —
        // a safety control that silently did nothing.
        ws?.manager?.setPermissionMode(permissionMode, patch.forKey)
          .catch((e) => log.warn(`Could not change permission mode: ${String(e)}`))
      }
      /*
       * BOTH HALVES AT ONCE, from the composer's single agent picker.
       *
       * Handled before the individual `provider` and `runtime` branches, and
       * instead of them, because those two each kick off their own model
       * refresh — and a refresh started against the old runtime while the new
       * provider is being applied files one backend's models under the other's
       * name. `catalogueKey` has the postmortem for what that costs. One switch,
       * one refresh, in that order.
       */
      const combined = typeof patch.agent === 'string' ? patch.agent.split('|') : undefined
      if (combined) {
        const rt = parseRuntimeId(combined[0])
        const wanted = combined[1] ?? ''
        const profile = providers.find((p) => p.id === wanted)
        if (rt) {
          const runtimeChanged = rt !== runtime
          if (runtimeChanged) {
            runtime = rt
            void state.update('runtime', runtime)
            ws?.manager?.setDefaults({ runtime })
          }
          // `setActiveProvider` already refreshes the catalogue, so a runtime
          // change rides along with it rather than firing a second one.
          if (profile && profile.id !== providerId) {
            setActiveProvider(profile.id)
              .then(() => refreshAll())
              .catch((e: unknown) => log.error(`Could not apply the backend: ${String(e)}`))
          } else if (runtimeChanged) {
            void refreshModels(true).then(() => refreshAll())
          }
          if (runtimeChanged) void SettingsPanel.refreshIfOpen()
        }
      }
      if (!combined && patch.provider && patch.provider !== providerId && providers.some((p) => p.id === patch.provider)) {
        setActiveProvider(patch.provider)
          .then(() => refreshAll())
          .catch((e: unknown) => log.error(`Could not apply the provider: ${String(e)}`))
      }
      /*
       * Which agent program the next session runs on.
       *
       * Parsed rather than trusted — the webview is another program — and
       * applied to the NEXT session only, like the provider and for the same
       * reason: a runtime IS the process, and its transcript, model ids and
       * login all belong to it, so there is no honest way to move a live run
       * onto a different one. Two cards on two agents, running at once, is the
       * supported thing; one card changing agent mid-run is not.
       */
      const nextRuntime = combined ? undefined : parseRuntimeId(patch.runtime)
      if (nextRuntime && nextRuntime !== runtime) {
        runtime = nextRuntime
        void state.update('runtime', runtime)
        // The model list is per runtime, so a switch can otherwise strand the
        // picker on an id the new agent does not serve — `claude-opus-5`
        // selected, then a move to Codex, which would fail at the first request
        // with somebody else's error message. Same failure the provider switch
        // already guards against.
        void refreshModels(true).then(() => refreshAll())
        void SettingsPanel.refreshIfOpen()
      }
      if (patch.ultracode) ultracode = patch.ultracode === 'on'
      if (patch.fastMode) fastMode = patch.fastMode === 'on'

      /*
       * ONE gate, after the assignments rather than on them, because it has two
       * jobs and they are the same job:
       *
       *  - a stale webview posting `ultracode: on` for a model that cannot run
       *    it (the request path validates NOTHING — measured against a real
       *    CLI, `applyFlagSettings()` resolves for `ultracode: true` on a model
       *    with no xhigh, for `ultracode: 'banana'`, and for a key that does
       *    not exist), and
       *  - a MODEL switch revoking a flag that was legitimately on: Opus
       *    supports fast mode, Fable does not.
       *
       * Checking on the assignment as well looked like belt and braces and was
       * simply unreachable — breaking it deliberately failed no test, which is
       * how it was found. A guard that cannot be shown to fire is not a guard.
       */
      regateFlags()
      if (patch.ultracode || patch.model) void state.update('ultracode', ultracode)
      if (patch.fastMode || patch.model) void state.update('fastMode', fastMode)
      ws?.manager?.setDefaults({ model, effort, thinking, ultracode, fastMode, runtime })
    },

    async newSession(prompt, images) {
      const { images: ok, dropped } = sanitiseImages(images ?? [])
      if (!prompt.trim() && !ok.length) return
      if (dropped.length) reportDroppedImages(dropped)
      // Refuse rather than improvise. A half-configured provider does not fail
      // here, it fails at the first API call with a message from somebody
      // else's system — after a worktree has been created and a card has
      // appeared — and the user has no way to connect that to a missing field.
      const problem = providerProblem()
      if (problem) {
        log.error(`Not starting a session: ${problem}`)
        const choice = await vscode.window.showErrorMessage(
          `Agents Kanban cannot start a session: ${problem}`,
          'Configure provider',
        )
        if (choice === 'Configure provider') {
          await vscode.commands.executeCommand('agentsKanban.selectProvider')
        }
        return
      }
      // Await it: the cached patch is what the manager was built with, and a
      // credential set moments ago must be in this run rather than the next.
      await refreshProviderEnv()
      const mgr = ensureManager()
      mgr.setProvider(currentProvider(), providerEnv)
      log.info(
        `Starting session: ${prompt.slice(0, 80)}` +
        (ok.length ? ` (+${describeImages(ok.length)})` : ''),
      )
      selectedKey = await mgr.start(prompt, ok.length ? { images: ok } : {})
      mode = 'chat'
      refreshAll()
    },

    async sendMessage(key, text, images) {
      const { images: ok, dropped } = sanitiseImages(images ?? [])
      // An images-only message is a real message: "look at this" with a
      // screenshot says everything it needs to. Only a message with neither
      // text nor an image is nothing.
      if (!text.trim() && !ok.length) return
      if (dropped.length) reportDroppedImages(dropped)
      await ensureManager().send(key, text, ok)
      selectedKey = key
      refreshAll()
    },

    async move(key, phase) {
      // A human may move a card anywhere, including into a humanOnly column.
      // The guard exists to stop the AGENT, not the user.
      const w = requireWs()
      const a = w.manager?.byKey(key)
      const id = a?.sessionId ?? key
      // No `startsWith('run-')` guard, and removing it fixes both halves of a
      // bug that was worse than a silent no-op.
      //
      // `setPhase` is `meta.update(id, { phase })` and takes ANY key — that is
      // exactly how the agent moves its own card before Claude Code has
      // assigned a session id, and `getState()` renders a live agent's phase
      // from that same key, so a run-id phase is visible. `adoptKey()` then
      // carries the entry across. The guard refused the USER the identical
      // write the AGENT is allowed, with no message and no log line: the card
      // simply sprang back to the column it came from.
      //
      // And it only ever wrapped the phase write. `offerWorktreeCleanup()` ran
      // regardless and resolves the worktree straight off the live agent — so
      // dragging a still-starting card to Done did nothing visible and then
      // offered to delete the running agent's worktree. The one half of the
      // gesture that took effect was the destructive half.
      await w.store.setPhase(id, phase)
      refreshAll()
      // A subtask the USER moves can complete the set just as well as one the
      // agent moves. The roll-up lives behind an agent event; without this the
      // parent silently stays behind whenever the last card was dragged rather
      // than reported, which is exactly when someone is watching the board.
      if (isSettledColumn(w.board, phase)) rollUpFor(id)
      if (w.board.columns.find((c) => c.id === phase)?.category === 'done') {
        void offerWorktreeCleanup(key)
      }
    },

    async stop(key) { ws?.manager?.stop(key); refreshAll() },

    /** End the turn, keep the session. This is what you usually want, and it
     *  was implemented and unreachable — nothing in the UI called it. */
    async interrupt(key) {
      await ws?.manager?.interrupt(key)
      refreshAll()
    },

    /**
     * Pick a session back up after the editor restarted out from under it.
     *
     * There is nothing to re-attach to: the CLI process died with the old
     * extension host. What survives is Claude Code's session, so this is an
     * ordinary resumed run — the same path a follow-up message takes — with a
     * prompt that tells the agent the truth about why it is being restarted.
     * It must not assume its last action completed, because the process was
     * killed at an unknown point.
     *
     * A click, never automatic: this starts a real process with a real bill,
     * and doing that to every interrupted session the moment VS Code opens is
     * not a decision this extension gets to make.
     */
    async resume(key) {
      const w = requireWs()
      await w.store.patch(key, { running: 0 }).catch(() => {})
      await this.sendMessage(
        key,
        'The editor restarted while you were working, so your last turn was cut off part-way ' +
        'through. Check the current state of your worktree before doing anything — your last ' +
        'action may or may not have completed — then carry on from there.',
      )
    },

    /** The other honest answer: it is not coming back, and I know. */
    async dismissInterrupted(key) {
      await requireWs().store.patch(key, { running: 0 })
      refreshAll()
    },

    async clearQueue(key) {
      const n = ws?.manager?.clearQueue(key) ?? 0
      if (n) vscode.window.showInformationMessage(`Discarded ${n} queued message${n === 1 ? '' : 's'}.`)
      refreshAll()
    },

    /**
     * "Try again from here": put the card back to one of its messages.
     *
     * The worktree files are restored to the state that message was sent into
     * (from Claude Code's file checkpoints — see checkpoints.ts), the session
     * is forked at that message so everything after it is gone from the card,
     * and the sidecar entry is re-keyed to the fork. The user then sends the
     * corrected instruction, and the card resumes the fork in the same
     * worktree — nothing is tracked in the user's repository, and the original
     * session stays in Claude Code's history untouched.
     *
     * Every refusal names its reason, and success with a caveat (no checkpoints
     * at that point, a file that could not be restored) says the caveat — a
     * "try again" that silently kept the current files is a control that lied.
     */
    async forkAt(key, messageId) {
      const w = requireWs()
      if (!messageId) {
        vscode.window.showWarningMessage('Choose a message to start over from first.')
        return
      }
      const card = await w.store.get(key)
      if (!card) {
        vscode.window.showWarningMessage(
          'This session has not been given an id yet, so it cannot be forked. Wait for it to start, then try again.')
        return
      }
      if (card.runtime && card.runtime !== 'claude') {
        vscode.window.showWarningMessage(
          'A Codex session cannot be forked — Claude Code\'s fork works on its own transcripts.')
        return
      }
      const children = await w.store.childrenOf(card.id)
      if (children.length) {
        vscode.window.showWarningMessage(
          'Merge or remove its subtasks first — a fork re-keys this card to a new session, ' +
          'and each subtask remembers its parent by the id that would be left behind.')
        return
      }
      // The anchor must be a real prompt row of this session's transcript. The
      // view names it from the same parse this reads, so a miss means the
      // transcript moved under us — say so rather than fork at nothing.
      const rows = await w.store.transcript(card.id)
      const prompts = rows.filter((e): e is Entry & { kind: 'prompt'; id: string } =>
        e.kind === 'prompt' && e.id !== undefined)
      const anchor = prompts.find((e) => e.id === messageId)
      if (!anchor) {
        vscode.window.showWarningMessage(
          'That message is not in this session\'s transcript any more — refresh and try again.')
        return
      }
      const snippet = anchor.text.replace(/\s+/g, ' ').trim().slice(0, 90) ||
        '(message with no text)'
      const later = prompts.length - prompts.indexOf(anchor) - 1
      const live = w.manager?.byKey(key)
      const wt = await worktreeOf(key).catch(() => undefined)

      // What the files looked like when that message was sent: the snapshot
      // marker at that message, from the raw JSONL the SDK does not expose.
      // When a run is LIVE the file can still gain a snapshot update (the CLI
      // re-issues the marker when the file set changes mid-turn), so the map
      // for a live session is only read AFTER the run is stopped below; the
      // modal then cannot promise a count it does not have yet.
      const readMap = async (): Promise<CheckpointMap | undefined> => {
        const loc = await sessionFileFor(claudeHome(), card.id)
        if (!loc) return undefined
        const text = await fs.readFile(loc.file, 'utf8').catch(() => '')
        return checkpointMapFor(text.split('\n'), messageId)
      }
      const mapNow = live ? undefined : await readMap()

      const choice = await vscode.window.showWarningMessage(
        `Start over from "${snippet}"?`,
        {
          modal: true,
          detail: [
            `This forks the session at that message. Everything after it — its answer and the ` +
              `${later} later message${later === 1 ? '' : 's'} — is discarded from this card. The original ` +
              `session stays in Claude Code's history, untouched.`,
            live ? 'The run in progress is stopped first.' : '',
            !wt ? 'This session has no worktree, so no files are restored.'
              : live ? 'The worktree files are restored to how they were when you sent it.'
              : mapNow === undefined
                ? 'No file checkpoints exist at this point (this session ran before they were recorded), so the files keep their current state.'
                : Object.keys(mapNow).length
                  ? `Files are restored to how they were: ${Object.keys(mapNow).length} tracked file${Object.keys(mapNow).length === 1 ? '' : 's'}.`
                  : 'No files had been touched by that point, so there is nothing to restore.',
          ].filter(Boolean).join('\n\n'),
        },
        'Try again from here',
      )
      if (choice !== 'Try again from here') return

      // The fork reads the transcript file, so a dying CLI — which can flush a
      // frame or two on the way out — has to be finished before we cut. Only
      // now is the checkpoint map read for a live session.
      if (live) {
        w.manager?.stop(key)
        const loc = await sessionFileFor(claudeHome(), card.id)
        const settled = loc
          ? await waitForQuiescent(loc.file)
          : await new Promise((r) => setTimeout(r, 1500))
        if (!settled) {
          vscode.window.showWarningMessage(
            'The run is still stopping — wait a moment and try again.')
          return
        }
      }
      const map = mapNow ?? await readMap()

      // Restore first: the fork shares this worktree, and the redo must start
      // from the state the anchor message was sent into, not the state the
      // discarded turns left behind. applyRestore never throws per file; a
      // missing backup is a note afterwards, not a reason to skip the rest.
      let restored: string[] = []
      let failedFiles: { rel: string; reason: string }[] = []
      if (wt && map) {
        const plan = planRestore(wt.dir, historyDirFor(claudeHome(), card.id), map)
        const out = await applyRestore(plan.copies)
        restored = out.restored
        failedFiles = out.failed
      }

      try {
        const { forkSession } = await loadSdk()
        const forked = await forkSession(card.id, {
          upToMessageId: messageId,
          title: card.title,
        })
        const forkId = forked.sessionId
        // Re-key the card to the fork, keeping phase, tags and the worktree
        // mapping, and clear the run mark: the fork has never run.
        await w.store.adoptKey(card.id, forkId)
        await w.store.patch(forkId, { running: 0 })
        if (selectedKey === key) selectedKey = forkId
        log.info(`Forked session ${card.id} at ${messageId} -> ${forkId}; restored ${restored.length} file(s)`)
        refreshAll()

        const notes: string[] = []
        if (restored.length) {
          notes.push(`Restored ${restored.length} tracked file${restored.length === 1 ? '' : 's'} to how they were.`)
        } else if (wt && map && !Object.keys(map).length) {
          notes.push('No files had been touched by that point, so nothing needed restoring.')
        }
        if (failedFiles.length) {
          notes.push(`Could not restore: ${failedFiles.slice(0, 3).map((f) => f.rel).join(', ')}` +
            (failedFiles.length > 3 ? ` and ${failedFiles.length - 3} more` : '') +
            ` (${failedFiles[0]?.reason ?? 'unknown'}).`)
        }
        if (map === undefined && wt) {
          notes.push('No file checkpoints existed at that point, so the files kept their current state.')
        }
        const text = `Forked at "${snippet}". ` + (notes.length ? notes.join(' ') : 'Send the corrected instruction to continue here.')
        if (notes.length) vscode.window.showWarningMessage(text)
        else vscode.window.showInformationMessage(text)
      } catch (e) {
        // The files are already restored at this point — say so, or the card
        // looks untouched while the worktree quietly went backwards.
        vscode.window.showWarningMessage(
          `Could not fork: ${e instanceof Error ? e.message : String(e)}. ` +
          (restored.length
            ? `The files were restored to that message's state; the card still points at the original session.`
            : 'The card still points at the original session.'))
      }
    },

    /**
     * Start the app in a session's worktree, and open it when it answers.
     *
     * Reported as "I didn't know how to launch the worktree stuff" — and then,
     * having found the launcher, running it in the wrong directory answered
     * "not provisioned yet", which reads as a broken tool. Everything that
     * needs knowing to get from a finished agent to a page in a browser is in
     * here: which directory, which launcher, whether it needs provisioning
     * first, which port it landed on, and whether it is actually up yet.
     *
     * The waiting is the part that earns the button. `wt provision` can spend
     * minutes cloning a database; opening the browser before the server answers
     * gives a connection error and no clue whether the button did anything.
     */
    async runWorktree(key) {
      const w = requireWs()
      const a = w.manager?.byKey(key)
      const stored = a ? undefined : await w.store.get(key)
      const dir = a?.worktreePath ?? stored?.worktree
      if (!dir) { vscode.window.showInformationMessage('This session has no worktree, so there is nothing to run.'); return }

      const recipe = await detectRun({
        worktree: dir,
        ...(w.repoRoot ? { repoRoot: w.repoRoot } : {}),
        ...(cfg().get<string>('runCommand') ? { configuredCommand: cfg().get<string>('runCommand')! } : {}),
        ...(cfg().get<string>('runUrl') ? { configuredUrl: cfg().get<string>('runUrl')! } : {}),
      })
      if (!recipe) {
        // Nothing detected is an answer, not a failure to paper over: starting
        // a guessed command in someone's project is worse than saying so.
        const pick = await vscode.window.showWarningMessage(
          'Could not work out how to start this project. Set agentsKanban.runCommand and the button will use it.',
          'Open settings',
        )
        if (pick === 'Open settings') {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'agentsKanban.runCommand')
        }
        return
      }

      log.info(`Run app in ${dir} — ${recipe.why}`)
      for (const step of recipe.steps) {
        const term = vscode.window.createTerminal({ name: step.name, cwd: dir })
        // Only the serving step is brought forward. Showing each in turn leaves
        // the user looking at an asset watcher while the server logs scroll
        // past unseen behind it.
        if (step.serves) term.show()
        term.sendText(step.command, true)
      }

      // The port. Known up front for a provisioned launcher; written by the
      // launcher itself during a provision, so re-read after; and for anything
      // else, whichever conventional port starts answering.
      const settle = async (stop: () => boolean): Promise<number | undefined> => {
        if (recipe.port) return (await waitForPort(recipe.port, { shouldStop: stop })) ? recipe.port : undefined
        for (;;) {
          if (stop()) return undefined
          const reg = await readWtRegistry(dir)
          const assigned = Number(reg?.APP_PORT ?? 0)
          if (assigned) {
            return (await waitForPort(assigned, { shouldStop: stop })) ? assigned : undefined
          }
          for (const p of COMMON_DEV_PORTS) if (await isListening(p)) return p
          if (await new Promise<boolean>((r) => setTimeout(() => r(stop()), 800))) return undefined
        }
      }

      const found = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: recipe.url ? `Starting the app — waiting for ${recipe.url}` : 'Starting the app — waiting for it to listen',
          cancellable: true,
        },
        async (_progress, token) => settle(() => token.isCancellationRequested),
      )

      if (found === undefined) {
        // The terminals are left running on purpose: the output in them is the
        // only explanation of why nothing came up, and killing them takes it away.
        vscode.window.showWarningMessage(
          'The app did not start listening. Its output is in the terminal panel.',
        )
        return
      }
      const url = recipe.url && recipe.port === found ? recipe.url : `http://localhost:${found}`
      await vscode.env.openExternal(vscode.Uri.parse(url, true))
      log.info(`Run app: opened ${url}`)
    },

    async openWorktree(key) {
      const w = requireWs()
      const a = w.manager?.byKey(key)
      const s = a ? undefined : await w.store.get(key)
      const dir = a?.worktreePath ?? s?.worktree
      const branch = a?.branch ?? s?.branch
      if (!dir) { vscode.window.showInformationMessage('This session has no worktree.'); return }
      const uri = vscode.Uri.file(dir)
      const choice = await vscode.window.showQuickPick(
        [
          { label: 'Add to this workspace', detail: "Keeps the board open alongside the agent's files" },
          { label: 'Open in a new window', detail: dir },
        ],
        { placeHolder: `Worktree ${branch ?? ''}` },
      )
      if (!choice) return
      if (choice.label.startsWith('Add')) {
        const already = (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === uri.fsPath)
        if (!already) {
          vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders?.length ?? 0, 0,
            { uri, name: branch ?? 'worktree' },
          )
        }
      } else {
        await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true })
      }
    },

    answerPermission(key, requestId, allow, selections) {
      if (!ws?.manager?.answerPermission(key, requestId, allow, selections)) {
        log.warn(`Permission ${requestId} for ${key} was no longer pending.`)
      }
      refreshAll()
    },

    /** Archiving is a soft flag: the card leaves the board, Claude Code keeps
     *  the transcript, and unarchiving brings it straight back. */
    /** Pin a card to the top of its column. Works on any key — the sidecar is
     *  keyed by whatever the board calls the run, so it needs no session id,
     *  unlike archive, which releases the run and hides the card. */
    async pin(key, pinned) {
      const w = requireWs()
      const id = w.manager?.byKey(key)?.sessionId ?? key
      await w.store.setPinned(id, pinned)
      refreshAll()
    },

    async archive(key, archived) {
      const w = requireWs()
      const id = w.manager?.byKey(key)?.sessionId ?? key
      if (id.startsWith('run-')) { vscode.window.showInformationMessage('Wait for the session to start before archiving it.'); return }
      w.manager?.release(key)
      await w.store.archive(id, archived)
      if (archived && selectedKey === key) selectedKey = undefined
      refreshAll()
    },

    /** Permanent: removes the session from Claude Code's store too. */
    async remove(key) {
      const w = requireWs()
      const id = w.manager?.byKey(key)?.sessionId ?? key
      const card = await w.store.get(id)
      const choice = await vscode.window.showWarningMessage(
        `Delete "${card?.title ?? id}" permanently?`,
        {
          modal: true,
          detail:
            'The transcript is removed from Claude Code as well. If a Claude Code ' +
            'window currently has this session open, close it first — it writes its ' +
            'own state back afterwards and the session reappears in its history. ' +
            'The git worktree and its branch are left alone.',
        },
        'Delete',
      )
      if (choice !== 'Delete') return
      w.manager?.stop(key)
      if (!id.startsWith('run-')) {
        // Say so when the promise in that dialog was not kept, rather than
        // reporting success because the card happened to leave the board.
        const result = await w.store.delete(id)
        if (!result.deleted) {
          log.warn(`Session ${id} survived deletion: ${result.reason}`)
          vscode.window.showWarningMessage(
            `"${card?.title ?? id}" is off the board, but Claude Code still has it. ${result.reason}`,
          )
        }
      }
      if (selectedKey === key) selectedKey = undefined
      refreshAll()
    },

    async refreshReview(key) {
      await loadReview(key)
    },

    /** Open VS Code's own diff: the base version on the left, the worktree's on
     *  the right. An untracked file has no left side, so it just opens. */
    async openDiff(key, file) {
      const w = requireWs()
      if (!w.worktrees || !file) return
      const wt = await worktreeOf(key)
      if (!wt) { vscode.window.showInformationMessage('This session has no worktree to diff.'); return }
      const right = vscode.Uri.file(path.join(wt.dir, file))
      const entry = review?.data.files.find((f) => f.path === file)
      // Beside the board, for the same reason as openTestLink: an editor opened
      // into the board's own group closes the board.
      const beside = { viewColumn: vscode.ViewColumn.Beside }
      if (entry?.status === '?') {
        await ownLayoutChange(async () => { await vscode.window.showTextDocument(right, beside) })
        return
      }
      // The fork point, not the base branch tip: the file list was computed
      // against the merge-base, so diffing against a base that has moved on
      // shows other people's commits as the agent's deletions.
      const ref = review?.data.baseRef ?? (await w.worktrees.mergeBase(wt.dir, wt.base)) ?? wt.base
      const left = vscode.Uri.from({
        scheme: BASE_SCHEME,
        path: '/' + file,
        query: new URLSearchParams({ dir: wt.dir, ref }).toString(),
      })
      await ownLayoutChange(async () => {
        await vscode.commands.executeCommand(
          'vscode.diff', left, right, `${path.basename(file)} — ${wt.base} ↔ ${wt.branch}`, beside,
        )
      })
    },

    /** A test-plan link, made to actually do the thing it says.
     *
     *  Everything resolves inside the session's WORKTREE, never the user's
     *  checkout — the whole point is to try the agent's version. */
    async openTestLink(key, kind, target) {
      if (!target.trim()) return
      const wt = await worktreeOf(key).catch(() => undefined)
      if (!wt) { vscode.window.showInformationMessage('This session has no worktree to test in.'); return }

      if (kind === 'url') {
        // http(s) only. The target is model-written, and openExternal hands any
        // scheme to the OS — file:// to read a key, vscode:// to drive another
        // extension's URI handler, or any registered protocol. The card renders
        // a friendly label, so the user cannot see what they are clicking.
        let parsed: vscode.Uri
        try { parsed = vscode.Uri.parse(target, true) } catch {
          vscode.window.showWarningMessage(`"${target}" is not a valid URL.`)
          return
        }
        if (parsed.scheme !== 'http' && parsed.scheme !== 'https') {
          vscode.window.showWarningMessage(
            `Refused to open "${target}" — a test link may only point at http or https.`,
          )
          return
        }
        await vscode.env.openExternal(parsed)
        return
      }
      if (kind === 'command') {
        // Not run automatically. It is the agent's suggestion, in the user's
        // shell, and they get to read it before pressing Enter.
        //
        // That claim is only true for a single line, and `target` is
        // model-written: `sendText(t, false)` does not APPEND a newline, but a
        // newline inside `t` is still one, so everything before the last line
        // ran on the click. `targetIsClean` is the same predicate
        // `normaliseTestPlan` filters on, so this is defence in depth rather
        // than the only guard — and it is worth having, because it is the last
        // point before the user's own shell.
        if (!targetIsClean(target)) {
          vscode.window.showWarningMessage(
            `Refused to run "${target.split(/[\r\n]/)[0]}…" — a test command must be a single line, ` +
            'and this one contains control characters. Nothing was sent to the terminal.',
          )
          return
        }
        const term = vscode.window.createTerminal({ name: `Test ${wt.branch}`, cwd: wt.dir })
        term.show()
        term.sendText(target, false)
        return
      }
      // A file, relative to the worktree. Refuse to escape it: the target comes
      // from the model, and "../../.ssh/id_rsa" is a path like any other.
      const resolved = await realResolveInWorktree(wt.dir, target)
      if (!resolved) {
        vscode.window.showWarningMessage(`"${target}" is outside the session's worktree, so it was not opened.`)
        return
      }
      // BESIDE the board, and as our own layout change. Opened into the board's
      // own group, the file took the group, the webview stopped being visible,
      // and that is the event "click away" closes on — so a button on the board
      // made the board vanish, and the file appearing where it had been read as
      // "nothing happened". The guard covers the moment the group splits, when
      // the webview reports `visible: false` while the layout settles.
      try {
        await ownLayoutChange(async () => {
          await vscode.window.showTextDocument(vscode.Uri.file(resolved), { preview: false, viewColumn: vscode.ViewColumn.Beside })
        })
      } catch {
        vscode.window.showWarningMessage(`Could not open ${target} — it may not exist in the worktree.`)
      }
    },

    /** Agents are told to stop at the review column WITHOUT committing, so this
     *  is the normal way work becomes mergeable. */
    async commitWorktree(key) {
      const w = requireWs()
      if (!w.worktrees) return
      const wt = await worktreeOf(key)
      if (!wt) { vscode.window.showInformationMessage('This session has no worktree.'); return }
      if (await w.worktrees.isClean(wt.dir)) {
        vscode.window.showInformationMessage('Nothing to commit — the worktree is clean.')
        return
      }
      const card = await w.store.get(w.manager?.byKey(key)?.sessionId ?? key)
      const message = await vscode.window.showInputBox({
        prompt: `Commit everything in ${wt.branch}`,
        value: card?.title ?? 'Agent changes',
        ignoreFocusOut: true,
      })
      if (!message?.trim()) return
      try {
        const sha = await w.worktrees.commitAll(wt.dir, message.trim())
        vscode.window.showInformationMessage(`Committed ${sha} on ${wt.branch}.`)
      } catch (e) {
        vscode.window.showErrorMessage(`Commit failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      await loadReview(key)
    },

    /** Merge the session's branch back into its base. Confirmed first: it
     *  writes to the user's own checkout, which nothing else here does. */
    async mergeWorktree(key) {
      const w = requireWs()
      if (!w.worktrees) return
      const wt = await worktreeOf(key)
      if (!wt) { vscode.window.showInformationMessage('This session has no worktree.'); return }

      const ahead = await w.worktrees.aheadOf(wt.dir, wt.base)
      const choice = await vscode.window.showWarningMessage(
        `Merge ${wt.branch} into ${wt.base}?`,
        {
          modal: true,
          detail: `${ahead} commit${ahead === 1 ? '' : 's'} will be merged into your working tree. ` +
            'The worktree and its branch are left in place.',
        },
        'Merge',
      )
      if (choice !== 'Merge') return

      busy = key
      refreshAll()
      try {
        const result = await w.worktrees.merge(wt.branch, wt.base)
        if (result.ok) {
          vscode.window.showInformationMessage(`Merged ${wt.branch} into ${wt.base}.`)
        } else if (result.reason === 'conflict') {
          // Left in progress on purpose: the editor is the right place to
          // resolve it, and silently aborting would throw the work away.
          const pick = await vscode.window.showWarningMessage(
            `${wt.base} has conflicts with ${wt.branch}.`,
            {
              modal: true,
              detail: result.files.length
                ? `Conflicting:\n${result.files.slice(0, 20).join('\n')}\n\n` +
                  'The merge is left in progress so you can resolve it here, or abort and leave the repository as it was.'
                : 'The merge is left in progress so you can resolve it here.',
            },
            'Resolve here', 'Abort merge',
          )
          if (pick === 'Abort merge') {
            await w.worktrees.abortMerge()
            vscode.window.showInformationMessage('Merge aborted. The repository is unchanged.')
          }
        } else {
          vscode.window.showWarningMessage(result.message)
        }
      } catch (e) {
        vscode.window.showErrorMessage(`Merge failed: ${e instanceof Error ? e.message : String(e)}`)
      } finally {
        busy = undefined
        await loadReview(key)
        refreshAll()
      }
    },

    async rename(key, title) {
      const w = requireWs()
      const live = w.manager?.byKey(key)
      const wanted = title.trim()
      if (!wanted) return
      // A live run owns its own title, so rename THROUGH it. This used to bail
      // out on `id.startsWith('run-')` — the window before the session id
      // arrives — which made renaming a card in its first seconds silently do
      // nothing, where archiving the same card at least says why. The manager
      // writes `agent.title` and carries it across when the id lands, so the
      // rename is not lost; it just had no path to get there.
      if (live) {
        const r = await w.manager!.renameAgent(key, wanted)
        if (r && r.renamed === false) {
          vscode.window.showInformationMessage(
            `The card reads "${wanted}" for this run, but ${r.reason}, so it will go back afterwards.`,
          )
        }
        refreshAll()
        return
      }
      const id = key
      if (id.startsWith('run-')) {
        vscode.window.showWarningMessage(
          'This session has not been given an id yet, so it cannot be renamed. Try again in a moment.',
        )
        return
      }
      const r = await w.store.rename(id, wanted)
      if (!r.renamed) {
        vscode.window.showInformationMessage(`This card cannot be renamed from the board — ${r.reason}.`)
      }
      refreshAll()
    },
  }

  // --- Registration. None of this may depend on a folder being open: an
  // --- early return here is what made the commands "not found". ---

  /**
   * Clicking Agents Kanban in the activity bar gives you the whole board;
   * clicking Explorer gives you your setup back.
   *
   * The sidebar view's visibility is the only signal VS Code offers for "the
   * user switched to us" / "the user switched away", so it drives both halves.
   * The side bar itself is never closed — it is the way back, and it is where
   * this very view lives.
   */
  /**
   * Our own layout commands make the side bar appear and disappear, which fires
   * the very visibility events that drive them. Closing the side bar on entry
   * would immediately read as "the user left", and reopening it on exit would
   * read as "the user wants the board" — an infinite loop either way.
   *
   * So changes we make ourselves are marked and ignored. The window is a
   * compromise: long enough to cover the echo of our own commands (VS Code
   * fires most of these while the command is still running, but reshuffling the
   * layout can settle a frame later), short enough not to swallow the user's own
   * next click — clicking the icon again straight after leaving is ordinary, and
   * at 750ms it did nothing at all.
   */
  const SELF_INFLICTED_MS = 200
  let selfInflicted = 0
  const ownLayoutChange = async (fn: () => Promise<void>): Promise<void> => {
    selfInflicted++
    try { await fn() } finally {
      setTimeout(() => { selfInflicted = Math.max(0, selfInflicted - 1) }, SELF_INFLICTED_MS)
    }
  }

  /**
   * Put everything back and close the board.
   *
   * The board is a mode, not a document: left in the editor area it occupies the
   * space your code belongs in.
   */
  const leaveBoard = (): void => {
    ownLayoutChange(async () => {
      await applyBoardFocus(false)
      BoardPanel.close()
    }).catch((e) => log.warn(`Could not restore the layout: ${String(e)}`))
  }

  const enterBoard = (): void => {
    ownLayoutChange(async () => {
      BoardPanel.show(context.extensionUri, host)
      await applyBoardFocus(true)
    }).catch((e) => log.warn(`Could not take the window: ${String(e)}`))
  }

  /**
   * The board closes on its own X, and on nothing else. Losing focus is not
   * leaving: switching to a file, or to Source Control, must leave it exactly
   * where it was.
   */
  BoardPanel.onClosed = () => {
    if (!boardFocusApplied()) return
    ownLayoutChange(() => applyBoardFocus(false))
      .catch((e) => log.warn(`Could not restore the layout: ${String(e)}`))
  }

  /**
   * Clicking away from the board closes it, like the icon and the X.
   *
   * Off by setting, because this reaches much further than it used to. While
   * the board also collapsed the side bar there was nothing on the left to
   * click; now that your files stay where they are, opening one is a single
   * click away and it takes the board down with it. Some people want exactly
   * that — they are done with the board — and some want to glance at a file and
   * come back, so it is a switch rather than a decision.
   */
  BoardPanel.onLeft = () => {
    if (selfInflicted > 0) return
    if (BoardPanel.isVisible) return
    if (cfg().get<boolean>('closeOnClickAway') === false) return
    leaveBoard()
  }

  /**
   * Give the left side bar straight back.
   *
   * The icon has to live in the activity bar to be an icon at all, and VS Code
   * answers a click on it by showing our view in the side bar — evicting
   * whatever you had there. Nothing can stop that. What we can do is put it
   * back in the same tick, so the eviction lasts a frame instead of a session.
   *
   * The side bar is left OPEN and showing your files. That is the point: the
   * board takes the editor area, the terminal and the right-hand chat, and the
   * one thing it does not take is the column you navigate with.
   */
  const handBackSideBar = async (): Promise<void> => {
    const home = cfg().get<string>('sideBarHome') ?? 'workbench.view.explorer'
    try { await showSideBarView(home) } catch (e) {
      // A bad command id in the setting must not take the board down with it.
      log.warn(`Could not restore the side bar to "${home}": ${String(e)}`)
    }
  }

  /**
   * The Kanban icon is a plain toggle: press it for the board, press it again
   * for your window back.
   *
   * Every press arrives here as our view becoming visible, because every press
   * makes VS Code show our container — including the press that closes the
   * board, since we hand the side bar back immediately and are therefore never
   * the container already on screen. That is what makes one event enough to
   * drive both directions.
   *
   * Switching away — to Source Control, Search, anything — deliberately does
   * NOT close the board. The board closes on the icon, on clicking away from
   * it, or on its tab's X.
   */
  const onBoardViewVisibility = (visible: boolean): void => {
    if (selfInflicted > 0) return
    if (!visible) return
    if ((cfg().get<FocusMode>('focusMode') ?? 'wide') === 'off') return
    ownLayoutChange(async () => {
      if (BoardPanel.isOpen) {
        await applyBoardFocus(false)
        BoardPanel.close()
      } else {
        BoardPanel.show(context.extensionUri, host)
        await applyBoardFocus(true)
      }
      // Last, and inside the same guard: this hides our own view, and that
      // event must not read as another press of the icon.
      await handBackSideBar()
    }).catch((e) => log.warn(`Could not toggle the board: ${String(e)}`))
  }

  const provider = new BoardViewProvider(context.extensionUri, host, onBoardViewVisibility)

  const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  statusItem.command = 'agentsKanban.openBoard'
  statusItem.name = 'Agents Kanban'
  const refreshStatus = () => {
    if (cfg().get<boolean>('statusBar') === false) { statusItem.hide(); return }
    const live = ws?.manager?.list() ?? []
    const waiting = live.filter((a) => a.state.kind === 'needsInput').length
    const running = live.filter((a) => ['working', 'starting'].includes(a.state.kind)).length
    statusItem.text = waiting
      ? `$(kanban) ${waiting} waiting on you`
      : running
        ? `$(kanban) ${running} running`
        : '$(kanban) Agents Kanban'
    statusItem.tooltip = 'Open the Agents Kanban board  (Ctrl+Alt+K)'
    statusItem.show()
  }
  refreshStatus()

  context.subscriptions.push(
    statusItem,
    vscode.window.registerWebviewViewProvider(BoardViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // The left-hand side of every diff: a file as it stands on the base branch.
    // A content provider avoids writing temp files and lets VS Code own the
    // document lifecycle.
    vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, {
      async provideTextDocumentContent(uri): Promise<string> {
        const q = new URLSearchParams(uri.query)
        const dir = q.get('dir'), ref = q.get('ref')
        if (!dir || !ref || !ws?.worktrees) return ''
        return ws.worktrees.show(dir, ref, uri.path.replace(/^\//, ''))
      },
    }),
    vscode.commands.registerCommand('agentsKanban.openBoard', () => enterBoard()),
    vscode.commands.registerCommand('agentsKanban.toggleFocus', () => host.toggleFocus()),
    vscode.commands.registerCommand('agentsKanban.newSession', async () => {
      const text = await vscode.window.showInputBox({
        prompt: 'What should the agent do?', ignoreFocusOut: true,
      })
      if (text?.trim()) { BoardPanel.show(context.extensionUri, host); await host.newSession(text) }
    }),
    vscode.commands.registerCommand('agentsKanban.init', () => host.init()),
    vscode.commands.registerCommand('agentsKanban.openSettings', () => openSettings()),
    vscode.commands.registerCommand('agentsKanban.selectProvider', () => selectProvider()),
    vscode.commands.registerCommand('agentsKanban.addProvider', () => addProvider()),
    vscode.commands.registerCommand('agentsKanban.testProvider', () => testProvider()),
    vscode.commands.registerCommand('agentsKanban.refreshModels', async () => {
      await refreshModels(true)
      refreshAll()
    }),
    vscode.commands.registerCommand('agentsKanban.stopTask', async () => {
      const id = await pickSession(requireWs().store, 'Stop agent')
      if (id) await host.stop(id)
    }),
    vscode.commands.registerCommand('agentsKanban.archiveSession', async () => {
      const id = await pickSession(requireWs().store, 'Archive session')
      if (id) await host.archive(id, true)
    }),
    vscode.commands.registerCommand('agentsKanban.deleteSession', async () => {
      const id = await pickSession(requireWs().store, 'Delete session permanently')
      if (id) await host.remove(id)
    }),
    vscode.commands.registerCommand('agentsKanban.openWorktree', async () => {
      const id = await pickSession(requireWs().store, 'Open worktree')
      if (id) await host.openWorktree(id)
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void rebuild()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      /* An executable path changed, so LOOK AGAIN for the agents.
         Which agents the composer offers depends on which are installed, and
         `claudeExecutable`/`codexExecutable` are how someone points at one the
         search would not find. Without this, correcting a path leaves the agent
         missing from the picker until the window is reloaded — and the fix
         reads as not having worked. */
      if (e.affectsConfiguration('agentsKanban.claudeExecutable')
          || e.affectsConfiguration('agentsKanban.codexExecutable')) {
        detectRuntimes()
          .then(() => refreshAll())
          .catch((err: unknown) => log.error(`Could not look for the installed agents: ${String(err)}`))
      }
      // A profile edited by hand in settings.json must take effect without a
      // reload, and the cached environment patch is derived from it — so this
      // re-parses AND re-resolves rather than only re-reading the list.
      if (e.affectsConfiguration('agentsKanban.providers') || e.affectsConfiguration('agentsKanban.provider')) {
        providers = parseProfiles(cfg().get<unknown[]>('providers'))
        /* An EXPLICIT edit of `agentsKanban.provider` wins, and it used not to.
           The new value was read only inside `if (!providers.some(p => p.id ===
           providerId))` — only when the currently active id had DISAPPEARED
           from the list. `INHERIT_PROFILE` is always synthesised into the list
           and any previously selected id is still in it, so that branch was
           essentially never taken and the setting's new value was dropped;
           `refreshProviderEnv()` then recompiled the environment for the old
           profile. The comment above this block promised the opposite.
           The other escape route was closed too: `workspaceState` shadows the
           setting at activation, so once the picker had run the setting could
           never be picked up, even across a reload. So this adopts the value
           AND writes it through to the workspace state that shadows it —
           otherwise the change would last until the next reload and then
           silently revert. Starting an agent on the wrong backend bills someone
           else's account, which is why this is not cosmetic. */
        if (e.affectsConfiguration('agentsKanban.provider')) {
          const wanted = cfg().get<string>('provider')
          if (wanted && providers.some((p) => p.id === wanted) && wanted !== providerId) {
            providerId = wanted
            void context.workspaceState.update('provider', wanted)
            log.info(`Provider changed in settings to "${wanted}".`)
          }
        }
        if (!providers.some((p) => p.id === providerId)) {
          providerId = cfg().get<string>('provider') ?? INHERIT_PROFILE.id
        }
        providerMismatch = undefined
        refreshProviderEnv()
          .then(() => { alignModelToProvider(); refreshAll() })
          .catch((err: unknown) => log.error(`Could not apply the provider: ${String(err)}`))
      }
      /* An explicit edit of `agentsKanban.runtime` wins over the shadow.
         `workspaceState` is consulted first and is written by both the composer
         chip and the settings page, so after either had been used once the
         setting could never take effect again — including across a reload —
         while its own manifest description told the user it decides "which
         agent program new sessions run on". The shadow is CLEARED rather than
         merely overwritten, so the setting stays authoritative until the user
         picks something else in the UI. */
      if (e.affectsConfiguration('agentsKanban.runtime')) {
        const wanted = parseRuntimeId(cfg().get<string>('runtime'))
        if (wanted && wanted !== runtime) {
          runtime = wanted
          void state.update('runtime', undefined)
          ws?.manager?.setDefaults({ runtime })
          log.info(`Agent changed in settings to "${wanted}".`)
          // The model list is per runtime — the same reason the composer and
          // the settings page both re-ask after a switch.
          void refreshModels(true).then(() => { void SettingsPanel.refreshIfOpen(); refreshAll() })
        }
      }
      if (e.affectsConfiguration('agentsKanban.focusMode')) {
        setBoardFocusMode(cfg().get<FocusMode>('focusMode') ?? 'wide')
      }
      // A whisper/ffmpeg path changed, so the mic's gate must be re-asked: the
      // cache describes the OLD config, and without this, installing whisper
      // while the window is open leaves the mic missing until a reload — the
      // fix reading as not having worked, exactly like a corrected executable
      // path above.
      if (VOICE_KEYS.some((k) => e.affectsConfiguration(`agentsKanban.${k}`))) {
        voiceResult = undefined
        voiceCheckNow()
          .then(() => { refreshAll(); void SettingsPanel.refreshIfOpen() })
          .catch((err: unknown) => log.error(`Could not re-check the dictation pipeline: ${String(err)}`))
      }
    }),
    { dispose: () => ws?.manager?.stopAll() },
    { dispose: () => paint.dispose() },
  )

  // Resolve the provider once at activation, so the first session started in
  // this window runs on the configured backend rather than on whatever the
  // empty cache defaults to. Logged, because "which provider am I on" is the
  // first question when a run bills the wrong account.
  await refreshProviderEnv()
  // From the cache only — see refreshModels: asking spawns a CLI, and the
  // launch gate must not depend on one. The first provider switch or an
  // explicit refresh fills it in.
  recomputeCatalogue()
  alignModelToProvider()
  /* Except for a CUSTOM ENDPOINT, which is asked here, in the background.
     A different kind of ask: no CLI process, no token, one HTTP GET — which is
     why it is safe at activation where `refreshModels()` is not. And it has to
     happen unasked, because the state it repairs is one nobody knows they are
     in: a profile whose declared models were written by this extension from
     the WRONG list, offering ids the endpoint has never served. Waiting for the
     user to find a Refresh button means waiting for them to work out that the
     picker is the problem.
     Only when we have never asked this endpoint, only under the same setting
     that governs asking the CLI, and never awaited — activation does not wait
     on a network round trip. */
  /* Which agents are actually on this machine, in the background.
     `detect()` only — `login()` starts the CLI, and this runs at activation.
     The composer must not offer an agent that is not installed: every session
     started on one fails at its first step, and Codex sat on the bar as a peer
     of the agent doing all the work on a machine that never had it. */
  detectRuntimes()
    .then(() => refreshAll())
    .catch((e: unknown) => log.error(`Could not look for the installed agents: ${String(e)}`))

  /* The composer's mic, probed once in the background. Two spawnSync probes are
     too slow to sit on first paint; 2s later nobody is watching the frame rate. */
  kickVoiceCheck()

  const startupEndpoint = currentProvider()
  if (cfg().get<boolean>('discoverModels') !== false
      && startupEndpoint.kind === 'gateway' && !cachedEndpoint(startupEndpoint.id).length) {
    refreshEndpointModels(startupEndpoint)
      .then(() => {
        // Re-checked after the await: a provider switch inside that window
        // would otherwise apply one backend's catalogue under another's name.
        if (currentProvider().id !== startupEndpoint.id) return
        recomputeCatalogue()
        alignModelToProvider()
        refreshAll()
      })
      // Never a bare void: a rejection here is a picker that silently keeps
      // offering models the endpoint does not serve.
      .catch((e: unknown) => log.error(`Could not read the endpoint's model list: ${String(e)}`))
  }
  const startupProfile = currentProvider()
  log.info(
    `Provider: ${profileLabel(startupProfile)} — ${describeProfile(startupProfile)}` +
    (Object.keys(providerEnv.set).length
      ? ` (sets ${Object.keys(providerEnv.set).sort().join(', ')})`
      : ' (inherits the environment)'),
  )
  const startupProblem = providerProblem()
  if (startupProblem) log.warn(startupProblem)

  await rebuild()
}

/** Scheme for the base-branch side of a diff. */
const BASE_SCHEME = 'agents-kanban-base'

async function pickSession(store: SessionStore, placeHolder: string): Promise<string | undefined> {
  const list = await store.list({ includeArchived: true })
  if (!list.length) { vscode.window.showInformationMessage('No sessions on the board yet.'); return undefined }
  const pick = await vscode.window.showQuickPick(
    list.map((x) => ({
      label: x.title,
      description: `${x.phase}${x.archived ? ' · archived' : ''}`,
      detail: x.tags.length ? x.tags.map((t) => `#${t}`).join(' ') : undefined,
      id: x.id,
    })),
    { placeHolder },
  )
  return pick?.id
}

export function deactivate(): void { /* subscriptions handle teardown */ }
