import type { SessionMarkerDetail } from '@wrongstack/core/types';

/**
 * The chat text of a delegation, for the live handler AND for replay.
 *
 * Two callers build these lines: `session-execution-handlers` when the
 * `delegate.started` / `delegate.completed` frames arrive, and
 * `session-replay-handlers` when the same delegation comes back from the
 * journal as a marker. They must produce the same bubble, or a resumed session
 * shows a delegation that reads differently from the one that was on screen —
 * so the wording lives here rather than in either caller.
 */

/** Trim a single-line preview, matching the live handler's 180-char budget. */
export function truncateDelegateTask(text: string, max = 180): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function delegateStartedText(target: string, task: string): string {
  return `Delegating to \`${target}\`: ${truncateDelegateTask(task)}`;
}

export function delegateCompletedText(input: {
  target: string;
  ok: boolean;
  status?: string | undefined;
  summary: string;
  durationMs: number;
  iterations: number;
  toolCalls: number;
  costUsd?: number | undefined;
}): string {
  const seconds = Math.max(0, Math.round(input.durationMs / 100) / 10);
  const cost =
    typeof input.costUsd === 'number' && input.costUsd > 0 ? ` · $${input.costUsd.toFixed(4)}` : '';
  return [
    `Delegate ${input.ok ? 'completed' : 'failed'} for \`${input.target}\`${
      input.status ? ` (${input.status})` : ''
    }.`,
    input.summary,
    `${input.iterations} iteration(s), ${input.toolCalls} tool call(s), ${seconds}s${cost}`,
  ].join('\n');
}

/**
 * Render a replayed delegate marker as the chat bubble it was live, or `null`
 * when the marker is not a delegation.
 */
export function delegateMarkerText(
  detail: SessionMarkerDetail | undefined,
): { content: string; isError?: boolean | undefined } | null {
  if (detail?.kind === 'delegate_started') {
    // No `isError` at all — `handleDelegateStarted` does not set the key, and
    // a replayed bubble that carries `false` where the live one carried
    // nothing is a difference the parity test (rightly) refuses.
    return { content: delegateStartedText(detail.target, detail.task) };
  }
  if (detail?.kind === 'delegate_completed') {
    return { content: delegateCompletedText(detail), isError: !detail.ok };
  }
  return null;
}
