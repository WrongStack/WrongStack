import { EventEmitter } from 'node:events';
import type { HqSageRecord } from '@wrongstack/hq';
import { afterEach, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { sendSageSnapshot } from '../src/hq-server/sage-sync-send.js';

class Peer extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  maxBuffered = 0;
  records = 0;
  terminated = false;
  stall = false;
  send(data: string, callback?: (error?: Error) => void) {
    const bytes = Buffer.byteLength(data);
    this.bufferedAmount += bytes;
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    this.records += JSON.parse(data).payload.records.length;
    if (!this.stall)
      queueMicrotask(() => {
        this.bufferedAmount -= bytes;
        callback?.();
      });
  }
  terminate() {
    this.terminated = true;
    this.readyState = 3;
    this.emit('close');
  }
}
const tombstone: HqSageRecord = { id: 'm', revision: 1, changeId: 'a'.repeat(32), memory: null };
afterEach(() => vi.useRealTimers());
it('delivers a corpus larger than 32 MiB without queuing it all at once', async () => {
  const records = Array.from({ length: 200 }, (_, i) => ({
    ...tombstone,
    id: `m${i}`,
    memory: {
      id: `m${i}`,
      scope: 'project',
      kind: 'fact',
      status: 'active',
      text: 'x'.repeat(180_000),
      importance: 1,
      confidence: 1,
      freshness: 1,
      createdAt: '2026-09-29',
      updatedAt: '2026-09-29',
      tags: [],
      anchors: [],
      sources: [],
    },
  }));
  const peer = new Peer();
  expect(await sendSageSnapshot(peer as unknown as WebSocket, { projectId: 'p', records })).toBe(
    true,
  );
  expect(peer.records).toBe(200);
  expect(peer.terminated).toBe(false);
  expect(peer.maxBuffered).toBeLessThan(512 * 1024 + 1024);
  expect(peer.listenerCount('close')).toBe(0);
});
it('stops a stalled initial transfer on a bounded timeout', async () => {
  vi.useFakeTimers();
  const peer = new Peer();
  peer.stall = true;
  const sending = sendSageSnapshot(peer as unknown as WebSocket, {
    projectId: 'p',
    records: [tombstone],
  });
  await vi.runAllTimersAsync();
  expect(await sending).toBe(false);
  expect(peer.terminated).toBe(true);
  expect(peer.listenerCount('close')).toBe(0);
});
it('releases the transfer immediately when the peer disconnects', async () => {
  const peer = new Peer();
  peer.stall = true;
  const sending = sendSageSnapshot(peer as unknown as WebSocket, {
    projectId: 'p',
    records: [tombstone],
  });
  peer.terminate();
  expect(await sending).toBe(false);
  expect(peer.listenerCount('close')).toBe(0);
});
