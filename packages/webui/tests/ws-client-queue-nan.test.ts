import { describe, expect, it } from 'vitest';
import { enqueueMessage, type QueueState } from '../src/lib/ws-client-queue';

describe('ws-client-queue cap validation', () => {
  it('rejects messages when queue caps are zero, negative, or non-finite', () => {
    const state: QueueState = {
      messageQueue: [],
      messageQueueChars: 0,
      messageQueueWeights: new WeakMap(),
    };
    expect(enqueueMessage(state, { type: 'ping' } as never, '{}', 0, 100)).toBe(false);
    expect(enqueueMessage(state, { type: 'ping' } as never, '{}', Number.NaN, 100)).toBe(false);
    expect(enqueueMessage(state, { type: 'ping' } as never, '{}', 5, Number.NaN)).toBe(false);
    expect(state.messageQueue).toHaveLength(0);
    expect(enqueueMessage(state, { type: 'ping' } as never, '{}', 2, 100)).toBe(true);
    expect(state.messageQueue).toHaveLength(1);
  });
});
