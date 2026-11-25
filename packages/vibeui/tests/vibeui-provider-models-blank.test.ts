import { describe, expect, it } from 'vitest';
import { providerReducers } from '../src/lib/reducers/provider';

describe('providerReducers["provider.models"] blank provider guard (F2274)', () => {
  it('ignores provider.models frames with blank provider ids', () => {
    const state = { models: {}, providers: [], provider: '', model: '', notice: '' } as never;
    const next = providerReducers['provider.models']!(
      state,
      { provider: '   ', models: [{ id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000 }] },
      { type: 'provider.models' } as never,
    );
    expect(Object.keys(next.models)).toEqual([]);
  });
});
