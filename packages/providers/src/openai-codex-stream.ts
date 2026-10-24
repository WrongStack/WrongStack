import {
  classifyProviderError,
  isRetryableKind,
  ProviderError,
  type StopReason,
  type StreamEvent,
  type Usage,
} from '@wrongstack/contracts/types';
import { recordProviderQuota } from '@wrongstack/core/quota';
import { scrubErrorText } from '@wrongstack/core/security';
import { safeParse } from '@wrongstack/core/utils';
import { parseToolInput } from './_tool-input.js';
import type { CodexResponseMetadata } from './codex-websocket.js';
import {
  parseProviderErrorBody,
  safetyRefusalMessage,
  scrubProviderErrorBody,
} from './error-parse.js';
import { parseCodexRateLimitEvent } from './openai-codex-rate-limits.js';
import { responsesReasoningSummary } from './responses-reasoning-summary.js';

import { createSseLineFoldingTransform, parseSSE } from './sse.js';
import {
  CODEX_REASONING_ENCRYPTED_META,
  CODEX_REASONING_ID_META,
  CODEX_REASONING_SUMMARY_META,
  CODEX_TOOL_ARGUMENTS_META,
} from './tool-format/to-responses.js';

// ── Responses SSE → StreamEvent ──────────────────────────────────────────────

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface StreamingArgBuffer {
  chunks: string[];
  length: number;
}

function appendArgChunk(buf: StreamingArgBuffer, chunk: string): void {
  if (chunk.length === 0) return;
  buf.chunks.push(chunk);
  buf.length += chunk.length;
}

function joinArgBuffer(buf: StreamingArgBuffer): string {
  return buf.chunks.length === 1 ? (buf.chunks[0] ?? '') : buf.chunks.join('');
}

/**
 * Join the text of a Responses `message` item's `content` array. The backend
 * echoes assistant prose as `content: [{ type: 'output_text', text }, ...]`
 * (and refusals as `{ type: 'refusal', refusal }`). Returns the concatenated
 * text, or '' for any non-message / malformed shape.
 */
function extractOutputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const p = part as { type?: unknown; text?: unknown; refusal?: unknown };
    if ((p.type === 'output_text' || p.type === 'text') && typeof p.text === 'string') {
      out += p.text;
    } else if (p.type === 'refusal' && typeof p.refusal === 'string') {
      out += p.refusal;
    }
  }
  return out;
}

/** The `content_index` of a text delta/done event; events without one address part 0. */
function contentPartIndex(evt: Record<string, unknown>): number {
  const index = evt['content_index'];
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : 0;
}

/**
 * Read a response-metadata event, whichever dialect the backend used.
 *
 * The live ChatGPT WebSocket sends `{ type: 'codex.response.metadata',
 * headers: {...} }` — the headers sit at the TOP LEVEL, not under a `metadata`
 * envelope. Upstream documents the same two shapes ("`response.headers` for
 * standard Responses stream events; top-level `headers` for websocket metadata
 * events") and accepts both event names.
 *
 * This mattered more than a parsing nicety: after the handshake a WebSocket has
 * no HTTP response headers, so this frame is the only delivery of
 * `x-codex-turn-state` and `x-models-etag` for every turn of a WebSocket
 * session — which is the default transport. Matching only the envelope dialect
 * left both silently unread there.
 */
function responseMetadataFromEvent(
  evt: Record<string, unknown>,
): CodexResponseMetadata | undefined {
  const raw =
    (evt['metadata'] as Record<string, unknown> | undefined) ??
    ((evt['response'] as Record<string, unknown> | undefined)?.['metadata'] as
      | Record<string, unknown>
      | undefined) ??
    evt;
  if (!raw || typeof raw !== 'object') return undefined;
  const rawHeaders = raw['headers'];
  if (!rawHeaders || typeof rawHeaders !== 'object') return undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) headers[name.toLowerCase()] = value;
  }
  if (Object.keys(headers).length === 0) return undefined;
  const requestId =
    typeof raw['request_id'] === 'string'
      ? raw['request_id']
      : typeof raw['requestId'] === 'string'
        ? raw['requestId']
        : undefined;
  const model = typeof raw['model'] === 'string' ? raw['model'] : undefined;
  return { headers, ...(requestId ? { requestId } : {}), ...(model ? { model } : {}) };
}

export async function* parseOpenAIResponsesStream(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
  fallbackModel: string,
  providerId = 'openai-codex',
  onResponseMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined,
  onReasoningUsage?: ((tokens: number | undefined) => void) | undefined,
  options: ResponsesStreamOptions = {},
): AsyncIterable<StreamEvent> {
  const { onWrappedHttpError } = options;
  let model = fallbackModel;
  let started = false;
  // The model the backend says actually served the request. Reported once, and
  // only when it differs from the requested slug (case-insensitively, as the
  // official client compares): every request of a rerouted account carries it.
  let rerouteReported = false;
  const reroute = (served: string | undefined): StreamEvent | undefined => {
    if (rerouteReported || !served) return undefined;
    if (served.toLowerCase() === fallbackModel.toLowerCase()) return undefined;
    rerouteReported = true;
    return {
      type: 'model_rerouted',
      requested: fallbackModel,
      served,
      ...(options.rerouteReason ? { reason: options.rerouteReason } : {}),
    };
  };
  let usage: Usage = { input: 0, output: 0 };
  let stopReason: StopReason = 'end_turn';
  let sawToolUse = false;
  // Set once a terminal envelope (`response.completed`/`response.incomplete`,
  // or `[DONE]`) is seen. If the stream closes without one after we started,
  // the response was cut mid-stream and must surface as retryable.
  let sawTerminal = false;
  let sawTerminalEnvelope = false;

  // Server id of the reasoning item currently streaming, so its encrypted
  // payload can be paired with it when the item closes.
  let reasoningItemId: string | undefined;

  // Currently-streaming function call (Responses streams one item at a time).
  let toolCallId: string | undefined;
  let toolArgBuf: StreamingArgBuffer = { chunks: [], length: 0 };

  // Assistant-text recovery. The ChatGPT Responses backend does not always
  // stream a message's text as `output_text.delta` chunks — reasoning turns
  // (gpt-5-codex) frequently deliver the full text only in the terminal
  // `response.output_text.done` (`text`) or the message `output_item.done`
  // (`content[].text`) events. We count how many text chars we have already
  // emitted for the current message item; the terminal events then emit ONLY
  // the un-streamed remainder, so a fully-streamed message adds nothing and a
  // never-streamed one is recovered in full — no duplication either way.
  let msgTextStreamed = 0;
  // Per content part (`content_index`) of the current message item:
  // `output_text.done` carries ONE part's text, so it is compared against that
  // part's own count — never the whole message's.
  let msgPartStreamed = new Map<number, number>();
  const flushRemainingText = (full: string, part?: number): StreamEvent | undefined => {
    const streamed = part === undefined ? msgTextStreamed : (msgPartStreamed.get(part) ?? 0);
    if (full.length <= streamed) return undefined;
    const remainder = full.slice(streamed);
    if (part === undefined) {
      msgTextStreamed = full.length;
    } else {
      msgPartStreamed.set(part, full.length);
      msgTextStreamed += remainder.length;
    }
    return { type: 'text_delta', text: remainder };
  };

  const ensureStart = (): StreamEvent | undefined => {
    if (started) return undefined;
    started = true;
    return { type: 'message_start', model };
  };

  // The ChatGPT-backend Responses API occasionally emits a single `data:`
  // field (typically a `response.completed` envelope echoing large input, or
  // a `function_call` with multi-KB JSON `arguments`) that exceeds parseSSE's
  // 256 KiB safety cap. We fold any oversized `data:` line into multiple
  // JSON-safe continuation lines before handing the stream to the parser —
  // the parser then rejoins them via `dataLines.join('\n')` and JSON.parse
  // reconstructs the original object. Wrapped only when the body is a Web
  // ReadableStream; Node streams hit the existing path unchanged.
  const foldedBody =
    body && typeof (body as ReadableStream<Uint8Array>).getReader === 'function'
      ? createSseLineFoldingTransform(body as ReadableStream<Uint8Array>)
      : body;
  for await (const msg of parseSSE(foldedBody)) {
    if (msg.data === '[DONE]') {
      sawTerminal = true;
      continue;
    }
    if (!msg.data) continue;
    const parsed = safeParse<Record<string, unknown>>(msg.data);
    if (!parsed.ok || !parsed.value) continue;
    const evt = parsed.value;
    const type = typeof evt['type'] === 'string' ? (evt['type'] as string) : '';
    // Server model: the transport's own response headers (HTTP, WebSocket
    // handshake), then any event carrying `response.headers` or — on metadata
    // frames — top-level `headers`, in the official client's precedence.
    const rerouted = reroute(
      options.servedModel?.() ??
        servedModelFromHeaders(
          (evt['response'] as Record<string, unknown> | undefined)?.['headers'],
        ) ??
        servedModelFromHeaders(evt['headers']) ??
        servedModelFromHeaders(
          (evt['metadata'] as Record<string, unknown> | undefined)?.['headers'],
        ),
    );
    if (rerouted) yield rerouted;

    switch (type) {
      case 'response.metadata':
      case 'codex.response.metadata': {
        const metadata = responseMetadataFromEvent(evt);
        if (metadata) onResponseMetadata?.(metadata);
        break;
      }

      case 'response.created':
      case 'response.in_progress': {
        const resp = evt['response'] as { model?: string } | undefined;
        if (typeof resp?.model === 'string') model = resp.model;
        const s = ensureStart();
        if (s) yield s;
        break;
      }

      case 'response.output_item.added': {
        const s = ensureStart();
        if (s) yield s;
        const item = evt['item'] as
          | {
              type?: string;
              id?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
              content?: unknown;
            }
          | undefined;
        if (!item) break;
        if (item.type === 'reasoning') {
          // Keep the server's item id on the block. Replaying a reasoning item
          // needs BOTH the id and the encrypted payload (which only arrives on
          // `output_item.done`), so the id is stashed now and the payload is
          // attached below as the block's signature.
          reasoningItemId = typeof item.id === 'string' ? item.id : undefined;
          yield reasoningItemId
            ? {
                type: 'thinking_start',
                providerMeta: { [CODEX_REASONING_ID_META]: reasoningItemId },
              }
            : { type: 'thinking_start' };
        } else if (item.type === 'function_call') {
          toolCallId = item.call_id ?? item.id ?? `call_${Math.random().toString(36).slice(2)}`;
          toolArgBuf = { chunks: [], length: 0 };
          if (item.arguments) appendArgChunk(toolArgBuf, item.arguments);
          sawToolUse = true;
          yield { type: 'tool_use_start', id: toolCallId, name: item.name ?? 'unknown' };
          for (const partial of toolArgBuf.chunks) {
            yield { type: 'tool_use_input_delta', id: toolCallId, partial };
          }
        } else if (item.type === 'message') {
          // A fresh message item begins — reset the per-message text counter so
          // its terminal events emit only its own un-streamed text. Some backends
          // inline the full text on `added` (no deltas at all); recover it now.
          msgTextStreamed = 0;
          msgPartStreamed = new Map();
          const prefilled = extractOutputText(item.content);
          const ev0 = flushRemainingText(prefilled);
          if (Array.isArray(item.content)) {
            item.content.forEach((part, index) => {
              msgPartStreamed.set(index, extractOutputText([part]).length);
            });
          }
          if (ev0) yield ev0;
        }
        break;
      }

      case 'codex.rate_limits': {
        // Some ChatGPT backends restate the quota windows as an SSE event
        // instead of (or in addition to) the response headers. Same numbers,
        // same store — a surface reading the quota must not care which path
        // delivered it.
        const snapshot = parseCodexRateLimitEvent(evt);
        if (snapshot) recordProviderQuota(providerId, [snapshot]);
        break;
      }

      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const delta = typeof evt['delta'] === 'string' ? (evt['delta'] as string) : '';
        if (delta) {
          const part = contentPartIndex(evt);
          msgTextStreamed += delta.length;
          msgPartStreamed.set(part, (msgPartStreamed.get(part) ?? 0) + delta.length);
          yield { type: 'text_delta', text: delta };
        }
        break;
      }

      case 'response.output_text.done': {
        // Terminal text event carrying the full message text. Emit only the
        // remainder we have not already streamed (nothing when deltas covered
        // it; the whole text when the backend skipped deltas entirely).
        const full = typeof evt['text'] === 'string' ? (evt['text'] as string) : '';
        const ev1 = flushRemainingText(full, contentPartIndex(evt));
        if (ev1) yield ev1;
        break;
      }

      case 'response.reasoning_text.delta':
      case 'response.reasoning_summary_text.delta': {
        const delta = typeof evt['delta'] === 'string' ? (evt['delta'] as string) : '';
        if (delta) yield { type: 'thinking_delta', text: delta };
        break;
      }

      case 'response.function_call_arguments.delta': {
        const delta = typeof evt['delta'] === 'string' ? (evt['delta'] as string) : '';
        if (toolCallId && delta) {
          appendArgChunk(toolArgBuf, delta);
          yield { type: 'tool_use_input_delta', id: toolCallId, partial: delta };
        }
        break;
      }

      case 'response.function_call_arguments.done': {
        // Final arguments authoritative — captured at output_item.done below.
        const args =
          typeof evt['arguments'] === 'string' ? (evt['arguments'] as string) : undefined;
        if (args !== undefined) {
          toolArgBuf = { chunks: [args], length: args.length };
        }
        break;
      }

      case 'response.output_item.done': {
        const item = evt['item'] as
          | {
              type?: string;
              id?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
              content?: unknown;
            }
          | undefined;
        if (!item) break;
        if (item.type === 'reasoning') {
          const encrypted = (item as { encrypted_content?: unknown }).encrypted_content;
          const summary = (item as { summary?: unknown }).summary;
          const itemId = reasoningItemId ?? (typeof item.id === 'string' ? item.id : undefined);
          if (typeof encrypted === 'string' && encrypted.length > 0 && itemId) {
            yield {
              type: 'thinking_meta',
              providerMeta: {
                [CODEX_REASONING_ID_META]: itemId,
                [CODEX_REASONING_ENCRYPTED_META]: encrypted,
                ...(Array.isArray(summary)
                  ? { [CODEX_REASONING_SUMMARY_META]: responsesReasoningSummary(summary) }
                  : {}),
              },
            };
          }
          reasoningItemId = undefined;
          yield { type: 'thinking_stop' };
        } else if (item.type === 'function_call') {
          const id = item.call_id ?? toolCallId ?? `call_${Math.random().toString(36).slice(2)}`;
          const raw =
            item.arguments && item.arguments.length > 0
              ? item.arguments
              : joinArgBuffer(toolArgBuf);
          yield {
            type: 'tool_use_stop',
            id,
            input: parseToolInput(raw || '{}'),
            providerMeta: { [CODEX_TOOL_ARGUMENTS_META]: raw || '{}' },
          };
          toolCallId = undefined;
          toolArgBuf = { chunks: [], length: 0 };
        } else if (item.type === 'message') {
          // Final safety net: recover any message text the backend delivered
          // only in the completed item's `content` (no deltas, no
          // output_text.done). flushRemainingText dedupes against what we
          // already streamed, so this is a no-op on the normal delta path.
          const full = extractOutputText(item.content);
          const ev2 = flushRemainingText(full);
          if (ev2) yield ev2;
        }
        break;
      }

      case 'response.completed':
      case 'response.incomplete':
      // The WebSocket transport treats `response.done` as terminal and ends the
      // frame queue on it; without a case here the parser then reported the
      // finished response as truncated (retryable 599) and dropped its usage.
      case 'response.done': {
        sawTerminalEnvelope = true;
        const resp = evt['response'] as { status?: string; usage?: ResponsesUsage } | undefined;
        if (evt['type'] === 'response.done' && resp?.status === 'failed') {
          const errorBody = parseProviderErrorBody(JSON.stringify(evt));
          const status = responseFailureStatus(
            errorBody.type,
            errorBody.message,
            undefined,
            errorBody.code,
          );
          const rawMessage = errorBody.message ?? 'OpenAI Responses request failed';
          const kind = classifyProviderError(status, errorBody, rawMessage);
          throw new ProviderError(
            safetyRefusalMessage(errorBody) ?? scrubErrorText(rawMessage),
            status,
            isRetryableKind(kind),
            providerId,
            {
              body: scrubProviderErrorBody(errorBody),
              kind,
            },
          );
        }
        if (resp?.usage) {
          usage = normalizeUsage(resp.usage);
          const reasoning = resp.usage.output_tokens_details?.reasoning_tokens;
          onReasoningUsage?.(
            typeof reasoning === 'number' && Number.isFinite(reasoning) && reasoning >= 0
              ? reasoning
              : undefined,
          );
          // A usage-bearing terminal envelope must never silently drop its
          // telemetry, even when the backend skipped every start-producing
          // event (`response.created`/`in_progress`/`output_item.added`):
          // emit message_start here so the final `if (started)` yields the
          // paired usage-bearing message_stop. No-op on the normal path where
          // message_start was already emitted.
          const s = ensureStart();
          if (s) yield s;
        }
        stopReason = mapResponsesStatus(
          resp?.status,
          sawToolUse,
          (resp as { incomplete_details?: { reason?: unknown } } | undefined)?.incomplete_details
            ?.reason,
        );
        sawTerminal = true;
        break;
      }

      case 'error':
      case 'response.failed': {
        // The WebSocket transport delivers an HTTP failure as a frame —
        // `{"type":"error","status":429,"error":{…},"headers":{…}}` — and the
        // official client handles it exactly like that HTTP response. Its
        // headers are the only copy of the quota windows and reset times.
        const wrapped = type === 'error' ? wrappedHttpStatus(evt) : undefined;
        if (wrapped !== undefined && onWrappedHttpError) {
          throw onWrappedHttpError(wrapped, JSON.stringify(evt), wrappedHttpHeaders(evt));
        }
        // These are application-level failures delivered over an HTTP 200 SSE
        // stream, not HTTP 502 responses. Parse the entire envelope so the
        // provider's code/message can drive canonical classification (notably
        // context_overflow) and remain available in persisted diagnostics.
        // Serialize once to reuse the shared tolerant parser and preserve its
        // bounded raw-envelope diagnostics instead of duplicating extraction.
        const raw = JSON.stringify(evt);
        const errorBody = parseProviderErrorBody(raw);
        const response = evt['response'] as Record<string, unknown> | undefined;
        const statusCode =
          typeof response?.['status_code'] === 'number' ? response['status_code'] : undefined;
        const status = responseFailureStatus(
          errorBody.type,
          errorBody.message,
          statusCode,
          errorBody.code,
        );
        const rawMessage = errorBody.message ?? 'OpenAI Responses request failed';
        const kind = classifyProviderError(status, errorBody, rawMessage);
        const body = scrubProviderErrorBody(errorBody);
        const message = safetyRefusalMessage(errorBody) ?? scrubErrorText(rawMessage);
        throw new ProviderError(message, status, isRetryableKind(kind), providerId, { body, kind });
      }

      default:
        break;
    }
  }

  if ((started && !sawTerminal) || (options.requireTerminalEnvelope && !sawTerminalEnvelope)) {
    // Output arrived, then the stream closed with no `response.completed` and
    // no `[DONE]` — cut mid-stream. Retryable rather than a synthetic end_turn.
    throw new ProviderError(
      'OpenAI Responses stream ended without a terminal envelope (response.completed/[DONE]) — response truncated mid-stream',
      599,
      true,
      providerId,
      { body: { message: 'stream truncated before completion' } },
    );
  }
  if (started) {
    yield { type: 'message_stop', stopReason, usage };
  }
}

/** Optional hooks for {@link parseOpenAIResponsesStream}. */
export interface ResponsesStreamOptions {
  /** Public ChatGPT plan requests require an explicit terminal Responses envelope. */
  requireTerminalEnvelope?: boolean | undefined;
  /** Maps a WebSocket-wrapped HTTP failure frame onto the provider's HTTP error. */
  onWrappedHttpError?: WrappedHttpErrorHandler | undefined;
  /** The served model from transport headers the parser never sees (HTTP, WS handshake). */
  servedModel?: (() => string | undefined) | undefined;
  /** Explanation attached to a `model_rerouted` event. */
  rerouteReason?: string | undefined;
}

/** `openai-model` / `x-openai-model` from a JSON header map, as the official client reads it. */
function servedModelFromHeaders(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const lower = name.toLowerCase();
    if ((lower === 'openai-model' || lower === 'x-openai-model') && typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

/** Turns a WebSocket-wrapped HTTP failure into the provider's HTTP error. */
export type WrappedHttpErrorHandler = (
  status: number,
  rawText: string,
  headers: Headers | undefined,
) => ProviderError;

function wrappedHttpStatus(evt: Record<string, unknown>): number | undefined {
  const status = evt['status'] ?? evt['status_code'];
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
}

function wrappedHttpHeaders(evt: Record<string, unknown>): Headers | undefined {
  const raw = evt['headers'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      continue;
    }
    try {
      headers.set(name, String(value));
    } catch {
      // An invalid header name or value is skipped, as the official client does.
    }
  }
  return headers;
}

function responseFailureStatus(
  type: string | undefined,
  message: string | undefined,
  statusCode?: number,
  code?: string,
): number {
  if (statusCode !== undefined) return statusCode;
  // Streaming errors may have no HTTP status; preserve the documented plan error semantics.
  if (code === 'subscription_sharing_usage_limit_exceeded') return 429;
  if (
    code === 'subscription_sharing_usage_unavailable' ||
    code === 'subscription_sharing_user_unavailable'
  )
    return 503;
  if (
    code === 'subscription_sharing_user_not_eligible' ||
    code === 'subscription_sharing_route_not_supported' ||
    code === 'chatpass_v2_scope_not_authorized' ||
    code === 'chatpass_v2_invalid_authorization_context'
  )
    return 403;
  if (code === 'subscription_sharing_invalid_user') return 401;
  if (code === 'subscription_sharing_unsupported_capability') return 400;
  const text = `${type ?? ''}\n${message ?? ''}`;
  if (/rate.?limit/i.test(text)) return 429;
  if (/insufficient.quota|quota.exhausted/i.test(text)) return 402;
  if (/overload|server_error|internal_error/i.test(text)) return 529;

  const kind = classifyProviderError(400, { type, message }, message);
  switch (kind) {
    case 'context_overflow':
      return 413;
    case 'quota_exhausted':
      return 402;
    case 'auth':
      return 401;
    case 'content_filter':
    case 'invalid_request':
      return 400;
    default:
      return 502;
  }
}

function normalizeUsage(u: ResponsesUsage): Usage {
  const cached = nonNegative(u.input_tokens_details?.cached_tokens);
  const cacheWrite = nonNegative(u.input_tokens_details?.cache_write_tokens);
  const total = nonNegative(u.input_tokens);
  return {
    input: Math.max(0, total - cached - cacheWrite),
    output: nonNegative(u.output_tokens),
    cacheRead: cached || undefined,
    cacheWrite: cacheWrite || undefined,
  };
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function mapResponsesStatus(
  status: string | undefined,
  sawToolUse: boolean,
  incompleteReason?: unknown,
): StopReason {
  // `incomplete` is a filter block as well as a token cut-off; chat
  // completions' `content_filter` already maps to `refusal`.
  if (status === 'incomplete') {
    return incompleteReason === 'content_filter' ? 'refusal' : 'max_tokens';
  }
  // 'completed' (and anything else benign) → tool_use when a call was emitted.
  return sawToolUse ? 'tool_use' : 'end_turn';
}
