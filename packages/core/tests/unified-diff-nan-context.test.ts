import { describe, expect, it } from 'vitest';
import { unifiedDiff } from '../src/utils/diff.js';

describe('unifiedDiff non-finite context guard', () => {
  it('falls back to default context when opts.context is NaN', () => {
    const diff = unifiedDiff('a\nb\n', 'a\nc\n', { context: Number.NaN });
    expect(diff).toContain('-b');
    expect(diff).toContain('+c');
  });
});
