import { describe, expect, it } from 'vitest';
import { emitBoardEvent, subscribeToBoardEvents } from '../src/server/event-emitter.js';

describe('kanban event-emitter reentrant subscription', () => {
  it('iterates a snapshot so a listener that resubscribes itself is only called once per emit', () => {
    let calls = 0;
    let unsub: (() => void) | undefined;
    const listener = () => {
      calls += 1;
      unsub?.();
      unsub = subscribeToBoardEvents(listener);
    };
    unsub = subscribeToBoardEvents(listener);
    try {
      emitBoardEvent('board.updated' as never, 'b1');
    } finally {
      unsub?.();
    }
    expect(calls).toBe(1);
  });
});
