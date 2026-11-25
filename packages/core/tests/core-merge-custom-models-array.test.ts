import { describe, expect, it } from 'vitest';
import { mergeCustomModelDefs } from '../src/utils/merge-custom-models.js';

describe('mergeCustomModelDefs array and blank-id guard (F2285)', () => {
  it('skips blank model ids and array values', () => {
    expect(
      mergeCustomModelDefs(
        { '   ': { contextWindow: 8000 } as never, arr: ['bad'] as never },
        undefined,
      ),
    ).toBeUndefined();
  });
});
