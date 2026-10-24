import { EventBus } from '@wrongstack/contracts/kernel/events';
import { describe, expect, it, vi } from 'vitest';
import {
  DELEGATION_RESULT_MARKER,
  delegationDeliveryId,
  type LeaderDelivery,
  LeaderDeliveryHub,
  renderLeaderDeliveryBlock,
} from '../../src/coordination/delegation/leader-delivery-hub.js';

function delivery(id: string, over: Partial<LeaderDelivery> = {}, excerpt = 'ok'): LeaderDelivery {
  return {
    deliveryId: delegationDeliveryId(id),
    sessionId: 'sess-1',
    kind: 'delegation_result',
    createdAt: 1,
    wake: true,
    payload: {
      delegationId: id,
      taskId: `task-${id}`,
      target: 'bug-hunter',
      task: 'audit',
      ok: true,
      status: 'success',
      stopReason: 'end_turn',
      handoffs: 0,
      summary: `[bug-hunter] done ${id}`,
      excerpt,
    },
    ...over,
  };
}

describe('LeaderDeliveryHub', () => {
  it('is idempotent on deliveryId, even after the item was taken', () => {
    const hub = new LeaderDeliveryHub();
    expect(hub.enqueue(delivery('a'))).toBe(true);
    expect(hub.enqueue(delivery('a'))).toBe(false);
    expect(hub.pending('sess-1')).toBe(1);
    expect(hub.take('sess-1')).toHaveLength(1);
    expect(hub.enqueue(delivery('a'))).toBe(false);
    expect(hub.pending('sess-1')).toBe(0);
  });

  it('keeps sessions apart and normalizes session ids', () => {
    const hub = new LeaderDeliveryHub();
    hub.enqueue(delivery('a', { sessionId: 'dir\\sess-1' }));
    hub.enqueue(delivery('b', { sessionId: 'sess-2' }));
    expect(hub.pending('dir/sess-1')).toBe(1);
    expect(hub.take('sess-2').map((d) => d.payload.delegationId)).toEqual(['b']);
    expect(hub.pending('dir/sess-1')).toBe(1);
  });

  it('takes within the item budget and leaves the overflow pending in order', () => {
    const hub = new LeaderDeliveryHub();
    for (const id of ['a', 'b', 'c']) hub.enqueue(delivery(id));
    expect(hub.take('sess-1', { maxItems: 2 }).map((d) => d.payload.delegationId)).toEqual([
      'a',
      'b',
    ]);
    expect(hub.take('sess-1').map((d) => d.payload.delegationId)).toEqual(['c']);
  });

  it('takes within the char budget but always at least one item', () => {
    const hub = new LeaderDeliveryHub();
    hub.enqueue(delivery('a', {}, 'x'.repeat(3_000)));
    hub.enqueue(delivery('b', {}, 'y'.repeat(3_000)));
    const first = hub.take('sess-1', { maxChars: 10 });
    expect(first.map((d) => d.payload.delegationId)).toEqual(['a']);
    expect(hub.pending('sess-1')).toBe(1);
  });

  it('markConsumed drops a pending item and keeps it deduped', () => {
    const hub = new LeaderDeliveryHub();
    hub.enqueue(delivery('a'));
    expect(hub.markConsumed(delegationDeliveryId('a'))).toBe(true);
    expect(hub.pending('sess-1')).toBe(0);
    expect(hub.enqueue(delivery('a'))).toBe(false);
    expect(hub.markConsumed(delegationDeliveryId('zzz'))).toBe(false);
  });

  it('announces leader.delivery_pending to listeners and the EventBus with the wake flag', () => {
    const hub = new LeaderDeliveryHub();
    const events = new EventBus();
    const onBus = vi.fn();
    const onHub = vi.fn();
    events.on('leader.delivery_pending', onBus);
    hub.on(onHub);
    hub.enqueue(delivery('a', { wake: false }), { events });
    const expected = {
      sessionId: 'sess-1',
      count: 1,
      wake: false,
      deliveryIds: [delegationDeliveryId('a')],
    };
    expect(onHub).toHaveBeenCalledWith(expected);
    expect(onBus).toHaveBeenCalledWith(expected);
  });

  it('renders one [DELEGATION RESULT] block with id, status, report and roll_up handle', () => {
    const text = renderLeaderDeliveryBlock(delivery('a', {}, 'REPORT BODY'));
    expect(text.startsWith(`${DELEGATION_RESULT_MARKER} delegationId=a`)).toBe(true);
    expect(text).toContain('status: success');
    expect(text).toContain('stopReason: end_turn');
    expect(text).toContain('REPORT BODY');
    expect(text).toContain('Full result: roll_up(["task-a"])');
    expect(text.split(DELEGATION_RESULT_MARKER)).toHaveLength(2);
  });

  it('evicts completed IDs from seen up to SEEN_CAP even when pending IDs sit at the front (F147)', () => {
    const hub = new LeaderDeliveryHub();
    for (let i = 0; i < 5; i++) {
      hub.enqueue(delivery(`pending-${i}`, { sessionId: 'sess-pending' }));
    }
    const seen = (hub as unknown as { seen: Set<string> }).seen;
    for (let i = 0; seen.size < 10_000; i++) {
      seen.add(delegationDeliveryId(`old-done-${i}`));
    }
    for (let i = 0; i < 3; i++) {
      hub.enqueue(delivery(`new-done-${i}`, { sessionId: 'sess-active' }));
      hub.take('sess-active');
    }
    expect(seen.size).toBe(10_000);
    expect(hub.pending('sess-pending')).toBe(5);
  });
});
