import type { KanbanEvent, KanbanTask } from '@wrongstack/kanban';
import type { TFunction } from 'i18next';

export type TaskActivityFilter = 'all' | 'execution' | 'changes' | 'notes' | 'failures';

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

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown): string | undefined {
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

/** Catalog keys for the event titles below, by event type. */
const EVENT_TITLE_KEYS: Record<string, string> = {
  'task.created': 'activity:kanbanText.eventTitle.taskCreated',
  'task.copied': 'activity:kanbanText.eventTitle.taskCopied',
  'task.updated': 'activity:kanbanText.eventTitle.taskUpdated',
  'task.moved': 'activity:kanbanText.eventTitle.taskMoved',
  'task.assigned': 'activity:kanbanText.eventTitle.agentAssigned',
  'task.claimed': 'activity:kanbanText.eventTitle.taskClaimed',
  'task.released': 'activity:kanbanText.eventTitle.assignmentReleased',
  'task.assignment.updated': 'activity:kanbanText.eventTitle.assignmentUpdated',
  'task.assignment.running': 'activity:kanbanText.eventTitle.agentStarted',
  'task.assignment.completed': 'activity:kanbanText.eventTitle.agentCompleted',
  'task.assignment.failed': 'activity:kanbanText.eventTitle.agentRunFailed',
  'task.assignment.cancelled': 'activity:kanbanText.eventTitle.agentRunCancelled',
  'task.assignment.heartbeat': 'activity:kanbanText.eventTitle.agentHeartbeat',
  'task.note.added': 'activity:kanbanText.eventTitle.noteAdded',
  'task.check.added': 'activity:kanbanText.eventTitle.checkAdded',
  'task.check.updated': 'activity:kanbanText.eventTitle.checkUpdated',
  'task.metric.added': 'activity:kanbanText.eventTitle.metricAdded',
  'task.metric.updated': 'activity:kanbanText.eventTitle.metricUpdated',
  'task.lifecycle.transition': 'activity:kanbanText.eventTitle.lifecycleAdvanced',
  'task.assignment.snapshot': 'activity:kanbanText.eventTitle.assignmentObserved',
  'task.stale_recovered': 'activity:kanbanText.eventTitle.staleRecovered',
  'task.reconciled': 'activity:kanbanText.eventTitle.reconciled',
};

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** `t` gives the title in the display language; without it the title is English. */
export function eventTitle(event: KanbanEvent, t?: TFunction): string {
  if (event.type.startsWith('task.file.')) {
    const operation = titleCase(event.type.slice('task.file.'.length));
    return t
      ? t('activity:kanbanText.eventTitle.fileOperation', { operation })
      : `File ${operation}`;
  }
  if (event.type.startsWith('task.activity.')) {
    const kind = titleCase(event.type.slice('task.activity.'.length));
    return t ? t('activity:kanbanText.eventTitle.recordedKind', { kind }) : `Recorded ${kind}`;
  }
  const titleKey = t ? EVENT_TITLE_KEYS[event.type] : undefined;
  if (t && titleKey) return t(titleKey);
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

/** `t` gives the description in the display language; without it the text is English. */
export function eventDescription(event: KanbanEvent, t?: TFunction): string | undefined {
  const before = record(event.before);
  const after = record(event.after);
  const unknown = t ? t('activity:kanbanText.valueUnknown') : 'unknown';
  if (event.type.startsWith('task.file.')) {
    const filePath = text(after['filePath']);
    const toolName = text(after['toolName']);
    const durationMs = typeof after['durationMs'] === 'number' ? after['durationMs'] : undefined;
    const lines = typeof after['lines'] === 'number' ? after['lines'] : undefined;
    const lineCount =
      lines === undefined
        ? undefined
        : t
          ? t(
              lines === 1
                ? 'activity:kanbanText.lineCountOne'
                : 'activity:kanbanText.lineCountMany',
              { count: lines },
            )
          : `${lines} lines`;
    return (
      [
        filePath,
        toolName ? `tool:${toolName}` : undefined,
        durationMs !== undefined ? `${durationMs}ms` : undefined,
        lineCount,
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
    if (from || to) return `${from ?? unknown} → ${to ?? unknown}`;
  }
  if (event.type === 'task.updated') {
    const changes = eventFieldChanges(event);
    const fields = changes.map((change) => change.field).join(', ');
    if (changes.length && t) {
      return t(
        changes.length === 1
          ? 'activity:kanbanText.fieldsChangedOne'
          : 'activity:kanbanText.fieldsChangedMany',
        { count: changes.length, fields },
      );
    }
    if (changes.length)
      return `${changes.length} field${changes.length === 1 ? '' : 's'} changed: ${fields}`;
  }
  if (event.type === 'task.lifecycle.transition') {
    const from = text(before['stage']);
    const to = text(after['stage']);
    if (to) {
      if (from) return `${from} → ${to}`;
      return t ? t('activity:kanbanText.enteredStage', { stage: to }) : `Entered ${to}`;
    }
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

export function activityTone(event: KanbanEvent): string {
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

export function formatTimestamp(value: string): string {
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

export function compactValue(value: unknown, t?: TFunction): string {
  if (value === undefined) return t ? t('activity:kanbanText.valueUnset') : 'unset';
  if (value === null) return t ? t('activity:kanbanText.valueNone') : 'none';
  if (typeof value === 'string')
    return value || (t ? t('activity:kanbanText.valueEmpty') : 'empty');
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
