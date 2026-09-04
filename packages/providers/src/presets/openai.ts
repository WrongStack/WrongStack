/**
 * OpenAI provider as a declarative `WireFormatConfig`. Same canonical events
 * as `OpenAIProvider`; the per-message body is the loop body of
 * `parseOpenAIStream` split into a stateful step.
 */
import type {
  Request,
  ResponseFormat,
  StopReason,
  StreamEvent,
  Usage,
} from '@wrongstack/core/types';
import { safeParse } from '@wrongstack/core/utils';
import { parseToolInput } from '../_tool-input.js';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { type BuildBodyContext, resolveMaxOutputTokens } from '../model-output-limits.js';
import { stripCacheControl } from '../object-utils.js';
import { isOpenAIEffort } from '../openai-shared.js';
import { applyPromptCacheKey } from '../prompt-cache-key.js';
import { normalizeOpenAI } from '../stop-reason.js';
import { messagesToOpenAI, toolsToOpenAI } from '../tool-format/to-openai.js';
import { defineWireFormat } from '../wire-format.js';

function appendArgChunk(buf: StreamingArgBuffer, chunk: string): void {
  if (chunk.length === 0) return;
  buf.chunks.push(chunk);
  buf.length += chunk.length;
}

function joinArgBuffer(buf: StreamingArgBuffer): string {
  return buf.chunks.length === 1 ? (buf.chunks[0] ?? '') : buf.chunks.join('');
}

interface StreamingArgBuffer {
  chunks: string[];
  length: number;
}

interface OpenAIStreamToolState {
  id?: string | undefined;
  name?: string | undefined;
  argBuf: StreamingArgBuffer;
  emittedStart: boolean;
  emittedChunkIndex: number;
}

export interface OpenAIStreamState {
  model: string;
  usage: Usage;
  stopReason: StopReason;
  started: boolean;
  textOpen: boolean;
  thinkingOpen: boolean;
  toolByIndex: Map<number, OpenAIStreamToolState>;
  finalEmitted: boolean;
  /** Set once `[DONE]` or a `finish_reason` is seen — a proper end-of-stream. */
  sawTerminal: boolean;
}

export const openaiWireFormat = defineWireFormat<OpenAIStreamState>({
  id: 'openai',
  family: 'openai',
  capabilities: capabilitiesForFamily('openai'),
  defaultBaseUrl: 'https://api.openai.com/v1',
  buildUrl: (base) => {
    const b = base.replace(/\/+$/, '');
    if (/\/chat\/completions$/.test(b)) return b;
    if (/\/v\d+(\/[a-z0-9_-]+)*$/i.test(b)) return `${b}/chat/completions`;
    return `${b}/v1/chat/completions`;
  },
  buildHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  buildBody: (req: Request, ctx: BuildBodyContext) => {
    const maxOutput = resolveMaxOutputTokens(req, ctx);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messagesToOpenAI(stripCacheControl(req.system), req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    // `max_completion_tokens` is optional — when nothing knows this model's
    // ceiling, omit it so the backend applies the model's own maximum instead
    // of a number we made up. Real OpenAI 400s on the deprecated `max_tokens`
    // for newer model families (gpt-4o, o1/o3/o4), so the field name matters.
    // See issue #10.
    if (maxOutput !== undefined) body['max_completion_tokens'] = maxOutput;
    if (req.tools && req.tools.length > 0) {
      body['tools'] = toolsToOpenAI(req.tools);
      if (req.toolChoice) {
        if (typeof req.toolChoice === 'string') {
          body['tool_choice'] = req.toolChoice === 'required' ? 'required' : req.toolChoice;
        } else {
          body['tool_choice'] = {
            type: 'function',
            function: { name: req.toolChoice.name },
          };
        }
      }
    }
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (req.frequencyPenalty !== undefined) body['frequency_penalty'] = req.frequencyPenalty;
    if (req.presencePenalty !== undefined) body['presence_penalty'] = req.presencePenalty;
    if (req.seed !== undefined) body['seed'] = req.seed;
    if (req.user) body['user'] = req.user;
    applyPromptCacheKey(body, req, ctx?.capabilities);
    if (req.logprobs === true) {
      body['logprobs'] = true;
      if (req.topLogprobs !== undefined) body['top_logprobs'] = req.topLogprobs;
    }
    if (req.stopSequences) body['stop'] = req.stopSequences;
    if (req.reasoning?.effort !== undefined && isOpenAIEffort(req.reasoning.effort)) {
      body['reasoning_effort'] = req.reasoning.effort;
    }
    if (req.responseFormat) {
      body['response_format'] = responseFormatToOpenAI(req.responseFormat);
    }
    return body;
  },
  createStreamState: (fallbackModel) => ({
    model: fallbackModel,
    usage: { input: 0, output: 0 },
    stopReason: 'end_turn',
    started: false,
    textOpen: false,
    thinkingOpen: false,
    toolByIndex: new Map(),
    finalEmitted: false,
    sawTerminal: false,
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (msg.data === '[DONE]') {
      state.sawTerminal = true;
      return [];
    }
    if (!msg.data) return [];
    const parsed = safeParse<Record<string, unknown>>(msg.data);
    if (!parsed.ok || !parsed.value) return [];
    const obj = parsed.value;
    const out: StreamEvent[] = [];

    if (typeof obj['model'] === 'string') state.model = obj['model'] as string;
    if (!state.started) {
      state.started = true;
      out.push({ type: 'message_start', model: state.model });
    }

    const choices = obj['choices'] as
      | Array<{
          delta?: {
            content?: string | null | undefined;
            reasoning_content?: string | undefined;
            reasoning?: string | undefined;
            tool_calls?: Array<{
              index?: number | undefined;
              id?: string | undefined;
              function?: { name?: string | undefined; arguments?: string | undefined };
            }>;
          };
          finish_reason?: string | null | undefined;
        }>
      | undefined;
    const choice = choices?.[0];

    // DeepSeek (and Moonshot/Kimi thinking mode, OpenRouter `reasoning`)
    // streams chain-of-thought as `delta.reasoning_content` at the top of
    // the delta. The full blob MUST be echoed back as message-level
    // `reasoning_content` on the next request — otherwise DeepSeek 400s.
    const reasoningDelta =
      typeof choice?.delta?.reasoning_content === 'string'
        ? choice.delta.reasoning_content
        : typeof choice?.delta?.reasoning === 'string'
          ? choice.delta.reasoning
          : undefined;
    if (reasoningDelta && reasoningDelta.length > 0) {
      if (!state.thinkingOpen) {
        state.thinkingOpen = true;
        out.push({ type: 'thinking_start' });
      }
      out.push({ type: 'thinking_delta', text: reasoningDelta });
    }

    if (choice?.delta?.content) {
      if (state.thinkingOpen) {
        state.thinkingOpen = false;
        out.push({ type: 'thinking_stop' });
      }
      if (!state.textOpen) state.textOpen = true;
      out.push({ type: 'text_delta', text: choice.delta.content });
    }

    if (choice?.delta?.tool_calls) {
      if (state.thinkingOpen) {
        state.thinkingOpen = false;
        out.push({ type: 'thinking_stop' });
      }
      for (const tc of choice.delta.tool_calls) {
        const idx = tc.index ?? 0;
        let entry = state.toolByIndex.get(idx);
        if (!entry) {
          entry = {
            id: tc.id,
            name: tc.function?.name,
            argBuf: { chunks: [], length: 0 },
            emittedStart: false,
            emittedChunkIndex: 0,
          };
          state.toolByIndex.set(idx, entry);
        } else {
          if (tc.id && !entry.id) entry.id = tc.id;
          if (tc.function?.name && !entry.name) entry.name = tc.function.name;
        }
        if (tc.function?.arguments) {
          appendArgChunk(entry.argBuf, tc.function.arguments);
        }
        if (!entry.emittedStart && entry.id && entry.name) {
          entry.emittedStart = true;
          state.textOpen = false;
          out.push({ type: 'tool_use_start', id: entry.id, name: entry.name });
        }
        if (
          entry.emittedStart &&
          entry.id &&
          entry.emittedChunkIndex < entry.argBuf.chunks.length
        ) {
          for (; entry.emittedChunkIndex < entry.argBuf.chunks.length; entry.emittedChunkIndex++) {
            out.push({
              type: 'tool_use_input_delta',
              id: entry.id,
              partial: entry.argBuf.chunks[entry.emittedChunkIndex] ?? '',
            });
          }
        }
      }
    }

    if (choice?.finish_reason) {
      state.stopReason = normalizeOpenAI(choice.finish_reason);
      state.sawTerminal = true;
    }

    const u = obj['usage'] as
      | {
          prompt_tokens?: number | undefined;
          input_tokens?: number | undefined;
          completion_tokens?: number | undefined;
          total_tokens?: number | undefined;
          prompt_tokens_details?: {
            cached_tokens?: number | undefined;
            cache_write_tokens?: number | undefined;
          };
          prompt_cache_hit_tokens?: number | undefined;
          prompt_cache_miss_tokens?: number | undefined;
        }
      | undefined;
    if (u) {
      // Mirror openai.ts: disjoint semantics: input is fresh-only,
      // cacheRead is the cached subset. Subtracting prevents the cost
      // calc / cache-hit-ratio from double-counting cached tokens.
      const hasDeepSeekCacheFields =
        u.prompt_cache_hit_tokens !== undefined || u.prompt_cache_miss_tokens !== undefined;
      const cached = nonNegative(u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens);
      const cacheWrite = nonNegative(u.prompt_tokens_details?.cache_write_tokens);
      const completion = nonNegative(u.completion_tokens, state.usage.output);
      // MiniMax (and other lean OpenAI-compatible endpoints) may report only
      // `total_tokens` + `completion_tokens` with no `prompt_tokens`; derive
      // prompt = total − completion so the input count is recovered instead of
      // collapsing to 0. Ordered after the explicit prompt fields.
      const hasPromptTotal = u.prompt_tokens !== undefined;
      const hasFreshInputDelta = !hasPromptTotal && u.input_tokens !== undefined;
      const cacheMiss = optionalNonNegative(u.prompt_cache_miss_tokens);
      const reportedPromptTotal = hasPromptTotal
        ? nonNegative(u.prompt_tokens)
        : hasDeepSeekCacheFields
          ? nonNegative(u.prompt_cache_hit_tokens) + nonNegative(u.prompt_cache_miss_tokens)
          : u.total_tokens !== undefined
            ? Math.max(0, u.total_tokens - completion)
            : state.usage.input + cached + cacheWrite;
      // Some hybrid gateways expose Anthropic/MiniMax semantics through an
      // OpenAI-shaped envelope: input_tokens is fresh-only and cache tokens
      // are separate. prompt_tokens, when present, remains OpenAI's total.
      // If a broken gateway reports cached > prompt total, preserve both
      // counters instead of producing a >100% cache ratio.
      const promptTotal =
        hasPromptTotal && cached > reportedPromptTotal
          ? reportedPromptTotal + cached
          : reportedPromptTotal;
      const nextUsage: Usage = {
        input:
          cacheMiss ??
          (hasFreshInputDelta
            ? Math.max(0, u.input_tokens ?? 0)
            : Math.max(0, promptTotal - cached - cacheWrite)),
        output: completion,
        cacheRead: cached || state.usage.cacheRead,
      };
      if (cacheWrite || state.usage.cacheWrite !== undefined) {
        nextUsage.cacheWrite = cacheWrite || state.usage.cacheWrite;
      }
      state.usage = nextUsage;
    }

    return out;
  },
  finalizeStream: (state): StreamEvent[] => {
    if (state.finalEmitted) return [];
    state.finalEmitted = true;
    const out: StreamEvent[] = [];
    if (state.thinkingOpen) {
      state.thinkingOpen = false;
      out.push({ type: 'thinking_stop' });
    }
    for (const entry of state.toolByIndex.values()) {
      if (!entry.id || !entry.name) continue;
      if (!entry.emittedStart) {
        out.push({ type: 'tool_use_start', id: entry.id, name: entry.name });
      }
      const input = parseToolInput(joinArgBuffer(entry.argBuf));
      out.push({ type: 'tool_use_stop', id: entry.id, input });
    }
    if (state.started) {
      out.push({ type: 'message_stop', stopReason: state.stopReason, usage: state.usage });
    }
    return out;
  },
  // Started receiving but the upstream closed with no `[DONE]` and no
  // `finish_reason` → the response was cut mid-stream. Terse endpoints that
  // omit these markers use the local-llm preset, not this one, so on the
  // OpenAI SSE contract this reliably means truncation.
  isTruncated: (state) => state.started && !state.sawTerminal,
});

function nonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Translate a canonical `ResponseFormat` to OpenAI's `response_format` body field.
 * Mirrors the same-named helper in ../openai.ts.
 */
function responseFormatToOpenAI(fmt: ResponseFormat): Record<string, unknown> {
  if (fmt.type === 'text') return { type: 'text' };
  if (fmt.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: fmt.jsonSchema.name,
      strict: fmt.jsonSchema.strict ?? true,
      schema: fmt.jsonSchema.schema,
      ...(fmt.jsonSchema.description ? { description: fmt.jsonSchema.description } : {}),
    },
  };
}
