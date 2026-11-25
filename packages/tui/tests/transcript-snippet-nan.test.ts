import { describe, expect, it } from 'vitest';
import { transcriptMatchSnippet } from '../src/transcript-search.js';

describe('transcriptMatchSnippet non-finite width guard', () => {
  it('preserves full line context when width is NaN', () => {
    const match = { line: 'hello world from transcript', column: 6, length: 5 };
    expect(transcriptMatchSnippet(match, Number.NaN)).toEqual({
      before: 'hello ',
      hit: 'world',
      after: ' from transcript',
    });
  });
});
