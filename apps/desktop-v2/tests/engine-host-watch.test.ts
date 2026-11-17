import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostPidFrom, processAlive, watchHost } from '../engine/host-watch';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('engine host watch', () => {
  it('reads only a positive integer host pid', () => {
    expect(hostPidFrom('4242')).toBe(4242);
    for (const value of [undefined, '', '0', '-3', '12.5', 'host']) {
      expect(hostPidFrom(value)).toBeUndefined();
    }
  });

  it('stops once, the first time the host is gone', () => {
    let hostAlive = true;
    const onGone = vi.fn();
    watchHost(4242, onGone, { intervalMs: 100, alive: () => hostAlive });
    vi.advanceTimersByTime(1_000);
    expect(onGone).not.toHaveBeenCalled();
    hostAlive = false;
    vi.advanceTimersByTime(100);
    expect(onGone).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1_000);
    expect(onGone).toHaveBeenCalledTimes(1);
  });

  it('sees a live process and not a missing one', () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 31 - 2)).toBe(false);
  });

  it('can be cancelled', () => {
    const onGone = vi.fn();
    const cancel = watchHost(4242, onGone, { intervalMs: 100, alive: () => false });
    cancel();
    vi.advanceTimersByTime(1_000);
    expect(onGone).not.toHaveBeenCalled();
  });
});
