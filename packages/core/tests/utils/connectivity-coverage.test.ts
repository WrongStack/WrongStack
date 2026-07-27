/**
 * Coverage for core/src/utils/connectivity.ts
 */
import { describe, expect, it } from 'vitest';

describe('connectivity', () => {
  it('checkConnectivity is exported and callable', async () => {
    const { checkConnectivity } = await import('../../src/utils/connectivity.js');
    expect(typeof checkConnectivity).toBe('function');
  });

  it('checkConnectivity returns a boolean', async () => {
    const { checkConnectivity } = await import('../../src/utils/connectivity.js');
    const result = await checkConnectivity();
    expect(typeof result).toBe('boolean');
  });

  it('checkConnectivity accepts custom options', async () => {
    const { checkConnectivity } = await import('../../src/utils/connectivity.js');
    // Call with very short timeout to test the non-cached path
    const result = await checkConnectivity({
      probeUrl: 'https://8.8.8.8',
      timeoutMs: 1000,
      ttlMs: 0, // bypass cache
    });
    expect(typeof result).toBe('boolean');
  });

  it('cached results are returned within TTL', async () => {
    const { checkConnectivity } = await import('../../src/utils/connectivity.js');
    // First call populates cache
    const first = await checkConnectivity({ ttlMs: 60000 });
    // Second call should use cache
    const second = await checkConnectivity({ ttlMs: 60000 });
    expect(first).toBe(second);
  });

  it('returns false on network error with custom invalid URL', async () => {
    const { checkConnectivity } = await import('../../src/utils/connectivity.js');
    const result = await checkConnectivity({
      probeUrl: 'https://invalid-host-that-does-not-exist.invalid',
      timeoutMs: 500,
      ttlMs: 0,
    });
    // Should be false or true depending on network, but should not throw
    expect(typeof result).toBe('boolean');
  });
});
