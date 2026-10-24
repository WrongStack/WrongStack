/**
 * Mistral provider as a declarative wire-format config — a 50-line proof
 * that adding a new OpenAI-flavored provider doesn't require subclassing.
 *
 * Mistral's streaming chat completion API is OpenAI-compatible at the wire
 * level, with `delta.content` + `delta.tool_calls` + `[DONE]` terminator.
 * For exotic providers the same pattern still applies — only the
 * `parseStreamEvent` body changes.
 */
import { createHash } from 'node:crypto';
import type { Request, StopReason, StreamEvent, Usage } from '@wrongstack/contracts/types';
import { safeParse } from '@wrongstack/core/utils';
import { parseToolInput } from '../_tool-input.js';
import { providerErrorFromStreamPayload } from '../error-parse.js';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { type BuildBodyContext, resolveMaxOutputTokens } from '../model-output-limits.js';
import { stripCacheControl } from '../object-utils.js';
import { normalizeOpenAIChatUsage, type OpenAIChatUsageWire } from '../openai-chat-usage.js';
import { applyPromptCacheKey } from '../prompt-cache-key.js';
import { messagesToOpenAI, toolsToOpenAI } from '../tool-format/to-openai.js';
import { defineWireFormat } from '../wire-format.js';

interface MistralStreamState {
  model: string;
  started: boolean;
  inThinking: boolean;
  usage: Usage;
  stopReason?: StopReason | undefined;
  // OpenAI-style tool_call accumulators keyed by `index`
  toolCalls: Map<
    number,
    {
      id?: string | undefined;
      name?: string | undefined;
      partial: string;
      emittedStart: boolean;
      emittedArgLength: number;
    }
  >;
  /** `[DONE]` or a `finish_reason` arrived — the stream ended on purpose. */
  sawTerminal?: boolean | undefined;
  /** A `message_stop` (with its tool closes) was already emitted. */
  stopped?: boolean | undefined;
  /** Live provider id (alias-aware) for errors raised mid-stream. */
  providerId?: string | undefined;
}

const MISTRAL_CAPABILITIES = capabilitiesForFamily('openai-compatible', {
  jsonMode: true,
  // Mistral caches prompt prefixes per `prompt_cache_key` (cached tokens at
  // 10% of the input price) and reports hits in
  // `usage.prompt_tokens_details.cached_tokens`.
  promptCache: true,
  cacheControl: 'auto',
});

export const mistralWireFormat = defineWireFormat<MistralStreamState>({
  id: 'mistral',
  family: 'openai-compatible',
  capabilities: MISTRAL_CAPABILITIES,
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  buildUrl: (base) => `${base.replace(/\/+$/, '')}/chat/completions`,
  buildHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
  buildBody: (req: Request, ctx: BuildBodyContext) => {
    const maxOutput = resolveMaxOutputTokens(req, ctx);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: messagesToMistral(req),
      stream: true,
    };
    // Optional field — omit rather than guess; see model-output-limits.ts.
    if (maxOutput !== undefined) body['max_tokens'] = maxOutput;
    applyPromptCacheKey(body, req, ctx?.capabilities ?? MISTRAL_CAPABILITIES);
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
    if (req.seed !== undefined) body['random_seed'] = req.seed;
    if (req.reasoning?.effort !== undefined) {
      body['reasoning_effort'] = req.reasoning.effort;
    }
    // `enabled: false` no longer fabricates `reasoning_effort: 'none'`:
    // 'none' is not in Mistral's documented effort enum, and sending an
    // unknown value risks a 400 on models that validate the field. Disabling
    // is expressed by simply omitting reasoning controls — Mistral's
    // non-reasoning models don't think by default.
    if (req.stopSequences) body['stop'] = req.stopSequences;
    return body;
  },
  createStreamState: (fallbackModel, providerId) => ({
    providerId,
    model: fallbackModel,
    started: false,
    inThinking: false,
    usage: { input: 0, output: 0 },
    toolCalls: new Map(),
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (msg.data === '[DONE]') {
      state.sawTerminal = true;
      return state.started && !state.stopped
        ? closeMessage(state, state.stopReason ?? 'end_turn', state.usage)
        : [];
    }
    if (!msg.data) return [];
    const parsed = safeParse<{
      model?: string | undefined;
      choices?: {
        delta?: {
          content?:
            | string
            | Array<
                | { type: 'text'; text?: string | undefined }
                | {
                    type: 'thinking';
                    thinking?: string | Array<{ type?: string; text?: string | undefined }>;
                  }
              >
            | undefined;
          tool_calls?: {
            index: number;
            id?: string | undefined;
            function?: { name?: string | undefined; arguments?: string | undefined };
          }[];
        };
        finish_reason?: string | undefined;
      }[];
      usage?: OpenAIChatUsageWire | undefined;
      error?: unknown;
    }>(msg.data);
    if (!parsed.ok || !parsed.value) return [];
    const ev = parsed.value;
    if (ev.error !== undefined && ev.error !== null) {
      throw providerErrorFromStreamPayload(
        state.providerId ?? 'mistral',
        ev as Record<string, unknown>,
      );
    }
    const out: StreamEvent[] = [];
    if (ev.model) state.model = ev.model;
    if (!state.started) {
      state.started = true;
      out.push({ type: 'message_start', model: state.model });
    }
    if (ev.usage) {
      state.usage = normalizeOpenAIChatUsage(ev.usage, state.usage);
    }
    const choice = ev.choices?.[0];
    const content = choice?.delta?.content;
    if (typeof content === 'string' && content.length > 0) {
      closeThinking(out, state);
      out.push({ type: 'text_delta', text: content });
    } else if (Array.isArray(content)) {
      for (const chunk of content) {
        if (chunk.type === 'thinking') {
          const thinking =
            typeof chunk.thinking === 'string'
              ? chunk.thinking
              : (chunk.thinking ?? []).map((part) => part.text ?? '').join('');
          if (thinking.length === 0) continue;
          if (!state.inThinking) {
            state.inThinking = true;
            out.push({ type: 'thinking_start' });
          }
          out.push({ type: 'thinking_delta', text: thinking });
        } else if (chunk.type === 'text' && chunk.text) {
          closeThinking(out, state);
          out.push({ type: 'text_delta', text: chunk.text });
        }
      }
    }
    for (const tc of choice?.delta?.tool_calls ?? []) {
      closeThinking(out, state);
      let block = state.toolCalls.get(tc.index);
      if (!block) {
        block = {
          id: tc.id,
          name: tc.function?.name,
          partial: '',
          emittedStart: false,
          emittedArgLength: 0,
        };
        state.toolCalls.set(tc.index, block);
      } else {
        if (tc.id && !block.id) block.id = tc.id;
        if (tc.function?.name && !block.name) block.name = tc.function.name;
      }
      const arg = tc.function?.arguments;
      if (arg) {
        block.partial += arg;
      }
      if (!block.emittedStart && block.id && block.name) {
        block.emittedStart = true;
        out.push({ type: 'tool_use_start', id: block.id, name: block.name });
      }
      if (block.emittedStart && block.id && block.emittedArgLength < block.partial.length) {
        const partial = block.partial.slice(block.emittedArgLength);
        block.emittedArgLength = block.partial.length;
        out.push({ type: 'tool_use_input_delta', id: block.id, partial });
      }
    }
    if (choice?.finish_reason) {
      state.sawTerminal = true;
      state.stopReason = mapStopReason(choice.finish_reason);
    }
    return out;
  },
  // Started, then closed with neither `finish_reason` nor `[DONE]`: the reply
  // was cut mid-stream. Previously nothing was emitted at all, so the partial
  // text was committed as a clean end_turn and pending tool calls vanished.
  isTruncated: (state) => state.started && !state.sawTerminal,
  // `[DONE]` without a `finish_reason` still ends the turn properly.
  finalizeStream: (state): StreamEvent[] =>
    state.started && !state.stopped
      ? closeMessage(state, state.stopReason ?? 'end_turn', state.usage)
      : [],
});

function closeMessage(
  state: MistralStreamState,
  stopReason: StopReason,
  usage: Usage,
): StreamEvent[] {
  const out: StreamEvent[] = [];
  state.stopped = true;
  closeThinking(out, state);
  // Close out tool calls with parsed JSON
  for (const block of state.toolCalls.values()) {
    if (block.id && block.name) {
      if (!block.emittedStart) {
        out.push({ type: 'tool_use_start', id: block.id, name: block.name });
      }
      out.push({
        type: 'tool_use_stop',
        id: block.id,
        input: parseToolInput(block.partial),
      });
    }
  }
  out.push({ type: 'message_stop', stopReason, usage });
  return out;
}

/**
 * Mistral rejects any tool-call id that is not exactly 9 ASCII letters/digits
 * ("Tool call id was call_… but must be a-z, A-Z, 0-9, with a length of 9").
 * Its own ids already comply; ids minted by other wires (`toolu_…`, `call_…`)
 * arrive with the history after a `/model` switch or fallback hop and 400'd
 * the request. The mapping is a pure function of the id, so a call and its
 * result always rewrite to the same value.
 */
export function mistralToolCallId(id: string): string {
  if (/^[A-Za-z0-9]{9}$/.test(id)) return id;
  return createHash('sha256').update(id).digest('hex').slice(0, 9);
}

function messagesToMistral(req: Request): unknown[] {
  return messagesToOpenAI(stripCacheControl(req.system), req.messages).map((raw) => {
    const message = {
      ...raw,
      ...(raw.tool_call_id !== undefined
        ? { tool_call_id: mistralToolCallId(raw.tool_call_id) }
        : {}),
      ...(raw.tool_calls
        ? { tool_calls: raw.tool_calls.map((tc) => ({ ...tc, id: mistralToolCallId(tc.id) })) }
        : {}),
    };
    if (message.role !== 'assistant' || !message.reasoning_content) return message;
    const { reasoning_content: reasoning, ...rest } = message;
    const content: Array<Record<string, unknown>> = [
      { type: 'thinking', thinking: [{ type: 'text', text: reasoning }] },
    ];
    if (typeof message.content === 'string' && message.content.length > 0) {
      content.push({ type: 'text', text: message.content });
    }
    return { ...rest, content };
  });
}

function closeThinking(out: StreamEvent[], state: MistralStreamState): void {
  if (!state.inThinking) return;
  state.inThinking = false;
  out.push({ type: 'thinking_stop' });
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
    case 'model_length':
      return 'max_tokens';
    case 'stop':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}
