import { describe, expect, it } from 'vitest';
import { requestLimitExtension } from '../../src/core/iteration-limit.js';
import { EventBus } from '../../src/kernel/events.js';

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
});
