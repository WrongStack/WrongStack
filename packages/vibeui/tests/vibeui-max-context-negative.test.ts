import { describe, expect, it } from 'vitest';
import { runtimeReducers } from '../src/lib/reducers/runtime';

describe('runtimeReducers["ctx.max_context"] positive guard (F2275)', () => {
  it('preserves existing maxContext when ctx.max_context carries <= 0', () => {
    const state = { maxContext: 128_000, load: 0, tokens: 0, messages: [], prefs: {} } as never;
    const next = runtimeReducers['ctx.max_context']!(state, { maxContext: -500 }, {
      type: 'ctx.max_context',
    } as never);
    expect(next.maxContext).toBe(128_000);
  });
});
