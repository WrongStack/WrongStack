/**
 * Anthropic provider expressed as a declarative `WireFormatConfig`.
 *
 * The existing `AnthropicProvider` class stays as the production path until
 * the rest of the registry switches over — both produce the same canonical
 * StreamEvent[]. The per-message logic here is extracted verbatim from
 * `parseAnthropicStream` in `../anthropic.ts`, just split into a stateful
 * `parseStreamEvent` call instead of an async generator loop.
 */
import type {
  Capabilities,
  ContentBlock,
  Message,
  ReasoningEffort,
  Request,
  StopReason,
  StreamEvent,
  Usage,
} from '@wrongstack/contracts/types';
import { safeParse } from '@wrongstack/core/utils';
import { parseToolInput } from '../_tool-input.js';
import { capAnthropicCacheBreakpoints } from '../cache-breakpoint-cap.js';
import { providerErrorFromStreamPayload } from '../error-parse.js';
import { capabilitiesForFamily } from '../family-capabilities.js';
import { documentInputFallback, imageInputFallback } from '../media-input-policy.js';
import { type BuildBodyContext, resolveRequiredMaxOutputTokens } from '../model-output-limits.js';
import { normalizeAnthropic } from '../stop-reason.js';
import { toolsToAnthropic } from '../tool-format/to-anthropic.js';
import { defineWireFormat } from '../wire-format.js';

type BlockKind = 'text' | 'tool_use' | 'thinking' | 'unknown';

/**
 * Anthropic usage object as it appears on the wire (`message_start.message.usage`
 * and `message_delta.usage`). All fields optional: different gateway shapes
 * report different subsets, and `message_delta` canonically carries only
 * `output_tokens`.
 */
type AnthropicUsageWire = {
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  cache_read_input_tokens?: number | undefined;
  cache_creation_input_tokens?: number | undefined;
  cache_creation?:
    | {
        ephemeral_5m_input_tokens?: number | undefined;
        ephemeral_1h_input_tokens?: number | undefined;
      }
    | undefined;
};

/**
 * Merge a wire usage object into the stream state's canonical `Usage`.
 * Present fields overwrite; absent fields keep the previously-seen value, so
 * `message_start` + `message_delta` accumulate into one authoritative figure
 * and late-reporting gateways never clobber earlier cache telemetry with
 * undefined.
 */
function mergeAnthropicUsage(state: AnthropicStreamState, u: AnthropicUsageWire | undefined): void {
  if (!u) return;
  if (u.input_tokens !== undefined) state.usage.input = nonNegative(u.input_tokens);
  if (u.output_tokens !== undefined) state.usage.output = nonNegative(u.output_tokens);
  if (u.cache_read_input_tokens !== undefined)
    state.usage.cacheRead = nonNegative(u.cache_read_input_tokens);
  if (u.cache_creation?.ephemeral_5m_input_tokens !== undefined) {
    state.usage.cacheWrite5m = nonNegative(u.cache_creation.ephemeral_5m_input_tokens);
  }
  if (u.cache_creation?.ephemeral_1h_input_tokens !== undefined) {
    state.usage.cacheWrite1h = nonNegative(u.cache_creation.ephemeral_1h_input_tokens);
  }
  // Prefer the explicit aggregate; derive it from the TTL split when only the
  // split was reported. The derivation reads the RETAINED state, not just
  // this event's values — a gateway may report the 5m bucket on
  // message_start and the 1h bucket on message_delta, in which case the
  // aggregate must be the sum of both. Once an explicit aggregate has been
  // seen, stop deriving: a later partial split must not clobber the
  // authoritative figure with a smaller sum. Absent buckets stay absent on
  // the canonical Usage (never fabricated zeros — see the partial-TTL pinning
  // test), so the split-presence signal downstream is preserved.
  if (u.cache_creation_input_tokens !== undefined) {
    state.usage.cacheWrite = nonNegative(u.cache_creation_input_tokens);
    state.cacheWriteFromAggregate = true;
  } else if (
    !state.cacheWriteFromAggregate &&
    (state.usage.cacheWrite5m !== undefined || state.usage.cacheWrite1h !== undefined)
  ) {
    state.usage.cacheWrite = (state.usage.cacheWrite5m ?? 0) + (state.usage.cacheWrite1h ?? 0);
  }
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

export interface AnthropicStreamState {
  model: string;
  usage: Usage;
  stopReason: StopReason;
  started: boolean;
  stopped: boolean;
  /** Live provider id (alias-aware) for errors raised mid-stream. */
  providerId?: string | undefined;
  /**
   * Set once `message_delta` carries a `stop_reason` — the model finished and
   * only the closing `message_stop` frame is outstanding. Distinguishes a
   * gateway that merely omits `message_stop` from a connection cut mid-reply.
   */
  sawStopReason?: boolean | undefined;
  /**
   * Provenance: true once any event supplied an explicit
   * `cache_creation_input_tokens` aggregate. While true, the TTL-split
   * derivation in `mergeAnthropicUsage` must not overwrite
   * `usage.cacheWrite` — the gateway's authoritative aggregate outranks any
   * sum derived from the (possibly partial) ephemeral buckets on later
   * events. Optional so external constructors of this state stay valid;
   * undefined behaves as false.
   */
  cacheWriteFromAggregate?: boolean | undefined;
  // `chunks` accumulates tool-call `input_json_delta` fragments; joined once at
  // content_block_stop. Array-of-chunks avoids O(n²) string concatenation for
  // large tool inputs delivered as many small deltas (mirrors presets/openai.ts).
  blocks: Map<
    number,
    {
      kind: BlockKind;
      id?: string | undefined;
      name?: string | undefined;
      chunks: string[];
      initialInput?: unknown;
    }
  >;
}

const DEFAULT_VERSION = '2023-06-01';

/**
 * `providerMeta` key carrying a `redacted_thinking` block's opaque `data`.
 * The canonical ThinkingBlock has no field for it; without round-tripping it
 * the block vanished from history, and Anthropic rejects a thinking-enabled
 * tool-use continuation whose prior assistant turn lost its thinking blocks.
 */
export const ANTHROPIC_REDACTED_THINKING_META = 'anthropic.redactedThinking';

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
  buildBody: (req: Request, ctx: BuildBodyContext) => {
    // Anthropic's Messages API REQUIRES `max_tokens`, so this is the one wire
    // format that cannot simply omit the field when nothing is known — hence
    // the `Required` variant with its documented last resort.
    const maxOutput = resolveRequiredMaxOutputTokens(req, ctx);
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: maxOutput,
      messages: req.messages.map((m: Message) => ({
        role: m.role === 'system' ? 'user' : m.role,
        content: normalizeMessageContent(m, ctx?.capabilities),
      })),
      stream: true,
    };
    if (req.system && req.system.length > 0) {
      // Always emit fresh, field-allowlisted objects (never the shared
      // ctx.systemPrompt block references): the breakpoint cap below mutates
      // cache_control in place, and any builder-side metadata must not leak.
      body['system'] = req.system.map((b) => {
        const out: Record<string, unknown> = { type: 'text', text: b.text };
        if (b.cache_control) out['cache_control'] = b.cache_control;
        return out;
      });
    }
    // Honor the configured cache `ttl` on the DEEPEST marker of the request —
    // the conversation boundary inside `messages` when one exists (that prefix
    // is the bulk of the request and the one worth keeping across turn gaps),
    // else the last marked system block. The old placement — forced onto the
    // last system block unconditionally — predates the message-tail boundary
    // and would pin a 1h cache write to a shallower prefix than we cache.
    if (req.cache?.ttl) {
      const target = findDeepestMarkedBlock(body);
      if (target) target['cache_control'] = { type: 'ephemeral', ttl: req.cache.ttl };
    }
    if (req.tools && req.tools.length > 0) body['tools'] = toolsToAnthropic(req.tools);
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    if (req.topK !== undefined) body['top_k'] = req.topK;
    if (req.stopSequences) body['stop_sequences'] = req.stopSequences;
    if (req.toolChoice) body['tool_choice'] = req.toolChoice;
    if (req.user) body['metadata'] = { user_id: req.user };
    if (req.reasoning) {
      if (req.reasoning.enabled === false || req.reasoning.effort === 'none') {
        body['thinking'] = { type: 'disabled' };
      } else if (req.reasoning.enabled === true || req.reasoning.effort !== undefined) {
        // An effort-only request (no explicit `enabled`) means the caller
        // wants thinking at that level — the Anthropic wire has no effort
        // enum, only a budget, so treating effort as "enable + size" is the
        // only way the setting can take effect. Previously such requests
        // sent no thinking field at all and the user's effort was a no-op
        // (only OpenCode Go's Qwen path worked around it, locally).
        // `effort: 'none'` is handled above: it canonically means OFF, not
        // "enable with the smallest budget".
        const budget = deriveThinkingBudget(maxOutput, req.reasoning.effort);
        if (budget !== undefined) {
          body['thinking'] = {
            type: 'enabled',
            budget_tokens: budget,
          };
          // Anthropic requires temperature to be 1.0 (or omitted) and top_p/top_k
          // to be unset when thinking is enabled. Leaving a non-1.0 temperature or
          // top_p will cause Anthropic to reject the request with 400 invalid_request.
          delete body['temperature'];
          delete body['top_p'];
          delete body['top_k'];
        }
      }
    }
    // Enforce Anthropic's global 4-breakpoint ceiling across tools+system+
    // messages. No-op when ≤4 markers; drops redundant middle breakpoints only.
    capAnthropicCacheBreakpoints(body);
    return body;
  },
  createStreamState: (fallbackModel, providerId) => ({
    model: fallbackModel,
    usage: { input: 0, output: 0 },
    stopReason: 'end_turn',
    started: false,
    stopped: false,
    providerId,
    blocks: new Map(),
  }),
  parseStreamEvent: (msg, state): StreamEvent[] => {
    if (msg.data === '[DONE]') {
      // Not part of Anthropic's protocol, but OpenAI-style gateways fronting
      // the Messages API append it — an explicit end-of-stream all the same.
      state.sawStopReason = true;
      return [];
    }
    if (!msg.data) return [];
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
              usage?: AnthropicUsageWire | undefined;
            }
          | undefined;
        if (message?.model) state.model = message.model;
        state.usage = { input: 0, output: 0 };
        mergeAnthropicUsage(state, message?.usage);
        if (!state.started) {
          state.started = true;
          out.push({ type: 'message_start', model: state.model });
        }
        break;
      }
      case 'content_block_start': {
        const index = Number(ev['index'] ?? 0);
        const cb = ev['content_block'] as
          | {
              type?: string | undefined;
              id?: string | undefined;
              name?: string | undefined;
              input?: unknown;
            }
          | undefined;
        if (cb?.type === 'tool_use') {
          state.blocks.set(index, {
            kind: 'tool_use',
            id: cb.id,
            name: cb.name,
            chunks: [],
            initialInput: cb.input,
          });
          if (cb.id && cb.name) {
            out.push({ type: 'tool_use_start', id: cb.id, name: cb.name });
          }
        } else if (cb?.type === 'text') {
          state.blocks.set(index, { kind: 'text', chunks: [] });
        } else if (cb?.type === 'redacted_thinking') {
          state.blocks.set(index, { kind: 'thinking', chunks: [] });
          const data = (cb as { data?: unknown }).data;
          out.push(
            typeof data === 'string' && data.length > 0
              ? {
                  type: 'thinking_start',
                  providerMeta: { [ANTHROPIC_REDACTED_THINKING_META]: data },
                }
              : { type: 'thinking_start' },
          );
        } else if (cb?.type === 'thinking') {
          state.blocks.set(index, { kind: 'thinking', chunks: [] });
          out.push({ type: 'thinking_start' });
        } else {
          state.blocks.set(index, { kind: 'unknown', chunks: [] });
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
            block.chunks.push(delta.partial_json);
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
          // Canonical Anthropic starts with {} then streams the object. Some
          // compatible gateways supply the full arguments on the start event.
          // Deltas remain authoritative when present; never discard start-only input.
          const raw =
            block.chunks.length > 0
              ? block.chunks.join('')
              : typeof block.initialInput === 'string'
                ? block.initialInput
                : JSON.stringify(block.initialInput);
          const input = parseToolInput(raw);
          out.push({ type: 'tool_use_stop', id: block.id, input });
        } else if (block?.kind === 'thinking') {
          out.push({ type: 'thinking_stop' });
        }
        break;
      }
      case 'message_delta': {
        const delta = ev['delta'] as { stop_reason?: string | null | undefined } | undefined;
        const u = ev['usage'] as AnthropicUsageWire | undefined;
        if (delta?.stop_reason !== undefined) {
          state.stopReason = normalizeAnthropic(delta.stop_reason);
          if (delta.stop_reason !== null) state.sawStopReason = true;
        }
        // Canonical Anthropic sends only `output_tokens` here, but
        // Anthropic-compatible gateways may report the authoritative usage
        // (including cache telemetry) on this final event. Merge rather than
        // overwrite so both shapes surface their cache numbers.
        mergeAnthropicUsage(state, u);
        break;
      }
      case 'message_stop':
        state.stopped = true;
        out.push({ type: 'message_stop', stopReason: state.stopReason, usage: state.usage });
        break;
      case 'error':
        // Mid-stream errors are mostly capacity signals (`overloaded_error`
        // is Anthropic's documented in-stream 529). Classify them like the
        // HTTP path does instead of hard-coding non-retryable, which turned a
        // transient overload into a dead turn with no retry and no fallback.
        throw providerErrorFromStreamPayload(state.providerId ?? 'anthropic', ev);
    }
    return out;
  },
  // Started, but the connection closed before both `message_stop` and a
  // `message_delta.stop_reason` → the reply was cut mid-stream. Surface a
  // retryable error instead of committing the partial text as a clean end_turn.
  // A stop_reason alone is enough to accept the turn: some Anthropic-compatible
  // gateways never send the closing `message_stop` frame.
  isTruncated: (state) => state.started && !state.stopped && !state.sawStopReason,
  finalizeStream: (state): StreamEvent[] => {
    // If upstream closed without an explicit `message_stop` (but after a
    // stop_reason) we synthesize one so the consumer's stream-end logic fires.
    if (state.started && !state.stopped) {
      return [{ type: 'message_stop', stopReason: state.stopReason, usage: state.usage }];
    }
    return [];
  },
});

/**
 * Derive a thinking budget_tokens value for Anthropic's extended thinking.
 * Mirrors the same-named helper in ../anthropic.ts.
 *
 * Returns `undefined` when `maxTokens` cannot hold a legal budget: the API
 * requires `budget_tokens >= 1024` AND `budget_tokens < max_tokens`. The
 * smallest workable cap is therefore 1025 (budget exactly 1024). For anything
 * smaller there is no value satisfying both, and emitting one anyway would 400
 * every such request. Callers must omit the `thinking` field in that case.
 */
function deriveThinkingBudget(
  maxTokens: number,
  effort: ReasoningEffort | undefined,
): number | undefined {
  if (maxTokens < 1025) return undefined; // budget must be >=1024 AND < max_tokens

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
function redactedThinkingData(b: ContentBlock): string | undefined {
  if (b.type !== 'thinking') return undefined;
  const data = b.providerMeta?.[ANTHROPIC_REDACTED_THINKING_META];
  return typeof data === 'string' && data.length > 0 ? data : undefined;
}

function normalizeMessageContent(m: Message, capabilities: Capabilities | undefined): unknown {
  if (typeof m.content === 'string') return m.content;
  return (
    (m.content as ContentBlock[])
      // A thinking block with no text is rejected outright
      // ("content[].thinking.thinking: cannot be empty"). Other wires legitimately
      // produce one — the Codex Responses wire returns reasoning whose value is
      // the encrypted payload in `providerMeta`, with the summary text often
      // empty — and a history built there can reach Anthropic through a `/model`
      // switch or a fallback hop. Dropping it is the correct translation: the
      // payload means nothing to this provider anyway.
      .filter(
        (b) =>
          b.type !== 'thinking' || b.thinking.length > 0 || redactedThinkingData(b) !== undefined,
      )
      .map((b) => sanitizeAnthropicBlock(b, capabilities))
  );
}

/**
 * Locate the wire block whose `cache_control` marks the request's deepest
 * cached prefix: the last marked block inside `messages` (the conversation
 * boundary), else the last marked `system` block, else — preserving the old
 * "ttl always applies" contract for marker-less embedder prompts — the last
 * system block outright. Returns the mutable wire object or undefined.
 *
 * INTENTIONAL MARKER ADDITION (B7): when no system or message block carries
 * `cache_control`, the fallback returns the last system block *without* a
 * marker — the caller (`ttl` placement at the call site) then stamps it with
 * `cache_control + ttl`, effectively adding a new breakpoint to the wire.
 * This is deliberate (keeps the "ttl always pins something" contract for
 * embedders that don't emit their own markers), but it means the total
 * marker count on the wire can exceed what the embedder produced — which
 * feeds the pinned-overflow scenario in `capAnthropicCacheBreakpoints`.
 * The cap runs *after* this step and owns the final count.
 */
function findDeepestMarkedBlock(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const messages = body['messages'];
  if (Array.isArray(messages)) {
    for (let m = messages.length - 1; m >= 0; m--) {
      const content = (messages[m] as Record<string, unknown> | null)?.['content'];
      if (!Array.isArray(content)) continue;
      for (let i = content.length - 1; i >= 0; i--) {
        const block = content[i] as Record<string, unknown> | null;
        if (block?.['cache_control']) return block;
      }
    }
  }
  const system = body['system'];
  if (Array.isArray(system) && system.length > 0) {
    for (let i = system.length - 1; i >= 0; i--) {
      const block = system[i] as Record<string, unknown> | null;
      if (block?.['cache_control']) return block;
    }
    return system[system.length - 1] as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Reduce a canonical ContentBlock to exactly the fields the Anthropic Messages
 * API accepts. Strips extra fields that other wires inject:
 *   - `tool_result.name`        — set by ToolExecutor for Google's functionResponse
 *   - `tool_use.providerMeta`   — e.g. Gemini thought-signatures
 *   - `thinking.providerMeta`   — provider-specific metadata
 */
function sanitizeAnthropicBlock(
  b: ContentBlock,
  capabilities: Capabilities | undefined,
): Record<string, unknown> {
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
      // The request composer pins the conversation cache boundary on the
      // trailing durable block, which is usually a tool_result. Anthropic
      // accepts cache_control on tool_result blocks; other wires rebuild
      // their tool messages explicitly and never see this field.
      if (b.cache_control) out['cache_control'] = b.cache_control;
      return out;
    }
    case 'thinking': {
      const redacted = redactedThinkingData(b);
      if (redacted !== undefined) return { type: 'redacted_thinking', data: redacted };
      return b.signature
        ? { type: 'thinking', thinking: b.thinking, signature: b.signature }
        : { type: 'thinking', thinking: b.thinking };
    }
    case 'image': {
      const fallback = imageInputFallback(b, { allowImages: capabilities?.vision !== false });
      return fallback ? { type: 'text', text: fallback } : { type: 'image', source: b.source };
    }
    case 'document': {
      const fallback = documentInputFallback(b, capabilities?.pdf !== false);
      return fallback
        ? { type: 'text', text: fallback }
        : { type: 'document', source: b.source, ...(b.name ? { title: b.name } : {}) };
    }
    default:
      return b as never as Record<string, unknown>;
  }
}
