import { describe, expect, it, vi } from 'vitest';

const mockSetupProvider = vi.fn();

vi.mock('../../src/wiring/provider.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/wiring/provider.js')>(
    '../../src/wiring/provider.js',
  );
  return {
    ...actual,
    setupProvider: mockSetupProvider,
  };
});

// Mock @wrongstack/providers so we can force capabilitiesFor to throw
// and test the graceful fallback. Default: call through to the real impl.
const mockCapabilitiesFor = vi.fn();

vi.mock('@wrongstack/providers', async () => {
  const actual =
    await vi.importActual<typeof import('@wrongstack/providers')>('@wrongstack/providers');
  return {
    ...actual,
    capabilitiesFor: mockCapabilitiesFor.mockImplementation(actual.capabilitiesFor),
  };
});

/**
 * PR 4 of Issue #29: mode + provider + modelCapabilities
 * resolution is now in `resolveModeAndCapabilities()`. This
 * test pins the contract that future refactors of cli-main
 * can't accidentally regress:
 *
 *   1. The default-mode fallback: when no activeMode is
 *      provided, modeId is 'default' and modePrompt is ''.
 *   2. The exit branch: when setupProvider throws, the
 *      helper returns `{ kind: 'exit', code: 2, message }`
 *      and the caller's writeErr + reader.close + return 2
 *      shape is preserved.
 *   3. The exit branch: when setupProvider resolves but
 *      resolvedProvider is undefined (e.g. unknown provider
 *      id), the helper returns `{ kind: 'exit', code: 2, ... }`
 *      with a message that names the offending provider.
 *   4. The capability fallback: when `capabilitiesFor`
 *      throws, modelCapabilities is `undefined` (not a
 *      crash). The system prompt builder treats
 *      `undefined` as "skip the model-aware hints", so
 *      this is the safe path.
 *
 * We mock `@wrongstack/core`'s `mergeCustomModelDefs` and
 * `setupProvider` from the local `wiring/provider.js` so
 * the test doesn't have to wire up a real models registry
 * or a real provider factory.
 */

const { resolveModeAndCapabilities } = await import('../../src/boot/system-prompt.js');

import type { Config, Logger, ModelsRegistry } from '@wrongstack/core/types';

function makeLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as never as Logger;
}

function makeConfig(): Config {
  return {
    provider: 'test-provider',
    model: 'test-model',
    yolo: false,
    debugStream: false,
    context: { preserveK: 0, eliseThreshold: 0 },
    features: { skills: false },
  } as never as Config;
}

function makeModelsRegistry(): ModelsRegistry {
  return {
    getModel: vi.fn(async () => undefined),
    getProvider: vi.fn(async () => undefined),
  } as never as ModelsRegistry;
}

function makeProviderResult() {
  return {
    resolvedProvider: { id: 'test-provider', name: 'Test Provider' },
    provider: { id: 'test-provider' },
    providerRegistry: {} as never,
  };
}

describe('resolveModeAndCapabilities (PR 4 of #29)', () => {
  it('defaults to modeId="default" and modePrompt="" when no activeMode is set', async () => {
    mockSetupProvider.mockResolvedValueOnce(makeProviderResult());
    const result = await resolveModeAndCapabilities({
      config: makeConfig(),
      modelsRegistry: makeModelsRegistry(),
      logger: makeLogger(),
      activeMode: null,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.modeId).toBe('default');
      expect(result.modePrompt).toBe('');
    }
  });

  it('returns ok with the active mode id + prompt when activeMode is set', async () => {
    mockSetupProvider.mockResolvedValueOnce(makeProviderResult());
    const result = await resolveModeAndCapabilities({
      config: makeConfig(),
      modelsRegistry: makeModelsRegistry(),
      logger: makeLogger(),
      activeMode: { id: 'review', prompt: 'You are a code reviewer.' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.modeId).toBe('review');
      expect(result.modePrompt).toBe('You are a code reviewer.');
    }
  });

  it('returns { kind: "exit", code: 2 } when setupProvider throws', async () => {
    mockSetupProvider.mockRejectedValueOnce(new Error('provider-not-found: anthropic'));
    const result = await resolveModeAndCapabilities({
      config: makeConfig(),
      modelsRegistry: makeModelsRegistry(),
      logger: makeLogger(),
      activeMode: null,
    });
    expect(result.kind).toBe('exit');
    if (result.kind === 'exit') {
      expect(result.code).toBe(2);
      expect(result.message).toContain('provider-not-found');
    }
  });

  it('returns { kind: "exit", code: 2 } when setupProvider resolves but resolvedProvider is undefined', async () => {
    mockSetupProvider.mockResolvedValueOnce({
      resolvedProvider: undefined,
      provider: { id: 'test-provider' },
      providerRegistry: {} as never,
    });
    const result = await resolveModeAndCapabilities({
      config: makeConfig(),
      modelsRegistry: makeModelsRegistry(),
      logger: makeLogger(),
      activeMode: null,
    });
    expect(result.kind).toBe('exit');
    if (result.kind === 'exit') {
      expect(result.code).toBe(2);
      expect(result.message).toContain('test-provider');
    }
  });

  it('returns modelCapabilities: undefined when capabilitiesFor throws (graceful fallback)', async () => {
    mockCapabilitiesFor.mockRejectedValueOnce(new Error('provider crash'));
    mockSetupProvider.mockResolvedValueOnce(makeProviderResult());
    const result = await resolveModeAndCapabilities({
      config: makeConfig(),
      modelsRegistry: makeModelsRegistry(),
      logger: makeLogger(),
      activeMode: null,
    });
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      // When capabilitiesFor rejects, the .catch(() => undefined) in
      // resolveModeAndCapabilities produces undefined modelCapabilities,
      // which the system prompt builder treats as "skip model-aware hints".
      expect(result.modelCapabilities).toBeUndefined();
      // modeId and prompt are still populated — the provider itself worked.
      expect(result.modeId).toBe('default');
      expect(result.modePrompt).toBe('');
    }
  });
});
