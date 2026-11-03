import { Wrench } from 'lucide-react';
import { formatTokens, type TurnStats } from './context-usage';
import type { EngineEvent } from './engine-state';
import { SessionActivity } from './SessionActivity';
import { turnToolSummary } from './turn-tools';
import './session-status.css';

/**
 * The tool work of one finished turn, kept with the answer it led to: what the turn took
 * (iterations, tokens) and a one-line summary that opens the same activity view the live run
 * shows.
 */
export function TurnTools({
  events,
  stats,
  onOpenFile,
}: {
  events: readonly EngineEvent[];
  stats?: TurnStats | undefined;
  onOpenFile: (path: string) => void;
}) {
  const summary = turnToolSummary(events);
  const meta = stats ? turnMeta(stats) : '';
  if (summary.calls === 0 && !meta) return null;
  return (
    <>
      {meta && <p className="chat-turn-meta">{meta}</p>}
      {summary.calls > 0 && (
        <details className="chat-run-activity turn-tools">
          <summary>
            <Wrench size={12} /> Worked with {summary.calls}{' '}
            {summary.calls === 1 ? 'tool call' : 'tool calls'}
            {summary.failed ? ` · ${summary.failed} failed` : ''} · {summary.text}
          </summary>
          <SessionActivity compact events={events} onOpenFile={onOpenFile} />
        </details>
      )}
    </>
  );
}
function turnMeta(stats: TurnStats): string {
  const parts: string[] = [];
  if (stats.iterations)
    parts.push(`${stats.iterations} ${stats.iterations === 1 ? 'iteration' : 'iterations'}`);
  if (stats.prompt) parts.push(`${formatTokens(stats.prompt)} prompt tokens`);
  if (stats.output) parts.push(`${formatTokens(stats.output)} output`);
  if (stats.prompt && stats.cacheRead)
    parts.push(`${Math.round((stats.cacheRead / stats.prompt) * 100)}% from cache`);
  return parts.join(' · ');
}
/**
 * The running turn's work, open while it runs: every tool call so far, grouped by tool in the
 * summary, with thinking and retries in order.
 */
export function LiveRunActivity({
  events,
  onOpenFile,
}: {
  events: readonly EngineEvent[];
  onOpenFile: (path: string) => void;
}) {
  if (!events.length) return null;
  const summary = turnToolSummary(events);
  const calls = new Set(
    events
      .filter((event) => event.type === 'tool.started' || event.type === 'tool.executed')
      .map((event) => event.payload['id'])
      .filter((id) => typeof id === 'string'),
  ).size;
  return (
    <details className="chat-run-activity" open>
      <summary>
        <Wrench size={12} /> Run activity
        {calls ? ` · ${calls} ${calls === 1 ? 'tool call' : 'tool calls'}` : ''}
        {summary.failed ? ` · ${summary.failed} failed` : ''}
        {summary.text ? ` · ${summary.text}` : ''}
      </summary>
      <SessionActivity compact events={events} onOpenFile={onOpenFile} />
    </details>
  );
}
