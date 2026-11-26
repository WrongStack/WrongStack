import { describe, expect, it } from 'vitest';
import { resolvePreserveK } from '../src/execution/compaction-history-policy.js';

describe('resolvePreserveK non-finite guard', () => {
  it('falls back to 6 when preserveK is Infinity', () => {
    const res = resolvePreserveK.call(
      {} as Parameters<typeof resolvePreserveK>[0] extends never ? never : never,
      {
        meta: { contextWindowPolicy: { preserveK: Number.POSITIVE_INFINITY } },
      } as unknown as Parameters<typeof resolvePreserveK>[0],
    );
    expect(res).toBe(6);
  });
});
