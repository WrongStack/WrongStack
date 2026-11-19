// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { useCodeMapGraphLoader } from '../src/atlas/use-code-map-graph-loader.js';
import { SurfaceHostProvider } from '../src/host.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeGraph(nodeId: string) {
  return {
    scope: { level: 'files', package: 'pkg-a' },
    nodes: [{ id: nodeId, label: nodeId, kind: 'file' }],
    edges: [],
    stats: { totalFiles: 1, totalSymbols: 0, totalEdges: 0 },
  };
}

describe('useCodeMapGraphLoader branch dedup and retry/unmount cancellation (F564)', () => {
  it('deduplicates same-tick ensureBranch calls and blocks stale pre-retry or post-unmount cache writes', async () => {
    (globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;
    const branchResolvers: Array<Deferred<Response>> = [];
    let branchFetchCount = 0;

    const host = {
      getClient: () => null,
      fetch: (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('pkg-a') || url.includes('pkg-b')) {
          branchFetchCount += 1;
          const d = deferred<Response>();
          branchResolvers.push(d);
          return d.promise;
        }
        return Promise.resolve(
          new Response(JSON.stringify(makeGraph('root-node')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    } as never;

    let latest: ReturnType<typeof useCodeMapGraphLoader> | null = null;
    const rootScope = { level: 'packages' } as const;
    const t = ((_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? '') as never;
    const noopSetSelected = (() => undefined) as never;
    const noopResolve = (() => undefined) as never;
    const emptyOps: never[] = [];

    function Harness() {
      const pendingSelection = useRef<string | null>(null);
      latest = useCodeMapGraphLoader({
        scope: rootScope,
        currentScopeKey: 'packages',
        t,
        pendingSelection,
        setSelectedId: noopSetSelected,
        activeOperations: emptyOps,
        resolveActivitySymbol: noopResolve,
      });
      return null;
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <SurfaceHostProvider host={host}>
          <Harness />
        </SurfaceHostProvider>,
      );
    });

    await act(async () => {
      void latest!.ensureBranch({ level: 'files', package: 'pkg-a' });
      void latest!.ensureBranch({ level: 'files', package: 'pkg-a' });
    });
    expect(branchFetchCount).toBe(1);

    await act(async () => {
      latest!.retry();
    });
    await act(async () => {
      branchResolvers[0]!.resolve(
        new Response(JSON.stringify(makeGraph('stale-node')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await Promise.resolve();
    });
    expect(latest!.packageGraph('pkg-a')).toBeUndefined();

    await act(async () => {
      void latest!.ensureBranch({ level: 'files', package: 'pkg-a' });
    });
    expect(branchFetchCount).toBe(2);
    await act(async () => {
      branchResolvers[1]!.resolve(
        new Response(JSON.stringify(makeGraph('fresh-node')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      await Promise.resolve();
    });
    expect(latest!.packageGraph('pkg-a')?.nodes[0]?.id).toBe('fresh-node');

    let unmountPromise!: Promise<void>;
    await act(async () => {
      unmountPromise = latest!.ensureBranch({ level: 'files', package: 'pkg-b' });
    });
    await act(async () => {
      root.unmount();
    });
    branchResolvers[2]!.resolve(
      new Response(JSON.stringify(makeGraph('post-unmount-node')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(unmountPromise).resolves.toBeUndefined();
    container.remove();
  });
});
