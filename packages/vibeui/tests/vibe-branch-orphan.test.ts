import { describe, expect, it } from 'vitest';
import { flattenVibeBranchRows } from '../src/lib/session-branch-model';

describe('flattenVibeBranchRows orphan attachment', () => {
  it('attaches orphaned branches to the resolved root when main does not exist', () => {
    const rows = flattenVibeBranchRows({
      activeBranchId: 'trunk',
      headSeq: 2,
      branches: {
        trunk: {
          id: 'trunk',
          name: 'trunk',
          parentBranchId: null,
          forkSeq: 0,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastActivityAt: '2026-01-01T00:00:00.000Z',
          status: 'active',
          turnCount: 1,
        },
        orphan: {
          id: 'orphan',
          name: 'orphan',
          parentBranchId: 'deleted-parent',
          forkSeq: 1,
          createdAt: '2026-01-01T00:01:00.000Z',
          lastActivityAt: '2026-01-01T00:01:00.000Z',
          status: 'active',
          turnCount: 1,
        },
      },
    });
    expect(rows.map((r) => [r.branch.id, r.depth])).toEqual([
      ['trunk', 0],
      ['orphan', 1],
    ]);
  });
});
