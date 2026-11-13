import type { SessionEvent, WorkspaceCheckpointRef } from '@wrongstack/contracts/types/session';
import { describe, expect, it } from 'vitest';
import {
  getSessionTreeSnapshot,
  reconstructSessionTree,
} from '../../src/storage/session-store/tree-replay.js';

function checkpointRef(digit: string): WorkspaceCheckpointRef {
  return {
    manifestHash: digit.repeat(64),
    baseHead: 'a'.repeat(40),
    entryCount: 1,
    unresolvedCount: 0,
    capturedAt: '2026-11-14T00:00:00.000Z',
    coverage: 'git-head-plus-dirty',
  };
}

describe('SessionTreeTracker workspace_checkpoint replay', () => {
  it('populates main baseWorkspaceCheckpoint and per-branch latestWorkspaceCheckpoint from workspace_checkpoint events', () => {
    const m0 = checkpointRef('1');
    const m1 = checkpointRef('2');
    const f1 = checkpointRef('3');

    const events: SessionEvent[] = [
      {
        type: 'checkpoint',
        ts: '2026-11-13T00:00:00.000Z',
        promptIndex: 0,
        promptPreview: 'p0',
        seq: 0,
      },
      {
        type: 'workspace_checkpoint',
        ts: '2026-11-13T00:00:00.050Z',
        promptIndex: 0,
        workspaceCheckpoint: m0,
        seq: 1,
      },
      {
        type: 'checkpoint',
        ts: '2026-11-13T00:01:00.000Z',
        promptIndex: 1,
        promptPreview: 'p1',
        seq: 2,
      },
      {
        type: 'workspace_checkpoint',
        ts: '2026-11-13T00:01:00.050Z',
        promptIndex: 1,
        workspaceCheckpoint: m1,
        seq: 3,
      },
      {
        type: 'branch_created',
        ts: '2026-11-13T00:02:00.000Z',
        newBranchId: 'br-feat',
        name: 'feat',
        parentBranchId: 'main',
        forkSeq: 3,
        baseWorkspaceCheckpoint: m1,
        seq: 4,
      },
      {
        type: 'workspace_checkpoint',
        ts: '2026-11-13T00:03:00.000Z',
        promptIndex: 2,
        workspaceCheckpoint: f1,
        branchId: 'br-feat',
        seq: 5,
      },
    ];

    const replayed = reconstructSessionTree(events, { sessionId: 'sess-ws-cp' });
    expect(replayed.tree.branches['main']?.baseWorkspaceCheckpoint).toEqual(m0);
    expect(replayed.tree.branches['main']?.latestWorkspaceCheckpoint).toEqual(m1);
    expect(replayed.tree.branches['br-feat']?.baseWorkspaceCheckpoint).toEqual(m1);
    expect(replayed.tree.branches['br-feat']?.latestWorkspaceCheckpoint).toEqual(f1);

    const unbranchedSnapshot = getSessionTreeSnapshot({
      metadata: { id: 'sess-unbranched' } as never,
      events: events.slice(0, 2),
    });
    expect(unbranchedSnapshot.branches['main']?.baseWorkspaceCheckpoint).toEqual(m0);
    expect(unbranchedSnapshot.branches['main']?.latestWorkspaceCheckpoint).toEqual(m0);
  });
});
