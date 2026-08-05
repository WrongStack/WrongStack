import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it } from 'vitest';
import { createFallbackGate } from '../src/wiring/fallback-gate.js';

describe('createFallbackGate', () => {
  it('emits provider.fallback_pending with candidates and requestId', async () => {
    const events = new EventBus();
    const gate = createFallbackGate(events);

    const pendingEvents: unknown[] = [];
    events.on('provider.fallback_pending', (e) => pendingEvents.push(e));

    const resultPromise = gate({
      events,
      sessionId: 's1',
      from: { providerId: 'anthropic', model: 'opus' },
      status: 429,
      candidates: [
        { providerId: 'openai', model: 'gpt-4o' },
        { providerId: 'google', model: 'gemini-pro' },
      ],
      autoSwitchSeconds: 1,
      requestId: 'req-first',
    });

    // The pending event is emitted synchronously during the gate call.
    expect(pendingEvents).toHaveLength(1);
    const pending = pendingEvents[0] as Record<string, unknown>;
    expect(pending['from']).toEqual({ providerId: 'anthropic', model: 'opus' });
    expect(pending['status']).toBe(429);
    expect(pending['autoSwitchSeconds']).toBe(1);
    expect(typeof pending['requestId']).toBe('string');
    expect(pending['requestId']).toBe('req-first');
    expect(pending['candidates']).toEqual([
      { providerId: 'openai', model: 'gpt-4o' },
      { providerId: 'google', model: 'gemini-pro' },
    ]);

    const requestId = pending['requestId'] as string;
    events.emit('provider.fallback_choice', { requestId, autoSwitch: true });
    await resultPromise;
  });

  it('resolves with the chosen model when provider.fallback_choice is emitted', async () => {
    const events = new EventBus();
    const gate = createFallbackGate(events);

    // Capture requestId synchronously during the emit.
    let requestId = '';
    events.on('provider.fallback_pending', (e) => {
      requestId = (e as Record<string, unknown>)['requestId'] as string;
    });

    const resultPromise = gate({
      events,
      sessionId: 's1',
      from: { providerId: 'anthropic', model: 'opus' },
      status: 529,
      candidates: [{ providerId: 'openai', model: 'gpt-4o' }],
      autoSwitchSeconds: 10,
      requestId: 'req-gate',
    });

    // requestId was captured synchronously — send the choice now.
    expect(requestId.length).toBeGreaterThan(0);
    events.emit('provider.fallback_choice', {
      requestId,
      providerId: 'openai',
      model: 'gpt-4o',
    });

    const result = await resultPromise;
    expect(result).toEqual({ providerId: 'openai', model: 'gpt-4o' });
  });

  it('resolves with null on autoSwitch choice', async () => {
    const events = new EventBus();
    const gate = createFallbackGate(events);

    let requestId = '';
    events.on('provider.fallback_pending', (e) => {
      requestId = (e as Record<string, unknown>)['requestId'] as string;
    });

    const resultPromise = gate({
      events,
      sessionId: 's1',
      from: { providerId: 'anthropic', model: 'opus' },
      status: 429,
      candidates: [{ providerId: 'openai', model: 'gpt-4o' }],
      autoSwitchSeconds: 10,
      requestId: 'req-gate',
    });

    expect(requestId.length).toBeGreaterThan(0);
    events.emit('provider.fallback_choice', { requestId, autoSwitch: true });

    const result = await resultPromise;
    expect(result).toBeNull();
  });

  it('resolves with null after the safety deadline (headless mode)', async () => {
    const events = new EventBus();
    const gate = createFallbackGate(events);

    const resultPromise = gate({
      events,
      sessionId: undefined,
      from: { providerId: 'anthropic', model: 'opus' },
      status: 429,
      candidates: [{ providerId: 'openai', model: 'gpt-4o' }],
      autoSwitchSeconds: 1, // deadline = 1.5s
      requestId: 'req-deadline',
    });

    const result = await resultPromise;
    expect(result).toBeNull();
  }, 5000);

  it('ignores choice events with a different requestId', async () => {
    const events = new EventBus();
    const gate = createFallbackGate(events);

    let requestId = '';
    events.on('provider.fallback_pending', (e) => {
      requestId = (e as Record<string, unknown>)['requestId'] as string;
    });

    const resultPromise = gate({
      events,
      sessionId: 's1',
      from: { providerId: 'anthropic', model: 'opus' },
      status: 429,
      candidates: [{ providerId: 'openai', model: 'gpt-4o' }],
      autoSwitchSeconds: 10,
      requestId: 'req-gate',
    });

    expect(requestId.length).toBeGreaterThan(0);

    // Send a choice with the WRONG requestId — should be ignored.
    events.emit('provider.fallback_choice', {
      requestId: 'wrong-id',
      providerId: 'openai',
      model: 'gpt-4o',
    });

    // Now send the correct one.
    events.emit('provider.fallback_choice', {
      requestId,
      providerId: 'openai',
      model: 'gpt-4o',
    });

    const result = await resultPromise;
    expect(result).toEqual({ providerId: 'openai', model: 'gpt-4o' });
  });

  it('cleans up the choice listener after resolving', async () => {
    const events = new EventBus();
    const gate = createFallbackGate(events);

    let requestId = '';
    events.on('provider.fallback_pending', (e) => {
      requestId = (e as Record<string, unknown>)['requestId'] as string;
    });

    const resultPromise = gate({
      events,
      sessionId: 's1',
      from: { providerId: 'anthropic', model: 'opus' },
      status: 429,
      candidates: [{ providerId: 'openai', model: 'gpt-4o' }],
      autoSwitchSeconds: 10,
      requestId: 'req-gate',
    });

    expect(requestId.length).toBeGreaterThan(0);
    events.emit('provider.fallback_choice', {
      requestId,
      providerId: 'openai',
      model: 'gpt-4o',
    });

    await resultPromise;
    // After resolution, the gate's internal listener should be removed.
    expect(events.listenerCount('provider.fallback_choice')).toBe(0);
  });
});
