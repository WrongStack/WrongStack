import { describe, expect, it } from 'vitest';
import { journalRecallTexts, recallHistory } from '../src/journal-recall';

describe('durable prompt recall', () => {
  it('recalls this conversation first, then older journal prompts, without repeats', () => {
    expect(recallHistory(['first', 'second'], ['second', 'older', ' ', 'oldest'])).toEqual([
      'second',
      'first',
      'older',
      'oldest',
    ]);
    expect(recallHistory([], ['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
  });

  it('reads original prompts from the journal, newest first', () => {
    expect(
      journalRecallTexts({
        entries: [
          { category: 'raw_user', content: 'old', timestamp: '2026-10-01T00:00:00Z' },
          { category: 'refined_user', content: 'refined', timestamp: '2026-10-03T00:00:00Z' },
          { category: 'raw_user', content: 'new', timestamp: '2026-10-02T00:00:00Z' },
        ],
      }),
    ).toEqual(['new', 'old']);
  });
});
