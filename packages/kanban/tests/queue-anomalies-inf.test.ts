import { describe, expect, it } from 'vitest';
import { kanbanQueueAnomalyCount, kanbanQueueAnomalySignals } from '../src/queue-anomalies.js';
import type { KanbanQueueHealth } from '../src/types-operations.js';

function makeHealth(failed: number): KanbanQueueHealth {
  return {
    staleAssignments: { count: 0, taskIds: [] },
    failedRetryable: { count: 0, taskIds: [] },
    dependencyBlocked: { count: 0, taskIds: [] },
    heartbeatDue: { count: 0, taskIds: [] },
    counts: { failed, blocked: 0 },
  } as unknown as KanbanQueueHealth;
}

describe('kanbanQueueAnomalySignals non-finite count guard (F1981)', () => {
  it('ignores non-finite anomaly counts', () => {
    expect(kanbanQueueAnomalyCount(makeHealth(2))).toBe(2);
    expect(kanbanQueueAnomalyCount(makeHealth(Number.POSITIVE_INFINITY))).toBe(0);
    expect(kanbanQueueAnomalySignals(makeHealth(Number.POSITIVE_INFINITY))).toEqual([]);
  });
});
