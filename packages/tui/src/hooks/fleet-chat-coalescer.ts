/**
 * Pure per-agent tool-call aggregation for compact fleet-chat mode.
 *
 * In `compact` mode the director bridge does not emit one chat line per
 * subagent tool call; instead each call is folded into a per-agent
 * `ToolAgg` and committed as ONE summary line at the same turn
 * boundaries that flush the buffered assistant text (session end, task
 * completion, effect teardown). Kept hook-free so it is unit-testable
 * without React or a Director.
 */

export interface ToolAgg {
  /** Total tool calls in this turn. */
  total: number;
  /** Calls that reported ok === false. */
  fails: number;
  /** Sum of reported durations (calls without a duration contribute 0). */
  totalMs: number;
  /** Call count per tool name, insertion-ordered. */
  byTool: Map<string, number>;
}

export function newToolAgg(): ToolAgg {
  return { total: 0, fails: 0, totalMs: 0, byTool: new Map() };
}

export function addTool(
  agg: ToolAgg,
  name: string,
  ok?: boolean | undefined,
  durationMs?: number | undefined,
): void {
  agg.total += 1;
  if (ok === false) agg.fails += 1;
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
    agg.totalMs += durationMs;
  }
  agg.byTool.set(name, (agg.byTool.get(name) ?? 0) + 1);
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Render an aggregate as a single chat line:
 * `14 tools · grep×9 read×5 · 3.2s · 1 ✗`
 *
 * The top `maxTools` tools by count are listed; any remainder collapses
 * into `+N more`. Segments with nothing to say (no duration, no
 * failures) are omitted. Returns '' for an empty aggregate.
 */
export function formatToolSummary(agg: ToolAgg, maxTools = 4): string {
  if (agg.total === 0) return '';
  const parts: string[] = [`${agg.total} tool${agg.total === 1 ? '' : 's'}`];
  const sorted = [...agg.byTool.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted
    .slice(0, maxTools)
    .map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
  const restCount = sorted.length - maxTools;
  if (restCount > 0) top.push(`+${restCount} more`);
  if (top.length > 0) parts.push(top.join(' '));
  if (agg.totalMs > 0) parts.push(formatDuration(agg.totalMs));
  if (agg.fails > 0) parts.push(`${agg.fails} ✗`);
  return parts.join(' · ');
}
