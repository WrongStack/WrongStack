/**
 * Drift guard for the reviewer default fallback chain.
 *
 * DEFAULT_REVIEW_FALLBACK_MODELS is defined once in
 * packages/core/src/plugins/auto-review-plugin.ts and shared with the CLI
 * reviewer spawn in packages/cli/src/execution.ts via the exported
 * resolveReviewerFallbackModels() helper. These tests assert, by strict
 * runtime value equality against the real production code path, that the two
 * spawn seams cannot diverge — which is exactly the drift that could reopen the
 * chimera-review `provider_auth` (1 iter / 0 tools) failure on one seam but not
 * the other.
 *
 * See: fix(auto-review) 623bd441a + refactor(auto-review) a93f3310a.
 */

import { DEFAULT_REVIEW_FALLBACK_MODELS } from '@wrongstack/core/plugin';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __resetReviewerRoundRobinCursor,
  assignReviewerModelsRoundRobin,
  resolveReviewerFallbackModels,
} from '../src/execution.js';

describe('reviewer fallback-chain drift guard', () => {
  it('exposes a non-empty shared DEFAULT_REVIEW_FALLBACK_MODELS from @wrongstack/core', () => {
    expect(Array.isArray(DEFAULT_REVIEW_FALLBACK_MODELS)).toBe(true);
    expect(DEFAULT_REVIEW_FALLBACK_MODELS.length).toBeGreaterThan(0);
  });

  it('every default entry is a well-formed provider/model ref', () => {
    // Guards against a malformed default list (e.g. a bare profile name or a
    // model with no provider) that would 401 as "Model is not supported".
    for (const ref of DEFAULT_REVIEW_FALLBACK_MODELS) {
      expect(typeof ref).toBe('string');
      const slash = ref.indexOf('/');
      expect(slash, `"${ref}" must be provider/model`).toBeGreaterThan(0);
      expect(slash, `"${ref}" must have a model after the slash`).toBeLessThan(ref.length - 1);
    }
  });

  it('CLI reviewer spawn resolves exactly the shared default when no bundle chain is present', () => {
    // Strict runtime value comparison against the production code path: the
    // manual/ordinary-Chimera reviewer spawn calls resolveReviewerFallbackModels()
    // with no bundle chain, so it MUST equal the shared core default. If a future
    // edit re-hardcodes a divergent local list, this equality fails in CI.
    expect(resolveReviewerFallbackModels()).toEqual([...DEFAULT_REVIEW_FALLBACK_MODELS]);
    expect(resolveReviewerFallbackModels(undefined)).toEqual([...DEFAULT_REVIEW_FALLBACK_MODELS]);
    expect(resolveReviewerFallbackModels([])).toEqual([...DEFAULT_REVIEW_FALLBACK_MODELS]);
  });

  it('returns a fresh mutable copy (never aliases the shared frozen constant)', () => {
    const a = resolveReviewerFallbackModels();
    const b = resolveReviewerFallbackModels();
    expect(a).not.toBe(b);
    expect(a).not.toBe(DEFAULT_REVIEW_FALLBACK_MODELS);
    // SubagentConfig.fallbackModels is a mutable string[]; mutating the result
    // must not corrupt the shared source constant.
    a.push('mutation/check');
    expect(resolveReviewerFallbackModels()).toEqual([...DEFAULT_REVIEW_FALLBACK_MODELS]);
  });

  it('uses the auto-review bundle chain verbatim when one is supplied', () => {
    // When the bundle already resolved a chain, the reviewer must use it as-is
    // rather than the default — the other half of the spawn contract.
    const bundleChain = ['minimax-coding-plan/MiniMax-M3', 'zai-coding-plan/glm-5.2'];
    expect(resolveReviewerFallbackModels(bundleChain)).toEqual(bundleChain);
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
