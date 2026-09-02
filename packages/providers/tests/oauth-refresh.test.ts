import { describe, expect, it, vi } from 'vitest';
import { createSingleFlightRefresh } from '../src/oauth-refresh.js';

describe('createSingleFlightRefresh', () => {
  it('runs the underlying refreshFn once when called concurrently', async () => {
    let resolveRefresh!: (v: string) => void;
    const refreshFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const sf = createSingleFlightRefresh(refreshFn);

    const p1 = sf.refresh();
    const p2 = sf.refresh();
    const p3 = sf.refresh();

    expect(sf.inFlight).toBe(true);
    expect(refreshFn).toHaveBeenCalledTimes(1);

    resolveRefresh('done');
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe('done');
    expect(r2).toBe('done');
    expect(r3).toBe('done');
    expect(sf.inFlight).toBe(false);
  });

  it('clears the in-flight slot after rejection so retries can fire', async () => {
    let rejectRefresh!: (err: Error) => void;
    const refreshFn = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );
    const sf = createSingleFlightRefresh(refreshFn);

    const p1 = sf.refresh();
    const p2 = sf.refresh();
    const error = new Error('refresh failed');
    rejectRefresh(error);

    await expect(p1).rejects.toBe(error);
    await expect(p2).rejects.toBe(error);
    expect(sf.inFlight).toBe(false);

    // A second refresh cycle after the failure must call refreshFn again,
    // not stay stuck in the failed slot.
    refreshFn.mockResolvedValueOnce('recovered');
    const recovered = await sf.refresh();
    expect(recovered).toBe('recovered');
    expect(refreshFn).toHaveBeenCalledTimes(2);
  });

  it('runs sequential refreshes independently', async () => {
    const refreshFn = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const sf = createSingleFlightRefresh(refreshFn);

    expect(await sf.refresh()).toBe('first');
    expect(await sf.refresh()).toBe('second');
    expect(refreshFn).toHaveBeenCalledTimes(2);
    expect(sf.inFlight).toBe(false);
  });

  it('runs the shared refresh with no caller signal (decoupled from callers)', async () => {
    const refreshFn = vi.fn().mockResolvedValue('ok');
    const sf = createSingleFlightRefresh(refreshFn);
    const ctrl1 = new AbortController();
    const ctrl2 = new AbortController();

    const p1 = sf.refresh(ctrl1.signal);
    const p2 = sf.refresh(ctrl2.signal);

    await Promise.all([p1, p2]);
    expect(refreshFn).toHaveBeenCalledTimes(1);
    // No caller's signal drives the shared refresh — cancelling one caller must
    // not cancel the shared token exchange that persists rotated tokens.
    expect(refreshFn.mock.calls[0]?.[0]).toBeUndefined();
  });

  it('a caller aborting rejects only that caller; the shared refresh still resolves the others', async () => {
    let resolveRefresh!: (v: string) => void;
    const refreshFn = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const sf = createSingleFlightRefresh(refreshFn);
    const ctrlA = new AbortController();
    const ctrlB = new AbortController();

    const pA = sf.refresh(ctrlA.signal);
    const pB = sf.refresh(ctrlB.signal);

    // Caller A cancels (e.g. user Esc) while the refresh is still in flight.
    ctrlA.abort();
    await expect(pA).rejects.toThrow();

    // The shared work is untouched: complete it and B still gets the value.
    resolveRefresh('rotated-token');
    await expect(pB).resolves.toBe('rotated-token');
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('reports inFlight correctly across the lifecycle', async () => {
    let resolveRefresh!: (v: number) => void;
    const refreshFn = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const sf = createSingleFlightRefresh(refreshFn);

    expect(sf.inFlight).toBe(false);
    const p = sf.refresh();
    expect(sf.inFlight).toBe(true);
    resolveRefresh(42);
    await p;
    expect(sf.inFlight).toBe(false);
  });
});
