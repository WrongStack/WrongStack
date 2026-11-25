import { recordProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { describe, expect, it } from 'vitest';
import { providerQuotaMenu } from '../src/tui-provider-quota-menu.js';

describe('providerQuotaMenu non-finite usedPercent guard', () => {
  it('ignores NaN usedPercent when computing worst status and renders a valid bar', () => {
    resetProviderQuota();
    try {
      recordProviderQuota('test-prov', [
        {
          providerId: 'test-prov',
          meterId: 'm1',
          windows: [
            { id: 'w1', usedPercent: 95 },
            { id: 'w2', usedPercent: Number.NaN },
          ],
          capturedAt: Date.now(),
        },
      ]);
      const menu = providerQuotaMenu(undefined);
      const item = menu.items.find((i) => i.id === 'test-prov');
      expect(item?.status).toBe('bad');
      expect(item?.body).not.toContain('NaN');
      expect(item?.body).toContain('░░░░░░░░░░');
    } finally {
      resetProviderQuota();
    }
  });
});
