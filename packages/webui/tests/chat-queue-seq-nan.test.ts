import { describe, expect, it } from 'vitest';
import { nextQueueItemId, setEnqueueSequence } from '../src/stores/chat-queue-helpers';

describe('setEnqueueSequence non-finite guard', () => {
  it('resets sequence to 0 instead of poisoning nextQueueItemId with NaN', () => {
    setEnqueueSequence(Number.NaN);
    expect(nextQueueItemId()).toBe(1);
    setEnqueueSequence(0);
  });
});
