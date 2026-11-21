import { describe, expect, it } from 'vitest';
import { assertManagementWrite, managementTaskVersion } from '../src/management-fence.js';
import { StaleWriteError } from '../src/manager/lifecycle-error.js';
import type { KanbanBoard, KanbanTask } from '../src/types.js';

describe('assertManagementWrite lease expiry validation', () => {
  const task = {
    id: 't1',
    title: 'Fix auth',
    status: 'todo',
    columnId: 'todo',
    priority: 'high',
    type: 'task',
  } as unknown as KanbanTask;

  it('refuses non-finite or non-numeric lease.expiresAt values instead of treating them as unexpired', () => {
    for (const badExpiry of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const board = {
        id: 'b1',
        tasks: [task],
        management: { lease: { token: 'tok-1', expiresAt: badExpiry } },
      } as unknown as KanbanBoard;

      expect(() =>
        assertManagementWrite(board, [task], {
          sessionId: 'session-test',
          expectedManagementToken: 'tok-1',
          expectedManagementTaskVersions: { t1: managementTaskVersion(board, task) },
        }),
      ).toThrow(StaleWriteError);
    }
  });
});
