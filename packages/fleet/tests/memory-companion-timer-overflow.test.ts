/**
 * F1212: the Memory Companion's review deadline comes from the `memory-curator`
 * roster budget, which a project may set larger than the default. The host
 * passed it to `setTimeout` unclamped, and Node/Bun fire a delay above
 * 2^31-1 ms after ~1 ms — every review was abandoned as soon as it began. Fake
 * timers model the same overflow (a delay above the maximum becomes 1 ms).
 */
import type { EventBus } from '@wrongstack/contracts/kernel';
import type { SubagentConfig } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/coordination';
import type { Sage, SageSurface } from '@wrongstack/sage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HostMemoryCompanion } from '../src/host-memory-companion.js';

function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(event: string, fn: (payload: unknown) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
      return () => {
        set?.delete(fn);
      };
    },
    emit(event: string, payload: unknown) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload);
    },
  } as unknown as EventBus;
}

const evidence = {
  files: [{ path: 'src/retry.ts', hash: 'hash1', text: 'export const MAX_RETRIES = 3;' }],
  unavailable: [] as string[],
  changedAnchor: true,
  fingerprint: 'hash1',
};

function record(id: string): Sage {
  return {
    id,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'stale',
    staleReason: 'verification',
    text: 'Retry budget uses MAX_RETRIES = 3.',
    importance: 0.7,
    confidence: 0.8,
    freshness: 0.4,
    tags: [],
    anchors: [{ type: 'file', path: 'src/retry.ts', contentHash: 'old' }],
    sources: [],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}

const instances: HostMemoryCompanion[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.stop();
  vi.useRealTimers();
});

function harness(rosterTimeoutMs: number) {
  const events = createEventBus();
  const assignInternal = vi.fn(async (_task: { id: string; timeoutMs?: number }) => {});
  const terminate = vi.fn(async (_id: string) => {});
  const director = {
    spawnCompanion: async (_cfg: SubagentConfig) => 'worker-1',
    assignInternal,
    terminate,
    status: () => ({ subagents: [{ id: 'worker-1' }] }),
    on: () => () => {},
  } as unknown as Director;
  const companion = new HostMemoryCompanion({
    projectRoot: '/project',
    director,
    events,
    // No `timeoutMs` input, as in production: the roster budget decides.
    roster: {
      'memory-curator': {
        name: 'Memory Curator',
        tools: ['read_file'],
        timeoutMs: rosterTimeoutMs,
      },
    },
    memory: () => ({ getSage: async (id: string) => record(id) }) as unknown as SageSurface,
    enabled: () => true,
    scrub: (t) => t,
    note: () => {},
    snapshot: async () => evidence,
  });
  instances.push(companion);
  companion.ensure('s1');
  events.emit('memory.injector_run', {
    sessionId: 's1',
    contextPressure: 0.2,
    injected: [{ id: 'm1' }],
    paths: [],
  } as never);
  return { assignInternal, terminate };
}

describe('Memory Companion review deadline above the timer maximum', () => {
  it('does not abandon the review at once when the roster budget exceeds 2^31-1 ms', async () => {
    vi.useFakeTimers();
    const h = harness(3_000_000_000);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    expect(h.assignInternal.mock.calls[0]![0]).toMatchObject({ timeoutMs: 3_000_000_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.terminate).not.toHaveBeenCalled();
  });

  it('still abandons a review that misses an ordinary deadline', async () => {
    vi.useFakeTimers();
    const h = harness(120_000);
    await vi.waitFor(() => expect(h.assignInternal).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(h.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.terminate).toHaveBeenCalledWith('worker-1');
  });
});
