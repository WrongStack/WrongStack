import { describe, expect, it, vi } from 'vitest';
import { EventBus, type Context, type SessionEventBridge } from '@wrongstack/core';
import { setupEvents } from '../../src/server/setup-events.js';

describe('setupEvents session scoping', () => {
  it('only appends audit events for the active session', () => {
    const events = new EventBus();
    const append = vi.fn(async () => {});
    const dispose = setupEvents({
      events,
      broadcast: () => {},
      clients: new Map(),
      config: {},
      context: {
        session: { id: '2026-06-29/sess_active' },
        todos: [],
      } as unknown as Context,
      pendingConfirms: new Map(),
      sessionBridge: { append } as unknown as SessionEventBridge,
    });

    events.emit('provider.retry', {
      sessionId: '2026-06-29/sess_other',
      providerId: 'openai',
      attempt: 1,
      delayMs: 100,
      status: 429,
      description: 'rate limited',
    });
    events.emit('provider.retry', {
      sessionId: '2026-06-29/sess_active',
      providerId: 'openai',
      attempt: 2,
      delayMs: 200,
      status: 429,
      description: 'rate limited again',
    });

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      type: 'provider_retry',
      attempt: 2,
    });
    dispose();
  });
});
