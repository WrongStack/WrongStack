import { describe, expect, it, vi } from 'vitest';
import { startCostTelemetryBridge } from '../../src/hq/cost-bridge.js';
import type { HqUsagePayload } from '../../src/hq/protocol.js';
import type { HqPublisher } from '../../src/hq/publisher.js';
import { EventBus } from '../../src/kernel/events.js';

function fakePublisher(spy: ReturnType<typeof vi.fn>): HqPublisher {
  return {
    publishEvent: (o: { type: string; payload: unknown }) => {
      spy(o);
      return {} as never;
    },
  } as unknown as HqPublisher;
}

describe('startCostTelemetryBridge', () => {
  it('forwards token.accounted as session.usage', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    const stop = startCostTelemetryBridge({ events, publisher, sessionId: 's1' });
    events.emit('token.accounted', {
      sessionId: 's1',
      usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
      cost: { input: 0.001, output: 0.002, total: 0.003 },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const call = spy.mock.calls[0]![0];
    expect(call.type).toBe('session.usage');
    const payload: HqUsagePayload = call.payload;
    expect(payload.inputTokens).toBe(100);
    expect(payload.outputTokens).toBe(50);
    expect(payload.totalTokens).toBe(150);
    expect(payload.costUsd).toBe(0.003);
    expect(call.sessionId).toBe('s1');
    stop();
  });

  it('forwards model/provider/cache dimensions onto the payload', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startCostTelemetryBridge({ events, publisher });
    events.emit('token.accounted', {
      usage: { input: 100, output: 50, cacheRead: 80, cacheWrite: 20 },
      cost: { input: 0.001, output: 0.002, total: 0.003 },
      provider: 'anthropic',
      model: 'claude-sonnet-4',
    });
    const payload: HqUsagePayload = spy.mock.calls[0]![0].payload;
    expect(payload.provider).toBe('anthropic');
    expect(payload.model).toBe('claude-sonnet-4');
    expect(payload.cacheRead).toBe(80);
    expect(payload.cacheWrite).toBe(20);
    expect(payload.inputTokens).toBe(200);
    expect(payload.totalTokens).toBe(250);
  });

  it('omits model/provider/cache when the event carries none', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startCostTelemetryBridge({ events, publisher });
    events.emit('token.accounted', {
      usage: { input: 100, output: 50 },
      cost: { input: 0.001, output: 0.002, total: 0.003 },
    });
    const payload: HqUsagePayload = spy.mock.calls[0]![0].payload;
    expect(payload.provider).toBeUndefined();
    expect(payload.model).toBeUndefined();
    expect(payload.cacheRead).toBeUndefined();
    expect(payload.cacheWrite).toBeUndefined();
  });

  it('uses the event sessionId when no override is set', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startCostTelemetryBridge({ events, publisher });
    events.emit('token.accounted', {
      sessionId: 'from-event',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      cost: { input: 0, output: 0, total: 0.01 },
    });
    expect(spy.mock.calls[0]![0].sessionId).toBe('from-event');
  });

  it('override sessionId takes precedence over event sessionId', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    startCostTelemetryBridge({ events, publisher, sessionId: 'override' });
    events.emit('token.accounted', {
      sessionId: 'from-event',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      cost: { input: 0, output: 0, total: 0.01 },
    });
    expect(spy.mock.calls[0]![0].sessionId).toBe('override');
  });

  it('disposer unsubscribes', () => {
    const events = new EventBus();
    const spy = vi.fn();
    const publisher = fakePublisher(spy);
    const stop = startCostTelemetryBridge({ events, publisher });
    stop();
    events.emit('token.accounted', {
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      cost: { input: 0, output: 0, total: 0 },
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('never throws on publisher failure', () => {
    const events = new EventBus();
    const publisher = {
      publishEvent: () => {
        throw new Error('boom');
      },
    } as unknown as HqPublisher;
    const stop = startCostTelemetryBridge({ events, publisher });
    expect(() =>
      events.emit('token.accounted', {
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        cost: { input: 0, output: 0, total: 0 },
      }),
    ).not.toThrow();
    stop();
  });
});
