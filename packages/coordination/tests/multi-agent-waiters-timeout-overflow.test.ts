import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { awaitCoordinatorTasksAny } from '../src/multi-agent-waiters.js';

describe('multi-agent-waiters timeout chunking (F308)', () => {
  it('chunks timeoutMs > 2^31-1 ms instead of overflowing setTimeout', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const emitter = new EventEmitter();
      const promise = awaitCoordinatorTasksAny({
        emitter,
        taskIds: ['t1'],
        completedResultsById: new Map(),
        opts: { timeoutMs: 2_147_483_648 },
      });
      emitter.emit('task.completed', {
        task: { id: 't1' },
        result: { taskId: 't1', status: 'ok' },
      });
      const res = await promise;
      expect(res.completed).toHaveLength(1);
      const delays = setTimeoutSpy.mock.calls.map((c) => Number(c[1] ?? 0));
      expect(delays.length).toBeGreaterThan(0);
      expect(delays.every((d) => d >= 0 && d <= 2_147_483_647)).toBe(true);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
