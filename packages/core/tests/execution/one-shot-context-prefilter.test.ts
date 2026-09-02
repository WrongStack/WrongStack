/**
 * Tests for the context-window pre-filter in the OneShotOrchestrator fallback
 * chain.
 *
 * When the estimated request token count exceeds a fallback provider's
 * maxContext, the entry should be skipped instead of dispatching a call that
 * will fail with context_overflow (which is not fallback-worthy and would
 * surface as a terminal error).
 */
import { describe, expect, it, vi } from 'vitest';
import { FallbackProfileManager } from '../../src/core/fallback-profile-manager.js';
import { OneShotOrchestrator } from '../../src/execution/one-shot-llm.js';
import { ProviderError } from '../../src/types/provider.js';
import type { OneShotOrchestratorOptions } from '../../src/types/one-shot-llm.js';
import type { Provider, ProviderErrorKind, Request, Response } from '../../src/types/provider.js';
import type { Config } from '../../src/types/config.js';

function fakeProvider(
  id: string,
  opts?: { failCount?: number; model?: string; maxContext?: number },
): Provider {
  let calls = 0;
  return {
    id,
    capabilities: {
      maxContext: opts?.maxContext ?? 128_000,
      tools: true,
      parallelTools: false,
      vision: false,
      streaming: false,
      promptCache: false,
      systemPrompt: true,
      jsonMode: false,
      reasoning: false,
      cacheControl: 'none',
    },
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

function fakeProviderThatThrows(id: string, kind: ProviderErrorKind = 'overloaded'): Provider {
  return {
    id,
    capabilities: {
      maxContext: 128_000,
      tools: true,
      parallelTools: false,
      vision: false,
      streaming: false,
      promptCache: false,
      systemPrompt: true,
      jsonMode: false,
      reasoning: false,
      cacheControl: 'none',
    },
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
    provider: 'primary',
    model: 'primary-model',
    providers: {
      primary: { type: 'test', apiKey: 'sk-test', models: ['primary-model'] },
      'small-provider': { type: 'test', apiKey: 'sk-small', models: ['small-model'] },
      'large-provider': { type: 'test', apiKey: 'sk-large', models: ['large-model'] },
    },
    ...overrides,
  } as Config;
}

function makeOneShotOpts(
  config: Config,
  buildProvider: OneShotOrchestratorOptions['buildProvider'],
) {
  return {
    buildProvider,
    getConfig: () => config,
    fallbackProfileManager: new FallbackProfileManager(config),
  };
}

describe('OneShotOrchestrator context-window pre-filter', () => {
  it('skips a fallback provider whose maxContext is smaller than the estimated request tokens', async () => {
    // Primary fails with overloaded; small-model has 4K context; large-model has 200K.
    // The request has a large system prompt that estimates to > 4K tokens.
    const primary = fakeProviderThatThrows('primary', 'overloaded');
    const smallProvider = fakeProvider('small-provider', {
      model: 'small-model',
      maxContext: 4_000,
    });
    const largeProvider = fakeProvider('large-provider', {
      model: 'large-model',
      maxContext: 200_000,
    });

    const cfg = makeConfig();
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(cfg, async (pid: string) => {
        if (pid === 'primary') return primary;
        if (pid === 'small-provider') return smallProvider;
        return largeProvider;
      }),
    );

    // Large system prompt — should estimate to well over 4K tokens
    const bigSystem = 'A'.repeat(20_000);

    const result = await orch.call({
      system: bigSystem,
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['small-provider/small-model', 'large-provider/large-model'],
    });

    // small-model should have been skipped; large-model should have been called
    expect(result.fromFallback).toBe(true);
    expect(result.text).toContain('large-model');
    expect(smallProvider.complete).not.toHaveBeenCalled();
    expect(largeProvider.complete).toHaveBeenCalled();
  });

  it('does NOT skip fallback entries when the context window is large enough', async () => {
    const primary = fakeProviderThatThrows('primary', 'overloaded');
    const fallback = fakeProvider('fallback-provider', {
      model: 'fallback-model',
      maxContext: 128_000,
    });

    const cfg = makeConfig();
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(cfg, async (pid) => (pid === 'primary' ? primary : fallback)),
    );

    const result = await orch.call({
      system: 'short system prompt',
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['fallback-provider/fallback-model'],
    });

    expect(result.fromFallback).toBe(true);
    expect(fallback.complete).toHaveBeenCalled();
  });

  it('skips all fallback entries when none have sufficient context window', async () => {
    const primary = fakeProviderThatThrows('primary', 'overloaded');
    // Both fallbacks have tiny context windows
    const smallProvider = fakeProvider('small-provider', {
      model: 'small-model',
      maxContext: 1_000,
    });
    const anotherSmall = fakeProvider('another-small', { model: 'tiny-model', maxContext: 2_000 });

    const cfg = makeConfig({
      providers: {
        primary: { type: 'test', apiKey: 'sk-test', models: ['primary-model'] },
        'small-provider': { type: 'test', apiKey: 'sk-small', models: ['small-model'] },
        'another-small': { type: 'test', apiKey: 'sk-tiny', models: ['tiny-model'] },
      },
    });
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(cfg, async (pid: string) => {
        if (pid === 'primary') return primary;
        if (pid === 'small-provider') return smallProvider;
        return anotherSmall;
      }),
    );

    const bigSystem = 'A'.repeat(20_000);

    const result = await orch.call({
      system: bigSystem,
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['small-provider/small-model', 'another-small/tiny-model'],
    });

    // All fallbacks were skipped — error should be surfaced
    expect(result.error).toBeTruthy();
    expect(result.fromFallback).toBe(false);
    expect(smallProvider.complete).not.toHaveBeenCalled();
    expect(anotherSmall.complete).not.toHaveBeenCalled();
  });

  it('does NOT skip when maxContext is unknown (0 or undefined)', async () => {
    const primary = fakeProviderThatThrows('primary', 'overloaded');
    // Provider with unknown context window (maxContext: 0)
    const unknownProvider: Provider = {
      id: 'unknown-provider',
      capabilities: {
        maxContext: 0,
        tools: true,
        parallelTools: false,
        vision: false,
        streaming: false,
        promptCache: false,
        systemPrompt: true,
        jsonMode: false,
        reasoning: false,
        cacheControl: 'none',
      },
      complete: vi.fn(async () => fakeResponse('unknown-provider', 'unknown-model')),
      stream: vi.fn(),
    };

    const cfg = makeConfig({
      providers: {
        primary: { type: 'test', apiKey: 'sk-test', models: ['primary-model'] },
        'unknown-provider': { type: 'test', apiKey: 'sk-unknown', models: ['unknown-model'] },
      },
    });
    const orch = new OneShotOrchestrator(
      makeOneShotOpts(cfg, async (pid) => (pid === 'primary' ? primary : unknownProvider)),
    );

    const bigSystem = 'A'.repeat(20_000);

    const result = await orch.call({
      system: bigSystem,
      userPrompt: 'hello',
      providerId: 'primary',
      model: 'primary-model',
      fallbackModels: ['unknown-provider/unknown-model'],
    });

    // Should NOT be skipped — maxContext is unknown, so the filter is conservative
    expect(result.fromFallback).toBe(true);
    expect(unknownProvider.complete).toHaveBeenCalled();
  });
});
