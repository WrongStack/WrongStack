/**
 * F1155 — `DirectorTaskRegistry.awaitTasksAny` must honour a `timeoutMs`
 * window larger than setTimeout's 2^31-1 ms ceiling. Node and Bun clamp an
 * overflowing delay to ~1 ms, which made `await_tasks({mode:'any',
 * timeoutMs})` (schema: minimum 1, no maximum) report `timedOut: true` with
 * zero completions almost immediately instead of waiting.
 */
import type { TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectorTaskRegistry } from '../src/director/director-task-registry.js';

const MAX_TIMER_MS = 2_147_483_647;

function makeRegistry(): DirectorTaskRegistry {
  return new DirectorTaskRegistry({
    coordinator: {
      assign: vi.fn(async () => {}),
      listPendingTasks: vi.fn(() => [] as TaskSpec[]),
      retargetPendingTask: vi.fn(() => true),
    },
    stateCheckpoint: null,
    isWorkComplete: () => false,
    addTaskToManifest: vi.fn(),
    recordPendingTask: vi.fn(),
    appendSessionEvent: vi.fn(async () => {}),
    scheduleManifest: vi.fn(),
    getSubagentMeta: () => undefined,
  });
}

describe('DirectorTaskRegistry.awaitTasksAny timeout overflow (F1155)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps waiting when timeoutMs exceeds the 32-bit timer ceiling', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const registry = makeRegistry();
    let settled: unknown = 'pending';
    void registry.awaitTasksAny(['t-1'], { timeoutMs: 3_000_000_000 }).then((r) => {
      settled = r;
    });

    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays.length).toBeGreaterThan(0);
    for (const delay of delays) expect(delay).toBeLessThanOrEqual(MAX_TIMER_MS);

    // An overflowing delay fires after ~1 ms; give it ample room to misfire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe('pending');
    registry.resolveWaitersOnShutdown();
  });

  it('still times out on an in-range window', async () => {
    const registry = makeRegistry();
    const result = await registry.awaitTasksAny(['t-2'], { timeoutMs: 5 });
    expect(result).toEqual({ completed: [], pending: ['t-2'], timedOut: true });
  });
});
