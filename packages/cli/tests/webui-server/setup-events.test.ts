import type { Context } from '@wrongstack/core/agent';
import { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it, vi } from 'vitest';
import { createSetupEvents } from '../../src/webui-server/setup-events.js';

function harness() {
  const events = new EventBus();
  const broadcast = vi.fn();
  const queueTextDelta = vi.fn();
  const queueThinkingDelta = vi.fn();
  const queueToolProgress = vi.fn();
  const flushThinkingDelta = vi.fn();
  const flushAllStreamBuffers = vi.fn();
  const eventUnsubscribers: Array<() => void> = [];
  const setup = createSetupEvents({
    events,
    agent: {
      ctx: {
        projectRoot: '',
        session: { id: 'session-live' },
        todos: [],
        meta: { maxIterations: 8 },
        state: { onChange: vi.fn(), revision: 0 },
      } as unknown as Context,
    },
    broadcast,
    sessionPayload: (payload) => ({ ...payload, sessionId: 'session-live' }),
    currentSessionId: () => 'session-live',
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
    pendingConfirms: new Map(),
    secretScrubber: {
      scrubObject: (value: unknown) => ({ scrubbed: value }),
    } as never,
    getClients: () => new Map(),
    eventUnsubscribers,
  });
  return {
    events,
    broadcast,
    queueTextDelta,
    flushThinkingDelta,
    flushAllStreamBuffers,
    eventUnsubscribers,
    setup,
  };
}

describe('CLI setup-events canonical adapter', () => {
  it('uses stream coalescing and scrubs tool payloads', () => {
    const h = harness();
    h.setup();
    h.events.emit('provider.text_delta', {
      sessionId: 'session-live',
      ctx: {} as Context,
      text: 'delta',
    });
    h.events.emit('tool.started', {
      sessionId: 'session-live',
      id: 'tool-1',
      name: 'read',
      input: { token: 'secret' },
    });

    expect(h.flushThinkingDelta).toHaveBeenCalledOnce();
    expect(h.queueTextDelta).toHaveBeenCalledWith('delta', 'session-live');
    expect(h.flushAllStreamBuffers).toHaveBeenCalledOnce();
    expect(h.broadcast.mock.calls.map(([message]) => message)).toContainEqual(
      expect.objectContaining({
        type: 'tool.started',
        payload: expect.objectContaining({ input: { scrubbed: { token: 'secret' } } }),
      }),
    );
    for (const dispose of h.eventUnsubscribers) dispose();
  });

  it('re-arms without duplicating pattern subscriptions', () => {
    const h = harness();
    h.setup();
    h.setup();
    (h.events as unknown as { emit(event: string, payload: unknown): void }).emit(
      'brain.decision',
      { choice: 'continue' },
    );

    expect(
      h.broadcast.mock.calls.filter(([message]) => message.type === 'brain.event'),
    ).toHaveLength(1);
    for (const dispose of h.eventUnsubscribers) dispose();
  });
});
