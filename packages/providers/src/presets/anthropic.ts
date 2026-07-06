/**
 * Anthropic provider expressed as a declarative `WireFormatConfig`.
 *
 * The existing `AnthropicProvider` class stays as the production path until
 * the rest of the registry switches over — both produce the same canonical
 * StreamEvent[]. The per-message logic here is extracted verbatim from
 * `parseAnthropicStream` in `../anthropic.ts`, just split into a stateful
 * `parseStreamEvent` call instead of an async generator loop.
 */
import type { Capabilities, ContentBlock, Message, ReasoningEffort, Request, StopReason, StreamEvent, Usage } from '@wrongstack/core';
import { ProviderError, safeParse } from '@wrongstack/core';
import { parseToolInput } from '../_tool-input.js';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { normalizeAnthropic } from '../stop-reason.js';
import { toolsToAnthropic } from '../tool-format/to-anthropic.js';
import { defineWireFormat } from '../wire-format.js';

type BlockKind = 'text' | 'tool_use' | 'thinking' | 'unknown';

export interface AnthropicStreamState {
  model: string;
  usage: Usage;
  stopReason: StopReason;
  started: boolean;
  stopped: boolean;
  blocks: Map<number, { kind: BlockKind; id?: string | undefined; name?: string | undefined; partial: string }>;
}

const DEFAULT_VERSION = '2023-06-01';

export const anthropicWireFormat = defineWireFormat<AnthropicStreamState>({
  id: 'anthropic',
  family: 'anthropic',
  capabilities: capabilitiesForFamily('anthropic'),
  defaultBaseUrl: 'https://api.anthropic.com',
  buildUrl: (base) => {
    const b = base.replace(/\/+$/, '');
    if (/\/v\d+\/messages$/.test(b)) return b;
    if (/\/v\d+$/.test(b)) return `${b}/messages`;
    return `${b}/v1/messages`;
  },
  buildHeaders: (apiKey) => ({
    'x-api-key': apiKey,
    'anthropic-version': DEFAULT_VERSION,
  }),
  buildBody: (req: Request, ctx: { capabilities: Capabilities }) => {
    // Anthropic's `max_tokens` is required. Pull from the caller's
    // Request when set, otherwise the per-model ceiling the catalog
    // populates via `withCatalogCapabilities` for the selected model.
    // The 8192 floor is the same safety net the rest of the system uses
    // for unknown models.
    const maxOutput = req.maxTokens ?? ctx.capabilities.maxOutput ?? 8192;
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: maxOutput,
      messages: req.messages.map((m: Message) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: normalizeMessageContent(m),
      })),
      stream: true,
    };
    if (req.system && req.system.length > 0) {
      body['system'] = req.system.map((b, index) =>
        req.cache?.ttl && index === req.system!.length - 1
          ? { ...b, cache_control: { type: 'ephemeral', ttl: req.cache.ttl } }
          : b,
      );
    }
    if (req.tools && req.tools.length > 0) body['tools'] = toolsToAnthropic(req.tools);
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (req.topK !== undefined) body['top_k'] = req.topK;
    if (req.stopSequences) body['stop_sequences'] = req.stopSequences;
    if (req.toolChoice) body['tool_choice'] = req.toolChoice;
    if (req.user) body['metadata'] = { user_id: req.user };
    if (req.reasoning) {
      if (req.reasoning.enabled === false) {
        body['thinking'] = { type: 'disabled' };
      } else if (req.reasoning.enabled === true) {
        body['thinking'] = {
          type: 'enabled',
          budget_tokens: deriveThinkingBudget(maxOutput, req.reasoning.effort),
        };
      }
    }
    return body;
  },
  createStreamState: (fallbackModel) => ({
    model: fallbackModel,
    usage: { input: 0, output: 0 },
    stopReason: 'end_turn',
    started: false,
    stopped: false,
    blocks: new Map(),
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (!msg.data || msg.data === '[DONE]') return [];
    const parsed = safeParse<Record<string, unknown>>(msg.data);
    if (!parsed.ok || !parsed.value) return [];
    const ev = parsed.value;
    const type = String(ev['type'] ?? msg.event);
    const out: StreamEvent[] = [];

    switch (type) {
      case 'message_start': {
        const message = ev['message'] as
          | {
              model?: string | undefined;
              usage?: {
                input_tokens?: number | undefined;
                cache_read_input_tokens?: number | undefined;
                cache_creation_input_tokens?: number | undefined;
              };
            }
          | undefined;
        if (message?.model) state.model = message.model;
        state.usage = {
          input: message?.usage?.input_tokens ?? 0,
          output: 0,
          cacheRead: message?.usage?.cache_read_input_tokens,
          cacheWrite: message?.usage?.cache_creation_input_tokens,
        };
        if (!state.started) {
          state.started = true;
          out.push({ type: 'message_start', model: state.model });
        }
        break;
      }
      case 'content_block_start': {
        const index = Number(ev['index'] ?? 0);
        const cb = ev['content_block'] as { type?: string | undefined; id?: string | undefined; name?: string | undefined } | undefined;
        if (cb?.type === 'tool_use') {
          state.blocks.set(index, { kind: 'tool_use', id: cb.id, name: cb.name, partial: '' });
          if (cb.id && cb.name) {
            out.push({ type: 'tool_use_start', id: cb.id, name: cb.name });
          }
        } else if (cb?.type === 'text') {
          state.blocks.set(index, { kind: 'text', partial: '' });
        } else if (cb?.type === 'thinking' || cb?.type === 'redacted_thinking') {
          state.blocks.set(index, { kind: 'thinking', partial: '' });
          out.push({ type: 'thinking_start' });
        } else {
          state.blocks.set(index, { kind: 'unknown', partial: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const index = Number(ev['index'] ?? 0);
        const delta = ev['delta'] as
          | {
              type?: string | undefined;
              text?: string | undefined;
              partial_json?: string | undefined;
              thinking?: string | undefined;
              signature?: string | undefined;
            }
          | undefined;
        const block = state.blocks.get(index);
        if (!block || !delta) break;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          out.push({ type: 'text_delta', text: delta.text });
        } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          if (block.id) {
            block.partial += delta.partial_json;
            out.push({ type: 'tool_use_input_delta', id: block.id, partial: delta.partial_json });
          }
        } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          out.push({ type: 'thinking_delta', text: delta.thinking });
        } else if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
          out.push({ type: 'thinking_signature', signature: delta.signature });
        }
        break;
      }
      case 'content_block_stop': {
        const index = Number(ev['index'] ?? 0);
        const block = state.blocks.get(index);
        if (block?.kind === 'tool_use' && block.id) {
          const input = parseToolInput(block.partial);
          out.push({ type: 'tool_use_stop', id: block.id, input });
        } else if (block?.kind === 'thinking') {
          out.push({ type: 'thinking_stop' });
        }
        break;
      }
      case 'message_delta': {
        const delta = ev['delta'] as { stop_reason?: string | null | undefined } | undefined;
        const u = ev['usage'] as { output_tokens?: number | undefined } | undefined;
        if (delta?.stop_reason !== undefined) {
          state.stopReason = normalizeAnthropic(delta.stop_reason);
        }
        if (u?.output_tokens !== undefined) {
          state.usage = { ...state.usage, output: u.output_tokens };
        }
        break;
      }
      case 'message_stop':
        state.stopped = true;
        out.push({ type: 'message_stop', stopReason: state.stopReason, usage: state.usage });
        break;
      case 'error': {
        const err = ev['error'] as { message?: string | undefined; type?: string | undefined } | undefined;
        throw new ProviderError(err?.message ?? 'Anthropic stream error', 0, false, 'anthropic', {
          body: { type: err?.type, message: err?.message },
        });
      }
    }
    return out;
  },
  finalizeStream: (state): StreamEvent[] => {
    // If upstream closed without an explicit `message_stop` we synthesize
    // one so the consumer's stream-end logic still fires.
    if (state.started && !state.stopped) {
      return [{ type: 'message_stop', stopReason: state.stopReason, usage: state.usage }];
    }
    return [];
  },
});

/**
 * Derive a thinking budget_tokens value for Anthropic's extended thinking.
 * Mirrors the same-named helper in ../anthropic.ts.
 */
function deriveThinkingBudget(
  maxTokens: number,
  effort: ReasoningEffort | undefined,
): number {
  const fraction =
    effort === 'none' || effort === 'minimal'
      ? 0.25
      : effort === 'low'
        ? 0.35
        : effort === 'medium' || effort === undefined
          ? 0.5
          : effort === 'high'
            ? 0.65
            : /* 'xhigh' | 'max' */ 0.75;

  return Math.max(1024, Math.min(Math.floor(maxTokens * fraction), Math.floor(maxTokens * 0.8)));
}

/**
 * Normalize a message's content to the shape Anthropic accepts.
 * String content is passed through; block content is sanitized via
 * `sanitizeAnthropicBlock` to strip extra fields other wire formats
 * inject (tool_result.name, tool_use.providerMeta, thinking.providerMeta).
 */
function normalizeMessageContent(m: Message): unknown {
  if (typeof m.content === 'string') return m.content;
  return (m.content as ContentBlock[]).map((b) => sanitizeAnthropicBlock(b));
}

/**
 * Reduce a canonical ContentBlock to exactly the fields the Anthropic Messages
 * API accepts. Strips extra fields that other wires inject:
 *   - `tool_result.name`        — set by ToolExecutor for Google's functionResponse
 *   - `tool_use.providerMeta`   — e.g. Gemini thought-signatures
 *   - `thinking.providerMeta`   — provider-specific metadata
 */
function sanitizeAnthropicBlock(b: ContentBlock): Record<string, unknown> {
  switch (b.type) {
    case 'text':
      return b.cache_control
        ? { type: 'text', text: b.text, cache_control: b.cache_control }
        : { type: 'text', text: b.text };
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
    case 'tool_result': {
      const out: Record<string, unknown> = {
        type: 'tool_result',
        tool_use_id: b.tool_use_id,
        content: b.content,
      };
      if (b.is_error) out['is_error'] = true;
      return out;
    }
    case 'thinking':
      return b.signature
        ? { type: 'thinking', thinking: b.thinking, signature: b.signature }
        : { type: 'thinking', thinking: b.thinking };
    case 'image':
      return { type: 'image', source: b.source };
    default:
      return b as never as Record<string, unknown>;
  }
}
