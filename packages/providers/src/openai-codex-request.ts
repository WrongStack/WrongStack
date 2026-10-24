import { createHash, randomUUID } from 'node:crypto';
import * as zlib from 'node:zlib';

import type { Request } from '@wrongstack/contracts/types';

import { CODEX_BASE_URL, codexModelsUrl, codexResponsesUrl } from './oauth/codex-protocol.js';

// ── OAuth refresh (shared protocol — see ./oauth/codex-protocol.ts) ──────────

export const DEFAULT_CODEX_BASE = CODEX_BASE_URL;

/** Bodies below this gain nothing worth the CPU; real turns are far above it. */
const CODEX_ZSTD_MIN_BYTES = 8 * 1024;

type ZstdCompress = (buffer: Uint8Array, options?: { params?: Record<number, number> }) => Buffer;

/** `zlib.zstdCompressSync` where the runtime has it (Node ≥ 22.15), else null. */
const RUNTIME_ZSTD: ZstdCompress | null =
  typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === 'function'
    ? (zlib as { zstdCompressSync: ZstdCompress }).zstdCompressSync
    : null;

/**
 * zstd-compress a ChatGPT-backend request body, as the official client does by
 * default (`enable_request_compression`, zstd level 3, `content-encoding: zstd`,
 * only for its own backend). A turn re-sends the whole conversation, so the
 * upload is the part of latency that grows with the session.
 *
 * Returns the JSON untouched — and leaves `headers` alone — for a proxy or
 * custom base URL (which may not accept zstd), a runtime without zstd, a small
 * body, a caller that already set an encoding, or any compression failure.
 */
export function compressCodexRequestBody(
  json: string,
  headers: Record<string, string>,
  baseUrl: string,
  compress: ZstdCompress | null = RUNTIME_ZSTD,
): string | Uint8Array {
  if (!compress || !isOfficialCodexBase(baseUrl)) return json;
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'content-encoding')) return json;
  const raw = Buffer.from(json, 'utf8');
  if (raw.length < CODEX_ZSTD_MIN_BYTES) return json;
  try {
    const level = (zlib.constants as Record<string, number>)['ZSTD_c_compressionLevel'];
    const compressed = compress(raw, level === undefined ? {} : { params: { [level]: 3 } });
    headers['content-encoding'] = 'zstd';
    return compressed;
  } catch {
    return json;
  }
}

function isOfficialCodexBase(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).host === new URL(CODEX_BASE_URL).host;
  } catch {
    return false;
  }
}

/**
 * `x-codex-routing-hint`: the official client tells the ChatGPT backend which
 * model a request is for (`model=<slug>`, plus `;tier=<tier>` when a service
 * tier is requested — we never request one) on every HTTP request and on the
 * WebSocket handshake (codex-rs core `build_routing_hint_header`). Routing the
 * request to where that model is served is also where its prompt cache lives.
 */
export const CODEX_ROUTING_HINT_HEADER = 'x-codex-routing-hint';

/** The hint for `model`, or undefined when there is no model or it is not header-safe. */
export function codexRoutingHint(model: string | undefined): string | undefined {
  return model && /^[\x21-\x7e]+$/.test(model) ? `model=${model}` : undefined;
}

/**
 * Put the volatile system blocks after the conversation.
 *
 * They still reach the model, and being last they are also the most recent
 * thing it read — but nothing cacheable sits behind them any more.
 */
export function appendVolatileSystem(
  input: Record<string, unknown>[],
  volatileSystem: readonly string[],
): Record<string, unknown>[] {
  if (volatileSystem.length === 0) return input;
  return [
    ...input,
    { role: 'user', content: [{ type: 'input_text', text: volatileSystem.join('\n\n') }] },
  ];
}

/** Header-safe, session-stable affinity key used by the Codex backend. */
export function codexCacheSessionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  // Lossy replacement merged e.g. "session/a" and "session?a", sharing
  // thread connections and turn state. Hash the original opaque value.
  if (sessionId.length > 64 || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    return `ws-${createHash('sha256').update(sessionId).digest('hex').slice(0, 61)}`;
  }
  return sessionId;
}

/** Stable UUID-shaped thread/request id derived from WrongStack's opaque session id. */
export function codexClientRequestId(sessionId: string | undefined): string {
  if (!sessionId) return randomUUID();
  const hex = createHash('sha256').update(sessionId).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

// ── URL + tool-choice helpers ────────────────────────────────────────────────

/** Normalize a base URL to the `/codex/responses` endpoint. */
export function resolveCodexUrl(baseUrl: string | undefined): string {
  return codexResponsesUrl(baseUrl ?? DEFAULT_CODEX_BASE);
}

/** Convert the HTTP Responses endpoint to the Codex WebSocket endpoint. */
export function resolveCodexWebSocketUrl(baseUrl: string | undefined): string {
  const httpUrl = resolveCodexUrl(baseUrl);
  return httpUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
}

/** Resolve the authenticated Codex model-catalog endpoint beside `/responses`. */
export function resolveCodexModelsUrl(baseUrl: string | undefined): string {
  return codexModelsUrl(baseUrl ?? DEFAULT_CODEX_BASE);
}

export function positiveContextLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

export function mapToolChoice(
  choice: Request['toolChoice'],
): 'auto' | 'required' | 'none' | { type: 'function'; name: string } {
  if (choice === undefined) return 'auto';
  if (choice === 'auto' || choice === 'required' || choice === 'none') return choice;
  return { type: 'function', name: choice.name };
}
