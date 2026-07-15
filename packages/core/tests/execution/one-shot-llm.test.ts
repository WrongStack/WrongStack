import { describe, expect, it, vi } from 'vitest';
import { OneShotOrchestrator } from '../../src/execution/one-shot-llm.js';
import { ProviderError } from '../../src/types/provider.js';
import type {
  Provider,
  ProviderErrorKind,
  Request,
  Response,
} from '../../src/types/provider.js';
import type { Config } from '../../src/types/config.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function fakeProvider(id: string, opts?: { failCount?: number; model?: string }): Provider {
  let calls = 0;
  return {
    id,
    capabilities: { maxContext: 128_000, supportsTools: true, supportsVision: false, supportsReasoning: false },
    complete: vi.fn(async (_req: Request, _opts?: { signal?: AbortSignal }) => {
      calls++;
      if (opts?.failCount && calls <= opts.failCount) {
        throw new ProviderError(
          `Provider ${id} overloaded (attempt ${calls})`,
          503,
          true,
          id,
          { kind: 'overloaded' },
        );
      }
      return fakeResponse(id, opts?.model);
    }),
    stream: vi.fn(),
  };
}

function fakeProviderThatThrows(id: string, kind: ProviderErrorKind = 'auth'): Provider {
  return {
    id,
    capabilities: { maxContext: 128_000, supportsTools: true, supportsVision: false, supportsReasoning: false },
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

// ── Tests ────────────────────────────────────────────────────────────────

describe('OneShotOrchestrator', () => {
  it('returns text from a basic successful call', async () => {
    const provider = fakeProvider('test-provider');
    const orch = new OneShotOrchestrator({
      buildProvider: async () => provider,
      getConfig: () => makeConfig(),
    });

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
    const orch = new OneShotOrchestrator({
      buildProvider: async (pid, model) => {
        expect(pid).toBe('custom-provider');
        expect(model).toBe('custom-model');
        return provider;
      },
      getConfig: () => makeConfig(),
    });

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
    const orch = new OneShotOrchestrator({
      buildProvider: async () => provider,
      getConfig: () => makeConfig(),
    });

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
    });

    expect(result.model).toBe('test-model');
    expect(result.provider).toBe('test-provider');
  });

  it('uses role-based routing via ModelRouter when role is set', async () => {
    const provider = fakeProvider('role-provider', { model: 'role-model' });
    const orch = new OneShotOrchestrator({
      buildProvider: async () => provider,
      getConfig: () => makeConfig(),
      modelRouter: {
        pickForTask: (role: string) => {
          if (role === 'bug-hunter') return { provider: 'role-provider', model: 'role-model', reason: 'matched', fromMatrix: true };
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
    const orch = new OneShotOrchestrator({
      buildProvider: async () => { throw new Error('API key not found'); },
      getConfig: () => makeConfig(),
    });

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
    });

    expect(result.error).toContain('API key not found');
    expect(result.text).toBe('');
  });

  it('returns error when no provider/model can be resolved', async () => {
    const orch = new OneShotOrchestrator({
      buildProvider: async () => fakeProvider('x'),
      getConfig: () => makeConfig({ provider: '', model: '' }) as Config,
    });

    const result = await orch.call({ system: 'test', userPrompt: 'hi' });

    expect(result.error).toContain('No provider or model could be resolved');
  });

  it('falls back to the next provider on transient errors', async () => {
    const primary = fakeProviderThatThrows('primary', 'overloaded');
    const fallback = fakeProvider('fallback-provider', { model: 'fallback-model' });

    const orch = new OneShotOrchestrator({
      buildProvider: async (pid) => pid === 'primary' ? primary : fallback,
      getConfig: () => makeConfig(),
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
    expect(result.provider).toBe('fallback-provider');
  });

  it('does NOT fall back on non-transient errors (auth)', async () => {
    const primary = fakeProviderThatThrows('primary', 'auth');
    const fallback = fakeProvider('fallback-provider', { model: 'fallback-model' });

    const orch = new OneShotOrchestrator({
      buildProvider: async (pid) => pid === 'primary' ? primary : fallback,
      getConfig: () => makeConfig(),
    });

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
    const orch = new OneShotOrchestrator({
      buildProvider: async (pid) => fakeProviderThatThrows(pid, 'overloaded'),
      getConfig: () => makeConfig({ fallbackAuto: false }),
    });

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

  it('honors the fallbackProfile from config', async () => {
    const primary = fakeProviderThatThrows('primary', 'overloaded');
    const fallback = fakeProvider('fallback-provider', { model: 'fallback-model' });

    const orch = new OneShotOrchestrator({
      buildProvider: async (pid) => pid === 'primary' ? primary : fallback,
      getConfig: () => makeConfig({
        fallbackProfiles: {
          summary: ['fallback-provider/fallback-model'],
        },
      }),
    });

    const result = await orch.call({
      system: 'test',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackProfile: 'summary',
    });

    expect(result.text).toContain('fallback-model');
    expect(result.fromFallback).toBe(true);
  });

  it('times out when the provider takes too long (AbortSignal)', async () => {
    const slowProvider: Provider = {
      id: 'slow',
      capabilities: { maxContext: 128_000, supportsTools: true, supportsVision: false, supportsReasoning: false },
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

    const orch = new OneShotOrchestrator({
      buildProvider: async () => slowProvider,
      getConfig: () => makeConfig(),
    });

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
      capabilities: { maxContext: 128_000, supportsTools: true, supportsVision: false, supportsReasoning: false },
      complete: vi.fn(async () => {
        throw new ProviderError('Rate limited', 429, true, 'transient', { kind: 'rate_limit' });
      }),
      stream: vi.fn(),
    };

    const orch = new OneShotOrchestrator({
      buildProvider: async () => transientProvider,
      getConfig: () => makeConfig({ fallbackAuto: false }),
    });

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
    const orch = new OneShotOrchestrator({
      buildProvider: async (providerId) => fakeProviderThatThrows(providerId, 'overloaded'),
      getConfig: () => makeConfig({ fallbackAuto: false }),
    });

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
      capabilities: {
        maxContext: 128_000,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
      },
      complete: vi.fn(async () => {
        controller.abort();
        throw new ProviderError('Cancelled', 0, false, 'primary', { kind: 'network' });
      }),
      stream: vi.fn(),
    };
    const buildProvider = vi.fn(async (providerId: string) =>
      providerId === 'primary' ? primary : fallback,
    );
    const orch = new OneShotOrchestrator({
      buildProvider,
      getConfig: () => makeConfig({ fallbackAuto: false }),
    });

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
      capabilities: {
        maxContext: 128_000,
        supportsTools: true,
        supportsVision: false,
        supportsReasoning: false,
      },
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
    const orch = new OneShotOrchestrator({
      buildProvider: async () => provider,
      getConfig: () => makeConfig({ fallbackAuto: false }),
    });

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
