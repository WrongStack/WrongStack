import { EventBus } from '@wrongstack/contracts/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFleetStatusBroadcaster } from '../src/status-broadcast.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createFleetStatusBroadcaster subagent.removed cleanup', () => {
  it('cancels pending coalesced timer when subagent.removed fires before flush', async () => {
    vi.useFakeTimers();
    const events = new EventBus();
    const sent: Array<{ from: string; subject: string }> = [];

    const broadcaster = createFleetStatusBroadcaster({
      events,
      sessionTag: () => 'sess-1',
      config: { minIntervalMsPerAgent: 15_000 },
      mailboxFactory: () =>
        ({
          registerAgent: async () => {},
          deregisterAgent: async () => {},
          heartbeat: async () => {},
          send: async (msg: { from: string; subject: string }) => {
            sent.push({ from: msg.from, subject: msg.subject });
          },
        }) as never,
    });

    broadcaster.start();
    events.emit('subagent.spawned', { subagentId: 's1', taskId: 't1', sessionId: 'sess-1' });
    const afterSpawn = sent.length;

    events.emit('subagent.task_completed', {
      subagentId: 's1',
      taskId: 't1',
      sessionId: 'sess-1',
      status: 'success',
      iterations: 1,
      toolCalls: 0,
      durationMs: 1_000,
    });
    events.emit('subagent.removed', { subagentId: 's1', sessionId: 'sess-1' });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(sent.length).toBe(afterSpawn);
    broadcaster.stop();
  });
});
