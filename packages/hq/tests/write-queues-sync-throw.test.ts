import { describe, expect, it } from 'vitest';
import { BestEffortBatchQueue, BestEffortLatestQueue } from '../src/write-queues.js';

describe('HQ write queues synchronous throw safety (F1845)', () => {
  it('catches synchronous throws from writeBatch and writeLatest and recovers on subsequent writes', async () => {
    const seenBatch: string[] = [];
    let failBatch = true;
    const bq = new BestEffortBatchQueue<string>((items) => {
      if (failBatch) {
        failBatch = false;
        throw new Error('sync batch failure');
      }
      seenBatch.push(...items);
      return Promise.resolve();
    });
    bq.enqueue('first');
    await expect(bq.drain()).resolves.toBeUndefined();
    bq.enqueue('second');
    await bq.drain();
    expect(seenBatch).toEqual(['second']);

    const seenLatest: string[] = [];
    let failLatest = true;
    const lq = new BestEffortLatestQueue<string>((value) => {
      if (failLatest) {
        failLatest = false;
        throw new Error('sync latest failure');
      }
      seenLatest.push(value);
      return Promise.resolve();
    });
    lq.enqueue('first');
    await expect(lq.drain()).resolves.toBeUndefined();
    lq.enqueue('second');
    await lq.drain();
    expect(seenLatest).toEqual(['second']);
  });
});
