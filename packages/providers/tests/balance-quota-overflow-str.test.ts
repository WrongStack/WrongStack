import { describe, expect, it } from 'vitest';
import { balanceEndpoint } from '../src/balance-quota.js';

describe('balanceEndpoint (F2178)', () => {
  it('rejects overflowing decimal strings that convert to Infinity', () => {
    const ep = balanceEndpoint('moonshot', 'api.moonshot.ai');
    expect(ep).toBeDefined();
    expect(
      ep?.parse({ status: true, data: { available_balance: '9'.repeat(400) } }),
    ).toBeUndefined();
    expect(ep?.parse({ status: true, data: { available_balance: '12.50' } })?.balance).toBe(
      '$12.50',
    );
  });
});
