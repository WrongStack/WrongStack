import type { Config, Provider } from '@wrongstack/contracts/types';
import { describe, expect, it, vi } from 'vitest';
import { createGoalRefinerAdapter } from '../src/server/goal-refiner-adapter.js';

function provider(id: string, text?: string): Provider {
  return {
    id,
    complete: vi.fn(async () => {
      if (!text) throw new Error('unavailable');
      return {
        content: [{ type: 'text', text }],
        usage: { input: 21, output: 7 },
      } as never;
    }),
  } as never;
}

describe('Goal WebUI refiner adapter', () => {
  it('uses the configured profile before the requesting session model', async () => {
    const primary = provider('primary', 'REFINED_GOAL: Primary\nDELIVERABLES:\n- Primary proof');
    const dedicated = provider('dedicated', 'REFINED_GOAL: Dedicated\nDELIVERABLES:\n- Proof');
    const config = {
      provider: 'primary',
      model: 'primary-model',
      autonomy: { refinerFallbackProfile: 'goal-refiner' },
      fallbackProfiles: { 'goal-refiner': ['dedicated/refiner-model'] },
      favoriteModels: ['refiner-model'],
    } as unknown as Config;
    const refine = createGoalRefinerAdapter({
      config,
      primaryProvider: primary,
      primaryModel: 'primary-model',
      activeProviderId: 'primary',
      createProvider: (id) => (id === 'dedicated' ? dedicated : primary),
    });

    await expect(refine?.('Raw')).resolves.toMatchObject({
      refinedGoal: 'Dedicated',
      deliverables: ['Proof'],
    });
    expect(dedicated.complete).toHaveBeenCalledOnce();
    expect(primary.complete).not.toHaveBeenCalled();
  });

  it('falls back to the requesting session model when the dedicated refiner fails', async () => {
    const primary = provider('primary', 'REFINED_GOAL: Primary\nDELIVERABLES:\n- Proof');
    const dedicated = provider('dedicated');
    const refine = createGoalRefinerAdapter({
      config: {
        provider: 'primary',
        autonomy: { refinerProvider: 'dedicated', refinerModel: 'small-model' },
        favoriteModels: ['small-model'],
      } as unknown as Config,
      primaryProvider: primary,
      primaryModel: 'active-model',
      createProvider: (id) => (id === 'dedicated' ? dedicated : primary),
    });

    await expect(refine?.('Raw')).resolves.toMatchObject({ refinedGoal: 'Primary' });
    expect(dedicated.complete).toHaveBeenCalledOnce();
    expect(primary.complete).toHaveBeenCalledOnce();
    expect(primary.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'active-model' }),
      expect.any(Object),
    );
  });

  it('resolves a model-only refiner against the requesting tab provider', async () => {
    const tabProvider = provider('tab-profile', 'REFINED_GOAL: Tab\nDELIVERABLES:\n- Proof');
    const createProvider = vi.fn((id: string) => (id === 'tab-profile' ? tabProvider : undefined));
    const refine = createGoalRefinerAdapter({
      config: {
        provider: 'boot-profile',
        autonomy: { refinerModel: 'small-model' },
        favoriteModels: ['small-model'],
      } as unknown as Config,
      primaryProvider: tabProvider,
      primaryModel: 'active-model',
      activeProviderId: 'tab-profile',
      createProvider,
    });

    await expect(refine?.('Raw')).resolves.toMatchObject({ refinedGoal: 'Tab' });
    expect(createProvider).toHaveBeenCalledWith('tab-profile');
    expect(tabProvider.complete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'small-model' }),
      expect.any(Object),
    );
  });

  it('delivers refine usage to the onUsage hook for session journaling', async () => {
    const primary = provider('primary', 'REFINED_GOAL: Primary\nDELIVERABLES:\n- Primary proof');
    const dedicated = provider('dedicated', 'REFINED_GOAL: Dedicated\nDELIVERABLES:\n- Proof');
    const appended: unknown[] = [];
    const sessionWriter = {
      append: vi.fn(async (event: unknown) => {
        appended.push(event);
      }),
    };
    const config = {
      provider: 'primary',
      model: 'primary-model',
      autonomy: { refinerProvider: 'dedicated', refinerModel: 'small-model' },
    } as unknown as Config;
    const refine = createGoalRefinerAdapter({
      config,
      primaryProvider: primary,
      primaryModel: 'active-model',
      createProvider: (id) => (id === 'dedicated' ? dedicated : primary),
      onUsage: (usage, source) => {
        void sessionWriter.append({
          type: 'enhance_usage',
          ts: new Date().toISOString(),
          usage,
          provider: source.providerId,
          model: source.model,
        });
      },
    });

    await refine?.('Raw');
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      type: 'enhance_usage',
      usage: { input: 21, output: 7 },
      provider: 'dedicated',
      model: 'small-model',
    });
  });

  it('records failures reaching the adapter with kind and reason', async () => {
    const primary = provider('primary', 'REFINED_GOAL: Primary\nDELIVERABLES:\n- Primary proof');
    const broken = provider('dedicated'); // no text → complete() throws
    const onOutcome = vi.fn();
    const config = {
      provider: 'primary',
      model: 'primary-model',
      autonomy: { refinerProvider: 'dedicated', refinerModel: 'small-model' },
    } as unknown as Config;
    const refine = createGoalRefinerAdapter({
      config,
      primaryProvider: primary,
      primaryModel: 'active-model',
      createProvider: (id) => (id === 'dedicated' ? broken : primary),
      onOutcome,
    });

    await expect(refine?.('Raw')).resolves.toMatchObject({ refinedGoal: 'Primary' });
    // The dedicated tier's failure carries the kind and the refiner's reason.
    expect(onOutcome).toHaveBeenCalledWith({
      result: 'provider_error',
      providerId: 'dedicated',
      model: 'small-model',
      durationMs: expect.any(Number),
      reason: 'unavailable',
      failureKind: 'provider_error',
    });
    // The primary fallback then succeeded — one enriched outcome per attempt.
    expect(onOutcome).toHaveBeenLastCalledWith({
      result: 'success',
      providerId: 'primary',
      model: 'active-model',
      durationMs: expect.any(Number),
    });
  });

  it('emits a success outcome when the refiner succeeds', async () => {
    const primary = provider('primary', 'REFINED_GOAL: Primary\nDELIVERABLES:\n- Primary proof');
    const onOutcome = vi.fn();
    const refine = createGoalRefinerAdapter({
      primaryProvider: primary,
      primaryModel: 'active-model',
      onOutcome,
    });

    await expect(refine?.('Raw')).resolves.toMatchObject({ refinedGoal: 'Primary' });
    expect(onOutcome).toHaveBeenCalledWith({
      result: 'success',
      providerId: 'primary',
      model: 'active-model',
      durationMs: expect.any(Number),
    });
  });
});
