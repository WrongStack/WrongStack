import { describe, expect, it } from 'vitest';
import { isWorkspaceSnapshotFenceDescriptorValid } from '../src/workspace-snapshot-fence.js';

describe('isWorkspaceSnapshotFenceDescriptorValid null/type guard (F2246)', () => {
  it('returns false instead of throwing on null or non-string fields', () => {
    expect(
      isWorkspaceSnapshotFenceDescriptorValid(
        null as unknown as Parameters<typeof isWorkspaceSnapshotFenceDescriptorValid>[0],
      ),
    ).toBe(false);
    expect(
      isWorkspaceSnapshotFenceDescriptorValid({
        schemaVersion: 1,
        snapshotId: 'a'.repeat(64),
        projectId: 123 as unknown as string,
        revision: 1,
        manifestHash: 'b'.repeat(64),
        capturedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toBe(false);
  });
});
