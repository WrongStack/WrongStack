import type {
  MutableProviderModelStatus,
  ProviderModelStatus,
  ProviderStatusSnapshot,
  ProviderStatusTrackerConfig,
} from './provider-status-tracker-types.js';
import {
  isProviderErrorKind,
  isQuotaExhausted,
  pairKey,
  safeCount,
  safeNullableNumber,
  safeTimestamp,
  statusIdentity,
} from './provider-status-tracker-types.js';

const ROUTE_SCOPED_QUOTA_RE = /\b(?:tier|routing|route|model-specific|per-model|route-scoped)\b/i;

export interface SnapshotContext {
  cfg: ProviderStatusTrackerConfig;
  providerQuotaBlocks: Map<string, number>;
  getOrCreate: (key: string, providerId: string, model: string) => MutableProviderModelStatus;
  fanOutExpiryFor: (now: number, pairExpiry: number) => number;
}

/**
 * Get a JSON-safe snapshot suitable for WebUI rendering.
 * Includes summary stats + per-pair details.
 */
export function buildProviderStatusSnapshot(all: ProviderModelStatus[]): ProviderStatusSnapshot {
  const healthy: ProviderModelStatus[] = [];
  const degraded: ProviderModelStatus[] = [];
  const blocked: ProviderModelStatus[] = [];

  for (const s of all) {
    if (s.state === 'blocked') blocked.push(s);
    else if (s.state === 'degraded') degraded.push(s);
    else healthy.push(s);
  }

  return {
    totalPairs: all.length,
    healthy: healthy.length,
    degraded: degraded.length,
    blocked: blocked.length,
    totalFailures: all.reduce((sum, s) => sum + s.totalFailures, 0),
    totalRateLimits: all.reduce((sum, s) => sum + s.rateLimitHits, 0),
    statuses: all,
  };
}

/** Restore non-expired waiting-room entries from a previous process. */
export function restoreProviderStatusSnapshot(ctx: SnapshotContext, value: unknown): number {
  if (!value || typeof value !== 'object') return 0;
  const statuses = (value as { statuses?: unknown }).statuses;
  if (!Array.isArray(statuses)) return 0;
  let restored = 0;
  const now = Date.now();
  for (const raw of statuses) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item['providerId'] !== 'string' || typeof item['model'] !== 'string') continue;
    if (item['state'] !== 'blocked' && item['state'] !== 'degraded') continue;
    if (typeof item['stateExpiresAt'] !== 'number' || item['stateExpiresAt'] <= now) continue;
    const { providerId, model } = statusIdentity(item['providerId'], item['model']);
    const s = ctx.getOrCreate(pairKey(providerId, model), providerId, model);
    s.state = item['state'];
    s.stateExpiresAt = item['stateExpiresAt'];
    s.consecutiveFailures = safeCount(item['consecutiveFailures']);
    s.totalFailures = safeCount(item['totalFailures']);
    s.rateLimitHits = safeCount(item['rateLimitHits']);
    s.lastFailureAt = safeTimestamp(item['lastFailureAt']);
    s.lastErrorStatus = safeNullableNumber(item['lastErrorStatus']);
    s.lastErrorMessage =
      typeof item['lastErrorMessage'] === 'string' ? item['lastErrorMessage'] : null;
    s.lastErrorKind = isProviderErrorKind(item['lastErrorKind']) ? item['lastErrorKind'] : null;
    const providerWideQuota =
      s.lastErrorKind === 'quota_exhausted' ||
      isQuotaExhausted(
        s.lastErrorKind ?? 'unknown',
        s.lastErrorStatus ?? 0,
        s.lastErrorMessage ?? '',
      );
    if (
      ctx.cfg.quarantineSiblingsOnQuotaExhausted &&
      providerWideQuota &&
      !ROUTE_SCOPED_QUOTA_RE.test(s.lastErrorMessage ?? '') &&
      s.state === 'blocked' &&
      s.stateExpiresAt !== null
    ) {
      const previous = ctx.providerQuotaBlocks.get(providerId) ?? 0;
      // The restored PAIR keeps its persisted expiry (a real weekly cap
      // still holds), but the provider-wide gate is capped at the fixed
      // quota block, same as a live fan-out would be.
      ctx.providerQuotaBlocks.set(
        providerId,
        Math.max(previous, ctx.fanOutExpiryFor(now, s.stateExpiresAt)),
      );
    }
    restored += 1;
  }
  return restored;
}
