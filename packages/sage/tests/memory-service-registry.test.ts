import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSageMemoryPortForService } from '../src/memory-backend.js';
import { clearSageServiceBackends, sageServiceBackendFor } from '../src/memory-service-registry.js';
import {
  wrongMemoryPanelHealth,
  wrongMemoryServiceActionRefusal,
} from '../src/wrongmemory-service.js';

const distReady = existsSync(fileURLToPath(new URL('../dist/index.js', import.meta.url)));

function fakeConnect(running: boolean, projects: Array<Record<string, string>>) {
  return async () => {
    if (!running) throw new Error('no daemon');
    return {
      call: async () => ({ projects }),
      close: () => {},
    } as never;
  };
}

describe('memory service registry and WrongMemory panel surfaces', () => {
  let root: string;
  beforeEach(() => {
    clearSageServiceBackends();
    root = mkdtempSync(path.join(tmpdir(), 'wm-registry-'));
  });
  afterEach(() => {
    clearSageServiceBackends();
    rmSync(root, { recursive: true, force: true });
  });

  it('records the backend each port was created for', () => {
    createSageMemoryPortForService({
      projectRoot: root,
      service: { mode: 'wrongmemory', dataRoot: 'D:\\wm-home' },
    });
    expect(sageServiceBackendFor(root)).toEqual({
      backend: 'wrongmemory',
      dataRoot: 'D:\\wm-home',
    });
    const other = path.join(root, 'other');
    createSageMemoryPortForService({
      projectRoot: other,
      service: { mode: 'local' },
      createLocal: () => ({}) as never,
    });
    expect(sageServiceBackendFor(other)).toEqual({ backend: 'local', dataRoot: undefined });
    expect(sageServiceBackendFor(path.join(root, 'never-opened'))).toBeUndefined();
  });

  it('panels report WrongMemory instead of probing local SAGE', async () => {
    expect(await wrongMemoryPanelHealth(root, fakeConnect(true, []))).toBeUndefined();
    expect(wrongMemoryServiceActionRefusal(root)).toBeUndefined();

    createSageMemoryPortForService({ projectRoot: root, service: { mode: 'wrongmemory' } });
    expect(await wrongMemoryPanelHealth(root, fakeConnect(false, []))).toMatchObject({
      status: 'offline',
      detail: expect.stringMatching(/not running/),
    });
    expect(await wrongMemoryPanelHealth(root, fakeConnect(true, []))).toMatchObject({
      status: 'offline',
      detail: expect.stringMatching(/registered on first use/),
    });
    expect(
      await wrongMemoryPanelHealth(
        root,
        fakeConnect(true, [
          { projectId: 'p_1', root, storeKind: 'managed', admission: 'read-write' },
        ]),
      ),
    ).toEqual({
      status: 'healthy',
      mode: 'wrongmemory-service',
      detail: 'Served by WrongMemory: project p_1 (managed, read-write).',
    });
    expect(wrongMemoryServiceActionRefusal(root)).toMatch(/served by the WrongMemory service/);
  });

  it.skipIf(!distReady)(
    'never starts a local SAGE server for a project WrongMemory serves',
    async () => {
      const sage = (await import(
        pathToFileURL(fileURLToPath(new URL('../dist/index.js', import.meta.url))).href
      )) as typeof import('../src/index.js');
      sage.clearSageServiceBackends();
      sage.recordSageServiceBackend(root, 'wrongmemory');
      const conn = new sage.SageProjectServerConnection(root);
      try {
        await expect(conn.connect()).rejects.toMatchObject({ code: 'SAGE_SERVED_BY_WRONGMEMORY' });
      } finally {
        conn.close();
        sage.clearSageServiceBackends();
      }
      // Nothing was spawned: the store directory (and its daemon log) never appeared.
      expect(existsSync(path.join(root, '.wrongstack'))).toBe(false);
    },
  );
});
