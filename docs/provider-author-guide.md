# Provider Author Guide

How to add a new LLM provider to WrongStack. Two paths:

1. **Declarative** via `WireFormatConfig` — when the provider speaks
   HTTP+SSE and the wire format fits the shared template. This is what
   Anthropic, OpenAI, Google, and every `openai-compatible` provider use.
2. **Imperative** by subclassing `WireAdapter` — only when the transport
   doesn't fit (non-SSE streams, multipart bodies, custom OAuth flows).

Always prefer the declarative path. The imperative escape hatch exists,
but it's costly.

---

## Declarative path: `WireFormatConfig`

A `WireFormatConfig<S>` is a plain object that captures the bits that
actually vary between providers. The boilerplate — HTTP errors, abort
wiring, SSE parsing — is shared by `WireFormatProvider`.

### The shape

```ts
import type { StreamEvent } from '@wrongstack/contracts/types';
import type { WireFormatConfig } from '@wrongstack/providers';

const config: WireFormatConfig<MyStreamState> = {
  id: 'my-llm',
  family: 'openai-compatible',
  capabilities: { /* see below */ },
  defaultBaseUrl: 'https://api.my-llm.com/v1',

  buildUrl(base, req) {
    return `${base}/chat/completions`;
  },

  buildHeaders(apiKey, req) {
    return { authorization: `Bearer ${apiKey}` };
  },

  buildBody(req) {
    return {
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      stream: true,
    };
  },

  createStreamState(fallbackModel) {
    return { model: fallbackModel, accumulated: '', started: false };
  },

  parseStreamEvent(msg, state) {
    if (!msg.data || msg.data === '[DONE]') return [];
    const json = JSON.parse(msg.data);
    const out: StreamEvent[] = [];
    if (!state.started) {
      state.started = true;
      out.push({ type: 'message_start', model: state.model });
    }
    const delta = json.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') {
      state.accumulated += delta;
      out.push({ type: 'text_delta', text: delta });
    }
    return out;
  },

  finalizeStream(state) {
    return state.started
      ? [{ type: 'message_stop', stopReason: 'end_turn', usage: { input: 0, output: 0 } }]
      : [];
  },
};
```

### `capabilities`

Tell the rest of the system what the provider can do:

```ts
capabilities: {
  tools: true,           // model supports function calling
  parallelTools: true,   // can return multiple tool_use blocks per turn
  vision: true,          // can accept image content blocks
  streaming: true,       // emits SSE deltas (almost always true)
  promptCache: false,    // supports prompt-caching headers (Anthropic-only currently)
  systemPrompt: true,    // accepts a system role separate from messages
  jsonMode: true,        // supports response_format=json_object
  maxContext: 128_000,   // model context window in tokens
  cacheControl: 'none',  // 'native' | 'auto' | 'none'
}
```

The CLI surfaces these in `wstack providers` and the agent uses them to
gate request shape (e.g. `cacheControl: 'none'` strips
`cache_control` from outgoing blocks).

### Stream state `S`

The `S` type parameter is provider-internal state threaded across SSE
events for one stream. Use it to:

- Accumulate partial tool-call JSON (OpenAI sends function args as a
  string that arrives one chunk at a time)
- Track current block kind (`text` vs `tool_use`) so a `*_delta` event
  knows which it's appending to
- Carry the model id forward from `message_start` so `usage` events have it
- Preserve `thoughtSignature` (Google) or vendor-specific fields

A fresh `S` is created per `stream()` call via `createStreamState`. Don't
share state across streams.

---

## Registering the provider

Wrap the config in a factory and register it:

```ts
import type { ProviderFactory } from '@wrongstack/core/registry';
import { WireFormatProvider } from '@wrongstack/providers';
import { myLlmConfig } from './my-llm-config.js';

export const myLlmFactory: ProviderFactory = {
  type: 'my-llm',
  family: 'openai-compatible',
  create: (cfg: any) =>
    new WireFormatProvider(myLlmConfig, {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
    }),
};
```

From a plugin:

```ts
// in plugin.setup(api)
api.providers.register(myLlmFactory);
```

User config picks the provider up via `providers.my-llm` in
the active `~/.wrongstack/profiles/<name>/config.json`:

```json
{
  "provider": "my-llm",
  "model": "my-llm-large",
  "providers": {
    "my-llm": {
      "apiKey": "sk-...",
      "baseUrl": "https://api.my-llm.com/v1"
    }
  }
}
```

(The apiKey is encrypted at rest by the secret vault on first read.)

---

## Walk-throughs

### A pure OpenAI-compatible endpoint (Together, Groq, OpenRouter, …)

If the upstream truly speaks OpenAI Chat Completions, you usually don't
need a new factory at all — set `family: 'openai-compatible'` and
`baseUrl` in the user's config:

```json
{
  "provider": "openai-compatible",
  "model": "meta-llama/Llama-3-70b",
  "providers": {
    "openai-compatible": {
      "apiKey": "sk-...",
      "baseUrl": "https://api.together.xyz/v1"
    }
  }
}
```

The shipped `openai-compatible` preset handles it. Reach for a custom
preset only when the wire format diverges (different tool-call shape,
non-standard streaming events, …).

### A vendor with quirks (e.g. tool-call accumulation)

OpenAI streams `function.arguments` as a string fragmented across many
SSE events. The state struct is where you reassemble it:

```ts
interface OpenAIStreamState {
  model: string;
  started: boolean;
  toolCalls: Map<
    number,
    {
      id?: string;
      name?: string;
      args: string;
      emittedStart: boolean;
      emittedArgLength: number;
    }
  >;
}

createStreamState(fallbackModel) {
  return { model: fallbackModel, started: false, toolCalls: new Map() };
},

parseStreamEvent(msg, state) {
  if (!msg.data || msg.data === '[DONE]') return [];
  const json = JSON.parse(msg.data);
  const out: StreamEvent[] = [];
  if (!state.started) {
    state.started = true;
    out.push({ type: 'message_start', model: state.model });
  }
  const delta = json.choices?.[0]?.delta;
  if (delta?.tool_calls) {
    for (const tc of delta.tool_calls) {
      const slot = state.toolCalls.get(tc.index) ?? {
        id: undefined,
        name: undefined,
        args: '',
        emittedStart: false,
        emittedArgLength: 0,
      };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name = tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
      state.toolCalls.set(tc.index, slot);
      if (!slot.emittedStart && slot.id && slot.name) {
        slot.emittedStart = true;
        out.push({ type: 'tool_use_start', id: slot.id, name: slot.name });
      }
      if (slot.emittedStart && slot.id && slot.emittedArgLength < slot.args.length) {
        const partial = slot.args.slice(slot.emittedArgLength);
        slot.emittedArgLength = slot.args.length;
        out.push({ type: 'tool_use_input_delta', id: slot.id, partial });
      }
    }
  }
  return out;
},

finalizeStream(state) {
  // Flush completed tool_use blocks with parsed arguments.
  const events: StreamEvent[] = [];
  for (const [_idx, tc] of state.toolCalls) {
    if (!tc.id || !tc.name) continue;
    if (!tc.emittedStart) {
      events.push({ type: 'tool_use_start', id: tc.id, name: tc.name });
    }
    events.push({ type: 'tool_use_stop', id: tc.id, input: parseToolArgs(tc.args) });
  }
  if (state.started) {
    events.push({ type: 'message_stop', stopReason: 'tool_use', usage: { input: 0, output: 0 } });
  }
  return events;
},

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { __raw: value };
  } catch {
    return { __raw: raw };
  }
}
```

The full implementations live in
[`packages/providers/src/openai.ts`](../packages/providers/src/openai.ts)
and [`anthropic.ts`](../packages/providers/src/anthropic.ts) — read them
side-by-side to see how the same template handles two very different
SSE protocols.

---

## Stop-reason mapping

Each provider emits a stop reason in its own vocabulary
(`stop`/`length`/`tool_calls` vs `end_turn`/`max_tokens`/`tool_use`).
The agent works in the Anthropic-style canonical set: `end_turn`,
`max_tokens`, `tool_use`, `stop_sequence`. Map vendor-specific reasons
in `parseStreamEvent` or `finalizeStream`:

```ts
const STOP_MAP: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
};
```

There's a shared helper in
[`packages/providers/src/stop-reason.ts`](../packages/providers/src/stop-reason.ts) —
prefer extending that rather than inlining a map.

---

## Errors

`WireFormatProvider` handles HTTP errors via
[`error-parse.ts`](../packages/providers/src/error-parse.ts) by default:

- 4xx → `ProviderError` with `status` and parsed body
- 429 → `ProviderError` with `retryable: true`
- 5xx → `ProviderError` with `retryable: true` so the retry policy kicks in

Override only when the vendor returns errors in a non-standard envelope:

```ts
import { ProviderError } from '@wrongstack/contracts/types';

normalizeError(status, body) {
  const j = JSON.parse(body);
  return new ProviderError(
    j.error?.message ?? body,
    status,
    status === 429 || status >= 500,
    'my-llm',
    {
      body: {
        type: j.error?.code,
        message: j.error?.message,
      },
    },
  );
}
```

---

## Testing

Provider tests should use inline or checked-in SSE fixtures. Don't make
live API calls in tests:

```ts
import { describe, expect, it, vi } from 'vitest';
import { WireFormatProvider } from '@wrongstack/providers';
import { myLlmConfig } from '../src/my-llm-config.js';

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('my-llm', () => {
  it('parses streaming text deltas', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(streamFromText('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const p = new WireFormatProvider(myLlmConfig, { apiKey: 'fake', fetchImpl });
    const events = [];
    for await (const e of p.stream(
      { model: 'my-model', messages: [], maxTokens: 100 },
      { signal: new AbortController().signal },
    )) {
      events.push(e);
    }
    expect(events.filter((e) => e.type === 'text_delta').length).toBeGreaterThan(0);
  });
});
```

Keep tests deterministic: use inline or checked-in SSE fixtures and never
make live API calls.

---

## When you genuinely need to subclass `WireAdapter`

Cases where the declarative config can't represent the protocol:

- Non-SSE streams (NDJSON, raw chunked text, custom framing)
- Multipart request bodies (file uploads)
- Multi-step auth (OAuth refresh, exchange-token-for-session)
- WebSocket streams (vendor sends realtime audio/video deltas)

In those cases, extend `WireAdapter` directly and override `stream` /
`complete`. The shared HTTP+abort+error machinery still helps; you're
only overriding the parts that don't fit.

---

## Reference

- `WireFormatConfig`: [`packages/providers/src/wire-format.ts`](../packages/providers/src/wire-format.ts)
- Capabilities: [`packages/providers/src/capabilities.ts`](../packages/providers/src/capabilities.ts)
- Three reference implementations:
  [anthropic](../packages/providers/src/anthropic.ts) /
  [openai](../packages/providers/src/openai.ts) /
  [google](../packages/providers/src/google.ts)
- Aggregate registry: [`packages/providers/src/aggregate.ts`](../packages/providers/src/aggregate.ts)
