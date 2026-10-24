/**
 * Per-iteration phase emitted via `onStage` so UIs can render the
 * engine's live location in the sense-decide-execute-reflect loop.
 */
export type IterationStage =
  | { phase: 'idle' }
  | { phase: 'decide'; reason: string }
  | { phase: 'execute'; task: string }
  | {
      phase: 'reflect';
      status: 'success' | 'failure' | 'aborted' | 'skipped';
      note?: string | undefined;
    }
  | { phase: 'sleep'; ms: number }
  | { phase: 'paused' }
  | { phase: 'stopped' }
  | { phase: 'error'; message: string };

export type ParallelIterationStage =
  | { phase: 'idle' }
  | { phase: 'decompose' }
  | { phase: 'fanout'; slots: number }
  | { phase: 'await'; taskIds: string[] }
  | {
      phase: 'aggregate';
      successCount: number;
      total: number;
      goalComplete: boolean;
    }
  | { phase: 'sleep'; ms: number }
  | { phase: 'stopped' }
  | { phase: 'error'; message: string };

/** Union of serial and parallel autonomy engine stage types (from EternalAutonomyEngine / ParallelEternalEngine). */
export type AutonomyStage = IterationStage | ParallelIterationStage;
