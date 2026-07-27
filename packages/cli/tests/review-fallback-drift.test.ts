/**
 * Drift guard for Chimera reviewer fallback routing.
 *
 * Chimera must not maintain its own hard-coded fallback model chain. Reviewer
 * fallbacks come from the resolved auto-review bundle/profile, or from an
 * explicit session-ref append requested by the spawn caller.
 */

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
    expect(resolveReviewerFallbackModels(['alt-provider/alt-model'], 'session-provider/session-model')).toEqual([
      'alt-provider/alt-model',
      'session-provider/session-model',
    ]);
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
});
