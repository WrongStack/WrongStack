import { describe, expect, it } from 'vitest';
import { getTargetFilesForStack } from '../src/scan-targets.js';

describe('getTargetFilesForStack prototype key guard (F2256)', () => {
  it('falls back to unknown globs for Object.prototype keys like toString', () => {
    expect(getTargetFilesForStack({ stack: 'toString' as never })).toEqual(['**/*']);
  });
});
