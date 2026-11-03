import {
  DEFAULT_FAILED_RUN_RESUME_BASE_MS,
  failedRunResumeDelayMs,
  failedRunResumePrompt,
  isResumableRunFailure,
  MAX_FAILED_RUN_RESUMES,
} from '@wrongstack/contracts/types/failed-run-resume';
import type { EngineState } from './engine-state';

/**
 * A conversation's last run that failed, with the WebUI's recovery rules: Continue is always
 * offered, and in `auto` mode a run a provider killed on a recoverable error resumes by itself
 * after a growing wait, at most MAX_FAILED_RUN_RESUMES times in a row (one shared policy in
 * `@wrongstack/contracts`).
 */
export interface FailedRun {
  message: string;
  /** A provider error the provider marked recoverable (not a context overflow). */
  resumable: boolean;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** The failure the latest run ended with, while no other run has started. */
export function failedRun(state: Pick<EngineState, 'running' | 'results'>): FailedRun | null {
  const result = state.results['run.result'];
  if (state.running || result?.['status'] !== 'failed') return null;
  const error = record(result['error']);
  return {
    message: String(error['message'] ?? 'Agent run failed'),
    resumable: isResumableRunFailure('failed', {
      code: typeof error['code'] === 'string' ? error['code'] : undefined,
      recoverable: error['recoverable'] === true,
    }),
  };
}

/** The prompt Continue sends by hand. */
export const MANUAL_RESUME_PROMPT =
  'The previous run failed — continue from where it stopped and finish the remaining work.';

// Automatic resumes sent in a row per conversation; a completed run resets the count.
const resumes = new Map<string, number>();

/** The next automatic resume (1-based), or null once the budget is spent. */
export function nextAutomaticResume(sessionId: string): number | null {
  const sent = resumes.get(sessionId) ?? 0;
  return sent < MAX_FAILED_RUN_RESUMES ? sent + 1 : null;
}
export const recordAutomaticResume = (sessionId: string) =>
  void resumes.set(sessionId, (resumes.get(sessionId) ?? 0) + 1);
export const resetAutomaticResumes = (sessionId: string) => void resumes.delete(sessionId);

/** Wait before automatic resume `attempt`. */
export const automaticResumeDelayMs = (attempt: number) =>
  failedRunResumeDelayMs(attempt, DEFAULT_FAILED_RUN_RESUME_BASE_MS);

/** The prompt automatic resume `attempt` sends: numbered, with the provider's reason. */
export const automaticResumePrompt = (attempt: number, failure: FailedRun) =>
  failedRunResumePrompt(attempt, failure.message.split('\n')[0]);

export const RESUME_PAUSED_NOTICE = `Automatic resume paused: the run failed on a provider error ${
  MAX_FAILED_RUN_RESUMES + 1
} times in a row. Switch the model or add a fallback model, then press Continue.`;
