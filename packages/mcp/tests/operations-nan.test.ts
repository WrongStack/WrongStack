import { describe, expect, it } from 'vitest';
import { pushBounded, summarizeLatency } from '../src/operations.js';

describe('MCP operations non-finite guards', () => {
  it('filters non-finite/negative latency samples and bounds pushBounded on NaN limit', () => {
    const summary = summarizeLatency([10, Number.NaN, -5, 30]);
    expect(summary.count).toBe(2);
    expect(summary.minMs).toBe(10);
    expect(summary.maxMs).toBe(30);
    expect(summary.p50Ms).toBe(10);

    const arr: number[] = [];
    pushBounded(arr, 1, Number.NaN);
    expect(arr.length).toBe(0);
  });
});
