# AI SDK 7 / Vercel AI Gateway Integration — Session Handoff

> **Purpose:** This file is the complete context handoff for continuing the AI SDK 7
> integration work in a new session. It is written for an agent with **zero prior
> context** on this task.

---

## 1. Project context

- **Project:** WrongStack — a terminal/TUI/WebUI AI coding agent.
- **Repo root:** `D:\Codebox\PROJECTS\WrongStack`
- **Monorepo:** pnpm workspaces (`packages/*`, `apps/*`, `website`).
- **Package manager:** pnpm 11.x. Node >= 22. TypeScript 7.x, ESM-only.
- **Branch:** `main` (ahead of `origin/main`; work below is **uncommitted**).
- **Lint/format:** Biome. **Tests:** Vitest.

### Relevant existing architecture

WrongStack already had a provider abstraction before this work:

| Concept | Path |
|---|---|
| `Provider` interface (`stream()` / `complete()`) | `packages/core/src/types/provider.ts:278` |
| `ProviderError`, error kinds | `packages/core/src/types/provider.ts:572` |
| `ProviderRegistry` + `ProviderFactory` | `packages/core/src/registry/provider-registry.ts` |
| Provider adapters (Anthropic/OpenAI/Google/…) | `packages/providers/src/` |
| Stream aggregation for `complete()` | `packages/providers/src/aggregate.ts` |
| Catalog-driven factory construction | `packages/providers/src/index.ts` |
| CLI boot wiring | `packages/cli/src/wiring/provider.ts` |
| Runtime switch / fallback wiring | `packages/cli/src/wiring/provider-runtime.ts` |
| Normalized stream consumption | `packages/core/src/core/streaming-response-builder.ts` |

---

## 2. Core architectural decision

**AI SDK 7 was integrated as an additional transport/provider backend — NOT as a
replacement for WrongStack's agent loop.**

WrongStack retains ownership of:

- tool permission checks and tool execution (`ToolExecutor`)
- retry policy and cross-provider fallback
- context compaction
- usage/cost accounting
- session events, observability, TUI/WebUI streaming

The adapter therefore:

1. Performs **one model step only** (no AI SDK agent loop, no `stopWhen` multi-step).
2. Declares AI SDK tools **without `execute`** so AI SDK can never run a tool.
3. Passes `maxRetries: 0` so retry/fallback stays with WrongStack's provider runner.
4. Normalizes AI SDK stream parts, usage, and errors into WrongStack types.

---

## 3. What was implemented

### New files

| File | Purpose |
|---|---|
| `packages/providers/src/ai-gateway.ts` | `AiGatewayProvider` + conversions + `createAiGatewayProviderFactory()` |
| `packages/providers/tests/ai-gateway.test.ts` | Focused unit tests for the adapter |

### Modified files

| File | Change |
|---|---|
| `packages/providers/package.json` | Added dependency `ai: 7.0.50` |
| `pnpm-lock.yaml` | Lockfile update |
| `packages/providers/src/index.ts` | Exports; registers `ai-gateway` factory; `makeProviderFromConfig()` handles `type: "ai-gateway"` |
| `packages/cli/src/wiring/provider.ts` | Registers built-in gateway factory even when models registry is disabled; boot resolves `factoryType` separately from the user-visible provider id |
| `packages/cli/src/wiring/provider-runtime.ts` | Registry-off alias path preserves `type: "ai-gateway"` |
| `packages/cli/src/webui-server.ts` | Credential hot-reload preserves the saved factory type instead of downgrading an alias |
| `packages/cli/tests/wiring-provider.test.ts` | Mock for the new factory + alias boot regression test |
| `packages/cli/tests/wiring-provider-runtime.test.ts` | Registry-off alias regression test |
| `docs/configuration.md` | `ai-gateway` provider config example + explanatory paragraph |

> **Note:** `.env.example` and several unrelated files also appear modified/untracked in
> the working tree from other agents/sessions. **They are out of scope for this task.**

### Version note (important)

- Main package is `ai@7.0.x`; **provider packages use their own major versions**
  (e.g. `@ai-sdk/openai` is 4.x, `@ai-sdk/gateway` is 4.x). Do not look for `@ai-sdk/openai@7`.
- `ai@7.0.52` was rejected by pnpm's `minimumReleaseAge: 1440` supply-chain guard
  (published < 24h prior). **`7.0.50` was pinned instead.** Do not weaken that guard.

---

## 4. Conversion contracts (do not regress)

### Usage — disjoint token accounting

WrongStack requires `input` to exclude cached tokens. Mapping used:

```
input      = usage.inputTokenDetails.noCacheTokens
             ?? max(0, inputTokens - cacheReadTokens - cacheWriteTokens)
cacheRead  = usage.inputTokenDetails.cacheReadTokens
cacheWrite = usage.inputTokenDetails.cacheWriteTokens
output     = usage.outputTokens
```

Assigning `usage.inputTokens` straight into `input` would double-bill cached tokens.

### Messages

- WrongStack compaction emits **system-role history messages**, but AI SDK 7
  `streamText()` rejects system entries inside `messages` by default
  (`allowSystemInMessages` defaults to false). They are converted to
  `role: "user"` with a `[system context]` prefix; the canonical `request.system`
  stays top-level.
- Failed tool results (`is_error`) map to AI SDK `{ type: 'error-text' }`, not `text`.
- `providerMeta` is preserved on tool calls and reasoning (e.g. Gemini `thoughtSignature`,
  Anthropic reasoning signatures).

### Streaming

AI SDK 7 stream parts → WrongStack `StreamEvent`:
`text-start/delta/end`, `reasoning-start/delta/end`, `tool-input-start`,
`tool-input-delta`, `tool-call`, `finish`, `abort`, `error`.

**Verified fact:** in `ai@7.0.50`, `result.stream` is the canonical all-events stream;
`result.fullStream` is a **deprecated alias**. A review claimed the opposite — that claim
was checked against `node_modules/.pnpm/ai@7.0.50_zod@4.4.3/.../dist/index.d.ts` and is
**false**. Do not "fix" this back to `fullStream`.

### Request field forwarding

Forwarded: `maxTokens`→`maxOutputTokens`, `temperature`, `topP`, `topK`,
`frequencyPenalty`, `presencePenalty`, `seed`, `stopSequences`, `toolChoice`,
and `reasoning` (WrongStack effort → AI SDK `'provider-default' | 'none' | 'minimal' |
'low' | 'medium' | 'high' | 'xhigh'`; WrongStack `'max'` maps to `'xhigh'`).

**Not yet mapped:** `Request.responseFormat` (structured output) and `Request.cache`.
Because of this, the adapter deliberately advertises `structuredOutput: false` rather
than claiming a capability it ignores.

### Errors

- `APICallError` → `ProviderError` with `status`, `retryable`, truncated body.
- Aborts are rethrown as-is (never converted into `ProviderError`).
- Missing credentials throw `ConfigError` with `code: 'CONFIG_INVALID'`.
- Model resolution and the `streamText()` invocation are inside the normalization
  boundary, so synchronous SDK failures are classified too.

---

## 5. Configuration surface

`docs/configuration.md` documents:

```jsonc
{
  "providers": {
    "ai-gateway": {
      "type": "ai-gateway",
      "envVars": ["AI_GATEWAY_API_KEY"],
      "model": "anthropic/claude-sonnet-4.6",
      "models": ["anthropic/claude-sonnet-4.6", "openai/gpt-5.4"]
    }
  }
}
```

- Model ids use `provider/model` form.
- Credential resolution order: `apiKeys`/`activeKey` → `apiKey` → `envVars` →
  default `AI_GATEWAY_API_KEY`.
- A stale `activeKey` label falls back to the first key instead of failing.
- Plaintext keys should not be committed to project config.

### `WireFamily` caveat

The factory currently declares `family: 'openai-compatible'` purely as registry routing
metadata — the real wire conversion happens inside `AiGatewayProvider`. A dedicated
`'ai-sdk'` wire family was intentionally **not** added yet, because that type is used in
exhaustive switches across core, CLI, TUI, WebUI, and the website data files.

---

## 6. Verification status

### Passed (executed in this session)

- `pnpm --filter @wrongstack/providers typecheck` — 0 errors
- `pnpm --filter @wrongstack/cli typecheck` — 0 errors
- `pnpm exec vitest run packages/providers/tests` — all green
- `pnpm exec vitest run packages/cli/tests/wiring-provider.test.ts packages/cli/tests/wiring-provider-runtime.test.ts` — green
- Biome lint on all touched files — 0 errors / 0 warnings
- `pnpm --filter @wrongstack/providers build` — succeeded
- `pnpm audit` (high) — 0 vulnerabilities

### NOT verified

- **No live AI Gateway API call has ever been made.** Text, tool-call, and reasoning
  behavior against the real service is unproven. All adapter tests use test doubles
  plus the real installed AI SDK types/runtime.

---

## 7. Issues found by review and already fixed

| Issue | Resolution |
|---|---|
| Boot failed with `modelsRegistry` disabled | Gateway factory registered independently of the catalog; `makeProviderFromConfig()` understands `type: "ai-gateway"` |
| Startup vs. switch/fallback resolved providers differently | Both now resolve `factoryType` separately from the user-visible id |
| Alias lost its provider id | Factory now preserves `cfg.type` |
| `reasoning` and several generation params silently dropped | Forwarded to `streamText()` |
| Missing key threw a plain `Error` | Now a structured `ConfigError` |
| WebUI credential hot-reload downgraded an alias | Saved factory type preserved |
| System-role history rejected by AI SDK 7 | Converted to user context markers |
| Failed tool results looked successful to the model | Mapped to `error-text` |
| `structuredOutput` advertised but unimplemented | Capability set to `false` |

---

## 8. Remaining open items (deferred)

Both remaining items are blocked on the same prerequisite.

### Item 1 — Live smoke run (blocked)

Run three live calls through the AI Gateway provider and record results:

1. plain text completion
2. a **required** tool call (verify WrongStack executes it, not AI SDK)
3. a reasoning-enabled request (verify reasoning stream parts arrive)

**Blocker:** `AI_GATEWAY_API_KEY` is not present in the running WrongStack process
(`process.env.AI_GATEWAY_API_KEY` is empty).

Findings about the key:

- A `.env` file exists at repo root, is **git-ignored** (`.gitignore:35`) and untracked,
  and **does contain** an `AI_GATEWAY_API_KEY` line with a non-empty 60-character value.
- WrongStack does **not** auto-load that `.env` for provider credentials, and the running
  process was started without the variable.
- The user explicitly **descoped** "load the key from `.env`" for now — do not implement
  `.env` loading unless newly asked.

To unblock, WrongStack must be restarted from a shell that already exports the variable:

```powershell
$env:AI_GATEWAY_API_KEY = "<key>"
wrongstack
```

### Item 2 — Verify smoke results and clean up (blocked, depends on Item 1)

No live results exist to verify yet, and **no temporary artifacts were created**
(`.temp_files/` has nothing for this task). Any future helper scripts must live under
`<repo-root>/.temp_files/` and only task-created files may be deleted.

---

## 9. Security notice — action required

An `AI_GATEWAY_API_KEY` value was pasted directly into the chat during this session and
must be treated as **leaked**. It was deliberately never written to any file, command,
or tool argument.

**Recommended:** revoke that key in the Vercel dashboard and issue a replacement. The
60-character value currently in the local `.env` matches that leaked key's length, so it
is likely the same credential.

Never paste the key into chat; pass it via the environment instead.

---

## 10. Suggested next steps

1. Provide the key via the environment, restart, then run the three live smoke calls.
2. Verify live results (stream ordering, usage disjointness, tool-call ownership,
   reasoning parts) and clean up any smoke artifacts.
3. Optional follow-up: map `Request.responseFormat` to AI SDK 7's `output` API and flip
   `structuredOutput` to `true` with tests.
4. Optional follow-up: introduce a dedicated `'ai-sdk'` `WireFamily` across core/CLI/
   TUI/WebUI/website instead of the current `openai-compatible` routing metadata.
5. Commit the AI Gateway work as its own conventional commit, excluding the unrelated
   working-tree changes from other sessions.
