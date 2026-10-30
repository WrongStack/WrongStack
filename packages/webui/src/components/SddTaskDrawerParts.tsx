import { Activity, FileText, Terminal } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { statusStyle } from '@/lib/sdd-theme';
import { cn } from '@/lib/utils';
import type { BoardTaskItem, SddBoardFeedEntry } from '@/stores';

export function TaskEventLog({
  events,
  expanded,
}: {
  events: SddBoardFeedEntry[];
  expanded?: boolean;
}) {
  const { t } = useAppTranslation();
  // Task events are bounded (per task), show all without pagination.
  return (
    <section
      className={cn(
        'rounded-lg border border-border/70 bg-background/45',
        expanded && 'sm:col-span-2',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
        <Activity className="h-4 w-4 text-primary" />
        <h4 className="text-xs font-semibold text-foreground">{t('activity:sddTask.eventLog')}</h4>
        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
          {events.length}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {t('activity:sddTask.newestFirst')}
        </span>
      </div>

      {events.length === 0 ? (
        <p className="px-3 py-5 text-center text-[11px] text-muted-foreground">
          {t('activity:sddTask.noEvents')}
        </p>
      ) : (
        <div
          className={cn(
            'divide-y divide-border/45 overflow-auto',
            expanded ? 'max-h-[32rem]' : 'max-h-72',
          )}
        >
          {events.map((event, index) => {
            const isFile = event.kind === 'file';
            const isTool = event.kind === 'tool';
            const failed =
              event.ok === false || event.kind === 'failed' || event.kind === 'verification_failed';
            const Icon = isFile ? FileText : isTool ? Terminal : Activity;
            return (
              <div
                key={`${event.ts}-${event.kind}-${index}`}
                className={cn(
                  'grid grid-cols-[4.75rem_1rem_minmax(0,1fr)] gap-2 px-3 py-2.5 text-[11px]',
                  failed && 'bg-destructive/[0.035]',
                )}
              >
                <time
                  dateTime={new Date(event.ts).toISOString()}
                  className="font-mono text-[10px] text-muted-foreground"
                  title={new Date(event.ts).toLocaleString()}
                >
                  {new Date(event.ts).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </time>
                <Icon
                  className={cn(
                    'mt-0.5 h-3.5 w-3.5',
                    failed
                      ? 'text-destructive'
                      : isFile
                        ? 'text-info'
                        : isTool
                          ? 'text-warning'
                          : 'text-primary',
                  )}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {event.action && (
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground">
                        {event.action}
                      </span>
                    )}
                    {event.agentName && (
                      <span className="text-[10px] text-muted-foreground">{event.agentName}</span>
                    )}
                    {event.durationMs !== undefined && (
                      <span className="text-[10px] text-muted-foreground">
                        {event.durationMs < 1000
                          ? `${Math.round(event.durationMs)}ms`
                          : `${(event.durationMs / 1000).toFixed(1)}s`}
                      </span>
                    )}
                  </div>
                  {event.filePath ? (
                    <code className="mt-1 block break-all font-mono text-[10px] leading-relaxed text-foreground">
                      {event.filePath}
                    </code>
                  ) : event.detail ? (
                    <code className="mt-1 block break-words font-mono text-[10px] leading-relaxed text-muted-foreground">
                      {event.detail}
                    </code>
                  ) : (
                    <p className="mt-1 break-words leading-relaxed text-foreground">{event.text}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function Meta({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div
      className={cn('rounded-md border border-border bg-muted/50 px-2 py-1', full && 'col-span-2')}
    >
      <div className="text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-foreground">{children}</div>
    </div>
  );
}

export function DepList({
  title,
  shortIds,
  byShort,
  onSelectTask,
}: {
  title: string;
  shortIds: string[];
  byShort: Map<string, BoardTaskItem>;
  onSelectTask: (id: string) => void;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="flex flex-wrap gap-1">
        {shortIds.map((sid) => {
          const dep = byShort.get(sid);
          return (
            <button
              key={sid}
              type="button"
              disabled={!dep}
              onClick={() => dep && onSelectTask(dep.id)}
              className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] text-foreground hover:bg-muted disabled:opacity-50"
              title={dep?.title}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  statusStyle(dep?.displayStatus ?? 'pending').dot,
                )}
              />
              <span className="font-mono">{sid}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
