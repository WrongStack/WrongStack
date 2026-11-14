import { describe, expect, it } from 'vitest';
import { HostShadowManager } from '../src/host-shadow-manager.js';

function makeDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('HostShadowManager dispose fencing', () => {
  it('drops queued microtask shadow passes after dispose()', async () => {
    let spawns = 0;
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
      spawnAndAssign: async () => {
        spawns++;
        return { subagentId: 's1', taskId: 't1' };
      },
    });

    manager.requestShadowPass('before dispose', 'sess-1');
    manager.dispose();
    await Promise.resolve();
    await Promise.resolve();
    expect(spawns).toBe(0);
  });

  it('does not schedule follow-up shadow passes when disposed mid-spawn', async () => {
    const spawnStarted = makeDeferred();
    const spawnRelease = makeDeferred();
    let spawns = 0;
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
      spawnAndAssign: async () => {
        spawns++;
        spawnStarted.resolve();
        await spawnRelease.promise;
        return { subagentId: 's2', taskId: 't2' };
      },
    });

    const passPromise = manager.runShadowPass('first failure', 'sess-2');
    await spawnStarted.promise;
    await manager.runShadowPass('queued failure', 'sess-2');
    manager.dispose();
    spawnRelease.resolve();
    await passPromise;
    await Promise.resolve();
    await Promise.resolve();
    expect(spawns).toBe(1);
  });
});
