# Claude Agent SDK — verified notes

Checked against the real type definitions in
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (v0.3.259, 8721 lines).

**The published docs at `code.claude.com/docs/en/agent-sdk/typescript` are wrong
in several places** — they are summarised by a model and some signatures do not
match the shipped types. When they disagree, the `.d.ts` wins. Always grep it:

```bash
grep -n "type CanUseTool" -A 20 node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

---

## Where the docs are wrong

| Thing | Docs say | Actually |
|---|---|---|
| `CanUseTool` | `(request) => Promise<PermissionResult>` | `(toolName, input, options) => Promise<PermissionResult>` — three positional args |
| `PermissionResult` | `{ approved: boolean, reason?: string }` | `{ behavior: 'allow', updatedInput?, updatedPermissions? } \| { behavior: 'deny', message, interrupt? }` |
| `PermissionMode` | 3 values | 6: `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto` |
| `SDKMessage` | `SDKTextMessage \| SDKToolUseMessage \| …` | `SDKAssistantMessage \| SDKUserMessage \| SDKResultMessage \| SDKSystemMessage \| SDKPartialAssistantMessage \| …` (~36 members). Discriminants are `assistant` / `user` / `result` / `system` / `stream_event`, **not** `text` / `tool_use` |

Getting the last one wrong is the expensive mistake: there is no `type: 'text'`
message. Text arrives as `content[]` blocks inside an `assistant` message.

---

## Packaging constraints

**ESM-only.** `"type": "module"`, single `sdk.mjs` entry, no CommonJS build. VS
Code extensions are CommonJS, so it cannot be `require`d.

**It must stay out of the bundle.** It resolves a per-platform native `claude`
binary at runtime; bundling breaks that resolution.

Both are handled in [`src/agent/sdk.ts`](../src/agent/sdk.ts) with a cached
dynamic `import()`. Verified empirically: **esbuild preserves `import()` verbatim
for external packages in CJS output**, so this loads correctly from the bundled
extension.

**`zod` is a peer dependency and must also be external.** Bundling it inline
gives a second zod instance while the SDK resolves its own; the two disagree
during schema conversion. It also cut the bundle 581KB → 148KB.

**Peer requires `zod@^4`**, not v3. `npm install` refuses outright otherwise.

**Do not ship the native binary.** The per-platform package is ~190MB and made
the `.vsix` 87MB. `resolveClaudeExecutable()` finds the installed CLI instead
(setting → PATH → usual locations), keeping it at ~5MB.

---

## Session storage — the API that made the rewrite possible

Claude Code stores every session as JSONL under
`~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`, and the SDK exposes it:

```ts
listSessions({ dir?, limit?, includeWorktrees? }): Promise<SDKSessionInfo[]>
getSessionMessages(id, { dir?, limit?, offset? }): Promise<SessionMessage[]>
getSessionInfo(id, { dir? }): Promise<SDKSessionInfo | undefined>
renameSession(id, title, { dir? }): Promise<void>
tagSession(id, tag: string | null, { dir? }): Promise<void>
deleteSession(id, { dir? }): Promise<void>
```

`SDKSessionInfo`: `sessionId`, `summary`, `lastModified`, `customTitle`,
`firstPrompt`, `gitBranch`, `cwd`, `tag`, `createdAt`, `fileSize`.

Title resolution order: `customTitle` → `summary` → `firstPrompt`.

**`includeWorktrees: true` is essential.** `listSessions({dir})` is keyed on the
working directory, and an agent's worktree is a *different* directory — without
it, every agent session vanishes from the board the moment it starts.

**`tagSession` stores one string.** Not a list. That is why our multi-tag support
lives in the sidecar rather than here.

`SessionMessage.parent_tool_use_id` is set for subagent messages — filter them
out or subagent chatter swamps the main transcript.

---

## In-process MCP tools

```ts
createSdkMcpServer({ name, version?, instructions?, tools?, alwaysLoad?, timeout? })
  → McpSdkServerConfigWithInstance   // { type: 'sdk', name, instance }

tool(name, description, inputSchema, handler, extras?)
```

`inputSchema` is a **raw Zod shape** — `{ id: z.string() }`, not `z.object({…})`.

`alwaysLoad: true` keeps the tools in the turn-1 prompt instead of behind
ToolSearch. Worth it for tools the agent must know it has.

Handlers return `{ content: [{ type: 'text', text }], isError?: boolean }`.
Return `isError: true` rather than throwing — the model sees it and can adapt.

Pass the server as `mcpServers: { board: server }`; tools are then namespaced
`mcp__board__<tool>`.

---

## Options that matter here

```ts
query({ prompt, options })
```

**`prompt` must be an `AsyncIterable<SDKUserMessage>`, never a string.** A bare
string makes the SDK treat it as one-shot and close the child's stdin after the
result, breaking `interrupt()`, permission round-trips and follow-ups.

| Option | Note |
|---|---|
| `cwd` | The worktree. This is what makes parallel agents safe. |
| `model` | Plain model id. |
| `effort` | `'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`. Omit to keep the CLI's own default. |
| `thinking` | `{type:'adaptive'\|'enabled'\|'disabled'}`. **Omit entirely for "on"** — that keeps adaptive. Only send `{type:'disabled'}` to turn it off, and some models reject it. |
| `includePartialMessages` | Required for token-by-token `stream_event`. Without it output arrives one lump per turn. |
| `canUseTool` | Only fires when the permission flow reaches a prompt — not for `allowedTools` matches. |
| `resume` | A session id. `forkSession: true` branches instead of continuing. |
| `permissionMode` | See the six values above. |
| `pathToClaudeCodeExecutable` | Needed when the bundled binary isn't shipped. |

`Query` (the returned generator) also has `interrupt()` and
`setPermissionMode()`, but **only in streaming-input mode** — another reason the
prompt must be an AsyncIterable.

---

## Usage accounting — the trap

Two figures that look alike. Using the wrong one displays 1,500%.

```ts
// Context fill: PER-STEP, from an `assistant` message.
const u = msg.message.usage
const fill = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

// result.usage is CUMULATIVE across every step of the session. Not fill.
// result.modelUsage[model].contextWindow is the denominator.
```

`ModelUsage` carries `contextWindow`, `maxOutputTokens`, `costUSD`,
`inputTokens`, `outputTokens`, `cacheReadInputTokens`,
`cacheCreationInputTokens`, `thinkingTokens`.

On `system` / `compact_boundary` there is no assistant message afterwards, so
reset the meter or it stays pinned at the pre-compaction number.

---

## Message types worth handling

| Type | Discriminant | Use |
|---|---|---|
| `SDKSystemMessage` | `system` / `init` | Capture `session_id` — the only handle for resume. |
| `SDKPartialAssistantMessage` | `stream_event` | `event.delta.text` / `.thinking` for live typing. |
| `SDKAssistantMessage` | `assistant` | `message.content[]` blocks + per-step `usage`. |
| `SDKUserMessage` | `user` | `tool_result` blocks, matched by `tool_use_id`. |
| `SDKCompactBoundaryMessage` | `system` / `compact_boundary` | `compact_metadata.pre_tokens`; reset the meter. |
| `SDKResultMessage` | `result` | `result`, `duration_ms`, `total_cost_usd`, `modelUsage`, `permission_denials`. |

Everything else in the union can be ignored safely.
