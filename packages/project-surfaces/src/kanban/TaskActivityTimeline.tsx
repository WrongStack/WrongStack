import type { KanbanEvent, KanbanTask } from '@wrongstack/kanban';
import { Activity, Check, Copy, Download, RefreshCw, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useAppTranslation } from '../lib/i18n';
import { usePagination } from '../lib/usePagination';
import { cn } from '../lib/utils';
import { Pagination } from '../ui/pagination';
import type { TaskActivityFilter } from './task-activity-model';
import {
  activityCategory,
  activityTone,
  buildTaskActivity,
  buildTaskActivityExport,
  compactValue,
  eventDescription,
  eventFieldChanges,
  eventTitle,
  formatTimestamp,
  record,
  text,
} from './task-activity-model';

export {
  activityCategory,
  buildTaskActivity,
  buildTaskActivityExport,
  eventFieldChanges,
} from './task-activity-model';

interface TaskActivityTimelineProps {
  task: KanbanTask;
  events: KanbanEvent[];
  sessionId?: string | undefined;
  loading?: boolean | undefined;
  error?: string | null | undefined;
  onRefresh?: (() => void) | undefined;
}

function RoutingBadges({ event }: { event: KanbanEvent }) {
  const after = record(event.after);
  const provider = text(after['provider']);
  const model = text(after['model']);
  const routing = text(after['modelRouting']);
  const profile = text(after['fallbackProfile']);
  const fallbacks = Array.isArray(after['fallbackModels'])
    ? after['fallbackModels'].filter((value): value is string => typeof value === 'string')
    : [];
  const attempt = typeof after['attempt'] === 'number' ? after['attempt'] : undefined;
  const maxAttempts = typeof after['maxAttempts'] === 'number' ? after['maxAttempts'] : undefined;
  const status = text(after['status']);
  if (
    !provider &&
    !model &&
    !routing &&
    !profile &&
    !fallbacks.length &&
    attempt === undefined &&
    !status
  )
    return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-[9px] text-muted-foreground">
      {status && (
        <span className="rounded border border-border/60 px-1.5 py-0.5">status:{status}</span>
      )}
      {routing && (
        <span className="rounded border border-border/60 px-1.5 py-0.5">route:{routing}</span>
      )}
      {(provider || model) && (
        <span className="rounded border border-border/60 px-1.5 py-0.5">
          model:{provider ? `${provider}/` : ''}
          {model ?? 'default'}
        </span>
      )}
      {profile && (
        <span className="rounded border border-border/60 px-1.5 py-0.5">profile:{profile}</span>
      )}
      {fallbacks.map((fallback, index) => (
        <span
          key={`${fallback}:${index}`}
          className="rounded border border-border/60 px-1.5 py-0.5"
        >
          fallback-{index + 1}:{fallback}
        </span>
      ))}
      {attempt !== undefined && (
        <span className="rounded border border-border/60 px-1.5 py-0.5">
          attempt:{attempt}
          {maxAttempts ? `/${maxAttempts}` : ''}
        </span>
      )}
    </div>
  );
}

export function TaskActivityTimeline({
  task,
  events,
  sessionId,
  loading = false,
  error,
  onRefresh,
}: TaskActivityTimelineProps) {
  const { t } = useAppTranslation();
  const [filter, setFilter] = useState<TaskActivityFilter>('all');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const activity = useMemo(
    () => buildTaskActivity(task, events, sessionId),
    [task, events, sessionId],
  );
  const counts = useMemo(
    () => ({
      all: activity.length,
      execution: activity.filter((event) => activityCategory(event) === 'execution').length,
      changes: activity.filter((event) => activityCategory(event) === 'changes').length,
      notes: activity.filter((event) => activityCategory(event) === 'notes').length,
      failures: activity.filter((event) => activityCategory(event) === 'failures').length,
    }),
    [activity],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return activity.filter((event) => {
      if (filter !== 'all' && activityCategory(event) !== filter) return false;
      if (!needle) return true;
      return [
        eventTitle(event),
        eventTitle(event, t),
        event.type,
        event.actor,
        event.sessionId,
        event.subagentId,
        event.runTaskId,
        event.note,
        JSON.stringify(event.before),
        JSON.stringify(event.after),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(needle);
    });
  }, [activity, filter, query, t]);
  const activityPage = usePagination(visible, 50, `${filter}:${query}`);
  const displayed = activityPage.pageItems;
  const actors = [...new Set(activity.map((event) => event.actor).filter(Boolean))].length;
  const sessions = [
    ...new Set(activity.map((event) => event.sessionId ?? sessionId).filter(Boolean)),
  ].length;

  const copyVisibleActivity = async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(buildTaskActivityExport(task, visible, 'filtered'), null, 2),
      );
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const downloadFullActivity = () => {
    const payload = JSON.stringify(buildTaskActivityExport(task, activity, 'full'), null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${
      task.title
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase() || task.id
    }-activity.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section aria-label={t('activity:taskTimeline.taskActivity')} className="mt-5">
      <div className="mb-2 flex items-center gap-2">
        <Activity className="size-3.5 text-primary" />
        <h3 className="text-xs font-semibold uppercase text-muted-foreground">
          {t('activity:taskTimeline.activityLedger')}
        </h3>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {visible.length}/{activity.length}
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            onClick={copyVisibleActivity}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('activity:taskTimeline.copyVisibleTaskActivityJson')}
            title={t('activity:taskTimeline.copyFilteredActivityJson')}
          >
            {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
          </button>
          <button
            type="button"
            onClick={downloadFullActivity}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('activity:taskTimeline.downloadFullTaskActivityJson')}
            title={t('activity:taskTimeline.downloadFullActivityJson')}
          >
            <Download className="size-3" />
          </button>
          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t('activity:taskTimeline.refreshTaskActivity')}
            >
              <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
            </button>
          )}
        </div>
      </div>

      <div className="mb-2 grid grid-cols-4 gap-px overflow-hidden rounded-md border border-border/60 bg-border/60 text-center">
        {(
          [
            ['activity:kanbanText.statEvents', activity.length],
            ['activity:kanbanText.statActors', actors],
            ['activity:kanbanText.statSessions', sessions],
            ['activity:kanbanText.statFailures', counts.failures],
          ] as const
        ).map(([labelKey, value]) => (
          <div key={labelKey} className="bg-background/90 px-1 py-1.5">
            <div className="text-xs font-semibold tabular-nums">{value}</div>
            <div className="text-[8px] uppercase text-muted-foreground">{t(labelKey)}</div>
          </div>
        ))}
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {(['all', 'execution', 'changes', 'notes', 'failures'] as TaskActivityFilter[]).map(
          (value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={cn(
                'rounded border px-1.5 py-1 text-[9px] capitalize',
                filter === value
                  ? 'border-primary/50 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`activity:kanbanText.filter.${value}`)} {counts[value]}
            </button>
          ),
        )}
      </div>

      <div className="relative mb-3">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t('activity:taskTimeline.searchTaskActivity')}
          placeholder={t('activity:taskTimeline.searchAgentSessionModelResultField')}
          className="h-8 w-full rounded-md border bg-background pl-7 pr-7 text-[11px] outline-none focus:border-primary"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label={t('activity:taskTimeline.clearTaskActivitySearch')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </div>

      {error && (
        <div className="mb-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive">
          {error}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="rounded-md border border-dashed px-3 py-6 text-center text-[11px] text-muted-foreground">
          {t('activity:taskTimeline.noActivityMatchesThisFilter')}
        </div>
      ) : (
        <>
          <ol className="relative ml-1.5 space-y-0 border-l border-border/70">
            {displayed.map((event) => {
              const description = eventDescription(event, t);
              const effectiveSessionId = event.sessionId ?? sessionId;
              const changes = eventFieldChanges(event);
              const isFailure = activityCategory(event) === 'failures';
              const isSuccess =
                event.type.includes('completed') ||
                text(record(event.after)['outcome']) === 'succeeded';
              return (
                <li key={event.id} className="relative pb-4 pl-4 last:pb-0">
                  <span
                    className={cn(
                      'absolute -left-[5px] top-1.5 size-2 rounded-full ring-4',
                      activityTone(event),
                    )}
                  />
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium leading-5">{eventTitle(event, t)}</p>
                      <code
                        className="block truncate text-[8px] text-muted-foreground/70"
                        title={event.type}
                      >
                        {event.type}
                      </code>
                    </div>
                    <time
                      dateTime={event.ts}
                      title={new Date(event.ts).toLocaleString()}
                      className="shrink-0 text-[9px] text-muted-foreground"
                    >
                      {formatTimestamp(event.ts)}
                    </time>
                  </div>
                  {description && (
                    <p className="mt-1 whitespace-pre-wrap text-[11px] leading-4 text-muted-foreground">
                      {description}
                    </p>
                  )}
                  {event.note && (
                    <div
                      className={cn(
                        'mt-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap rounded border px-2 py-1.5 text-[10px] leading-4',
                        isFailure
                          ? 'border-destructive/30 bg-destructive/5 text-destructive'
                          : isSuccess
                            ? 'border-success/30 bg-success/5 text-success'
                            : 'border-border/70 bg-muted/35 text-foreground',
                      )}
                    >
                      <strong>
                        {isFailure
                          ? t('activity:kanbanText.noteError')
                          : isSuccess
                            ? t('activity:kanbanText.noteResult')
                            : t('activity:kanbanText.noteReason')}
                      </strong>{' '}
                      {event.note}
                    </div>
                  )}
                  {changes.length > 0 &&
                    event.type !== 'task.assigned' &&
                    event.type !== 'task.assignment.snapshot' &&
                    !event.type.startsWith('task.file.') && (
                      <div className="mt-1.5 space-y-1 rounded border border-border/60 bg-background/50 p-1.5">
                        {changes.map((change) => (
                          <div
                            key={change.field}
                            className="grid grid-cols-[5rem_minmax(0,1fr)] gap-1.5 text-[9px] leading-4"
                          >
                            <code className="truncate text-primary" title={change.field}>
                              {change.field}
                            </code>
                            <span className="min-w-0 break-all text-muted-foreground">
                              <span className="line-through opacity-70">
                                {compactValue(change.before, t)}
                              </span>{' '}
                              <span aria-hidden>→</span>{' '}
                              <span className="text-foreground">
                                {compactValue(change.after, t)}
                              </span>
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  <RoutingBadges event={event} />
                  {(event.actor ||
                    effectiveSessionId ||
                    event.subagentId ||
                    event.runTaskId ||
                    event.correlationId) && (
                    <div className="mt-1.5 flex flex-wrap gap-1 font-mono text-[9px] text-muted-foreground">
                      {event.actor && (
                        <span className="rounded bg-muted px-1.5 py-0.5">agent:{event.actor}</span>
                      )}
                      {effectiveSessionId && (
                        <span
                          className="max-w-52 truncate rounded bg-muted px-1.5 py-0.5"
                          title={effectiveSessionId}
                        >
                          session:{effectiveSessionId}
                        </span>
                      )}
                      {event.subagentId && (
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          subagent:{event.subagentId}
                        </span>
                      )}
                      {event.runTaskId && (
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          run:{event.runTaskId}
                        </span>
                      )}
                      {event.correlationId && (
                        <span className="rounded bg-muted px-1.5 py-0.5">
                          trace:{event.correlationId}
                        </span>
                      )}
                    </div>
                  )}
                  <details className="mt-1.5 text-[9px] text-muted-foreground">
                    <summary className="cursor-pointer hover:text-foreground">
                      {t('activity:taskTimeline.fullEventPayload')}
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded border bg-muted/30 p-2 text-[9px] leading-4 text-foreground">
                      {JSON.stringify(event, null, 2)}
                    </pre>
                  </details>
                </li>
              );
            })}
          </ol>
          <Pagination
            page={activityPage.page}
            pageSize={activityPage.pageSize}
            totalItems={activityPage.totalItems}
            onPageChange={activityPage.setPage}
            className="mt-3"
            itemLabel={t('activity:uiText.item.activityEvents')}
          />
        </>
      )}
    </section>
  );
}
