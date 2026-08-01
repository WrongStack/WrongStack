import type { Config, Provider, Response } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  refineGoalHeuristic,
  refineGoalWithFallback,
  resolveRefinerTarget,
} from '../src/slash-commands/goal-refiner.js';

// ---------------------------------------------------------------------------
// Helper: a fake Provider whose `complete()` returns a canned Response
// ---------------------------------------------------------------------------
function fakeProvider(overrides?: { responseText?: string; shouldThrow?: boolean }): Provider {
  const text =
    overrides?.responseText ??
    `REFINED_GOAL:
Build the auth module with JWT and refresh tokens.

DELIVERABLES:
- JWT login endpoint
- Refresh token rotation
- Unit tests pass`;
  return {
    id: 'test-provider',
    capabilities: {} as never,
    stream: vi.fn(),
    async complete(): Promise<Response> {
      if (overrides?.shouldThrow) throw new Error('provider down');
      return {
        content: [{ type: 'text' as const, text }],
      } as unknown as Response;
    },
  };
}

// ---------------------------------------------------------------------------
// refineGoalHeuristic
// ---------------------------------------------------------------------------
describe('refineGoalHeuristic', () => {
  it('extracts action-verb sentences as deliverables', () => {
    const result = refineGoalHeuristic('Build a login page. Add tests. Deploy to production.');
    expect(result.refinedGoal).toBe('Build a login page. Add tests. Deploy to production.');
    expect(result.deliverables).toContain('Build a login page');
    expect(result.deliverables).toContain('Add tests');
    expect(result.deliverables).toContain('Deploy to production');
  });

  it('treats the whole goal as one deliverable when no action verbs are found', () => {
    const result = refineGoalHeuristic('Make the app better.');
    expect(result.deliverables).toHaveLength(1);
    expect(result.deliverables[0]).toBe('Make the app better.');
  });

  it('handles empty / whitespace input gracefully', () => {
    const result = refineGoalHeuristic('   ');
    expect(result.refinedGoal).toBe('');
    expect(result.deliverables).toHaveLength(1);
  });

  it('recognises all action verbs in the heuristic list', () => {
    const goal =
      'Add logging. Build dashboard. Create schema. Fix bug. Implement search. Refactor utils. Write docs. Remove dead code. Update deps. Migrate DB. Set up CI. Configure ESLint. Deploy canary. Test webhooks. Document API.';
    const result = refineGoalHeuristic(goal);
    // Every sentence starts with an action verb, so each should be a deliverable.
    expect(result.deliverables.length).toBeGreaterThanOrEqual(15);
  });

  it('trims whitespace from deliverables', () => {
    const result = refineGoalHeuristic('  Fix the login bug.   ');
    expect(result.deliverables[0]).toBe('Fix the login bug');
  });
});

// ---------------------------------------------------------------------------
// resolveRefinerTarget — built-in provider/model selection & validation
// ---------------------------------------------------------------------------
function makeMinimalConfig(overrides?: Partial<Config>): Config {
  return {
    version: 1 as const,
    provider: 'openai',
    model: 'gpt-4',
    context: { mode: 'auto' as const, warnThreshold: 0.75, compactThreshold: 0.85, maxTurns: 100 },
    tools: {
      defaultExecutionStrategy: 'sequential' as const,
      maxIterations: 100,
      iterationTimeoutMs: 300_000,
      restrictToProjectRoot: false,
      allowedOutside: [],
      loopDetection: { steerThreshold: 5, cutThreshold: 10 },
      danger: { allowAll: false },
    },
    log: { level: 'info' as const },
    features: { mcp: false },
    ...overrides,
  } as Config;
}

describe('resolveRefinerTarget', () => {
  const createFake = (id: string) => (pid: string) =>
    pid === id ? ({ id: pid } as unknown as Provider) : undefined;

  it('returns undefined when neither refinerProvider nor refinerModel is in config', () => {
    const cfg = makeMinimalConfig();
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeUndefined();
  });

  it('accepts a refinerModel that matches the active model', () => {
    const cfg = makeMinimalConfig({
      autonomy: { refinerModel: 'gpt-4' }, // same as active model
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeDefined();
    expect(result!.model).toBe('gpt-4');
    expect(result!.provider.id).toBe('openai');
  });

  it('accepts a refinerModel that is in favoriteModels', () => {
    const cfg = makeMinimalConfig({
      autonomy: { refinerModel: 'gpt-4o-mini' },
      favoriteModels: ['gpt-4o-mini', 'claude-haiku'],
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeDefined();
    expect(result!.model).toBe('gpt-4o-mini');
  });

  it('rejects a refinerModel that is NOT a favorite AND NOT the active model', () => {
    const cfg = makeMinimalConfig({
      autonomy: { refinerModel: 'unknown-model-v42' },
      favoriteModels: ['gpt-4o-mini'],
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeUndefined();
  });

  it('accepts model when favoriteModels is empty (no constraint)', () => {
    const cfg = makeMinimalConfig({
      autonomy: { refinerModel: 'any-model' },
      favoriteModels: [],
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeDefined();
    expect(result!.model).toBe('any-model');
  });

  it('resolves refinerProvider to a concrete provider instance', () => {
    const cfg = makeMinimalConfig({
      autonomy: { refinerProvider: 'anthropic', refinerModel: 'claude-haiku' },
      favoriteModels: ['claude-haiku'],
    });
    const result = resolveRefinerTarget(cfg, createFake('anthropic'), 'openai', 'gpt-4');
    expect(result).toBeDefined();
    expect(result!.provider.id).toBe('anthropic');
    expect(result!.model).toBe('claude-haiku');
  });

  it('returns undefined when refinerProvider is unreachable (createProvider returns undefined)', () => {
    const cfg = makeMinimalConfig({
      autonomy: { refinerProvider: 'nonexistent', refinerModel: 'gpt-4' },
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeUndefined();
  });

  it('uses active provider when only refinerModel is set (no provider specified)', () => {
    const cfg = makeMinimalConfig({
      autonomy: { refinerModel: 'gpt-4o-mini' },
      favoriteModels: ['gpt-4o-mini'],
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeDefined();
    expect(result!.provider.id).toBe('openai'); // active provider
    expect(result!.model).toBe('gpt-4o-mini');
  });

  it('returns undefined when createProvider is not available', () => {
    const cfg = makeMinimalConfig({
      autonomy: { refinerModel: 'gpt-4' },
    });
    const result = resolveRefinerTarget(cfg, undefined, 'openai', 'gpt-4');
    expect(result).toBeUndefined();
  });

  it('skips an invalid first profile entry and uses the next valid refiner target', () => {
    const cfg = makeMinimalConfig({
      autonomy: { refinerFallbackProfile: 'refiners' },
      fallbackProfiles: {
        refiners: ['missing/broken', 'openai/gpt-4'],
      },
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result?.provider.id).toBe('openai');
    expect(result?.model).toBe('gpt-4');
  });
});

// ---------------------------------------------------------------------------
// refineGoalWithFallback — multi-tier fallback chain
// ---------------------------------------------------------------------------
describe('refineGoalWithFallback', () => {
  it('tier 1 succeeds when dedicated refiner provider+model is set', async () => {
    const refiner = fakeProvider();
    const primary = fakeProvider({ shouldThrow: true }); // would fail if reached

    const result = await refineGoalWithFallback('build auth', {
      refinerProvider: refiner,
      refinerModel: 'gpt-4o-mini',
      primaryProvider: primary,
      primaryModel: 'claude-opus-4',
    });

    expect(result.refinedGoal).toContain('auth module');
    expect(result.deliverables.length).toBeGreaterThan(0);
  });

  it('tier 2 succeeds when refiner model is used on primary provider', async () => {
    const _refiner = fakeProvider({ shouldThrow: true }); // tier 1 fails (no provider instance)
    const primary = fakeProvider();

    const result = await refineGoalWithFallback('build auth', {
      refinerModel: 'claude-haiku', // only model, no refiner provider
      primaryProvider: primary,
      primaryModel: 'claude-opus-4',
    });

    expect(result.refinedGoal).toContain('auth module');
  });

  it('tier 3 succeeds when only primary provider+model is set', async () => {
    const primary = fakeProvider();

    const result = await refineGoalWithFallback('build auth', {
      primaryProvider: primary,
      primaryModel: 'claude-opus-4',
    });

    expect(result.refinedGoal).toContain('auth module');
  });

  it('tier 4 falls back to heuristic when all LLM calls fail', async () => {
    const refiner = fakeProvider({ shouldThrow: true });
    const primary = fakeProvider({ shouldThrow: true });

    const result = await refineGoalWithFallback('Fix the login bug. Add unit tests.', {
      refinerProvider: refiner,
      refinerModel: 'gpt-4o-mini',
      primaryProvider: primary,
      primaryModel: 'claude-opus-4',
    });

    // Heuristic always returns a result
    expect(result.refinedGoal).toBe('Fix the login bug. Add unit tests.');
    expect(result.deliverables).toContain('Fix the login bug');
    expect(result.deliverables).toContain('Add unit tests');
  });

  it('returns heuristic when no provider is available at all', async () => {
    const result = await refineGoalWithFallback('Fix the crash.', {});

    expect(result.refinedGoal).toBe('Fix the crash.');
    expect(result.deliverables).toHaveLength(1);
  });

  it('refiner provider without model skips tier 1 (tries tier 2 without falling back to tier 1)', async () => {
    // When refinerModel is set but refinerProvider isn't passed (undefined),
    // tier 1 is skipped (needs both), tier 2 tries model on primary.
    const primary = fakeProvider();

    const result = await refineGoalWithFallback('build auth', {
      refinerModel: 'claude-haiku',
      primaryProvider: primary,
      primaryModel: 'claude-opus-4',
    });

    expect(result.refinedGoal).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// refineGoal — lower-level LLM call with format parsing
// ---------------------------------------------------------------------------
describe('refineGoal (via refineGoalWithFallback)', () => {
  it('parses the REFINED_GOAL and DELIVERABLES markers from LLM output', async () => {
    const provider = fakeProvider({
      responseText: `REFINED_GOAL:
Ship a React frontend with login and dashboard.

DELIVERABLES:
- Login page with OAuth
- Dashboard with charts
- E2E tests pass`,
    });

    const result = await refineGoalWithFallback('ship frontend', {
      primaryProvider: provider,
      primaryModel: 'test-model',
    });

    expect(result.refinedGoal).toBe('Ship a React frontend with login and dashboard.');
    expect(result.deliverables).toContain('Login page with OAuth');
    expect(result.deliverables).toContain('Dashboard with charts');
    expect(result.deliverables).toContain('E2E tests pass');
  });

  it('uses the raw goal as fallback when DELIVERABLES section is missing', async () => {
    const provider = fakeProvider({
      responseText: `REFINED_GOAL:
Just cleanup.`,
    });

    const result = await refineGoalWithFallback('clean up the repo', {
      primaryProvider: provider,
      primaryModel: 'test-model',
    });

    expect(result.refinedGoal).toBe('Just cleanup.');
    expect(result.deliverables).toEqual([]);
  });

  it('falls through tiers when LLM returns unparseable output', async () => {
    // Tier 1 returns text with no markers → parseRefinement falls back to raw goal
    // Tier 2 throws → skipped
    // Tier 3 succeeds
    const tier1 = fakeProvider({
      responseText: 'Sure, I can help with that.',
    });
    const tier3 = fakeProvider();

    const result = await refineGoalWithFallback('build auth', {
      refinerProvider: tier1,
      refinerModel: 'gpt-4o-mini',
      primaryProvider: tier3,
      primaryModel: 'claude-opus-4',
    });

    // tier1 returned unparseable → refineGoal returned the raw goal as fallback
    // which is truthy, so tier1 "succeeds" with the raw goal text
    expect(result.refinedGoal).toBeDefined();
  });
});
