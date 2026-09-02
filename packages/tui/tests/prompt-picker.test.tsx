import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  PromptPicker,
  type PromptPickEntry,
  filterPromptPicker,
} from '../src/components/prompt-picker.js';

const entries: PromptPickEntry[] = [
  {
    slug: 'test',
    title: 'Write tests',
    description: 'Create unit tests',
    category: 'testing',
    source: 'project',
    content: 'Write tests for...',
    favorite: false,
  },
  {
    slug: 'fix',
    title: 'Fix bug',
    description: 'Debug and fix',
    category: 'debug',
    source: 'user',
    content: 'Fix the bug...',
    favorite: true,
  },
  {
    slug: 'refactor',
    title: 'Refactor',
    description: 'Clean up code',
    category: 'testing',
    source: 'synced',
    content: 'Refactor...',
    favorite: false,
  },
];

describe('filterPromptPicker', () => {
  it('returns all when category is "all"', () => {
    expect(filterPromptPicker(entries, ['all'], 0)).toEqual(entries);
  });

  it('filters by category when catIndex points to a specific category', () => {
    const result = filterPromptPicker(entries, ['all', 'testing', 'debug'], 2);
    expect(result).toHaveLength(1);
    expect(result.every((e) => e.category === 'debug')).toBe(true);
  });

  it('filters by "★ favorites"', () => {
    const result = filterPromptPicker(entries, ['all', '★ favorites'], 1);
    expect(result).toHaveLength(1);
    expect(result[0]!.slug).toBe('fix');
  });

  it('filters by "🕘 recent" order', () => {
    const result = filterPromptPicker(entries, ['all', '🕘 recent'], 1, ['refactor', 'test']);
    expect(result).toHaveLength(2);
    expect(result[0]!.slug).toBe('refactor');
    expect(result[1]!.slug).toBe('test');
  });

  it('returns empty for recent slugs with no matches', () => {
    const result = filterPromptPicker(entries, ['all', '🕘 recent'], 1, ['nonexistent']);
    expect(result).toHaveLength(0);
  });

  it('filters by specific category', () => {
    const result = filterPromptPicker(entries, ['all', 'testing', 'debug'], 1);
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.category === 'testing')).toBe(true);
  });

  it('returns empty array for empty input', () => {
    const result = filterPromptPicker([], ['all'], 0);
    expect(result).toEqual([]);
  });
});

describe('PromptPicker', () => {
  it('renders title with category and count', () => {
    const view = render(
      React.createElement(PromptPicker, {
        entries,
        selected: 0,
        category: 'all',
        total: 3,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Prompt library');
    expect(frame).toContain('all');
    expect(frame).toContain('3/3');
    view.unmount();
  });

  it('renders key hints', () => {
    const view = render(
      React.createElement(PromptPicker, {
        entries,
        selected: 0,
        category: 'all',
        total: 3,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('↑/↓ navigate');
    expect(frame).toContain('Enter insert');
    view.unmount();
  });

  it('renders all entries with titles', () => {
    const view = render(
      React.createElement(PromptPicker, {
        entries,
        selected: 0,
        category: 'all',
        total: 3,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Write tests');
    expect(frame).toContain('Fix bug');
    expect(frame).toContain('Refactor');
    view.unmount();
  });

  it('shows empty message when no entries', () => {
    const view = render(
      React.createElement(PromptPicker, {
        entries: [],
        selected: 0,
        category: 'all',
        total: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('No prompts in this category');
    view.unmount();
  });

  it('highlights selected entry', () => {
    const view = render(
      React.createElement(PromptPicker, {
        entries,
        selected: 0,
        category: 'all',
        total: 3,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('›');
    view.unmount();
  });

  it('shows favorite star for favorited entries', () => {
    const view = render(
      React.createElement(PromptPicker, {
        entries,
        selected: 1,
        category: 'all',
        total: 3,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('★');
    view.unmount();
  });

  it('shows correct source glyphs', () => {
    const allSources: PromptPickEntry[] = [
      {
        slug: 'a',
        title: 'Proj',
        description: 'x',
        category: 'test',
        source: 'project',
        content: 'x',
        favorite: false,
      },
      {
        slug: 'b',
        title: 'User',
        description: 'x',
        category: 'test',
        source: 'user',
        content: 'x',
        favorite: false,
      },
      {
        slug: 'c',
        title: 'Sync',
        description: 'x',
        category: 'test',
        source: 'synced',
        content: 'x',
        favorite: false,
      },
      {
        slug: 'd',
        title: 'Def',
        description: 'x',
        category: 'test',
        source: 'other',
        content: 'x',
        favorite: false,
      },
    ];
    const view = render(
      React.createElement(PromptPicker, {
        entries: allSources,
        selected: 0,
        category: 'all',
        total: 4,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('📁');
    expect(frame).toContain('👤');
    expect(frame).toContain('☁');
    expect(frame).toContain('📦');
    view.unmount();
  });

  it('handles many entries with window scrolling', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      slug: `e${i}`,
      title: `Entry ${i}`,
      description: `desc ${i}`,
      category: 'test',
      source: 'project' as const,
      content: 'x',
      favorite: false,
    }));
    const view = render(
      React.createElement(PromptPicker, {
        entries: many,
        selected: 15,
        category: 'all',
        total: 20,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Entry 15');
    view.unmount();
  });
});

describe('PromptPicker - detail panel height stability (split mode)', () => {
  // Regression: navigating between prompts with different description/preview
  // lengths used to change the detail-panel height because both sections
  // rendered with wrap="wrap" and no height floor. Both are now pre-wrapped
  // into fixed line budgets with blank-line padding, so every prompt's frame
  // must be the same height.
  const columns = 100;
  const maxRows = 20;

  function frameLineCount(frame: string): number {
    const trimmed = frame.replace(/\s+$/, '');
    return trimmed === '' ? 0 : trimmed.split('\n').length;
  }

  it('renders the same frame height for short vs long description and content', () => {
    const varied: PromptPickEntry[] = [
      {
        slug: 'short',
        title: 'Short',
        description: 'Brief.',
        category: 'test',
        source: 'project',
        content: 'Do the thing.',
        favorite: false,
      },
      {
        slug: 'long',
        title: 'Long',
        description:
          'This is a much longer description that spans multiple lines when wrapped at the detail panel width, exercising the word-aware wrapper and its ellipsis truncation behavior.',
        category: 'test',
        source: 'project',
        content:
          'Line one of a very long prompt body.\nLine two continues with more detail.\nLine three adds additional context.\nLine four has even more content.\nLine five keeps going.\nLine six is here too.\nLine seven would overflow the budget.\nLine eight definitely overflows.',
        favorite: false,
      },
    ];

    const viewShort = render(
      React.createElement(PromptPicker, {
        entries: varied,
        selected: 0,
        category: 'all',
        total: 2,
        columns,
        maxRows,
      }),
    );
    const shortFrame = viewShort.lastFrame() ?? '';
    viewShort.unmount();

    const viewLong = render(
      React.createElement(PromptPicker, {
        entries: varied,
        selected: 1,
        category: 'all',
        total: 2,
        columns,
        maxRows,
      }),
    );
    const longFrame = viewLong.lastFrame() ?? '';
    viewLong.unmount();

    expect(frameLineCount(shortFrame)).toBe(frameLineCount(longFrame));
  });

  it('fits the detail panel within maxRows at the 14-row boundary', () => {
    const entry: PromptPickEntry = {
      slug: 'x',
      title: 'Boundary',
      description:
        'A description long enough to wrap to multiple lines at the detail panel width, exercising the budget derivation.',
      category: 'test',
      source: 'project',
      content:
        'Line one of a long body that would overflow a fixed 6-line preview budget.\nLine two.\nLine three.\nLine four.\nLine five.\nLine six.\nLine seven.\nLine eight.',
      favorite: false,
    };

    const view = render(
      React.createElement(PromptPicker, {
        entries: [entry],
        selected: 0,
        category: 'all',
        total: 1,
        columns: 100,
        maxRows: 14,
      }),
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();

    // Detail panel: 10 chrome + 2 desc + 2 preview = 14, which must fit.
    expect(frame).toContain('slug:');
    expect(frame).toContain('preview');
    expect(frameLineCount(frame)).toBeLessThanOrEqual(14);
  });

  it('falls back to list-only below the 14-row split threshold', () => {
    const entry: PromptPickEntry = {
      slug: 'x',
      title: 'Low',
      description: 'desc',
      category: 'test',
      source: 'project',
      content: 'content',
      favorite: false,
    };

    const view = render(
      React.createElement(PromptPicker, {
        entries: [entry],
        selected: 0,
        category: 'all',
        total: 1,
        columns: 100,
        maxRows: 13,
      }),
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();

    // Below SPLIT_MIN_ROWS the detail panel must not render at all.
    expect(frame).not.toContain('slug:');
    expect(frame).not.toContain('preview');
  });

  it('fits the detail panel within maxRows at the 17-row boundary', () => {
    const entry: PromptPickEntry = {
      slug: 'x',
      title: 'Mid',
      description:
        'A description long enough to wrap to multiple lines at the detail panel width, exercising the budget derivation.',
      category: 'test',
      source: 'project',
      content:
        'Line one of a long body.\nLine two.\nLine three.\nLine four.\nLine five.\nLine six.\nLine seven.\nLine eight.',
      favorite: false,
    };

    const view = render(
      React.createElement(PromptPicker, {
        entries: [entry],
        selected: 0,
        category: 'all',
        total: 1,
        columns: 100,
        maxRows: 17,
      }),
    );
    const frame = view.lastFrame() ?? '';
    view.unmount();

    // 10 chrome + 2 desc + 5 preview = 17, must fit within the 17-row budget.
    expect(frame).toContain('slug:');
    expect(frameLineCount(frame)).toBeLessThanOrEqual(17);
  });
});
