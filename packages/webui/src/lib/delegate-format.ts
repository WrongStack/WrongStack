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
  const limit = Number.isFinite(max) ? Math.floor(max) : 180;
  if (limit <= 0) return '';
  if (line.length <= limit) return line;
  if (limit === 1) return '…';
  let end = limit - 1;
  if (end > 0) {
    const code = line.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return `${line.slice(0, end)}…`;
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
  const seconds = Number.isFinite(input.durationMs)
    ? Math.max(0, Math.round(input.durationMs / 100) / 10)
    : 0;
  const cost =
    typeof input.costUsd === 'number' && Number.isFinite(input.costUsd) && input.costUsd > 0
      ? ` · $${input.costUsd.toFixed(4)}`
      : '';
  const iterations = Number.isFinite(input.iterations)
    ? Math.max(0, Math.floor(input.iterations))
    : 0;
  const toolCalls = Number.isFinite(input.toolCalls) ? Math.max(0, Math.floor(input.toolCalls)) : 0;
  return [
    `Delegate ${input.ok ? 'completed' : 'failed'} for \`${input.target}\`${
      input.status ? ` (${input.status})` : ''
    }.`,
    input.summary,
    `${iterations} iteration(s), ${toolCalls} tool call(s), ${seconds}s${cost}`,
  ].join('\n');
}
