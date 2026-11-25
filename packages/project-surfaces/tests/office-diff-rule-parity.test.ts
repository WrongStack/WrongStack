import { describe, expect, it } from 'vitest';
import { countUnifiedDiffLines } from '../../core/src/utils/unified-diff-count';
import { buildAgentToolCalls } from '../src/office/agent-office';

/**
 * F2241: the Office view's edit summary is computed by `patchDelta`, whose own
 * comment promises the same rule as core's `countUnifiedDiffLines` (and the
 * Code Map extractor). A declared hunk bounds its body, so trailer lines after
 * it are not content.
 */
function officeCounts(patch: string): { added: number; removed: number } | undefined {
  const [call] = buildAgentToolCalls(
    [
      {
        id: 'evt-1',
        kind: 'tool:executed',
        timestamp: 1_700_000_000_000,
        source: 'leader',
        target: 'edit',
        label: 'edit',
        data: { name: 'edit', id: 'tool-1', input: { patch }, durationMs: 5 },
      },
    ],
    'leader',
  );
  const match = /^\+(\d+) \/ −(\d+) lines$/.exec(call?.summary ?? '');
  return match ? { added: Number(match[1]), removed: Number(match[2]) } : undefined;
}

const BARE_HUNK = '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n';

describe('Office patch deltas match core countUnifiedDiffLines (F2241)', () => {
  it.each([
    ['bare hunk', BARE_HUNK],
    ['format-patch trailer', `${BARE_HUNK}-- \n2.49.0\n`],
    ['outside-hunk +/- lines', `${BARE_HUNK}-outside hunk\n+outside hunk\n`],
    ['line after a declared hunk', ['@@ -1,1 +1,1 @@', '-old', '+new', '-not part'].join('\n')],
    ['counts-less hunk header', ['@@', '-old', '+new', '+more'].join('\n')],
  ])('counts %s the way core does', (_label, patch) => {
    expect(officeCounts(patch)).toEqual(countUnifiedDiffLines(patch));
  });
});
