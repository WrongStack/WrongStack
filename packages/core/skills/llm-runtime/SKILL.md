---
name: llm-runtime
description: "LLM API integration: streaming, tool calling, structured outputs, prompt caching, retries with backoff, token budgets and fallbacks. Use when implementing or debugging an AI feature or agent runtime against OpenAI, Anthropic, Google or Vercel AI SDK APIs: tool-calling loops, SSE streaming, JSON outputs, cost and latency. Not for writing the prompt text itself (use prompt-engineering) or exposing tools over MCP (use mcp-development)."
version: 1.2.0
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when code calls an LLM provider API or SDK: tool loops, streaming, structured output, caching, retries, token or cost limits."
metadata:
  routing-group: integration
---

# LLM Runtime Engineering

## Selection card
- Task: Implement or repair LLM provider integration, tool-calling loops, streaming and structured outputs.
- Start: Find the provider client, model configuration, message assembly and the place where usage (tokens, cache) is logged.
- Finish: recorded-fixture tests cover success, tool loop, truncation and provider errors; one live smoke call (when credentials exist) shows correct usage and cache numbers.

## Overview

Treat the model as an unreliable remote service that returns untrusted text: every output is validated, every call is bounded in time, tokens and retries, and the conversation prefix is kept byte-stable so caching works.
Checked 2026-11-02 stable SDK targets: openai 7.47.0, @anthropic-ai/sdk 1.3.0, @google/genai 2.32.0, Vercel AI SDK (ai) 7.0.159, and zod 4.6.7.
Model ids, context limits and prices change; read them from configuration or the provider's models endpoint, never from memory.

## Rules

1. Validate every structured result and tool argument against a schema at runtime, even when the provider offers a strict mode; on failure, run at most one or two repair turns that include the validation error.
2. Handle every stop reason explicitly: normal end, tool call, output-token limit (truncated text or truncated tool JSON), refusal, and provider pause or error. Truncation is never success.
3. Keep the prompt prefix stable: system text, tool definitions and long documents first and byte-identical across turns; volatile data (time, cwd, git status, user input, tool results) last.
4. Retry only the model call, never tool execution with side effects: bounded attempts and total time, full jitter, honor `retry-after` (seconds or HTTP date), retry 408/429/5xx/overloaded and network errors, never 400/401/403/404.
5. A safety or policy refusal is a terminal answer: do not retry it on another model or provider to get around it.
6. Tool results and retrieved documents are untrusted data: never let them grant permissions, change the system prompt or trigger destructive tools without confirmation.
7. Thread an `AbortSignal` through every call and stream; detect idle streams (no bytes for N seconds) and abort rather than hang.
8. Log usage per call — input, output, cache-write and cache-read tokens, latency, model, stop reason — without logging secrets or full user content by default.

## First moves by situation

| Situation | First moves |
|---|---|
| Tool loop errors ("tool result without matching call") | Assistant tool-call message must be appended verbatim before results; result ids must match call ids; parallel calls answered together as the provider requires |
| JSON output fails to parse | Check for truncation (output limit), code fences, prose around JSON; move to the provider's structured-output or forced-tool mode; validate with the schema |
| Prompt cache hit rate near zero | Diff two consecutive request prefixes byte for byte: timestamps, reordered tools, changed tool descriptions, per-request ids in system text |
| Costs spike | Per-call usage logs: growing history, uncached prefix, large tool outputs re-sent each turn; trim or summarize old tool results |
| Stream hangs or cuts off | Idle timeout, proxy buffering (`X-Accel-Buffering: no`), SSE parser splitting events across chunks, mid-stream error events |
| 429 storms | Concurrency limit per key, token-bucket client-side, respect reset headers, queue instead of retrying in parallel |
| Reasoning model loses context in a tool loop | Reasoning or thinking items must be passed back unchanged as the provider documents (or use server-side conversation state) |
| Switching providers or models | Compare tool-call formats, structured-output support, context and output limits, and refusal behavior before swapping |

## Patterns and pitfalls

- **Message shapes differ** — Anthropic returns tool_use blocks answered by tool_result blocks in the next user message; OpenAI Chat uses `tool_calls` answered by `tool` role messages with `tool_call_id`; the Responses API uses `function_call` and `function_call_output` items with `call_id`. Normalize at one adapter boundary.
- **Strict schemas** — strict structured-output modes typically require every property listed as required and `additionalProperties: false`; express optional fields as nullable.
- **Partial tool arguments** — streamed tool arguments arrive as JSON fragments; parse only when the block or call completes.
- **SSE parsing** — split on blank lines, not on chunk boundaries; handle `event: error` after a successful start; never assume one network chunk is one event.
- **Mid-stream failure** — if text was already shown, a blind retry duplicates it; restart the turn visibly or resume from saved state.
- **Context budget** — reserve `max_tokens` for output before filling the window; count tokens with the provider's counting endpoint or tokenizer, not character heuristics, near the limit.
- **Caching mechanics** — explicit cache breakpoints (Anthropic) or automatic prefix caching (OpenAI) both need a long stable prefix; changing any earlier byte invalidates everything after it.
- **Fallbacks** — fall back on overload or outage after retries, to a model with the same tool and context capabilities; never on validation errors or refusals.
- **Timeouts** — SDK defaults can be many minutes; set request and idle timeouts per use case (interactive versus batch).
- **Determinism in tests** — record provider responses as fixtures and replay them; live calls belong in a separate, opt-in smoke suite.
- **Secrets** — API keys from the environment or a secret store; never in prompts, logs, error messages or client bundles.

## Implementation sketch (TypeScript)

```typescript
import { z } from 'zod';

export const SearchArgs = z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20) });

function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = header === null ? Number.NaN : Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return Math.random() * Math.min(30_000, 500 * 2 ** attempt); // full jitter
}

export async function callModel(url: string, init: RequestInit, signal: AbortSignal, maxAttempts = 4) {
  for (let attempt = 0; ; attempt++) {
    const res = await globalThis.fetch(url, { ...init, signal });
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    if (!retryable || attempt + 1 >= maxAttempts) return res;
    await res.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(res, attempt)));
    signal.throwIfAborted();
  }
}
```

## Workflow

1. Map the request path: message assembly → provider adapter → stream parser → tool executor → result validation → persistence.
2. Write fixtures for: plain answer, tool loop with parallel calls, truncated output, refusal, 429 then success, mid-stream error.
3. Implement schemas, stop-reason handling, retries, timeouts and abort wiring at the adapter boundary.
4. Make the prefix stable; verify cache reads on the second identical-prefix call.
5. Add usage logging and a cost or token budget guard.
6. Run tests, then one opt-in live smoke call when credentials are available.

## Proof

- Unit tests with recorded fixtures through the project's runner (for example `npx vitest run src/llm`)
- Schema checks: every tool argument and structured result passes `schema.safeParse` in tests, including a deliberately invalid fixture
- Cache proof: two consecutive live calls with the same prefix show cache-read tokens on the second
- Abort proof: cancelling mid-stream stops network activity and leaves no dangling tool execution

## Stop and ask

- Credentials, paid live calls or a model change are needed beyond what the task authorizes.
- A tool would gain write, payment or deletion power based on model output alone.
- The design sends user data to a new provider or region.

## Acceptance checks

- [ ] Tool arguments and structured outputs validated at runtime with bounded repair
- [ ] All stop reasons handled; truncation and refusal never treated as success
- [ ] Retries bounded, jittered, honoring `retry-after`, never re-running side-effecting tools
- [ ] Prefix byte-stable and cache reads observed (or the reason they cannot be)
- [ ] Abort and idle timeouts wired through calls and streams
- [ ] Usage logged per call without secrets; fixture tests cover the error paths

## Sources

[Anthropic tool use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use), [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching), [OpenAI function calling](https://platform.openai.com/docs/guides/function-calling), [OpenAI structured outputs](https://platform.openai.com/docs/guides/structured-outputs), [Vercel AI SDK](https://ai-sdk.dev/docs).

## Skills in scope

- prompt-engineering — system prompt architecture, few-shot calibration, and eval rubrics.
- mcp-development — Model Context Protocol servers, tool schemas, and transport security.
- realtime-systems — SSE and WebSocket streaming backpressure and reconnection contracts.
- observability — usage, latency and error telemetry for model calls.
- testing — recorded-fixture tests for provider adapters.
