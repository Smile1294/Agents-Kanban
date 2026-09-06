/** Claude Code, behind the runtime contract.
 *
 * This adds no behaviour. `AgentSession` is unchanged and still does all the
 * work; this file is the descriptor that lets `AgentManager` reach it through
 * the same interface it reaches Codex through, so that "which agent program is
 * this card running on" is a lookup rather than a branch.
 *
 * That matters more than it looks. The alternative — an `if (runtime ===
 * 'claude')` in the manager — reads as smaller and is the thing that does not
 * scale: every future question ("is it installed?", "is it signed in?", "what
 * models does it have?", "where is its transcript?") grows a second arm of that
 * `if`, in a different file each time. Here they are five members of one object
 * and a third runtime either implements them or does not compile.
 *
 * The one asymmetry worth knowing about is board tools. Claude Code takes an
 * **in-process** MCP server — a plain object, no transport — because the Agent
 * SDK accepts one and we are in the same process as the `SessionStore`. Codex
 * cannot, and gets the same tools over a socket. `capabilities.boardTools` is
 * how the manager knows which to build, rather than knowing about either
 * runtime by name.
 */
import { AgentSession, agentEnv } from '../session.ts'
import { resolveClaudeExecutable, type Options } from '../sdk.ts'
import { withSilentQuery } from '../connect.ts'
import { MODELS } from '../../sessions/meta.ts'
import { MODEL_WINDOWS } from '../../sessions/usage.ts'
import type { ProviderEnv } from '../providers.ts'
import {
  type AgentRun,
  type AgentRuntime,
  type LoginState,
  type ModelCatalogue,
  type RunSpec,
  type RuntimeLocation,
  type RuntimeModel,
} from '../runtime.ts'

/** The built-in list, in the contract's shape.
 *
 *  Derived from `MODELS` and `MODEL_WINDOWS` rather than written out again, so
 *  the picker's label and the meter's denominator still cannot disagree — the
 *  rule that table already exists to enforce. Effort and thinking are omitted
 *  deliberately: the built-in list does not know which models support them, and
 *  guessing is what shipped a five-level effort picker on Haiku. The CLI's own
 *  answer, via `models()`, is where those come from. */
function builtin(): RuntimeModel[] {
  return MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    ...(MODEL_WINDOWS[m.id] ? { contextWindow: MODEL_WINDOWS[m.id]! } : {}),
  }))
}

export const claudeRuntime: AgentRuntime = {
  id: 'claude',
  label: 'Claude Code',
  vendor: 'Anthropic',
  blurb: 'Runs the Claude Code CLI on this machine. Its backend — Anthropic, Bedrock, Vertex, a gateway — is chosen by a provider profile.',
  installHint: 'npm install -g @anthropic-ai/claude-code',
  capabilities: {
    // The one runtime whose backend is environment on the child process, so the
    // provider profiles apply to it and to nothing else.
    providerProfiles: true,
    interrupt: true,
    steer: true,
    approvals: true,
    images: true,
    thinkingToggle: true,
    durableHistory: true,
    boardTools: 'inProcess',
  },

  detect(configured?: string): Promise<RuntimeLocation | undefined> {
    return resolveClaudeExecutable(configured).then((command) =>
      command ? { command, source: configured ? ('setting' as const) : ('path' as const) } : undefined)
  },

  /**
   * Who the CLI says it is.
   *
   * `Query.accountInfo()` answers from the `initialize` handshake, before any
   * prompt is read, so this costs a process start and no tokens — the same
   * probe `checkEndpoint` documents at ~460ms.
   *
   * Note what it does NOT claim. `accountInfo()` reports the backend the CLI
   * WOULD use; it has made no API request, so a signed-in answer here is not a
   * promise that the next request succeeds. That is why the provider page has a
   * separate endpoint check, and why this returns `unknown` rather than
   * `signedOut` when it cannot ask.
   */
  async login(loc: RuntimeLocation, provider?: ProviderEnv): Promise<LoginState> {
    try {
      /* Through `withSilentQuery`, and that is not a tidy-up.
         This used to build its own `query()` and `await q.accountInfo()` with
         NO timeout and no guaranteed abort — the one CLI call in this codebase
         that had neither, while `connect.ts` says out loud that a wall clock
         "is part of the contract rather than defensive habit".
         It survived only because it always ran first-party, where the handshake
         answers. Running it with the ACTIVE BACKEND's environment — which is
         what makes the answer true — points it at whatever the profile points
         at, and a gateway on a host that drops packets does not fail, it hangs.
         An unbounded await inside the settings page's status collection is a
         page that never paints and a CLI process left behind for the life of
         the window. */
      const info = await withSilentQuery(
        provider ?? { set: {}, clear: [] },
        { claudeExecutable: loc.command, timeoutMs: 15_000 },
        (q, race) => race(q.accountInfo?.()) as Promise<Record<string, unknown> | undefined>,
      )
      if (!info) return { kind: 'unknown', reason: 'The CLI did not report an account.' }
      const email = typeof info.emailAddress === 'string' ? info.emailAddress
        : typeof info.email === 'string' ? info.email : undefined
      const providerId = typeof info.apiProvider === 'string' ? info.apiProvider : undefined
      return {
        kind: 'signedIn',
        // `firstParty` is a subscription or a Console key; the cloud backends
        // authenticate through their own credential chains, which is a
        // different thing to tell the user about.
        via: providerId && providerId !== 'firstParty' ? 'cloud' : 'subscription',
        ...(email ? { account: email } : {}),
        /* `apiProvider` used to be reported as the PLAN, which is how the raw
           string `firstParty` came to be printed on the settings page next to
           an email address. It is not a plan, it is somebody else's word for a
           backend — and the backend is named properly on its own row now. */
      }
    } catch (e) {
      return { kind: 'unknown', reason: e instanceof Error ? e.message : String(e) }
    }
  },


  /**
   * What this install can run.
   *
   * Deliberately thin: `agent/models.ts` already owns discovery, its cache and
   * the three-source fallback, and duplicating that here is the "two functions
   * that both know how to fall back" bug this project has a rule about. The
   * settings page asks `models.ts` — and for a while it did NOT, taking this
   * path for every runtime and therefore always reporting the built-in three
   * while blaming the CLI for not answering. It now special-cases `claude`;
   * this exists so the contract is complete and a caller that only has a
   * runtime can still get an answer.
   */
  async models(): Promise<ModelCatalogue> {
    return { models: builtin(), source: 'builtin' }
  },

  builtinModels: builtin,

  start(spec: RunSpec): AgentRun {
    if (!spec.executable) {
      throw new Error(
        'The Claude Code CLI was not found. Install it from https://claude.com/code, ' +
        'or set `agentsKanban.claudePath` to where it lives.',
      )
    }
    return new AgentSession({
      taskId: spec.taskId,
      cwd: spec.cwd,
      permissionMode: spec.permissionMode as NonNullable<Options['permissionMode']>,
      // The SDK's in-process server. `boardTools.inProcess` is `unknown` in the
      // contract on purpose: its type is an Anthropic API and the contract must
      // not depend on one vendor's SDK to describe a concept every runtime has.
      boardServer: spec.boardTools?.inProcess as never,
      claudeExecutable: spec.executable,
      ...(spec.boardTools?.autoAllow ? { boardTools: spec.boardTools.autoAllow } : {}),
      ...(spec.appendSystemPrompt ? { appendSystemPrompt: spec.appendSystemPrompt } : {}),
      ...(spec.resume ? { resume: spec.resume } : {}),
      ...(spec.log ? { log: spec.log } : {}),
      ...(spec.provider ? { provider: spec.provider } : {}),
      // What a custom endpoint said its models cost. Without this the session
      // prices Anthropic's models and nothing else, and every run on a gateway
      // reads `≥ $0.00`.
      ...(spec.modelBook ? { modelBook: spec.modelBook } : {}),
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.envClear ? { envClear: spec.envClear } : {}),
      ...(spec.model ? { model: spec.model } : {}),
      ...(spec.effort ? { effort: spec.effort } : {}),
      ...(spec.thinking === 'disabled' ? { thinking: 'disabled' as const } : {}),
      ...(spec.ultracode ? { ultracode: true } : {}),
      ...(spec.fastMode ? { fastMode: true } : {}),
    })
  },
}
