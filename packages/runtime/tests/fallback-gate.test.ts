import { EventBus } from '@wrongstack/contracts/kernel';
import { describe, expect, it } from 'vitest';
import { createFallbackGate } from '../src/index.js';

const params = (events: EventBus, requestId: string, autoSwitchSeconds = 5) => ({
  events,
  sessionId: 's1',
  from: { providerId: 'anthropic', model: 'opus' },
  status: 529,
  candidates: [
    { providerId: 'openai', model: 'gpt-4o' },
    { providerId: 'google', model: 'gemini-pro' },
  ],
  autoSwitchSeconds,
  requestId,
});

describe('createFallbackGate (runtime)', () => {
  it('resolves null immediately when nothing listens for provider.fallback_pending', async () => {
    const events = new EventBus();
    await expect(createFallbackGate(events)(params(events, 'r0'))).resolves.toBeNull();
  });

  it('emits provider.fallback_pending and resolves with the matching manual choice', async () => {
    const events = new EventBus();
    const pending: Array<Record<string, unknown>> = [];
    events.on('provider.fallback_pending', (payload) => {
      const p = payload as Record<string, unknown>;
      pending.push(p);
      // A reply for another gate must be ignored.
      events.emit('provider.fallback_choice', {
        requestId: 'someone-else',
        providerId: 'x',
        model: 'y',
      });
      events.emit('provider.fallback_choice', {
        requestId: p['requestId'],
        providerId: 'google',
        model: 'gemini-pro',
      });
    });

    const choice = await createFallbackGate(events)(params(events, 'r1'));

    expect(choice).toEqual({ providerId: 'google', model: 'gemini-pro' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ sessionId: 's1', requestId: 'r1', status: 529 });
    expect(events.listenerCount('provider.fallback_choice')).toBe(0);
  });

  it('auto-switches (null) when the UI replies autoSwitch', async () => {
    const events = new EventBus();
    events.on('provider.fallback_pending', (payload) => {
      const p = payload as Record<string, unknown>;
      events.emit('provider.fallback_choice', { requestId: p['requestId'], autoSwitch: true });
    });
    await expect(createFallbackGate(events)(params(events, 'r2'))).resolves.toBeNull();
  });
});
