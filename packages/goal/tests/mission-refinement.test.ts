import type { Config } from '@wrongstack/contracts/types/config';
import type { Provider, Response } from '@wrongstack/contracts/types/provider';
import { describe, expect, it, vi } from 'vitest';
import { refineGoalWithProvider, resolveRefinerTarget } from '../src/mission-refinement.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<Config>): Config {
  return {
    provider: 'openai',
    model: 'gpt-4',
    ...overrides,
  } as Config;
}

const WELL_FORMED =
  'REFINED_GOAL:\nBuild the auth module with JWT.\n\nDELIVERABLES:\n- JWT login endpoint';

type CompleteOpts = { signal?: AbortSignal | undefined };

function fakeProvider(
  overrides: {
    responseText?: string;
    shouldThrow?: boolean;
    /** complete() never resolves; it rejects only when its signal aborts. */
    hangUntilAbort?: boolean;
    /** complete() rejects with a late failure after this many ms (races the deadline). */
    rejectAfterMs?: number;
    /** complete() resolves with this text when its signal aborts (SDKs that swallow aborts). */
    resolveOnAbort?: string;
  } = {},
): Provider {
  const text = overrides.responseText ?? WELL_FORMED;
  return {
    id: 'test-provider',
    capabilities: {} as never,
    stream: vi.fn(),
    async complete(_request: unknown, runOpts: CompleteOpts): Promise<Response> {
      if (overrides.shouldThrow) throw new Error('provider down');
      if (overrides.rejectAfterMs !== undefined) {
        await new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('late provider failure')), overrides.rejectAfterMs);
        });
      }
      if (overrides.resolveOnAbort !== undefined) {
        const abortedText = await new Promise<string>((resolve) => {
          runOpts.signal?.addEventListener('abort', () => resolve(overrides.resolveOnAbort!), {
            once: true,
          });
        });
        return {
          content: [{ type: 'text' as const, text: abortedText }],
          usage: { input: 10, output: 5 },
        } as unknown as Response;
      }
      if (overrides.hangUntilAbort) {
        await new Promise<never>((_, reject) => {
          runOpts.signal?.addEventListener(
            'abort',
            () => reject(runOpts.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      }
      return {
        content: [{ type: 'text' as const, text }],
        usage: { input: 10, output: 5 },
      } as unknown as Response;
    },
  } as unknown as Provider;
}

// ---------------------------------------------------------------------------
// resolveRefinerTarget — favorites-gate removal + preserved selection rules
// ---------------------------------------------------------------------------

describe('resolveRefinerTarget', () => {
  const createFake = (id: string) => (pid: string) =>
    pid === id ? ({ id: pid } as unknown as Provider) : undefined;

  it('returns undefined when neither refinerProvider nor refinerModel is configured', () => {
    const result = resolveRefinerTarget(makeConfig(), createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeUndefined();
  });

  it('resolves a refinerModel even when NOT favorited and NOT the active model (gate removed)', () => {
    // The old resolver silently returned undefined here, making the config
    // key inert for goal refinement while prompt refinement honored the same
    // configuration. The shared spec resolver removed that divergence.
    const cfg = makeConfig({
      autonomy: { refinerModel: 'unknown-model-v42' },
      favoriteModels: ['gpt-4o-mini'],
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeDefined();
    expect(result!.provider.id).toBe('openai');
    expect(result!.model).toBe('unknown-model-v42');
  });

  it('still resolves a favorited refinerModel (behavior preserved)', () => {
    const cfg = makeConfig({
      autonomy: { refinerModel: 'gpt-4o-mini' },
      favoriteModels: ['gpt-4o-mini', 'claude-haiku'],
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeDefined();
    expect(result!.model).toBe('gpt-4o-mini');
  });

  it('defaults the model to the active model when only refinerProvider is set', () => {
    const cfg = makeConfig({ autonomy: { refinerProvider: 'anthropic' } });
    const result = resolveRefinerTarget(cfg, createFake('anthropic'), 'openai', 'gpt-4');
    expect(result).toBeDefined();
    expect(result!.provider.id).toBe('anthropic');
    expect(result!.model).toBe('gpt-4');
  });

  it('prefers the named profile and skips entries whose provider cannot be built', () => {
    const cfg = makeConfig({
      autonomy: { refinerFallbackProfile: 'refiners' },
      fallbackProfiles: { refiners: ['missing/broken', 'openai/gpt-4'] },
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result?.provider.id).toBe('openai');
    expect(result?.model).toBe('gpt-4');
  });

  it("keeps scanning profile entries until one builds, then applies that entry's model", () => {
    const providers: Record<string, Provider> = {
      deepseek: { id: 'deepseek' } as unknown as Provider,
      openai: { id: 'openai' } as unknown as Provider,
    };
    const cfg = makeConfig({
      autonomy: { refinerFallbackProfile: 'refiners' },
      fallbackProfiles: { refiners: ['ghost/one', 'deepseek/deepseek-chat', 'openai/gpt-4'] },
    });
    const result = resolveRefinerTarget(cfg, (pid) => providers[pid], 'openai', 'gpt-4');
    expect(result?.provider.id).toBe('deepseek');
    expect(result?.model).toBe('deepseek-chat');
  });

  it('does NOT fall through past the explicit candidate when its provider cannot be built', () => {
    // The explicit provider/model pair is the LAST candidate: a broken
    // dedicated refiner must fall back to the caller's session target
    // (undefined here), never skip to some unrelated configured entry.
    const cfg = makeConfig({
      autonomy: { refinerProvider: 'nonexistent', refinerModel: 'm' },
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeUndefined();
  });

  it('returns undefined when refinerProvider is unreachable (createProvider returns undefined)', () => {
    const cfg = makeConfig({
      autonomy: { refinerProvider: 'nonexistent', refinerModel: 'gpt-4' },
    });
    const result = resolveRefinerTarget(cfg, createFake('openai'), 'openai', 'gpt-4');
    expect(result).toBeUndefined();
  });

  it('returns undefined when createProvider is not available', () => {
    const cfg = makeConfig({ autonomy: { refinerModel: 'gpt-4' } });
    const result = resolveRefinerTarget(cfg, undefined, 'openai', 'gpt-4');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// refineGoalWithProvider — EnhanceFailureKind taxonomy + AbortSignal support
// ---------------------------------------------------------------------------

describe('refineGoalWithProvider', () => {
  it('parses a well-formed response and does not call onError', async () => {
    const onError = vi.fn();
    const mission = await refineGoalWithProvider('Raw goal', fakeProvider(), 'test-provider', {
      onError,
    });
    expect(mission).toMatchObject({
      refinedGoal: expect.stringContaining('auth module'),
      deliverables: ['JWT login endpoint'],
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('works with no options at all (additive options object)', async () => {
    const mission = await refineGoalWithProvider('Raw goal', fakeProvider(), 'test-provider');
    expect(mission).not.toBeNull();
  });

  it('reports provider_error and returns null when the call throws', async () => {
    const onError = vi.fn();
    const mission = await refineGoalWithProvider('Raw', fakeProvider({ shouldThrow: true }), 'm', {
      onError,
    });
    expect(mission).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('provider down', 'provider_error');
  });

  it('reports timeout when the refiner exceeds the deadline', async () => {
    const onError = vi.fn();
    const mission = await refineGoalWithProvider(
      'Raw',
      fakeProvider({ hangUntilAbort: true }),
      'm',
      { timeoutMs: 20, onError },
    );
    expect(mission).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('timeout');
    expect(String(onError.mock.calls[0]?.[0])).toContain('timed out');
  });

  it('stays silent when the PARENT signal cancels the call (no onError)', async () => {
    const onError = vi.fn();
    const parent = new AbortController();
    const pending = refineGoalWithProvider('Raw', fakeProvider({ hangUntilAbort: true }), 'm', {
      signal: parent.signal,
      timeoutMs: 10_000,
      onError,
    });
    parent.abort();
    await expect(pending).resolves.toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports empty when the refiner returns no text', async () => {
    const onError = vi.fn();
    const mission = await refineGoalWithProvider('Raw', fakeProvider({ responseText: '' }), 'm', {
      onError,
    });
    expect(mission).toBeNull();
    expect(onError).toHaveBeenCalledWith('refiner returned no text', 'empty');
  });

  it('reports empty when the response lacks the REFINED_GOAL/DELIVERABLES markers', async () => {
    const onError = vi.fn();
    const mission = await refineGoalWithProvider(
      'Raw',
      fakeProvider({ responseText: 'no markers here at all' }),
      'm',
      { onError },
    );
    expect(mission).toBeNull();
    expect(onError).toHaveBeenCalledWith(
      'refiner response was missing REFINED_GOAL/DELIVERABLES sections',
      'empty',
    );
  });

  it('never rejects and never double-notifies when onError itself throws', async () => {
    const kinds: string[] = [];
    const onError = vi.fn((_reason: string, kind?: string) => {
      kinds.push(kind ?? 'none');
      throw new Error('observer blew up');
    });
    await expect(
      refineGoalWithProvider('Raw', fakeProvider({ shouldThrow: true }), 'm', { onError }),
    ).resolves.toBeNull();
    expect(kinds).toEqual(['provider_error']);
  });

  it('stays silent when the parent aborts but the provider resolves anyway', async () => {
    // Some SDKs swallow the abort and resolve with a (partial) response —
    // that must surface as a silent cancel, not an `empty` failure.
    const onError = vi.fn();
    const parent = new AbortController();
    const pending = refineGoalWithProvider('Raw', fakeProvider(), 'm', {
      signal: parent.signal,
      onError,
    });
    parent.abort();
    await expect(pending).resolves.toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });

  it('classifies a deadline hit that surfaces as a resolved partial response as timeout', async () => {
    const onError = vi.fn();
    const mission = await refineGoalWithProvider(
      'Raw',
      fakeProvider({ resolveOnAbort: 'REFINED_GOAL: truncated by deadline' }),
      'm',
      { timeoutMs: 20, onError },
    );
    expect(mission).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('timeout');
  });

  it('classifies a deadline hit that surfaces as an EMPTY resolved response as timeout', async () => {
    const onError = vi.fn();
    const mission = await refineGoalWithProvider('Raw', fakeProvider({ resolveOnAbort: '' }), 'm', {
      timeoutMs: 20,
      onError,
    });
    expect(mission).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('timeout');
  });

  it('reports provider usage through onUsage', async () => {
    const onUsage = vi.fn();
    const mission = await refineGoalWithProvider('Raw', fakeProvider(), 'test-provider', {
      onUsage,
    });
    expect(mission).not.toBeNull();
    expect(onUsage).toHaveBeenCalledWith(
      { input: 10, output: 5 },
      { providerId: 'test-provider', model: 'test-provider' },
    );
  });

  it('keeps the mission and stays silent on onError when the usage observer throws', async () => {
    const onError = vi.fn();
    const mission = await refineGoalWithProvider('Raw', fakeProvider(), 'test-provider', {
      onError,
      onUsage: () => {
        throw new Error('cost pipeline down');
      },
    });
    expect(mission).not.toBeNull();
    expect(mission?.refinedGoal).toContain('auth module');
    expect(onError).not.toHaveBeenCalled();
  });

  it('fires onOutcome with success on the happy path', async () => {
    const onOutcome = vi.fn();
    const mission = await refineGoalWithProvider('Raw', fakeProvider(), 'test-provider', {
      onOutcome,
    });
    expect(mission).not.toBeNull();
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledWith({
      result: 'success',
      durationMs: expect.any(Number),
    });
  });

  it('records provider_error outcomes for failures', async () => {
    const onOutcome = vi.fn();
    const mission = await refineGoalWithProvider(
      'Raw',
      fakeProvider({ shouldThrow: true }),
      'test-provider',
      { onOutcome },
    );
    expect(mission).toBeNull();
    expect(onOutcome).toHaveBeenCalledWith({
      result: 'provider_error',
      durationMs: expect.any(Number),
    });
  });

  it('reports cancelled outcomes for caller-initiated cancellation', async () => {
    const parent = new AbortController();
    const onOutcome = vi.fn();
    const pending = refineGoalWithProvider('Raw', fakeProvider(), 'm', {
      signal: parent.signal,
      onOutcome,
    });
    parent.abort();
    await expect(pending).resolves.toBeNull();
    expect(onOutcome).toHaveBeenCalledWith({
      result: 'cancelled',
      durationMs: expect.any(Number),
    });
  });

  it('classifies a deadline hit as timeout even when the parent cancel races it', async () => {
    // Parent cancelled up-front; the deadline fires at 5ms; the provider's
    // late rejection lands at 20ms — by then BOTH abort flags are set, and
    // the fired deadline must win the classification.
    const parent = new AbortController();
    parent.abort();
    const onOutcome = vi.fn();
    const onError = vi.fn();
    const mission = await refineGoalWithProvider('Raw', fakeProvider({ rejectAfterMs: 20 }), 'm', {
      signal: parent.signal,
      timeoutMs: 5,
      onError,
      onOutcome,
    });
    expect(mission).toBeNull();
    expect(onOutcome).toHaveBeenCalledWith({
      result: 'timeout',
      durationMs: expect.any(Number),
    });
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('timed out'), 'timeout');
  });
});
