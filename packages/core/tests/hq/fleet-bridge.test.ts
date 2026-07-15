import { describe, expect, it, vi } from 'vitest';
import type { HqFleetSnapshotPayload } from '../../src/hq/protocol.js';
import type { HqPublisher } from '../../src/hq/publisher.js';
import { startFleetTelemetryBridge } from '../../src/hq/fleet-bridge.js';
import { EventBus } from '../../src/kernel/events.js';

function fakePublisher(spy: ReturnType<typeof vi.fn>): HqPublisher {
  return {
    publishFleetSnapshot: (p: HqFleetSnapshotPayload) => {
      spy(p);
      return {} as never;
    },
  } as unknown as HqPublisher;
}

const baseStats = {
  total: 2,
  running: 1,
  idle: 1,
  stopped: 0,
  inFlight: 0,
  pending: 1,
  completed: 3,
  subagentStatuses: [
    { subagentId: 's1', taskId: 't1', status: 'running', assigned: true },
    { subagentId: 's2', taskId: 't2', status: 'idle', assigned: false },
  ],
};

describe('startFleetTelemetryBridge', () => {
  it('publishes a fleet.snapshot on coordinator.stats', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    const stop = startFleetTelemetryBridge({ events, publisher, runId: 'run-1', sessionId: 'sess-1' });
    events.emit('coordinator.stats', baseStats);
    expect(spy).toHaveBeenCalledTimes(1);
    const payload = spy.mock.calls[0]![0];
    expect(payload.runId).toBe('run-1');
    expect(payload.activeSubagents).toBe(2); // running + idle
    expect(payload.queuedTasks).toBe(1);
    expect(payload.completedTasks).toBe(3);
    expect(payload.failedTasks).toBe(0);
    expect(payload.subagents).toHaveLength(2);
    expect(payload.subagents[0].subagentId).toBe('s1');
    expect(payload.subagents[0].status).toBe('running');
    stop();
  });

  it('hash-dedups identical consecutive stats', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startFleetTelemetryBridge({ events, publisher, runId: 'run-1' });
    events.emit('coordinator.stats', baseStats);
    events.emit('coordinator.stats', baseStats); // identical → suppressed
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('republishes when stats change', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startFleetTelemetryBridge({ events, publisher, runId: 'run-1' });
    events.emit('coordinator.stats', baseStats);
    events.emit('coordinator.stats', { ...baseStats, completed: 4 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('disposer unsubscribes', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    const stop = startFleetTelemetryBridge({ events, publisher, runId: 'run-1' });
    stop();
    events.emit('coordinator.stats', baseStats);
    expect(spy).not.toHaveBeenCalled();
  });

  it('never throws on publisher failure', () => {
    const events = new EventBus();
    const publisher = {
      publishFleetSnapshot: () => {
        throw new Error('boom');
      },
    } as unknown as HqPublisher;
    const stop = startFleetTelemetryBridge({ events, publisher, runId: 'run-1' });
    expect(() => events.emit('coordinator.stats', baseStats)).not.toThrow();
    stop();
  });

  it('normalizes unknown subagent statuses to idle', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startFleetTelemetryBridge({ events, publisher, runId: 'run-1' });
    events.emit('coordinator.stats', {
      ...baseStats,
      subagentStatuses: [{ subagentId: 'sx', taskId: 'tx', status: 'weird-unknown', assigned: true }],
    });
    expect(spy.mock.calls[0]![0].subagents[0].status).toBe('idle');
  });

  it('forwards totalCostUsd and enriched per-subagent fields', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startFleetTelemetryBridge({ events, publisher, runId: 'run-1' });
    events.emit('coordinator.stats', {
      ...baseStats,
      totalCostUsd: 0.42,
      subagentStatuses: [
        {
          subagentId: 's1',
          taskId: 't1',
          status: 'running',
          assigned: true,
          model: 'claude-sonnet-4',
          costUsd: 0.12,
          runtimeMs: 45_000,
          lastActivityAt: '2026-07-14T10:00:00.000Z',
          iterations: 5,
          toolCalls: 8,
        },
      ],
    });
    const payload = spy.mock.calls[0]![0];
    expect(payload.totalCostUsd).toBe(0.42);
    const sub = payload.subagents[0];
    expect(sub.model).toBe('claude-sonnet-4');
    expect(sub.costUsd).toBe(0.12);
    expect(sub.runtimeMs).toBe(45_000);
    expect(sub.lastActivityAt).toBe('2026-07-14T10:00:00.000Z');
  });

  it('omits totalCostUsd when the source carries none', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startFleetTelemetryBridge({ events, publisher, runId: 'run-1' });
    events.emit('coordinator.stats', baseStats);
    expect(spy.mock.calls[0]![0].totalCostUsd).toBeUndefined();
  });
});
