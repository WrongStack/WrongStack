import type { KanbanEvent, KanbanTask } from '@wrongstack/kanban';
import { Bot, ChevronDown, History, Route, Timer } from 'lucide-react';
import { buildTaskActivity } from './TaskActivityTimeline';
import { usePagination } from '@/hooks/usePagination';
import { Pagination } from './ui/pagination';
import { useAppTranslation } from '@/i18n';

interface TaskExecutionAttempt {
  attempt: number;
  status: string;
  startedAt: string;
  runningAt?: string | undefined;
  endedAt?: string | undefined;
  durationMs?: number | undefined;
  owner?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  routingMode?: string | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels: string[];
  sessionIds: string[];
  subagentId?: string | undefined;
  runTaskId?: string | undefined;
  result?: string | undefined;
  error?: string | undefined;
  eventCount: number;
}

interface MutableAttempt extends Omit<TaskExecutionAttempt, 'sessionIds' | 'eventCount'> {
  sessionIds: Set<string>;
  eventCount: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isExecutionEvent(event: KanbanEvent): boolean {
  return (
    event.type === 'task.assigned' ||
    event.type === 'task.claimed' ||
    event.type === 'task.released' ||
    event.type === 'task.assignment.snapshot' ||
    event.type === 'task.stale_recovered' ||
    event.type.startsWith('task.assignment.')
  );
}

function statusFromEvent(event: KanbanEvent, after: Record<string, unknown>): string {
  const explicit = text(after['status']);
  if (explicit) return explicit;
  if (event.type === 'task.claimed') return 'claimed';
  if (event.type === 'task.released') return 'released';
  if (event.type === 'task.stale_recovered') return 'recovered';
  return event.type.split('.').at(-1) ?? 'unknown';
}

function isTerminal(status: string): boolean {
  return ['completed', 'failed', 'cancelled', 'released', 'recovered'].includes(status);
}

function elapsedMs(start: string, end?: string): number | undefined {
  if (!end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, endMs - startMs)
    : undefined;
}

export function buildTaskExecutionAttempts(
  task: KanbanTask,
  events: KanbanEvent[],
  sessionId?: string,
): TaskExecutionAttempt[] {
  const execution = buildTaskActivity(task, events, sessionId)
    .filter(isExecutionEvent)
    .sort((left, right) => left.ts.localeCompare(right.ts));
  const attempts = new Map<number, MutableAttempt>();
  let currentAttempt = 0;
  let highestAttempt = 0;
  let previousTerminal = false;

  for (const event of execution) {
    const after = record(event.after);
    const explicitAttempt = Number(after['attempt']);
    const beginsAttempt = event.type === 'task.assigned' || event.type === 'task.claimed';
    if (Number.isFinite(explicitAttempt) && explicitAttempt > 0) {
      currentAttempt = Math.trunc(explicitAttempt);
    } else if (beginsAttempt && (currentAttempt === 0 || previousTerminal)) {
      currentAttempt = highestAttempt + 1;
    } else if (currentAttempt === 0) {
      currentAttempt = 1;
    }
    highestAttempt = Math.max(highestAttempt, currentAttempt);

    const status = statusFromEvent(event, after);
    const existing = attempts.get(currentAttempt);
    const attempt: MutableAttempt = existing ?? {
      attempt: currentAttempt,
      status,
      startedAt: event.ts,
      fallbackModels: [],
      sessionIds: new Set<string>(),
      eventCount: 0,
    };
    attempt.status = status;
    attempt.eventCount += 1;
    if (event.sessionId ?? sessionId) attempt.sessionIds.add(event.sessionId ?? sessionId!);
    attempt.owner =
      text(after['name']) ??
      text(after['agentId']) ??
      text(after['role']) ??
      event.actor ??
      attempt.owner;
    attempt.provider = text(after['provider']) ?? attempt.provider;
    attempt.model = text(after['model']) ?? attempt.model;
    attempt.routingMode = text(after['modelRouting']) ?? attempt.routingMode;
    attempt.fallbackProfile = text(after['fallbackProfile']) ?? attempt.fallbackProfile;
    if (Array.isArray(after['fallbackModels'])) {
      attempt.fallbackModels = after['fallbackModels'].filter(
        (value): value is string => typeof value === 'string',
      );
    }
    attempt.subagentId = event.subagentId ?? text(after['subagentId']) ?? attempt.subagentId;
    attempt.runTaskId = event.runTaskId ?? text(after['runTaskId']) ?? attempt.runTaskId;
    if (status === 'running' && !attempt.runningAt) attempt.runningAt = event.ts;
    if (status === 'completed') {
      attempt.result = text(after['lastResult']) ?? event.note ?? attempt.result;
    }
    if (status === 'failed' || status === 'cancelled') {
      attempt.error = text(after['error']) ?? event.note ?? attempt.error;
    }
    if (isTerminal(status)) attempt.endedAt = event.ts;
    attempts.set(currentAttempt, attempt);
    previousTerminal = isTerminal(status);
  }

  return [...attempts.values()]
    .map((attempt) => ({
      ...attempt,
      sessionIds: [...attempt.sessionIds],
      durationMs: elapsedMs(attempt.startedAt, attempt.endedAt),
    }))
    .sort((left, right) => right.attempt - left.attempt);
}

function duration(value?: number): string {
  if (value === undefined) return 'running';
  if (value < 1_000) return `${value}ms`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function statusTone(status: string): string {
  if (status === 'completed') return 'bg-success/10 text-success';
  if (status === 'failed' || status === 'cancelled') return 'bg-destructive/10 text-destructive';
  if (status === 'running') return 'bg-info/10 text-info';
  return 'bg-muted text-muted-foreground';
}

export function TaskExecutionAttempts({
  task,
  events,
  sessionId,
}: {
  task: KanbanTask;
  events: KanbanEvent[];
  sessionId?: string | undefined;
}) {
  const { t } = useAppTranslation();
  const attempts = buildTaskExecutionAttempts(task, events, sessionId);
  const attemptPage = usePagination(attempts, 8, task.id);
  if (!attempts.length) return null;
  return (
    <details open className="mt-3 rounded-md border border-border/70 bg-muted/15">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <History className="size-4 text-primary" />
        <span className="text-xs font-semibold">{t('activity:taskExecutionAttempts.executionAttempts')}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">
          {attempts.length} total
        </span>
        <span className={`rounded px-1.5 py-0.5 text-[9px] ${statusTone(attempts[0]!.status)}`}>
          latest:{attempts[0]!.status}
        </span>
        <ChevronDown className="ml-auto size-3.5 text-muted-foreground" />
      </summary>
      <div className="space-y-2 border-t border-border/60 p-2.5">
        {attemptPage.pageItems.map((attempt) => (
          <section key={attempt.attempt} className="rounded-md border bg-background/70 p-2.5">
            <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
              <strong className="text-xs">Attempt #{attempt.attempt}</strong>
              <span className={`rounded px-1.5 py-0.5 ${statusTone(attempt.status)}`}>
                {attempt.status}
              </span>
              <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
                <Timer className="size-3" /> {duration(attempt.durationMs)} · {attempt.eventCount}{' '}
                events
              </span>
            </div>
            <div className="mt-2 grid gap-1 text-[10px] text-muted-foreground sm:grid-cols-2">
              <span className="inline-flex items-center gap-1">
                <Bot className="size-3" /> {attempt.owner ?? 'Unknown agent'}
              </span>
              <span className="inline-flex items-center gap-1 font-mono">
                <Route className="size-3" />
                {attempt.provider || attempt.model
                  ? `${attempt.provider ? `${attempt.provider}/` : ''}${attempt.model ?? 'default'}`
                  : (attempt.routingMode ?? 'default route')}
              </span>
              <span className="font-mono">
                session:{attempt.sessionIds.join(', ') || 'unknown'}
              </span>
              <span className="font-mono">
                subagent:{attempt.subagentId ?? '—'} · run:{attempt.runTaskId ?? '—'}
              </span>
            </div>
            {(attempt.fallbackProfile || attempt.fallbackModels.length > 0) && (
              <p className="mt-1.5 break-all font-mono text-[9px] text-muted-foreground">
                fallback:
                {[
                  attempt.fallbackProfile ? `profile:${attempt.fallbackProfile}` : '',
                  ...attempt.fallbackModels,
                ]
                  .filter(Boolean)
                  .join(' → ')}
              </p>
            )}
            {attempt.error && (
              <p className="mt-2 whitespace-pre-wrap rounded border border-destructive/30 bg-destructive/5 px-2 py-1.5 text-[10px] text-destructive">
                <strong>{t('activity:taskExecutionAttempts.error')}</strong> {attempt.error}
              </p>
            )}
            {attempt.result && (
              <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded border border-success/30 bg-success/5 px-2 py-1.5 text-[10px] text-success">
                <strong>{t('activity:taskExecutionAttempts.result')}</strong> {attempt.result}
              </p>
            )}
          </section>
        ))}
        <Pagination
          page={attemptPage.page}
          pageSize={attemptPage.pageSize}
          totalItems={attemptPage.totalItems}
          onPageChange={attemptPage.setPage}
          compact
          itemLabel="execution attempts"
        />
      </div>
    </details>
  );
}
