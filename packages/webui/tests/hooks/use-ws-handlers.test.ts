import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// ── Mocks ─────────────────────────────────────────────────────────────────
const onSpy = vi.hoisted(() => vi.fn(() => () => {}));

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => ({ on: onSpy }),
}));

// ── SUT (imported after mocks) ────────────────────────────────────────────
import { useWsHandlers } from '../../src/hooks/use-ws-handlers';

describe('useWsHandlers', () => {
  beforeEach(() => {
    onSpy.mockClear();
    onSpy.mockImplementation(() => () => {});
  });

  it('registers a dispatching wrapper for every key in the map', () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    renderHook(() =>
      useWsHandlers({
        'session.start': h1,
        'provider.text_delta': h2,
      }),
    );

    expect(onSpy).toHaveBeenCalledTimes(2);
    // A stable WRAPPER is registered (not the concrete handler) so the
    // dispatch always reads the latest map from the ref.
    expect(onSpy).toHaveBeenCalledWith('session.start', expect.any(Function));
    expect(onSpy).toHaveBeenCalledWith('provider.text_delta', expect.any(Function));

    const wrapper = (onSpy.mock.calls as Array<Array<unknown>>).find(
      (c) => c[0] === 'session.start',
    )?.[1] as (msg: unknown) => void;
    const msg = { type: 'session.start', payload: {} };
    wrapper(msg);
    expect(h1).toHaveBeenCalledWith(msg);
    expect(h2).not.toHaveBeenCalled();
  });

  it('dispatches the LATEST handler after a re-render (no stale closure)', () => {
    const first = vi.fn();
    const second = vi.fn();
    let handler = first;
    const { rerender } = renderHook(() => useWsHandlers({ 'session.start': handler }));

    handler = second;
    rerender();

    const wrapper = (onSpy.mock.calls as Array<Array<unknown>>)[0]?.[1] as (msg: unknown) => void;
    wrapper({ type: 'session.start', payload: {} });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('tears down every registration on unmount', () => {
    const off1 = vi.fn();
    const off2 = vi.fn();
    onSpy.mockImplementationOnce(() => off1);
    onSpy.mockImplementationOnce(() => off2);

    const { unmount } = renderHook(() =>
      useWsHandlers({ 'session.start': vi.fn(), 'provider.text_delta': vi.fn() }),
    );

    unmount();
    expect(off1).toHaveBeenCalledTimes(1);
    expect(off2).toHaveBeenCalledTimes(1);
  });

  it('registers keys with undefined handlers too (they may fill in later)', () => {
    const h = vi.fn();
    renderHook(() =>
      useWsHandlers({
        'session.start': h,
        'provider.text_delta': undefined,
      }),
    );

    // Both keys get wrappers: the map value can flip undefined → fn on a
    // later render without re-subscribing (the wrapper reads the ref).
    expect(onSpy).toHaveBeenCalledTimes(2);
    const wrapper = (onSpy.mock.calls as Array<Array<unknown>>).find(
      (c) => c[0] === 'provider.text_delta',
    )?.[1] as (msg: unknown) => void;
    // Dispatching to the undefined slot is a safe no-op.
    expect(() => wrapper({ type: 'provider.text_delta', payload: {} })).not.toThrow();
    expect(h).not.toHaveBeenCalled();
  });

  it('re-subscribes when deps change', () => {
    const off1 = vi.fn();
    onSpy.mockImplementation(() => off1);

    let dep = 'a';
    const { rerender } = renderHook(() => useWsHandlers({ 'session.start': vi.fn() }, [dep]));

    expect(onSpy).toHaveBeenCalledTimes(1);
    expect(off1).not.toHaveBeenCalled();

    dep = 'b';
    rerender();

    // Old registration torn down, new one made.
    expect(off1).toHaveBeenCalledTimes(1);
    expect(onSpy).toHaveBeenCalledTimes(2);
  });
});
