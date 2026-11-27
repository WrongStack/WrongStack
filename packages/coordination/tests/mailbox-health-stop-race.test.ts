import { describe, expect, it } from 'vitest';
import { MailboxHealthWatchdog } from '../src/mailbox-health.js';

describe('MailboxHealthWatchdog stop-before-timer race (F2715)', () => {
  it('does not schedule interval timer when stop() is called during started observer', async () => {
    let watchdog!: MailboxHealthWatchdog;
    watchdog = new MailboxHealthWatchdog({
      mailbox: { send: async () => {} } as never,
      url: 'http://127.0.0.1:1',
      probeIntervalMs: 60_000,
      probeTimeoutMs: 50,
      onAlert: (event) => {
        if (event.kind === 'started') {
          void watchdog.stop();
        }
      },
    });

    await watchdog.start();
    expect(watchdog.isRunning()).toBe(false);
    await watchdog.stop();
  });

  it('does not start when stop() was called before start()', async () => {
    const watchdog = new MailboxHealthWatchdog({
      mailbox: { send: async () => {} } as never,
      url: 'http://127.0.0.1:1',
      probeIntervalMs: 60_000,
      probeTimeoutMs: 50,
    });

    await watchdog.stop();
    await watchdog.start();
    expect(watchdog.isRunning()).toBe(false);
  });
});
