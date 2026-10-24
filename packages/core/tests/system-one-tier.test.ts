/**
 * System One tier suggestion fills only the routing-table gap: a task with no
 * explicit tier and no role/phase route. A configured route, a single level,
 * an unsure Choice or a failing host all leave the default in place.
 */

import type { Config } from '@wrongstack/contracts/types/config';
import { describe, expect, it, vi } from 'vitest';
import { createSystemOneTierSuggester } from '../src/coordination/system-one-tier.js';
import type { TypeSafeJudge } from '../src/typesafe/index.js';

const config = (routing: Record<string, string> = {}): Config =>
  ({
    modelTiers: {
      enabled: true,
      default: 'standard',
      routing,
      levels: {
        budget: { description: 'Cheap and fast' },
        standard: {},
        premium: { description: 'Most capable' },
      },
    },
  }) as unknown as Config;

function judge(choice: string | Error, confidence = 0.8): TypeSafeJudge {
  return {
    feature: 'modelTier',
    model: 'jev-test',
    client: {
      systemOne: vi.fn(async () => {
        if (choice instanceof Error) throw choice;
        return {
          answers: {
            tier: {
              type: 'choice' as const,
              choice,
              confidence,
              probabilities: { budget: 0.1, standard: 0.1, premium: 0.1, [choice]: 0.8 },
            },
          },
          usage: { inputTokens: 1, outputTokens: 0 },
        };
      }),
    },
  };
}

describe('createSystemOneTierSuggester', () => {
  const task = { task: 'Rename the `foo` variable to `bar` in src/util.ts' };

  it('picks a level for a task that fell to the default', async () => {
    const suggest = createSystemOneTierSuggester({
      getConfig: () => config(),
      getJudge: () => judge('budget'),
    });
    expect(await suggest(task)).toBe('budget');
  });

  it('never overrides a role route the user configured', async () => {
    const j = judge('budget');
    const suggest = createSystemOneTierSuggester({
      getConfig: () => config({ reviewer: 'premium' }),
      getJudge: () => j,
    });
    expect(await suggest({ ...task, role: 'reviewer' })).toBeUndefined();
    expect(j.client.systemOne).not.toHaveBeenCalled();
  });

  it('keeps the default when unsure, failing, or tiers are off', async () => {
    const unsure = createSystemOneTierSuggester({
      getConfig: () => config(),
      getJudge: () => judge('premium', 0.3),
    });
    expect(await unsure(task)).toBeUndefined();
    const failing = createSystemOneTierSuggester({
      getConfig: () => config(),
      getJudge: () => judge(new Error('resting')),
    });
    expect(await failing(task)).toBeUndefined();
    const off = createSystemOneTierSuggester({
      getConfig: () => ({}) as Config,
      getJudge: () => judge('budget'),
    });
    expect(await off(task)).toBeUndefined();
  });
});
