/**
 * Drift guard for Chimera reviewer fallback routing.
 *
 * Chimera must not maintain its own hard-coded fallback model chain. Reviewer
 * fallbacks come from the resolved auto-review bundle/profile, or from an
 * explicit session-ref append requested by the spawn caller.
 */

import { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetReviewerRoundRobinCursor,
  assignReviewerModelsRoundRobin,
  resolveReviewerFallbackModels,
} from '../src/execution.js';

describe('reviewer fallback-chain drift guard', () => {
  it('does not synthesize a default fallback chain when no bundle chain is present', () => {
    expect(resolveReviewerFallbackModels()).toEqual([]);
    expect(resolveReviewerFallbackModels(undefined)).toEqual([]);
    expect(resolveReviewerFallbackModels([])).toEqual([]);
  });

  it('returns a fresh mutable copy of a supplied auto-review bundle chain', () => {
    const bundleChain = ['minimax-coding-plan/MiniMax-M3', 'zai-coding-plan/glm-5.2'];
    const resolved = resolveReviewerFallbackModels(bundleChain);

    expect(resolved).toEqual(bundleChain);
    expect(resolved).not.toBe(bundleChain);
    resolved.push('mutation/check');
    expect(bundleChain).toEqual(['minimax-coding-plan/MiniMax-M3', 'zai-coding-plan/glm-5.2']);
  });

  it('can append the session provider/model as an explicit caller-provided fallback', () => {
    expect(resolveReviewerFallbackModels(undefined, 'session-provider/session-model')).toEqual([
      'session-provider/session-model',
    ]);
    expect(
      resolveReviewerFallbackModels(['alt-provider/alt-model'], 'session-provider/session-model'),
    ).toEqual(['alt-provider/alt-model', 'session-provider/session-model']);
  });

  it('does not duplicate an explicit session fallback already present in the supplied chain', () => {
    expect(
      resolveReviewerFallbackModels(
        ['alt-provider/alt-model', 'session-provider/session-model'],
        'session-provider/session-model',
      ),
    ).toEqual(['alt-provider/alt-model', 'session-provider/session-model']);
  });
});

describe('assignReviewerModelsRoundRobin — concurrent chimera spawn', () => {
  afterEach(() => {
    __resetReviewerRoundRobinCursor(0);
  });

  it('rotates primary across primary+fallback pool on successive spawns', () => {
    __resetReviewerRoundRobinCursor(0);
    const fallbacks = ['alt/m1', 'alt/m2'];

    const a = assignReviewerModelsRoundRobin('base', 'm0', fallbacks);
    expect(a.provider).toBe('base');
    expect(a.model).toBe('m0');
    expect(a.fallbackModels).toEqual(['alt/m1', 'alt/m2']);

    const b = assignReviewerModelsRoundRobin('base', 'm0', fallbacks);
    expect(b.provider).toBe('alt');
    expect(b.model).toBe('m1');
    expect(b.fallbackModels).toEqual(['alt/m2', 'base/m0']);

    const c = assignReviewerModelsRoundRobin('base', 'm0', fallbacks);
    expect(c.provider).toBe('alt');
    expect(c.model).toBe('m2');
    expect(c.fallbackModels).toEqual(['base/m0', 'alt/m1']);
  });

  it('is a no-op when the pool has a single entry', () => {
    __resetReviewerRoundRobinCursor(0);
    const a = assignReviewerModelsRoundRobin('only', 'm', []);
    expect(a).toEqual({ provider: 'only', model: 'm', fallbackModels: [] });
    const b = assignReviewerModelsRoundRobin('only', 'm', ['only/m']);
    expect(b.provider).toBe('only');
    expect(b.model).toBe('m');
  });

  describe('with a ProviderModelStatusTracker (waiting-room filter)', () => {
    // The 429 → waiting-room contract: a single rate_limit failure on a
    // (provider, model) pair must redirect every concurrent Chimera turn
    // away from the doomed model. Without this, the round-robin cursor
    // would re-pick the blocked primary on the next concurrent spawn and
    // burn the whole chain in a loop.
    function block(tracker: ProviderModelStatusTracker, providerId: string, model: string): void {
      tracker.recordFailure(providerId, model, 'rate_limit', 429, 'rate limited', {
        retryAfterMs: 60_000,
      });
    }

    it('rotates the cursor past a tracker-blocked primary to the next healthy entry', () => {
      __resetReviewerRoundRobinCursor(0);
      const tracker = new ProviderModelStatusTracker();
      block(tracker, 'base', 'm0');
      const fallbacks = ['alt/m1', 'alt/m2'];

      // Cursor 0 WITHOUT the tracker would pick base/m0. With the tracker
      // filtering base/m0 out, the live pool is [alt/m1, alt/m2] and we
      // expect alt/m1 to be the primary — proving the doomed model is
      // never re-spawned on a concurrent reviewer turn.
      const a = assignReviewerModelsRoundRobin('base', 'm0', fallbacks, tracker);
      expect(a.provider).toBe('alt');
      expect(a.model).toBe('m1');
      expect(a.fallbackModels).toEqual(['alt/m2']);
    });

    it('returns the no-op single-entry shape when the tracker blocks every candidate', () => {
      __resetReviewerRoundRobinCursor(0);
      const tracker = new ProviderModelStatusTracker();
      block(tracker, 'base', 'm0');
      block(tracker, 'alt', 'm1');
      const a = assignReviewerModelsRoundRobin('base', 'm0', ['alt/m1'], tracker);
      // pool.length collapses to 0 after the filter; the no-op branch
      // returns the original primary + fallbacks verbatim (matches the
      // pre-existing "single-entry" shape).
      expect(a.provider).toBe('base');
      expect(a.model).toBe('m0');
      expect(a.fallbackModels).toEqual(['alt/m1']);
    });

    it('without a tracker, behaves exactly like the legacy round-robin (no behavior drift)', () => {
      // Pin the legacy contract: callers that do not yet supply a tracker
      // keep the original cursor advancement and rotation. Important so
      // adding the optional dep cannot regress any pre-tracker spawn path.
      __resetReviewerRoundRobinCursor(0);
      const fallbacks = ['alt/m1', 'alt/m2'];

      const a = assignReviewerModelsRoundRobin('base', 'm0', fallbacks);
      expect(a).toEqual({
        provider: 'base',
        model: 'm0',
        fallbackModels: ['alt/m1', 'alt/m2'],
      });

      const b = assignReviewerModelsRoundRobin('base', 'm0', fallbacks);
      expect(b.provider).toBe('alt');
      expect(b.model).toBe('m1');
    });
  });
});
