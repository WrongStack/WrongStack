import { describe, expect, it } from 'vitest';
import { HQ_VAULT_FETCH_SKEW_MS, HqVaultNonceCache } from '../src/vault/store-guards.js';

describe('HqVaultNonceCache non-finite timestamps', () => {
  it('rejects non-finite ts or now so entries cannot become un-evictable', () => {
    const cache = new HqVaultNonceCache();
    expect(cache.remember('dev:n1', Number.NaN, 1_000)).toBe(false);
    expect(cache.remember('dev:n1', 1_000, Number.NaN)).toBe(false);
    expect(cache.remember('dev:n1', 1_000, 1_000)).toBe(true);
    expect(cache.remember('dev:n1', 1_000, 1_000)).toBe(false);
    expect(
      cache.remember(
        'dev:n1',
        1_000 + HQ_VAULT_FETCH_SKEW_MS * 2,
        1_000 + HQ_VAULT_FETCH_SKEW_MS * 2,
      ),
    ).toBe(true);
  });
});
