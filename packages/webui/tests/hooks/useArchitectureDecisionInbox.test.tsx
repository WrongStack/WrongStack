import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useArchitectureDecisionInbox } from '../../src/hooks/useArchitectureDecisionInbox';

const fixture = vi.hoisted(() => ({ rpc: vi.fn(), projectRoot: 'project-a' }));
vi.mock('@/lib/portable-command-rpc', () => ({ invokePortableCommand: fixture.rpc }));
vi.mock('@/stores', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ projectRoot: fixture.projectRoot }),
}));
const summary = (pending: number, version = 'a') => ({
  message: JSON.stringify({
    projectId: 'project-a',
    total: pending + 1,
    pending,
    version: version.repeat(64),
  }),
});
const settle = () =>
  act(async () => {
    await Promise.resolve();
  });

beforeEach(() => {
  vi.useFakeTimers();
  fixture.projectRoot = 'project-a';
  fixture.rpc.mockReset().mockResolvedValue(summary(2));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('project ADR inbox', () => {
  it('shares one poll between dock and panel and releases it after the last consumer', async () => {
    const dock = renderHook(() => useArchitectureDecisionInbox('session-a'));
    const panel = renderHook(() => useArchitectureDecisionInbox('session-a'));
    await settle();
    expect(fixture.rpc).toHaveBeenCalledTimes(1);
    expect(dock.result.current.summary?.pending).toBe(2);
    expect(panel.result.current.summary?.pending).toBe(2);
    dock.unmount();
    fixture.rpc.mockResolvedValue(summary(0, 'b'));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(panel.result.current.summary?.pending).toBe(0);
    panel.unmount();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fixture.rpc).toHaveBeenCalledTimes(2);
  });

  it('ignores and cancels a delayed response after a project switch', async () => {
    let resolveOld!: (value: unknown) => void;
    fixture.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const view = renderHook(() => useArchitectureDecisionInbox('session-a'));
    const signal = fixture.rpc.mock.calls[0][2].signal as AbortSignal;
    fixture.projectRoot = 'project-b';
    fixture.rpc.mockResolvedValue(summary(0, 'b'));
    view.rerender();
    await settle();
    expect(signal.aborted).toBe(true);
    await act(async () => resolveOld(summary(8)));
    expect(view.result.current.summary?.pending).toBe(0);
    expect(fixture.rpc.mock.calls[0][2].queueIfDisconnected).toBe(false);
  });

  it('reports an unavailable inbox instead of retaining a misleading count and recovers', async () => {
    const view = renderHook(() => useArchitectureDecisionInbox('session-a'));
    await settle();
    fixture.rpc.mockResolvedValue({ error: 'Offline' });
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(view.result.current).toMatchObject({ summary: null, unavailable: true });
    fixture.rpc.mockResolvedValue(summary(1, 'b'));
    await act(async () => view.result.current.refresh());
    expect(view.result.current.summary?.pending).toBe(1);
    expect(view.result.current.unavailable).toBe(false);
  });

  it('pauses while hidden, refreshes on return and does not poll disabled chips', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const view = renderHook(() => useArchitectureDecisionInbox('session-a'));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fixture.rpc).not.toHaveBeenCalled();
    visibility.mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(view.result.current.summary?.pending).toBe(2);
    visibility.mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fixture.rpc).toHaveBeenCalledTimes(1);
    view.unmount();
    renderHook(() => useArchitectureDecisionInbox('session-a', false));
    expect(fixture.rpc).toHaveBeenCalledTimes(1);
  });

  it('queues a single refresh behind a slow query instead of overlapping requests', async () => {
    let resolve!: (value: unknown) => void;
    fixture.rpc.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = renderHook(() => useArchitectureDecisionInbox('session-a'));
    await act(async () => {
      view.result.current.refresh();
      view.result.current.refresh();
    });
    expect(fixture.rpc).toHaveBeenCalledTimes(1);
    fixture.rpc.mockResolvedValue(summary(0, 'b'));
    await act(async () => resolve(summary(1)));
    expect(fixture.rpc).toHaveBeenCalledTimes(2);
    expect(view.result.current.summary?.pending).toBe(0);
  });
});
