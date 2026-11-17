/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchCodeMapGraph = vi.fn();
let indexGen = 0;

vi.mock('../src/atlas/fetch-code-map-graph.js', () => ({
  fetchCodeMapGraph,
}));

vi.mock('../src/atlas/codemap-index-store.js', () => ({
  useCodemapIndexStore: (selector: (s: { generation: number }) => number) =>
    selector({ generation: indexGen }),
}));

const { useCodeMapGraphLoader } = await import('../src/atlas/use-code-map-graph-loader.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let latestHook: ReturnType<typeof useCodeMapGraphLoader> | null = null;
const EMPTY_OPS: never[] = [];
const PACKAGES_SCOPE = { level: 'packages' } as const;
const tFn = (_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _k;
const pendingSelectionRef = { current: null as string | null };
const noopSetSelected = () => {};
const noopResolveSymbol = async () => null;
function Harness() {
  latestHook = useCodeMapGraphLoader({
    scope: PACKAGES_SCOPE,
    currentScopeKey: 'packages',
    t: tFn as never,
    pendingSelection: pendingSelectionRef,
    setSelectedId: noopSetSelected,
    activeOperations: EMPTY_OPS,
    resolveActivitySymbol: noopResolveSymbol,
  });
  return <div data-rev={String(latestHook.cacheRevision)} />;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  indexGen = 0;
  latestHook = null;
  fetchCodeMapGraph.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('useCodeMapGraphLoader stale refresh cancellation', () => {
  it('forwards cancelled to refreshStalePackages and does not evict newer reload cache', async () => {
    const pkgGraph = { nodes: [{ id: 'pkgA' }], edges: [], stats: {} };
    const stalePkgFetch = deferred<unknown>();
    const staleStarted = deferred<void>();
    let pkgCall = 0;

    fetchCodeMapGraph.mockImplementation(async (url: string) => {
      if (!url.includes('package=')) return pkgGraph;
      pkgCall++;
      if (pkgCall === 1) return { nodes: [{ id: 'file1' }], edges: [], stats: {} };
      if (pkgCall === 2) {
        staleStarted.resolve();
        return stalePkgFetch.promise;
      }
      return { nodes: [{ id: 'fresh-file' }], edges: [], stats: {} };
    });

    await act(async () => {
      root!.render(<Harness />);
    });
    await act(async () => {
      await latestHook!.ensureBranch({ level: 'files', package: 'pkgA' });
    });

    indexGen = 1;
    await act(async () => {
      root!.render(<Harness />);
    });
    await staleStarted.promise;

    await act(async () => {
      latestHook!.retry();
    });
    await act(async () => {
      await latestHook!.ensureBranch({ level: 'files', package: 'pkgA' });
    });
    expect(latestHook!.packageGraph('pkgA')?.nodes[0]?.id).toBe('fresh-file');

    await act(async () => {
      stalePkgFetch.reject(new Error('transient error'));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latestHook!.packageGraph('pkgA')?.nodes[0]?.id).toBe('fresh-file');
  });
});
