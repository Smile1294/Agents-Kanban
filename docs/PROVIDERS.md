# Providers — which backend Claude Code runs on

> **There are two axes, and this page is one of them.**
>
> A **runtime** is the agent program itself — Claude Code, Codex. It is what you
> sign into, and it owns the transcript, the tool loop and the login. See
> [RUNTIMES.md](RUNTIMES.md).
>
> A **provider** is what stands *behind* Claude Code: Anthropic directly,
> Bedrock, Vertex, Foundry, a gateway. That is this page.
>
> Codex has no provider setting and never will, because it authenticates as
> itself. Offering one would be a control that cannot take effect.

Agents Kanban does not talk to a model API. It spawns the **Claude Code CLI**,
and the CLI talks to the provider. That one fact decides the whole design, so
it is worth reading before anything else here.

Every backend Claude Code can reach is selected by **environment variables on
that child process** — `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_BASE_URL`, and
so on. So "provider support" in this extension is not an API client per vendor,
the way it is in [Cline](https://github.com/cline/cline) or
[Continue](https://github.com/continuedev/continue). It is a typed profile that
compiles to an environment block, and one place that knows the variable names:
[`src/agent/providers.ts`](../src/agent/providers.ts).

That is a much smaller feature than it first looks, and a much more reliable
one: anything Claude Code learns to talk to works here on the day it ships,
without a release.

---

## The default changes nothing

The profile every install starts on is **Inherit from environment**, and it
writes nothing and clears nothing.

This is not timidity, it is correctness. `agentEnv()` spreads `process.env`
into the CLI's environment, so somebody whose shell already exports
`CLAUDE_CODE_USE_BEDROCK=1` was *already* running agents on Bedrock before this
feature existed. A default that forced first-party Anthropic would have broken
every working enterprise setup on upgrade, silently, with the board cheerfully
naming the wrong provider.

So: if you already have Claude Code configured — through your shell, through
`~/.claude/settings.json`, through a managed settings file your admin
distributes — **you do not need this feature at all.** It is for choosing a
backend from inside the editor, and for running different sessions against
different ones.

---

## What you can select

| Kind | What it is | Supported by Anthropic |
|---|---|---|
| **Inherit from environment** | Whatever the CLI resolves on its own | — |
| **Anthropic API** | Your Claude subscription, or a Console API key | yes |
| **Amazon Bedrock** | Claude on AWS, through the AWS credential chain | yes |
| **Google Cloud Agent Platform** | Claude on GCP (formerly Vertex AI) | yes |
| **Microsoft Foundry** | Claude on Azure | yes |
| **Claude Platform on AWS** | Anthropic's API, billed through AWS Marketplace | yes |
| **Custom endpoint or gateway** | Anything serving the Anthropic Messages API at a URL | see below |

The last row is one kind rather than several, because to the CLI an enterprise
LLM gateway, a self-hosted proxy and a translation proxy in front of a local
model are the same thing: an HTTP endpoint that speaks
`POST /v1/messages`. Presets pre-fill it for the common cases; a preset is only
a factory for a profile, so it cannot behave differently from one you typed.

### About non-Claude models

Claude Code speaks the Anthropic Messages API. Ollama, OpenRouter, vLLM and
OpenAI-compatible servers speak a different one, so reaching them needs a
**translation proxy you run separately** —
[claude-code-router](https://github.com/musistudio/claude-code-router),
[LiteLLM](https://github.com/BerriAI/litellm), or similar. From this extension's
side that is just a gateway profile pointing at `localhost`.

It works. It is also **not a configuration Anthropic supports**: the
[gateway documentation](https://code.claude.com/docs/en/llm-gateway) says
plainly that routing Claude Code to non-Claude models through any gateway is
not supported. The picker marks those presets `community proxy` for that reason
— listing them beside Bedrock with no distinction would be lying by omission.

#### Codex, and a ChatGPT subscription

**This is no longer a provider question, and it no longer involves a proxy.**

Codex is not a backend that stands behind Claude Code — it is a *sibling of*
Claude Code, an agent runtime you sign into, with its own protocol, its own
transcript store and its own login. The board now drives it directly. See
[RUNTIMES.md](RUNTIMES.md).

What that means in practice: if you have run `codex login` on this machine,
Codex sessions work. There is nothing to configure, no endpoint to point at and
no key to paste. Pick **Codex** from the 🤖 picker on the composer bar, or make
it the default on the settings page.

The old advice on this page — run LiteLLM or claude-code-router in front of
Claude Code — was poor advice for a concrete reason, and it is worth stating
because it is the reason the runtime work happened at all:

> **A ChatGPT subscription cannot be spent through a proxy.** LiteLLM and
> claude-code-router need an OpenAI **API key**, which is a different credential
> on a different billing meter. The subscription's tokens live in
> `~/.codex/auth.json` and only the Codex runtime can spend them.

So the honest matrix is now:

| You have | What works |
|---|---|
| A ChatGPT / Codex **subscription** | Codex sessions, natively. No proxy. |
| An OpenAI **API key** | Codex sessions too — `codex login` takes either. |
| A non-Claude model behind an Anthropic-shaped endpoint | A `gateway` profile, as below. Still a community setup. |

#### Non-Claude models behind Claude Code

The gateway path still exists and is still unsupported by Anthropic, but it is
now for one case only: putting a model that is neither Claude nor GPT — a local
Llama, a vLLM deployment, DeepSeek — behind Claude Code through a translation
proxy such as [LiteLLM](https://github.com/BerriAI/litellm) or
[claude-code-router](https://github.com/musistudio/claude-code-router).

Pointing a base URL at `api.openai.com` can never work and the profile validator
refuses it by name: Claude Code sends Anthropic Messages requests and OpenAI does
not serve that protocol. If you want OpenAI models, use the Codex runtime — that
is what it is for.

The board's cost figures stay honest rather than helpful on a gateway: a model
with no entry in the Anthropic rate table shows spend as `≥ $…` instead of a
guessed price, and the context meter uses the window the profile declares.

Two settings exist for this path, and the presets turn them on:

- `disableBetas` → `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`. The documented
  fix for `Unexpected value(s) for the anthropic-beta header`, which is what
  most proxies return on a stock Claude Code request.
- `disableNonessentialTraffic` → `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
  as the gateway docs advise.

---

## How to set one up

From the board: the **🤖 picker** on the composer bar → *Agents, backends and
logins…*, which opens the settings tab. From the palette: **Agents Kanban:
Settings — Agents, Backends and Logins**.

It is a tab rather than a quick pick on purpose: a quick pick closes when focus
moves, and it took a half-typed gateway URL with it every time.

Pick a preset, answer the fields, and — because a provider that looks
configured and is not is the whole problem — press **Test connection**.

### What the connection test actually checks

Two halves, and the second one exists because of a bug found by running it
rather than by testing it.

**The CLI half is free.** `query()` spawns the CLI and completes an `initialize`
control request *before* any prompt is read, and that response already carries
the account and the model list. So the probe hands `query()` a prompt iterable
that never yields, asks its two questions, and aborts. No message reaches a
model. Measured against a real CLI: **~460ms**.

It reports three useful things:

- **which provider the CLI actually resolved** — see below
- **where the credential came from**, as the CLI sees it. This is how "my key is
  being ignored because I am still logged in" becomes visible instead of
  puzzling.
- **the models this backend offers**, which it will offer to put in the picker.
  That is the only authoritative list for a backend whose ids we cannot know.

**But that half alone overclaims.** Pointed at `http://127.0.0.1:1`, where
nothing is listening, the CLI initialises happily and reports `firstParty` — it
has made no API request, so it cannot know the endpoint is dead. The first
version of this probe said *"Connected"* and every agent run afterwards would
have failed. A check that cannot come back bad is exactly what this project
forbids.

So a **gateway** profile — the only kind whose endpoint is ours to test — is
checked for real, in two steps chosen because they have *different fixes*:

| Result | What it means | Cost |
|---|---|---|
| nothing listening | start the proxy, or correct the port | free (TCP connect) |
| `404` | reachable, but no `/v1/messages` — wrong path, or not an Anthropic-format endpoint | free |
| `401` / `403` | reachable; the credential is wrong, or is in the header this gateway does not read — try the other `authStyle` | free |
| `5xx` | the gateway answered; its upstream failed | free |
| `400` | it speaks this API but objected — usually a model id it does not serve. Counts as a pass | free |
| `200` | it answered and took the credential | **one token** |

That last request is `POST /v1/messages` with `max_tokens: 1` and a single
character of prompt — the verification request the
[gateway documentation](https://code.claude.com/docs/en/llm-gateway-connect)
itself prescribes. Every failure path costs nothing.

For the **cloud** kinds the endpoint and the credentials belong to the provider
and authentication runs through their SDK chain, so the probe confirms which
backend was *selected* and says so in exactly those words — "Claude Code is
configured for Amazon Bedrock. The first request will confirm the credentials."
It does not claim they work, because it has not asked.

---

## Where things are stored

| | Where | Why |
|---|---|---|
| Profiles | `agentsKanban.providers` in settings | Hand-editable, syncable, describable by a schema |
| Active profile | `agentsKanban.provider`, plus `workspaceState` | Same shape as the model and effort pickers |
| **Credentials** | **VS Code `SecretStorage`** | `settings.json` syncs between machines and gets committed in `.vscode/` directories. An API key is not configuration. |

The profile records only `hasCredential: true`, never the value. `smoke.mjs`
checks both stores in both directions, because a stub that swallowed writes
would let "the key went into settings.json" pass.

If the credential is already in your shell, set `credentialFromEnv` to the
variable name and skip the keychain entirely.

---

## The two things that are load-bearing

Everything above is plumbing. These two are the reason it can be trusted.

### 1. An explicit choice CLEARS the variables it does not set

Provider selection is a **set of independent flags**, not one field. With
`CLAUDE_CODE_USE_BEDROCK=1` in the ambient environment, selecting a gateway
profile and setting `ANTHROPIC_BASE_URL` produces a session that is *still on
Bedrock* — nothing turned the flag off. The board would then name a provider
that is not billing the tokens.

So `envForProfile()` returns `clear` alongside `set`, listing every
provider-steering variable the profile does not own, and `agentEnv()` drops
those keys from the child's environment **entirely** — absent, not empty,
because a future CLI reading `''` as "set" would turn the guard back into the
bug. `providers.test.ts` checks this as a matrix over every kind, so a new
provider is covered the moment it is added to `PROVIDER_KINDS`.

What `clear` deliberately does **not** cover is your cloud credential chain:
`AWS_PROFILE`, `AWS_REGION`, `GOOGLE_APPLICATION_CREDENTIALS`, `HTTPS_PROXY`
and the rest. Those are how Bedrock and Vertex are *documented* to
authenticate. The line is: this extension owns which backend and where it is,
not who you are to your cloud.

### 2. The board shows what the CLI resolved, not what we asked for

Writing environment variables is a request. Plenty of things outrank it — a
managed settings file, an `apiKeyHelper`, an `env` block in
`~/.claude/settings.json`. A readout that could only ever repeat our own
configuration back to us would be the
["never show a signal that cannot say bad"](DECISIONS.md) rule broken in a new
place.

So every run asks `Query.accountInfo()` once, reads `apiProvider`, and
reconciles it against the profile. A disagreement becomes an amber note on the
composer bar naming **both** sides — asked for Bedrock, got first-party — and a
line in the output channel. Two disagreements are accepted as legitimate and
documented:

- a `gateway` profile reporting `firstParty`, which is what a proxy forwarding
  to Anthropic with no gateway credential correctly does
- a `bedrock` profile reporting `mantle`, which is Bedrock at a different
  endpoint

The check runs **once per run**, fire-and-forget, never in the message loop:
it is a control round trip to the child, and the repaint budget exists to keep
exactly this kind of work off the per-token path.

---

## The model list

The picker asks the CLI. `Query.supportedModels()` returns exactly what `/model`
shows, for whatever provider is active, and it arrives with the `initialize`
response — so it costs nothing beyond the ~460ms connection described above.

That replaced a hardcoded table which was wrong in three ways at once, none of
them visible from inside the extension:

- **Models were missing.** Fable 5 shipped and the picker did not have it. A
  table of model ids goes stale between releases and the person who notices is
  the user, who cannot fix it.
- **The 1M variants were invisible.** `claude-opus-5[1m]` and `claude-opus-5`
  are different context windows and the picker knew one number.
- **It offered controls models do not have.** Every model got the full
  `low…max` effort picker and an extended-thinking toggle. **Haiku 4.5 supports
  neither** — so both were controls that could not say no, the same class of
  problem as a spinner over a wedged process. They now disappear for a model
  that does not support them, rather than being greyed out.

A real answer, from Claude Code 2.1.239:

| Picker entry | id passed to `query()` | Window | Effort | Thinking |
|---|---|---|---|---|
| Default (recommended) | `default` | 1M | low…max | yes |
| Opus (1M context) | `opus[1m]` | 1M | low…max | yes |
| Fable | `claude-fable-5[1m]` | 1M | low…max | yes |
| Sonnet | `sonnet` | 1M | low…max | yes |
| Haiku | `haiku` | 200K | **none** | **no** |

Ids are passed through **verbatim**. `default` and `sonnet` are real things to
hand `query()`, and resolving them here would second-guess the CLI's own
resolution — which is per provider and can change without us.

**Where it runs, and where it deliberately does not.** Discovery spawns a CLI
process, so it is triggered by the events that can change the answer — a
provider switch, or *Refresh the model list* in the provider menu — and cached
per provider in extension storage. It is **not** on the render path (`getState()`
runs ten times a second while an agent streams) and **not** on the activation
path (the launch gate seeds a throwaway `CLAUDE_CONFIG_DIR` precisely so it does
not depend on the machine).

**The fallback never produces an empty picker.** An empty picker reads as a
broken extension, and the cause would be something as ordinary as being offline.
Three sources, in order: a list the profile declares → what the CLI reported →
the built-in table. When the built-in one is in force the menu **says so**,
because "why is the model I use in Claude Code missing here?" is otherwise
unanswerable.

Turn the whole thing off with `agentsKanban.discoverModels: false`.

**The cache is parsed, not trusted.** Extension storage outlives the version
that wrote it, so a catalogue cached by an older build is another program's
output. When `ModelChoice` gained its capability fields, every previously cached
entry became one with holes in it, and the composer read `undefined.includes(…)`
inside `getState()` — a silently blank panel, not an error. A cache this build
cannot read counts as a miss and is re-asked.

### If the picker is missing a model

Press **Refresh the model list** and read what it says:

| It says | Meaning |
|---|---|
| `N models: …` naming what you expect | Working — the list is the CLI's |
| `Using the built-in model list: …` | Discovery failed, and the reason follows |
| The menu footer says **Built-in list** | Same, seen from the picker |
| The menu footer says **Models listed by this provider profile** | Your profile declares its own `models`, which outranks discovery — clear that field to fall back to the CLI |

### Ultracode and fast mode

Both are **session flags**, not `query()` options — but `Options.settings`
accepts an inline object that layers over your settings files (above
user/project/local, below managed policy), so both are settable per session.

- **Ultracode** — the SDK describes it as *"xhigh effort plus standing
  dynamic-workflow orchestration… requires workflows to be enabled and an
  xhigh-capable model."* It is the same thing the `ultracode` keyword triggers
  in a prompt.
- **Fast mode** — same model, faster output.

Both appear in the composer **only when the CLI says the selected model supports
them**: `supportedEffortLevels` including `xhigh` for ultracode,
`supportsFastMode` for fast mode. On Haiku, neither appears.

That gate is not decoration, because **the flag path validates nothing.**
Measured against a real CLI, `Query.applyFlagSettings()` resolves for all of
these:

| Sent | Result |
|---|---|
| `ultracode: true` on an xhigh-capable model | resolved |
| `ultracode: true` on Haiku, which has no xhigh | **resolved** |
| `ultracode: "banana"` | **resolved** |
| `completelyMadeUpKey: true` | **resolved** |

So a toggle wired straight to it would be a control that can never say no. The
model capability is the only check available *before* a run.

**And one check after it.** Ultracode requires workflows to be enabled, which
nothing exposes — so once the session exists, `system/init` is inspected for the
`Workflow` tool. If it is absent, ultracode cannot do the half it is named for,
and the board says so instead of leaving the toggle looking on.

This is deliberately **one-sided**: `Workflow` is present on ordinary sessions
too (verified), so its presence proves nothing and is never reported as success.
Only its absence is evidence. A signal has to be able to say "bad"; it does not
have to be able to say "good".

Turning ultracode on **hides the effort picker** — ultracode *is* xhigh, and two
controls arguing over one value is worse than one.

---

## Model ids, cost and the context meter

`MODEL_RATES` and `MODEL_WINDOWS` in [`usage.ts`](../src/sessions/usage.ts) are
keyed by Anthropic's model ids, and **no other provider uses them**:

```
us.anthropic.claude-haiku-4-5-20251001-v1:0   Bedrock, cross-region profile
global.anthropic.claude-opus-5                Bedrock, global profile
anthropic.claude-sonnet-5                     Bedrock Mantle
claude-sonnet-4-6@20260115                    Vertex
claude-sonnet-4-6[1m]                         a pinned 1M-window variant
```

Every one is the same model at the same price as its bare id, so `normaliseModel`
strips the prefixes and suffixes rather than the price table being copied per
provider. Without that, a whole Bedrock deployment reports `≥ $0.00` and a `?`
context window — technically honest, since `priced: false` *is* "we do not know
this model", and completely useless.

Two deliberate limits:

- **`[1m]` maps to the base model.** The 1M window carries a premium above 200K
  tokens that a two-number rate cannot express, so the estimate runs low on a
  long session. Low by a known mechanism beats a total that gives up, and
  `settleTurn` already compares every turn against the CLI's own
  `total_cost_usd` and says so when the gap exceeds 20%.
- **An inference-profile ARN stays unpriced.** It names a profile, not a model,
  and the mapping lives in your AWS account. Unpriced is the truth.

A profile may declare `models` (its own ids for the picker) and
`contextWindow` (a denominator for the meter). Labels and windows are
**derived** from the same tables the meter measures against, so a Bedrock
inference profile still reads as `Haiku 4.5` at `200K` — the existing rule that
"a label that disagrees with the meter beside it is not expressible",
extended to ids we did not write. Only a genuinely unknown model falls back to
its raw id and the profile's declared window.

---

## Switching provider does not move a running agent

`setProvider()` applies to the **next** session only. A provider is chosen when
the CLI process starts, because it *is* environment on that process, so there is
no honest way to move a live run — and a card claiming a backend it is not on is
the failure this whole feature exists to prevent. The model and effort pickers
can be loose about this because those genuinely do take effect next turn.

Switching also re-checks the model selection: the model list is per-provider, so
a switch can otherwise strand it on an id the new backend does not serve (a
Bedrock inference profile still selected after moving to first-party). Left
alone, that shows a nameless agent in the picker and fails at the first API
call with somebody else's error message.

---

## Variables each kind writes

Reference. The authority is `envForProfile()`; this table is for reading.

| Kind | Sets |
|---|---|
| `inherit` | *nothing* |
| `anthropic` | `ANTHROPIC_API_KEY` (only if you gave one) |
| `bedrock` | `CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `ANTHROPIC_BEDROCK_REGION_PREFIX`, `ANTHROPIC_BEDROCK_BASE_URL`, `AWS_BEARER_TOKEN_BEDROCK`, `CLAUDE_CODE_SKIP_BEDROCK_AUTH` |
| `vertex` | `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION`, `ANTHROPIC_VERTEX_BASE_URL`, `CLAUDE_CODE_SKIP_VERTEX_AUTH` |
| `foundry` | `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_FOUNDRY_BASE_URL`, `ANTHROPIC_FOUNDRY_RESOURCE`, `ANTHROPIC_FOUNDRY_API_KEY` / `ANTHROPIC_FOUNDRY_AUTH_TOKEN`, `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` |
| `anthropicAws` | `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `ANTHROPIC_AWS_WORKSPACE_ID`, `AWS_REGION`, `ANTHROPIC_AWS_BASE_URL`, `ANTHROPIC_AWS_API_KEY`, `CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH` |
| `gateway` | `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN` **or** `ANTHROPIC_API_KEY` |

Any kind may also set `ANTHROPIC_CUSTOM_HEADERS`,
`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, and anything in the profile's `env`
escape hatch — applied last, so an unforeseen variable never needs a release.

`authStyle` is not cosmetic. `ANTHROPIC_AUTH_TOKEN` sends
`Authorization: Bearer`; `ANTHROPIC_API_KEY` sends `x-api-key`. A credential in
the wrong one reaches the gateway in a header it does not read and comes back
`401`, which is the most common way a correct key looks like a wrong key. The
default is bearer, as the documentation advises.

---

## Sources

- [Claude Code environment variables](https://code.claude.com/docs/en/env-vars)
- [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)
- [LLM gateways](https://code.claude.com/docs/en/llm-gateway)
- [Claude Code on Amazon Bedrock](https://code.claude.com/docs/en/amazon-bedrock)
- [Claude Code on Google Cloud's Agent Platform](https://code.claude.com/docs/en/google-vertex-ai)
- [Claude Code on Microsoft Foundry](https://code.claude.com/docs/en/microsoft-foundry)
- [Enterprise deployment overview](https://code.claude.com/docs/en/third-party-integrations)
- [claude-code-router](https://github.com/musistudio/claude-code-router), for the
  non-Claude path
