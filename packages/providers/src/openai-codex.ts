/**
 * `openai-codex` wire family — the ChatGPT-backend Responses API.
 *
 * This is the transport used by "Sign in with ChatGPT" (OAuth) credentials.
 * It speaks the OpenAI **Responses** wire format (NOT chat/completions) and
 * targets `https://chatgpt.com/backend-api/codex/responses`, authenticating
 * with the OAuth access token + `chatgpt-account-id` header. It deliberately
 * leaves the API-key `openai` family (api.openai.com/chat/completions)
 * untouched — the two coexist as separate providers.
 *
 * Token lifecycle: the access token is short-lived. This adapter refreshes it
 * transparently — before a request when it is near expiry, and once more on a
 * 401 — using the stored refresh token, then invokes `onRefresh` so the CLI
 * can persist the rotated tokens back to the vault.
 *
 * The refresh endpoint + client id are duplicated here (rather than imported
 * from the CLI) to respect the package layering: `providers` must not depend
 * on `cli`. They are tiny constants that match the CLI login module.
 */

import {
  type Capabilities,
  classifyProviderError,
  FetchError,
  isRetryableKind,
  ParseError,
  ProviderError,
  type ReasoningEffort,
  type Request,
  type StopReason,
  type StreamEvent,
  type Usage,
} from '@wrongstack/core/types';
import { scrubErrorText } from '@wrongstack/core/security';
import { safeParse } from '@wrongstack/core/utils';
import { parseToolInput } from './_tool-input.js';
import {
  type HeadersLike,
  parseProviderErrorBody,
  parseProviderHttpError,
  scrubProviderErrorBody,
} from './error-parse.js';
import { extractAccountId } from './openai-codex-account.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { OAuthRefreshCoordinator } from './oauth-refresh-coordinator.js';
import { applyPromptCacheKey } from './prompt-cache-key.js';
import { createSseLineFoldingTransform, parseSSE } from './sse.js';
import { messagesToResponsesInput, toolsToResponses } from './tool-format/to-responses.js';
import type { BuildBodyContext } from './model-output-limits.js';
import { WireAdapter, type WireAdapterStreamOptions } from './wire-adapter.js';

// ── OAuth refresh constants (mirror packages/cli auth-menu/openai-codex-oauth) ─

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const DEFAULT_CODEX_BASE = 'https://chatgpt.com/backend-api';

export interface CodexOAuthTokens {
  access: string;
  refresh: string;
  /** Absolute expiry in epoch milliseconds. */
  expires: number;
}

/** Refresh an expired Codex access token using its refresh token. */
export async function refreshCodexAccessToken(
  refreshToken: string,
  signal?: AbortSignal,
): Promise<CodexOAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Preserve the real status: FetchError derives `recoverable` from it
    // (429/5xx → true). Hardcoding 401 marked every transient blip (503, 429)
    // as a non-recoverable auth failure, so callers dropped credentials and
    // forced a re-login instead of retrying.
    throw new FetchError({
      message: `Codex token refresh failed (${res.status}): ${text || res.statusText}`,
      status: res.status,
      context: { provider: 'openai-codex' },
    });
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  } | null;
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new ParseError({
      message: 'Codex token refresh response missing fields',
      source: 'openai-codex',
    });
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
  };
}

// extractAccountId lives in openai-codex-account.ts so the oauth entry can
// use it without bundling this provider. Re-exported for API compatibility.
export { extractAccountId } from './openai-codex-account.js';

// ── Provider ────────────────────────────────────────────────────────────────

export interface CodexCredentials {
  /** The OAuth access token (a JWT). */
  accessToken: string;
  /** The refresh token, used to mint a new access token before/at expiry. */
  refreshToken?: string | undefined;
  /** Access-token expiry, epoch ms. When absent, refresh only fires on 401. */
  expiresAt?: number | undefined;
  /** Cached ChatGPT account id. Re-derived from the live token when missing. */
  accountId?: string | undefined;
}

/**
 * Decide what happens to a caller's `req.maxTokens` on the Codex wire.
 *
 * ChatGPT's subscription-backed `/backend-api/codex/responses` surface rejects
 * `max_output_tokens` with HTTP 400, even though the public Responses API
 * accepts it. Always omit the field and let the backend apply the selected
 * model's own output policy.
 *
 * Kept as an exported compatibility helper for existing callers.
 */
export function codexOutputCap(_maxTokens: number | undefined): undefined {
  return undefined;
}

export interface OpenAICodexProviderOptions {
  credentials: CodexCredentials;
  baseUrl?: string | undefined;
  id?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  capabilities?: Partial<Capabilities> | undefined;
  streamOpts?: WireAdapterStreamOptions | undefined;
  /**
   * Persist rotated tokens after a successful refresh. The CLI wires this to
   * write back to the encrypted config so the new access/refresh pair survive
   * the session.
   */
  onRefresh?:
    | ((creds: {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        accountId: string | undefined;
      }) => void)
    | undefined;
  /** Override the refresh call (tests). */
  refreshFn?:
    | ((refreshToken: string, signal?: AbortSignal) => Promise<CodexOAuthTokens>)
    | undefined;
  /**
   * Reasoning effort for the Codex (gpt-5.x) reasoning models. Sent as
   * `reasoning.effort` with `summary: 'auto'` so chain-of-thought streams back
   * as thinking deltas. Request-level reasoning settings override this default.
   * Default 'medium'. Set 'none' to omit reasoning entirely.
   */
  reasoningEffort?: ReasoningEffort | undefined;
}

export class OpenAICodexProvider extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;

  private access: string;
  private refresh: string | undefined;
  private accountId: string | undefined;
  private readonly refreshFn: (
    refreshToken: string,
    signal?: AbortSignal,
  ) => Promise<CodexOAuthTokens>;
  /** Shared OAuth refresh machinery — see packages/providers/src/oauth-refresh-coordinator.ts */
  private readonly refreshCoordinator: OAuthRefreshCoordinator<
    CodexOAuthTokens,
    NonNullable<OpenAICodexProviderOptions['onRefresh']> extends (p: infer P) => void ? P : never
  >;
  private readonly reasoningEffort: ReasoningEffort;

  constructor(opts: OpenAICodexProviderOptions) {
    super(
      opts.credentials.accessToken,
      opts.baseUrl ?? DEFAULT_CODEX_BASE,
      opts.fetchImpl,
      opts.streamOpts,
    );
    this.id = opts.id ?? 'openai-codex';
    this.access = opts.credentials.accessToken;
    this.refresh = opts.credentials.refreshToken;
    this.accountId = opts.credentials.accountId ?? extractAccountId(this.access) ?? undefined;
    this.refreshFn = opts.refreshFn ?? refreshCodexAccessToken;
    this.refreshCoordinator = new OAuthRefreshCoordinator<CodexOAuthTokens, {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
      accountId: string | undefined;
    }>({
      initialRefreshKey: opts.credentials.refreshToken,
      initialExpiresAt: opts.credentials.expiresAt,
      label: 'Codex OAuth',
      hooks: {
        refreshFn: (key, signal) => this.refreshFn(key, signal),
        onRefresh: opts.onRefresh,
        formatPayload: (_tokens, derived) => ({
          accessToken: derived.accessToken,
          refreshToken: derived.refreshKey ?? '',
          expiresAt: derived.expiresAt,
          accountId: this.accountId,
        }),
        projectTokens: (tokens) => ({
          accessToken: tokens.access,
          expiresAt: tokens.expires,
          // Codex rotates its refresh token on every refresh.
          refreshKey: tokens.refresh,
        }),
        applyTokens: (derived) => {
          this.access = derived.accessToken;
          if (derived.refreshKey !== undefined) {
            this.refresh = derived.refreshKey;
          }
          // Re-derive the ChatGPT account id from the new access token, falling
          // back to the cached value if the new JWT lacks the claim.
          this.accountId = extractAccountId(derived.accessToken) ?? this.accountId;
        },
      },
    });
    this.reasoningEffort = opts.reasoningEffort ?? 'medium';
    this.capabilities = capabilitiesForFamily('openai-codex', { ...opts.capabilities });
  }

  override async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    await this.ensureFreshToken(opts.signal);
    try {
      yield* super.stream(req, opts);
    } catch (err) {
      // A 401 means the token went stale between the pre-flight check and the
      // request (or we had no expiry to check). Refresh once and retry — the
      // error is thrown before any StreamEvent is emitted, so no output is
      // duplicated.
      if (err instanceof ProviderError && err.status === 401 && this.refresh) {
        await this.doRefresh(opts.signal);
        yield* super.stream(req, opts);
        return;
      }
      throw err;
    }
  }

  private async ensureFreshToken(signal: AbortSignal): Promise<void> {
    await this.refreshCoordinator.ensureFreshToken(signal);
  }

  private async doRefresh(signal: AbortSignal): Promise<void> {
    await this.refreshCoordinator.doRefresh(signal);
  }

  protected override buildUrl(_req: Request): string {
    return resolveCodexUrl(this.baseUrl);
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    const headers: Record<string, string> = {
      ...super.buildHeaders(_req),
      authorization: `Bearer ${this.access}`,
      originator: 'wrongstack',
      'OpenAI-Beta': 'responses=experimental',
    };
    if (this.accountId) headers['chatgpt-account-id'] = this.accountId;
    return headers;
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    const instructions =
      req.system && req.system.length > 0
        ? req.system.map((b) => b.text).join('\n\n')
        : 'You are a helpful assistant.';

    const body: Record<string, unknown> = {
      model: req.model,
      // The ChatGPT Codex backend rejects `store: true` ("Store must be set to
      // false"). We send the full conversation as `input` each turn.
      store: false,
      stream: true,
      instructions,
      input: messagesToResponsesInput(req.messages),
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: true,
    };

    if (req.tools && req.tools.length > 0) {
      body['tools'] = toolsToResponses(req.tools);
      body['tool_choice'] = mapToolChoice(req.toolChoice);
    }
    // The ChatGPT Codex backend rejects max_output_tokens. This differs from
    // API-key Responses transports, which can forward the caller's cap.
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    if (req.topP !== undefined) body['top_p'] = req.topP;
    const reasoningEffort = req.reasoning?.effort ?? this.reasoningEffort;
    if (req.reasoning?.enabled !== false && reasoningEffort !== 'none') {
      body['reasoning'] = { effort: reasoningEffort, summary: 'auto' };
    }
    // Responses API accepts prompt_cache_key for cache routing (codex caps are
    // cacheControl:'auto'). Best-effort — the field is dropped by backends that
    // don't recognize it.
    applyPromptCacheKey(body, req, ctx?.capabilities);
    return body;
  }

  protected override parseStream(
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    return parseOpenAIResponsesStream(body, fallbackModel, this.id);
  }

  protected override translateError(
    status: number,
    text: string,
    headers?: HeadersLike,
  ): ProviderError {
    return parseProviderHttpError(this.id, status, text, headers);
  }
}

// ── URL + tool-choice helpers ────────────────────────────────────────────────

/** Normalize a base URL to the `/codex/responses` endpoint. */
export function resolveCodexUrl(baseUrl: string | undefined): string {
  const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE;
  const normalized = raw.replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) return normalized;
  if (normalized.endsWith('/codex')) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

function mapToolChoice(
  choice: Request['toolChoice'],
): 'auto' | 'required' | 'none' | { type: 'function'; name: string } {
  if (choice === undefined) return 'auto';
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  return { type: 'function', name: choice.name };
}

// ── Responses SSE → StreamEvent ──────────────────────────────────────────────

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
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

export async function* parseOpenAIResponsesStream(
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
  fallbackModel: string,
  providerId = 'openai-codex',
): AsyncIterable<StreamEvent> {
  let model = fallbackModel;
  let started = false;
  let usage: Usage = { input: 0, output: 0 };
  let stopReason: StopReason = 'end_turn';
  let sawToolUse = false;
  // Set once a terminal envelope (`response.completed`/`response.incomplete`,
  // or `[DONE]`) is seen. If the stream closes without one after we started,
  // the response was cut mid-stream and must surface as retryable.
  let sawTerminal = false;

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
  const flushRemainingText = (full: string): StreamEvent | undefined => {
    if (full.length <= msgTextStreamed) return undefined;
    const remainder = full.slice(msgTextStreamed);
    msgTextStreamed = full.length;
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

    switch (type) {
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
          yield { type: 'thinking_start' };
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
          const prefilled = extractOutputText(item.content);
          const ev0 = flushRemainingText(prefilled);
          if (ev0) yield ev0;
        }
        break;
      }

      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const delta = typeof evt['delta'] === 'string' ? (evt['delta'] as string) : '';
        if (delta) {
          msgTextStreamed += delta.length;
          yield { type: 'text_delta', text: delta };
        }
        break;
      }

      case 'response.output_text.done': {
        // Terminal text event carrying the full message text. Emit only the
        // remainder we have not already streamed (nothing when deltas covered
        // it; the whole text when the backend skipped deltas entirely).
        const full = typeof evt['text'] === 'string' ? (evt['text'] as string) : '';
        const ev1 = flushRemainingText(full);
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
          yield { type: 'thinking_stop' };
        } else if (item.type === 'function_call') {
          const id = item.call_id ?? toolCallId ?? `call_${Math.random().toString(36).slice(2)}`;
          const raw = item.arguments && item.arguments.length > 0 ? item.arguments : joinArgBuffer(toolArgBuf);
          yield { type: 'tool_use_stop', id, input: parseToolInput(raw || '{}') };
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
      case 'response.incomplete': {
        const resp = evt['response'] as { status?: string; usage?: ResponsesUsage } | undefined;
        if (resp?.usage) usage = normalizeUsage(resp.usage);
        stopReason = mapResponsesStatus(resp?.status, sawToolUse);
        sawTerminal = true;
        break;
      }

      case 'error':
      case 'response.failed': {
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
        const status = responseFailureStatus(errorBody.type, errorBody.message, statusCode);
        const rawMessage = errorBody.message ?? 'OpenAI Responses request failed';
        const kind = classifyProviderError(status, errorBody, rawMessage);
        const body = scrubProviderErrorBody(errorBody);
        const message = scrubErrorText(rawMessage);
        throw new ProviderError(message, status, isRetryableKind(kind), providerId, { body, kind });
      }

      default:
        break;
    }
  }

  if (started && !sawTerminal) {
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

function responseFailureStatus(
  type: string | undefined,
  message: string | undefined,
  statusCode?: number,
): number {
  if (statusCode !== undefined) return statusCode;
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
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.input_tokens_details?.cache_write_tokens ?? 0;
  const total = u.input_tokens ?? 0;
  return {
    input: Math.max(0, total - cached - cacheWrite),
    output: u.output_tokens ?? 0,
    cacheRead: cached || undefined,
    cacheWrite: cacheWrite || undefined,
  };
}

function mapResponsesStatus(status: string | undefined, sawToolUse: boolean): StopReason {
  if (status === 'incomplete') return 'max_tokens';
  // 'completed' (and anything else benign) → tool_use when a call was emitted.
  return sawToolUse ? 'tool_use' : 'end_turn';
}
