import { EventBus } from '@wrongstack/contracts/kernel';
import { describe, expect, it, vi } from 'vitest';
import { setupEvents } from '../src/server/setup-events.js';

describe('setupEvents lifecycle', () => {
  it('releases every EventBus subscription on dispose', () => {
    const events = new EventBus();
    const baseline = events.listenerCount();
    const dispose = setupEvents({
      events,
      broadcast: vi.fn(),
      clients: new Map(),
      config: {},
      context: {
        meta: {},
        provider: { capabilities: { maxContext: 128_000 } },
        state: { onChange: vi.fn(), revision: 0 },
      } as never,
      pendingConfirms: new Map(),
    });

    expect(events.listenerCount()).toBeGreaterThan(baseline);

    dispose();
    dispose();

    expect(events.listenerCount()).toBe(baseline);
  });

  it('does not accumulate subscriptions across repeated setup and teardown', () => {
    const events = new EventBus();

    for (let cycle = 0; cycle < 3; cycle++) {
      const dispose = setupEvents({
        events,
        broadcast: vi.fn(),
        clients: new Map(),
        config: {},
        context: {
          meta: {},
          provider: { capabilities: { maxContext: 128_000 } },
          state: { onChange: vi.fn(), revision: 0 },
        } as never,
        pendingConfirms: new Map(),
      });
      dispose();
    }

    expect(events.listenerCount()).toBe(0);
  });
});
