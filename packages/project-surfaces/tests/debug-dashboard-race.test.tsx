/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fetchQueue: Array<ReturnType<typeof deferred<Response>>> = [];
const surfaceFetchMock = vi.fn(() => {
  const d = deferred<Response>();
  fetchQueue.push(d);
  return d.promise;
});

vi.mock('../src/host.js', async (orig) => {
  const actual = await orig<typeof import('../src/host.js')>();
  return {
    ...actual,
    useSurfaceHost: () => ({
      notify: { success: () => {}, error: () => {} },
      useScrollRestore: () => () => {},
    }),
    surfaceFetch: surfaceFetchMock,
  };
});

const { DebugDashboard } = await import('../src/diagnostics/DebugDashboard.js');

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  fetchQueue.length = 0;
  surfaceFetchMock.mockClear();
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
  vi.useRealTimers();
});

describe('DebugDashboard fetchMetrics sequence guard', () => {
  it('ignores stale fetchMetrics responses resolving after a newer poll', async () => {
    await act(async () => {
      root!.render(<DebugDashboard />);
    });

    const oldWatcher = fetchQueue[0]!;
    const oldSystem = fetchQueue[1]!;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    const newWatcher = fetchQueue[2]!;
    const newSystem = fetchQueue[3]!;

    await act(async () => {
      newWatcher.resolve(jsonResponse({ active: true, watchedDirs: 99, totalEvents: 5 }));
      newSystem.resolve(jsonResponse({ ok: true }));
    });
    expect(container!.textContent).toContain('"watchedDirs": 99');

    await act(async () => {
      oldWatcher.resolve(jsonResponse({ active: false, watchedDirs: 11, totalEvents: 0 }));
      oldSystem.resolve(jsonResponse({ ok: true }));
    });

    expect(container!.textContent).toContain('"watchedDirs": 99');
    expect(container!.textContent).not.toContain('"watchedDirs": 11');
  });
});
