import { Wrench } from 'lucide-react';
import type { EngineEvent } from './engine-state';
import { SessionActivity } from './SessionActivity';
import { turnToolSummary } from './turn-tools';

/**
 * The tool work of one finished turn, kept with the answer it led to: a one-line summary that
 * opens the same activity view the live run shows.
 */
export function TurnTools({
  events,
  onOpenFile,
}: {
  events: readonly EngineEvent[];
  onOpenFile: (path: string) => void;
}) {
  const summary = turnToolSummary(events);
  if (summary.calls === 0) return null;
  return (
    <details className="chat-run-activity turn-tools">
      <summary>
        <Wrench size={12} /> Worked with {summary.calls}{' '}
        {summary.calls === 1 ? 'tool call' : 'tool calls'}
        {summary.failed ? ` · ${summary.failed} failed` : ''} · {summary.text}
      </summary>
      <SessionActivity compact events={events} onOpenFile={onOpenFile} />
    </details>
  );
}
