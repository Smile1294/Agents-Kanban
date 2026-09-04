/** Agents Kanban — activation and wiring.
 *
 * The board is plain markdown in the repo, agents run through the Claude Agent
 * SDK in isolated git worktrees, and the agent moves its own cards through
 * in-process MCP tools. This file owns the VS Code surface; everything else is
 * plain Node and unit-tested without VS Code.
 */
import * as path from 'node:path'
import * as vscode from 'vscode'
import { AgentManager, followKey, type RunningAgent } from './agent/manager.ts'
import type { Options as AgentOptions } from './agent/sdk.ts'
import {
  BoardPanel, BoardViewProvider, _resetBoardFocus, applyBoardFocus, boardFocusApplied,
  setBoardFocusMode, showSideBarView, toUiAgent,
  type BoardHost, type FocusMode, type Mode, type UiCard, type UiState,
} from './board/panel.ts'
import { WorktreeService, findRepoRoot, realResolveInWorktree, type WorktreeReview } from './git/worktree.ts'
import { MetaStore, EFFORT_LEVELS, MODELS, resolveEffort, resolveThinking, windowLabel, type EffortLevel, type ThinkingMode } from './sessions/meta.ts'
import { MODEL_WINDOWS, normaliseModel } from './sessions/usage.ts'
import { SessionStore, interruptedSessions, type Entry } from './sessions/store.ts'
import { listSlashCommands, type SlashCommand } from './sessions/commands.ts'
import { DEFAULT_BOARD, isReviewColumn, isSettledColumn, type BoardConfig } from './board/config.ts'
import { linkSubtasks } from './board/subtasks.ts'
import { coalesce } from './board/coalesce.ts'
import { describeImages, sanitiseImages } from './agent/images.ts'
import {
  COMMON_DEV_PORTS, detect as detectRun, isListening, readWtRegistry, waitForPort,
} from './run/recipe.ts'
import {
  INHERIT_PROFILE, PROVIDER_KINDS, PROVIDER_PRESETS, activeProfile, credentialKey,
  describeProfile, envForProfile, kindDef, parseProfiles, profileLabel,
  reconcileProvider, resolvedLabel, validateProfile,
  type ProviderEnv, type ProviderProfile,
} from './agent/providers.ts'
import { probeProvider } from './agent/probe.ts'
import {
  ALL_EFFORTS, catalogueFor, discoverModels, effortsFor, fastModeFor, thinkingFor, ultracodeFor,
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
    { key: 'acceptEdits', label: 'Auto-accept edits', detail: 'File edits go through; commands still ask' },
    { key: 'plan', label: 'Plan only', detail: 'Think it through, change nothing' },
    { key: 'dontAsk', label: "Don't ask", detail: 'Stop prompting; the agent decides' },
    { key: 'auto', label: 'Auto', detail: 'Let Claude Code choose per tool' },
    { key: 'bypassPermissions', label: 'Bypass all', detail: 'No checks at all — the agent is in a worktree, but still' },
  ]
  let permissionMode: NonNullable<AgentPermissionMode> =
    (state.get<string>('permissionMode') as NonNullable<AgentPermissionMode>) ??
    (cfg().get<string>('permissionMode') as NonNullable<AgentPermissionMode>) ??
    'acceptEdits'

  // Composer defaults, remembered per workspace.
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

  const catalogueKey = (id: string) => `models:${id}`

  /** Rebuild the catalogue from whatever is already known — no CLI round trip.
   *  Called whenever the profile changes, so the picker is never showing the
   *  previous provider's models while discovery runs. */
  function recomputeCatalogue(discovered?: readonly ModelChoice[], problem?: string): void {
    const p = currentProvider()
    const cached = discovered
      ?? context.globalState.get<ModelChoice[]>(catalogueKey(p.id))
      ?? []
    catalogue = catalogueFor(p, cached, builtinChoices(),
      { normaliseModel, windows: MODEL_WINDOWS, windowLabel }, problem)
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
    if (cfg().get<boolean>('discoverModels') === false) { recomputeCatalogue(); return }
    const p = currentProvider()
    if (!force && context.globalState.get<ModelChoice[]>(catalogueKey(p.id))?.length) {
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
        await context.globalState.update(catalogueKey(p.id), choices)
        log.info(`Models for ${profileLabel(p)}: ${choices.map((c) => c.id).join(', ')}`)
      } else if (problem) {
        log.warn(`Could not read the model list for ${profileLabel(p)}: ${problem}`)
      }
      recomputeCatalogue(choices, problem)
      alignModelToProvider()
    })().finally(() => { discovering = undefined })
    return discovering
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
    alignModelToProvider()
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
      ...(field.secret ? { password: true } : { value: current }),
      ignoreFocusOut: true,
    })
  }

  /**
   * Walk a profile's fields and write the answers onto it.
   *
   * Driven by `kindDef().fields` rather than a form per kind, which is what
   * makes a new provider one entry in `PROVIDER_KINDS` instead of a new dialog.
   * The secret never lands on the profile: it goes to SecretStorage and only
   * `hasCredential` is recorded.
   */
  async function fillProfile(profile: ProviderProfile): Promise<boolean> {
    for (const field of kindDef(profile.kind).fields) {
      const answer = await askField(profile, field)
      if (answer === undefined) return false
      const value = answer.trim()
      if (field.secret) {
        if (value) {
          await context.secrets.store(credentialKey(profile.id), value)
          profile.hasCredential = true
        } else {
          await context.secrets.delete(credentialKey(profile.id))
          delete profile.hasCredential
        }
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
    // A probe that found the models is worth keeping: it is the only
    // authoritative list for a backend whose ids we cannot know, and it turns
    // the model picker from a guess into something the endpoint confirmed.
    if (result.ok && result.models?.length && profile.kind !== 'inherit' && !profile.models?.length) {
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
    await saveProfiles(providers.filter((p) => p.id !== profile.id))
    if (providerId === profile.id) await setActiveProvider(INHERIT_PROFILE.id)
    refreshAll()
  }

  /** The one entry point: choose a provider, or manage the list. */
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
        defaults: { model, effort, thinking, ultracode, fastMode },
        permissionMode,
        maxConcurrent: cfg().get<number>('maxConcurrentAgents') ?? 3,
        claudeExecutable: cfg().get<string>('claudeExecutable') || undefined,
        provider: currentProvider(),
        providerEnv,
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
    const phases = await Promise.all(siblings.map((k) => w.store.card(k).then((c) => c.phase)))
    if (!phases.every((p) => isSettledColumn(w.board, p))) return false

    const review = w.board.columns.find((c) => c.category === 'review')?.id
    const parentCard = await w.store.card(parentKey)
    if (review && parentCard.phase !== review) await w.store.setPhase(parentKey, review)
    refreshAll()

    if (cfg().get<boolean>('notifyOnReview') === false) return true
    const title = w.manager?.byKey(parentKey)?.title
      ?? (await w.store.get(parentKey))?.title
      ?? 'The parent task'
    notifyReady(parentKey, title, `All ${siblings.length} subtasks of "${title}" are ready for you to test.`)
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
    async getState(): Promise<UiState> {
      const active = currentProvider()
      // The effort levels are the SELECTED MODEL's, not a global list. Haiku 4.5
      // accepts none, and was being offered all five — a control that could not
      // say no, which is the same class of bug as a spinner over a wedged
      // process.
      const levels = effortsFor(catalogue.choices, model)
      const composer = {
        model, effort, thinking,
        models: catalogue.choices.map((m) => ({
          id: m.id, label: m.label, context: m.context, ...(m.detail ? { detail: m.detail } : {}),
        })),
        // Ultracode owns effort — it IS xhigh — so the effort picker steps aside
        // rather than showing a level that is being overridden.
        efforts: ultracode ? [] : EFFORT_LEVELS.filter((e) => levels.includes(e.key)),
        thinkingSupported: thinkingFor(catalogue.choices, model),
        ultracode, fastMode,
        ultracodeSupported: ultracodeFor(catalogue.choices, model),
        fastModeSupported: fastModeFor(catalogue.choices, model),
        modelSource: catalogue.source,
        ...(catalogue.problem ? { modelNote: catalogue.problem } : {}),
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
        spentUsd: undefined as number | undefined,
        spendPriced: true as boolean,
        permissionMode: permissionMode as string,
        permissionModes: PERMISSION_MODES,
      }
      if (!ws) {
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
          key: s.id, sessionId: s.id, title: s.title, phase: s.phase, tags: s.tags,
          updated: s.updated, archived: s.archived, pinned: s.pinned,
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
          composer.spentUsd = a.spentUsd ?? a.priorUsd
          composer.spendPriced = a.spendPriced ?? true
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
          composer.spentUsd = totals.costUsd
          composer.spendPriced = totals.priced
        }
      }

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
      if (patch.effort) { effort = patch.effort as EffortLevel; void state.update('effort', effort) }
      if (patch.thinking) { thinking = patch.thinking as ThinkingMode; void state.update('thinking', thinking) }
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
      if (patch.provider && patch.provider !== providerId && providers.some((p) => p.id === patch.provider)) {
        setActiveProvider(patch.provider)
          .then(() => refreshAll())
          .catch((e: unknown) => log.error(`Could not apply the provider: ${String(e)}`))
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
      if (ultracode && !ultracodeFor(catalogue.choices, model)) {
        ultracode = false
        log.info(`Ultracode is not available on ${model}, which is not xhigh-capable.`)
      }
      if (fastMode && !fastModeFor(catalogue.choices, model)) {
        fastMode = false
        log.info(`Fast mode is not available on ${model}.`)
      }
      if (patch.ultracode || patch.model) void state.update('ultracode', ultracode)
      if (patch.fastMode || patch.model) void state.update('fastMode', fastMode)
      ws?.manager?.setDefaults({ model, effort, thinking, ultracode, fastMode })
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
      if (!id.startsWith('run-')) await w.store.setPhase(id, phase)
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
      const id = w.manager?.byKey(key)?.sessionId ?? key
      if (!title.trim() || id.startsWith('run-')) return
      await w.store.rename(id, title.trim())
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
      // A profile edited by hand in settings.json must take effect without a
      // reload, and the cached environment patch is derived from it — so this
      // re-parses AND re-resolves rather than only re-reading the list.
      if (e.affectsConfiguration('agentsKanban.providers') || e.affectsConfiguration('agentsKanban.provider')) {
        providers = parseProfiles(cfg().get<unknown[]>('providers'))
        if (!providers.some((p) => p.id === providerId)) {
          providerId = cfg().get<string>('provider') ?? INHERIT_PROFILE.id
        }
        providerMismatch = undefined
        refreshProviderEnv()
          .then(() => { alignModelToProvider(); refreshAll() })
          .catch((err: unknown) => log.error(`Could not apply the provider: ${String(err)}`))
      }
      if (e.affectsConfiguration('agentsKanban.focusMode')) {
        setBoardFocusMode(cfg().get<FocusMode>('focusMode') ?? 'wide')
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
