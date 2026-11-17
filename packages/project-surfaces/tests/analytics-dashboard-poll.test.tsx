/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
let statsListeners = 0;
let emitStats: ((msg: unknown) => void) | null = null;

vi.mock('../src/host.js', () => ({
  surfaceFetch: fetchMock,
  surfaceClient: () => ({
    on: (_event: string, fn: (msg: unknown) => void) => {
      statsListeners++;
      emitStats = fn;
      return () => {
        statsListeners--;
        if (emitStats === fn) emitStats = null;
      };
    },
    send: () => {},
  }),
  useSurfaceHost: () => ({
    useTranslation: () => ({
      t: (_k: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _k,
    }),
    useScrollRestore: () => ({ current: null }),
  }),
}));

const { AnalyticsDashboard } = await import('../src/analytics/AnalyticsDashboard.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  statsListeners = 0;
  emitStats = null;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () =>
      url.includes('sessions')
        ? []
        : url.includes('summary')
          ? {
              totalCost: 0,
              totalCostUsd: 0,
              totalTokens: 0,
              totalTurns: 0,
              totalEvents: 0,
              errorCount: 0,
              categoryBreakdown: {},
              eventBreakdown: {},
              toolBreakdown: {},
              recentErrors: [],
            }
          : { events: [] },
  }));
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

describe('AnalyticsDashboard polling cadence and unmount cleanup', () => {
  it('does not re-trigger polling on statsLoading changes and cleans up stats listener on unmount', async () => {
    await act(async () => {
      root!.render(<AnalyticsDashboard />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(statsListeners).toBe(1);

    await act(async () => {
      emitStats?.({
        payload: {
          cost: 0,
          usage: { input: 0, output: 0 },
          cache: { hitRatio: 0, reads: 0, writes: 0 },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(statsListeners).toBe(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(statsListeners).toBe(1);

    await act(async () => {
      root!.unmount();
    });
    root = null;
    expect(statsListeners).toBe(0);
  });
});
