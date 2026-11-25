import { describe, expect, it } from 'vitest';
import { searchFileVectorsWithStatement } from '../src/writer-vectors.js';

describe('searchFileVectorsWithStatement non-finite query norm', () => {
  it('short-circuits without scanning when query norm is non-finite', () => {
    let queried = false;
    const hits = searchFileVectorsWithStatement(
      () =>
        ({
          all: () => {
            queried = true;
            return [];
          },
        }) as never,
      new Float32Array([Number.POSITIVE_INFINITY, 1]),
      10,
      0,
    );
    expect(queried).toBe(false);
    expect(hits).toEqual([]);
  });
});
