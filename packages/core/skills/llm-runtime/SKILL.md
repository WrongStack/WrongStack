---
name: llm-runtime
description: "Integrate, stream, and orchestrate frontier LLM APIs with robust structured outputs, tool call schemas, prompt caching, and resilient backoff handling. Use when implementing AI agent runtimes, tool-calling loops, streaming SSE endpoints, or optimizing token usage and model latency."
version: 1.0.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "implementing AI agent runtimes, tool-calling loops, streaming SSE endpoints, or optimizing token usage and model latency."
metadata:
  routing-group: integration
---

# LLM Runtime Engineering — WrongStack

## Selection card
- Task: Implement frontier LLM integration, tool calling, and streaming pipelines.
- Start: Define model choice, schema definitions (Zod/JSON Schema), and streaming protocol.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

## Overview

Frontier LLM integrations require production reliability: structured tool contracts,
deterministic schema validation, streaming Server-Sent Events (SSE), prompt caching optimization,
and graceful degradation during rate limits (HTTP 429) or transient gateway timeouts (HTTP 502/529).

## Core Architecture Principles

1. **Strict Type-Safe Schema Contracts**:
   - Define all tool inputs and structured responses using Zod schemas converted to standard JSON Schema.
   - Set `additionalProperties: false` to force model compliance and eliminate hallucinated parameters.
2. **Streaming & Asynchronous Lifecycle**:
   - Stream model responses via standard `ReadableStream` or Server-Sent Events (`text/event-stream`).
   - Parse tool calls incrementally and emit status events to avoid user-perceived latency.
   - Wire `AbortSignal` through all fetch calls so user cancellations abort upstream API billing immediately.
3. **Prompt Caching & Token Economics**:
   - Place stable system prompts and large reference documents at the beginning of the context window.
   - Place ephemeral user inputs, dynamic turn logs, and real-time tool results at the end.
   - Monitor cache-read vs. cache-write token counts in response usage headers.
4. **Resilient Rate-Limit Backoff**:
   - Implement exponential backoff with full jitter on HTTP 429, 500, 502, and 503 errors.
   - Respect `retry-after` header values when provided by the provider gateway.

## Implementation Pattern (TypeScript ESM)

```typescript
import { z } from 'zod';

export const SearchToolSchema = z.object({
  query: z.string().describe('The search query term'),
  limit: z.number().int().min(1).max(20).default(5)
});

export type SearchToolInput = z.infer<typeof SearchToolSchema>;

export async function fetchWithBackoff(url: string, init: RequestInit, maxRetries = 3): Promise<Response> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      const response = await globalThis.fetch(url, init);
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number(response.headers.get('retry-after')) || Math.pow(2, attempt) + Math.random();
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        attempt++;
        continue;
      }
      return response;
    } catch (err) {
      if (attempt >= maxRetries - 1) throw err;
      attempt++;
    }
  }
  throw new Error('LLM gateway request exceeded retry budget');
}
```

## Acceptance checks

- Tool definitions enforce strict JSON Schema contracts with no undeclared properties.
- Streaming pipelines handle backpressure and abort cleanly via AbortSignal.
- Rate-limiting (HTTP 429) triggers exponential backoff with full jitter.
- Context window structure leverages prompt caching boundaries effectively.
