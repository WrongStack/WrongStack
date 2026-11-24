import { describe, expect, it } from 'vitest';
import {
  type DelegationLeaderDelivery,
  type RuntimeNoticeLeaderDelivery,
  renderLeaderDeliveryBlock,
  runtimeNoticeDeliveryId,
} from '../src/delegation/leader-delivery-hub.js';

const hasLoneSurrogate = (value: string): boolean =>
  [...value].some((character) => character.length === 1 && /[\uD800-\uDFFF]/u.test(character));

describe('leader delivery boundaries', () => {
  it('keeps delegation task previews well-formed', () => {
    const delivery: DelegationLeaderDelivery = {
      deliveryId: 'd',
      sessionId: 's',
      kind: 'delegation_result',
      createdAt: 1,
      wake: true,
      payload: {
        delegationId: 'd',
        target: 'agent',
        task: `${'a'.repeat(298)}😀tail`,
        ok: true,
        handoffs: 0,
        summary: 'done',
      },
    };
    expect(hasLoneSurrogate(renderLeaderDeliveryBlock(delivery))).toBe(false);
  });

  it('keeps runtime notice bodies well-formed', () => {
    const delivery: RuntimeNoticeLeaderDelivery = {
      deliveryId: 'n',
      sessionId: 's',
      kind: 'runtime_notice',
      createdAt: 1,
      wake: true,
      payload: {
        source: 'watch',
        handle: 'w',
        title: 'Update',
        body: `${'a'.repeat(3998)}😀tail`,
      },
    };
    expect(hasLoneSurrogate(renderLeaderDeliveryBlock(delivery))).toBe(false);
  });

  it('gives delimiter-bearing handles and sequences distinct IDs', () => {
    expect(runtimeNoticeDeliveryId('watch', 'a#b', 'c')).not.toBe(
      runtimeNoticeDeliveryId('watch', 'a', 'b#c'),
    );
  });
});
