import { describe, expect, it } from 'vitest';
import {
  cycleEffort,
  EFFORT_KEEP,
  effortOptionsForFocused,
  modelEffortOptions,
} from '../src/components/model-picker-effort.js';

describe('modelEffortOptions', () => {
  it('offers nothing for a non-reasoning model', () => {
    expect(modelEffortOptions({ reasoning: false })).toEqual([]);
    expect(modelEffortOptions(undefined)).toEqual([]);
  });

  it('offers only the documented levels, in canonical order', () => {
    expect(modelEffortOptions({ reasoning: true, effortLevels: ['high', 'low'] })).toEqual([
      EFFORT_KEEP,
      'low',
      'high',
    ]);
  });

  it('falls back to the full canonical set when the vocabulary is undocumented', () => {
    expect(modelEffortOptions({ reasoning: true })).toEqual([
      EFFORT_KEEP,
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  });

  it('ignores levels the runtime does not know', () => {
    expect(modelEffortOptions({ reasoning: true, effortLevels: ['turbo', 'max'] })).toEqual([
      EFFORT_KEEP,
      'max',
    ]);
  });
});

describe('effortOptionsForFocused', () => {
  const picker = {
    step: 'model' as const,
    providerOptions: [
      {
        id: 'openai',
        modelDetails: {
          o3: { reasoning: true, effortLevels: ['low', 'high'] },
          'gpt-4o': { reasoning: false },
        },
      },
    ],
    filteredOptions: ['o3', 'gpt-4o'],
    selected: 0,
    pickedProviderId: 'openai',
  };

  it('reads the focused row, not the provider as a whole', () => {
    expect(effortOptionsForFocused(picker)).toEqual([EFFORT_KEEP, 'low', 'high']);
    expect(effortOptionsForFocused({ ...picker, selected: 1 })).toEqual([]);
  });

  it('is empty in step 1', () => {
    expect(effortOptionsForFocused({ ...picker, step: 'provider' })).toEqual([]);
  });

  it("is empty for generic 'pick' invocations, which cannot carry an effort", () => {
    expect(effortOptionsForFocused({ ...picker, purpose: 'pick' })).toEqual([]);
  });
});

describe('cycleEffort', () => {
  const options = [EFFORT_KEEP, 'low', 'high'] as const;

  it('wraps in both directions', () => {
    expect(cycleEffort(options, EFFORT_KEEP, 1)).toBe('low');
    expect(cycleEffort(options, 'high', 1)).toBe(EFFORT_KEEP);
    expect(cycleEffort(options, EFFORT_KEEP, -1)).toBe('high');
  });

  it('treats an unknown current value as the default sentinel', () => {
    expect(cycleEffort(options, 'max', 1)).toBe('low');
  });

  it('stays on the sentinel when there are no options', () => {
    expect(cycleEffort([], 'low', 1)).toBe(EFFORT_KEEP);
  });
});
