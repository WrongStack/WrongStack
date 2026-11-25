import { describe, expect, it } from 'vitest';
import { resolvePinnedBrowserTarget } from '../src/security.js';

describe('resolvePinnedBrowserTarget loopback IPv4 validation', () => {
  it('rejects malformed 127.x addresses with out-of-range octets under loopback allowance', async () => {
    await expect(
      resolvePinnedBrowserTarget('http://app.localhost:3000', {
        allowedPrivateOrigins: ['loopback'],
        lookup: async () => [{ address: '127.999.0.1', family: 4 }],
      }),
    ).rejects.toThrow(/non-loopback/);

    const ok = await resolvePinnedBrowserTarget('http://app.localhost:3000', {
      allowedPrivateOrigins: ['loopback'],
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    });
    expect(ok.address).toBe('127.0.0.1');
  });
});
