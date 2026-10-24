import type { WrongStackError } from './errors.js';

/** Outcome of one `Agent.run()` call, handed to after-run hooks and hosts. */
export interface RunResult {
  status: 'done' | 'failed' | 'max_iterations' | 'aborted';
  error?: WrongStackError | undefined;
  finalText?: string | undefined;
  iterations: number;
  delegateSummaries?: Array<{ summary: string | undefined; ok: boolean }>;
  /** Human-readable reason for abort (e.g. "user interrupt", "tool timeout", "stream hang"). */
  abortReason?: string | undefined;
}
