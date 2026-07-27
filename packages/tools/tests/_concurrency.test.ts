import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/_concurrency.js';

describe('mapWithConcurrency', () => {
  it('returns empty array for empty input', async () => {
    const result = await mapWithConcurrency([], 3, async (x: number) => x * 2);
    expect(result).toEqual([]);
  });

  it('maps all items with default concurrency', async () => {
    const result = await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      3,
      async (x: number) => x * 2,
    );
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it('preserves order of results', async () => {
    const items = [10, 20, 30, 40, 50];
    const result = await mapWithConcurrency(items, 2, async (x: number) => {
      // Delay proportional to value to ensure ordering is order of input,
      // not order of completion
      await new Promise((r) => setTimeout(r, 5));
      return x / 10;
    });
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it('handles limit=1 (serial execution)', async () => {
    let running = 0;
    let maxRunning = 0;
    const result = await mapWithConcurrency(
      [1, 2, 3],
      1,
      async (x: number) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return x;
      },
    );
    expect(result).toEqual([1, 2, 3]);
    expect(maxRunning).toBe(1);
  });

  it('handles limit higher than items length', async () => {
    const result = await mapWithConcurrency(
      ['a', 'b'],
      10,
      async (x: string) => x.toUpperCase(),
    );
    expect(result).toEqual(['A', 'B']);
  });

  it('rejects on first error (fail-fast)', async () => {
    await expect(
      mapWithConcurrency(
        [1, 2, 3, 4, 5],
        2,
        async (x: number) => {
          if (x === 3) throw new Error('boom');
          return x;
        },
      ),
    ).rejects.toThrow('boom');
  });
});
