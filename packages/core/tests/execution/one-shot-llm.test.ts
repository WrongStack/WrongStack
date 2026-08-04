import { describe, expect, it, vi } from 'vitest';
import { FallbackProfileManager } from '../../src/core/fallback-profile-manager.js';
import { OneShotOrchestrator } from '../../src/execution/one-shot-llm.js';
import type { Config } from '../../src/types/config.js';
import type {
  Capabilities,
  Provider,
  ProviderErrorKind,
  Request,
  Response,
} from '../../src/types/provider.js';
import { ProviderError } from '../../src/types/provider.js';

// ── Helpers ──────────────────────────────────────────────────────────────

const TEST_CAPABILITIES = {
  tools: true,
  parallelTools: false,
  vision: false,
  streaming: true,
  promptCache: false,
  systemPrompt: true,
  jsonMode: false,
  reasoning: false,
  maxContext: 128_000,
  cacheControl: 'none',
} satisfies Capabilities;

function fakeProvider(id: string, opts?: { failCount?: number; model?: string }): Provider {
  let calls = 0;
  return {
    id,
    capabilities: TEST_CAPABILITIES,
    complete: vi.fn(async (_req: Request, _opts?: { signal?: AbortSignal }) => {
      calls++;
      if (opts?.failCount && calls <= opts.failCount) {
        throw new ProviderError(`Provider ${id} overloaded (attempt ${calls})`, 503, true, id, {
          kind: 'overloaded',
        });
      }
      return fakeResponse(id, opts?.model);
    }),
    stream: vi.fn(),
  };
}

function fakeProviderThatThrows(id: string, kind: ProviderErrorKind = 'auth'): Provider {
  return {
    id,
    capabilities: TEST_CAPABILITIES,
    complete: vi.fn(async () => {
      throw new ProviderError(
        `Provider ${id} ${kind} error`,
        kind === 'overloaded' ? 503 : 400,
        false,
        id,
        { kind },
      );
    }),
    stream: vi.fn(),
  };
}

let fakeResponseSeq = 0;
function fakeResponse(providerId: string, model?: string): Response {
  fakeResponseSeq++;
  const actualModel = model ?? providerId;
  return {
    model: actualModel,
    content: [{ type: 'text', text: `response-${fakeResponseSeq}-from-${actualModel}` }],
    stopReason: 'end_turn',
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    provider: 'test-provider',
    model: 'test-model',
    providers: {
      'test-provider': { type: 'test', apiKey: 'sk-test', models: ['test-model', 'test-model-2'] },
      'fallback-provider': { type: 'test', apiKey: 'sk-fallback', models: ['fallback-model'] },
    },
    ...overrides,
  } as Config;
}

function makeOneShotOpts(
  config: Config,
  buildProvider: ConstructorParameters<typeof OneShotOrchestrator>[0]['buildProvider'],
) {
  return {
    buildProvider,
    getConfig: () => config,
    fallbackProfileManager: new FallbackProfileManager(config),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('OneShotOrchestrator', () => {
  it('returns text from a basic successful call', async () => {
    const provider = fakeProvider('test-provider');
    const cfg = makeConfig();
    const orch = new OneShotOrchestrator(makeOneShotOpts(cfg, async () => provider));

    const result = await orch.call({
      system: 'You are a test.',
      userPrompt: 'Say hello.',
    });

    expect(result.text).toBe('response-1-from-test-provider');
    expect(result.model).toBe('test-provider');
    expect(result.provider).toBe('test-provider');
    expect(result.tokens.input).toBe(100);
    expect(result.tokens.output).toBe(50);
    expect(result.fromFallback).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('uses explicit providerId and model when provided', async () => {
    const provider = fakeProvider('custom-provider', { model: 'custom-model' });
    const cfg = makeConfig();
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(cfg, async (pid, model) => {
        expect(pid).toBe('custom-provider');
        expect(model).toBe('custom-model');
        return provider;
      }),
    );

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'custom-provider',
      model: 'custom-model',
    });

    expect(result.text).toContain('custom-model');
    expect(result.model).toBe('custom-model');
    expect(result.provider).toBe('custom-provider');
  });

  it('falls back to config defaults when no provider/model specified', async () => {
    const provider = fakeProvider('test-provider', { model: 'test-model' });
    const cfg = makeConfig();
    const orch = new OneShotOrchestrator(makeOneShotOpts(cfg, async () => provider));

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
    });

    expect(result.model).toBe('test-model');
    expect(result.provider).toBe('test-provider');
  });

  it('uses role-based routing via ModelRouter when role is set', async () => {
    const provider = fakeProvider('role-provider', { model: 'role-model' });
    const cfg = makeConfig();
    const orch = new OneShotOrchestrator({
      ...makeOneShotOpts(cfg, async () => provider),
      modelRouter: {
        pickForTask: (role: string) => {
          if (role === 'bug-hunter')
            return {
              provider: 'role-provider',
              model: 'role-model',
              reason: 'matched',
              fromMatrix: true,
            };
          return undefined;
        },
      } as never,
    });

    const result = await orch.call({
      system: 'test',
      userPrompt: 'find bugs',
      role: 'bug-hunter',
    });

    expect(result.model).toBe('role-model');
    expect(result.provider).toBe('role-provider');
  });

  it('returns error when buildProvider throws', async () => {
    const _e = makeConfig();
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(_e, async () => {
        throw new Error('API key not found');
      }),
    );

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
    });

    expect(result.error).toContain('API key not found');
    expect(result.text).toBe('');
  });

  it('returns error when no provider/model can be resolved', async () => {
    const _n = makeConfig({ provider: '', model: '' }) as Config;
    const orch = new OneShotOrchestrator(makeOneShotOpts(_n, async () => fakeProvider('x')));

    const result = await orch.call({ system: 'test', userPrompt: 'hi' });

    expect(result.error).toContain('No provider or model could be resolved');
  });

  it('falls back to the next provider on transient errors', async () => {
    const primary = fakeProviderThatThrows('primary', 'overloaded');
    const fallback = fakeProvider('fallback-provider', { model: 'fallback-model' });

    const _f = makeConfig();
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(_f, async (pid) => (pid === 'primary' ? primary : fallback)),
    );

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['fallback-provider/fallback-model'],
    });

    expect(result.text).toContain('fallback-model');
    expect(result.fromFallback).toBe(true);
    expect(result.provider).toBe('fallback-provider');
  });

  it('keeps the continuity bridge active when automatic fallback is disabled', async () => {
    const primary = fakeProviderThatThrows('primary', 'overloaded');
    const bridge = fakeProvider('fallback-provider', { model: 'fallback-model' });
    const config = makeConfig({
      fallbackAuto: false,
      fallbackBridge: 'fallback-provider/fallback-model',
    });
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(config, async (providerId) => (providerId === 'primary' ? primary : bridge)),
    );

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
    });

    expect(result.provider).toBe('fallback-provider');
    expect(result.model).toBe('fallback-model');
    expect(result.fromFallback).toBe(true);
  });

  it('does NOT fall back on non-transient errors (auth)', async () => {
    const primary = fakeProviderThatThrows('primary', 'auth');
    const fallback = fakeProvider('fallback-provider', { model: 'fallback-model' });

    const _f = makeConfig();
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(_f, async (pid) => (pid === 'primary' ? primary : fallback)),
    );

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['fallback-provider/fallback-model'],
    });

    // Auth error is non-retryable — should NOT fall back. The error should be captured.
    expect(result.error).toBeTruthy();
    expect(result.fromFallback).toBe(false);
  });

  it('exhausts all fallbacks and returns the last error', async () => {
    const _h = makeConfig({ fallbackAuto: false });
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(_h, async (pid) => fakeProviderThatThrows(pid, 'overloaded')),
    );

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['fallback-provider/fallback-a', 'fallback-provider/fallback-b'],
    });

    expect(result.error).toBeTruthy();
    expect(result.text).toBe('');
    expect(result.fromFallback).toBe(false);
    // Chain was tried — last attempted provider/model is the final fallback
    expect(result.provider).toBe('fallback-provider');
    expect(result.model).toBe('fallback-b');
  });

  it('reports the number of provider attempts behind a fallback success', async () => {
    const primary = fakeProviderThatThrows('primary', 'overloaded');
    const fallback = fakeProvider('fallback-provider', { model: 'fallback-model' });
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(makeConfig(), async (pid) => (pid === 'primary' ? primary : fallback)),
    );

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['fallback-provider/fallback-model'],
    });

    expect(result.text).toContain('fallback-model');
    expect(result.fromFallback).toBe(true);
    // Primary + one fallback entry actually tried
    expect(result.attempts).toBe(2);
  });

  it('counts every exhausted fallback attempt in the failure result', async () => {
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(
        makeConfig({ fallbackAuto: false }),
        async () => fakeProviderThatThrows('p', 'overloaded'),
      ),
    );

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['fallback-provider/fallback-a', 'fallback-provider/fallback-b'],
    });

    expect(result.error).toBeTruthy();
    expect(result.fromFallback).toBe(false);
    // Primary + both fallback entries were tried
    expect(result.attempts).toBe(3);
  });

  it('reports a single attempt for a direct success', async () => {
    const provider = fakeProvider('test-provider');
    const orch = new OneShotOrchestrator(makeOneShotOpts(makeConfig(), async () => provider));

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'test-provider',
      model: 'test-model',
    });

    expect(result.text).toBeTruthy();
    expect(result.fromFallback).toBe(false);
    expect(result.attempts).toBe(1);
  });

  it('counts only the fallback entries tried when the primary is blocked', async () => {
    const primary = fakeProvider('primary');
    const fallback = fakeProvider('fallback-provider', { model: 'fallback-model' });
    const orch = new OneShotOrchestrator({
      ...makeOneShotOpts(makeConfig(), async (pid) => (pid === 'primary' ? primary : fallback)),
      statusTracker: {
        isAvailable: (pid: string) => pid !== 'primary',
        recordSuccess: () => {},
        recordFailure: () => {},
      } as unknown as NonNullable<ConstructorParameters<typeof OneShotOrchestrator>[0]['statusTracker']>,
    });

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['fallback-provider/fallback-model'],
    });

    expect(result.text).toContain('fallback-model');
    expect(result.fromFallback).toBe(true);
    // The blocked primary was never invoked — only the fallback entry ran.
    expect(result.attempts).toBe(1);
    expect(primary.complete).not.toHaveBeenCalled();
  });

  it('reports zero attempts when the primary is blocked and no chain exists', async () => {
    const provider = fakeProvider('test-provider');
    const orch = new OneShotOrchestrator({
      ...makeOneShotOpts(makeConfig({ fallbackAuto: false }), async () => provider),
      statusTracker: {
        isAvailable: () => false,
        recordSuccess: () => {},
        recordFailure: () => {},
      } as unknown as NonNullable<ConstructorParameters<typeof OneShotOrchestrator>[0]['statusTracker']>,
    });

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'test-provider',
      model: 'test-model',
    });

    expect(result.error).toBeTruthy();
    expect(result.attempts).toBe(0);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  // ── Stale-entry regression ────────────────────────────────────────────
  //
  // The per-entry break was removed so that one non-fallback-eligible
  // failure inside the chain (e.g. a retired model returning 404 →
  // invalid_request) does NOT abort every healthy entry after it.
  // Only the PRIMARY's eligibility gates chain entry. Mirrors the
  // agent-loop fix tested in fallback-model-kind-gate.test.ts:234.
  it('skips a stale chain entry (404/invalid_request) and still tries the next one', async () => {
    const primary: Provider = {
      id: 'primary',
      capabilities: TEST_CAPABILITIES,
      complete: vi.fn(async () => {
        throw new ProviderError('overloaded', 503, true, 'primary', { kind: 'overloaded' });
      }),
      stream: vi.fn(),
    };
    const stale: Provider = {
      id: 'stale-provider',
      capabilities: TEST_CAPABILITIES,
      complete: vi.fn(async () => {
        throw new ProviderError('model not found', 404, false, 'stale-provider', {
          kind: 'invalid_request',
        });
      }),
      stream: vi.fn(),
    };
    const healthy: Provider = {
      id: 'healthy-provider',
      capabilities: TEST_CAPABILITIES,
      complete: vi.fn(async () => fakeResponse('healthy-provider', 'healthy-model')),
      stream: vi.fn(),
    };
    const cfg = makeConfig({
      providers: {
        'test-provider': { type: 'test', apiKey: 'sk-test', models: ['test-model'] },
        'stale-provider': { type: 'test', apiKey: 'sk-stale', models: ['retired-model'] },
        'healthy-provider': { type: 'test', apiKey: 'sk-healthy', models: ['healthy-model'] },
      },
      fallbackAuto: false,
    });
    const buildProvider = vi.fn(async (pid: string) => {
      if (pid === 'primary') return primary;
      if (pid === 'stale-provider') return stale;
      return healthy;
    });
    const orch = new OneShotOrchestrator(makeOneShotOpts(cfg, buildProvider));

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['stale-provider/retired-model', 'healthy-provider/healthy-model'],
    });

    expect(result.text).toContain('healthy-model');
    expect(result.fromFallback).toBe(true);
    expect(result.provider).toBe('healthy-provider');
    // Both chain entries were attempted — stale didn't abort the loop
    expect(stale.complete).toHaveBeenCalledTimes(1);
    expect(healthy.complete).toHaveBeenCalledTimes(1);
  });

  it('honors a named fallback profile resolved upstream as fallbackModels', async () => {
    const primary = fakeProviderThatThrows('primary', 'overloaded');
    const fallback = fakeProvider('fallback-provider', { model: 'fallback-model' });
    const cfg = makeConfig({
      fallbackProfiles: {
        summary: ['fallback-provider/fallback-model'],
      },
    });
    const mgr = new FallbackProfileManager(cfg);
    // Named profile resolved upstream — only the resolved chain reaches OneShot
    const resolvedChain = mgr.resolve('summary').map((e) => `${e.providerId}/${e.model}`);

    const orch = new OneShotOrchestrator(
      makeOneShotOpts(cfg, async (pid) => (pid === 'primary' ? primary : fallback)),
    );

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: resolvedChain,
    });

    expect(result.text).toContain('fallback-model');
    expect(result.fromFallback).toBe(true);
  });

  it('times out when the provider takes too long (AbortSignal)', async () => {
    const slowProvider: Provider = {
      id: 'slow',
      capabilities: TEST_CAPABILITIES,
      complete: vi.fn(async (_req, opts) => {
        // Wait for the signal to abort
        await new Promise((_, reject) => {
          if (opts?.signal?.aborted) {
            reject(new ProviderError('Aborted', 0, false, 'slow', { kind: 'timeout' }));
            return;
          }
          opts?.signal?.addEventListener('abort', () => {
            reject(new ProviderError('Timed out', 0, false, 'slow', { kind: 'timeout' }));
          });
        });
        return fakeResponse('slow');
      }),
      stream: vi.fn(),
    };

    const _s = makeConfig();
    const orch = new OneShotOrchestrator(makeOneShotOpts(_s, async () => slowProvider));

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      timeoutMs: 10, // Very short timeout
    });

    expect(result.error).toBeTruthy();
  });

  it('preserves error message when tryCall returns undefined (transient without fallback)', async () => {
    // Provider that returns undefined by throwing a transient error
    // AND no fallback chain configured
    const transientProvider: Provider = {
      id: 'transient',
      capabilities: TEST_CAPABILITIES,
      complete: vi.fn(async () => {
        throw new ProviderError('Rate limited', 429, true, 'transient', { kind: 'rate_limit' });
      }),
      stream: vi.fn(),
    };

    const _x = makeConfig({ fallbackAuto: false });
    const orch = new OneShotOrchestrator(makeOneShotOpts(_x, async () => transientProvider));

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'transient',
      model: 'm',
    });

    expect(result.error).toBe('Rate limited');
    expect(result.text).toBe('');
  });

  it('reports the final attempted target and its exact error after fallback exhaustion', async () => {
    const _z1 = makeConfig({ fallbackAuto: false });
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(_z1, async (providerId) => fakeProviderThatThrows(providerId, 'overloaded')),
    );

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['fallback-provider/fallback-model'],
    });

    expect(result.provider).toBe('fallback-provider');
    expect(result.model).toBe('fallback-model');
    expect(result.error).toBe('Provider fallback-provider overloaded error');
    expect(result.fromFallback).toBe(false);
  });

  it('does not rotate to fallbacks after parent cancellation', async () => {
    const controller = new AbortController();
    const fallback = fakeProvider('fallback-provider', { model: 'fallback-model' });
    const primary: Provider = {
      id: 'primary',
      capabilities: TEST_CAPABILITIES,
      complete: vi.fn(async () => {
        controller.abort();
        throw new ProviderError('Cancelled', 0, false, 'primary', { kind: 'network' });
      }),
      stream: vi.fn(),
    };
    const buildProvider = vi.fn(async (providerId: string) =>
      providerId === 'primary' ? primary : fallback,
    );
    const _z2 = makeConfig({ fallbackAuto: false });
    const orch = new OneShotOrchestrator(makeOneShotOpts(_z2, buildProvider));

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['fallback-provider/fallback-model'],
      signal: controller.signal,
    });

    expect(result.error).toBe('Cancelled');
    expect(result.provider).toBe('primary');
    expect(result.fromFallback).toBe(false);
    expect(buildProvider).toHaveBeenCalledTimes(1);
  });

  it('composes an external signal with timeout instead of disabling the timeout', async () => {
    let observedSignal: AbortSignal | undefined;
    const provider: Provider = {
      id: 'slow',
      capabilities: TEST_CAPABILITIES,
      complete: vi.fn(async (_request, opts) => {
        observedSignal = opts.signal;
        await new Promise((_, reject) => {
          opts.signal.addEventListener(
            'abort',
            () => reject(new ProviderError('Timed out', 0, false, 'slow', { kind: 'timeout' })),
            { once: true },
          );
        });
        return fakeResponse('slow');
      }),
      stream: vi.fn(),
    };
    const external = new AbortController();
    const _z3 = makeConfig({ fallbackAuto: false });
    const orch = new OneShotOrchestrator(makeOneShotOpts(_z3, async () => provider));

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      signal: external.signal,
      timeoutMs: 10,
    });

    expect(observedSignal).toBeDefined();
    expect(observedSignal).not.toBe(external.signal);
    expect(observedSignal?.aborted).toBe(true);
    expect(result.error).toBe('Timed out');
  });
});

describe('OneShotOrchestrator — role routing priority', () => {
  it('lets a MATRIX pick override an explicit providerId+model', async () => {
    const provider = fakeProvider('matrix-provider', { model: 'matrix-model' });
    const orch = new OneShotOrchestrator({
      ...makeOneShotOpts(makeConfig(), async () => provider),
      modelRouter: {
        pickForTask: () => ({
          provider: 'matrix-provider',
          model: 'matrix-model',
          reason: 'matrix override',
          fromMatrix: true,
        }),
      } as never,
    });

    const result = await orch.call({
      userPrompt: 'x',
      role: 'critic',
      providerId: 'explicit-provider',
      model: 'explicit-model',
    });

    expect(result.model).toBe('matrix-model');
  });

  it('does NOT let a heuristic pick override an explicit providerId+model', async () => {
    // Council seats carry both a persona role and a resolved seat target. A
    // capability guess silently replacing the caller's explicit target would
    // make providerId/model unreliable for every role-carrying caller.
    const provider = fakeProvider('explicit-provider', { model: 'explicit-model' });
    const orch = new OneShotOrchestrator({
      ...makeOneShotOpts(makeConfig(), async () => provider),
      modelRouter: {
        pickForTask: () => ({
          provider: 'guessed-provider',
          model: 'guessed-model',
          reason: 'best-for review (auto-detected)',
          fromMatrix: false,
        }),
      } as never,
    });

    const result = await orch.call({
      userPrompt: 'x',
      role: 'critic',
      providerId: 'explicit-provider',
      model: 'explicit-model',
    });

    expect(result.model).toBe('explicit-model');
    expect(result.provider).toBe('explicit-provider');
  });

  it('applies a heuristic pick when the caller supplied no target', async () => {
    const provider = fakeProvider('guessed-provider', { model: 'guessed-model' });
    const orch = new OneShotOrchestrator({
      ...makeOneShotOpts(makeConfig(), async () => provider),
      modelRouter: {
        pickForTask: () => ({
          provider: 'guessed-provider',
          model: 'guessed-model',
          reason: 'best-for review (auto-detected)',
          fromMatrix: false,
        }),
      } as never,
    });

    const result = await orch.call({ userPrompt: 'x', role: 'critic' });

    expect(result.model).toBe('guessed-model');
  });
});
