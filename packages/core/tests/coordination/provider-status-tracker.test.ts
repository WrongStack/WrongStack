/**
 * Unit tests for ProviderModelStatusTracker.
 *
 * Covers:
 *  - state machine transitions (healthy → degraded → blocked → healthy)
 *  - auto-recovery on cooldown expiry
 *  - isAvailable / isBlocked / filterAvailable
 *  - error history with session/agent metadata
 *  - event emission on state changes
 *  - the empty_response / overloaded chimera-review pattern
 */

import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { beforeEach, describe, it } from 'vitest';
import { ProviderModelStatusTracker } from '../../src/coordination/provider-status-tracker.js';
import { ProviderError } from '../../src/types/provider.js';

/** Fresh tracker with all thresholds set to minimal values for fast testing. */
function createTestTracker(): ProviderModelStatusTracker {
  return new ProviderModelStatusTracker({
    config: {
      degradedAfterFailures: 2,
      degradedDurationMs: 50_000, // long enough that auto-recovery won't fire during the test
      blockAfterRateLimitHits: 3,
      blockAfterFailures: 5,
      blockDurationMs: 50_000,
      quotaBlockDurationMs: 120_000,
      recoverAfterSuccesses: 3,
      maxErrorHistory: 10,
    },
  });
}

describe('ProviderModelStatusTracker', () => {
  let tracker: ProviderModelStatusTracker;

  beforeEach(() => {
    tracker = createTestTracker();
  });

  // ── Initial state ───────────────────────────────────────────────────

  it('starts healthy for unseen provider/model pairs', () => {
    strictEqual(tracker.isAvailable('test', 'model-a'), true);
    strictEqual(tracker.isBlocked('test', 'model-a'), false);
    strictEqual(tracker.getStatus('test', 'model-a'), undefined);
  });

  it('getAllStatuses returns empty for a fresh tracker', () => {
    deepStrictEqual(tracker.getAllStatuses(), []);
  });

  // ── state: healthy → degraded → blocked ────────────────────────────

  it('enters degraded after 2 consecutive failures', () => {
    tracker.recordFailure('test', 'model-a', 'server', 500, 'Internal error');
    tracker.recordFailure('test', 'model-a', 'server', 502, 'Bad gateway');

    const status = tracker.getStatus('test', 'model-a');
    strictEqual(status?.state, 'degraded');
    strictEqual(status?.consecutiveFailures, 2);
  });

  it('stays healthy after 1 failure (below degradedAfterFailures threshold)', () => {
    tracker.recordFailure('test', 'model-a', 'overloaded', 529, 'Overloaded');

    const status = tracker.getStatus('test', 'model-a');
    strictEqual(status?.state, 'healthy');
  });

  it('enters blocked after 3 rate_limit hits', () => {
    tracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'Rate limited');
    tracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'Rate limited');
    tracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'Rate limited');

    const status = tracker.getStatus('test', 'model-a');
    strictEqual(status?.state, 'blocked');
    strictEqual(status?.rateLimitHits, 3);
    ok(status?.stateExpiresAt !== null);
  });

  it('quarantines a plain 429 on the FIRST hit with default config', () => {
    // Regression pin for the immediate-quarantine default: a transient 429
    // must enter the waiting room at once so the fallback engine rotates
    // instead of burning more doomed requests on the same model.
    const defaultTracker = new ProviderModelStatusTracker();
    defaultTracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'Too many requests');

    strictEqual(defaultTracker.getStatus('test', 'model-a')?.state, 'blocked');
    strictEqual(defaultTracker.isAvailable('test', 'model-a'), false);
    strictEqual(defaultTracker.isBlocked('test', 'model-a'), true);
  });

  it('sends exhausted quota to the waiting room on the first failure', () => {
    tracker.recordFailure(
      'openrouter',
      'paid-model',
      'rate_limit',
      429,
      'insufficient_quota: account credit exhausted',
    );

    const status = tracker.getStatus('openrouter', 'paid-model');
    strictEqual(status?.state, 'blocked');
    strictEqual(status?.rateLimitHits, 1);
    ok((status?.stateExpiresAt ?? 0) > Date.now() + 100_000);
  });

  it('honors a prose reset hint over the fixed quota block duration', () => {
    // Weekly-cap style message: the provider publishes the reset in prose but
    // sends no Retry-After header. The waiting room must hold until the real
    // reset (6h12m), not the configured 2-minute quota default.
    tracker.recordFailure(
      'openrouter',
      'weekly-model',
      'rate_limit',
      429,
      'insufficient_quota: weekly plan limit reached. Please try again in 6h12m',
    );

    const status = tracker.getStatus('openrouter', 'weekly-model');
    strictEqual(status?.state, 'blocked');
    ok((status?.stateExpiresAt ?? 0) > Date.now() + 6 * 3_600_000);
    strictEqual(status?.recentErrors[0]?.retryAfterMs, 6 * 3_600_000 + 12 * 60_000);
  });

  it('parses an absolute ISO reset timestamp from the message', () => {
    const resetAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    tracker.recordFailure(
      'openrouter',
      'iso-model',
      'rate_limit',
      429,
      `insufficient_quota: usage cap reached; resets at ${resetAt}`,
    );

    const status = tracker.getStatus('openrouter', 'iso-model');
    strictEqual(status?.state, 'blocked');
    ok((status?.stateExpiresAt ?? 0) > Date.now() + 3_500_000);
  });

  it('prefers an explicit retryAfterMs over any prose hint', () => {
    tracker.recordFailure(
      'openrouter',
      'explicit-model',
      'rate_limit',
      429,
      'insufficient_quota: credit exhausted. Please try again in 6h',
      { retryAfterMs: 30_000 },
    );

    const status = tracker.getStatus('openrouter', 'explicit-model');
    strictEqual(status?.recentErrors[0]?.retryAfterMs, 30_000);
    // The 6h prose hint must NOT extend the expiry past the quota default.
    ok((status?.stateExpiresAt ?? 0) < Date.now() + 3_600_000);
  });

  it('ignores garbage prose and falls back to the configured quota duration', () => {
    tracker.recordFailure(
      'openrouter',
      'garbage-model',
      'rate_limit',
      429,
      'insufficient_quota: credit exhausted; try again in a bit',
    );

    const status = tracker.getStatus('openrouter', 'garbage-model');
    strictEqual(status?.state, 'blocked');
    const expiry = status?.stateExpiresAt ?? 0;
    ok(expiry > Date.now() + 100_000 && expiry < Date.now() + 140_000);
  });

  it('clamps absurd prose hints to the 7-day maximum', () => {
    tracker.recordFailure(
      'openrouter',
      'monthly-model',
      'rate_limit',
      429,
      'insufficient_quota: monthly budget exhausted. Please try again in 30 days',
    );

    const status = tracker.getStatus('openrouter', 'monthly-model');
    const expiry = status?.stateExpiresAt ?? 0;
    ok(expiry > Date.now() + 6 * 86_400_000);
    ok(expiry <= Date.now() + 7 * 86_400_000 + 5_000);
  });

  it('parses prose hints on plain rate_limit failures too', () => {
    // Default config: a single 429 blocks immediately (blockAfterRateLimitHits: 1),
    // so the 45m prose hint should extend the block past the 5-min default.
    const defaultTracker = new ProviderModelStatusTracker();
    defaultTracker.recordFailure(
      'test',
      'burst-model',
      'rate_limit',
      429,
      'Too many requests. Please try again in 45m',
    );

    const status = defaultTracker.getStatus('test', 'burst-model');
    strictEqual(status?.state, 'blocked');
    // 45m hint must extend past the 5-min default block duration.
    ok((status?.stateExpiresAt ?? 0) > Date.now() + 2_600_000);
  });

  it('ignores prose hints on non-rate-limit failures', () => {
    tracker.recordFailure(
      'test',
      'server-model',
      'server',
      500,
      'Internal error; try again in 6h12m',
    );

    strictEqual(
      tracker.getStatus('test', 'server-model')?.recentErrors[0]?.retryAfterMs,
      undefined,
    );
  });

  // ── Provider-level sibling quarantine ─────────────────────────────

  it('quarantines sibling models on the same provider when quota is exhausted', () => {
    // Seed two sibling models so they are known to the tracker.
    tracker.recordSuccess('openai', 'gpt-4o');
    tracker.recordSuccess('openai', 'gpt-4o-mini');

    // Trigger a quota_exhausted on one model.
    tracker.recordFailure(
      'openai',
      'gpt-4o',
      'rate_limit',
      429,
      'insufficient_quota: account credit exhausted',
    );

    // The triggering model is blocked.
    strictEqual(tracker.getStatus('openai', 'gpt-4o')?.state, 'blocked');

    // The sibling is ALSO blocked via fan-out.
    strictEqual(tracker.getStatus('openai', 'gpt-4o-mini')?.state, 'blocked');
    ok(!tracker.isAvailable('openai', 'gpt-4o-mini'));
  });

  it('quarantines unseen sibling models after provider-wide quota exhaustion', () => {
    tracker.recordFailure('openai', 'gpt-4o', 'quota_exhausted', 429, 'account credit exhausted');

    strictEqual(tracker.getStatus('openai', 'never-tried'), undefined);
    strictEqual(tracker.isAvailable('openai', 'never-tried'), false);
    strictEqual(tracker.isAvailable('anthropic', 'never-tried'), true);
  });

  it('does NOT quarantine siblings on a different provider', () => {
    tracker.recordSuccess('openai', 'gpt-4o');
    tracker.recordSuccess('anthropic', 'claude-4');

    tracker.recordFailure(
      'openai',
      'gpt-4o',
      'rate_limit',
      429,
      'insufficient_quota: account credit exhausted',
    );

    strictEqual(tracker.getStatus('openai', 'gpt-4o')?.state, 'blocked');
    // Different provider — unaffected.
    strictEqual(tracker.isAvailable('anthropic', 'claude-4'), true);
  });

  it('does NOT quarantine siblings on a plain rate_limit (non-quota)', () => {
    // Use default config (threshold=1) so one hit blocks the triggering model.
    const defaultTracker = new ProviderModelStatusTracker();
    defaultTracker.recordSuccess('openai', 'gpt-4o');
    defaultTracker.recordSuccess('openai', 'gpt-4o-mini');

    // Plain 429 without quota language — per-model, not account-level.
    defaultTracker.recordFailure('openai', 'gpt-4o', 'rate_limit', 429, 'Too many requests');

    strictEqual(defaultTracker.getStatus('openai', 'gpt-4o')?.state, 'blocked');
    // Sibling must NOT be blocked.
    strictEqual(defaultTracker.isAvailable('openai', 'gpt-4o-mini'), true);
  });

  it('respects quarantineSiblingsOnQuotaExhausted: false', () => {
    const noFanOut = new ProviderModelStatusTracker({
      config: { quarantineSiblingsOnQuotaExhausted: false },
    });
    noFanOut.recordSuccess('openai', 'gpt-4o');
    noFanOut.recordSuccess('openai', 'gpt-4o-mini');

    noFanOut.recordFailure(
      'openai',
      'gpt-4o',
      'rate_limit',
      429,
      'insufficient_quota: account credit exhausted',
    );

    strictEqual(noFanOut.getStatus('openai', 'gpt-4o')?.state, 'blocked');
    // Sibling stays available when fan-out is disabled.
    strictEqual(noFanOut.isAvailable('openai', 'gpt-4o-mini'), true);
  });

  it('does not re-block already-blocked siblings', () => {
    // Pre-block one sibling with a long cooldown.
    tracker.recordFailure('openai', 'gpt-4o', 'server', 500, 'Server error');
    tracker.recordFailure('openai', 'gpt-4o', 'server', 500, 'Server error');
    tracker.recordFailure('openai', 'gpt-4o', 'server', 500, 'Server error');
    tracker.recordFailure('openai', 'gpt-4o', 'server', 500, 'Server error');
    tracker.recordFailure('openai', 'gpt-4o', 'server', 500, 'Server error');
    // Now gpt-4o is blocked via the consecutive-failures threshold.
    const originalExpiry = tracker.getStatus('openai', 'gpt-4o')?.stateExpiresAt;
    ok(originalExpiry !== null && originalExpiry !== undefined);

    tracker.recordSuccess('openai', 'gpt-4o-mini');

    // Trigger quota on the mini — gpt-4o is already blocked and should
    // keep its original expiry, not be overwritten by the sibling fan-out.
    tracker.recordFailure(
      'openai',
      'gpt-4o-mini',
      'rate_limit',
      429,
      'insufficient_quota: credit exhausted',
    );

    strictEqual(tracker.getStatus('openai', 'gpt-4o')?.state, 'blocked');
    // The already-blocked sibling's expiry was not changed.
    strictEqual(tracker.getStatus('openai', 'gpt-4o')?.stateExpiresAt, originalExpiry);
  });

  it('sibling quarantine message identifies the triggering model', () => {
    tracker.recordSuccess('openai', 'gpt-4o-mini');

    tracker.recordFailure(
      'openai',
      'gpt-4o',
      'rate_limit',
      429,
      'insufficient_quota: account credit exhausted',
    );

    const sibling = tracker.getStatus('openai', 'gpt-4o-mini');
    strictEqual(sibling?.state, 'blocked');
    ok(sibling?.lastErrorMessage?.includes('gpt-4o'));
    strictEqual(sibling?.lastErrorKind, 'quota_exhausted');
  });

  it('sets the sibling stateExpiresAt to match the triggering pair expiry', () => {
    tracker.recordSuccess('openai', 'gpt-4o-mini');

    tracker.recordFailure(
      'openai',
      'gpt-4o',
      'rate_limit',
      429,
      'insufficient_quota: account credit exhausted',
    );

    const triggerExpiry = tracker.getStatus('openai', 'gpt-4o')?.stateExpiresAt;
    const siblingExpiry = tracker.getStatus('openai', 'gpt-4o-mini')?.stateExpiresAt;
    ok(triggerExpiry !== null && triggerExpiry !== undefined);
    strictEqual(siblingExpiry, triggerExpiry);
  });

  it('propagates the actual trigger status (402) to quarantined siblings', () => {
    tracker.recordSuccess('openai', 'gpt-4o-mini');

    // 402 Payment Required triggers quota-exhausted detection without
    // any prose. The sibling must inherit the real status, not a
    // hardcoded 429.
    tracker.recordFailure('openai', 'gpt-4o', 'invalid_request', 402, 'Payment required');

    strictEqual(tracker.getStatus('openai', 'gpt-4o')?.lastErrorStatus, 402);
    strictEqual(tracker.getStatus('openai', 'gpt-4o-mini')?.lastErrorStatus, 402);
  });

  it('records an error-history entry for each quarantined sibling', () => {
    tracker.recordSuccess('openai', 'gpt-4o-mini');

    tracker.recordFailure(
      'openai',
      'gpt-4o',
      'rate_limit',
      429,
      'insufficient_quota: account credit exhausted',
    );

    const sibling = tracker.getStatus('openai', 'gpt-4o-mini');
    strictEqual(sibling?.recentErrors.length, 1);
    strictEqual(sibling?.recentErrors[0]?.kind, 'quota_exhausted');
    strictEqual(sibling?.recentErrors[0]?.status, 429);
    ok(sibling?.recentErrors[0]?.message.includes('gpt-4o'));
  });

  it('does not double-broadcast when re-triggering quarantine on an already-quarantined sibling', () => {
    // Track how many status_changed events are emitted for each model.
    const modelEvents = new Map<string, number>();
    const bump = (model: string) => modelEvents.set(model, (modelEvents.get(model) ?? 0) + 1);
    const eventTracker = new ProviderModelStatusTracker({
      config: {},
      events: {
        emit: (_event: string, payload: { model?: string }) => {
          if (payload.model) bump(payload.model);
        },
      } as unknown as import('../../src/kernel/events.js').EventBus,
    });
    eventTracker.recordSuccess('openai', 'gpt-4o-mini');

    eventTracker.recordFailure(
      'openai',
      'gpt-4o',
      'rate_limit',
      429,
      'insufficient_quota: account credit exhausted',
    );
    const siblingEventsAfterFirst = modelEvents.get('gpt-4o-mini') ?? 0;
    ok(siblingEventsAfterFirst >= 1, 'sibling should have received an event on first quarantine');

    // A second quota failure on a different model. The already-blocked
    // sibling (gpt-4o-mini) must NOT receive another event.
    eventTracker.recordSuccess('openai', 'gpt-4o-2');
    eventTracker.recordFailure(
      'openai',
      'gpt-4o-2',
      'rate_limit',
      429,
      'insufficient_quota: account credit exhausted',
    );
    const siblingEventsAfterSecond = modelEvents.get('gpt-4o-mini') ?? 0;

    strictEqual(siblingEventsAfterSecond, siblingEventsAfterFirst);
  });

  it('treats HTTP 402 as exhausted credit even without a provider-specific message', () => {
    tracker.recordFailure('metered', 'model-a', 'invalid_request', 402, 'Payment required');
    strictEqual(tracker.isAvailable('metered', 'model-a'), false);
  });

  it('does not confuse an ordinary burst rate limit with exhausted quota', () => {
    tracker.recordFailure('test', 'model-a', 'rate_limit', 429, '5 requests per minute');
    strictEqual(tracker.getStatus('test', 'model-a')?.state, 'healthy');
  });

  it('tracks an OmniRoute route as its logical provider/model identity', () => {
    tracker.recordFailure(
      'omniroute',
      'cc/claude-opus-4.8',
      'rate_limit',
      429,
      'credit exhausted for this route',
    );

    strictEqual(tracker.isAvailable('omniroute', 'cc/claude-opus-4.8'), false);
    strictEqual(tracker.isAvailable('cc', 'claude-opus-4.8'), false);
    strictEqual(tracker.isAvailable('omniroute', 'cc/claude-sonnet-4.7'), true);
    strictEqual(tracker.isAvailable('omniroute', 'openai/gpt-5.5'), true);

    const status = tracker.getStatus('omniroute', 'cc/claude-opus-4.8');
    strictEqual(status?.providerId, 'cc');
    strictEqual(status?.model, 'claude-opus-4.8');
  });

  it('enters blocked after 5 consecutive failures', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('test', 'model-a', 'server', 500, `Error ${i}`);
    }

    const status = tracker.getStatus('test', 'model-a');
    strictEqual(status?.state, 'blocked');
    strictEqual(status?.consecutiveFailures, 5);
  });

  it('isAvailable returns false for blocked pairs', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('test', 'model-a', 'server', 500, `Error ${i}`);
    }

    strictEqual(tracker.isAvailable('test', 'model-a'), false);
    strictEqual(tracker.isBlocked('test', 'model-a'), true);
  });

  // ── state: blocked → healthy (success streak recovery) ─────────────

  it('recovers from degraded to healthy after 3 consecutive successes', () => {
    tracker.recordFailure('test', 'model-a', 'server', 500, 'Error 1');
    tracker.recordFailure('test', 'model-a', 'server', 500, 'Error 2');

    strictEqual(tracker.getStatus('test', 'model-a')?.state, 'degraded');

    tracker.recordSuccess('test', 'model-a');
    tracker.recordSuccess('test', 'model-a');
    tracker.recordSuccess('test', 'model-a');

    strictEqual(tracker.getStatus('test', 'model-a')?.state, 'healthy');
  });

  // ── Error history ──────────────────────────────────────────────────

  it('stores error history with session/agent metadata', () => {
    tracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'Too many requests', {
      sessionId: 'sess_abc',
      agentId: 'agent_review_1',
      retryAfterMs: 12_000,
    });

    const status = tracker.getStatus('test', 'model-a');
    strictEqual(status?.lastSessionId, 'sess_abc');
    strictEqual(status?.lastAgentId, 'agent_review_1');
    strictEqual(status?.lastErrorMessage, 'Too many requests');
    strictEqual(status?.lastErrorKind, 'rate_limit');
    strictEqual(status?.recentErrors.length, 1);
    strictEqual(status?.recentErrors[0]?.kind, 'rate_limit');
    strictEqual(status?.recentErrors[0]?.retryAfterMs, 12_000);
  });

  it('honours long provider reset hints without truncating them to one minute', () => {
    tracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'Rate limited', {
      retryAfterMs: 20 * 60_000,
    });
    tracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'Rate limited', {
      retryAfterMs: 20 * 60_000,
    });

    ok((tracker.getStatus('test', 'model-a')?.stateExpiresAt ?? 0) > Date.now() + 19 * 60_000);
  });

  it('caps error history to maxErrorHistory', () => {
    for (let i = 0; i < 15; i++) {
      tracker.recordFailure('test', 'model-a', 'server', 500, `Error ${i}`);
    }

    const status = tracker.getStatus('test', 'model-a');
    ok(status !== undefined);
    ok(status.recentErrors.length <= 10, 'should cap at 10 entries');
  });

  // ── filterAvailable ───────────────────────────────────────────────

  it('filterAvailable removes blocked entries', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('test', 'model-a', 'server', 500, `Error ${i}`);
    }

    const entries = [
      { providerId: 'test', model: 'model-a' },
      { providerId: 'test', model: 'model-b' },
      { providerId: 'other', model: 'model-x' },
    ];

    const available = tracker.filterAvailable(entries);
    strictEqual(available.length, 2);
    strictEqual(available[0]?.model, 'model-b');
    strictEqual(available[1]?.model, 'model-x');
  });

  // ── Snapshot ───────────────────────────────────────────────────────

  it('getSnapshot returns correct summary stats', () => {
    // 2 failures → degraded
    tracker.recordFailure('p1', 'm1', 'server', 500, 'err');
    tracker.recordFailure('p1', 'm1', 'server', 500, 'err');

    // 3 rate-limits → blocked
    tracker.recordFailure('p2', 'm2', 'rate_limit', 429, 'rl');
    tracker.recordFailure('p2', 'm2', 'rate_limit', 429, 'rl');
    tracker.recordFailure('p2', 'm2', 'rate_limit', 429, 'rl');

    // healthy (just 1 failure, below threshold)
    tracker.recordFailure('p3', 'm3', 'timeout', 408, 'timeout');

    const snap = tracker.getSnapshot();
    strictEqual(snap.totalPairs, 3);
    strictEqual(snap.degraded, 1);
    strictEqual(snap.blocked, 1);
    strictEqual(snap.healthy, 1);
    strictEqual(snap.totalFailures, 6);
    strictEqual(snap.totalRateLimits, 3);
  });

  // ── Clear ──────────────────────────────────────────────────────────

  it('clear resets all tracking', () => {
    tracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'rl');
    tracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'rl');
    tracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'rl');

    strictEqual(tracker.isBlocked('test', 'model-a'), true);

    tracker.clear();
    strictEqual(tracker.isBlocked('test', 'model-a'), false);
    strictEqual(tracker.getAllStatuses().length, 0);
  });

  it('clear with provider/model resets a single pair', () => {
    tracker.recordFailure('p1', 'm1', 'server', 500, 'err');
    tracker.recordFailure('p1', 'm1', 'server', 500, 'err');
    tracker.recordFailure('p2', 'm2', 'server', 500, 'err');
    tracker.recordFailure('p2', 'm2', 'server', 500, 'err');

    strictEqual(tracker.getAllStatuses().length, 2);
    tracker.clear('p1', 'm1');
    strictEqual(tracker.getAllStatuses().length, 1);
  });

  // ── The chimera-review pattern: empty_response / overloaded ─────────
  //
  // The mailbox shows 11+ chimera-review tasks failing with:
  //   1 iteration, 0 tools, 29-40s, empty_response
  // This simulates that pattern with ProviderErrors.

  it('records the chimera-review empty_response pattern — overloaded blocks after 5', () => {
    // Simulate 5 chimera-review failures — overloaded blocks after 5 consecutive fails
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure(
        'openai',
        'gpt-4o',
        'overloaded',
        529,
        'Empty response — model returned no content after 35s',
        {
          sessionId: 'sess_review_001',
          agentId: 'chimera-review-abc',
        },
      );
    }

    const status = tracker.getStatus('openai', 'gpt-4o');
    strictEqual(status?.state, 'blocked');
    strictEqual(status?.overloadedHits, 5);
    strictEqual(status?.lastErrorMessage, 'Empty response — model returned no content after 35s');
    strictEqual(status?.lastSessionId, 'sess_review_001');
    strictEqual(status?.lastAgentId, 'chimera-review-abc');

    // After blocking, tracking should prevent new chimera spawns
    strictEqual(tracker.isAvailable('openai', 'gpt-4o'), false);

    // But a different model on the same provider should still be available
    strictEqual(tracker.isAvailable('openai', 'gpt-4o-mini'), true);
  });

  it('records the chimera-review pattern — rate_limit blocks after 3', () => {
    // 3 rate_limit failures → blocked (different threshold from overloaded)
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure(
        'openai',
        'gpt-4o',
        'rate_limit',
        429,
        'Rate limited after 5 requests per minute',
        {
          sessionId: 'sess_review_002',
          agentId: 'chimera-review-xyz',
        },
      );
    }

    const status = tracker.getStatus('openai', 'gpt-4o');
    strictEqual(status?.state, 'blocked');
    strictEqual(status?.rateLimitHits, 3);
    strictEqual(tracker.isAvailable('openai', 'gpt-4o'), false);
  });

  it('a different failure kind resets count for empty_response model', () => {
    // First chimera-review fails with overloaded
    tracker.recordFailure('openai', 'gpt-4o', 'overloaded', 529, 'Empty response', {
      sessionId: 'sess_1',
      agentId: 'chimera-review-1',
    });
    // Second one also fails
    tracker.recordFailure('openai', 'gpt-4o', 'overloaded', 529, 'Empty response', {
      sessionId: 'sess_2',
      agentId: 'chimera-review-2',
    });
    // Third one fails — crosses into degraded
    tracker.recordFailure('openai', 'gpt-4o', 'overloaded', 529, 'Empty response', {
      sessionId: 'sess_3',
      agentId: 'chimera-review-3',
    });

    strictEqual(tracker.getStatus('openai', 'gpt-4o')?.state, 'degraded');

    // Then a success — resets consecutive failures
    tracker.recordSuccess('openai', 'gpt-4o');

    strictEqual(tracker.getStatus('openai', 'gpt-4o')?.consecutiveFailures, 0);

    // But continue to fail again — now counts fresh
    tracker.recordFailure('openai', 'gpt-4o', 'overloaded', 529, 'Empty response again', {
      sessionId: 'sess_4',
      agentId: 'chimera-review-4',
    });

    strictEqual(tracker.getStatus('openai', 'gpt-4o')?.consecutiveFailures, 1);
  });

  // ── Auto-recovery on cooldown expiry ────────────────────────────────

  it('auto-recovers from blocked when cooldown expires', () => {
    // Use a tracker with a very short block duration
    const fastTracker = new ProviderModelStatusTracker({
      config: {
        blockDurationMs: 1, // 1ms — immediately expires
        quotaBlockDurationMs: 50_000,
        blockAfterRateLimitHits: 3,
        degradedAfterFailures: 2,
        blockAfterFailures: 5,
        degradedDurationMs: 50_000,
        recoverAfterSuccesses: 3,
        maxErrorHistory: 10,
      },
    });

    fastTracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'rl');
    fastTracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'rl');
    fastTracker.recordFailure('test', 'model-a', 'rate_limit', 429, 'rl');

    // Assert the recorded transition without consulting the wall clock: with
    // a 1 ms cooldown, a busy parallel test worker may already be past expiry.
    strictEqual(fastTracker.getStatus('test', 'model-a')?.state, 'blocked');

    // Wait for cooldown to expire
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        strictEqual(fastTracker.isAvailable('test', 'model-a'), true);
        strictEqual(fastTracker.isBlocked('test', 'model-a'), false);
        resolve();
      }, 10);
    });
  });

  it('sweepExpired releases waiting-room entries while idle', async () => {
    const fastTracker = new ProviderModelStatusTracker({
      config: {
        blockDurationMs: 50_000,
        quotaBlockDurationMs: 20,
      },
    });
    fastTracker.recordFailure('metered', 'model-a', 'rate_limit', 429, 'credit exhausted');
    strictEqual(fastTracker.isBlocked('metered', 'model-a'), true);

    await new Promise((resolve) => setTimeout(resolve, 30));
    strictEqual(fastTracker.sweepExpired(), 1);
    strictEqual(fastTracker.isAvailable('metered', 'model-a'), true);
  });

  it('retryNow releases exactly one namespaced model and retains its history', () => {
    tracker.recordFailure('omniroute', 'cc/claude-opus-4.8', 'rate_limit', 429, 'credit exhausted');

    strictEqual(tracker.retryNow('cc', 'claude-opus-4.8'), true);
    strictEqual(tracker.isAvailable('omniroute', 'cc/claude-opus-4.8'), true);
    strictEqual(tracker.getStatus('omniroute', 'cc/claude-opus-4.8')?.recentErrors.length, 1);
    strictEqual(tracker.retryNow('cc', 'claude-opus-4.8'), false);
  });

  it('restores only non-expired waiting entries across process restarts', () => {
    tracker.recordFailure('omniroute', 'cc/claude-opus-4.8', 'quota_exhausted', 429, 'quota');
    const snapshot = tracker.getSnapshot();
    const restored = createTestTracker();

    strictEqual(restored.restoreSnapshot(snapshot), 1);
    strictEqual(restored.isAvailable('cc', 'claude-opus-4.8'), false);
    strictEqual(restored.getStatus('cc', 'claude-opus-4.8')?.lastErrorKind, 'quota_exhausted');
    strictEqual(restored.isAvailable('cc', 'unseen-sibling'), false);
  });

  it('restores provider-wide blocks classified from a rate-limit message', () => {
    tracker.recordFailure('openai', 'gpt-4o', 'rate_limit', 429, 'account credit exhausted');
    const restored = createTestTracker();

    strictEqual(restored.restoreSnapshot(tracker.getSnapshot()), 1);
    strictEqual(restored.isAvailable('openai', 'unseen-sibling'), false);
  });

  it('ignores malformed and expired persisted entries', () => {
    const restored = createTestTracker();
    const count = restored.restoreSnapshot({
      statuses: [
        null,
        { providerId: 12, model: 'x', state: 'blocked' },
        {
          providerId: 'cc',
          model: 'old',
          state: 'blocked',
          stateExpiresAt: Date.now() - 1,
        },
      ],
    });
    strictEqual(count, 0);
    strictEqual(restored.getAllStatuses().length, 0);
  });

  // ── ProviderError integration ──────────────────────────────────────

  it('classifies and records ProviderError kinds', () => {
    const err = new ProviderError('Rate limited', 429, true, 'test', {
      body: {
        type: 'rate_limit_error',
        message: 'Too fast',
        retryAfterMs: 5000,
      },
    });

    tracker.recordFailure('test', 'model-a', err.kind, err.status, err.describe(), {
      retryAfterMs: err.body?.retryAfterMs,
    });

    const status = tracker.getStatus('test', 'model-a');
    strictEqual(status?.lastErrorKind, 'rate_limit');
    strictEqual(status?.rateLimitHits, 1);
  });

  it('unblocks and clears failure state on manual unblock', () => {
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure('test', 'model-a', 'server', 500, `Error ${i}`);
    }
    strictEqual(tracker.isAvailable('test', 'model-a'), false);

    tracker.unblock('test', 'model-a');
    strictEqual(tracker.isAvailable('test', 'model-a'), true);
    strictEqual(tracker.getStatus('test', 'model-a')?.state, 'healthy');
  });
});
