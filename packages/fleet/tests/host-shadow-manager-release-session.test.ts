import { describe, expect, it } from 'vitest';
import { HostShadowManager } from '../src/host-shadow-manager.js';

function makeDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('HostShadowManager releaseSession fencing', () => {
  it('cancels queued microtask passes for a released session while keeping other sessions and later re-runs active', async () => {
    const spawnsByTab = new Map<string, number>();
    const manager = new HostShadowManager({
      deps: {
        session: { id: 'boot' },
        configStore: { get: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-6' }) },
        events: { on: () => () => {} },
      } as never,
      opts: {},
      getDirector: () =>
        ({
          isWorkComplete: () => false,
          coordinator: { getStatus: () => ({ subagents: [] }), stop: async () => {} },
        }) as never,
      spawnAndAssign: async (cfg) => {
        const sid = cfg.originSessionId ?? 'boot';
        const next = (spawnsByTab.get(sid) ?? 0) + 1;
        spawnsByTab.set(sid, next);
        return { subagentId: `s-${sid}-${next}`, taskId: `t-${sid}-${next}` };
      },
    });

    manager.requestShadowPass('failed turn', 'tab-closed');
    manager.requestShadowPass('failed turn', 'tab-live');
    manager.releaseSession('tab-closed');
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnsByTab.get('tab-closed') ?? 0).toBe(0);
    expect(spawnsByTab.get('tab-live') ?? 0).toBe(1);

    // Subsequent run in the same session ID creates a fresh state and spawns normally
    manager.requestShadowPass('new run failed', 'tab-closed');
    await Promise.resolve();
    await Promise.resolve();
    expect(spawnsByTab.get('tab-closed')).toBe(1);
    manager.dispose();
  });

  it('drops mid-spawn follow-ups and stopShadowAfterTask continuations when releaseSession runs', async () => {
    const spawnStarted = makeDeferred();
    const spawnRelease = makeDeferred();
    const stopRelease = makeDeferred();
    let sub3Active = true;
    const spawnsByTab = new Map<string, number>();
    let manager!: HostShadowManager;

    manager = new HostShadowManager({
      deps: {
        session: { id: 'boot' },
        configStore: { get: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-6' }) },
        events: { on: () => () => {} },
      } as never,
      opts: {},
      getDirector: () =>
        ({
          isWorkComplete: () => false,
          coordinator: {
            getStatus: () => ({
              subagents: sub3Active ? [{ id: 'sub-3', status: 'running' }] : [],
            }),
            stop: async (id: string) => {
              if (id === 'sub-3') {
                sub3Active = false;
                await stopRelease.promise;
              }
            },
          },
        }) as never,
      spawnAndAssign: async (cfg, _desc, opts) => {
        const sid = cfg.originSessionId ?? 'boot';
        const next = (spawnsByTab.get(sid) ?? 0) + 1;
        spawnsByTab.set(sid, next);
        const subagentId = `sub-${sid}-${next}`;
        const taskId = `task-${sid}-${next}`;
        if (sid === 'tab-mid' && next === 1) {
          spawnStarted.resolve();
          await spawnRelease.promise;
          manager.markShadowTask(taskId, sid);
          if (opts?.stopShadowAfterTask) manager.addStopAfterTaskId(taskId, sid);
          manager.recordShadowAgent(subagentId, taskId, opts?.shadowIntervalMs, sid);
        }
        return { subagentId, taskId };
      },
    });

    const pass = manager.runShadowPass('first failure', 'tab-mid');
    await spawnStarted.promise;
    await manager.runShadowPass('queued failure', 'tab-mid');
    manager.releaseSession('tab-mid');
    spawnRelease.resolve();
    await pass;
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnsByTab.get('tab-mid')).toBe(1);
    expect(manager.getAgentId('tab-mid')).toBeNull();
    expect(manager.isShadowTask('task-tab-mid-1')).toBe(false);

    manager.recordShadowAgent('sub-3', 'task-3', 30_000, 'tab-stop');
    manager.addStopAfterTaskId('task-3', 'tab-stop');
    await manager.runShadowPass('queued while shadow active', 'tab-stop');
    manager.onShadowTaskCompleted('task-3', 'sub-3');
    manager.releaseSession('tab-stop');
    stopRelease.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(spawnsByTab.get('tab-stop') ?? 0).toBe(0);
    const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
    expect(sessions.has('tab-mid')).toBe(false);
    expect(sessions.has('tab-stop')).toBe(false);
    manager.dispose();
  });
});
