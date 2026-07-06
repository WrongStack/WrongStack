# @wrongstack/providers

LLM provider adapters for WrongStack: Anthropic, OpenAI, Google, OpenAI-compatible (Mistral, DeepSeek, xAI/Grok, Groq, Together, Fireworks, OpenRouter, …), plus OAuth-based variants (Claude Pro/Max via "Sign in with Claude", ChatGPT via "Sign in with ChatGPT", GitHub Copilot).

All providers ride a single declarative `WireFormatConfig` adapter — even the majors (Anthropic / OpenAI / Google) are thin wrappers around their presets. Adding a new OpenAI-compatible provider is usually a 20-line preset, not a new file.

## Install

```bash
pnpm add @wrongstack/providers @wrongstack/core
```

`@wrongstack/core` provides the shared `Provider` interface, message types, capabilities model, and tool format.

## Supported wire families

| Family | Class | Preset | Used by |
|--------|-------|--------|---------|
| `anthropic` | `AnthropicProvider` | `anthropicWireFormat` | Claude API key |
| `anthropic-oauth` | `AnthropicOAuthProvider` | `anthropicWireFormat` | Claude Pro/Max (OAuth) |
| `openai` | `OpenAIProvider` | `openaiWireFormat` | OpenAI API key |
| `openai-codex` | `OpenAICodexProvider` | — | ChatGPT (Responses API, OAuth) |
| `github-copilot` | `GitHubCopilotProvider` | — | GitHub Copilot (OAuth) |
| `openai-compatible` | `OpenAICompatibleProvider` | generic | Any `/v1/chat/completions` endpoint |
| `google` | `GoogleProvider` | `googleWireFormat` | Gemini API key |

### Tuned presets (auto-registered for matching provider ids)

| Preset | Family | Base URL | Notes |
|--------|--------|----------|-------|
| `mistralWireFormat` | openai-compatible | `https://api.mistral.ai/v1` | JSON mode, 128K context |
| `ollamaWireFormat` | openai-compatible | `http://localhost:11434/v1` | No auth, keep-alive |
| `vllmWireFormat` | openai-compatible | `http://localhost:8000/v1` | 32K context |
| `lmstudioWireFormat` | openai-compatible | `http://localhost:1234/v1` | 8K context |

## What's in here

```
src/
  anthropic.ts             thin WireFormatProvider wrapper (anthropic preset)
  openai.ts                thin WireFormatProvider wrapper (openai preset)
  google.ts                thin WireFormatProvider wrapper (google preset)
  openai-compatible.ts     generic /v1/chat/completions adapter
  anthropic-oauth.ts       Claude Pro/Max OAuth (same wire as anthropic)
  openai-codex.ts          ChatGPT Responses API (OAuth)
  github-copilot.ts        GitHub Copilot (OAuth)
  wire-adapter.ts          base HTTP + SSE streaming for all providers
  wire-format.ts           declarative WireFormatConfig → WireFormatProvider
  presets/                 tuned configs for anthropic / openai / google / mistral / local-llm
  capabilities.ts          resolve capabilities for (provider, model) pairs
  family-capabilities.ts   per-family capability defaults
  sse.ts                   SSE parser with 256 KB buffer cap
  aggregate.ts             tool_use stream-event aggregator
  tool-format/             tools ↔ Anthropic / OpenAI / Responses converters
  stop-reason.ts           normalize provider stop_reason → canonical
  error-parse.ts           parse provider HTTP error envelopes
  index.ts                 factory builder + preset registration
```

## Request parameters

Every provider accepts the canonical `Request` type from `@wrongstack/core`. Parameters not supported by a provider are silently ignored at the wire level:

| Parameter | Anthropic | OpenAI | Gemini | Compatible |
|-----------|-----------|--------|--------|------------|
| `model` | ✅ | ✅ | ✅ | ✅ |
| `messages` | ✅ | ✅ | ✅ | ✅ |
| `maxTokens` | ✅ `max_tokens` | ✅ `max_completion_tokens` | ✅ `maxOutputTokens` | ✅ `max_tokens` |
| `temperature` | ✅ `temperature` | ✅ `temperature` | ✅ `temperature` | ✅ `temperature` |
| `topP` | ✅ `top_p` | ✅ `top_p` | ✅ `topP` | ✅ `top_p` |
| `topK` | ✅ `top_k` | ❌ | ✅ `topK` | ✅ `top_k` |
| `frequencyPenalty` | ❌ | ✅ `frequency_penalty` | ✅ `frequencyPenalty` | ✅ `frequency_penalty` |
| `presencePenalty` | ❌ | ✅ `presence_penalty` | ✅ `presencePenalty` | ✅ `presence_penalty` |
| `seed` | ❌ | ✅ `seed` | ✅ `seed` | ✅ `seed` |
| `stopSequences` | ✅ `stop_sequences` | ✅ `stop` | ✅ `stopSequences` | ✅ `stop` |
| `toolChoice` | ✅ | ✅ | ✅ | ✅ |
| `user` | ✅ (metadata.user_id) | ✅ `user` | ❌ | ✅ `user` |
| `logprobs` | ❌ | ✅ `logprobs` + `top_logprobs` | ✅ `logprobs` | ✅ `logprobs` |
| `reasoning` | ✅ `thinking` | ✅ `reasoning_effort` | ✅ `thinkingConfig` | via quirks |
| `responseFormat` | ❌ | ✅ `response_format` | ✅ `responseMimeType`+`responseSchema` | ❌ |
| `cache` | ✅ `cache_control` | ❌ | ❌ | ❌ |
| `safetySettings` | ❌ | ❌ | ✅ `safetySettings` array | ❌ |
| `candidateCount` | ❌ | ❌ | ✅ `candidateCount` | ❌ |

## Quick example

```ts
import { AnthropicProvider } from '@wrongstack/providers';

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
});

const stream = provider.stream(
  {
    model: 'anthropic-test-model',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 512,
    temperature: 0.7,
    topK: 40,
    user: 'user-abc',
    reasoning: { enabled: true, effort: 'high' },
  },
  { signal: new AbortController().signal },
);

for await (const event of stream) {
  if (event.type === 'text_delta') process.stdout.write(event.text);
}
```

## Using a preset (OpenAI-compatible service)

Presets are automatically used when the models.dev registry returns a matching provider id. You can also use them directly:

```ts
import { createWireFormatFactory, mistralWireFormat } from '@wrongstack/providers';

// Build a factory from the Mistral preset
const factory = createWireFormatFactory(mistralWireFormat, {
  apiKey: process.env.MISTRAL_API_KEY!,
});
const provider = factory.create({ apiKey: process.env.MISTRAL_API_KEY! });

const result = await provider.complete(
  {
    model: 'mistral-large-2506',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 512,
    seed: 42,
    responseFormat: { type: 'json_object' },
  },
  { signal: new AbortController().signal },
);
```

## Wire-format adapter (declarative)

For a new provider that doesn't fit one of the existing presets, write a `WireFormatConfig` and plug it into `WireFormatProvider`. See [docs/provider-author-guide.md](../../docs/provider-author-guide.md) for the full spec.

```ts
import { WireFormatProvider, type WireFormatConfig, defineWireFormat } from '@wrongstack/providers';

const myWire = defineWireFormat({
  id: 'myprovider',
  family: 'openai-compatible',
  capabilities: { tools: true, parallelTools: true, vision: false, streaming: true, promptCache: false, systemPrompt: true, jsonMode: false, maxContext: 32_000, cacheControl: 'none' },
  defaultBaseUrl: 'https://api.myprovider.com/v1',
  buildUrl: (baseUrl) => `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
  buildHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  buildBody: (req) => ({ model: req.model, messages: req.messages, max_tokens: req.maxTokens, stream: true }),
  createStreamState: (fallbackModel) => ({ model: fallbackModel, started: false }),
  parseStreamEvent: () => [],
  finalizeStream: () => [{ type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } }],
});

const provider = new WireFormatProvider(myWire, { apiKey: '…' });
```

## Capabilities model

Each provider family has a baseline capability profile in `CAPABILITIES_BY_FAMILY`. Per-model overrides from the [models.dev](https://models.dev) catalog are AND-ed with the family baseline. The agent uses capabilities to gate vision, reasoning, tool-use, and parameter support.

### Capability flags

| Flag | anthropic | openai | google | compatible |
|------|-----------|--------|--------|------------|
| `tools` / `parallelTools` | ✅ | ✅ | ✅ | ✅ |
| `vision` | ✅ | ✅ | ✅ | ❌ |
| `streaming` | ✅ | ✅ | ✅ | ✅ |
| `systemPrompt` | ✅ | ✅ | ✅ | ✅ |
| `promptCache` | ✅ (native) | ❌ | ❌ | ❌ |
| `jsonMode` | ❌ | ✅ | ✅ | ❌ |
| `reasoning` | ❌ (via thinking) | ✅ | via thinkingConfig | via quirks |
| `topK` | ✅ | ❌ | ✅ | ❌ |
| `frequencyPenalty` | ❌ | ✅ | ✅ | ❌ |
| `presencePenalty` | ❌ | ✅ | ✅ | ❌ |
| `seed` | ❌ | ✅ | ✅ | ❌ |
| `structuredOutput` | ❌ | ✅ | ✅ | ❌ |
| `logprobs` | ❌ | ✅ | ✅ | ❌ |
| `audio` | ❌ | ✅ (gpt-audio-*) | ❌ | ❌ |

User-defined model overrides via `CustomModelDefinition.capabilities` skip the AND gate and take full effect.

## Thinking / reasoning

Extended thinking (chain-of-thought) is managed through the `Request.reasoning` field and works across providers:

- **Anthropic**: `reasoning.enabled` → `thinking: { type: "enabled", budget_tokens }`. The budget is derived automatically from `maxTokens` and `reasoning.effort`. Thinking is streamed as `thinking_start`, `thinking_delta`, `thinking_signature`, and `thinking_stop` events. The signature must be echoed back on the next request — the stream parser handles this automatically.

- **OpenAI** (o-series models): `reasoning.effort` → `reasoning_effort: "low"|"medium"|"high"`. Values `minimal`, `xhigh`, and `max` are filtered to avoid provider 400s. Reasoning content from the response (`delta.reasoning_content`) is echoed back as `message.reasoning_content` on subsequent turns.

- **Gemini**: `reasoning.enabled` → `generationConfig.thinkingConfig: { type: "enabled"|"disabled" }`.

- **OpenAI-compatible**: The `thinkingParam` quirk controls how reasoning is mapped — `'zai-glm'` (ZAI reasoning), `'kimi-toggle'` (Kimi thinking mode), or `'always-on'` (models that always think and reject disable). See `CompatibilityQuirks`.

## Structured output

Set `Request.responseFormat` to constrain the model's output:

```ts
// JSON Schema (OpenAI, Gemini)
{
  type: 'json_schema',
  jsonSchema: {
    name: 'person',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' }
      },
      required: ['name', 'age']
    }
  }
}

// Free-form JSON (OpenAI, Gemini)
{ type: 'json_object' }

// Plain text (default)
{ type: 'text' }
```

- **OpenAI** → `response_format` with `json_schema` or `json_object` type
- **Gemini** → `responseMimeType: "application/json"` + `responseSchema` (when json_schema)

## Safety settings

Gemini supports per-category safety thresholds via `Request.safetySettings`:

```ts
{
  safetySettings: [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_LOW_AND_ABOVE' },
  ],
}
```

Supported categories: `HARM_CATEGORY_HARASSMENT`, `HARM_CATEGORY_HATE_SPEECH`, `HARM_CATEGORY_SEXUALLY_EXPLICIT`, `HARM_CATEGORY_DANGEROUS_CONTENT`.

Thresholds: `BLOCK_NONE`, `BLOCK_ONLY_HIGH`, `BLOCK_MEDIUM_AND_ABOVE`, `BLOCK_LOW_AND_ABOVE`.

## Structured error responses

Every provider HTTP error is normalized through `parseProviderHttpError()` into a `ProviderError` with:
- `status` — HTTP status code
- `providerId` — which provider returned the error
- `retryable` — whether the agent loop should retry (true for 429/5xx)
- `describe()` — one-line human-readable description for the CLI/TUI status line

## Tool input parsing (`parseToolInput`)

All providers run tool-call JSON through [`_tool-input.ts`](src/_tool-input.ts). It guarantees the agent always receives a `Record<string, unknown>` for `tool_use.input`, never a parse-error or `null`. Invalid or non-object inputs are wrapped under `{ __raw: ... }` instead of crashing the provider runner.

## Local LLM presets

Presets for Ollama, vLLM, and LM Studio are tuned for local servers:

```ts
import { ollamaWireFormat } from '@wrongstack/providers';
import { WireFormatProvider } from '@wrongstack/providers';

const ollama = new WireFormatProvider(ollamaWireFormat, {
  apiKey: '',  // Ollama doesn't use auth
  baseUrl: 'http://localhost:11434/v1',
});
```

The `createLocalLlmPreset()` factory lets you create custom local presets with `bodyExtras` for provider-specific fields (e.g., Ollama's `keep_alive`, vLLM's `repetition_penalty`).

## OAuth providers

Three providers use OAuth token refresh patterns:

- **AnthropicOAuthProvider** — Claude Pro/Max "Sign in with Claude". Same wire as the API-key Anthropic family but with `Authorization: Bearer` and Claude Code identity headers. Tokens self-refresh near-expiry and on 401.

- **OpenAICodexProvider** — ChatGPT "Sign in with ChatGPT" (Responses API). Uses the OpenAI Responses wire format (not chat/completions). Reasoning effort is configurable via `reasoningEffort`.

- **GitHubCopilotProvider** — GitHub Copilot subscription. Wraps the OpenAI-compatible chat endpoint with Copilot editor headers and token-based URL discovery.

All three persist refreshed tokens through the `setOAuthTokenPersister` hook so new tokens survive session restarts.

## License

MIT
