import type { KanbanBoard, KanbanBoardPresence, KanbanEvent, KanbanTask } from '@wrongstack/kanban';
import {
  Activity,
  Bot,
  BrainCircuit,
  ChevronDown,
  GitBranch,
  Route,
  ShieldCheck,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useAppTranslation } from '@/i18n';
import { kanbanMetadataText } from '@/lib/kanban-metadata';
import { activityCategory, buildTaskActivity } from './TaskActivityTimeline';

interface TaskIntelligencePanelProps {
  board: KanbanBoard;
  task: KanbanTask;
  events: KanbanEvent[];
  presence?: KanbanBoardPresence[] | undefined;
  sessionId?: string | undefined;
  sessionProvider?: string | undefined;
  sessionModel?: string | undefined;
}

interface RelatedTask {
  id: string;
  title: string;
  status: string;
}

interface TaskIntelligence {
  column: string;
  reason: string;
  owner: string;
  routingMode: string;
  provider?: string | undefined;
  model?: string | undefined;
  primaryModel: string;
  fallbackRoute: string;
  blockers: RelatedTask[];
  dependencies: RelatedTask[];
  actors: string[];
  sessions: string[];
  presence: string[];
  activePresence: number;
  attempts: number;
  failures: number;
  completions: number;
  lastFailure?: string | undefined;
  lastResult?: string | undefined;
  eventCount: number;
  lastActivity?: KanbanEvent | undefined;
}

function eventRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return kanbanMetadataText(value);
}

function related(board: KanbanBoard, ids: string[] | undefined): RelatedTask[] {
  return (ids ?? []).map((id) => {
    const task = board.tasks.find((candidate) => candidate.id === id);
    return { id, title: task?.title ?? id, status: task?.status ?? 'missing' };
  });
}

export function deriveTaskIntelligence(
  board: KanbanBoard,
  task: KanbanTask,
  events: KanbanEvent[],
  sessionId?: string,
  sessionProvider?: string,
  sessionModel?: string,
  presence?: KanbanBoardPresence[],
): TaskIntelligence {
  const activity = buildTaskActivity(task, events, sessionId);
  const dependencies = related(board, task.dependsOn);
  const blockers = dependencies.filter(
    (dependency) => !['completed', 'archived'].includes(dependency.status),
  );
  const assignment = task.assignment;
  const taskPresence = (presence ?? board.presence ?? []).filter(
    (entry) => entry.taskId === task.id,
  );
  const latestAssignmentEvent = activity.find(
    (event) =>
      event.type === 'task.assigned' ||
      event.type === 'task.claimed' ||
      event.type.startsWith('task.assignment.'),
  );
  const historicalAssignment = eventRecord(latestAssignmentEvent?.after);
  const routingMode =
    stringValue(assignment?.modelRouting) ??
    stringValue(historicalAssignment['modelRouting']) ??
    'session';
  const provider =
    stringValue(assignment?.provider) ??
    stringValue(historicalAssignment['provider']) ??
    (routingMode === 'session' ? stringValue(sessionProvider) : undefined);
  const model =
    stringValue(assignment?.model) ??
    stringValue(historicalAssignment['model']) ??
    (routingMode === 'session' ? stringValue(sessionModel) : undefined);
  const fallbackModels = (
    Array.isArray(assignment?.fallbackModels)
      ? assignment.fallbackModels
      : Array.isArray(historicalAssignment['fallbackModels'])
        ? historicalAssignment['fallbackModels']
        : []
  )
    .map(stringValue)
    .filter((value): value is string => value !== undefined);
  const fallbackProfile =
    stringValue(assignment?.fallbackProfile) ??
    stringValue(historicalAssignment['fallbackProfile']);
  const owner =
    stringValue(assignment?.name) ??
    stringValue(assignment?.agentId) ??
    stringValue(assignment?.role) ??
    stringValue(task.assignee) ??
    stringValue(task.assignedAgent) ??
    'Unassigned';

  const lastTransition = task.lifecycle?.history.at(-1);
  const latestReason = activity.find(
    (event) => event.note && event.type !== 'task.note.added',
  )?.note;
  let reason = `Placed in ${board.columns.find((column) => column.id === task.columnId)?.title ?? task.columnId}.`;
  if (assignment?.error) reason = `Agent run failed: ${assignment.error}`;
  else if (blockers.length) reason = `Blocked by ${blockers.map((item) => item.title).join(', ')}.`;
  else if (lastTransition?.comment) reason = lastTransition.comment;
  else if (latestReason) reason = latestReason;
  else if (task.status === 'review')
    reason = 'Implementation is waiting for review evidence or approval.';
  else if (task.status === 'in_progress') reason = `${owner} is currently working on this task.`;
  else if (task.status === 'completed')
    reason = 'The task and its current assignment are complete.';

  const attemptValues = activity
    .map((event) => Number(eventRecord(event.after)['attempt']))
    .filter((value) => Number.isFinite(value));
  const inferredAttempts = activity.filter(
    (event) => event.type === 'task.claimed' || event.type === 'task.assigned',
  ).length;
  const latestFailure = activity.find((event) => activityCategory(event) === 'failures');
  const latestCompletion = activity.find((event) => event.type.includes('completed'));

  return {
    column: board.columns.find((column) => column.id === task.columnId)?.title ?? task.columnId,
    reason,
    owner,
    routingMode,
    provider,
    model,
    primaryModel:
      provider || model
        ? `${provider ? `${provider}/` : ''}${model ?? 'default'}`
        : 'Session default',
    fallbackRoute:
      [fallbackProfile ? `profile:${fallbackProfile}` : '', ...fallbackModels]
        .filter(Boolean)
        .join(' → ') || 'None configured',
    blockers,
    dependencies,
    actors: [
      ...new Set([
        ...activity.map((event) => event.actor).filter((value): value is string => !!value),
        ...taskPresence.map((entry) => entry.agentId),
      ]),
    ],
    sessions: [
      ...new Set(
        [
          ...activity.map((event) => event.sessionId ?? sessionId),
          ...taskPresence.map((entry) => entry.sessionId),
        ].filter((value): value is string => !!value),
      ),
    ],
    presence: taskPresence.map(
      (entry) =>
        `${entry.agentName ?? entry.agentId} · ${entry.active ? 'active' : `last seen ${displayDate(entry.lastSeenAt)}`}`,
    ),
    activePresence: taskPresence.filter((entry) => entry.active).length,
    attempts: Math.max(assignment?.attempt ?? 0, ...attemptValues, inferredAttempts),
    failures: activity.filter((event) => event.type.includes('failed')).length,
    completions: activity.filter((event) => event.type.includes('completed')).length,
    lastFailure: assignment?.lastFailureKind ?? assignment?.error ?? latestFailure?.note,
    lastResult: assignment?.lastResult ?? latestCompletion?.note,
    eventCount: activity.length,
    lastActivity: activity[0],
  };
}

function displayDate(value?: string): string {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : value;
}

function displayDuration(from?: string, to?: string): string {
  if (!from) return '—';
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return '—';
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function InfoRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2 py-1 text-[11px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={mono ? 'break-all font-mono text-[10px]' : 'min-w-0 break-words'}>{value}</dd>
    </div>
  );
}

function Group({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-border/70 bg-background/55 p-2.5">
      <h4 className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        {title}
      </h4>
      <dl className="divide-y divide-border/35">{children}</dl>
    </section>
  );
}

function RelationList({ items }: { items: RelatedTask[] }) {
  const { t } = useAppTranslation();
  if (!items.length)
    return <span className="text-muted-foreground">{t('activity:taskIntel.none')}</span>;
  return (
    <span className="space-y-1">
      {items.map((item) => (
        <span key={item.id} className="flex items-center justify-between gap-2">
          <span className="truncate" title={item.title}>
            {item.title}
          </span>
          <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px]">{item.status}</span>
        </span>
      ))}
    </span>
  );
}

export function TaskIntelligencePanel({
  board,
  task,
  events,
  presence,
  sessionId,
  sessionProvider,
  sessionModel,
}: TaskIntelligencePanelProps) {
  const { t } = useAppTranslation();
  const intelligence = deriveTaskIntelligence(
    board,
    task,
    events,
    sessionId,
    sessionProvider,
    sessionModel,
    presence,
  );
  const assignment = task.assignment;
  const checkCount = task.successCriteria?.length ?? 0;
  const passedChecks =
    task.successCriteria?.filter((check) => check.status === 'passed').length ?? 0;
  const relationIds = [
    task.parentTaskId,
    ...(task.childTaskIds ?? []),
    task.chain?.previousTaskId,
    task.chain?.nextTaskId,
    task.mergedIntoTaskId,
    ...(task.mergedFromTaskIds ?? []),
  ].filter((value): value is string => !!value);
  const relations = related(board, [...new Set(relationIds)]);

  return (
    <details open className="mt-3 rounded-md border border-primary/25 bg-primary/[0.025]">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        <BrainCircuit className="size-4 text-primary" />
        <span className="text-xs font-semibold">{t('activity:taskIntel.heading')}</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[9px] uppercase text-muted-foreground">
          {task.status}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {t('activity:taskIntel.eventsCount', { count: intelligence.eventCount })}
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </summary>

      <div className="space-y-2.5 border-t border-border/60 p-2.5">
        <section className="rounded-md border border-info/25 bg-info/5 p-2.5">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="rounded bg-info/10 px-1.5 py-0.5 font-semibold text-info">
              {intelligence.column}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5">
              {t('activity:taskIntel.stagePrefix')}
              {task.lifecycle?.currentStage ?? t('activity:taskIntel.legacyStage')}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5">
              {t('activity:taskIntel.priorityPrefix')}
              {task.priority}
            </span>
            <span className="rounded bg-muted px-1.5 py-0.5">
              {t('activity:taskIntel.typePrefix')}
              {task.type ?? t('activity:taskIntel.inferredType')}
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-4">
            <strong>{t('activity:taskIntel.whyHere')}</strong> {intelligence.reason}
          </p>
          {intelligence.blockers.length > 0 && (
            <p className="mt-1 text-[10px] text-warning">
              {t('activity:taskIntel.unresolvedBlockers', {
                count: intelligence.blockers.length,
              })}
            </p>
          )}
        </section>

        <div className="grid gap-2 xl:grid-cols-2">
          <Group icon={<Bot className="size-3" />} title={t('activity:taskIntel.ownershipRuntime')}>
            <InfoRow label={t('activity:taskIntel.owner')} value={intelligence.owner} />
            <InfoRow
              label={t('activity:taskIntel.assignee')}
              value={stringValue(task.assignee) ?? stringValue(task.assignedAgent) ?? '—'}
            />
            <InfoRow
              label={t('activity:taskIntel.agentId')}
              value={stringValue(assignment?.agentId) ?? '—'}
              mono
            />
            <InfoRow
              label={t('activity:taskIntel.agentNameRole')}
              value={
                [stringValue(assignment?.name), stringValue(assignment?.role)]
                  .filter(Boolean)
                  .join(' · ') || '—'
              }
            />
            <InfoRow
              label={t('activity:taskIntel.runStatus')}
              value={stringValue(assignment?.status) ?? 'unassigned'}
            />
            <InfoRow
              label={t('activity:taskIntel.subagent')}
              value={stringValue(assignment?.subagentId) ?? '—'}
              mono
            />
            <InfoRow
              label={t('activity:taskIntel.runTask')}
              value={stringValue(assignment?.runTaskId) ?? '—'}
              mono
            />
            <InfoRow
              label={t('activity:taskIntel.sessionS')}
              value={intelligence.sessions.join(', ') || 'Unknown'}
              mono
            />
            <InfoRow
              label={t('activity:taskIntel.usersPresence')}
              value={
                intelligence.presence.length
                  ? intelligence.presence.join(', ')
                  : 'No task-scoped presence recorded'
              }
            />
          </Group>

          <Group
            icon={<Route className="size-3" />}
            title={t('activity:taskIntel.modelRouteFallback')}
          >
            <InfoRow label={t('activity:taskIntel.routingMode')} value={intelligence.routingMode} />
            <InfoRow
              label={t('activity:taskIntel.primary')}
              value={intelligence.primaryModel}
              mono
            />
            <InfoRow
              label={t('activity:taskIntel.provider')}
              value={intelligence.provider ?? '—'}
              mono
            />
            <InfoRow label={t('activity:taskIntel.model')} value={intelligence.model ?? '—'} mono />
            <InfoRow
              label={t('activity:taskIntel.fallbackRoute')}
              value={intelligence.fallbackRoute}
              mono
            />
            <InfoRow
              label={t('activity:taskIntel.skills')}
              value={assignment?.skills?.map(stringValue).filter(Boolean).join(', ') || 'Default'}
            />
            <InfoRow
              label={t('activity:taskIntel.tools')}
              value={
                assignment?.tools?.map(stringValue).filter(Boolean).join(', ') || 'Default toolset'
              }
            />
            <InfoRow
              label={t('activity:taskIntel.capabilities')}
              value={
                assignment?.allowedCapabilities?.map(stringValue).filter(Boolean).join(', ') ||
                'Safe defaults'
              }
              mono
            />
          </Group>

          <Group
            icon={<ShieldCheck className="size-3" />}
            title={t('activity:taskIntel.executionPolicyOutcome')}
          >
            <InfoRow
              label={t('activity:taskIntel.attempts')}
              value={`${intelligence.attempts}${assignment?.maxAttempts ? ` / ${assignment.maxAttempts}` : ''}`}
            />
            <InfoRow
              label={t('activity:taskIntel.retryPolicy')}
              value={assignment?.retryPolicy ?? task.retryPolicy ?? 'off'}
            />
            <InfoRow
              label={t('activity:taskIntel.costCeiling')}
              value={
                (assignment?.costCeilingUsd ?? task.costCeilingUsd) != null
                  ? `$${(assignment?.costCeilingUsd ?? task.costCeilingUsd)!.toFixed(2)}`
                  : 'Unbounded'
              }
            />
            <InfoRow
              label={t('activity:taskIntel.failuresDone')}
              value={`${intelligence.failures} / ${intelligence.completions}`}
            />
            <InfoRow
              label={t('activity:taskIntel.checks')}
              value={`${passedChecks} / ${checkCount} passed`}
            />
            <InfoRow
              label={t('activity:taskIntel.lastFailure')}
              value={intelligence.lastFailure ?? '—'}
            />
            <InfoRow
              label={t('activity:taskIntel.result')}
              value={intelligence.lastResult ?? 'No result recorded'}
            />
          </Group>

          <Group
            icon={<Activity className="size-3" />}
            title={t('activity:taskIntel.timingAuditCoverage')}
          >
            <InfoRow label={t('activity:taskIntel.created')} value={displayDate(task.createdAt)} />
            <InfoRow label={t('activity:taskIntel.updated')} value={displayDate(task.updatedAt)} />
            <InfoRow label={t('activity:taskIntel.due')} value={displayDate(task.dueDate)} />
            <InfoRow
              label={t('activity:taskIntel.dispatched')}
              value={displayDate(assignment?.dispatchedAt ?? assignment?.claimedAt)}
            />
            <InfoRow
              label={t('activity:taskIntel.completed')}
              value={displayDate(assignment?.completedAt ?? task.completedAt)}
            />
            <InfoRow
              label={t('activity:taskIntel.duration')}
              value={displayDuration(
                assignment?.dispatchedAt ?? assignment?.claimedAt,
                assignment?.completedAt,
              )}
            />
            <InfoRow
              label={t('activity:taskIntel.heartbeat')}
              value={displayDate(assignment?.heartbeatAt)}
            />
            <InfoRow
              label={t('activity:taskIntel.leaseExpires')}
              value={displayDate(assignment?.leaseExpiresAt)}
            />
            <InfoRow
              label={t('activity:taskIntel.actors')}
              value={intelligence.actors.join(', ') || 'Unknown'}
              mono
            />
          </Group>
        </div>

        <Group
          icon={<GitBranch className="size-3" />}
          title={t('activity:taskIntel.dependenciesChainProvenance')}
        >
          <InfoRow
            label={t('activity:taskIntel.dependencies')}
            value={<RelationList items={intelligence.dependencies} />}
          />
          <InfoRow
            label={t('activity:taskIntel.otherRelations')}
            value={<RelationList items={relations} />}
          />
          <InfoRow
            label={t('activity:taskIntel.chain')}
            value={task.chain ? `${task.chain.chainId} · position ${task.chain.order}` : 'None'}
            mono
          />
          <InfoRow
            label={t('activity:taskIntel.originSystem')}
            value={task.origin?.system ?? 'manual'}
          />
          <InfoRow
            label={t('activity:taskIntel.originIds')}
            value={
              task.origin
                ? [task.origin.graphId, task.origin.phaseId, task.origin.taskId, task.origin.specId]
                    .filter(Boolean)
                    .join(' · ') || '—'
                : '—'
            }
            mono
          />
          <InfoRow label={t('activity:taskIntel.taskId')} value={task.id} mono />
          <InfoRow label={t('activity:taskIntel.boardId')} value={board.id} mono />
        </Group>
      </div>
    </details>
  );
}
