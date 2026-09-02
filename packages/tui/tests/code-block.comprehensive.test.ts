import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import {
  DiffBlock,
  type DiffFilePreviews,
  applyWashTokens,
  extractDiffPreview,
  extractMultiFileDiffs,
  extractReplaceDiffs,
  formatDiffStats,
  formatMultiDiffSummary,
  summarizeMultiFileDiffs,
  MULTI_DIFF_SUMMARY_THRESHOLD,
} from '../src/components/history/code-block.js';

describe('applyWashTokens', () => {
  it('returns tokens unchanged when not on wash', () => {
    const tokens = [{ text: 'hello', color: 'syntax.comment', dim: true }];
    expect(applyWashTokens(tokens, false)).toBe(tokens);
  });

  it('re-points comment tokens to the on-wash role', () => {
    const tokens = [
      { text: 'const', color: 'syntax.keyword' as const },
      { text: ' ', color: undefined },
      { text: 'x', color: 'syntax.comment' as const, dim: true },
    ];
    const result = applyWashTokens(tokens, true);
    expect(result[0]).toBe(tokens[0]);
    expect(result[2]).not.toBe(tokens[2]);
    expect(result[2]).toMatchObject({ text: 'x', color: 'syntax.commentOnWash', dim: false });
  });
});

describe('summarizeMultiFileDiffs', () => {
  it('sums stats across multiple files', () => {
    const items = [
      {
        path: 'a.ts',
        preview: { added: 2, removed: 1, hiddenAdded: 0, hiddenRemoved: 0, hidden: 0, rows: [] },
      },
      {
        path: 'b.ts',
        preview: { added: 3, removed: 4, hiddenAdded: 1, hiddenRemoved: 2, hidden: 5, rows: [] },
      },
    ];
    const summary = summarizeMultiFileDiffs(items);
    expect(summary).toMatchObject({
      fileCount: 2,
      added: 5,
      removed: 5,
      hiddenAdded: 1,
      hiddenRemoved: 2,
      truncatedFiles: 1,
    });
  });

  it('counts omitted changes in totals without labeling them as hidden preview rows', () => {
    const items: DiffFilePreviews = [];
    items.omitted = { fileCount: 2, added: 7, removed: 3 };

    expect(summarizeMultiFileDiffs(items)).toMatchObject({
      fileCount: 2,
      added: 7,
      removed: 3,
      hiddenAdded: 0,
      hiddenRemoved: 0,
      truncatedFiles: 0,
      omittedFiles: 2,
    });
  });
});

describe('formatMultiDiffSummary', () => {
  it('returns null when threshold is 0', () => {
    const summary = {
      fileCount: 5,
      added: 10,
      removed: 5,
      hiddenAdded: 0,
      hiddenRemoved: 0,
      truncatedFiles: 0,
      omittedFiles: 0,
    };
    expect(formatMultiDiffSummary(summary, 0)).toBeNull();
  });

  it('returns null when fileCount below effective threshold', () => {
    const summary = {
      fileCount: 3,
      added: 10,
      removed: 5,
      hiddenAdded: 0,
      hiddenRemoved: 0,
      truncatedFiles: 0,
      omittedFiles: 0,
    };
    expect(formatMultiDiffSummary(summary, MULTI_DIFF_SUMMARY_THRESHOLD)).toBeNull();
  });

  it('renders summary with hidden stats when fileCount >= threshold', () => {
    const summary = {
      fileCount: 7,
      added: 10,
      removed: 5,
      hiddenAdded: 2,
      hiddenRemoved: 1,
      truncatedFiles: 1,
      omittedFiles: 0,
    };
    const result = formatMultiDiffSummary(summary, 3);
    expect(result).toContain('7 files');
    expect(result).toContain('+10');
    expect(result).toContain('·');
  });

  it('returns default threshold when passed negative value', () => {
    const summary = {
      fileCount: 7,
      added: 10,
      removed: 5,
      hiddenAdded: 0,
      hiddenRemoved: 0,
      truncatedFiles: 0,
      omittedFiles: 0,
    };
    const result = formatMultiDiffSummary(summary, -1);
    // -1 triggers the default threshold (5), so 7 >= 5 → renders
    expect(result).not.toBeNull();
  });
});

describe('formatDiffStats', () => {
  it('handles single line singular forms', () => {
    expect(formatDiffStats(1, 0)).toBe('Added 1 line');
    expect(formatDiffStats(0, 1)).toBe('Removed 1 line');
    expect(formatDiffStats(2, 2)).toBe('Added 2 lines, removed 2 lines');
  });
});

describe('extractDiffPreview', () => {
  it('returns undefined for empty/whitespace output', () => {
    expect(extractDiffPreview('edit', '')).toBeUndefined();
    expect(extractDiffPreview('edit', '   ')).toBeUndefined();
  });

  it('handles write tool with created=true from input content', () => {
    const output = JSON.stringify({ path: 'new.ts', diff: '@@ -0,0 +1,2 @@\n+line1\n+line2' });
    const preview = extractDiffPreview('write', output, { content: 'line1\nline2' });
    expect(preview).toBeDefined();
  });

  it('handles patch tool with JSON output containing stdout', () => {
    const output = JSON.stringify({ stdout: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new' });
    const preview = extractDiffPreview('patch', output);
    expect(preview).toBeDefined();
    expect(preview!.added).toBe(1);
  });

  it('handles (no-op) diffs', () => {
    expect(extractDiffPreview('edit', JSON.stringify({ diff: '(no-op)' }))).toBeUndefined();
  });
});

describe('extractMultiFileDiffs', () => {
  it('returns undefined for empty output', () => {
    expect(extractMultiFileDiffs('replace', '')).toBeUndefined();
  });

  it('handles replace tool with results', () => {
    const output = JSON.stringify({
      results: [{ path: 'a.ts', diff: '--- a.ts\n+++ b.ts\n@@ -1 +1 @@\n-old\n+new' }],
    });
    const diffs = extractMultiFileDiffs('replace', output);
    expect(diffs).toBeDefined();
    expect(diffs!.length).toBe(1);
    expect(diffs![0]!.path).toBe('a.ts');
  });

  it('returns undefined for unsupported tool', () => {
    expect(extractMultiFileDiffs('grep', 'some output')).toBeUndefined();
  });
});

describe('extractReplaceDiffs', () => {
  it('returns undefined for non-replace tool', () => {
    expect(extractReplaceDiffs('edit', 'output')).toBeUndefined();
  });
});

describe('DiffBlock', () => {
  it('renders with add/del markers and stats header', () => {
    const rows = [
      { kind: 'add' as const, text: '+new line', newLine: 1 },
      { kind: 'del' as const, text: '-old line', oldLine: 1 },
    ];
    const { lastFrame, unmount } = render(React.createElement(DiffBlock, { rows, hidden: 0 }));
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('+');
    expect(frame).toContain('-');
  });

  it('renders hunk rows (first hunk hidden, second shows)', () => {
    const rows = [
      { kind: 'hunk' as const, text: '@@ -1 +1 @@' },
      { kind: 'hunk' as const, text: '@@ -5 +5 @@' },
    ];
    const { lastFrame, unmount } = render(React.createElement(DiffBlock, { rows, hidden: 0 }));
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('⋯');
  });

  it('renders meta rows', () => {
    const rows = [{ kind: 'meta' as const, text: 'This is a meta description' }];
    const { lastFrame, unmount } = render(React.createElement(DiffBlock, { rows, hidden: 0 }));
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('This is a meta description');
  });

  it('renders hidden > 0 footer', () => {
    const rows = [{ kind: 'add' as const, text: '+new line', newLine: 1 }];
    const { lastFrame, unmount } = render(
      React.createElement(DiffBlock, { rows, hidden: 5, hiddenAdded: 3, hiddenRemoved: 2 }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('more line');
  });

  it('renders stats line when showStats=true', () => {
    const rows = [{ kind: 'add' as const, text: '+new', newLine: 1 }];
    const { lastFrame, unmount } = render(
      React.createElement(DiffBlock, { rows, hidden: 0, added: 1, removed: 2, showStats: true }),
    );
    const frame = lastFrame() ?? '';
    unmount();
    expect(frame).toContain('⎿');
  });
});
