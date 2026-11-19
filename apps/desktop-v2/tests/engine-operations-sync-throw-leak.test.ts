import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineOperations } from '../src/engine-operations.js';

describe('EngineOperations synchronous send throw cleanup and null payload guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears armed timeout timers and pending entries when send throws synchronously or rejects asynchronously', async () => {
    const syncOps = new EngineOperations(() => {
      throw new Error('sync transport failure');
    }, 15_000);
    await expect(syncOps.request('op', {}, ['reply'])).rejects.toThrow('sync transport failure');
    expect(vi.getTimerCount()).toBe(0);

    const asyncOps = new EngineOperations(async () => {
      throw new Error('async transport failure');
    }, 15_000);
    await expect(asyncOps.request('op', {}, ['reply'])).rejects.toThrow('async transport failure');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores null/non-object payloads in receive() and clears pending before rejecting in clear()', async () => {
    let lastRequestId = '';
    const ops = new EngineOperations(async (_type, payload) => {
      lastRequestId = String(payload?.['requestId'] ?? '');
    }, 15_000);

    const p1 = ops.request('op', {}, ['reply']);
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);

    expect(() => ops.receive({ type: 'reply', payload: null } as never)).not.toThrow();
    ops.receive({ type: 'reply', payload: { requestId: lastRequestId, ok: true, answer: 7 } });
    await expect(p1).resolves.toMatchObject({ ok: true, answer: 7 });
    expect(vi.getTimerCount()).toBe(0);

    const p2 = ops.request('op', {}, ['reply']);
    ops.clear();
    await expect(p2).rejects.toThrow('workspace was detached');
    expect(vi.getTimerCount()).toBe(0);
  });
});
