import { describe, expect, it } from 'vitest';
import { filterPromptPicker, type PromptPickEntry } from '../src/components/prompt-picker-model.js';

describe('filterPromptPicker duplicate recentSlugs guard (F2266)', () => {
  it('deduplicates recentSlugs while preserving order', () => {
    const all: PromptPickEntry[] = [
      {
        slug: 'review',
        title: 'Review',
        description: 'd',
        category: 'code',
        source: 'builtin',
        content: 'c',
        favorite: false,
      },
    ];
    const result = filterPromptPicker(all, ['all', '🕘 recent'], 1, ['review', 'review']);
    expect(result).toHaveLength(1);
  });
});
