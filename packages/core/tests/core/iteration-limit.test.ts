import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it } from 'vitest';
import { requestLimitExtension } from '../../src/core/iteration-limit.js';

describe('requestLimitExtension', () => {
  it('auto-grants 100 when autoExtend=true and no listener responds', async () => {
    const events = new EventBus();
    const extra = await requestLimitExtension({
      events,
      currentIterations: 100,
      currentLimit: 100,
      autoExtend: true,
    });
    expect(extra).toBe(100);
  });

  it('honors synchronous grant() from a listener', async () => {
    const events = new EventBus();
    events.on('iteration.limit_reached', (e) => e.grant(42));
    const extra = await requestLimitExtension({
      events,
      currentIterations: 50,
      currentLimit: 50,
      autoExtend: true,
    });
    expect(extra).toBe(42);
  });

  it('honors synchronous deny() — resolves to 0 even with autoExtend', async () => {
    const events = new EventBus();
    events.on('iteration.limit_reached', (e) => e.deny());
    const extra = await requestLimitExtension({
      events,
      currentIterations: 50,
      currentLimit: 50,
      autoExtend: true,
    });
    expect(extra).toBe(0);
  });

  it('grant(-5) is clamped to 0', async () => {
    const events = new EventBus();
    events.on('iteration.limit_reached', (e) => e.grant(-5));
    const extra = await requestLimitExtension({
      events,
      currentIterations: 50,
      currentLimit: 50,
      autoExtend: true,
    });
    expect(extra).toBe(0);
  });

  it('no autoExtend + no listener + short timeout resolves to 0', async () => {
    const events = new EventBus();
    const extra = await requestLimitExtension({
      events,
      currentIterations: 50,
      currentLimit: 50,
      autoExtend: false,
      timeoutMs: 50,
    });
    expect(extra).toBe(0);
  });

  it('no autoExtend with async listener grant() works', async () => {
    const events = new EventBus();
    events.on('iteration.limit_reached', (e) => {
      setTimeout(() => e.grant(7), 10);
    });
    const extra = await requestLimitExtension({
      events,
      currentIterations: 50,
      currentLimit: 50,
      autoExtend: false,
      timeoutMs: 1000,
    });
    expect(extra).toBe(7);
  });

  it('second grant after resolution is a no-op', async () => {
    const events = new EventBus();
    let lateGrant: ((extra: number) => void) | undefined;
    events.on('iteration.limit_reached', (e) => {
      lateGrant = e.grant;
      e.deny();
    });
    const extra = await requestLimitExtension({
      events,
      currentIterations: 50,
      currentLimit: 50,
      autoExtend: false,
      timeoutMs: 100,
    });
    expect(extra).toBe(0);
    // Late call should not throw or change the result.
    expect(() => lateGrant!(100)).not.toThrow();
  });

  it('chunks timeoutMs > 2^31-1 ms instead of overflowing setTimeout (F295)', async () => {
    const origSetTimeout = globalThis.setTimeout;
    const recordedDelays: number[] = [];
    (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = ((
      _fn: TimerHandler,
      delay?: number,
    ) => {
      recordedDelays.push(Number(delay ?? 0));
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;

    try {
      const events = new EventBus();
      events.on('iteration.limit_reached', (e) => e.grant(5));
      const extra = await requestLimitExtension({
        events,
        currentIterations: 10,
        currentLimit: 10,
        autoExtend: false,
        timeoutMs: 2_147_483_648,
      });
      expect(extra).toBe(5);
      expect(recordedDelays.length).toBeGreaterThan(0);
      expect(recordedDelays.every((d) => d >= 0 && d <= 2_147_483_647)).toBe(true);
    } finally {
      (globalThis as unknown as { setTimeout: typeof setTimeout }).setTimeout = origSetTimeout;
    }
  });
});
