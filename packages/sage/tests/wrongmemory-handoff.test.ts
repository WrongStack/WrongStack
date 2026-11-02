import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handOffSageToWrongMemory } from '../src/wrongmemory-handoff.js';

/** Unit-level handoff checks with an injected client and local owner (no daemon). */
describe('handOffSageToWrongMemory', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wm-handoff-'));
    mkdirSync(path.join(root, '.wrongstack', 'memories'), { recursive: true });
    writeFileSync(path.join(root, '.wrongstack', 'memories', 'sage.db'), '');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function owner(alive = true) {
    const state = { alive, shutdowns: [] as unknown[] };
    return {
      state,
      local: {
        status: async () => (state.alive ? { pid: 1 } : null),
        shutdown: async (reason?: string) => {
          state.shutdowns.push(reason);
          state.alive = false;
          return { stopped: true };
        },
      },
    };
  }

  function client(calls: Array<{ method: string; params: unknown }>) {
    return async (options: { start?: boolean; daemonPath?: string }) => {
      calls.push({ method: 'connect', params: options });
      return {
        call: async (method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === 'project.register') {
            return { project: { projectId: 'p_1', admission: 'read-write' } };
          }
          return {};
        },
        close: () => {},
      } as never;
    };
  }

  it('without apply returns the plan and touches nothing', async () => {
    const { state, local } = owner();
    const calls: Array<{ method: string; params: unknown }> = [];
    const report = await handOffSageToWrongMemory({
      projectRoot: root,
      service: { mode: 'wrongmemory' },
      apply: false,
      local,
      connect: client(calls),
    });
    expect(report).toMatchObject({ applied: false, localServerRunning: true });
    expect(report.steps[0]).toMatch(/stop the running SAGE project server/);
    expect(state.shutdowns).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('reaches WrongMemory first and leaves the local owner alone when it cannot', async () => {
    const { state, local } = owner();
    await expect(
      handOffSageToWrongMemory({
        projectRoot: root,
        service: { mode: 'wrongmemory', startPolicy: 'never' },
        apply: true,
        local,
        connect: async () => {
          throw Object.assign(new Error('no daemon'), { code: 'UNAVAILABLE' });
        },
      }),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(state.shutdowns).toEqual([]);
    expect(state.alive).toBe(true);
  });

  it('starts the daemon per policy, stops the local owner, then adopts the store', async () => {
    const { state, local } = owner();
    const calls: Array<{ method: string; params: unknown }> = [];
    const report = await handOffSageToWrongMemory({
      projectRoot: root,
      service: { mode: 'wrongmemory', daemonPath: 'C:\\wm\\wrongmemoryd.exe' },
      apply: true,
      local,
      connect: client(calls),
    });
    expect(calls[0]).toMatchObject({
      method: 'connect',
      params: { start: true, daemonPath: 'C:\\wm\\wrongmemoryd.exe' },
    });
    expect(state.shutdowns).toEqual(['handoff-to-wrongmemory']);
    expect(calls.map((c) => c.method)).toEqual(['connect', 'project.register', 'memory.stats']);
    expect(calls[1]!.params).toMatchObject({ storeKind: 'adopted', write: true });
    expect(report).toMatchObject({
      applied: true,
      localServerStopped: true,
      projectId: 'p_1',
      admission: 'read-write',
    });
  });

  it('refuses a custom storage directory and a missing store', async () => {
    await expect(
      handOffSageToWrongMemory({
        projectRoot: root,
        directory: 'custom/memories',
        service: undefined,
        apply: false,
      }),
    ).rejects.toThrow(/not supported for a handoff/);
    rmSync(path.join(root, '.wrongstack', 'memories', 'sage.db'));
    await expect(
      handOffSageToWrongMemory({ projectRoot: root, service: undefined, apply: false }),
    ).rejects.toThrow(/no SAGE store/);
  });
});
