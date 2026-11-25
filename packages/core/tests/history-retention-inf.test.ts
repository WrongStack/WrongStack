import { describe, expect, it } from 'vitest';
import { getHistoryRetention } from '../src/execution/history-retention.js';

describe('getHistoryRetention non-finite preserveK guard', () => {
  it('falls back to default preserveK when preserveK is Infinity', () => {
    const res = getHistoryRetention({
      messages: [],
      meta: { contextWindowPolicy: { preserveK: Number.POSITIVE_INFINITY } },
    });
    expect(res.preserveK).toBe(6);
  });
});
