/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn().mockResolvedValue({ ok: false });

vi.mock('../src/host.js', () => ({
  useSurfaceHost: () => ({
    useScrollRestore: () => ({ current: null }),
    apiFetch: vi.fn(),
  }),
  surfaceFetch: (...args: unknown[]) => fetchMock(...args),
  surfaceClient: () => ({
    on: (_evt: string, fn: (msg: unknown) => void) => {
      (globalThis as { __f413PListener?: (msg: unknown) => void }).__f413PListener = fn;
      return () => {
        delete (globalThis as { __f413PListener?: (msg: unknown) => void }).__f413PListener;
      };
    },
    send: () => {
      (globalThis as { __f413PListener?: (msg: unknown) => void }).__f413PListener?.({
        payload: {
          cost: 0,
          usage: { input: 0, output: 0 },
          cache: { hitRatio: 0, hits: 0, misses: 0, readTokens: 0, writeTokens: 0 },
        },
      });
    },
  }),
}));

import { AnalyticsDashboard } from '../src/analytics/AnalyticsDashboard.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  fetchMock.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('AnalyticsDashboard sync reply timer guard', () => {
  it('never leaks an 8s timeout on synchronous stats.get delivery', async () => {
    const origSetTimeout = globalThis.setTimeout;
    let activeTimers = 0;
    const created: ReturnType<typeof setTimeout>[] = [];

    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...args: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const id = origSetTimeout(fn, ms, ...args);
      if (ms === 8000) activeTimers += 1;
      created.push(id);
      return id;
    }) as typeof setTimeout);

    await act(async () => {
      root!.render(<AnalyticsDashboard />);
    });

    for (const id of created) clearTimeout(id);
    expect(activeTimers).toBe(0);
  });
});
