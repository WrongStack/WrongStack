import { describe, expect, it } from 'vitest';
import { countUnifiedDiffLines } from '../../core/src/utils/unified-diff-count';
import { extractActivitiesFromMessage } from '../src/atlas/codemap-activity-extract';

/**
 * F2232: the activity extractor's `change` line counts are shown on the Code
 * Map and its own comment promises "the same rule core's countUnifiedDiffLines
 * enforces". A declared hunk bounds its body, so a trailer after the declared
 * lines is not content in either implementation.
 */
function activityCounts(patch: string): { added: number; removed: number } | undefined {
  const [activity] = extractActivitiesFromMessage({
    type: 'tool.started',
    payload: { name: 'edit', id: 'tool-1', input: { patch } },
  });
  const change = activity?.change;
  return change ? { added: change.added, removed: change.removed } : undefined;
}

const BARE_HUNK = '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n';

describe('Code Map patch counts match core countUnifiedDiffLines (F2232)', () => {
  it.each([
    ['bare hunk', BARE_HUNK],
    ['format-patch trailer', `${BARE_HUNK}-- \n2.49.0\n`],
    ['outside-hunk +/- lines', `${BARE_HUNK}-outside hunk\n+outside hunk\n`],
    [
      'line after a declared hunk',
      ['@@ -1,1 +1,1 @@', '-old', '+new', '-not part of the hunk'].join('\n'),
    ],
    [
      'git metadata then binary trailer',
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/binary.png b/binary.png',
        '-- ',
        '2.45.0',
      ].join('\n'),
    ],
    [
      'header-shaped content inside a hunk',
      [
        '--- a/comments.txt',
        '+++ b/comments.txt',
        '@@ -1 +1 @@',
        '--- old comment',
        '+++ new comment',
      ].join('\n'),
    ],
    ['counts-less hunk header', ['@@', '-old', '+new', '+more'].join('\n')],
  ])('counts %s the way core does', (_label, patch) => {
    expect(activityCounts(patch)).toEqual(countUnifiedDiffLines(patch));
  });
});
