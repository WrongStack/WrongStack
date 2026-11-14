import { describe, expect, it } from 'vitest';
import { resolveTestFiles } from '../src/test-runner-gate/test-runner.js';

describe('resolveTestFiles $-sequence preservation (F293)', () => {
  it('preserves $$ and $& sequences in source paths without corruption or silent drop', () => {
    expect(resolveTestFiles('src/$$id.ts', ['{dir}/{name}.test.ts'])).toEqual(['src/$$id.test.ts']);
    expect(resolveTestFiles('src/foo$&bar.ts', ['{dir}/{name}.test.ts'])).toEqual([
      'src/foo$&bar.test.ts',
    ]);
  });
});
