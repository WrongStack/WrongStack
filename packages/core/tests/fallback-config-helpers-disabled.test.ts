import type { Config } from '@wrongstack/contracts/types/config';
import { describe, expect, it } from 'vitest';
import { disabledModelKeys } from '../src/core/fallback-config-helpers.js';

describe('disabledModelKeys non-string entry guard', () => {
  it('skips non-string entries instead of throwing TypeError', () => {
    const keys = disabledModelKeys({
      provider: 'openai',
      disabledModels: [null, 123, 'gpt-4o'] as unknown as string[],
    } as unknown as Config);
    expect([...keys]).toEqual(['openai/gpt-4o']);
  });
});
