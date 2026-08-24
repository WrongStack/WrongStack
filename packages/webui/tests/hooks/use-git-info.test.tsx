import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const getGitInfo = vi.fn();
let clientValue: unknown = { getGitInfo };

vi.mock('../../src/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ client: clientValue }),
}));

const { useGitInfoStore } = await import('../../src/stores');
const { useGitInfo } = await import('../../src/hooks/useGitInfo');

describe('useGitInfo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getGitInfo.mockReset();
    clientValue = { getGitInfo };
    useGitInfoStore.setState({ info: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches once immediately on mount', () => {
    renderHook(() => useGitInfo());
    expect(getGitInfo).toHaveBeenCalledTimes(1);
  });

  it('polls every 30 seconds', () => {
    renderHook(() => useGitInfo());
    expect(getGitInfo).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    expect(getGitInfo).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(60_000);
    expect(getGitInfo).toHaveBeenCalledTimes(4);
  });

  it('does not fire early — the chip must not hammer the server', () => {
    renderHook(() => useGitInfo());
    vi.advanceTimersByTime(29_999);
    expect(getGitInfo).toHaveBeenCalledTimes(1);
  });

  it('stops polling on unmount', () => {
    const { unmount } = renderHook(() => useGitInfo());
    unmount();
    vi.advanceTimersByTime(120_000);
    expect(getGitInfo).toHaveBeenCalledTimes(1);
  });

  it('returns the store value', () => {
    useGitInfoStore.setState({ info: { branch: 'main', dirty: false } as never });
    const { result } = renderHook(() => useGitInfo());
    expect(result.current).toMatchObject({ branch: 'main' });
  });

  it('re-renders when the store value changes', () => {
    const { result, rerender } = renderHook(() => useGitInfo());
    expect(result.current).toBeNull();
    act(() => {
      useGitInfoStore.setState({ info: { branch: 'feat/x', dirty: true } as never });
    });
    rerender();
    expect(result.current).toMatchObject({ branch: 'feat/x' });
  });

  it('is inert when the socket client is not ready yet', () => {
    clientValue = null;
    expect(() => renderHook(() => useGitInfo())).not.toThrow();
    vi.advanceTimersByTime(60_000);
  });

  it('tolerates a client without a getGitInfo method', () => {
    clientValue = {};
    expect(() => renderHook(() => useGitInfo())).not.toThrow();
    vi.advanceTimersByTime(30_000);
  });

  it('restarts polling against the new client when the socket reconnects', () => {
    const { rerender } = renderHook(() => useGitInfo());
    expect(getGitInfo).toHaveBeenCalledTimes(1);

    const nextGetGitInfo = vi.fn();
    clientValue = { getGitInfo: nextGetGitInfo };
    rerender();

    // The new client is fetched immediately...
    expect(nextGetGitInfo).toHaveBeenCalledTimes(1);
    // ...and the old interval was torn down, so only the new one ticks.
    vi.advanceTimersByTime(30_000);
    expect(nextGetGitInfo).toHaveBeenCalledTimes(2);
    expect(getGitInfo).toHaveBeenCalledTimes(1);
  });
});
