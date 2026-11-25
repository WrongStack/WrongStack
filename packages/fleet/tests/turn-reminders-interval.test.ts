import { describe, expect, it } from 'vitest';
import { startAcpTurnReminders } from '../src/acp-turn-reminders.js';

describe('startAcpTurnReminders poll interval validation', () => {
  it('falls back to default poll intervals when btwPollMs or mailPollMs is non-finite or non-positive', () => {
    const delays: number[] = [];
    const origSetInterval = globalThis.setInterval;
    globalThis.setInterval = ((_fn: () => void, ms?: number) => {
      delays.push(ms as number);
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;

    try {
      const stop = startAcpTurnReminders({
        steer: async () => 'injected',
        context: {} as never,
        unreadCount: async () => 0,
        btwPollMs: Number.NaN,
        mailPollMs: -50,
      });
      stop();
    } finally {
      globalThis.setInterval = origSetInterval;
    }

    expect(delays).toEqual([1_000, 15_000]);
  });
});
