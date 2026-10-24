/**
 * A shadow review is requested from an event handler, so nothing awaits it.
 *
 * `HostShadowManager.requestShadowPass` runs `void this.runShadowPass(...)`
 * inside `queueMicrotask`, triggered by an ordinary event — a subagent task
 * ending `failed`. `runHostShadowPass` only swallows `FleetSpawnBudgetError`
 * and rethrows everything else from `spawnAndAssign`. The director rejects a
 * spawn for other everyday reasons too: the fleet cost cap
 * (`FleetCostCapError`), the token cap, leader context pressure, or
 * `assignInternal` failing. Those reached the process as an unhandled
 * rejection: one failed task in a fleet that has hit its spend cap.
 *
 * These cases fire the real event path and observe the process-level
 * `unhandledRejection` event.
 */

import { EventBus } from '@wrongstack/contracts/kernel';
import type { ConfigStore, SessionWriter } from '@wrongstack/contracts/types';
import { FleetCostCapError, FleetSpawnBudgetError } from '@wrongstack/core/coordination';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostShadowManager } from '../../src/fleet/host-shadow-manager.js';
import type { MultiAgentDeps, MultiAgentHostOptions } from '../../src/fleet/host-types.js';

function managerWith(spawnError: () => Error): { events: EventBus; attempts: () => number } {
  const events = new EventBus();
  let attempts = 0;
  const manager = new HostShadowManager({
    deps: {
      events,
      session: { id: 'boot-session' } as unknown as SessionWriter,
      configStore: { get: () => ({ provider: 'mock', model: 'm' }) } as unknown as ConfigStore,
    } as unknown as MultiAgentDeps,
    opts: {} as MultiAgentHostOptions,
    getDirector: () =>
      ({
        isWorkComplete: () => false,
        coordinator: { getStatus: () => ({ subagents: [] }), stop: async () => undefined },
      }) as never,
    // A plain async function, not `vi.fn`: the spy wrapper attaches its own
    // handler to the promise it returns, which would hide the rejection.
    spawnAndAssign: async () => {
      attempts += 1;
      throw spawnError();
    },
  });
  manager.armIfNeeded();
  return { events, attempts: () => attempts };
}

function failTask(events: EventBus): void {
  events.emit('subagent.task_started', { subagentId: 'w1', taskId: 't1' });
  events.emit('subagent.task_completed', {
    subagentId: 'w1',
    taskId: 't1',
    status: 'failed',
    iterations: 1,
    toolCalls: 0,
    durationMs: 5,
  });
}

/** Microtask → async spawn rejection → Node's unhandled-rejection checkpoint. */
async function unhandledDuring(action: () => void): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    action();
    for (let turn = 0; turn < 3; turn++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HostShadowManager shadow-pass failures', () => {
  it('does not leak a rejection when the fleet cost cap refuses the reviewer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = managerWith(() => new FleetCostCapError(1, 2));
    const seen = await unhandledDuring(() => failTask(h.events));
    expect(h.attempts()).toBe(1);
    expect(seen).toEqual([]);
  });

  it('does not leak a rejection when assigning the reviewer fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const h = managerWith(() => new Error('coordinator stopped'));
    const seen = await unhandledDuring(() => failTask(h.events));
    expect(seen).toEqual([]);
  });

  it('still treats a closed spawn budget as a quiet no-op (control)', async () => {
    const h = managerWith(() => new FleetSpawnBudgetError('max_spawns', 1, 2));
    const seen = await unhandledDuring(() => failTask(h.events));
    expect(h.attempts()).toBe(1);
    expect(seen).toEqual([]);
  });
});
