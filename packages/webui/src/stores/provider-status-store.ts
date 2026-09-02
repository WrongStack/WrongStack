/**
 * Zustand store for the provider/model waiting room (token limit reset room).
 *
 * Two data sources:
 * 1. **Push events**: `provider.status_changed` WS events call `.update()` for
 *    real-time status transitions.
 * 2. **On-demand snapshot**: `provider.status.snapshot` WS messages call
 *    `.applySnapshot()` with the full tracker state — requested by the
 *    ProviderWaitingRoom panel on mount and on manual refresh.
 *
 * Both map into the same `entries` map keyed by `providerId\0model`.
 */

import { create } from 'zustand';

export type ProviderHealthState = 'healthy' | 'degraded' | 'blocked';

export interface ProviderHealthEntry {
  providerId: string;
  model: string;
  state: ProviderHealthState;
  reason: string;
  updatedAt: number;
  stateExpiresAt?: number | undefined;
  /** Failure counters from the full snapshot (when available). */
  consecutiveFailures?: number | undefined;
  totalFailures?: number | undefined;
  rateLimitHits?: number | undefined;
  /** Last error message from the full snapshot (when available). */
  lastErrorMessage?: string | undefined;
  lastErrorKind?: string | undefined;
  lastErrorStatus?: number | undefined;
  /** Recent error history from the full snapshot (when available). */
  recentErrors?:
    | readonly {
        timestamp: number;
        kind: string;
        status: number;
        message: string;
        sessionId?: string | undefined;
        agentId?: string | undefined;
        retryAfterMs?: number | undefined;
      }[]
    | undefined;
  lastSessionId?: string | undefined;
  lastAgentId?: string | undefined;
  lastFailureAt?: number | null | undefined;
}

export interface ProviderAuditEntry {
  ts: number;
  providerId: string;
  model: string;
  from: ProviderHealthState;
  to: ProviderHealthState;
  reason: string;
  expiresAt: number | null;
  error: {
    kind: string;
    status: number | null;
    message: string;
    sessionId: string | null;
    agentId: string | null;
  } | null;
}

interface ProviderStatusStore {
  entries: Record<string, ProviderHealthEntry>;
  /** Durable block/open audit trail tail (newest first), fed by provider.audit.get. */
  audit: ProviderAuditEntry[];
  /** Summary counts from the last full snapshot (or null before first fetch). */
  summary: {
    totalPairs: number;
    healthy: number;
    degraded: number;
    blocked: number;
    totalFailures: number;
    totalRateLimits: number;
  } | null;
  loading: boolean;
  error: string | null;

  update: (entry: ProviderHealthEntry) => void;
  hydrate: (entries: ProviderHealthEntry[]) => void;
  applySnapshot: (snapshot: Record<string, unknown>) => void;
  setAudit: (lines: ProviderAuditEntry[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clear: () => void;
  removeEntry: (providerId: string, model: string) => void;
}

const keyOf = (entry: Pick<ProviderHealthEntry, 'providerId' | 'model'>) =>
  `${entry.providerId}\u0000${entry.model}`;

export const useProviderStatusStore = create<ProviderStatusStore>((set) => ({
  entries: {},
  audit: [],
  summary: null,
  loading: false,
  error: null,

  update: (entry) =>
    set((state) => {
      const next = { ...state.entries };
      const key = keyOf(entry);
      if (entry.state === 'healthy') {
        delete next[key];
      } else {
        const previous = next[key];
        // A push must never erase richer snapshot data with undefined (the
        // server omits fields on some transitions): strip every undefined
        // value so pushes only overwrite what they actually carry.
        const clean = Object.fromEntries(
          Object.entries(entry).filter((pair) => pair[1] !== undefined),
        );
        next[key] = { ...previous, ...clean } as ProviderHealthEntry;
      }
      return { entries: next };
    }),

  hydrate: (entries) =>
    set({
      entries: Object.fromEntries(
        entries.filter((entry) => entry.state !== 'healthy').map((entry) => [keyOf(entry), entry]),
      ),
    }),

  applySnapshot: (snapshot) => {
    const statuses = (snapshot as { statuses?: unknown }).statuses;
    if (!Array.isArray(statuses)) {
      set({ error: 'Invalid snapshot from server', loading: false });
      return;
    }
    const next: Record<string, ProviderHealthEntry> = {};
    for (const raw of statuses) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const providerId = typeof item['providerId'] === 'string' ? item['providerId'] : '';
      const model = typeof item['model'] === 'string' ? item['model'] : '';
      if (!providerId || !model) continue;
      const state = item['state'];
      if (state !== 'healthy' && state !== 'degraded' && state !== 'blocked') continue;
      next[`${providerId}\u0000${model}`] = {
        providerId,
        model,
        state,
        reason: (typeof item['lastErrorKind'] === 'string' ? item['lastErrorKind'] : '') || state,
        updatedAt: typeof item['lastFailureAt'] === 'number' ? item['lastFailureAt'] : Date.now(),
        ...(typeof item['stateExpiresAt'] === 'number'
          ? { stateExpiresAt: item['stateExpiresAt'] as number }
          : {}),
        ...(typeof item['consecutiveFailures'] === 'number'
          ? { consecutiveFailures: item['consecutiveFailures'] as number }
          : {}),
        ...(typeof item['totalFailures'] === 'number'
          ? { totalFailures: item['totalFailures'] as number }
          : {}),
        ...(typeof item['rateLimitHits'] === 'number'
          ? { rateLimitHits: item['rateLimitHits'] as number }
          : {}),
        ...(typeof item['lastErrorMessage'] === 'string'
          ? { lastErrorMessage: item['lastErrorMessage'] as string }
          : {}),
        ...(typeof item['lastErrorKind'] === 'string'
          ? { lastErrorKind: item['lastErrorKind'] as string }
          : {}),
        ...(typeof item['lastErrorStatus'] === 'number'
          ? { lastErrorStatus: item['lastErrorStatus'] as number }
          : {}),
        ...(Array.isArray(item['recentErrors'])
          ? {
              recentErrors: (
                item['recentErrors'] as readonly {
                  timestamp: number;
                  kind: string;
                  status: number;
                  message: string;
                  sessionId?: string | undefined;
                  agentId?: string | undefined;
                  retryAfterMs?: number | undefined;
                }[]
              ).slice(0, 20),
            }
          : {}),
        ...(typeof item['lastSessionId'] === 'string'
          ? { lastSessionId: item['lastSessionId'] as string }
          : {}),
        ...(typeof item['lastAgentId'] === 'string'
          ? { lastAgentId: item['lastAgentId'] as string }
          : {}),
        ...(typeof item['lastFailureAt'] === 'number'
          ? { lastFailureAt: item['lastFailureAt'] as number }
          : {}),
      };
    }
    const s = snapshot as Record<string, unknown>;
    set({
      entries: next,
      summary: {
        totalPairs: typeof s['totalPairs'] === 'number' ? s['totalPairs'] : 0,
        healthy: typeof s['healthy'] === 'number' ? s['healthy'] : 0,
        degraded: typeof s['degraded'] === 'number' ? s['degraded'] : 0,
        blocked: typeof s['blocked'] === 'number' ? s['blocked'] : 0,
        totalFailures: typeof s['totalFailures'] === 'number' ? s['totalFailures'] : 0,
        totalRateLimits: typeof s['totalRateLimits'] === 'number' ? s['totalRateLimits'] : 0,
      },
      error: null,
      loading: false,
    });
  },

  setAudit: (lines) => set({ audit: lines }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),

  removeEntry: (providerId, model) =>
    set((state) => {
      const next = { ...state.entries };
      delete next[keyOf({ providerId, model })];
      return { entries: next };
    }),

  clear: () => set({ entries: {}, audit: [], summary: null, error: null }),
}));
