'use client';

/**
 * What HQ has sent, and what came of it: queued → delivered → answered. Rows
 * for other targets stay visible (a command sent a minute ago may be stuck),
 * and the toggle narrows to the current target.
 */
import { controlClientLabel } from '@hq/domain/control-format';
import type { HqClientRecord, HqCommandAuditEntry, HqSnapshot } from '@wrongstack/hq';
import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { cn } from '@/lib/cn';
import { readAudit } from './model';

const TONE: Record<string, string> = {
  muted: 'text-muted-foreground',
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-destructive',
};

export function CommandAudit({
  entries,
  error,
  clients,
  snapshot,
  targetClientId,
  highlightId,
  onRefresh,
}: {
  entries: readonly HqCommandAuditEntry[];
  error: string | null;
  clients: readonly HqClientRecord[];
  snapshot: HqSnapshot | null;
  targetClientId: string | null;
  highlightId: string | null;
  onRefresh: () => void;
}): ReactNode {
  const [onlyTarget, setOnlyTarget] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const shown = onlyTarget ? entries.filter((entry) => entry.clientId === targetClientId) : entries;
  const nameOf = (clientId: string): string => {
    const client = clients.find((candidate) => candidate.clientId === clientId);
    return client === undefined
      ? `${clientId.slice(0, 10)}… (gone)`
      : controlClientLabel(client, snapshot);
  };

  return (
    <aside aria-labelledby="command-audit-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-3">
        <h2 id="command-audit-title" className="text-sm font-semibold">
          Sent commands
        </h2>
        <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={onlyTarget}
            onChange={(event) => setOnlyTarget(event.target.checked)}
            className="size-4 accent-primary"
          />
          This target only
        </label>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh sent commands"
          className="grid size-8 place-items-center text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className="size-4" />
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          The command history could not be loaded: {error}
        </p>
      )}
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing sent yet.</p>
      ) : (
        <ol className="flex flex-col">
          {shown.map((entry) => {
            const reading = readAudit(entry, now);
            return (
              <li
                key={entry.commandId}
                data-command={entry.commandId}
                className={cn(
                  'flex flex-col gap-1 border-t border-border py-3',
                  entry.commandId === highlightId && 'bg-muted/60 px-2',
                  // Mark the selected target's rows; dimming the others with opacity
                  // pushed their muted text under the contrast floor.
                  entry.clientId === targetClientId &&
                    !onlyTarget &&
                    'border-l-2 border-l-primary pl-2',
                )}
              >
                <span className="flex items-baseline gap-2 text-sm">
                  <span className="font-medium">{entry.type}</span>
                  <span className={cn(TONE[reading.tone])}>{reading.label}</span>
                  <span
                    className="tabular ml-auto shrink-0 text-xs text-muted-foreground"
                    title={entry.enqueuedAt}
                  >
                    {relativeTime(entry.enqueuedAt, now)}
                  </span>
                </span>
                {entry.ackMessage !== undefined && entry.ackMessage !== '' && (
                  <span className="break-words text-sm text-muted-foreground">
                    {entry.ackMessage}
                  </span>
                )}
                <span className="truncate text-xs text-muted-foreground" title={entry.clientId}>
                  {nameOf(entry.clientId)} · by {entry.enqueuedBy}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}
