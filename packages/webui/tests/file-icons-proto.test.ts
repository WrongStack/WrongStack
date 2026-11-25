import { describe, expect, it } from 'vitest';
import { fileIcon } from '../src/lib/file-icons';

describe('fileIcon prototype safety', () => {
  it('returns the fallback File icon for prototype-named extensions like .constructor', () => {
    const fallback = fileIcon('unknown.xyz');
    expect(fileIcon('foo.constructor')).toBe(fallback);
    expect(fileIcon('index.ts')).not.toBe(fallback);
  });
});
