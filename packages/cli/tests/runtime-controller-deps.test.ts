import type { Context } from '@wrongstack/core/agent';
import type { Provider } from '@wrongstack/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createRuntimeControllerDeps } from '../src/wiring/runtime-controller-deps.js';

function provider(id: string): Provider {
  return { id } as Provider;
}

describe('createRuntimeControllerDeps refiner provider resolution', () => {
  it('does not substitute the live provider when the requested provider/model cannot be built', async () => {
    const live = provider('openai-codex');
    const buildProviderForModel = vi.fn(async () => {
      throw new Error('missing credentials');
    });
    const deps = createRuntimeControllerDeps({
      buildProviderForModel,
      context: { provider: live, model: 'gpt-5.6-sol' } as Context,
    } as never);

    await expect(
      deps.buildEnhancerProvider?.('opencode-go', 'deepseek-v4-flash'),
    ).resolves.toBeUndefined();
    expect(buildProviderForModel).toHaveBeenCalledWith('opencode-go', 'deepseek-v4-flash');
  });

  it('returns the provider built for the exact requested model', async () => {
    const target = provider('opencode-go');
    const buildProviderForModel = vi.fn(async () => target);
    const deps = createRuntimeControllerDeps({
      buildProviderForModel,
      context: { provider: provider('openai-codex'), model: 'gpt-5.6-sol' } as Context,
    } as never);

    await expect(deps.buildEnhancerProvider?.('opencode-go', 'deepseek-v4-flash')).resolves.toBe(
      target,
    );
  });
});
