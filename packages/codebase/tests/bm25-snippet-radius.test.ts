import { describe, expect, it } from 'vitest';
import { buildBm25Index } from '../src/bm25.js';

describe('Bm25Index.extractSnippet radius bounds', () => {
  it('clamps negative radius to 0 instead of slicing from the end of the document', () => {
    const idx = buildBm25Index([{ id: 1, text: 'hello world foo bar baz' }]);
    expect(idx.extractSnippet(1, ['nomatch'], -1)).toBe('…');
    expect(idx.extractSnippet(1, ['nomatch'], 3)).toBe('hello …');
  });
});
