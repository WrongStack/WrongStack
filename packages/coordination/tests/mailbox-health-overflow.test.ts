import { afterEach, describe, expect, it, vi } from 'vitest';
import { MailboxHealthWatchdog } from '../src/mailbox-health.js';

describe('MailboxHealthWatchdog timeout clamping (F394)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clamps probeTimeoutMs and probeIntervalMs above 32-bit signed max', async () => {
    let abortedEarly = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      await new Promise((r) => setTimeout(r, 30));
      if (init?.signal?.aborted) {
        abortedEarly = true;
        throw new DOMException('The operation was aborted', 'AbortError');
      }
      return new Response('ok', { status: 200 });
    });

    const watchdog = new MailboxHealthWatchdog({
      mailbox: { send: async () => {} } as never,
      url: 'http://127.0.0.1:9999',
      probeIntervalMs: 3_500_000_000,
      probeTimeoutMs: 3_000_000_000,
      failureThreshold: 1,
    });

    try {
      await expect(
        (watchdog as unknown as { probe: () => Promise<boolean> }).probe(),
      ).resolves.toBe(true);
      expect(abortedEarly).toBe(false);
    } finally {
      watchdog.stop();
    }
  });
});
