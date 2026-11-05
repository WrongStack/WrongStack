import { describe, expect, it } from 'vitest';
import {
  extractPathHints,
  summarizeToolResultElision,
} from '../../src/execution/compaction-elision-summaries.js';
import type { ToolResultBlock } from '@wrongstack/contracts/types/blocks';

/**
 * Regression guard for the elision twin of PATH_HINT_PATTERN.
 *
 * utils/compaction-preview.ts (the fixed twin, 69ce9f3fc) requires a hint to
 * start at a run boundary (lookbehind) with segments bounded to a filename's
 * length (255). The elision copy in execution/compaction-elision-summaries.ts
 * missed that sync: its unbounded first segment swallowed a >255-char segment
 * plus the real path after it into one match, and the 220-char receipt cap
 * below then dropped the whole match, so the elision receipt lost the
 * `files=` attribution entirely.
 */

// A URL-ish token whose middle segment exceeds the 255-char bound, followed by
// real paths (newline-separated so each path is its own candidate).
const overlongSegment = `cdn.example.com/${'a'.repeat(300)}/assets/app.js\nsrc/other.ts`;

function block(content: string): ToolResultBlock {
  return { type: 'tool_result', tool_use_id: 't1', content, is_error: false };
}

describe('extractPathHints (elision summaries)', () => {
  it('extracts an ordinary relative path', () => {
    expect(extractPathHints('src/large.ts')).toEqual(['src/large.ts']);
  });

  it('keeps semicolon-separated paths distinct', () => {
    expect(extractPathHints('edited src/a.ts; src/b.ts')).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('matches the preview twin on mixed separators and drive paths', () => {
    const hints = extractPathHints('key=src/a.ts, other:lib/b.json; at C:\\Users\\dev\\c.json');
    expect([...hints].sort()).toEqual(['C:/Users/dev/c.json', 'lib/b.json', 'src/a.ts']);
  });

  it('finds a short path that follows a segment longer than 255 chars', () => {
    expect([...extractPathHints(overlongSegment)].sort()).toEqual([
      'assets/app.js',
      'src/other.ts',
    ]);
  });

  it('does not swallow paths after a segment one char over the bound', () => {
    const content = `${'c'.repeat(256)}/build/out.ts\nsrc/other.ts`;
    expect([...extractPathHints(content)].sort()).toEqual(['build/out.ts', 'src/other.ts']);
  });

  it('keeps the file attribution in the elision receipt', () => {
    const receipt = summarizeToolResultElision(block(overlongSegment), 120);
    expect(receipt).toContain('files=assets/app.js, src/other.ts');
  });
});
