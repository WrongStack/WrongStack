import { createHash, randomUUID } from 'node:crypto';
import type { Request, StreamEvent } from '@wrongstack/contracts/types';
import {
  isCacheProbeEnabled,
  recordCacheProbeRequest,
  recordCacheProbeUsage,
} from './prompt-cache-probe.js';

/** Per-request cache-probe identity, filled when the body is built. */
export interface CodexCacheProbe {
  requestId: string;
  sessionKey: string;
  reasoningTokens?: number | undefined;
}

/** A fresh probe when the opt-in cache probe is on, else `undefined`. */
export function newCodexCacheProbe(): CodexCacheProbe | undefined {
  return isCacheProbeEnabled()
    ? { requestId: '', sessionKey: 'no-session', reasoningTokens: undefined }
    : undefined;
}

/** Add to an insertion-ordered set, evicting the oldest entry past `max`. */
export function addBounded<T>(set: Set<T>, value: T, max: number): void {
  set.add(value);
  if (set.size > max) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

/**
 * Pass a provider stream through, calling `onOutput` at the first event that
 * carries output and recording the probe's usage at `message_stop`.
 */
export async function* trackCodexStream(
  source: AsyncIterable<StreamEvent>,
  ctx: { providerId: string; req: Request; probe: CodexCacheProbe | undefined },
  onOutput: () => void,
): AsyncIterable<StreamEvent> {
  const { providerId, req, probe } = ctx;
  for await (const event of source) {
    // `message_start` carries no user-visible content. A backend can emit
    // it before a response.failed envelope, and retrying at that point is
    // still safe. Every other streamed event is treated as an output
    // boundary to prevent duplicate text/tool/reasoning delivery.
    if (event.type !== 'message_start') onOutput();
    // The charge for the request whose prefix the probe just fingerprinted.
    // Recorded here rather than in `parseStream` because the WebSocket
    // transport parses the stream itself and never calls that override.
    if (event.type === 'message_stop' && isCacheProbeEnabled()) {
      recordCacheProbeUsage({
        provider: providerId,
        sessionKey: probe?.sessionKey ?? 'no-session',
        requestId: probe?.requestId,
        model: req.model,
        threadId: req.cache?.threadId ?? req.cache?.sessionId,
        usage: event.usage,
        reasoningTokens: probe?.reasoningTokens,
      });
    }
    yield event;
  }
}

/**
 * Opt-in local comparison within the same account/model/thread/settings.
 * Changed segments can explain lost overlap, but unchanged JSON cannot
 * prove the backend's rendered prefix, cache boundaries or routing.
 */
export function recordCodexCacheProbeRequest(
  body: Record<string, unknown>,
  req: Request,
  ctx: { providerId: string; probe: CodexCacheProbe | undefined; accountSeed: string },
): void {
  const sessionKey = String(body['prompt_cache_key'] ?? 'no-session');
  const { probe } = ctx;
  if (probe) {
    probe.requestId = randomUUID();
    probe.sessionKey = sessionKey;
    probe.reasoningTokens = undefined;
  }
  recordCacheProbeRequest({
    provider: ctx.providerId,
    sessionKey,
    requestId: probe?.requestId,
    threadId: req.cache?.threadId ?? req.cache?.sessionId,
    // Used only in the in-memory identity; never written into the log.
    accountScope: createHash('sha256').update(ctx.accountSeed).digest('hex'),
    settings: [body['reasoning'], body['text'], body['tool_choice'], body['parallel_tool_calls']],
    model: req.model,
    instructions: String(body['instructions'] ?? ''),
    tools: body['tools'] as readonly unknown[] | undefined,
    items: body['input'] as readonly unknown[],
  });
}
