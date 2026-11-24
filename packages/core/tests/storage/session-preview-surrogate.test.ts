import { describe, expect, it } from 'vitest';
import { sessionContentPreview } from '../../src/storage/session-helpers.js';

describe('sessionContentPreview Unicode boundary', () => {
  it('does not retain half of an astral character at its cap', () => {
    const preview = sessionContentPreview('ab😀tail', 4);
    expect(preview).toBe('ab…');
    expect(() => new TextEncoder().encode(preview)).not.toThrow();
  });
});
