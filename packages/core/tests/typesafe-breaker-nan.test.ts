import { FetchError } from '@wrongstack/contracts/types/errors';
import { describe, expect, it } from 'vitest';
import { createTypeSafeBreaker } from '../src/typesafe/breaker.js';

describe('createTypeSafeBreaker non-finite threshold guard', () => {
  it('falls back to default threshold 3 when threshold is NaN', async () => {
    const failingClient = {
      systemOne: async () => {
        throw new FetchError({ message: 'unauthorized', status: 401 });
      },
    } as Parameters<typeof createTypeSafeBreaker>[0]['client'];

    const breaker = createTypeSafeBreaker({ client: failingClient, threshold: Number.NaN });
    for (let i = 0; i < 3; i++) {
      await expect(breaker.systemOne({} as never)).rejects.toThrow();
    }
    expect(breaker.open).toBe(true);
  });
});
