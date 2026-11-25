import { describe, expect, it } from 'vitest';
import {
  renewRotatingOAuthCredential,
  setSubscriptionRefreshTransaction,
} from '../src/subscription-refresh-store.js';

describe('renewRotatingOAuthCredential non-finite expires', () => {
  it('omits expiresAt instead of throwing RangeError when exchange returns NaN expires', async () => {
    setSubscriptionRefreshTransaction(async (_pid, source, renew) => renew(source));
    try {
      const res = await renewRotatingOAuthCredential({
        providerId: 'openai',
        stored: { label: 'main', apiKey: 'old', authMethod: 'oauth' } as never,
        accessToken: 'old',
        refreshToken: 'ref1',
        exchange: async () => ({
          access: 'new-acc',
          refresh: 'new-ref',
          expires: Number.NaN,
        }),
        signInHint: 'Sign in again',
      });
      expect(res?.credential.apiKey).toBe('new-acc');
      expect(res?.credential.expiresAt).toBeUndefined();
      expect(Number.isFinite(res?.tokens.expires)).toBe(true);
    } finally {
      setSubscriptionRefreshTransaction(undefined);
    }
  });
});
