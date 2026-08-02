import type { WorkspaceCheckpointRef, WorkspaceMaterializationResult } from '../types/session.js';
import type { SessionCheckpointCas } from './session-checkpoint-cas.js';

function requiredCheckpointCas(
  checkpointCas: SessionCheckpointCas | undefined,
  operation: 'capture' | 'materialization',
): SessionCheckpointCas {
  if (!checkpointCas) {
    throw new Error(`Workspace checkpoint ${operation} requires a projectRoot-aware session store`);
  }
  return checkpointCas;
}

export function captureCheckpoint(
  checkpointCas: SessionCheckpointCas | undefined,
  sessionId: string,
  promptIndex: number,
): Promise<WorkspaceCheckpointRef | undefined> {
  return requiredCheckpointCas(checkpointCas, 'capture').capture(sessionId, promptIndex);
}

export function materializeCheckpoint(
  checkpointCas: SessionCheckpointCas | undefined,
  checkpoint: WorkspaceCheckpointRef,
  targetRoot: string,
): Promise<WorkspaceMaterializationResult> {
  return requiredCheckpointCas(checkpointCas, 'materialization').materialize(
    checkpoint,
    targetRoot,
  );
}
