import { describe, expect, it } from 'vitest';
import { requestLimitExtension } from '../src/core/iteration-limit.js';

describe('requestLimitExtension grant finite guard', () => {
  it('resolves to 0 instead of NaN when a listener calls grant(NaN)', async () => {
    const res = await requestLimitExtension({
      events: {
        emit: (_n: string, p: { grant: (x: number) => void }) => p.grant(Number.NaN),
      } as never,
      currentIterations: 5,
      currentLimit: 5,
      autoExtend: false,
      timeoutMs: 1000,
    });
    expect(res).toBe(0);
  });
});
