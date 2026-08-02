import { createHash } from 'node:crypto';

export const WORKSPACE_SNAPSHOT_FENCE_SCHEMA_VERSION = 1 as const;

export interface WorkspaceSnapshotFenceDescriptor {
  readonly schemaVersion: typeof WORKSPACE_SNAPSHOT_FENCE_SCHEMA_VERSION;
  readonly snapshotId: string;
  readonly projectId: string;
  readonly revision: number;
  readonly manifestHash: string;
  readonly capturedAt: string;
}

export type RecordWorkspaceSnapshotResult =
  | { readonly recorded: true; readonly snapshot: WorkspaceSnapshotFenceDescriptor }
  | {
      readonly recorded: false;
      readonly code: 'workspace_snapshot_invalid';
      readonly message: string;
    };

export function workspaceSnapshotFenceId(
  projectId: string,
  revision: number,
  manifestHash: string,
  capturedAt: string,
): string {
  return createHash('sha256')
    .update(
      `wrongstack-workspace-snapshot-fence-v1\0${projectId}\0${revision}\0${manifestHash}\0${capturedAt}`,
      'utf8',
    )
    .digest('hex');
}

export function isWorkspaceSnapshotFenceDescriptorValid(
  snapshot: WorkspaceSnapshotFenceDescriptor,
): boolean {
  return (
    snapshot.schemaVersion === WORKSPACE_SNAPSHOT_FENCE_SCHEMA_VERSION &&
    /^[a-f0-9]{64}$/u.test(snapshot.snapshotId) &&
    snapshot.projectId.trim().length > 0 &&
    snapshot.projectId.length <= 512 &&
    Number.isSafeInteger(snapshot.revision) &&
    snapshot.revision > 0 &&
    /^[a-f0-9]{64}$/u.test(snapshot.manifestHash) &&
    Number.isSafeInteger(Date.parse(snapshot.capturedAt)) &&
    workspaceSnapshotFenceId(
      snapshot.projectId,
      snapshot.revision,
      snapshot.manifestHash,
      snapshot.capturedAt,
    ) === snapshot.snapshotId
  );
}
