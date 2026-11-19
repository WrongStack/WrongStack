import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ mode: 'sync-throw' as 'sync-throw' | 'ok' }));

vi.mock('@wrongstack/tools', () => ({
  fileGraphService: async () => ({ nodes: [], edges: [] }),
  packageGraphService: async () => ({ nodes: [], edges: [] }),
  symbolGraphService: async () => ({ nodes: [], edges: [] }),
  getIndexState: () => ({ phase: 'idle' }),
  runStartupIndex: () => {
    if (state.mode === 'sync-throw') throw new Error('sync index startup crash');
    return Promise.resolve({ filesIndexed: 2 });
  },
}));

const { handleCodemapIndex } = await import('../src/server/codemap-handlers.js');

function fakeRes() {
  let status = 0;
  let body = '';
  const res = {
    writeHead(s: number) {
      status = s;
    },
    end(chunk: string) {
      body = chunk;
    },
  } as never;
  return {
    res,
    read: () => ({ status, json: body ? (JSON.parse(body) as Record<string, unknown>) : null }),
  };
}

describe('handleCodemapIndex sync-throw recovery and indexDir isolation', () => {
  it('transitions job to error on synchronous runStartupIndex throw and allows monotonic retries', async () => {
    state.mode = 'sync-throw';
    const deps = { projectRoot: '/repo-sync-test', indexDir: '/idx-a' };

    const r1 = fakeRes();
    expect(() => handleCodemapIndex(r1.res, deps, true)).not.toThrow();
    expect(r1.read().status).toBe(202);
    const firstStartedAt = Number(r1.read().json?.['startedAt']);

    for (let i = 0; i < 6; i++) await Promise.resolve();

    const st1 = fakeRes();
    handleCodemapIndex(st1.res, deps, false);
    expect(st1.read().json?.['status']).toBe('error');

    state.mode = 'ok';
    const r2 = fakeRes();
    handleCodemapIndex(r2.res, deps, true);
    expect(Number(r2.read().json?.['startedAt'])).toBeGreaterThan(firstStartedAt);

    for (let i = 0; i < 6; i++) await Promise.resolve();

    const st2 = fakeRes();
    handleCodemapIndex(st2.res, deps, false);
    expect(st2.read().json?.['status']).toBe('ready');

    const stOther = fakeRes();
    handleCodemapIndex(stOther.res, { projectRoot: '/repo-sync-test', indexDir: '/idx-b' }, false);
    expect(stOther.read().json?.['status']).toBeUndefined();
  });
});
