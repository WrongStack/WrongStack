import { describe, expect, it } from 'vitest';
import { auditMessage, auditOutcome, boardHealth } from '../src/kanban-health';

const result = (id: string, title: string) => ({ board: { id: 'b1' }, task: { id, title } });

describe('kanban queue health', () => {
  it('reads counts and lists only the problems the engine reported', () => {
    const health = boardHealth({
      counts: { startable: 3, ready: 0, queued: 1, running: 2, review: 1, blocked: 0, failed: 1 },
      staleAssignments: { count: 1, tasks: [result('t1', 'Expired card')] },
      dependencyBlocked: { count: 0, tasks: [] },
      failedRetryable: { count: 2, tasks: [result('t2', 'Retry me')] },
      heartbeatDue: { count: 0, tasks: [] },
      lastDispatchedAt: '2026-10-30T10:00:00.000Z',
    });
    expect(health.counts.find((item) => item.label === 'Ready to start')?.value).toBe(3);
    expect(health.issues.map((issue) => [issue.key, issue.count])).toEqual([
      ['staleAssignments', 1],
      ['failedRetryable', 2],
    ]);
    expect(health.issues[1]?.tasks).toEqual([{ id: 't2', title: 'Retry me' }]);
    expect(health.lastDispatchedAt).toBe('2026-10-30T10:00:00.000Z');
  });
  it('treats absent or malformed buckets as zero', () => {
    const health = boardHealth({ counts: { running: -1, failed: 'x' }, parked: null });
    expect(health.counts.every((item) => item.value === 0)).toBe(true);
    expect(health.issues).toEqual([]);
  });
  it('describes what an audit reported, including failures', () => {
    const healthy = auditOutcome({
      status: 'healthy',
      reconciledTaskIds: ['a'],
      staleRecoveredTaskIds: [],
      anomalyCount: 0,
    });
    expect(auditMessage(healthy!)).toBe(
      'Queue healthy · 1 cards reconciled · 0 expired assignments returned to the queue',
    );
    const attention = auditOutcome({
      status: 'attention',
      reconciledTaskIds: [],
      staleRecoveredTaskIds: ['x', 'y'],
      anomalyCount: 1,
    });
    expect(auditMessage(attention!)).toMatch(/^Needs attention · 1 issue · .* 2 expired/);
    const failed = auditOutcome({ status: 'error', error: 'board locked', anomalyCount: 0 });
    expect(auditMessage(failed!)).toMatch(/^Audit failed: board locked/);
    expect(auditOutcome({ removed: true })).toBeNull();
  });
});
