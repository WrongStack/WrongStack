/**
 * Compact, human-readable fleet / delegate lines for TUI chat history.
 *
 * Goals:
 * - One short scan line (no raw `Budget exceeded: timeout (limit=…)` dumps)
 * - Duration that reads as 12s / 2m 51s rather than 171s
 * - Delegate start shows a tight task preview, not a paragraph
 */

/** Format a duration for a history chip. */
export function formatHistoryDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (ms < 3_600_000) return s === 0 ? `${m}m` : `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM === 0 ? `${h}h` : `${h}h ${remM}m`;
}

/** Collapse whitespace and hard-cap a task/description for a single history line. */
export function shortenTaskPreview(task: string, maxChars = 56): string {
  const oneLine = task.replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  if (oneLine.length <= maxChars) return oneLine;
  return `${oneLine.slice(0, Math.max(1, maxChars - 1))}…`;
}

interface SubagentCompletionLike {
  status: string;
  iterations: number;
  toolCalls: number;
  durationMs: number;
  error?:
    | {
        kind?: string | undefined;
        message?: string | undefined;
      }
    | undefined;
}

/**
 * One-line outcome for `subagent.task_completed` (and similar).
 *
 * Known budget/timeout kinds drop the raw engine message — the kind + stats
 * are enough. Unknown failures keep a short message tail when useful.
 */
export function formatSubagentCompletionText(e: SubagentCompletionLike): string {
  const stats = `${e.iterations} iter · ${e.toolCalls} tools · ${formatHistoryDuration(e.durationMs)}`;
  const kind = e.error?.kind ?? '';

  if (e.status === 'success') return `done · ${stats}`;

  if (e.status === 'timeout' || kind === 'budget_timeout') {
    return `timed out · ${stats}`;
  }
  if (kind === 'budget_iterations') return `hit iteration budget · ${stats}`;
  if (kind === 'budget_tool_calls') return `hit tool-call budget · ${stats}`;
  if (kind === 'budget_tokens') return `hit token budget · ${stats}`;
  if (kind === 'budget_cost') return `hit cost budget · ${stats}`;
  if (kind.startsWith('budget_')) {
    return `budget hit · ${stats}`;
  }
  if (e.status === 'stopped' || kind === 'aborted_by_parent') {
    return `stopped · ${stats}`;
  }

  const raw = (e.error?.message ?? '').replace(/\s+/g, ' ').trim();
  // Engine budget dumps are noise once we've already labeled the outcome.
  if (!raw || /^Budget exceeded:/i.test(raw) || /^subagent stopped:/i.test(raw)) {
    return `failed · ${stats}`;
  }
  const tail = raw.length > 72 ? `${raw.slice(0, 71)}…` : raw;
  return `failed · ${stats} — ${tail}`;
}

/**
 * Compact `delegate.started` body. Label already carries the role; this is
 * just the task preview (or a bare "started" when the task is empty).
 */
export function formatDelegateStartedText(task: string): string {
  const preview = shortenTaskPreview(task, 56);
  return preview || 'started';
}

/**
 * Compact `delegate.completed` body for success. Failures are left to
 * `subagent.task_completed` so history doesn't print the same death twice.
 */
export function formatDelegateSuccessText(input: {
  summary?: string | undefined;
  iterations: number;
  toolCalls: number;
  durationMs: number;
}): string {
  const stats = `${input.iterations} iter · ${input.toolCalls} tools · ${formatHistoryDuration(input.durationMs)}`;
  // buildDelegateSummary is like: `[critic] done in 12s (3 iter, 5 tools) — preview…`
  // Prefer a short report preview when present; otherwise just "done · stats".
  const summary = (input.summary ?? '').replace(/\s+/g, ' ').trim();
  const previewMatch = summary.match(/—\s+(.+)$/);
  const preview = previewMatch?.[1]?.trim();
  if (preview) {
    const short = shortenTaskPreview(preview, 48);
    return `done · ${stats} — ${short}`;
  }
  return `done · ${stats}`;
}
