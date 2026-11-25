import { describe, expect, it } from 'vitest';
import {
  formatProjectSuppliedBlock,
  sanitizeProjectSuppliedBody,
} from '../src/project-supplied-fence.js';

describe('project-supplied-fence blank tag fallback', () => {
  it('falls back to default tag when given an empty or whitespace-only tag', () => {
    const out = formatProjectSuppliedBlock({ source: 'README.md', body: 'hello', tag: '   ' });
    expect(out.startsWith('<project-supplied source="README.md">')).toBe(true);
    expect(out.endsWith('</project-supplied>')).toBe(true);
    expect(sanitizeProjectSuppliedBody('a < b', '   ')).toBe('a < b');
  });
});
