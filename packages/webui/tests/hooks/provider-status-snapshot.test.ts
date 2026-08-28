/**
 * Unit tests for the handleProviderStatusSnapshot WS handler.
 *
 * Verifies that the handler correctly routes the `provider.status.snapshot`
 * server message into the provider-status store, and handles the error
 * sentinel when the tracker is not available on the server.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderStatusStore } from '../../src/stores/provider-status-store';

// The handler imports toast and the store at module level. We mock toast
// to avoid side effects; the store is used directly for assertions.
vi.mock('@/lib/toast', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
}));

// Import AFTER mocks are set up.
const { handleProviderStatusSnapshot } = await import(
  '../../src/hooks/ws-handlers/session-handlers'
);

describe('handleProviderStatusSnapshot', () => {
  beforeEach(() => useProviderStatusStore.getState().clear());

  it('applies a valid snapshot to the store', () => {
    handleProviderStatusSnapshot({
      type: 'provider.status.snapshot',
      payload: {
        totalPairs: 2,
        healthy: 1,
        degraded: 0,
        blocked: 1,
        totalFailures: 3,
        totalRateLimits: 2,
        statuses: [
          {
            providerId: 'openai',
            model: 'gpt-4o',
            state: 'blocked',
            consecutiveFailures: 3,
            totalFailures: 3,
            rateLimitHits: 2,
            overloadedHits: 0,
            serverErrors: 0,
            otherErrors: 0,
            consecutiveSuccesses: 0,
            totalSuccesses: 0,
            lastSuccessAt: null,
            firstFailureAt: 1000,
            lastFailureAt: 2000,
            stateExpiresAt: 9999,
            lastErrorKind: 'rate_limit',
            lastErrorMessage: 'Too many requests',
            lastErrorStatus: 429,
            lastSessionId: 's1',
            lastAgentId: 'leader',
            recentErrors: [],
          },
          {
            providerId: 'deepseek',
            model: 'v4',
            state: 'healthy',
            consecutiveFailures: 0,
            totalFailures: 0,
            rateLimitHits: 0,
            overloadedHits: 0,
            serverErrors: 0,
            otherErrors: 0,
            consecutiveSuccesses: 5,
            totalSuccesses: 50,
            lastSuccessAt: 3000,
            firstFailureAt: null,
            lastFailureAt: null,
            stateExpiresAt: null,
            lastErrorKind: null,
            lastErrorMessage: null,
            lastErrorStatus: null,
            lastSessionId: null,
            lastAgentId: null,
            recentErrors: [],
          },
        ],
      },
    });

    const store = useProviderStatusStore.getState();
    // All entries are stored (including healthy — the snapshot is the full picture).
    expect(Object.values(store.entries)).toHaveLength(2);
    expect(store.entries['openai\u0000gpt-4o']).toBeDefined();
    expect(store.entries['openai\u0000gpt-4o']?.lastErrorMessage).toBe('Too many requests');

    // Summary populated from the snapshot.
    expect(store.summary).not.toBeNull();
    expect(store.summary?.blocked).toBe(1);
    expect(store.summary?.totalFailures).toBe(3);
    expect(store.error).toBeNull();
  });

  it('sets error state when server signals tracker not available', () => {
    handleProviderStatusSnapshot({
      type: 'provider.status.snapshot',
      payload: { error: 'not_available' },
    });

    const store = useProviderStatusStore.getState();
    expect(store.error).toBe('Provider status tracking not available');
    expect(store.loading).toBe(false);
  });

  it('handles empty statuses array gracefully', () => {
    handleProviderStatusSnapshot({
      type: 'provider.status.snapshot',
      payload: {
        totalPairs: 0,
        healthy: 0,
        degraded: 0,
        blocked: 0,
        totalFailures: 0,
        totalRateLimits: 0,
        statuses: [],
      },
    });

    const store = useProviderStatusStore.getState();
    expect(Object.values(store.entries)).toHaveLength(0);
    expect(store.summary).toEqual({
      totalPairs: 0,
      healthy: 0,
      degraded: 0,
      blocked: 0,
      totalFailures: 0,
      totalRateLimits: 0,
    });
    expect(store.error).toBeNull();
  });
});

describe('handleProviderAuditHistory', () => {
  beforeEach(() => useProviderStatusStore.getState().clear());

  it('stores validated audit lines and skips malformed ones', async () => {
    const { handleProviderAuditHistory } = await import(
      '../../src/hooks/ws-handlers/session-handlers'
    );
    handleProviderAuditHistory({
      type: 'provider.audit.history',
      payload: {
        lines: [
          {
            ts: 123,
            providerId: 'openai',
            model: 'gpt-4o',
            from: 'healthy',
            to: 'blocked',
            reason: 'rate_limit_threshold_1',
            expiresAt: 9999,
            error: {
              kind: 'rate_limit',
              status: 429,
              message: 'Too many requests',
              sessionId: 's1',
              agentId: 'a1',
            },
          },
          {
            ts: 2,
            providerId: '',
            model: 'm',
            from: 'healthy',
            to: 'blocked',
            reason: '',
            expiresAt: null,
            error: null,
          },
          null,
        ],
      },
    } as never);

    const audit = useProviderStatusStore.getState().audit;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ providerId: 'openai', model: 'gpt-4o', to: 'blocked' });
    expect(audit[0]?.error?.sessionId).toBe('s1');
  });

  it('clears the audit tail when the server sends an empty one', async () => {
    const { handleProviderAuditHistory } = await import(
      '../../src/hooks/ws-handlers/session-handlers'
    );
    useProviderStatusStore.getState().setAudit([
      {
        ts: 1,
        providerId: 'a',
        model: 'm',
        from: 'healthy',
        to: 'blocked',
        reason: 'r',
        expiresAt: null,
        error: null,
      },
    ]);

    handleProviderAuditHistory({
      type: 'provider.audit.history',
      payload: { lines: [] },
    } as never);

    expect(useProviderStatusStore.getState().audit).toEqual([]);
  });
});
