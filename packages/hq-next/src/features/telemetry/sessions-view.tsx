'use client';

/**
 * Sessions — what already ran: every session that ended, newest first, with
 * where it ran, how long, what it cost and whether it ended on its own or HQ
 * lost it (a client that vanished, which can mean a crash). Follows the
 * scope; the full figures live server-side in `session-history.jsonl`.
 */
import { fetchSessionHistory } from '@hq/data/api';
import { useHqStore } from '@hq/data/store/index';
import { formatUsd } from '@hq/lib/format';
import type { HqSessionHistoryEntry } from '@wrongstack/hq';
import { Download, History, MessageSquareText } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { plural } from '@/features/overview/model';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-text';
import { machineKeysWithLabel } from '@/lib/scope';
import { useFleetScope } from '@/lib/use-scope';
import { groupByDay, historyCsv, sessionDuration, summarizeHistory } from './session-history-model';

const POLL_MS = 30_000;

/** Save the listed sessions as CSV, built in the browser (nothing leaves HQ). */
function downloadCsv(entries: readonly HqSessionHistoryEntry[]): void {
  const url = URL.createObjectURL(
    new Blob([historyCsv(entries)], { type: 'text/csv;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `wrongstack-hq-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function SessionsView(): ReactNode {
  const scope = useFleetScope();
  const [entries, setEntries] = useState<HqSessionHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyLost, setOnlyLost] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const next = await fetchSessionHistory({
          projectId: scope.kind === 'project' ? scope.id : undefined,
          machineKey: scope.kind === 'machine' ? scope.id : undefined,
        });
        if (cancelled) return;
        setEntries(next.sessions);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [scope.kind, scope.id]);

  // A label scope is a set of machines: the server filters by one machine, so
  // the fleet's history is narrowed here.
  const snapshot = useHqStore((state) => state.snapshot);
  const scoped = useMemo(() => {
    if (entries === null || scope.kind !== 'label') return entries ?? [];
    const keys = machineKeysWithLabel(snapshot, scope.id);
    return entries.filter((entry) => keys.has(entry.machineKey));
  }, [entries, scope.kind, scope.id, snapshot]);
  const shown = useMemo(
    () => scoped.filter((entry) => !onlyLost || entry.outcome === 'lost'),
    [scoped, onlyLost],
  );
  const summary = useMemo(() => summarizeHistory(scoped), [scoped]);
  const days = useMemo(() => groupByDay(shown), [shown]);

  if (entries === null) {
    return (
      <p className={cn('p-6 text-sm', error ? 'text-destructive' : 'text-muted-foreground')}>
        {error ? `The session history could not be read: ${error}` : 'Reading the session history…'}
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-6 py-6">
      <header className="flex flex-col gap-1">
        <h2
          className="flex items-center gap-2 font-display text-2xl font-semibold"
          data-testid="sessions-headline"
        >
          <History className="size-5" />
          {summary.count === 0
            ? 'No session has ended yet'
            : `${plural(summary.count, 'session')} ended · ${formatUsd(summary.costUsd)}`}
        </h2>
        <p className="text-base text-muted-foreground">
          {summary.count === 0
            ? 'Sessions appear here once they finish, with where they ran, how long, and what they cost.'
            : `${plural(summary.toolCalls, 'tool call')}. ${
                summary.lost === 0
                  ? 'Every one ended on its own.'
                  : `${plural(summary.lost, 'session')} stopped reporting without ending — the client may have crashed or lost its network.`
              }`}
        </p>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            The last refresh failed: {error}. Showing what was loaded before.
          </p>
        )}
        {shown.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => downloadCsv(shown)}
              className="inline-flex h-9 items-center gap-2 border border-border px-3 text-sm hover:bg-muted"
            >
              <Download className="size-4" />
              Download {shown.length === 1 ? 'this session' : `these ${shown.length} sessions`} as
              CSV
            </button>
          </div>
        )}
      </header>

      {summary.lost > 0 && (
        <label className="flex w-fit items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyLost}
            onChange={(event) => setOnlyLost(event.target.checked)}
          />
          Only sessions HQ lost
        </label>
      )}

      {days.map((group) => (
        <section key={group.day} className="flex flex-col gap-2" aria-label={group.day}>
          <h3 className="text-sm font-semibold">{group.day}</h3>
          <div className="overflow-x-auto border border-border">
            <table className="w-full min-w-[44rem] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="px-3 py-1.5 font-normal">Ended</th>
                  <th className="px-3 py-1.5 font-normal">Project</th>
                  <th className="px-3 py-1.5 font-normal">Machine</th>
                  <th className="px-3 py-1.5 text-right font-normal">Ran</th>
                  <th className="px-3 py-1.5 text-right font-normal">Cost</th>
                  <th className="px-3 py-1.5 text-right font-normal">Tools</th>
                  <th className="px-3 py-1.5 font-normal">Models</th>
                  <th className="px-3 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {group.entries.map((entry) => (
                  <tr
                    key={`${entry.sessionId}:${entry.endedAt}`}
                    data-history-session={entry.sessionId}
                    className="border-t border-border"
                  >
                    <td className="whitespace-nowrap px-3 py-1.5">
                      {new Date(entry.endedAt).toLocaleTimeString(undefined, {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                      {entry.outcome === 'lost' && (
                        <span
                          className="ml-2 text-xs text-warning"
                          title="The client stopped reporting without ending the session"
                        >
                          lost
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {entry.projectName}
                      {entry.gitBranch && (
                        <span className="ml-1 font-mono text-xs text-muted-foreground">
                          {entry.gitBranch}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5">
                      {entry.hostname ?? entry.machineKey.replace(/^(host|mid):/, '')}
                    </td>
                    <td className="tabular px-3 py-1.5 text-right">{sessionDuration(entry)}</td>
                    <td className="tabular px-3 py-1.5 text-right">{formatUsd(entry.costUsd)}</td>
                    <td className="tabular px-3 py-1.5 text-right">{entry.toolCalls}</td>
                    <td
                      className="max-w-48 truncate px-3 py-1.5 font-mono text-xs"
                      title={entry.models.join(', ')}
                    >
                      {entry.models.join(', ') || '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      <Link
                        href={`/fleet/console/?session=${encodeURIComponent(entry.sessionId)}`}
                        aria-label={`Open the transcript of ${entry.projectName} on ${entry.hostname ?? entry.machineKey}`}
                        className="inline-grid size-8 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <MessageSquareText className="size-4" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
