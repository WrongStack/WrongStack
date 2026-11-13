import type { SessionEvent } from '@wrongstack/contracts';
import { describe, expect, it } from 'vitest';
import {
  getSessionTreeSnapshot,
  reconstructSessionTree,
} from '../../src/storage/session-store/tree-replay.js';

describe('SessionTreeTracker workspace_checkpoint replay', () => {
  it('populates main baseWorkspaceCheckpoint and per-branch latestWorkspaceCheckpoint from workspace_checkpoint events', () => {
    const m0 = { manifestHash: '1'.repeat(64), dirtyCount: 1, untrackedCount: 0 };
    const m1 = { manifestHash: '2'.repeat(64), dirtyCount: 2, untrackedCount: 1 };
    const f1 = { manifestHash: '3'.repeat(64), dirtyCount: 0, untrackedCount: 3 };

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
        switched: true,
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
