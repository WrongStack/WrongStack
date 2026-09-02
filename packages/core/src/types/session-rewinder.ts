export interface CheckpointInfo {
  promptIndex: number;
  promptPreview: string;
  ts: string;
  fileCount: number;
}

export interface RewindResult {
  revertedFiles: string[];
  errors: string[];
}

/** Extended result that also carries the promptIndex of the rewind target. */
export interface RewindResultExtended extends RewindResult {
  toPromptIndex: number;
  removedEvents: number;
}

export interface SessionRewinder {
  listCheckpoints(sessionId: string): Promise<CheckpointInfo[]>;
  rewindToCheckpoint(sessionId: string, checkpointIndex: number): Promise<RewindResultExtended>;
  rewindLastN(sessionId: string, n: number): Promise<RewindResultExtended>;
  rewindToStart(sessionId: string): Promise<RewindResultExtended>;
}
