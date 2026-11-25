import { describe, expect, it } from 'vitest';
import { deliverHqVaultNotice, onHqVaultNotice } from '../src/vault/notice-bus.js';

describe('deliverHqVaultNotice re-entrant subscribe guard (F2296)', () => {
  it('does not invoke listeners added during an active notice delivery', () => {
    let lateCalled = false;
    let offLate: (() => void) | undefined;
    const offFirst = onHqVaultNotice(() => {
      offLate = onHqVaultNotice(() => {
        lateCalled = true;
      });
    });
    deliverHqVaultNotice({ generation: 1, updatedAt: new Date().toISOString() } as never);
    offFirst();
    offLate?.();
    expect(lateCalled).toBe(false);
  });
});
