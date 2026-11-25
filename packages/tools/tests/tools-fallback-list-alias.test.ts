import { describe, expect, it } from 'vitest';
import { chainList, modelList } from '../src/management/fallback-manage-helpers.js';

describe('fallback-manage-helpers list isolation (F2263)', () => {
  it('returns cloned arrays from modelList and chainList', () => {
    const config = {
      favoriteModels: ['openai/gpt-4o'],
      fallbackModels: ['openai/gpt-4o-mini'],
    } as never;
    modelList(config).push('mutated/model');
    chainList(config).push('mutated/fallback');
    expect((config as { favoriteModels: string[] }).favoriteModels).toEqual(['openai/gpt-4o']);
    expect((config as { fallbackModels: string[] }).fallbackModels).toEqual(['openai/gpt-4o-mini']);
  });
});
