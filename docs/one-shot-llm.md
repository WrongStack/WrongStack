# One-Shot LLM (`llm` tool)

A general-purpose, stateless utility for making single LLM calls with provider
resolution, fallback chains, timeout control, and structured results.

## Quick Start

```ts
// The `llm` tool is registered in the ToolRegistry at startup.
// Any agent can call it directly:

llm({
  system: "You are a concise summarizer.",
  userPrompt: "Summarize this conversation: ...",
  model: "deepseek-chat",
})
// → { text: "...", model: "deepseek-chat", provider: "deepseek",
//     tokens: { input: 100, output: 50 }, fromFallback: false }
```

## When to Use

The `llm` tool is for **one-shot, stateless LLM calls** — give it a system prompt
and content, get a response back. Use it when you need:

- **Summarization** — compact conversation history, meeting notes, code diffs.
- **Classification** — categorize text, detect intent, route by topic.
- **Extraction** — pull structured data (JSON, entities, decisions) from free text.
- **Transformation** — translate, rewrite, format-convert with a system prompt.
- **Any single-turn task** where you don't need conversation state.

Do **NOT** use it for multi-turn conversations, tool calling, or streaming —
those are handled by the main agent loop.

## Architecture

```
Agent / Middleware / Tool
         │
         ▼
   ┌─────────────────────────────┐
   │      llm tool               │  ← ToolRegistry'daki "llm"
   │  createOneShotLLMTool()     │
   └──────────┬──────────────────┘
              │
   ┌──────────▼──────────────────┐
   │   OneShotOrchestrator       │  ← execution/one-shot-llm.ts
   │                             │
   │  1. resolveTarget()         │  → provider + model seçimi
   │  2. buildRequest()          │  → Request oluştur
   │  3. resolveSignal()         │  → AbortSignal (timeout)
   │  4. resolveFallbackChain()  │  → fallback listesi
   │  5. tryCall()               │  → provider.complete()
   │     ↻ fallback?             │  → sonraki provider'a dene
   │  6. return result           │  → { text, model, tokens, ... }
   └─────────────────────────────┘
              │
   ┌──────────▼──────────────────┐
   │   Provider (Anthropic,      │
   │   OpenAI, DeepSeek, ...)    │
   └─────────────────────────────┘
```

### Internal Consumers

The same `OneShotOrchestrator` powers three internal paths alongside the tool:

| Consumer | Purpose | Default Model |
|----------|---------|---------------|
| **IntelligentCompactor** | Summarize ancient turns during compaction | `deepseek-chat` |
| **MemoryConsolidator** | Extract facts from completed sessions | `deepseek-chat` |
| **context_manager summary** | User-requested summary of message range | via the `llm` tool |

## Tool Reference

### Input

```ts
llm({
  // ── Content ──────────────────────────────────
  system: string,              // System prompt
  userPrompt?: string,         // Single user message (shorthand)

  // ── Provider & model ─────────────────────────
  model?: string,              // "deepseek-chat", "gpt-4o-mini", etc.
  providerId?: string,         // "deepseek", "anthropic", "openai"
  role?: string,               // Roster role for model-matrix routing

  // ── Fallback ─────────────────────────────────
  fallbackProfile?: string,    // Named profile from config.fallbackProfiles
  fallbackModels?: string[],   // Explicit: ["anthropic/claude-haiku", ...]

  // ── Output controls ──────────────────────────
  maxTokens?: number,          // Default: 1024
  temperature?: number,        // Provider default when omitted

  // ── Lifecycle ────────────────────────────────
  timeoutMs?: number,          // Default: 30_000 (30s)
})
```

### Output

```ts
{
  text: string,                // Response text (empty on failure)
  model: string,               // Model that served the request
  provider: string,            // Provider that served the request
  tokens: {
    input: number,
    output: number,
    total: number,
  },
  durationMs: number,          // Wall-clock time
  fromFallback: boolean,       // True if a fallback provider was used
  stopReason?: string,         // "end_turn", "max_tokens", etc.
  error?: string,              // Error message on total failure
}
```

### Error Handling

The tool **never throws** — it always returns a structured result with an
`error` field on failure:

```ts
const result = await llm.execute(input, ctx, opts);
if (result.error) {
  console.warn(`LLM call failed: ${result.error}`);
  // result.text is empty, result.tokens are zero
} else {
  console.log(result.text);
}
```

Error cases:

| Condition | `result.error` content |
|-----------|----------------------|
| No `model` + no `providerId` + no defaults | "provide model and providerId or configure defaults" |
| `buildProvider` fails | "Provider not available: ..." |
| All providers exhausted (including fallbacks) | Last error from the chain |
| Timeout exceeded | AbortError message |
| Provider returns empty response | "(empty response)" as `result.text`, no error |

## Provider & Model Resolution

Priority (highest to lowest):

1. **`role`** — Model matrix routing via `ModelRouter.pickForTask()`.
2. **Explicit `providerId` + `model`** — Used as-is.
3. **Tool defaults** — `defaultProvider`/`defaultModel` from `createOneShotLLMTool()`.
4. **Config fallback** — Unavailable; returns an error (see below).

### Default Behaviour

The tool **does not** silently fall back to the session's provider/model.
This is intentional — an agent calling `llm()` must explicitly know which
model it wants. If you want session-level defaults:

```ts
// When creating the tool at boot:
createOneShotLLMTool({
  buildProvider,
  getConfig: () => config,
  defaultProvider: config.provider,  // session default
  defaultModel: config.model,        // session default
})
```

## Fallback Chain

### Explicit Fallback Models

```ts
llm({
  system: "...",
  userPrompt: "...",
  model: "deepseek-chat",
  fallbackModels: [
    "deepseek/deepseek-chat",
    "anthropic/claude-3-haiku",
    "openai/gpt-4o-mini",
  ],
})
```

When the primary provider returns a transient error (rate limit, overloaded,
timeout, network failure), the orchestrator tries each fallback in order.
The first successful response is returned with `fromFallback: true`.

### Named Fallback Profiles

```ts
// In config:
{
  "fallbackProfiles": {
    "summary": ["deepseek-chat", "claude-haiku"],
    "code": ["gpt-4o-mini", "claude-haiku"]
  }
}

// In code:
llm({ system: "...", userPrompt: "...", fallbackProfile: "summary" })
```

### Non-Transient Errors

Errors that would fail identically on any provider (auth, invalid request,
content filter) **skip the fallback chain entirely** and return immediately.

## Timeout

Default timeout is **30 seconds**. Override per call:

```ts
llm({
  system: "...",
  userPrompt: "...",
  timeoutMs: 60_000,  // 1 minute
})
```

The timeout uses `AbortSignal.timeout()`. If both an external `AbortSignal`
and a timeout are provided, the sooner of the two wins.

## Programmatic Usage (Node.js API)

For internal code that needs one-shot LLM calls without going through
the tool system:

```ts
import { OneShotOrchestrator } from '@wrongstack/core';

const oneShot = new OneShotOrchestrator({
  buildProvider: myBuildProvider,
  getConfig: () => myConfig,
  modelRouter,   // optional
  logger,        // optional
});

const result = await oneShot.call({
  system: 'You are a helpful assistant.',
  userPrompt: 'What is the capital of France?',
  model: 'deepseek-chat',
  maxTokens: 500,
});
console.log(result.text); // "Paris"
```

## Testing

The OneShotOrchestrator has **12 unit tests** covering:

- Basic completion and token counting
- Provider resolution (explicit, config defaults, role-based)
- Fallback chain activation on transient errors
- No fallback on non-transient (auth) errors
- Fallback exhaustion (all fail → last error)
- Named fallback profiles
- Timeout via AbortSignal
- Error message preservation on transient failures without fallback

The `llm` tool wrapper has **4 unit tests** covering:

- Correct tool name and registration
- Error on missing model/provider without defaults
- Successful response with explicit model/providerId
- Default provider/model application

## Implementation Files

| File | Description |
|------|-------------|
| `packages/core/src/types/one-shot-llm.ts` | `OneShotLLMInput`, `OneShotLLMResult`, `OneShotOrchestratorOptions` types |
| `packages/core/src/execution/one-shot-llm.ts` | `OneShotOrchestrator` class — core provider resolution + fallback + completion |
| `packages/core/src/tools/one-shot-llm-tool.ts` | `createOneShotLLMTool()` factory — wraps orchestrator as a registered tool |
| `packages/core/tests/execution/one-shot-llm.test.ts` | 12 orchestrator tests |
| `packages/core/tests/tools/one-shot-llm-tool.test.ts` | 4 tool wrapper tests |
| `packages/cli/src/cli-main.ts` | Runtime registration with `buildProviderForId` |
| `packages/core/src/index.ts` | Public API exports |
