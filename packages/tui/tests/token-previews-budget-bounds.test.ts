import { describe, expect, it } from 'vitest';
import {
  TOKEN_PREVIEWS_MAX_CHARS,
  TOKEN_PREVIEWS_MAX_ENTRIES,
  TokenPreviewStore,
} from '../src/token-previews.js';

/**
 * F2638: the store's eviction loop compares against `maxEntries`/`maxChars`
 * built with `Math.max(1, Math.floor(budget.x ?? default))`. A NaN budget makes
 * both comparisons false, so eviction never runs and the preview cache grows
 * without bound — the opposite of the constructor's job.
 */
describe('token preview budget typing (F2638)', () => {
  it('falls back to the default entry cap when maxEntries is not finite', () => {
    const store = new TokenPreviewStore({ maxEntries: Number.NaN as never });
    for (let i = 0; i < TOKEN_PREVIEWS_MAX_ENTRIES + 5; i++) store.set(`t${i}`, `v${i}`);

    expect(store.size).toBe(TOKEN_PREVIEWS_MAX_ENTRIES);
  });

  it('falls back to the default char cap when maxChars is not finite', () => {
    const store = new TokenPreviewStore({ maxChars: Number.POSITIVE_INFINITY as never });
    const value = 'x'.repeat(8_192);
    for (let i = 0; i < 100; i++) store.set(`t${i}`, value);

    expect(store.chars).toBeLessThanOrEqual(TOKEN_PREVIEWS_MAX_CHARS);
  });

  it('keeps finite budgets working (control)', () => {
    const store = new TokenPreviewStore({ maxEntries: 3 });
    for (let i = 0; i < 6; i++) store.set(`t${i}`, `v${i}`);

    expect(store.size).toBe(3);
    expect(store.get('t5')).toBe('v5');
  });
});
