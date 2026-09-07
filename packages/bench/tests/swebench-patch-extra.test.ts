import { describe, expect, it } from 'vitest';
import { extractPatchPaths } from '../src/suites/swebench-patch.js';

describe('extractPatchPaths', () => {
  it('collects paths from diff --git headers', () => {
    const patch = 'diff --git a/src/foo.py b/src/foo.py\n--- a/src/foo.py\n+++ b/src/foo.py\n';
    expect(extractPatchPaths(patch).has('src/foo.py')).toBe(true);
  });

  it('strips a trailing tab+timestamp from +++/--- paths', () => {
    const patch = '--- a/old.py\t2025-01-01 12:00:00\n+++ b/new.py\t2025-01-01 12:00:01\n';
    const paths = extractPatchPaths(patch);
    expect(paths.has('old.py')).toBe(true); // timestamp stripped
    expect(paths.has('new.py')).toBe(true);
  });

  it('ignores /dev/null markers', () => {
    const patch = '--- /dev/null\n+++ b/created.py\n';
    const paths = extractPatchPaths(patch);
    expect(paths.has('/dev/null')).toBe(false);
    expect(paths.has('created.py')).toBe(true);
  });
});

describe('filterPatchExcludingPaths — non-git unified diffs', () => {
  it('filters non-git unified diffs correctly including /dev/null headers', async () => {
    const { filterPatchExcludingPaths } = await import('../src/suites/swebench-patch.js');
    const diff = [
      '--- /dev/null',
      '+++ b/created.py',
      '@@ -0,0 +1 @@',
      '+created',
      '--- a/deleted.py',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-deleted',
      '--- a/modified.py',
      '+++ b/modified.py',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');

    const filtered = filterPatchExcludingPaths(diff, new Set(['created.py', 'modified.py']));
    expect(filtered).not.toContain('created.py');
    expect(filtered).not.toContain('+created');
    expect(filtered).toContain('deleted.py');
    expect(filtered).not.toContain('modified.py');
  });
});
