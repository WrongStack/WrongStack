import { describe, expect, it } from 'vitest';
import { StoreFaultBreaker } from '../src/middleware/tool-call-memory-breaker.js';

describe('StoreFaultBreaker non-finite clock guard', () => {
  it('keeps an open breaker open when isOpen receives NaN', () => {
    const breaker = new StoreFaultBreaker({ threshold: 1, cooldownMs: 60_000 });
    breaker.recordFailure(new Error('SQLITE_IOERR'), 1_000);
    expect(breaker.isOpen(Number.NaN)).toBe(true);
    expect(breaker.isOpen(2_000)).toBe(true);
    expect(breaker.isOpen(62_000)).toBe(false);
  });
});
