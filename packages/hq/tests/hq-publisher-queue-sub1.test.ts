import { describe, expect, it } from 'vitest';
import { PublisherQueue } from '../src/publisher-queue.js';

describe('PublisherQueue sub-1 maxQueuedMessages guard (F2299)', () => {
  it('drops frames when maxQueuedMessages is less than 1', () => {
    const q = new PublisherQueue(0.5, 1024);
    expect(q.enqueue('{"a":1}')).toBe(false);
    expect(q.length).toBe(0);
  });
});
