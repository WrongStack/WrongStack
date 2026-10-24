/**
 * Provider/model health (waiting-room) data contracts and the tracker port.
 * Implementation: `coordination/provider-status-tracker.ts`.
 */

import type { ProviderErrorKind } from './provider.js';

export type ProviderModelState = 'healthy' | 'degraded' | 'blocked';

export interface ErrorHistoryEntry {
  readonly timestamp: number;
  readonly kind: ProviderErrorKind;
  readonly status: number;
  readonly message: string;
  readonly sessionId?: string | undefined;
  readonly agentId?: string | undefined;
  readonly retryAfterMs?: number | undefined;
}

export interface ProviderModelStatus {
  readonly providerId: string;
  readonly model: string;

  /** Current state in the state machine. */
  readonly state: ProviderModelState;

  // ── Failure counters ──
  readonly consecutiveFailures: number;
  readonly totalFailures: number;
  readonly rateLimitHits: number;
  readonly overloadedHits: number;
  readonly serverErrors: number;
  readonly otherErrors: number;

  // ── Success counters ──
  readonly consecutiveSuccesses: number;
  readonly totalSuccesses: number;
  readonly lastSuccessAt: number | null;

  // ── Timing ──
  readonly firstFailureAt: number | null;
  readonly lastFailureAt: number | null;
  /** When the current degraded or blocked state expires (ms epoch), or null. */
  readonly stateExpiresAt: number | null;

  // ── Last-error detail (for WebUI / `/provider-status`) ──
  readonly lastErrorKind: ProviderErrorKind | null;
  readonly lastErrorMessage: string | null;
  readonly lastErrorStatus: number | null;
  readonly lastSessionId: string | null;
  readonly lastAgentId: string | null;

  /** Recent error history (newest-first, capped to `maxErrorHistory`). */
  readonly recentErrors: readonly ErrorHistoryEntry[];
}

export interface ProviderStatusSnapshot {
  readonly totalPairs: number;
  readonly healthy: number;
  readonly degraded: number;
  readonly blocked: number;
  readonly totalFailures: number;
  readonly totalRateLimits: number;
  readonly statuses: readonly ProviderModelStatus[];
}

/** Optional caller attribution attached to a recorded provider failure. */
export interface ProviderFailureMeta {
  sessionId?: string | undefined;
  agentId?: string | undefined;
  retryAfterMs?: number | undefined;
}

/**
 * Structural contract of the process-wide provider/model health tracker
 * (waiting room). `coordination/provider-status-tracker.ts` implements it; the
 * kernel token, provider runner and one-shot LLM depend on this shape only, so
 * the low layers never import the coordination implementation.
 */
export interface ProviderStatusTrackerPort {
  /** Canonical identity a pair is keyed under (aliases fold onto one logical target). */
  logicalIdentity(providerId: string, model: string): { providerId: string; model: string };
  recordSuccess(
    providerId: string,
    model: string,
    meta?: { sessionId?: string | undefined; agentId?: string | undefined },
  ): void;
  /** Record a failed provider call; returns the pair's state after the transition. */
  recordFailure(
    providerId: string,
    model: string,
    kind: ProviderErrorKind,
    status: number,
    message: string,
    meta?: ProviderFailureMeta,
  ): ProviderModelState;
  isAvailable(providerId: string, model: string): boolean;
  unblock(providerId: string, model: string): void;
  isRateLimited(providerId: string, model: string): boolean;
  getStatus(providerId: string, model: string): ProviderModelStatus | undefined;
  getAllStatuses(): ProviderModelStatus[];
  sweepExpired(): number;
  retryNow(providerId: string, model: string): boolean;
  getBlocked(): ProviderModelStatus[];
  getDegraded(): ProviderModelStatus[];
  filterAvailable<T extends { providerId: string; model: string }>(entries: readonly T[]): T[];
  isBlocked(providerId: string, model: string): boolean;
  clear(providerId?: string, model?: string): void;
  getSnapshot(): ProviderStatusSnapshot;
  /** Restore non-expired waiting-room entries from a previous process. */
  restoreSnapshot(value: unknown): number;
}
