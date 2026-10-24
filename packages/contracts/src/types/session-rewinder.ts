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
  /**
   * The text of the prompt the rewind took back (the `user_input` recorded
   * just before the target checkpoint), so a surface can hand it back to the
   * user to edit and send again. Absent when the journal has none.
   */
  promptText?: string | undefined;
}

export interface SessionRewinder {
  listCheckpoints(sessionId: string): Promise<CheckpointInfo[]>;
  rewindToCheckpoint(sessionId: string, checkpointIndex: number): Promise<RewindResultExtended>;
  rewindLastN(sessionId: string, n: number): Promise<RewindResultExtended>;
  rewindToStart(sessionId: string): Promise<RewindResultExtended>;
}
