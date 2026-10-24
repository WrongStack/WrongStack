import type { Request } from '@wrongstack/contracts/types';
import { recordProviderQuota } from '@wrongstack/core/quota';
import { extractPlanType } from './openai-codex-account.js';
import type { HeadersLike } from './openai-codex-errors.js';
import { parseCodexRateLimitHeaders } from './openai-codex-rate-limits.js';
import { codexCacheSessionId } from './openai-codex-request.js';
import {
  CODEX_TURN_STATE_HEADER,
  CODEX_TURN_STATE_MAX_SESSIONS,
  isTurnContinuation,
} from './openai-codex-turn-state-contracts.js';
export interface CodexTurnStateHost {
  rememberTurnState(req: Request, value: string | undefined): void;
  servedModels: WeakMap<Request, string>;
  access: string;
  id: string;
  contextLimitsEtag: string | undefined;
  contextLimitsFreshUntil: number;
  accountId: string | undefined;
  turnStateKey(req: Request): string;
  turnState: Map<string, string>;
}

export function onResponseHeaders(
  host: CodexTurnStateHost,
  headers: HeadersLike | undefined,
  _request: Request,
): void {
  if (!headers) return;
  host.rememberTurnState(_request, headers.get(CODEX_TURN_STATE_HEADER) ?? undefined);
  const served = (headers.get('openai-model') ?? headers.get('x-openai-model'))?.trim();
  if (served) host.servedModels.set(_request, served);
  // `x-codex-plan-type` is the account's live tier as the backend sees it.
  // The JWT claim is a snapshot taken when the token was minted, so it goes
  // stale across an upgrade; prefer the header and keep the claim as the
  // fallback for backends that omit it.
  const planLabel =
    headers.get('x-codex-plan-type')?.trim() || extractPlanType(host.access) || undefined;
  const snapshots = parseCodexRateLimitHeaders(headers).map((snapshot) =>
    snapshot.planLabel === undefined && planLabel !== undefined
      ? { ...snapshot, planLabel }
      : snapshot,
  );
  if (snapshots.length > 0) recordProviderQuota(host.id, snapshots);
  const etag = headers.get('x-models-etag');
  if (etag && etag !== host.contextLimitsEtag) {
    host.contextLimitsEtag = etag;
    host.contextLimitsFreshUntil = 0;
  }
}

export function turnStateKey(_host: CodexTurnStateHost, req: Request): string {
  return (
    codexCacheSessionId(req.cache?.threadId) ??
    codexCacheSessionId(req.cache?.sessionId) ??
    '__default__'
  );
}

export function reasoningReplayKey(host: CodexTurnStateHost, req: Request): string {
  return JSON.stringify([host.accountId, req.model, host.turnStateKey(req)]);
}

export function webSocketScope(host: CodexTurnStateHost, req: Request): string {
  return JSON.stringify([host.accountId, host.turnStateKey(req)]);
}

export function resolveTurnState(host: CodexTurnStateHost, req: Request): string | undefined {
  if (req.messages.length === 0) return undefined;
  const key = host.turnStateKey(req);
  if (!isTurnContinuation(req)) {
    host.turnState.delete(key);
    return undefined;
  }
  return host.turnState.get(key);
}

export function rememberTurnState(
  host: CodexTurnStateHost,
  req: Request,
  value: string | undefined,
): void {
  if (!value || req.messages.length === 0) return;
  const key = host.turnStateKey(req);
  // Re-insert so the map stays in least-recently-used order for the eviction
  // below; a Map preserves insertion order and delete+set moves the entry.
  host.turnState.delete(key);
  host.turnState.set(key, value);
  while (host.turnState.size > CODEX_TURN_STATE_MAX_SESSIONS) {
    const oldest = host.turnState.keys().next().value;
    if (oldest === undefined) break;
    host.turnState.delete(oldest);
  }
}
