import { beforeEach, describe, expect, it } from 'vitest';
import { useProviderStatusStore } from '../../src/stores/provider-status-store';

describe('provider status store', () => {
  beforeEach(() => useProviderStatusStore.getState().clear());

  it('keeps logical OmniRoute identities visible in the waiting room', () => {
    useProviderStatusStore.getState().update({
      providerId: 'cc',
      model: 'claude-opus-4.8',
      state: 'blocked',
      reason: 'quota_exhausted',
      updatedAt: 1,
      stateExpiresAt: 2,
    });

    expect(Object.values(useProviderStatusStore.getState().entries)).toEqual([
      expect.objectContaining({ providerId: 'cc', model: 'claude-opus-4.8' }),
    ]);
  });

  it('removes an entry when autonomous recovery marks it healthy', () => {
    const store = useProviderStatusStore.getState();
    store.update({
      providerId: 'cc',
      model: 'claude-opus-4.8',
      state: 'blocked',
      reason: 'quota_exhausted',
      updatedAt: 1,
    });
    useProviderStatusStore.getState().update({
      providerId: 'cc',
      model: 'claude-opus-4.8',
      state: 'healthy',
      reason: 'waiting_room_expired',
      updatedAt: 2,
    });

    expect(useProviderStatusStore.getState().entries).toEqual({});
  });

  it('hydrates blocked and degraded entries but omits healthy history', () => {
    useProviderStatusStore.getState().hydrate([
      { providerId: 'cc', model: 'opus', state: 'blocked', reason: 'quota', updatedAt: 1 },
      { providerId: 'openai', model: 'gpt', state: 'healthy', reason: 'ok', updatedAt: 1 },
    ]);

    expect(Object.values(useProviderStatusStore.getState().entries)).toHaveLength(1);
  });

  // ── applySnapshot ──────────────────────────────────────────────────

  it('applySnapshot populates entries from a full tracker snapshot', () => {
    useProviderStatusStore.getState().applySnapshot({
      totalPairs: 3,
      healthy: 1,
      degraded: 1,
      blocked: 1,
      totalFailures: 10,
      totalRateLimits: 5,
      statuses: [
        {
          providerId: 'openai',
          model: 'gpt-4o',
          state: 'blocked',
          consecutiveFailures: 3,
          totalFailures: 5,
          rateLimitHits: 3,
          overloadedHits: 0,
          serverErrors: 0,
          otherErrors: 0,
          consecutiveSuccesses: 0,
          totalSuccesses: 10,
          lastSuccessAt: null,
          firstFailureAt: 1000,
          lastFailureAt: 2000,
          stateExpiresAt: 9999,
          lastErrorKind: 'rate_limit',
          lastErrorMessage: 'Too many requests',
          lastErrorStatus: 429,
          lastSessionId: 'sess_abc',
          lastAgentId: 'leader',
          recentErrors: [
            { timestamp: 2000, kind: 'rate_limit', status: 429, message: 'Too many requests' },
          ],
        },
        {
          providerId: 'anthropic',
          model: 'claude-4',
          state: 'degraded',
          consecutiveFailures: 2,
          totalFailures: 2,
          rateLimitHits: 0,
          overloadedHits: 2,
          serverErrors: 0,
          otherErrors: 0,
          consecutiveSuccesses: 0,
          totalSuccesses: 8,
          lastSuccessAt: null,
          firstFailureAt: 1500,
          lastFailureAt: 1800,
          stateExpiresAt: 8888,
          lastErrorKind: 'overloaded',
          lastErrorMessage: 'Overloaded',
          lastErrorStatus: 529,
          lastSessionId: null,
          lastAgentId: null,
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
    });

    const store = useProviderStatusStore.getState();
    const entries = Object.values(store.entries);

    // All non-healthy entries are kept (healthy is also stored — the store
    // preserves the full snapshot so the summary counts stay consistent).
    expect(entries).toHaveLength(3);
    expect(entries.some((e) => e.providerId === 'openai' && e.model === 'gpt-4o')).toBe(true);
    expect(entries.some((e) => e.providerId === 'anthropic' && e.model === 'claude-4')).toBe(true);
    expect(entries.some((e) => e.providerId === 'deepseek' && e.model === 'v4')).toBe(true);

    // Rich fields are populated from the snapshot.
    const openai = store.entries['openai\u0000gpt-4o']!;
    expect(openai.lastErrorMessage).toBe('Too many requests');
    expect(openai.lastErrorKind).toBe('rate_limit');
    expect(openai.lastErrorStatus).toBe(429);
    expect(openai.totalFailures).toBe(5);
    expect(openai.rateLimitHits).toBe(3);
    expect(openai.consecutiveFailures).toBe(3);
    expect(openai.lastSessionId).toBe('sess_abc');
    expect(openai.lastAgentId).toBe('leader');
    expect(openai.recentErrors).toHaveLength(1);
    expect(openai.recentErrors![0]!.message).toBe('Too many requests');

    // Summary is populated.
    expect(store.summary).toEqual({
      totalPairs: 3,
      healthy: 1,
      degraded: 1,
      blocked: 1,
      totalFailures: 10,
      totalRateLimits: 5,
    });

    // Loading and error are cleared.
    expect(store.loading).toBe(false);
    expect(store.error).toBeNull();
  });

  it('applySnapshot sets error when statuses array is missing', () => {
    useProviderStatusStore.getState().applySnapshot({ foo: 'bar' });

    const store = useProviderStatusStore.getState();
    expect(store.error).toBe('Invalid snapshot from server');
    expect(store.loading).toBe(false);
  });

  it('applySnapshot skips malformed entries gracefully', () => {
    useProviderStatusStore.getState().applySnapshot({
      totalPairs: 1,
      healthy: 0,
      degraded: 0,
      blocked: 1,
      totalFailures: 0,
      totalRateLimits: 0,
      statuses: [
        { providerId: 'good', model: 'model-a', state: 'blocked' },
        { providerId: 'bad', model: '', state: 'blocked' }, // empty model → skipped
        { providerId: '', model: 'no-prov', state: 'blocked' }, // empty provider → skipped
        { providerId: 'bad', model: 'bad-model', state: 'invalid_state' }, // bad state → skipped
        null, // null → skipped
        'string', // wrong type → skipped
      ],
    });

    const entries = Object.values(useProviderStatusStore.getState().entries);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.providerId).toBe('good');
  });

  it('applySnapshot replaces entries from a previous snapshot', () => {
    // First snapshot with one entry.
    useProviderStatusStore.getState().applySnapshot({
      totalPairs: 1,
      healthy: 0,
      degraded: 0,
      blocked: 1,
      totalFailures: 1,
      totalRateLimits: 0,
      statuses: [{ providerId: 'a', model: 'm1', state: 'blocked', lastErrorKind: 'rate_limit' }],
    });
    expect(Object.values(useProviderStatusStore.getState().entries)).toHaveLength(1);

    // Second snapshot replaces — old entry gone, new one present.
    useProviderStatusStore.getState().applySnapshot({
      totalPairs: 1,
      healthy: 0,
      degraded: 0,
      blocked: 1,
      totalFailures: 1,
      totalRateLimits: 0,
      statuses: [
        { providerId: 'b', model: 'm2', state: 'blocked', lastErrorKind: 'quota_exhausted' },
      ],
    });

    const entries = useProviderStatusStore.getState().entries;
    expect(Object.keys(entries)).toHaveLength(1);
    expect(entries['b\u0000m2']).toBeDefined();
    expect(entries['a\u0000m1']).toBeUndefined();
  });

  it('removeEntry removes a single entry by providerId/model', () => {
    useProviderStatusStore.getState().applySnapshot({
      totalPairs: 2,
      healthy: 0,
      degraded: 0,
      blocked: 2,
      totalFailures: 0,
      totalRateLimits: 0,
      statuses: [
        { providerId: 'a', model: 'm1', state: 'blocked' },
        { providerId: 'b', model: 'm2', state: 'blocked' },
      ],
    });

    useProviderStatusStore.getState().removeEntry('a', 'm1');

    const entries = useProviderStatusStore.getState().entries;
    expect(Object.keys(entries)).toHaveLength(1);
    expect(entries['b\u0000m2']).toBeDefined();
    expect(entries['a\u0000m1']).toBeUndefined();
  });

  it('update preserves a known countdown when a push omits stateExpiresAt', () => {
    useProviderStatusStore.getState().update({
      providerId: 'openai',
      model: 'gpt-4o',
      state: 'blocked',
      reason: 'rate_limit_threshold_1',
      updatedAt: 1,
      stateExpiresAt: 60_000,
    });
    // Some transitions carry no expiry (the server omits the field); the
    // previously known countdown must not be erased.
    useProviderStatusStore.getState().update({
      providerId: 'openai',
      model: 'gpt-4o',
      state: 'blocked',
      reason: 'cooldown_extended',
      updatedAt: 2,
      stateExpiresAt: undefined,
    });

    expect(useProviderStatusStore.getState().entries['openai\u0000gpt-4o']?.stateExpiresAt).toBe(
      60_000,
    );
  });

  it('update overwrites the countdown when a push carries a fresh expiry', () => {
    useProviderStatusStore.getState().update({
      providerId: 'openai',
      model: 'gpt-4o',
      state: 'blocked',
      reason: 'rate_limit_threshold_1',
      updatedAt: 1,
      stateExpiresAt: 60_000,
    });
    useProviderStatusStore.getState().update({
      providerId: 'openai',
      model: 'gpt-4o',
      state: 'blocked',
      reason: 'cooldown_extended',
      updatedAt: 2,
      stateExpiresAt: 120_000,
    });

    expect(useProviderStatusStore.getState().entries['openai\u0000gpt-4o']?.stateExpiresAt).toBe(
      120_000,
    );
  });

  it('update preserves snapshot error context when a push omits it', () => {
    useProviderStatusStore.getState().update({
      providerId: 'openai',
      model: 'gpt-4o',
      state: 'blocked',
      reason: 'sibling_quota_exhausted',
      updatedAt: 1,
      stateExpiresAt: 60_000,
      lastErrorKind: 'quota_exhausted',
      lastErrorMessage: 'Sibling quarantine: account-level budget exhausted on openai/gpt-4o',
    });
    // A later push without error context (cooldown extension) must not erase
    // the snapshot-provided error details.
    useProviderStatusStore.getState().update({
      providerId: 'openai',
      model: 'gpt-4o',
      state: 'blocked',
      reason: 'cooldown_extended',
      updatedAt: 2,
    });

    const entry = useProviderStatusStore.getState().entries['openai\u0000gpt-4o'];
    expect(entry?.lastErrorMessage).toContain('Sibling quarantine');
    expect(entry?.lastErrorKind).toBe('quota_exhausted');
  });

  it('update applies real-time error context carried by a push', () => {
    useProviderStatusStore.getState().update({
      providerId: 'openai',
      model: 'gpt-4o',
      state: 'blocked',
      reason: 'rate_limit_threshold_1',
      updatedAt: 1,
    });
    useProviderStatusStore.getState().update({
      providerId: 'openai',
      model: 'gpt-4o',
      state: 'blocked',
      reason: 'quota_exhausted',
      updatedAt: 2,
      lastErrorKind: 'quota_exhausted',
      lastErrorMessage: 'usage limit reached',
      lastErrorStatus: 429,
      lastSessionId: 'sess_9',
      lastAgentId: 'agent_9',
    });

    const entry = useProviderStatusStore.getState().entries['openai\u0000gpt-4o'];
    expect(entry?.lastErrorMessage).toBe('usage limit reached');
    expect(entry?.lastErrorStatus).toBe(429);
    expect(entry?.lastSessionId).toBe('sess_9');
    expect(entry?.lastAgentId).toBe('agent_9');
  });

  it('setAudit stores the durable block/open tail and clear resets it', () => {
    useProviderStatusStore.getState().setAudit([
      {
        ts: 1,
        providerId: 'openai',
        model: 'gpt-4o',
        from: 'healthy',
        to: 'blocked',
        reason: 'rate_limit_threshold_1',
        expiresAt: 9999,
        error: { kind: 'rate_limit', status: 429, message: 'x', sessionId: 's', agentId: 'a' },
      },
    ]);
    expect(useProviderStatusStore.getState().audit).toHaveLength(1);

    useProviderStatusStore.getState().clear();
    expect(useProviderStatusStore.getState().audit).toEqual([]);
  });
});
