import { entries, record } from './engine-values';

export interface HealthTask {
  id: string;
  title: string;
}
export interface HealthIssue {
  key: 'staleAssignments' | 'dependencyBlocked' | 'failedRetryable' | 'heartbeatDue' | 'parked';
  label: string;
  hint: string;
  count: number;
  tasks: HealthTask[];
}
export interface BoardHealth {
  counts: { label: string; value: number }[];
  issues: HealthIssue[];
  lastDispatchedAt: string;
  lastStaleRecoveredAt: string;
}

const COUNTS: [string, string][] = [
  ['startable', 'Ready to start'],
  ['queued', 'Queued'],
  ['running', 'Running'],
  ['review', 'In review'],
  ['blocked', 'Blocked'],
  ['failed', 'Failed'],
];
const ISSUES: [HealthIssue['key'], string, string][] = [
  [
    'staleAssignments',
    'Expired assignments',
    'Queued or running cards whose worker lease has lapsed. An audit returns them to the queue.',
  ],
  [
    'heartbeatDue',
    'Leases about to lapse',
    'Running cards whose worker has not renewed its lease recently.',
  ],
  ['dependencyBlocked', 'Waiting on dependencies', 'Cards that cannot start until others finish.'],
  ['failedRetryable', 'Failed · retries left', 'Failed cards that still have attempts remaining.'],
  [
    'parked',
    'Parked after verification',
    'Cards the completion gate refused until their verification budget ran out.',
  ],
];

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

/** Queue health as the engine computed it; an absent bucket counts as zero, never as checked. */
export function boardHealth(value: unknown): BoardHealth {
  const health = record(value);
  const counts = record(health['counts']);
  return {
    counts: COUNTS.map(([key, label]) => ({ label, value: count(counts[key]) })),
    issues: ISSUES.flatMap(([key, label, hint]) => {
      const bucket = record(health[key]);
      const tasks = entries(bucket['tasks']).flatMap((item) => {
        const task = record(item['task']);
        return typeof task['id'] === 'string'
          ? [{ id: task['id'], title: String(task['title'] ?? task['id']) }]
          : [];
      });
      const total = Math.max(count(bucket['count']), tasks.length);
      return total ? [{ key, label, hint, count: total, tasks }] : [];
    }),
    lastDispatchedAt:
      typeof health['lastDispatchedAt'] === 'string' ? health['lastDispatchedAt'] : '',
    lastStaleRecoveredAt:
      typeof health['lastStaleRecoveredAt'] === 'string' ? health['lastStaleRecoveredAt'] : '',
  };
}

/** What an audit reported doing; null when the reply carries no audit result. */
export function auditOutcome(value: unknown) {
  const audit = record(value);
  if (typeof audit['status'] !== 'string') return null;
  const ids = (key: string) =>
    Array.isArray(audit[key]) ? audit[key].filter((id) => typeof id === 'string') : [];
  return {
    status: audit['status'],
    summary: typeof audit['summary'] === 'string' ? audit['summary'] : '',
    reconciled: ids('reconciledTaskIds').length,
    recovered: ids('staleRecoveredTaskIds').length,
    anomalies: count(audit['anomalyCount']),
    error: typeof audit['error'] === 'string' ? audit['error'] : '',
  };
}

export function auditMessage(outcome: NonNullable<ReturnType<typeof auditOutcome>>) {
  const status =
    outcome.status === 'healthy'
      ? 'Queue healthy'
      : outcome.status === 'disabled'
        ? 'Supervisor disabled for this board'
        : outcome.status === 'error'
          ? `Audit failed${outcome.error ? `: ${outcome.error}` : ''}`
          : outcome.status === 'running'
            ? 'An audit is already running'
            : outcome.status === 'attention'
              ? `Needs attention · ${outcome.anomalies} ${outcome.anomalies === 1 ? 'issue' : 'issues'}`
              : `Status: ${outcome.status}`;
  return `${status} · ${outcome.reconciled} cards reconciled · ${outcome.recovered} expired assignments returned to the queue`;
}
