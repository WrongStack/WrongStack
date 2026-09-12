import { describe, expect, it } from 'vitest';
import {
  enqueuePendingUserInput,
  type PendingUserInputRequest,
  resolvePendingUserInput,
} from '../src/lib/user-input-queue.js';

const entry = (id: string, sessionId = 's1'): PendingUserInputRequest => ({
  sessionId,
  request: { id, title: id, tabs: [{ id: 'main', label: 'Main', questions: [] }] },
});

describe('SimpleUI user-input queue', () => {
  it('preserves FIFO order, deduplicates replay, and removes only the resolved form', () => {
    let queue = enqueuePendingUserInput([], entry('one'));
    queue = enqueuePendingUserInput(queue, entry('two'));
    queue = enqueuePendingUserInput(queue, entry('one'));
    expect(queue.map((item) => item.request.id)).toEqual(['two', 'one']);
    expect(resolvePendingUserInput(queue, 'two').map((item) => item.request.id)).toEqual(['one']);
  });

  it('bounds a stalled queue', () => {
    let queue: PendingUserInputRequest[] = [];
    for (let index = 0; index < 12; index += 1) {
      queue = enqueuePendingUserInput(queue, entry(`r${index}`));
    }
    expect(queue).toHaveLength(8);
    expect(queue[0]?.request.id).toBe('r4');
  });
});
