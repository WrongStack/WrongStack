import type { EventBus } from '@wrongstack/contracts/kernel';
import type { SubagentConfig, TaskResult } from '@wrongstack/contracts/types';
import type { Director } from '@wrongstack/coordination';
import type { Sage, SageSurface } from '@wrongstack/sage';
import { afterEach, describe, expect, it } from 'vitest';
import { HostMemoryCompanion } from '../src/host-memory-companion.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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
      for (const fn of [...(listeners.get(event) ?? [])]) {
        fn(payload);
      }
    },
  } as unknown as EventBus;
}

async function flushAsync(turns = 32): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

const quote = 'export const MAX_RETRIES = 3;';
const evidence = {
  files: [{ path: 'src/retry.ts', hash: 'hash1', text: quote }],
  unavailable: [] as string[],
  changedAnchor: true,
  fingerprint: 'hash1',
};

function makeRecord(id: string): Sage {
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

describe('HostMemoryCompanion session termination and context-pressure pause fencing', () => {
  const instances: HostMemoryCompanion[] = [];

  afterEach(() => {
    for (const instance of instances.splice(0)) {
      instance.stop();
    }
  });

  it('fences pre-termination getSage/retrieveForPath/spawn continuations on onSessionTerminate without starving later turns', async () => {
    const events = createEventBus();
    const getSageGate = deferred<Sage | null>();
    const retrieveGate = deferred<Sage[]>();
    let gateIo = true;
    let terminateListener: ((sessionId: string) => void) | undefined;
    const spawns: SubagentConfig[] = [];
    const assignments: Array<{ id: string; subagentId: string; description: string }> = [];
    const notes: Array<{ sessionId: string; subject: string }> = [];

    const director = {
      spawnCompanion: async (cfg: SubagentConfig) => {
        spawns.push(cfg);
        return 'worker-1';
      },
      assignInternal: async (task: { id: string; subagentId: string; description: string }) => {
        assignments.push(task);
      },
      terminate: async () => {},
      status: () => ({ subagents: [{ id: 'worker-1' }] }),
      on: () => () => {},
      onSessionTerminate: (cb: (sessionId: string) => void) => {
        terminateListener = cb;
        return () => {};
      },
    } as unknown as Director;

    const companion = new HostMemoryCompanion({
      projectRoot: '/project',
      director,
      events,
      roster: { 'memory-curator': { name: 'Memory Curator', tools: ['read_file'] } },
      memory: () =>
        ({
          getSage: (id: string) => (gateIo ? getSageGate.promise : Promise.resolve(makeRecord(id))),
          retrieveForPath: () => (gateIo ? retrieveGate.promise : Promise.resolve([])),
        }) as unknown as SageSurface,
      enabled: () => true,
      scrub: (t) => t,
      note: (sessionId, subject) => notes.push({ sessionId, subject }),
      snapshot: async () => evidence,
      timeoutMs: 5_000,
    });
    instances.push(companion);

    companion.ensure('s-term');
    events.emit('memory.injector_run', {
      sessionId: 's-term',
      contextPressure: 0.2,
      injected: [{ id: 'm-inflight' }],
      paths: ['src/retry.ts'],
    } as never);
    await flushAsync(4);

    terminateListener?.('s-term');
    retrieveGate.resolve([makeRecord('m-stale-path')]);
    getSageGate.resolve(makeRecord('m-inflight'));
    await flushAsync();

    expect(spawns).toHaveLength(0);
    expect(assignments).toHaveLength(0);
    expect(notes.filter((n) => n.sessionId === 's-term')).toHaveLength(0);

    // Later turn on the same session still probes without re-calling ensure()
    gateIo = false;
    events.emit('memory.injector_run', {
      sessionId: 's-term',
      contextPressure: 0.2,
      injected: [{ id: 'm-after-resume' }],
      paths: [],
    } as never);
    await flushAsync();

    expect(assignments).toHaveLength(1);
    expect(assignments[0]?.description).toContain('m-after-resume');
  });

  it('suppresses post-completion review and unverifiable notes if contextPressure pauses the session mid-review', async () => {
    const events = createEventBus();
    let completedListener: ((ev: { result: TaskResult }) => void) | undefined;
    const assignments: Array<{ id: string; subagentId: string; description: string }> = [];
    const notes: Array<{ sessionId: string; subject: string }> = [];

    const director = {
      spawnCompanion: async () => 'worker-1',
      assignInternal: async (task: { id: string; subagentId: string; description: string }) => {
        assignments.push(task);
      },
      terminate: async () => {},
      status: () => ({ subagents: [{ id: 'worker-1' }] }),
      on: (_ev: string, cb: (ev: { result: TaskResult }) => void) => {
        completedListener = cb;
        return () => {};
      },
    } as unknown as Director;

    const companion = new HostMemoryCompanion({
      projectRoot: '/project',
      director,
      events,
      roster: { 'memory-curator': { name: 'Memory Curator', tools: ['read_file'] } },
      memory: () => ({ getSage: async (id: string) => makeRecord(id) }) as unknown as SageSurface,
      enabled: () => true,
      scrub: (t) => t,
      note: (sessionId, subject) => notes.push({ sessionId, subject }),
      snapshot: async () => evidence,
      timeoutMs: 5_000,
    });
    instances.push(companion);

    companion.ensure('s-pause');
    events.emit('memory.injector_run', {
      sessionId: 's-pause',
      contextPressure: 0.3,
      injected: [{ id: 'm1' }],
      paths: [],
    } as never);
    await flushAsync();
    expect(assignments).toHaveLength(1);
    notes.length = 0;

    // Leader reaches high context pressure (>= 0.82) while worker is running
    events.emit('memory.injector_run', {
      sessionId: 's-pause',
      contextPressure: 0.9,
      injected: [],
      paths: [],
    } as never);

    completedListener?.({
      result: {
        taskId: assignments[0]!.id,
        subagentId: 'worker-1',
        status: 'success',
        result: JSON.stringify({
          verdict: 'supported',
          summary: 'MAX_RETRIES remains 3.',
          evidence: [{ path: 'src/retry.ts', quote }],
        }),
      } as TaskResult,
    });
    await flushAsync();

    expect(
      notes.filter((n) => n.subject === '[memory:review]' || n.subject === '[memory:unverifiable]'),
    ).toHaveLength(0);
  });
});
