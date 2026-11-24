import { describe, expect, it } from 'vitest';
import {
  annotateUnifiedDiffWithLineNumbers,
  computeHybridIncrementalDeltaDiff,
} from '../src/review-diff.js';

describe('annotateUnifiedDiffWithLineNumbers — hunk lines that read like file headers', () => {
  it('keeps a removed "-- comment" line (shown as "--- comment") inside its hunk', () => {
    const res = annotateUnifiedDiffWithLineNumbers(
      [
        'diff --git a/schema.sql b/schema.sql',
        '--- a/schema.sql',
        '+++ b/schema.sql',
        '@@ -1,4 +1,4 @@',
        ' CREATE TABLE t (id int);',
        '--- legacy note',
        ' SELECT 1;',
        '+SELECT 2;',
        ' SELECT 9;',
      ].join('\n'),
    );
    expect(res.removedLines).toBe(1);
    expect(res.addedLines).toBe(1);
    expect(res.annotatedDiff).toContain('     | --- legacy note');
    expect(res.annotatedDiff).toContain('   3 | +SELECT 2;');
    expect(res.annotatedDiff).toContain('   4 |  SELECT 9;');
  });

  it('keeps an added "++ x" line (shown as "+++ x") inside its hunk, then reads the next file header', () => {
    const res = annotateUnifiedDiffWithLineNumbers(
      [
        '@@ -1,2 +1,3 @@',
        ' a',
        '+++ added',
        ' b',
        'diff --git a/next.txt b/next.txt',
        '--- a/next.txt',
        '+++ b/next.txt',
        '@@ -7 +7 @@',
        '-old',
        '+new',
      ].join('\n'),
    );
    expect(res.hunkCount).toBe(2);
    expect(res.addedLines).toBe(2);
    expect(res.removedLines).toBe(1);
    expect(res.annotatedDiff).toContain('   2 | +++ added');
    expect(res.annotatedDiff).toContain('   3 |  b');
    expect(res.annotatedDiff).toContain('\n--- a/next.txt\n+++ b/next.txt\n');
    expect(res.annotatedDiff).toContain('   7 | +new');
  });

  it('counts a removed "-- note" line in the session delta diff', () => {
    const delta = computeHybridIncrementalDeltaDiff('a\n-- note\nb\nc', 'a\nb\nc2\nc');
    expect(delta?.removedLines).toBe(1);
    expect(delta?.addedLines).toBe(1);
    expect(delta?.annotatedDiff).toContain('   3 | +c2');
  });
});
