import type { TFunction } from 'i18next';
import { LoaderCircle, Wrench } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatTokens, type TurnStats } from './context-usage';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
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
  command,
}: {
  events: readonly EngineEvent[];
  stats?: TurnStats | undefined;
  onOpenFile: (path: string) => void;
  command?: EngineCommand | undefined;
}) {
  const { t } = useDesktopText();
  const summary = turnToolSummary(events);
  const meta = stats ? turnMeta(stats, t) : '';
  if (summary.calls === 0 && !meta) return null;
  return (
    <>
      {meta && <p className="chat-turn-meta">{meta}</p>}
      {summary.calls > 0 && (
        <details className="chat-run-activity turn-tools">
          <summary>
            <Wrench size={12} /> {t('turn.workedWith', { calls: toolCalls(summary.calls, t) })}
            {summary.failed ? ` · ${t('turn.failed', { count: summary.failed })}` : ''} ·{' '}
            {summary.text}
          </summary>
          <SessionActivity compact events={events} onOpenFile={onOpenFile} command={command} />
        </details>
      )}
    </>
  );
}
function toolCalls(count: number, t: TFunction<'desktop'>): string {
  return t(count === 1 ? 'turn.toolCall' : 'turn.toolCalls', { count });
}
function turnMeta(stats: TurnStats, t: TFunction<'desktop'>): string {
  const parts: string[] = [];
  if (stats.iterations)
    parts.push(
      t(stats.iterations === 1 ? 'turn.iteration' : 'turn.iterations', {
        count: stats.iterations,
      }),
    );
  if (stats.prompt) parts.push(t('turn.promptTokens', { tokens: formatTokens(stats.prompt) }));
  if (stats.output) parts.push(t('turn.output', { tokens: formatTokens(stats.output) }));
  if (stats.prompt && stats.cacheRead)
    parts.push(t('turn.cache', { percent: Math.round((stats.cacheRead / stats.prompt) * 100) }));
  if (stats.durationMs !== undefined) parts.push(formatDuration(stats.durationMs));
  return parts.join(' · ');
}
/** "42 s", "3 min 05 s", "1 h 02 min". */
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}
/** The running turn's line under the conversation, with how long it has been running. */
export function AgentWorking({
  waiting,
  since,
}: {
  /** The turn waits for answers to its questions. */
  waiting: boolean;
  /** When the turn's first iteration started; unknown in journals without frame times. */
  since: number | null;
}) {
  const { t } = useDesktopText();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return (
    <div className="agent-working">
      <LoaderCircle size={13} className="spin" />
      {waiting ? t('working.waiting') : t('working.busy')}
      {since ? <span className="agent-working-elapsed"> {formatDuration(now - since)}</span> : null}
    </div>
  );
}
/**
 * The running turn's work, open while it runs: every tool call so far, grouped by tool in the
 * summary, with thinking and retries in order.
 */
export function LiveRunActivity({
  events,
  onOpenFile,
  command,
}: {
  events: readonly EngineEvent[];
  onOpenFile: (path: string) => void;
  command?: EngineCommand | undefined;
}) {
  const { t } = useDesktopText();
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
        <Wrench size={12} /> {t('turn.activity')}
        {calls ? ` · ${toolCalls(calls, t)}` : ''}
        {summary.failed ? ` · ${t('turn.failed', { count: summary.failed })}` : ''}
        {summary.text ? ` · ${summary.text}` : ''}
      </summary>
      <SessionActivity compact events={events} onOpenFile={onOpenFile} command={command} />
    </details>
  );
}
