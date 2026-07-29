import { render } from 'ink-testing-library';
import React, { act, StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTuiActivity } from '../src/hooks/use-tui-activity.js';
import { Text } from '../src/ink.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const heapWatchdogMocks = vi.hoisted(() => ({
  start: vi.fn((_options: unknown) => async () => {}),
}));
const storageMocks = vi.hoisted(() => ({ loadGoal: vi.fn() }));

vi.mock('@wrongstack/core/storage', () => ({ loadGoal: storageMocks.loadGoal }));
vi.mock('../src/heap-watchdog.js', () => ({
  startHeapWatchdog: heapWatchdogMocks.start,
  takeHeapSample: () => ({
    ts: '2026-07-15T00:00:00.000Z',
    rss: 0,
    heapUsed: 0,
    heapTotal: 0,
    external: 0,
    heapLimit: 0,
    load: 0,
  }),
}));

const stateRef = {
  current: { entries: [], runningTools: new Set() },
} as never;
const agentContext = { state: { messages: [] } } as never;
const dispatchMock = vi.fn();
const dispatch = dispatchMock as never;
const attachments = {} as never;
const builderRef = { current: null } as never;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function ActivityHarness({
  status,
  projectRoot = '',
  enhanceBusy = false,
  renderDots = false,
}: {
  status: 'idle' | 'running' | 'streaming' | 'aborting';
  projectRoot?: string | undefined;
  enhanceBusy?: boolean | undefined;
  renderDots?: boolean | undefined;
}): React.ReactElement {
  const result = useTuiActivity({
    status,
    fleet: {},
    enhanceBusy,
    thinkingWord: 'thinking',
    projectRoot,
    stateRef,
    agentContext,
    dispatch,
    attachments,
    builderRef,
  });
  return React.createElement(
    Text,
    null,
    renderDots ? `dots=${result.enhanceDots}` : result.workingTimeMs,
  );
}

function harness(status: 'idle' | 'running' | 'streaming' | 'aborting'): React.ReactElement {
  return React.createElement(StrictMode, null, React.createElement(ActivityHarness, { status }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  storageMocks.loadGoal.mockReset();
});

interface WatchdogOptions {
  collectStats?: (() => Record<string, number>) | undefined;
}

function latestWatchdogOptions(): WatchdogOptions {
  const call = heapWatchdogMocks.start.mock.calls.at(-1);
  if (!call) throw new Error('startHeapWatchdog was not called');
  return call[0] as WatchdogOptions;
}

describe('useTuiActivity foreground working time', () => {
  /** Ink 7.1.1 writes content and trailing whitespace as separate frames;
   *  return the last frame with non-whitespace content. */
  function lastVisibleFrame(view: ReturnType<typeof render>): string {
    const f = view.lastFrame() ?? '';
    if (f.trim().length > 0) return f.trim();
    // Fall back to scanning frames for content
    for (let i = view.frames.length - 1; i >= 0; i--) {
      const candidate = view.frames[i];
      if (candidate && candidate.trim().length > 0) return candidate.trim();
    }
    return f;
  }

  it('collects only shallow watchdog cardinalities', () => {
    const hostileEntry = {
      get text(): never {
        throw new Error('history element was traversed');
      },
    };
    const localStateRef = {
      current: {
        entries: [hostileEntry],
        runningTools: new Map([['tool-1', {}]]),
        fleet: { agent: { status: 'running' } },
        queue: [{ id: 1 }],
        inputHistory: ['one', 'two'],
      },
    } as never;
    const hostileMessage = {
      get content(): never {
        throw new Error('message element was traversed');
      },
    };
    const localAgentContext = { state: { messages: [hostileMessage] } } as never;

    function StatsHarness(): React.ReactElement {
      useTuiActivity({
        status: 'idle',
        fleet: {},
        enhanceBusy: false,
        thinkingWord: 'thinking',
        projectRoot: '',
        stateRef: localStateRef,
        agentContext: localAgentContext,
        dispatch,
        attachments,
        builderRef,
      });
      return React.createElement(Text, null, 'stats');
    }

    let view!: ReturnType<typeof render>;
    act(() => {
      view = render(React.createElement(StatsHarness));
    });
    const stats = latestWatchdogOptions().collectStats?.();
    expect(stats).toEqual({
      historyEntries: 1,
      messages: 1,
      runningTools: 1,
      stdoutQueued: expect.any(Number),
      fleetSize: 1,
      queued: 1,
      inputHistory: 2,
      attachments: 0,
      builderRefs: 0,
      directorInFlight: 0,
    });
    act(() => view.unmount());
  });

  it('counts committed working spells without resets or idle gaps', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
    let view!: ReturnType<typeof render>;
    act(() => {
      view = render(harness('idle'));
    });

    act(() => {
      vi.setSystemTime(new Date('2026-07-15T00:00:01.000Z'));
      view.rerender(harness('running'));
    });
    act(() => vi.advanceTimersByTime(2_000));
    expect(lastVisibleFrame(view)).toBe('2000');

    act(() => view.rerender(harness('streaming')));
    act(() => vi.advanceTimersByTime(1_000));
    expect(lastVisibleFrame(view)).toBe('3000');

    act(() => view.rerender(harness('idle')));
    act(() => vi.advanceTimersByTime(1_000));
    expect(lastVisibleFrame(view)).toBe('3000');

    act(() => view.rerender(harness('running')));
    act(() => vi.advanceTimersByTime(2_000));
    expect(lastVisibleFrame(view)).toBe('5000');

    act(() => view.unmount());
  });

  it('does not dispatch an unchanged null goal summary', async () => {
    vi.useFakeTimers();
    storageMocks.loadGoal.mockResolvedValue(null);

    let view!: ReturnType<typeof render>;
    await act(async () => {
      view = render(React.createElement(ActivityHarness, { status: 'idle', projectRoot: 'project' }));
      await Promise.resolve();
    });
    expect(storageMocks.loadGoal).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    const nullGoalActions = dispatchMock.mock.calls
      .map(([action]) => action as { type?: string; summary?: unknown })
      .filter((action) => action.type === 'goalSummary' && action.summary === null);
    expect(storageMocks.loadGoal).toHaveBeenCalledTimes(2);
    expect(nullGoalActions).toHaveLength(1);
    act(() => view.unmount());
  });

  it('ignores a stale goal load that resolves after a newer refresh', async () => {
    vi.useFakeTimers();
    const stale = deferred<unknown>();
    const fresh = deferred<unknown>();
    storageMocks.loadGoal
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    let view!: ReturnType<typeof render>;
    act(() => {
      view = render(React.createElement(ActivityHarness, { status: 'idle', projectRoot: 'project' }));
    });
    expect(storageMocks.loadGoal).toHaveBeenCalledTimes(1);

    act(() => vi.advanceTimersByTime(10_000));
    expect(storageMocks.loadGoal).toHaveBeenCalledTimes(2);

    await act(async () => {
      fresh.resolve({ goal: 'fresh', iterations: 2, progress: 50, deliverables: [] });
      await fresh.promise;
    });
    await act(async () => {
      stale.resolve({ goal: 'stale', iterations: 1, progress: 10, deliverables: [] });
      await stale.promise;
    });

    const goalActions = dispatchMock.mock.calls
      .map(([action]) => action as { type?: string; summary?: { goal?: string } })
      .filter((action) => action.type === 'goalSummary');
    expect(goalActions).toHaveLength(1);
    expect(goalActions[0]?.summary?.goal).toBe('fresh');
    act(() => view.unmount());
  });
});

describe('useTuiActivity shared animation tick', () => {
  // Regression: useTuiActivity used to own TWO independent 1s useAnimation
  // intervals — one for the foreground/fleet timing clock and one for the
  // enhance loading-dot cycle. The second interval kept ticking even when
  // nothing else was active, doubling the Ink render cadence during
  // enhanceBusy. The fix routes both through the same `useAnimation` tick
  // (isActive: timingActive || enhanceActive) and derives enhanceDots from
  // the shared frame: `enhanceBusy ? timingFrame % 36 : 0`.
  function lastDotsFrame(view: ReturnType<typeof render>): number | null {
    for (let i = view.frames.length - 1; i >= 0; i--) {
      const candidate = view.frames[i];
      if (!candidate) continue;
      const match = /dots=(\d+)/.exec(candidate);
      if (match) return Number(match[1]);
    }
    return null;
  }

  it('enhanceDots advances when enhanceBusy is the only active consumer', () => {
    vi.useFakeTimers();
    let view!: ReturnType<typeof render>;
    act(() => {
      // status='idle' (timingActive=false) but enhanceBusy=true → the shared
      // tick must still be alive so the dots animate.
      view = render(
        React.createElement(ActivityHarness, {
          status: 'idle',
          enhanceBusy: true,
          renderDots: true,
        }),
      );
    });
    // Initial frame before any tick — dots frame is 0.
    expect(lastDotsFrame(view)).toBe(0);

    act(() => vi.advanceTimersByTime(3_000));
    // After 3s of ticks: frame === 3, dots === 3 % 36 === 3.
    expect(lastDotsFrame(view)).toBe(3);

    act(() => vi.advanceTimersByTime(2_000));
    expect(lastDotsFrame(view)).toBe(5);
    act(() => view.unmount());
  });

  it('enhanceDots collapses to 0 when enhanceBusy is false', () => {
    vi.useFakeTimers();
    let view!: ReturnType<typeof render>;
    act(() => {
      view = render(
        React.createElement(ActivityHarness, {
          status: 'idle',
          enhanceBusy: false,
          renderDots: true,
        }),
      );
    });
    act(() => vi.advanceTimersByTime(5_000));
    // enhanceBusy=false → enhanceDots=0 regardless of how many ticks fired.
    expect(lastDotsFrame(view)).toBe(0);
    act(() => view.unmount());
  });
});
