import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryWhileUnauthorized } from '../src/project-endpoint.js';

afterEach(() => vi.useRealTimers());

describe('authorization retry delay', () => {
  it.each([150, 2_147_483_647, 2_147_483_648, 4_294_967_301])(
    'waits the full %i ms before retrying',
    async (delayMs) => {
      vi.useFakeTimers();
      const attempt = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValue('ok');
      const pending = retryWhileUnauthorized(attempt, () => true, { attempts: 1, delayMs });
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(attempt).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe('ok');
      expect(attempt).toHaveBeenCalledTimes(2);
    },
  );

  it('still permits a zero delay', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn().mockRejectedValueOnce(new Error('refused')).mockResolvedValue('ok');
    const pending = retryWhileUnauthorized(attempt, () => true, { attempts: 1, delayMs: 0 });
    await vi.runAllTimersAsync();
    expect(await pending).toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
