import { describe, expect, it } from 'vitest';
import { StreamCoalescer } from '../src/lib/stream-coalescer';

describe('StreamCoalescer fault isolation during drain (F2309)', () => {
  it('flushes remaining queued streams even when an earlier flush callback throws', () => {
    const c = new StreamCoalescer();
    let secondFlushed = false;
    c.push('k1', 'a', () => {
      throw new Error('bad listener');
    });
    c.push('k2', 'b', () => {
      secondFlushed = true;
    });
    expect(() => c.flushAll()).toThrow('bad listener');
    expect(secondFlushed).toBe(true);
  });
});
