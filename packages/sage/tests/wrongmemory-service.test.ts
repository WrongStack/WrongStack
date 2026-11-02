import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeWrongMemoryService, releaseWrongMemoryProject } from '../src/wrongmemory-service.js';

function fakeConnect(
  projects: Array<{ projectId: string; root: string; storeKind?: string }>,
  calls: string[],
) {
  return async (options: Record<string, unknown>) => {
    calls.push(`connect start=${String(options.start)}`);
    return {
      call: async (method: string, params: { projectId?: string }) => {
        calls.push(params?.projectId ? `${method} ${params.projectId}` : method);
        return method === 'project.list' ? { projects } : {};
      },
      close: () => calls.push('close'),
    } as never;
  };
}

describe('WrongMemory service helpers', () => {
  const root = path.resolve('some', 'project');

  it('reports a stopped daemon without starting one', async () => {
    const probe = await probeWrongMemoryService({
      projectRoot: root,
      connect: async () => {
        throw new Error('no daemon');
      },
    });
    expect(probe).toEqual({ running: false });
  });

  it('finds this project among the registered ones, never starting the daemon', async () => {
    const calls: string[] = [];
    const probe = await probeWrongMemoryService({
      projectRoot: root,
      connect: fakeConnect(
        [
          { projectId: 'p_other', root: path.resolve('elsewhere') },
          { projectId: 'p_me', root: `${root}${path.sep}`, storeKind: 'adopted' },
        ],
        calls,
      ),
    });
    expect(probe).toEqual({
      running: true,
      project: { projectId: 'p_me', storeKind: 'adopted', admission: undefined },
    });
    expect(calls).toEqual(['connect start=false', 'project.list', 'close']);
  });

  it('exports a managed store and detaches an adopted one', async () => {
    const calls: string[] = [];
    const connect = fakeConnect([], calls);
    await releaseWrongMemoryProject({
      project: { projectId: 'p_m', storeKind: 'managed' },
      connect,
    });
    await releaseWrongMemoryProject({
      project: { projectId: 'p_a', storeKind: 'adopted' },
      connect,
    });
    expect(calls.filter((c) => c.startsWith('project.'))).toEqual([
      'project.export p_m',
      'project.detach p_a',
    ]);
  });
});
