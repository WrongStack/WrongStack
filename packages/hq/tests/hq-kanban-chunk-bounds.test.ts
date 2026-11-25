import { describe, expect, it } from 'vitest';
import { isHqKanbanSnapshotPayload } from '../src/protocol/kanban.js';

describe('isHqKanbanSnapshotPayload chunk bounds', () => {
  it('rejects chunkCount < 1 and chunkIndex >= chunkCount', () => {
    const base = {
      projectId: 'proj-1',
      generatedAt: '2026-01-01T00:00:00.000Z',
      boards: [],
      tombstones: [],
    };
    expect(isHqKanbanSnapshotPayload({ ...base, chunkIndex: 0, chunkCount: 0 })).toBe(false);
    expect(isHqKanbanSnapshotPayload({ ...base, chunkIndex: 2, chunkCount: 2 })).toBe(false);
    expect(isHqKanbanSnapshotPayload({ ...base, chunkIndex: 1, chunkCount: 2 })).toBe(true);
  });
});
