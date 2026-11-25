import { describe, expect, it } from 'vitest';
import { settleWithin } from '../src/manager-support.js';

describe('settleWithin non-finite timeout guard', () => {
  it('does not immediately time out when ms is Infinity', async () => {
    const result = await settleWithin(
      new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 20)),
      Number.POSITIVE_INFINITY,
      'timed out',
    );
    expect(result).toBe('ok');
  });
});
