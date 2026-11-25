import { describe, expect, it } from 'vitest';
import { createTokenBucket } from '../src/rate-limiter.js';

describe('createTokenBucket sub-1 burst guard (F2247)', () => {
  it('falls back to default burst for sub-1 burst values so waitForToken can acquire a token', async () => {
    const bucket = createTokenBucket({ tokensPerSecond: 1000, burst: 0.5 });
    const start = Date.now();
    await bucket.waitForToken(50);
    expect(Date.now() - start).toBeLessThan(40);
  });
});
