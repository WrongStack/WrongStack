import type { KanbanEvent, KanbanTask } from '@wrongstack/kanban';
import { Activity, Check, Copy, Download, RefreshCw, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { usePagination } from '@/hooks/usePagination';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { Pagination } from './ui/pagination';

interface TaskActivityTimelineProps {
  task: KanbanTask;
  events: KanbanEvent[];
  sessionId?: string | undefined;
  loading?: boolean | undefined;
  error?: string | null | undefined;
  onRefresh?: (() => void) | undefined;
}

type TaskActivityFilter = 'all' | 'execution' | 'changes' | 'notes' | 'failures';

interface TaskFieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

interface TaskActivityExport {
  format: 'wrongstack-kanban-task-activity';
  version: 1;
  exportedAt: string;
  scope: 'full' | 'filtered';
  task: KanbanTask;
  events: KanbanEvent[];
}

export function buildTaskActivityExport(
  task: KanbanTask,
  events: KanbanEvent[],
  scope: TaskActivityExport['scope'],
  exportedAt = new Date().toISOString(),
): TaskActivityExport {
  return {
    format: 'wrongstack-kanban-task-activity',
    version: 1,
    exportedAt,
    scope,
    task,
    events,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function activityCategory(event: KanbanEvent): Exclude<TaskActivityFilter, 'all'> {
  if (event.type.startsWith('task.file.')) {
    return event.type === 'task.file.read' ? 'execution' : 'changes';
  }
  if (event.type.startsWith('task.activity.')) {
    if (text(record(event.after)['outcome']) === 'failed') return 'failures';
    return event.type === 'task.activity.attempt' ? 'execution' : 'notes';
  }
  if (event.type.includes('failed') || event.type.includes('cancelled')) return 'failures';
  if (
    event.type === 'task.assigned' ||
    event.type === 'task.claimed' ||
    event.type === 'task.released' ||
    event.type.startsWith('task.assignment.') ||
    event.type === 'task.stale_recovered'
  ) {
    return 'execution';
  }
  if (
    event.type.includes('note') ||
    event.type.includes('check') ||
    event.type.includes('metric')
  ) {
    return 'notes';
  }
  return 'changes';
}

export function eventFieldChanges(event: KanbanEvent): TaskFieldChange[] {
  const before = record(event.before);
  const after = record(event.after);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after[field]))
    .map((field) => ({ field, before: before[field], after: after[field] }));
}

function eventTitle(event: KanbanEvent): string {
  if (event.type.startsWith('task.file.')) {
    const operation = event.type.slice('task.file.'.length);
    return `File ${operation}`.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  if (event.type.startsWith('task.activity.')) {
    const kind = event.type.slice('task.activity.'.length);
    return `Recorded ${kind}`.replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  switch (event.type) {
    case 'task.created':
      return 'Task created';
    case 'task.copied':
      return 'Task copied';
    case 'task.updated':
      return 'Task contract updated';
    case 'task.moved':
      return 'Task moved';
    case 'task.assigned':
      return 'Agent assigned';
    case 'task.claimed':
      return 'Task claimed';
    case 'task.released':
      return 'Assignment released';
    case 'task.assignment.updated':
      return 'Assignment updated';
    case 'task.assignment.running':
      return 'Agent started work';
    case 'task.assignment.completed':
      return 'Agent completed work';
    case 'task.assignment.failed':
      return 'Agent run failed';
    case 'task.assignment.cancelled':
      return 'Agent run cancelled';
    case 'task.assignment.heartbeat':
      return 'Agent heartbeat';
    case 'task.note.added':
      return 'Operator note added';
    case 'task.check.added':
      return 'Acceptance check added';
    case 'task.check.updated':
      return 'Acceptance check updated';
    case 'task.metric.added':
      return 'Goal metric added';
    case 'task.metric.updated':
      return 'Goal metric updated';
    case 'task.lifecycle.transition':
      return 'Lifecycle advanced';
    case 'task.assignment.snapshot':
      return 'Current assignment observed';
    case 'task.stale_recovered':
      return 'Stale assignment recovered';
    case 'task.reconciled':
      return 'Task state reconciled';
    default:
      return event.type
        .replace(/^task\./, '')
        .replaceAll('.', ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
}

function eventDescription(event: KanbanEvent): string | undefined {
  const before = record(event.before);
  const after = record(event.after);
  if (event.type.startsWith('task.file.')) {
    const filePath = text(after['filePath']);
    const toolName = text(after['toolName']);
    const durationMs = typeof after['durationMs'] === 'number' ? after['durationMs'] : undefined;
    const lines = typeof after['lines'] === 'number' ? after['lines'] : undefined;
    return (
      [
        filePath,
        toolName ? `tool:${toolName}` : undefined,
        durationMs !== undefined ? `${durationMs}ms` : undefined,
        lines !== undefined ? `${lines} lines` : undefined,
      ]
        .filter(Boolean)
        .join(' · ') || undefined
    );
  }
  if (event.type.startsWith('task.activity.')) {
    return (
      [text(after['outcome']), text(after['details'])].filter(Boolean).join(' · ') || undefined
    );
  }
  if (event.type === 'task.moved') {
    const from = text(before['columnId']);
    const to = text(after['columnId']);
    if (from || to) return `${from ?? 'unknown'} → ${to ?? 'unknown'}`;
  }
  if (event.type === 'task.updated') {
    const changes = eventFieldChanges(event);
    if (changes.length)
      return `${changes.length} field${changes.length === 1 ? '' : 's'} changed: ${changes.map((change) => change.field).join(', ')}`;
  }
  if (event.type === 'task.lifecycle.transition') {
    const from = text(before['stage']);
    const to = text(after['stage']);
    if (to) return from ? `${from} → ${to}` : `Entered ${to}`;
  }
  if (event.type === 'task.assigned' || event.type === 'task.assignment.snapshot') {
    const owner = text(after['name']) ?? text(after['agentId']) ?? text(after['role']);
    const provider = text(after['provider']);
    const model = text(after['model']);
    const route =
      provider || model ? `${provider ? `${provider}/` : ''}${model ?? 'default'}` : undefined;
    return [owner, route].filter(Boolean).join(' · ') || undefined;
  }
  if (event.type.startsWith('task.check.')) {
    return (
      [text(after['description']), text(after['status'])].filter(Boolean).join(' · ') || undefined
    );
  }
  if (event.type.startsWith('task.metric.')) {
    return [text(after['name']), text(after['status'])].filter(Boolean).join(' · ') || undefined;
  }
  return undefined;
}

function activityTone(event: KanbanEvent): string {
  const type = event.type;
  if (text(record(event.after)['outcome']) === 'failed') {
    return 'bg-destructive ring-destructive/20';
  }
  if (type.includes('failed') || type.includes('cancelled'))
    return 'bg-destructive ring-destructive/20';
  if (type.includes('completed') || type.includes('reconciled'))
    return 'bg-success ring-success/20';
  if (type.includes('running') || type.includes('claimed') || type.includes('assigned')) {
    return 'bg-info ring-info/20';
  }
  if (type.includes('note')) return 'bg-warning ring-warning/20';
  return 'bg-primary ring-primary/20';
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(parsed);
}

function compactValue(value: unknown): string {
  if (value === undefined) return 'unset';
  if (value === null) return 'none';
  if (typeof value === 'string') return value || 'empty';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Merge the durable event stream with legacy card-local audit data. */
export function buildTaskActivity(
  task: KanbanTask,
  events: KanbanEvent[],
  fallbackSessionId?: string,
): KanbanEvent[] {
  const merged = events.filter((event) => event.taskId === task.id).map((event) => ({ ...event }));
  const hasType = (type: string) => merged.some((event) => event.type === type);

  if (!hasType('task.created')) {
    merged.push({
      id: `created:${task.id}`,
      boardId: '',
      taskId: task.id,
      type: 'task.created',
      ts: task.createdAt,
      sessionId: fallbackSessionId || '',
      after: { title: task.title, status: 'created', columnId: task.columnId },
    });
  }

  for (const [index, transition] of (task.lifecycle?.history ?? []).entries()) {
    if (
      merged.some(
        (event) =>
          event.type === 'task.lifecycle.transition' &&
          event.ts === transition.at &&
          event.actor === transition.actor,
      )
    )
      continue;
    merged.push({
      id: `lifecycle:${task.id}:${index}`,
      boardId: '',
      taskId: task.id,
      type: 'task.lifecycle.transition',
      ts: transition.at,
      actor: transition.actor,
      sessionId: fallbackSessionId || '',
      before: transition.from ? { stage: transition.from } : undefined,
      after: { stage: transition.to, action: transition.action, attachment: transition.attachment },
      note: transition.comment,
    });
  }

  for (const note of task.notes ?? []) {
    if (
      merged.some(
        (event) =>
          event.type === 'task.note.added' &&
          event.note === note.content &&
          Math.abs(Date.parse(event.ts) - Date.parse(note.createdAt)) < 2_000,
      )
    )
      continue;
    merged.push({
      id: `note:${note.id}`,
      boardId: '',
      taskId: task.id,
      type: 'task.note.added',
      ts: note.createdAt,
      actor: note.author,
      sessionId: fallbackSessionId || '',
      note: note.content,
    });
  }

  const hasAssignmentEvent = merged.some(
    (event) =>
      event.type === 'task.assigned' ||
      event.type === 'task.claimed' ||
      event.type.startsWith('task.assignment.'),
  );
  if (task.assignment && !hasAssignmentEvent) {
    merged.push({
      id: `assignment:${task.id}`,
      boardId: '',
      taskId: task.id,
      type: 'task.assignment.snapshot',
      ts:
        task.assignment.completedAt ??
        task.assignment.dispatchedAt ??
        task.assignment.claimedAt ??
        task.updatedAt,
      actor: task.assignment.agentId ?? task.assignment.name ?? task.assignment.role,
      sessionId: fallbackSessionId || '',
      subagentId: task.assignment.subagentId,
      runTaskId: task.assignment.runTaskId,
      after: { ...task.assignment },
      note: task.assignment.error ?? task.assignment.lastResult,
    });
  }

  return merged.sort((a, b) => b.ts.localeCompare(a.ts));
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
  }, [activity, filter, query]);
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
        {[
          ['Events', activity.length],
          ['Actors', actors],
          ['Sessions', sessions],
          ['Failures', counts.failures],
        ].map(([label, value]) => (
          <div key={String(label)} className="bg-background/90 px-1 py-1.5">
            <div className="text-xs font-semibold tabular-nums">{value}</div>
            <div className="text-[8px] uppercase text-muted-foreground">{label}</div>
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
              {value} {counts[value]}
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
              const description = eventDescription(event);
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
                      <p className="text-xs font-medium leading-5">{eventTitle(event)}</p>
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
                        {isFailure ? 'Error' : isSuccess ? 'Result' : 'Reason / result'}:
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
                                {compactValue(change.before)}
                              </span>{' '}
                              <span aria-hidden>→</span>{' '}
                              <span className="text-foreground">{compactValue(change.after)}</span>
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
            itemLabel="activity events"
          />
        </>
      )}
    </section>
  );
}
